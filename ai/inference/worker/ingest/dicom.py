"""DICOM series -> HU volume + voxel-to-LPS affine.

pydicom reads the headers (series grouping, geometry); SimpleITK/GDCM decodes the pixel data of
each slice, so compressed transfer syntaxes work and the rescale slope/intercept is applied.
The volume is assembled from ImagePositionPatient, never from file or instance order:

- slices are sorted along the slice normal (row x column direction cosines);
- uneven spacing or missing slices are resampled (linear, along the normal) onto a uniform grid
  at the median spacing, with a warning in the log;
- a gantry-tilted series (positions not along the normal) is rejected.

Voxel (i, j, k) = (column, row, slice); its LPS position is
`P0 + i * dc * row_dir + j * dr * col_dir + k * dz * normal`, where (dr, dc) = PixelSpacing.
"""

from __future__ import annotations

import logging
import warnings
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from worker.errors import BadInputError

log = logging.getLogger(__name__)

DICM_OFFSET = 128
MIN_SLICES = 20
MAX_TILT_DEGREES = 0.5
SPACING_TOLERANCE = 0.01
"""Relative deviation from the median slice spacing tolerated before resampling."""
DUPLICATE_MM = 1e-3
INT16_MIN, INT16_MAX = -32768, 32767


@dataclass(frozen=True)
class SliceHeader:
    path: Path
    series_uid: str
    position: tuple[float, float, float]
    orientation: tuple[float, float, float, float, float, float]
    pixel_spacing: tuple[float, float]
    rows: int
    columns: int
    instance_number: int
    modality: str
    frames: int


def _floats(value: object, n: int) -> tuple[float, ...] | None:
    try:
        out = tuple(float(v) for v in value)  # type: ignore[union-attr]
    except (TypeError, ValueError):
        return None
    return out if len(out) == n and all(np.isfinite(out)) else None


def read_header(path: Path) -> SliceHeader | None:
    """Header of an image slice, or None for anything else (not DICOM, DICOMDIR, SR, ...)."""
    import pydicom

    with path.open("rb") as fh:
        preamble = fh.read(DICM_OFFSET + 4)
    has_magic = preamble[DICM_OFFSET : DICM_OFFSET + 4] == b"DICM"
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ds = pydicom.dcmread(path, stop_before_pixels=True, force=not has_magic)
    except Exception:  # pydicom raises many types on non-DICOM input
        return None

    position = _floats(ds.get("ImagePositionPatient"), 3)
    orientation = _floats(ds.get("ImageOrientationPatient"), 6)
    spacing = _floats(ds.get("PixelSpacing"), 2)
    series_uid = str(ds.get("SeriesInstanceUID", "") or "")
    rows, columns = ds.get("Rows"), ds.get("Columns")
    if not (position and orientation and spacing and series_uid and rows and columns):
        return None
    if min(spacing) <= 0:
        return None
    try:
        instance = int(ds.get("InstanceNumber") or 0)
        frames = int(ds.get("NumberOfFrames") or 1)
    except (TypeError, ValueError):
        instance, frames = 0, 1
    return SliceHeader(
        path=path,
        series_uid=series_uid,
        position=position,  # type: ignore[arg-type]
        orientation=orientation,  # type: ignore[arg-type]
        pixel_spacing=spacing,  # type: ignore[arg-type]
        rows=int(rows),
        columns=int(columns),
        instance_number=instance,
        modality=str(ds.get("Modality", "") or "").upper(),
        frames=frames,
    )


@dataclass(frozen=True)
class SeriesSelection:
    slices: list[SliceHeader]
    series_count: int


def select_series(headers: list[SliceHeader]) -> SeriesSelection:
    """The series with the most slices; inside it, the dominant geometry (a localizer or a
    reformat that shares the series UID is left out)."""
    if not headers:
        raise BadInputError("the ZIP contains no DICOM image slices")
    by_series: dict[str, list[SliceHeader]] = defaultdict(list)
    for h in headers:
        by_series[h.series_uid].append(h)
    uid = max(sorted(by_series), key=lambda u: len(by_series[u]))
    chosen = by_series[uid]

    if any(h.frames > 1 for h in chosen):
        raise BadInputError("multi-frame (enhanced) DICOM is not supported; export single frames")

    def geometry(h: SliceHeader) -> tuple:
        return (
            tuple(round(v, 4) for v in h.orientation),
            h.rows,
            h.columns,
            tuple(round(v, 4) for v in h.pixel_spacing),
        )

    groups = Counter(geometry(h) for h in chosen)
    dominant, _ = groups.most_common(1)[0]
    kept = [h for h in chosen if geometry(h) == dominant]
    if len(kept) < len(chosen):
        log.warning(
            "slices with a different geometry left out",
            extra={"kept": len(kept), "dropped": len(chosen) - len(kept)},
        )
    return SeriesSelection(slices=kept, series_count=len(by_series))


