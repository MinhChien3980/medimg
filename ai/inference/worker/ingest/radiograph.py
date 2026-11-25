"""One DICOM radiograph (CR, DX, MG, ...) -> 8-bit grayscale PNG for display and the X-ray models.

The rendering follows the DICOM grayscale pipeline (PS3.4 N.2.1):

1. Modality LUT: Modality LUT Sequence if present, else Rescale Slope/Intercept.
2. VOI LUT: the first VOI LUT Sequence item if present, else the first Window Center/Width
   (VOI LUT Function LINEAR, LINEAR_EXACT or SIGMOID, PS3.3 C.11.2.1.2), else the image's own
   min-max.
3. Presentation: MONOCHROME1 (or Presentation LUT Shape INVERSE) is inverted, so that the PNG is
   always "high = white", like MONOCHROME2.

Colour images (secondary captures, Samples per Pixel = 3) are reduced to luminance (ITU-R
BT.601) without the LUT steps, which the standard defines for grayscale only.

Pixel data is decoded by pydicom. Compressed transfer syntaxes go through the GDCM plugin
(`python-gdcm`, BSD): JPEG Baseline/Extended, JPEG Lossless, JPEG-LS and JPEG 2000. Pillow is
pydicom's fallback for JPEG Baseline and JPEG 2000; RLE is decoded by pydicom itself.

The PNG carries no metadata (no text chunks, no physical size): nothing from the DICOM header
leaves the worker except modality, size and pixel spacing, returned separately.
"""

from __future__ import annotations

import io
import logging
import math
import warnings
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from worker.errors import BadInputError
from worker.ingest.volume import thumbnail_png
from worker.pipelines.base import ProgressCallback

log = logging.getLogger(__name__)

DICM_OFFSET = 128
MIN_SIDE = 256
MAX_PIXELS = 50_000_000
RADIOGRAPH_MODALITIES = frozenset({"CR", "DX", "RG", "MG", "PX", "OT"})
"""Single-image projection modalities a 2D upload may hold (OT: secondary capture, unknown)."""
SERIES_MODALITIES = frozenset({"CT", "MR", "PT", "US"})
"""Cross-sectional modalities: one file is one slice of a series, useless on its own."""


@dataclass(frozen=True)
class Radiograph:
    png: bytes
    thumbnail: bytes
    modality: str
    width: int
    height: int
    spacing: tuple[float, float] | None
    """(x, y) mm: horizontal (between columns) then vertical (between rows) pixel size."""


def _read(path: Path):
    import pydicom

    with path.open("rb") as fh:
        preamble = fh.read(DICM_OFFSET + 4)
    has_magic = preamble[DICM_OFFSET : DICM_OFFSET + 4] == b"DICM"
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return pydicom.dcmread(path, force=not has_magic)
    except Exception as exc:  # pydicom raises many types on non-DICOM input
        raise BadInputError(f"not a readable DICOM file: {exc}") from exc


def _int(ds, keyword: str, default: int) -> int:
    try:
        return int(ds.get(keyword) or default)
    except (TypeError, ValueError):
        return default


def _validate(ds) -> str:
    """Header checks, before any pixel is decoded. Returns the modality."""
    modality = str(ds.get("Modality", "") or "").strip().upper() or "OT"
    if modality in SERIES_MODALITIES:
        raise BadInputError(
            f"this DICOM file is a single {modality} slice; "
            "upload the whole series as a ZIP of its DICOM files"
        )
    if modality not in RADIOGRAPH_MODALITIES:
        allowed = ", ".join(sorted(RADIOGRAPH_MODALITIES))
        raise BadInputError(
            f"DICOM modality {modality} is not supported as a 2D image (supported: {allowed})"
        )
    if "PixelData" not in ds:
        raise BadInputError("the DICOM file has no pixel data (it is not an image)")
    frames = _int(ds, "NumberOfFrames", 1)
    if frames > 1:
        raise BadInputError(
            f"multi-frame DICOM ({frames} frames) is not supported; upload a single-frame image"
        )
    rows, columns = _int(ds, "Rows", 0), _int(ds, "Columns", 0)
    if min(rows, columns) < MIN_SIDE:
        raise BadInputError(
            f"the image is {columns}x{rows} pixels; at least {MIN_SIDE} pixels per side are needed"
        )
    if rows * columns > MAX_PIXELS:
        raise BadInputError(
            f"the image has {rows * columns / 1e6:.0f} million pixels; "
            f"at most {MAX_PIXELS / 1e6:.0f} million are accepted"
        )
    samples = _int(ds, "SamplesPerPixel", 1)
    photometric = str(ds.get("PhotometricInterpretation", "") or "").upper()
    if samples not in (1, 3) or photometric == "PALETTE COLOR":
        raise BadInputError(f"unsupported DICOM colour model {photometric or '?'}")
    return modality


def _decode(ds) -> np.ndarray:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pixels = ds.pixel_array
    except Exception as exc:  # missing codec, corrupt stream, inconsistent header, ...
        syntax = getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", None)
        name = getattr(syntax, "name", None) or str(syntax or "unknown transfer syntax")
        raise BadInputError(f"cannot decode the DICOM pixel data ({name}): {exc}") from exc
    del ds.PixelData  # the encoded copy is no longer needed (up to 100 MB)
    return pixels


