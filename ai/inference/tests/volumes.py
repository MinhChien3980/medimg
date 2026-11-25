"""Builders for synthetic CT data: DICOM series with known geometry, NIfTI files, ZIPs."""

from __future__ import annotations

import io
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import nibabel as nib
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

AXIAL = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
SAGITTAL = (0.0, 1.0, 0.0, 0.0, 0.0, -1.0)
CORONAL = (1.0, 0.0, 0.0, 0.0, 0.0, -1.0)


def oblique(degrees: float) -> tuple[float, ...]:
    """Axial plane rotated about the patient's z axis."""
    a = np.radians(degrees)
    return (np.cos(a), np.sin(a), 0.0, -np.sin(a), np.cos(a), 0.0)


@dataclass
class SeriesSpec:
    """A CT series whose stored values are 1024 (0 HU) except one marker voxel (1000 HU)."""

    rows: int = 10
    columns: int = 12
    slices: int = 24
    pixel_spacing: tuple[float, float] = (0.7, 0.9)  # (between rows, between columns)
    slice_spacing: float = 2.5
    orientation: tuple[float, ...] = AXIAL
    origin: tuple[float, float, float] = (-40.0, 25.0, -300.0)
    marker: tuple[int, int, int] = (3, 7, 5)  # (row, column, slice)
    series_uid: str = field(default_factory=generate_uid)
    offsets: list[float] | None = None
    """Slice positions along the normal (mm); default `k * slice_spacing`."""
    lateral_step: tuple[float, float, float] = (0.0, 0.0, 0.0)
    """Per-slice shift added to the position (gantry tilt)."""

    @property
    def row_dir(self) -> np.ndarray:
        return np.asarray(self.orientation[:3], dtype=np.float64)

    @property
    def col_dir(self) -> np.ndarray:
        return np.asarray(self.orientation[3:], dtype=np.float64)

    @property
    def normal(self) -> np.ndarray:
        return np.cross(self.row_dir, self.col_dir)

    def slice_offsets(self) -> list[float]:
        return self.offsets or [k * self.slice_spacing for k in range(self.slices)]

    def position(self, k: int) -> np.ndarray:
        return (
            np.asarray(self.origin)
            + self.slice_offsets()[k] * self.normal
            + k * np.asarray(self.lateral_step)
        )

    def world_lps(self, row: int, column: int, k: int) -> np.ndarray:
        dr, dc = self.pixel_spacing
        return self.position(k) + column * dc * self.row_dir + row * dr * self.col_dir

    @property
    def marker_lps(self) -> np.ndarray:
        return self.world_lps(*self.marker)


def dicom_slice(spec: SeriesSpec, k: int, instance: int) -> Dataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = "1.2.826.0.1.3680043.8.498.1"
    ds.SeriesInstanceUID = spec.series_uid
    ds.Modality = "CT"
    ds.PatientName = "Synthetic^Phantom"
    ds.InstanceNumber = instance
    ds.ImagePositionPatient = [float(v) for v in spec.position(k)]
    ds.ImageOrientationPatient = [float(v) for v in spec.orientation]
    ds.PixelSpacing = [float(v) for v in spec.pixel_spacing]
    ds.SliceThickness = spec.slice_spacing
    ds.Rows, ds.Columns = spec.rows, spec.columns
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.RescaleSlope = 1
    ds.RescaleIntercept = -1024
    pixels = np.full((spec.rows, spec.columns), 1024, dtype=np.uint16)
    if k == spec.marker[2]:
        pixels[spec.marker[0], spec.marker[1]] = 2024
    ds.PixelData = pixels.tobytes()
    return ds


def write_series(spec: SeriesSpec, directory: Path, reverse_files: bool = True) -> list[Path]:
    """One file per slice, named in reverse slice order so file order is never the answer."""
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    order = range(spec.slices)
    for n, k in enumerate(reversed(order) if reverse_files else order):
        path = directory / f"{spec.series_uid[-6:]}-{n:03d}.dcm"
        dicom_slice(spec, k, instance=k + 1).save_as(path, enforce_file_format=True)
        paths.append(path)
    return paths


def zip_files(entries: Iterable[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            zf.writestr(name, data)
    return buf.getvalue()


def series_zip(*specs: SeriesSpec, tmp: Path, extra: Iterable[tuple[str, bytes]] = ()) -> bytes:
    entries: list[tuple[str, bytes]] = []
    for n, spec in enumerate(specs):
        for path in write_series(spec, tmp / f"s{n}"):
            entries.append((f"study/series{n}/{path.name}", path.read_bytes()))
    return zip_files([*entries, *extra])


def nifti_bytes(
    data: np.ndarray,
    affine: np.ndarray,
    gz: bool = True,
    slope: float | None = None,
    inter: float | None = None,
    descrip: bytes = b"",
) -> bytes:
    img = nib.Nifti1Image(data, affine)
    if slope is not None:
        img.header.set_slope_inter(slope, inter or 0.0)
    img.header["descrip"] = descrip
    raw = img.to_bytes()
    if not gz:
        return raw
    import gzip

    return gzip.compress(raw, compresslevel=1)
