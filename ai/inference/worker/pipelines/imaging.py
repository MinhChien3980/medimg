"""Image helpers shared by 2D pipelines (no torch here, so they are cheap to unit test).

Geometry: the full original image is letterboxed (aspect-preserving resize + centered padding)
into a square model input. Heatmaps are mapped back by cropping the CAM to the content box and
resizing that crop to the original width/height, so every heatmap pixel lines up with the
original image.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, UnidentifiedImageError

from worker.errors import BadInputError

MIN_IMAGE_SIDE = 16
Image.MAX_IMAGE_PIXELS = 100_000_000  # ~10k x 10k, well above any chest X-ray


def decode_grayscale(data: bytes) -> tuple[np.ndarray, float]:
    """Decode PNG/JPEG bytes to a float32 grayscale array (H, W) and its nominal max value
    (255 for 8-bit, 65535 for 16-bit)."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            mode = img.mode
            if mode in ("I;16", "I;16L", "I;16B", "I;16N"):
                arr = np.asarray(img, dtype=np.uint16).astype(np.float32)
                maxval = 65535.0
            elif mode == "I":  # 16-bit PNGs may decode as 32-bit int
                arr = np.asarray(img, dtype=np.int64).astype(np.float32)
                maxval = 65535.0 if arr.max(initial=0) > 255 else 255.0
            elif mode == "F":
                arr = np.asarray(img, dtype=np.float32)
                peak = float(arr.max(initial=0))
                maxval = 1.0 if peak <= 1.0 else (255.0 if peak <= 255.0 else 65535.0)
            else:
                arr = np.asarray(img.convert("L"), dtype=np.float32)
                maxval = 255.0
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
        raise BadInputError(f"cannot decode input image: {exc}") from exc

    if arr.ndim != 2:
        raise BadInputError(f"expected a 2D grayscale image, got shape {arr.shape}")
    h, w = arr.shape
    if min(h, w) < MIN_IMAGE_SIDE:
        raise BadInputError(f"image too small: {w}x{h}")
    arr = np.clip(arr, 0.0, maxval)
    return arr, maxval


@dataclass(frozen=True)
class Letterbox:
    """Placement of a (src_w x src_h) image inside a (size x size) square."""

    src_w: int
    src_h: int
    size: int
    scale: float
    new_w: int
    new_h: int
    pad_x: int
    pad_y: int

    @classmethod
    def compute(cls, src_w: int, src_h: int, size: int) -> Letterbox:
        if src_w <= 0 or src_h <= 0:
            raise ValueError("image dimensions must be positive")
        scale = size / max(src_w, src_h)
        new_w = max(1, min(size, round(src_w * scale)))
        new_h = max(1, min(size, round(src_h * scale)))
        return cls(
            src_w=src_w,
            src_h=src_h,
            size=size,
            scale=scale,
            new_w=new_w,
            new_h=new_h,
            pad_x=(size - new_w) // 2,
            pad_y=(size - new_h) // 2,
        )

    @property
    def content_box(self) -> tuple[int, int, int, int]:
        """(x0, y0, x1, y1) of the image content inside the square, x1/y1 exclusive."""
        return self.pad_x, self.pad_y, self.pad_x + self.new_w, self.pad_y + self.new_h


def letterbox(arr: np.ndarray, size: int, fill: float) -> tuple[np.ndarray, Letterbox]:
    """Resize the full image (no cropping) into a size x size square, padding with `fill`."""
    h, w = arr.shape
    lb = Letterbox.compute(w, h, size)
    resized = Image.fromarray(np.ascontiguousarray(arr, dtype=np.float32)).resize(
        (lb.new_w, lb.new_h), Image.Resampling.BILINEAR
    )
    out = np.full((size, size), fill, dtype=np.float32)
    x0, y0, x1, y1 = lb.content_box
    out[y0:y1, x0:x1] = np.asarray(resized, dtype=np.float32)
    return out, lb


def cam_to_original(cam: np.ndarray, lb: Letterbox) -> np.ndarray:
    """Map a CAM computed on the square input (any resolution, e.g. 7x7 features) back onto the
    original image: crop the content box (in CAM coordinates) and resize it to src_w x src_h."""
    cam_h, cam_w = cam.shape
    x0, y0, x1, y1 = lb.content_box
    sx, sy = cam_w / lb.size, cam_h / lb.size
    box = (x0 * sx, y0 * sy, x1 * sx, y1 * sy)
    mapped = Image.fromarray(np.ascontiguousarray(cam, dtype=np.float32)).resize(
        (lb.src_w, lb.src_h), Image.Resampling.BILINEAR, box=box
    )
    return np.asarray(mapped, dtype=np.float32)


def normalize_cam(cam: np.ndarray) -> np.ndarray:
    """ReLU + scale to [0, 1] (all zeros stays all zeros)."""
    cam = np.maximum(cam.astype(np.float32), 0.0)
    peak = float(cam.max(initial=0.0))
    if peak <= 1e-12 or not np.isfinite(peak):
        return np.zeros_like(cam)
    return np.clip(cam / peak, 0.0, 1.0)


def jet(values: np.ndarray) -> np.ndarray:
    """Classic jet colormap: [0,1] -> RGB float in [0,1], shape (..., 3)."""
    v = np.clip(values, 0.0, 1.0)[..., None]
    centers = np.array([0.75, 0.5, 0.25], dtype=np.float32)  # R, G, B
    return np.clip(1.5 - np.abs(4.0 * v - 4.0 * centers), 0.0, 1.0)


HEATMAP_MAX_ALPHA = 0.6
HEATMAP_ALPHA_FLOOR = 0.15


def _rgba_lut(max_alpha: float, floor: float) -> np.ndarray:
    """256-entry RGBA lookup table: jet color, alpha = max_alpha * v, transparent below floor."""
    v = np.linspace(0.0, 1.0, 256, dtype=np.float32)
    alpha = np.where(v >= floor, v * max_alpha, 0.0)
    rgba = np.concatenate([jet(v), alpha[:, None]], axis=-1)
    return np.round(rgba * 255.0).astype(np.uint8)


_DEFAULT_LUT = _rgba_lut(HEATMAP_MAX_ALPHA, HEATMAP_ALPHA_FLOOR)


def render_heatmap(
    intensity: np.ndarray,
    max_alpha: float = HEATMAP_MAX_ALPHA,
    floor: float = HEATMAP_ALPHA_FLOOR,
) -> np.ndarray:
    """Intensity (H, W) in [0, 1] -> RGBA uint8 (H, W, 4): jet color, alpha = max_alpha *
    intensity, fully transparent below `floor`. Quantised to 256 levels via a lookup table
    (multi-megapixel X-rays render in tens of ms)."""
    if (max_alpha, floor) == (HEATMAP_MAX_ALPHA, HEATMAP_ALPHA_FLOOR):
        lut = _DEFAULT_LUT
    else:
        lut = _rgba_lut(max_alpha, floor)
    index = np.empty(intensity.shape, dtype=np.float32)
    np.clip(intensity, 0.0, 1.0, out=index)
    index *= 255.0
    index += 0.5
    return lut[index.astype(np.uint8)]


def encode_png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    # Low zlib level: heatmaps are smooth, so size barely changes but encoding is much faster.
    Image.fromarray(np.ascontiguousarray(rgba, dtype=np.uint8)).save(
        buf, format="PNG", compress_level=3
    )
    return buf.getvalue()
