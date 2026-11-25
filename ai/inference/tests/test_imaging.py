from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from tests.helpers import png_bytes
from worker.errors import BadInputError
from worker.pipelines.imaging import (
    HEATMAP_ALPHA_FLOOR,
    HEATMAP_MAX_ALPHA,
    Letterbox,
    cam_to_original,
    decode_grayscale,
    encode_png,
    jet,
    letterbox,
    normalize_cam,
    render_heatmap,
)

# ------------------------------------------------------------------ decoding


@pytest.mark.parametrize(
    ("mode", "maxval"), [("L", 255.0), ("RGB", 255.0), ("RGBA", 255.0), ("I;16", 65535.0)]
)
def test_decode_modes(mode, maxval):
    arr, got_max = decode_grayscale(png_bytes(300, 200, mode))
    assert arr.shape == (200, 300)
    assert arr.dtype == np.float32
    assert got_max == maxval
    assert arr.min() >= 0 and arr.max() <= maxval


def test_decode_jpeg():
    buf = io.BytesIO()
    Image.new("L", (64, 48), 128).save(buf, format="JPEG")
    arr, maxval = decode_grayscale(buf.getvalue())
    assert arr.shape == (48, 64) and maxval == 255.0


@pytest.mark.parametrize("data", [b"", b"not an image", png_bytes()[:60]])
def test_decode_garbage_raises_bad_input(data):
    with pytest.raises(BadInputError):
        decode_grayscale(data)


def test_decode_rejects_tiny_images():
    with pytest.raises(BadInputError):
        decode_grayscale(png_bytes(8, 8))


# ------------------------------------------------------------------ letterbox math


def test_letterbox_landscape():
    lb = Letterbox.compute(400, 200, 224)
    assert (lb.new_w, lb.new_h) == (224, 112)
    assert (lb.pad_x, lb.pad_y) == (0, 56)
    assert lb.content_box == (0, 56, 224, 168)


def test_letterbox_portrait():
    lb = Letterbox.compute(1000, 2000, 224)
    assert (lb.new_w, lb.new_h) == (112, 224)
    assert lb.content_box == (56, 0, 168, 224)


def test_letterbox_square_has_no_padding():
    lb = Letterbox.compute(512, 512, 224)
    assert lb.content_box == (0, 0, 224, 224)


def test_letterbox_image_keeps_full_content_and_pads():
    img = np.full((200, 400), 1000.0, dtype=np.float32)
    square, lb = letterbox(img, 224, fill=-1024.0)
    assert square.shape == (224, 224)
    x0, y0, x1, y1 = lb.content_box
    assert np.allclose(square[y0:y1, x0:x1], 1000.0)
    assert np.all(square[:y0] == -1024.0) and np.all(square[y1:] == -1024.0)


def test_letterbox_preserves_position_of_features():
    """A bright block in the original lands at the mapped place in the square."""
    img = np.zeros((200, 400), dtype=np.float32)
    img[50:100, 300:380] = 1.0  # rows 50-100, cols 300-380
    square, lb = letterbox(img, 224, fill=0.0)
    ys, xs = np.nonzero(square > 0.5)
    ex0, ey0 = lb.pad_x + 300 * lb.scale, lb.pad_y + 50 * lb.scale
    ex1, ey1 = lb.pad_x + 380 * lb.scale, lb.pad_y + 100 * lb.scale
    assert xs.min() == pytest.approx(ex0, abs=1.5) and xs.max() + 1 == pytest.approx(ex1, abs=1.5)
    assert ys.min() == pytest.approx(ey0, abs=1.5) and ys.max() + 1 == pytest.approx(ey1, abs=1.5)


# ------------------------------------------------------------------ CAM mapping


@pytest.mark.parametrize(("w", "h"), [(400, 200), (300, 600), (512, 512), (1023, 777)])
def test_cam_to_original_has_original_size(w, h):
    lb = Letterbox.compute(w, h, 224)
    out = cam_to_original(np.random.default_rng(1).random((7, 7), dtype=np.float32), lb)
    assert out.shape == (h, w)