@dataclass(frozen=True)
class SliceGeometry:
    slices: list[SliceHeader]
    """Sorted along the normal, duplicates removed."""
    offsets: np.ndarray
    """Position of each slice along the normal, mm, ascending."""
    lps_affine: np.ndarray
    """Voxel (column, row, slice) -> LPS mm, for the uniform grid starting at slices[0]."""
    spacing: float
    uniform: bool


def slice_geometry(slices: list[SliceHeader], min_slices: int = MIN_SLICES) -> SliceGeometry:
    orientation = np.asarray(slices[0].orientation, dtype=np.float64)
    row_dir = orientation[:3] / np.linalg.norm(orientation[:3])
    col_dir = orientation[3:] / np.linalg.norm(orientation[3:])
    normal = np.cross(row_dir, col_dir)
    normal /= np.linalg.norm(normal)

    ordered = sorted(slices, key=lambda h: (float(np.dot(h.position, normal)), h.instance_number))
    unique: list[SliceHeader] = []
    for h in ordered:
        if unique and np.dot(np.subtract(h.position, unique[-1].position), normal) < DUPLICATE_MM:
            continue
        unique.append(h)
    if len(unique) < len(ordered):
        log.warning(
            "duplicate slice positions ignored", extra={"dropped": len(ordered) - len(unique)}
        )
    if len(unique) < min_slices:
        raise BadInputError(
            f"the series has {len(unique)} slices; a 3D volume needs at least {min_slices}"
        )

    positions = np.asarray([h.position for h in unique], dtype=np.float64)
    span = positions[-1] - positions[0]
    along = float(np.dot(span, normal))
    lateral = float(np.linalg.norm(span - along * normal))
    tilt = float(np.degrees(np.arctan2(lateral, along)))
    if tilt > MAX_TILT_DEGREES:
        raise BadInputError(
            f"gantry-tilted series ({tilt:.1f} degrees) are not supported; "
            "export a reconstruction without tilt"
        )

    offsets = (positions - positions[0]) @ normal
    gaps = np.diff(offsets)
    spacing = float(np.median(gaps))
    uniform = bool(np.max(np.abs(gaps - spacing)) <= SPACING_TOLERANCE * spacing)
    if not uniform:
        log.warning(
            "uneven slice spacing, resampling onto a uniform grid",
            extra={
                "spacingMm": round(spacing, 4),
                "minGapMm": round(float(gaps.min()), 4),
                "maxGapMm": round(float(gaps.max()), 4),
            },
        )

    dr, dc = unique[0].pixel_spacing
    affine = np.eye(4)
    affine[:3, 0] = row_dir * dc
    affine[:3, 1] = col_dir * dr
    affine[:3, 2] = normal * spacing
    affine[:3, 3] = positions[0]
    return SliceGeometry(unique, offsets, affine, spacing, uniform)


def uniform_slice_count(geometry: SliceGeometry) -> int:
    if geometry.uniform:
        return len(geometry.slices)
    return round(float(geometry.offsets[-1]) / geometry.spacing) + 1


def read_pixels(slices: list[SliceHeader]) -> np.ndarray:
    """(slices, rows, columns) int16 stored values after rescale (HU for CT)."""
    import SimpleITK as sitk

    first = slices[0]
    out = np.empty((len(slices), first.rows, first.columns), dtype=np.int16)
    for index, h in enumerate(slices):
        try:
            image = sitk.ReadImage(str(h.path), sitk.sitkFloat32)
        except RuntimeError as exc:
            raise BadInputError(f"cannot decode DICOM pixel data: {exc}") from exc
        pixels = sitk.GetArrayViewFromImage(image)
        if pixels.size != h.rows * h.columns:
            raise BadInputError(
                f"slice {index} has {pixels.size} pixels, expected {h.rows}x{h.columns}"
            )
        out[index] = np.clip(np.rint(pixels.reshape(h.rows, h.columns)), INT16_MIN, INT16_MAX)
    return out


def resample_uniform(stack: np.ndarray, geometry: SliceGeometry) -> np.ndarray:
    """Linear interpolation along the slice axis onto offsets 0, dz, 2dz, ..."""
    count = uniform_slice_count(geometry)
    targets = np.arange(count) * geometry.spacing
    offsets = geometry.offsets
    out = np.empty((count, *stack.shape[1:]), dtype=np.int16)
    for m, t in enumerate(targets):
        k = int(np.clip(np.searchsorted(offsets, t, side="right") - 1, 0, len(offsets) - 2))
        w = float(np.clip((t - offsets[k]) / (offsets[k + 1] - offsets[k]), 0.0, 1.0))
        blended = (1.0 - w) * stack[k].astype(np.float32) + w * stack[k + 1].astype(np.float32)
        out[m] = np.rint(blended).astype(np.int16)
    return out
