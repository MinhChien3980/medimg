"""DICOM series -> canonical NIfTI: a marker voxel must stay at its patient (LPS) position."""

from __future__ import annotations

import nibabel as nib
import numpy as np
import pytest
import SimpleITK as sitk

from tests.volumes import AXIAL, CORONAL, SAGITTAL, SeriesSpec, oblique, series_zip, write_series
from worker.errors import BadInputError
from worker.ingest import dicom
from worker.ingest.workload import ingest_zip
from worker.messages import IngestResultType


def ingest(tmp_path, *specs: SeriesSpec, extra=()):
    archive = tmp_path / "upload"
    archive.write_bytes(series_zip(*specs, tmp=tmp_path / "src", extra=extra))
    progress: list[int] = []
    volume = ingest_zip(archive, tmp_path / "work", progress.append)
    return volume, progress


def marker_lps(image: nib.Nifti1Image) -> np.ndarray:
    data = np.asanyarray(image.dataobj)
    ijk = np.argwhere(data == data.max())
    assert len(ijk) == 1
    x, y, z = (image.affine @ np.array([*ijk[0], 1.0]))[:3]
    return np.array([-x, -y, z])  # RAS -> LPS


@pytest.mark.parametrize(
    "orientation",
    [AXIAL, SAGITTAL, CORONAL, oblique(20.0), (-1.0, 0.0, 0.0, 0.0, -1.0, 0.0)],
    ids=["axial", "sagittal", "coronal", "oblique", "axial-flipped"],
)
def test_marker_keeps_its_patient_position(tmp_path, orientation):
    spec = SeriesSpec(orientation=orientation)
    volume, progress = ingest(tmp_path, spec)

    np.testing.assert_allclose(marker_lps(volume.image), spec.marker_lps, atol=1e-4)
    assert nib.aff2axcodes(volume.image.affine) == ("R", "A", "S")
    assert progress == [40]
    assert volume.modality == "CT"
    assert volume.input_type is IngestResultType.DICOM_SERIES
    assert volume.spacing_assumed is False
    assert volume.source_slices == spec.slices
    assert volume.series_count == 1
    data = np.asanyarray(volume.image.dataobj)
    assert data.dtype == np.int16
    assert (int(data.min()), int(data.max())) == (0, 1000)  # rescale intercept applied (HU)
    assert sorted(volume.spacing) == pytest.approx(sorted([0.7, 0.9, 2.5]))


def test_matches_simpleitk_series_reader(tmp_path):
    """Independent reference: ITK's series reader on the same files, index -> physical point."""
    spec = SeriesSpec(orientation=oblique(-35.0))
    files = write_series(spec, tmp_path / "ref")
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(tmp_path / "ref")))
    reference = reader.Execute()
    array = sitk.GetArrayFromImage(reference)  # (k, row, column)
    k, row, column = np.argwhere(array == array.max())[0]
    itk_point = reference.TransformIndexToPhysicalPoint((int(column), int(row), int(k)))

    volume, _ = ingest(tmp_path, spec)
    np.testing.assert_allclose(marker_lps(volume.image), itk_point, atol=1e-4)
    assert len(files) == spec.slices


def test_uneven_spacing_is_resampled_by_position(tmp_path):
    offsets = [k * 2.5 for k in range(26) if k != 12]  # slice 12 missing
    spec = SeriesSpec(slices=25, offsets=offsets, marker=(3, 7, 15))
    volume, _ = ingest(tmp_path, spec)
    assert volume.image.shape[2] == 26
    assert volume.source_slices == 25
    assert volume.spacing[2] == pytest.approx(2.5)
    np.testing.assert_allclose(marker_lps(volume.image), spec.marker_lps, atol=1e-4)


def test_resample_uniform_interpolates_the_gap():
    headers = [object()] * 3
    geometry = dicom.SliceGeometry(
        slices=headers,  # type: ignore[arg-type]
        offsets=np.array([0.0, 2.0, 6.0]),
        lps_affine=np.eye(4),
        spacing=2.0,
        uniform=False,
    )
    stack = np.stack([np.full((2, 2), v, dtype=np.int16) for v in (0, 100, 300)])
    out = dicom.resample_uniform(stack, geometry)
    assert out[:, 0, 0].tolist() == [0, 100, 200, 300]


def test_largest_series_wins_and_is_counted(tmp_path):
    small = SeriesSpec(slices=21, marker=(1, 1, 1))
    large = SeriesSpec(slices=30, origin=(0.0, 0.0, 0.0))
    junk = [("study/readme.txt", b"hello"), ("study/DICOMDIR", b"\0" * 200)]
    volume, _ = ingest(tmp_path, small, large, extra=junk)
    assert volume.series_count == 2
    assert volume.source_slices == 30
    np.testing.assert_allclose(marker_lps(volume.image), large.marker_lps, atol=1e-4)


def test_too_few_slices_is_rejected(tmp_path):
    with pytest.raises(BadInputError, match="19 slices"):
        ingest(tmp_path, SeriesSpec(slices=19))


def test_zip_without_dicom_is_rejected(tmp_path):
    archive = tmp_path / "upload"
    archive.write_bytes(series_zip(tmp=tmp_path, extra=[("a.txt", b"x" * 300)]))
    with pytest.raises(BadInputError, match="no DICOM image"):
        ingest_zip(archive, tmp_path / "work", lambda _: None)


def test_gantry_tilt_is_rejected(tmp_path):
    spec = SeriesSpec(lateral_step=(0.0, 0.5, 0.0))  # 0.5 mm per 2.5 mm slice ~ 11 degrees
    with pytest.raises(BadInputError, match="gantry-tilted"):
        ingest(tmp_path, spec)


def test_duplicate_positions_are_ignored(tmp_path):
    spec = SeriesSpec(slices=24)
    other = SeriesSpec(slices=24, series_uid=spec.series_uid, marker=(0, 0, 0))
    files = write_series(spec, tmp_path / "a") + write_series(other, tmp_path / "b")
    headers = [dicom.read_header(f) for f in files]
    geometry = dicom.slice_geometry(dicom.select_series(headers).slices)  # type: ignore[arg-type]
    assert len(geometry.slices) == 24
    assert geometry.uniform


def test_read_header_skips_non_dicom(tmp_path):
    path = tmp_path / "x"
    path.write_bytes(b"\0" * 128 + b"NOPE" + b"garbage" * 10)
    assert dicom.read_header(path) is None