def _spacing(ds) -> tuple[float, float] | None:
    """PixelSpacing (calibrated to the patient) or ImagerPixelSpacing (at the detector), both
    stored as (between rows, between columns); returned as (x, y)."""
    for keyword in ("PixelSpacing", "ImagerPixelSpacing"):
        try:
            row, column = (float(v) for v in ds.get(keyword) or ())
        except (TypeError, ValueError):
            continue
        if all(math.isfinite(v) and v > 0 for v in (row, column)):
            return round(column, 6), round(row, 6)
    return None


def _modality_lut(pixels: np.ndarray, ds) -> np.ndarray:
    """Stored values -> modality values, float32 (in place where possible)."""
    if "ModalityLUTSequence" in ds:
        from pydicom.pixels import apply_modality_lut

        return apply_modality_lut(pixels, ds).astype(np.float32, copy=False)
    values = pixels.astype(np.float32)
    slope = float(ds.get("RescaleSlope", 1) or 1)
    intercept = float(ds.get("RescaleIntercept", 0) or 0)
    if slope != 1.0:
        values *= slope
    if intercept != 0.0:
        values += intercept
    return values


def _first(value: object) -> float | None:
    """First value of a possibly multi-valued DS element (Window Center/Width)."""
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        value = value[0] if len(value) else None
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def window(values: np.ndarray, center: float, width: float, function: str = "LINEAR") -> None:
    """VOI window (PS3.3 C.11.2.1.2/3) applied in place, output range 0..1."""
    if function == "SIGMOID":
        np.subtract(values, center, out=values)
        values *= -4.0 / width
        np.clip(values, -80.0, 80.0, out=values)  # exp() stays finite in float32
        np.exp(values, out=values)
        values += 1.0
        np.reciprocal(values, out=values)
        return
    if function == "LINEAR_EXACT":
        low, span = center - width / 2, width
    else:  # LINEAR: the standard's half-pixel offsets
        low, span = center - 0.5 - (width - 1) / 2, width - 1
    values -= low
    values /= span
    np.clip(values, 0.0, 1.0, out=values)


def _voi_lut(values: np.ndarray, ds) -> np.ndarray:
    """First VOI LUT Sequence item -> 0..1. The output is normalised by the largest entry of the
    table: a display LUT ends on white, and some writers overstate the bits per entry."""
    from pydicom.pixels import apply_voi

    item = ds.VOILUTSequence[0]
    entries, first = int(item.LUTDescriptor[0]) or 2**16, int(item.LUTDescriptor[1])
    table = apply_voi(np.arange(first, first + entries, dtype=np.int32), ds)
    top = max(float(table.max()), 1.0)
    indices = np.rint(values, out=values).astype(np.int32)
    out = apply_voi(indices, ds).astype(np.float32)
    out /= top
    return out


def _min_max(values: np.ndarray) -> None:
    low, high = float(values.min()), float(values.max())
    values -= low
    if high > low:
        values /= high - low


def _voi(values: np.ndarray, ds) -> np.ndarray:
    if ds.get("VOILUTSequence"):
        try:
            return _voi_lut(values, ds)
        except Exception as exc:  # malformed LUT: fall back on the window or the data range
            log.warning("unusable VOI LUT, ignored: %s", exc)
    center, width = _first(ds.get("WindowCenter")), _first(ds.get("WindowWidth"))
    function = str(ds.get("VOILUTFunction", "LINEAR") or "LINEAR").strip().upper()
    if function not in ("LINEAR", "LINEAR_EXACT", "SIGMOID"):
        function = "LINEAR"
    minimum = 1.0 if function == "LINEAR" else 0.0
    if center is not None and width is not None and width > minimum:
        window(values, center, width, function)
        return values
    if center is not None or width is not None:
        log.warning(
            "invalid window, using the data range", extra={"center": center, "width": width}
        )
    _min_max(values)
    return values


def _luminance(rgb: np.ndarray) -> np.ndarray:
    """RGB -> luminance (ITU-R BT.601, as Pillow's "L"), 0..1."""
    gray = rgb[..., 0] * np.float32(0.299)
    gray += rgb[..., 1] * np.float32(0.587)
    gray += rgb[..., 2] * np.float32(0.114)
    gray /= np.float32(np.iinfo(rgb.dtype).max if rgb.dtype.kind in "iu" else 1.0)
    return gray


def render(ds) -> np.ndarray:
    """Decoded dataset -> (rows, columns) uint8, high = white."""
    pixels = _decode(ds)
    if pixels.ndim == 3:  # colour, converted to RGB by pydicom
        unit = _luminance(pixels)
    else:
        unit = _voi(_modality_lut(pixels, ds), ds)
        del pixels
        photometric = str(ds.get("PhotometricInterpretation", "") or "").upper()
        shape = str(ds.get("PresentationLUTShape", "") or "").upper()
        if photometric == "MONOCHROME1" or shape == "INVERSE":
            np.subtract(1.0, unit, out=unit)
    unit *= 255.0
    np.rint(unit, out=unit)
    return unit.astype(np.uint8)


def encode_png(gray: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(gray)).save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


def ingest_radiograph(
    path: Path, progress: ProgressCallback, parsed: int = 40, rendered: int = 70
) -> Radiograph:
    """Validate, decode and render one DICOM file. Raises BadInputError with a readable reason."""
    ds = _read(path)
    modality = _validate(ds)
    spacing = _spacing(ds)
    progress(parsed)
    gray = render(ds)
    del ds
    progress(rendered)
    height, width = gray.shape
    return Radiograph(
        png=encode_png(gray),
        thumbnail=thumbnail_png(gray, spacing or (1.0, 1.0)),
        modality=modality,
        width=int(width),
        height=int(height),
        spacing=spacing,
    )
