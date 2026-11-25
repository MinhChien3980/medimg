"""One DICOM radiograph -> 8-bit PNG: the grayscale pipeline, decoders and refusals."""

from __future__ import annotations

import io
import struct

import numpy as np
import pytest
from PIL import Image

from tests.radiographs import (
    gdcm_transcode,
    jpeg2000_lossless,
    jpeg_baseline,
    radiograph,
    ramp,
    save,
    with_voi_lut,
)
from worker.errors import BadInputError
from worker.ingest.radiograph import ingest_radiograph, window


def ingest(tmp_path, ds):
    progress: list[int] = []
    result = ingest_radiograph(save(ds, tmp_path / "upload"), progress.append)
    assert progress == [40, 70]
    return result


def pixels_of(png: bytes) -> np.ndarray:
    image = Image.open(io.BytesIO(png))
    assert image.mode == "L"
    return np.asarray(image)


def columns(width: int, values: list[int], rows: int = 256, fill: int = 0) -> np.ndarray:
    """uint16 image whose first columns hold `values`, the rest `fill`."""
    image = np.full((rows, width), fill, dtype=np.uint16)
    image[:, : len(values)] = values
    return image


def png_chunks(png: bytes) -> list[bytes]:
    chunks, pos = [], 8
    while pos < len(png):
        length, kind = struct.unpack(">I4s", png[pos : pos + 8])
        chunks.append(kind)
        pos += 12 + length
    return chunks


def test_monochrome2_without_window_stretches_the_value_range(tmp_path):
    result = ingest(tmp_path, radiograph(ramp(top=4095)))
    out = pixels_of(result.png)
    assert out.shape == (300, 260)
    assert (int(out.min()), int(out.max())) == (0, 255)
    expected = np.rint(np.rint(np.linspace(0, 4095, 260)) / 4095 * 255)
    np.testing.assert_array_equal(out[0], expected)
    assert (result.width, result.height, result.modality) == (260, 300, "DX")


def test_monochrome1_is_the_inverse_of_monochrome2(tmp_path):
    two = pixels_of(ingest(tmp_path, radiograph(photometric="MONOCHROME2")).png)
    one = pixels_of(ingest(tmp_path, radiograph(photometric="MONOCHROME1")).png)
    np.testing.assert_array_equal(one.astype(int), 255 - two.astype(int))
    assert one[0, 0] == 255  # lowest stored value is white in MONOCHROME1


def test_presentation_lut_shape_inverse_also_inverts(tmp_path):
    plain = pixels_of(ingest(tmp_path, radiograph()).png)
    inverse = pixels_of(ingest(tmp_path, radiograph(PresentationLUTShape="INVERSE")).png)
    np.testing.assert_array_equal(inverse.astype(int), 255 - plain.astype(int))


def test_rescale_then_window(tmp_path):
    # stored s -> modality 2s - 1000 -> window centre 1000, width 4001 (LINEAR, PS3.3 C.11.2.1.2)
    stored = columns(256, [0, 500, 1000, 1500, 2000, 4095], fill=1000)
    ds = radiograph(stored, RescaleSlope=2, RescaleIntercept=-1000)
    ds.WindowCenter, ds.WindowWidth = 1000, 4001
    out = pixels_of(ingest(tmp_path, ds).png)
    assert out[0, :6].tolist() == [0, 64, 128, 191, 255, 255]


def test_first_of_several_windows_is_used(tmp_path):
    stored = columns(256, [0, 1000, 2000], fill=1000)
    ds = radiograph(stored, WindowCenter=[1000, 50], WindowWidth=[2001, 10])
    out = pixels_of(ingest(tmp_path, ds).png)
    assert out[0, :3].tolist() == [0, 128, 255]


def test_monochrome1_is_inverted_after_the_window(tmp_path):
    stored = columns(256, [0, 1000, 2000], fill=1000)
    ds = radiograph(stored, photometric="MONOCHROME1", WindowCenter=1000, WindowWidth=2001)
    out = pixels_of(ingest(tmp_path, ds).png)
    assert out[0, :3].tolist() == [255, 127, 0]


