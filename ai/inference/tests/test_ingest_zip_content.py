"""ZIP content detection and PNG/JPEG image stacks -> volume."""

from __future__ import annotations

import random

import nibabel as nib
import numpy as np
import pytest

from tests.radiographs import image_bytes, slice_image
from tests.volumes import SeriesSpec, write_series, zip_files
from worker.errors import BadInputError
from worker.ingest import image_stack
from worker.ingest.image_stack import natural_key
from worker.ingest.workload import ingest_zip
from worker.messages import IngestResultType

W, H = 40, 30


def stack_entries(n: int, name: str = "scan/img{k}.png", **kw) -> list[tuple[str, bytes]]:
    return [(name.format(k=k + 1), image_bytes(slice_image(k, W, H, **kw))) for k in range(n)]


def ingest(tmp_path, entries, spacing=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    archive = tmp_path / "upload"
    archive.write_bytes(zip_files(entries))
    progress: list[int] = []
    volume = ingest_zip(archive, tmp_path / "work", progress.append, slice_spacing=spacing)
    return volume, progress


def voxels(volume) -> np.ndarray:
    return np.asanyarray(volume.image.dataobj)


def dicom_entries(tmp_path, slices: int) -> list[tuple[str, bytes]]:
    files = write_series(SeriesSpec(slices=slices), tmp_path / "dicom")
    return [(f"dicom/{p.name}", p.read_bytes()) for p in files]


def test_natural_key():
    names = ["img10.png", "img2.png", "IMG3.png", "img1.png", "img02.png", "b/img1.png"]
    assert sorted(names, key=natural_key) == [
        "b/img1.png",
        "img1.png",
        "img02.png",
        "img2.png",
        "IMG3.png",
        "img10.png",
    ]


def test_stack_order_orientation_and_geometry(tmp_path):
    entries = stack_entries(25)
    random.Random(7).shuffle(entries)  # archive order must not matter
    volume, progress = ingest(tmp_path, entries)

    assert volume.input_type is IngestResultType.IMAGE_STACK
    assert (volume.modality, volume.source_slices, volume.series_count) == ("OT", 25, 1)
    assert progress == [40]
    data = voxels(volume)
    assert data.shape == (W, H, 25) and data.dtype == np.int16
    # img1 (k = 0) is the most inferior slice, img25 the most superior
    assert [int(data[0, 0, k]) for k in range(25)] == list(range(25))
    # pixel (row 2, column 5) of every image: i = W-1-5, j = H-1-2 (radiological axial view)
    for k in range(25):
        assert np.argwhere(data[:, :, k] == 200 + k).tolist() == [[W - 1 - 5, H - 1 - 2]]
    assert nib.aff2axcodes(volume.image.affine) == ("R", "A", "S")
    np.testing.assert_allclose(volume.image.affine, np.eye(4))
    assert volume.spacing == [1.0, 1.0, 1.0]
    assert volume.spacing_assumed is True


def test_given_spacing_is_used_and_not_assumed(tmp_path):
    volume, _ = ingest(tmp_path, stack_entries(20), spacing=(0.5, 0.75, 2.5))
    assert volume.spacing == [0.5, 0.75, 2.5]
    assert volume.spacing_assumed is False
    np.testing.assert_allclose(np.diag(volume.image.affine), [0.5, 0.75, 2.5, 1.0])


def test_rgb_and_palette_images_become_luminance(tmp_path):
    rgb = np.zeros((H, W, 3), dtype=np.uint8)
    rgb[..., 0] = 200  # pure red: BT.601 luminance 0.299
    entries = [(f"{k:03d}.jpg", image_bytes(rgb, "PNG")) for k in range(20)]
    volume, _ = ingest(tmp_path, entries)
    assert set(np.unique(voxels(volume)).tolist()) == {round(200 * 0.299)}


def test_jpeg_detected_by_magic_bytes_without_extension(tmp_path):
    gray = np.full((H, W), 100, dtype=np.uint8)
    entries = [(f"slice_{k}", image_bytes(gray, "JPEG")) for k in range(20)]
    volume, _ = ingest(tmp_path, entries)
    assert abs(int(voxels(volume).mean()) - 100) <= 2


def test_sixteen_bit_values_keep_their_range(tmp_path):
    low = stack_entries(20, dtype=np.uint16)
    volume, _ = ingest(tmp_path, low)
    assert voxels(volume).dtype == np.int16

    high = [
        (name, image_bytes(np.full((H, W), 40000 + k, dtype=np.uint16)))
        for k, (name, _) in enumerate(low)
    ]
    volume, _ = ingest(tmp_path / "high", high)
    data = voxels(volume)
    assert data.dtype == np.uint16
    assert volume.image.get_data_dtype() == np.uint16
    assert (int(data.min()), int(data.max())) == (40000, 40019)
    assert volume.hu_range() == [40000, 40019]


def test_size_mismatch_is_refused(tmp_path):
    entries = stack_entries(20)
    entries[7] = (entries[7][0], image_bytes(np.zeros((H, W + 1), dtype=np.uint8)))
    with pytest.raises(BadInputError) as exc:
        ingest(tmp_path, entries)
    assert str(exc.value) == (
        "all images must have the same size: 'scan/img1.png' is 40x30, 'scan/img8.png' is 41x30"
    )


def test_mixed_bit_depth_is_refused(tmp_path):
    entries = stack_entries(20)
    entries[3] = (entries[3][0], image_bytes(np.zeros((H, W), dtype=np.uint16)))
    with pytest.raises(
        BadInputError, match=r"same bit depth: 'scan/img1.png' is 8-bit, 'scan/img4"
    ):
        ingest(tmp_path, entries)


def test_macos_clutter_and_hidden_files_are_ignored(tmp_path):
    odd = image_bytes(np.zeros((5, 5), dtype=np.uint8))  # would break the size check
    clutter = [
        ("__MACOSX/scan/._img1.png", odd),
        ("scan/.hidden.png", odd),
        (".DS_Store", b"\0\0\0\1Bud1"),
        ("scan/notes.txt", b"not an image"),
    ]
    volume, _ = ingest(tmp_path, [*clutter, *stack_entries(20)])
    assert volume.source_slices == 20


def test_too_few_images_is_refused(tmp_path):
    with pytest.raises(BadInputError) as exc:
        ingest(tmp_path, stack_entries(19))
    assert str(exc.value) == "the ZIP has 19 PNG/JPEG images; a 3D volume needs at least 20"


def test_corrupt_image_is_refused(tmp_path):
    entries = stack_entries(20)
    entries[0] = (entries[0][0], entries[0][1][:45])
    with pytest.raises(BadInputError, match=r"scan/img1.png"):
        ingest(tmp_path, entries)


def test_voxel_budget_is_checked_before_decoding(tmp_path, monkeypatch):
    monkeypatch.setattr(image_stack, "MAX_VOXELS", W * H * 20 - 1)
    with pytest.raises(BadInputError, match="million voxels"):
        ingest(tmp_path, stack_entries(20))


def test_mixed_zip_more_dicom_is_a_dicom_series(tmp_path, caplog):
    volume, _ = ingest(tmp_path, [*dicom_entries(tmp_path, 22), *stack_entries(5)])
    assert volume.input_type is IngestResultType.DICOM_SERIES
    assert volume.source_slices == 22
    assert "PNG/JPEG images ignored" in caplog.text


def test_mixed_zip_more_images_is_an_image_stack(tmp_path, caplog):
    volume, _ = ingest(tmp_path, [*dicom_entries(tmp_path, 3), *stack_entries(21)])
    assert volume.input_type is IngestResultType.IMAGE_STACK
    assert volume.source_slices == 21
    assert "DICOM files ignored" in caplog.text


def test_mixed_zip_without_enough_of_either_is_refused(tmp_path):
    with pytest.raises(BadInputError) as exc:
        ingest(tmp_path, [*dicom_entries(tmp_path, 3), *stack_entries(15)])
    assert str(exc.value) == (
        "the ZIP has 3 DICOM slices and 15 PNG/JPEG images; "
        "a 3D volume needs at least 20 slices of one kind"
    )


def test_tie_goes_to_dicom(tmp_path):
    with pytest.raises(BadInputError, match="the series has 10 slices"):
        ingest(tmp_path, [*dicom_entries(tmp_path, 10), *stack_entries(10)])


def test_zip_with_nothing_usable_is_refused(tmp_path):
    with pytest.raises(BadInputError) as exc:
        ingest(tmp_path, [("a.txt", b"x"), ("b.pdf", b"%PDF-1.7")])
    assert str(exc.value) == (
        "the ZIP contains no DICOM image slices and no PNG/JPEG images (2 other files ignored)"
    )
