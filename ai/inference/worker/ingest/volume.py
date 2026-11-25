"""Normalised volume shared by the viewer and the models: canonical RAS NIfTI + thumbnail.

- `canonical_volume`: reorients to the closest canonical (RAS+) orientation with nibabel, so the
  array axes run left->right, posterior->anterior, inferior->superior. Only axis permutations
  and flips are applied: voxel values are never interpolated, the affine keeps the true spacing.
- The header is fresh: no description, no extensions, no DICOM tags; qform and sform both hold
  the affine (code 1, scanner) and units are mm.
- Voxels are int16, except image stacks with 16-bit values above 32767, which stay uint16.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import nibabel as nib
import numpy as np
from PIL import Image

from worker.messages import IngestResultType

CT_AIR_HU = -1024
THUMB_SIZE = 256
THUMB_WINDOW = (40.0, 400.0)  # level, width (soft tissue)


@dataclass(frozen=True)
class NormalizedVolume:
    image: nib.Nifti1Image
    modality: str
    source_slices: int
    series_count: int
    input_type: IngestResultType
    spacing_assumed: bool = False
    """True when the voxel size is a placeholder (image stack uploaded without a spacing)."""

    @property
    def dims(self) -> list[int]:
        return [int(d) for d in self.image.shape]

    @property
    def spacing(self) -> list[float]:
        return [round(float(z), 6) for z in self.image.header.get_zooms()[:3]]

    def hu_range(self) -> list[int]:
        data = np.asanyarray(self.image.dataobj)
        return [int(data.min()), int(data.max())]


def canonical_volume(
    data: np.ndarray, ras_affine: np.ndarray, modality: str, dtype: type = np.int16
) -> nib.Nifti1Image:
    """(i, j, k) voxels + RAS affine -> canonical NIfTI of `dtype` (int16, or uint16 for 16-bit
    image stacks). CT values below -1024 HU (padding outside the field of view, e.g. -2000 or
    -3024) are clipped to air."""
    if modality == "CT":
        np.maximum(data, CT_AIR_HU, out=data)
    img = nib.Nifti1Image(data.astype(dtype, copy=False), ras_affine)
    img = nib.as_closest_canonical(img)
    out = nib.Nifti1Image(np.ascontiguousarray(np.asanyarray(img.dataobj)), img.affine)
    out.header.set_data_dtype(dtype)
    out.header.set_xyzt_units("mm")
    out.set_qform(img.affine, code=1)
    out.set_sform(img.affine, code=1)
    return out


def axial_thumbnail(
    volume: nib.Nifti1Image,
    size: int = THUMB_SIZE,
    window: tuple[float, float] | None = THUMB_WINDOW,
) -> bytes:
    """Middle axial slice as an 8-bit PNG in radiological convention (patient's right on the
    left of the image, anterior at the top), longest side `size` px, aspect from the spacing.
    `window` is (level, width); None stretches the slice's own value range."""
    data = np.asanyarray(volume.dataobj)
    zx, zy = (float(z) for z in volume.header.get_zooms()[:2])
    axial = data[:, :, data.shape[2] // 2].astype(np.float32)  # (x: R+, y: A+)
    image = axial.T[::-1, ::-1]  # rows: anterior -> posterior, columns: right -> left
    if window is None:
        low, high = float(image.min()), float(image.max())
        level, width = (low + high) / 2, max(high - low, 1.0)
    else:
        level, width = window
    scaled = np.clip((image - (level - width / 2)) / width, 0.0, 1.0) * 255.0
    return thumbnail_png(np.rint(scaled).astype(np.uint8), (zx, zy), size)


def thumbnail_png(
    gray: np.ndarray, pixel_size: tuple[float, float] = (1.0, 1.0), size: int = THUMB_SIZE
) -> bytes:
    """8-bit grayscale (rows, columns) -> PNG whose longest side is `size` px. `pixel_size` is
    (width, height) of a pixel, so non-square pixels keep the true aspect ratio."""
    sx, sy = pixel_size
    height, width = gray.shape[0] * sy, gray.shape[1] * sx
    scale = size / max(height, width)
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    thumb = Image.fromarray(np.ascontiguousarray(gray, dtype=np.uint8)).resize(
        target, Image.Resampling.LANCZOS
    )
    buf = io.BytesIO()
    thumb.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def infer_modality(hint: str, data: np.ndarray) -> str:
    """NIfTI carries no modality: trust the uploader's hint, else call it CT when air-like values
    (< -500) are present, which magnitude MR images never have."""
    if hint:
        return hint
    return "CT" if int(data.min()) < -500 else "OT"