@pytest.mark.parametrize(
    ("function", "expected"),
    [("LINEAR", [0.0, 0.5, 1.0]), ("LINEAR_EXACT", [0.0, 0.5, 1.0]), ("SIGMOID", [0.0, 0.5, 1.0])],
)
def test_window_functions(function, expected):
    values = np.array([-1e4, 100.0, 1e4], dtype=np.float32)
    window(values, 100.0, 50.0, function)
    np.testing.assert_allclose(values, expected, atol=0.02)


def test_voi_lut_sequence_wins_over_the_window(tmp_path):
    # a step LUT with 12-bit entries under a descriptor that claims 16 bits
    table = [0] * 2048 + [4095] * 2048
    ds = with_voi_lut(radiograph(ramp(top=4095)), table, bits=16)
    ds.WindowCenter, ds.WindowWidth = 4000, 10  # would make nearly everything black
    out = pixels_of(ingest(tmp_path, ds).png)
    stored = ramp(top=4095)[0]
    np.testing.assert_array_equal(out[0], np.where(stored < 2048, 0, 255))


def test_voi_lut_first_mapped_value_and_clamping(tmp_path):
    stored = columns(256, [0, 100, 101, 102, 500], fill=100)
    ds = with_voi_lut(radiograph(stored), [0, 128, 255], first=100, bits=8)
    out = pixels_of(ingest(tmp_path, ds).png)
    assert out[0, :5].tolist() == [0, 0, 128, 255, 255]


def test_invalid_window_falls_back_to_the_data_range(tmp_path):
    ds = radiograph(ramp(top=1000), WindowCenter=500, WindowWidth=0)
    out = pixels_of(ingest(tmp_path, ds).png)
    assert (int(out[0, 0]), int(out[0, -1])) == (0, 255)


def test_signed_pixels(tmp_path):
    stored = np.zeros((256, 256), dtype=np.int16)
    stored[:, :3] = [-2000, 0, 2000]
    out = pixels_of(ingest(tmp_path, radiograph(stored)).png)
    assert out[0, :3].tolist() == [0, 128, 255]


def test_rgb_secondary_capture_becomes_luminance(tmp_path):
    rgb = np.zeros((256, 256, 3), dtype=np.uint8)
    rgb[:, :, 1] = 255  # pure green: BT.601 luminance 0.587
    ds = radiograph(rgb[:, :, 0], modality="OT", bits=8)
    ds.SamplesPerPixel, ds.PhotometricInterpretation, ds.PlanarConfiguration = 3, "RGB", 0
    ds.PixelData = rgb.tobytes()
    out = pixels_of(ingest(tmp_path, ds).png)
    assert int(out[0, 0]) == round(0.587 * 255)


def test_png_has_no_metadata_and_a_256_px_thumbnail(tmp_path):
    ds = radiograph(ramp(rows=600, columns=300), PatientName="Doe^Jane", PatientID="12345")
    result = ingest(tmp_path, ds)
    assert set(png_chunks(result.png)) == {b"IHDR", b"IDAT", b"IEND"}
    assert b"Doe" not in result.png and b"12345" not in result.png
    thumb = Image.open(io.BytesIO(result.thumbnail))
    assert (thumb.mode, thumb.size) == ("L", (128, 256))


def test_thumbnail_keeps_the_aspect_of_non_square_pixels(tmp_path):
    ds = radiograph(ramp(rows=256, columns=256), PixelSpacing=[0.2, 0.1])  # rows 0.2, cols 0.1
    thumb = Image.open(io.BytesIO(ingest(tmp_path, ds).thumbnail))
    assert thumb.size == (128, 256)


@pytest.mark.parametrize(
    ("elements", "expected"),
    [
        ({"PixelSpacing": [0.15, 0.1]}, (0.1, 0.15)),
        ({"ImagerPixelSpacing": [0.2, 0.2]}, (0.2, 0.2)),
        ({"PixelSpacing": [0.14, 0.14], "ImagerPixelSpacing": [0.2, 0.2]}, (0.14, 0.14)),
        ({"PixelSpacing": [0, 0], "ImagerPixelSpacing": [0.2, 0.25]}, (0.25, 0.2)),
        ({}, None),
    ],
)
def test_pixel_spacing_is_returned_as_x_then_y(tmp_path, elements, expected):
    assert ingest(tmp_path, radiograph(**elements)).spacing == expected


