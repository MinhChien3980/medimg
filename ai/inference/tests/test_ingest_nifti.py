from __future__ import annotations

import gzip
import io

import nibabel as nib
import numpy as np
import pytest
from PIL import Image

from tests.volumes import nifti_bytes
from worker.errors import BadInputError
from worker.ingest.nifti import load_nifti
from worker.ingest.volume import axial_thumbnail, canonical_volume, infer_modality
from worker.ingest.workload import ingest_nifti

LPS_STORED = np.array(  # x and y axes stored flipped (LPS-like storage)
    [[-0.8, 0, 0, 100.0], [0, -0.8, 0, 90.0], [0, 0, 2.0, -200.0], [0, 0, 0, 1]]
)


def upload(tmp_path, data: bytes):
    path = tmp_path / "upload"
    path.write_bytes(data)
    return path


def ingest(tmp_path, data: bytes, hint: str = ""):
    work = tmp_path / "work"
    work.mkdir()
    return ingest_nifti(upload(tmp_path, data), work, hint, lambda _: None)


def volume(shape=(16, 12, 24), fill=-1000, dtype=np.int16) -> np.ndarray:
    data = np.full(shape, fill, dtype=dtype)
    data[2, 3, 4] = 500  # marker
    return data


def marker_ras(image: nib.Nifti1Image) -> np.ndarray:
    data = np.asanyarray(image.dataobj)
    ijk = np.argwhere(data == data.max())[0]
    return (image.affine @ np.array([*ijk, 1.0]))[:3]


@pytest.mark.parametrize("gz", [True, False])
def test_reorients_to_canonical_keeping_world_positions(tmp_path, gz):
    out = ingest(tmp_path, nifti_bytes(volume(), LPS_STORED, gz=gz, descrip=b"Patient^Name"))
    image = out.image
    assert nib.aff2axcodes(image.affine) == ("R", "A", "S")
    expected = (LPS_STORED @ np.array([2, 3, 4, 1.0]))[:3]
    np.testing.assert_allclose(marker_ras(image), expected, atol=1e-6)
    assert image.header["descrip"].item() == b""
    assert len(image.header.extensions) == 0
    assert image.get_data_dtype() == np.int16
    assert (int(image.header["qform_code"]), int(image.header["sform_code"])) == (1, 1)
    assert image.header.get_xyzt_units()[0] == "mm"
    assert out.modality == "CT"
    assert out.source_slices == 24
    assert out.spacing == pytest.approx([0.8, 0.8, 2.0])
    assert out.dims == [16, 12, 24]


def test_scaled_float_data_becomes_rounded_int16_hu(tmp_path):
    raw = np.full((8, 8, 20), 24, dtype=np.int16)
    raw[0, 0, 0] = 2024
    out = ingest(tmp_path, nifti_bytes(raw, np.eye(4), slope=0.5, inter=-1024.0))
    data = np.asanyarray(out.image.dataobj)
    assert data.dtype == np.int16
    assert out.hu_range() == [-1012, -12]  # 24 * 0.5 - 1024, 2024 * 0.5 - 1024


def test_ct_padding_below_air_is_clipped(tmp_path):
    data = volume(fill=-3024)
    out = ingest(tmp_path, nifti_bytes(data, np.eye(4)))
    assert out.hu_range() == [-1024, 500]


def test_float64_input_is_converted(tmp_path):
    data = volume(dtype=np.float64) + 0.4
    out = ingest(tmp_path, nifti_bytes(data, np.eye(4)))
    assert out.hu_range() == [-1000, 500]


def test_4d_with_one_volume_is_accepted(tmp_path):
    out = ingest(tmp_path, nifti_bytes(volume()[..., None], np.eye(4)))
    assert out.dims == [16, 12, 24]


def test_4d_with_several_volumes_is_rejected(tmp_path):
    with pytest.raises(BadInputError, match="3D"):
        ingest(tmp_path, nifti_bytes(np.zeros((4, 4, 24, 2), np.int16), np.eye(4)))


def test_2d_is_rejected(tmp_path):
    with pytest.raises(BadInputError, match="3D"):
        ingest(tmp_path, nifti_bytes(np.zeros((64, 64), np.int16), np.eye(4)))


def test_too_few_slices_is_rejected(tmp_path):
    with pytest.raises(BadInputError, match="19 slices"):
        ingest(tmp_path, nifti_bytes(np.zeros((32, 32, 19), np.int16), np.eye(4)))


def test_voxel_cap_is_checked_on_the_header(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    path = upload(tmp_path, nifti_bytes(np.zeros((10, 10, 20), np.int16), np.eye(4)))
    with pytest.raises(BadInputError, match="million voxels"):
        load_nifti(path, work, max_voxels=1_999)


def test_truncated_gzip_is_rejected(tmp_path):
    data = nifti_bytes(volume(), np.eye(4))
    with pytest.raises(BadInputError):
        ingest(tmp_path, data[: len(data) // 2])


def test_gzip_bomb_stops_at_the_declared_size(tmp_path):
    raw = nib.Nifti1Image(volume(), np.eye(4)).to_bytes()
    bomb = gzip.compress(raw + b"\0" * 5_000_000)
    out = ingest(tmp_path, bomb)
    assert out.dims == [16, 12, 24]
    assert (tmp_path / "work" / "upload.nii").stat().st_size == len(raw)


@pytest.mark.parametrize("data", [b"\x1f\x8b" + b"not really gzip", b"plain garbage" * 50])
def test_garbage_is_rejected(tmp_path, data):
    with pytest.raises(BadInputError, match="NIfTI"):
        ingest(tmp_path, data)


@pytest.mark.parametrize(
    ("hint", "minimum", "expected"), [("", -1000, "CT"), ("", 0, "OT"), ("MR", -1000, "MR")]
)
def test_modality(hint, minimum, expected):
    assert infer_modality(hint, np.array([minimum, 10])) == expected


def test_thumbnail_is_radiological_and_keeps_the_aspect_ratio():
    data = np.full((100, 50, 21), -1000, dtype=np.int16)  # x: 100 x 0.5 mm, y: 50 x 2 mm
    data[90:, :, :] = 300  # patient's right side (high x in RAS)
    data[:, 45:, :] = 100  # anterior (high y)
    affine = np.diag([0.5, 2.0, 3.0, 1.0])
    image = canonical_volume(data, affine, "CT")
    png = Image.open(io.BytesIO(axial_thumbnail(image)))
    assert png.mode == "L"
    assert png.size == (128, 256)  # 50 mm wide, 100 mm high
    pixels = np.asarray(png)
    assert pixels[128, 2] == 255  # right side of the patient on the left of the image
    assert pixels[2, 64] > 150  # anterior at the top (100 HU in a 400/40 window ~ 166)
    assert pixels[250, 64] == 0  # posterior, air
