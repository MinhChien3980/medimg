"""A ZIP of plain PNG/JPEG slices -> one volume.

Plain images carry no geometry, so the volume is built by convention:

- Slice order: natural sort of the archive paths (`img2` before `img10`, case-insensitive). The
  first file is the most inferior slice (k = 0), the last the most superior.
- In-plane: each image is an axial slice seen in radiological convention, so the axial view of
  the volume shows it exactly as stored: image left = patient's right, image top = anterior.
  Voxel (i, j, k) of the canonical RAS volume is pixel (row H-1-j, column W-1-i) of image k.
- Spacing: `[x, y, z]` mm from the upload's `sliceSpacingMm` (x between columns, y between
  rows, z between slices), else 1 x 1 x 1 mm flagged `spacingAssumed`. The affine is
  `diag(x, y, z)`: RAS-aligned, origin at the first voxel.
- Values: colour is reduced to luminance (ITU-R BT.601); 8-bit and 16-bit values keep their
  range (no rescaling). The volume is int16, or uint16 when 16-bit values exceed 32767.
  Modality `OT`.

All images must have the same size and bit depth. Sizes are read from the image headers and
checked, together with the voxel budget, before any pixel is decoded.
"""

from __future__ import annotations

import logging
import re
import warnings
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from worker.errors import BadInputError
from worker.ingest.archive import ZipMember
from worker.ingest.nifti import MAX_VOXELS
from worker.ingest.volume import NormalizedVolume, canonical_volume
from worker.messages import IngestResultType
from worker.pipelines.base import ProgressCallback

log = logging.getLogger(__name__)

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"
MIN_SLICES = 20
MAX_SLICE_PIXELS = 50_000_000
ASSUMED_SPACING = (1.0, 1.0, 1.0)
MODALITY = "OT"

_SIXTEEN_BIT_MODES = frozenset({"I;16", "I;16L", "I;16B", "I;16N", "I"})
_DIGITS = re.compile(r"(\d+)")


def image_format(path: Path) -> str | None:
    """'PNG' or 'JPEG' from the magic bytes, else None. File names are not trusted."""
    with path.open("rb") as fh:
        head = fh.read(len(PNG_MAGIC))
    if head == PNG_MAGIC:
        return "PNG"
    if head.startswith(JPEG_MAGIC):
        return "JPEG"
    return None


def natural_key(name: str) -> tuple:
    """`scan/img2.png` < `scan/img10.png`; ties broken by the exact name."""
    parts = tuple(
        (0, int(chunk), "") if chunk.isdigit() else (1, 0, chunk)
        for chunk in _DIGITS.split(name.lower())
        if chunk
    )
    return parts, name


@dataclass(frozen=True)
class _Slice:
    member: ZipMember
    size: tuple[int, int]
    """(width, height)"""
    sixteen_bit: bool


def _open(member: ZipMember) -> Image.Image:
    """Lazy open (header only). Pillow's own bomb warning is silenced: the pixel budget is checked
    by `_survey`; images over twice Pillow's limit still raise DecompressionBombError."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            return Image.open(member.path)
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise BadInputError(f"cannot read image {member.name!r}: {exc}") from exc


def _survey(members: list[ZipMember]) -> list[_Slice]:
    """Headers only: size and bit depth of every slice, checked for consistency."""
    slices: list[_Slice] = []
    for member in members:
        with _open(member) as img:
            slices.append(_Slice(member, img.size, img.mode in _SIXTEEN_BIT_MODES))
    first = slices[0]
    for s in slices[1:]:
        if s.size != first.size:
            raise BadInputError(
                "all images must have the same size: "
                f"{first.member.name!r} is {first.size[0]}x{first.size[1]}, "
                f"{s.member.name!r} is {s.size[0]}x{s.size[1]}"
            )
    depths = {s.sixteen_bit for s in slices}
    if len(depths) > 1:
        eight = next(s for s in slices if not s.sixteen_bit)
        sixteen = next(s for s in slices if s.sixteen_bit)
        raise BadInputError(
            "all images must have the same bit depth: "
            f"{eight.member.name!r} is 8-bit, {sixteen.member.name!r} is 16-bit"
        )
    width, height = first.size
    if width * height > MAX_SLICE_PIXELS:
        raise BadInputError(
            f"each image has {width * height / 1e6:.0f} million pixels; "
            f"at most {MAX_SLICE_PIXELS / 1e6:.0f} million are accepted"
        )
    voxels = width * height * len(slices)
    if voxels > MAX_VOXELS:
        raise BadInputError(
            f"the stack has {voxels / 1e6:.0f} million voxels; "
            f"at most {MAX_VOXELS / 1e6:.0f} million are accepted"
        )
    return slices


def _pixels(s: _Slice) -> np.ndarray:
    """(rows, columns) uint8 or uint16 luminance, values as stored."""
    with _open(s.member) as img:
        try:
            if s.sixteen_bit:
                array = np.asarray(img)
                if img.mode == "I" and (array.min() < 0 or array.max() > 65535):
                    raise BadInputError(f"image {s.member.name!r} is not 8- or 16-bit")
                return array.astype(np.uint16, copy=False)
            if img.mode != "L":  # RGB(A), P, LA, 1, CMYK, YCbCr -> BT.601 luminance
                try:
                    img = img.convert("L")
                except ValueError:  # no direct conversion from this mode
                    img = img.convert("RGB").convert("L")
            return np.asarray(img)
        except (OSError, ValueError, SyntaxError) as exc:
            raise BadInputError(f"cannot decode image {s.member.name!r}: {exc}") from exc


def ingest_image_stack(
    members: Iterable[ZipMember],
    progress: ProgressCallback,
    spacing: tuple[float, float, float] | None = None,
    min_slices: int = MIN_SLICES,
    parsed: int = 40,
) -> NormalizedVolume:
    ordered = sorted(members, key=lambda m: natural_key(m.name))
    if len(ordered) < min_slices:
        raise BadInputError(
            f"the ZIP has {len(ordered)} PNG/JPEG images; a 3D volume needs at least {min_slices}"
        )
    slices = _survey(ordered)
    progress(parsed)

    width, height = slices[0].size
    sixteen_bit = slices[0].sixteen_bit
    # Filled slice by slice in its final (i, j, k) layout: no second copy of the volume.
    data = np.empty((width, height, len(slices)), dtype=np.uint16 if sixteen_bit else np.int16)
    for k, s in enumerate(slices):
        data[:, :, k] = _pixels(s)[::-1, ::-1].T
        s.member.path.unlink()
    dtype: type = np.int16
    if sixteen_bit:
        if int(data.max()) > np.iinfo(np.int16).max:
            dtype = np.uint16
        else:
            data = data.view(np.int16)  # same bits for 0..32767: no copy

    assumed = spacing is None
    sx, sy, sz = ASSUMED_SPACING if spacing is None else spacing
    image = canonical_volume(data, np.diag([sx, sy, sz, 1.0]), MODALITY, dtype=dtype)
    log.info(
        "image stack built",
        extra={
            "slices": len(slices),
            "width": width,
            "height": height,
            "dtype": np.dtype(dtype).name,
            "spacingAssumed": assumed,
        },
    )
    return NormalizedVolume(
        image=image,
        modality=MODALITY,
        source_slices=len(slices),
        series_count=1,
        input_type=IngestResultType.IMAGE_STACK,
        spacing_assumed=assumed,
    )