def test_jpeg_baseline(tmp_path):
    smooth = np.tile(np.linspace(0, 255, 256), (256, 1))
    out = pixels_of(ingest(tmp_path, jpeg_baseline(smooth)).png).astype(int)
    assert np.abs(out - np.rint(smooth)).mean() < 3  # lossy


def test_jpeg2000_lossless(tmp_path):
    stored = ramp(rows=256, columns=300, top=4095)
    reference = pixels_of(ingest(tmp_path, radiograph(stored)).png)
    out = pixels_of(ingest(tmp_path, jpeg2000_lossless(stored, BitsStored=12, HighBit=11)).png)
    np.testing.assert_array_equal(out, reference)


@pytest.mark.parametrize("syntax", ["JPEGLosslessProcess14_1", "JPEGLSLossless"])
def test_lossless_jpeg_family_through_gdcm(tmp_path, syntax):
    pytest.importorskip("gdcm")
    stored = ramp(rows=256, columns=300, top=4095)
    source = save(radiograph(stored, photometric="MONOCHROME1"), tmp_path / "plain.dcm")
    reference = pixels_of(ingest_radiograph(source, lambda _: None).png)
    gdcm_transcode(source, tmp_path / "upload", syntax)
    out = pixels_of(ingest_radiograph(tmp_path / "upload", lambda _: None).png)
    np.testing.assert_array_equal(out, reference)


@pytest.mark.parametrize("modality", ["CT", "MR", "PT", "US"])
def test_a_single_slice_of_a_series_is_refused(tmp_path, modality):
    with pytest.raises(BadInputError) as exc:
        ingest(tmp_path, radiograph(modality=modality))
    assert str(exc.value) == (
        f"this DICOM file is a single {modality} slice; "
        "upload the whole series as a ZIP of its DICOM files"
    )


def test_other_modalities_are_refused(tmp_path):
    with pytest.raises(BadInputError, match=r"modality XA is not supported .*CR, DX, MG, OT"):
        ingest(tmp_path, radiograph(modality="XA"))


@pytest.mark.parametrize("modality", ["CR", "DX", "RG", "MG", "PX", "OT"])
def test_radiograph_modalities_are_accepted(tmp_path, modality):
    assert ingest(tmp_path, radiograph(modality=modality)).modality == modality


def test_multi_frame_is_refused(tmp_path):
    with pytest.raises(BadInputError, match=r"multi-frame DICOM \(3 frames\)"):
        ingest(tmp_path, radiograph(NumberOfFrames=3))


def test_no_pixel_data_is_refused(tmp_path):
    ds = radiograph()
    del ds.PixelData
    with pytest.raises(BadInputError, match="no pixel data"):
        ingest(tmp_path, ds)


@pytest.mark.parametrize(("rows", "cols"), [(255, 300), (300, 100)])
def test_too_small_is_refused(tmp_path, rows, cols):
    with pytest.raises(BadInputError, match=f"is {cols}x{rows} pixels; at least 256"):
        ingest(tmp_path, radiograph(ramp(rows=rows, columns=cols)))


def test_too_large_is_refused_before_decoding(tmp_path):
    ds = radiograph(ramp(rows=256, columns=256))
    ds.Rows, ds.Columns = 8000, 7000  # pixel data far too short: never decoded
    with pytest.raises(BadInputError, match="56 million pixels; at most 50 million"):
        ingest(tmp_path, ds)


def test_not_dicom_is_refused(tmp_path):
    path = tmp_path / "upload"
    path.write_bytes(b"\0" * 128 + b"DICM" + b"\xff" * 64)
    with pytest.raises(BadInputError, match=r"not a readable DICOM|no pixel data"):
        ingest_radiograph(path, lambda _: None)


def test_undecodable_pixel_data_is_refused(tmp_path):
    ds = jpeg_baseline(np.zeros((256, 256)))
    ds.PixelData = ds.PixelData[:40] + b"\x00" * 200
    with pytest.raises(BadInputError, match=r"cannot decode the DICOM pixel data \(JPEG Baseline"):
        ingest(tmp_path, ds)