def test_cam_hotspot_maps_back_to_original_location():
    """Fake CAM at full square resolution: hot on the left half of the content box only."""
    w, h = 400, 200
    lb = Letterbox.compute(w, h, 224)
    cam = np.zeros((224, 224), dtype=np.float32)
    x0, y0, x1, y1 = lb.content_box
    cam[y0:y1, x0 : (x0 + x1) // 2] = 1.0
    cam[:y0] = 1.0  # padding must not leak into the original image
    cam[y1:] = 1.0

    mapped = cam_to_original(cam, lb)
    assert mapped.shape == (h, w)
    assert mapped[:, : w // 2 - 4].min() > 0.9
    # bilinear sampling may blend the padding into the outermost pixel row only
    assert mapped[2:-2, w // 2 + 4 :].max() < 0.1
    assert mapped[[0, -1], w // 2 + 4 :].max() < 0.5


def test_coarse_cam_cell_maps_to_expected_region():
    """7x7 CAM (DenseNet feature grid) with one hot cell inside the content area."""
    w, h = 448, 224  # content occupies square rows 56..168 -> CAM rows 1.75..5.25
    lb = Letterbox.compute(w, h, 224)
    cam = np.zeros((7, 7), dtype=np.float32)
    cam[3, 1] = 1.0  # center of cell (x=1.5, y=3.5) in 7x7 units -> square (48, 112)
    mapped = cam_to_original(cam, lb)
    peak_y, peak_x = np.unravel_index(np.argmax(mapped), mapped.shape)
    exp_x, exp_y = (48 - lb.pad_x) / lb.scale, (112 - lb.pad_y) / lb.scale  # (96, 112)
    assert peak_x == pytest.approx(exp_x, abs=w / 14)
    assert peak_y == pytest.approx(exp_y, abs=h / 7)


def test_normalize_cam():
    assert normalize_cam(np.array([[-1.0, 0.0], [2.0, 4.0]])).tolist() == [[0, 0], [0.5, 1.0]]
    assert normalize_cam(np.zeros((3, 3))).max() == 0
    assert normalize_cam(np.full((2, 2), -5.0)).max() == 0


# ------------------------------------------------------------------ heatmap rendering


def test_jet_endpoints():
    colors = jet(np.array([0.0, 0.5, 1.0]))
    assert colors[0].tolist() == pytest.approx([0.0, 0.0, 0.5])  # dark blue
    assert colors[1].tolist() == pytest.approx([0.5, 1.0, 0.5])  # green-ish center
    assert colors[2].tolist() == pytest.approx([0.5, 0.0, 0.0])  # dark red


def test_render_heatmap_alpha():
    intensity = np.array([[0.0, HEATMAP_ALPHA_FLOOR / 2, 0.5, 1.0]], dtype=np.float32)
    rgba = render_heatmap(intensity)
    assert rgba.shape == (1, 4, 4) and rgba.dtype == np.uint8
    alpha = rgba[0, :, 3]
    assert alpha[0] == 0 and alpha[1] == 0  # below floor -> transparent
    assert alpha[2] == pytest.approx(0.5 * HEATMAP_MAX_ALPHA * 255, abs=1)
    assert alpha[3] == pytest.approx(HEATMAP_MAX_ALPHA * 255, abs=1)  # max ~0.6
    assert alpha[3] > alpha[2]


def test_heatmap_png_from_fake_cam_has_original_size_and_rgba():
    w, h = 640, 480
    lb = Letterbox.compute(w, h, 224)
    cam = np.zeros((7, 7), dtype=np.float32)
    cam[2:4, 4:6] = 3.0
    intensity = normalize_cam(cam_to_original(normalize_cam(cam), lb))
    png = encode_png(render_heatmap(intensity))

    img = Image.open(io.BytesIO(png))
    assert img.format == "PNG"
    assert img.mode == "RGBA"
    assert img.size == (w, h)
    alpha = np.asarray(img)[..., 3]
    assert alpha.max() == pytest.approx(HEATMAP_MAX_ALPHA * 255, abs=1)
    assert (alpha == 0).mean() > 0.3  # cold regions are transparent
