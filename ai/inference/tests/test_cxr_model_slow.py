"""Real-model smoke test (TorchXRayVision weights must be cached; baked into the Docker image).

Run: pytest -m slow -s
"""

from __future__ import annotations

import io
import os
import time

import numpy as np
import pytest
from PIL import Image

from worker.errors import InvalidJobError

xrv = pytest.importorskip("torchxrayvision")
torch = pytest.importorskip("torch")

pytestmark = pytest.mark.slow

EXPECTED_LABELS = {
    "Atelectasis",
    "Consolidation",
    "Infiltration",
    "Pneumothorax",
    "Edema",
    "Emphysema",
    "Fibrosis",
    "Effusion",
    "Pneumonia",
    "Pleural_Thickening",
    "Cardiomegaly",
    "Nodule",
    "Mass",
    "Hernia",
    "Lung Lesion",
    "Fracture",
    "Lung Opacity",
    "Enlarged Cardiomediastinum",
}


def _weights_cached() -> bool:
    url = xrv.models.model_urls["densenet121-res224-all"]["weights_url"]
    path = os.path.join(xrv.utils.get_cache_dir(), os.path.basename(url))
    return os.path.exists(path)


if not _weights_cached():
    pytest.skip("xrv weights not cached (build the Docker image)", allow_module_level=True)


def synthetic_cxr(width: int = 600, height: int = 480) -> bytes:
    """Rough chest-X-ray-like picture: dark lungs inside a bright body, a spine, some noise."""
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    img = np.full((height, width), 40.0, dtype=np.float32)
    body = ((xx - width / 2) / (width * 0.45)) ** 2 + ((yy - height * 0.55) / (height * 0.5)) ** 2
    img[body < 1] = 190
    for cx in (0.33, 0.67):
        dx = (xx - width * cx) / (width * 0.14)
        dy = (yy - height * 0.5) / (height * 0.3)
        lung = dx**2 + dy**2
        img[lung < 1] = 70
    img[:, int(width * 0.48) : int(width * 0.52)] = 220
    img += np.random.default_rng(0).normal(0, 6, img.shape)
    buf = io.BytesIO()
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def pipeline():
    from worker.pipelines.cxr_multilabel import CxrMultilabelPipeline

    p = CxrMultilabelPipeline("cpu")
    p.warmup()
    return p


def test_labels(pipeline):
    assert set(pipeline.labels) == EXPECTED_LABELS
    assert len(pipeline.labels) == 18
    assert pipeline.model_version == "0.1.0-xrv"


def test_real_model_findings_and_heatmaps(pipeline):
    data = synthetic_cxr(600, 480)
    progress: list[int] = []
    pipeline.run(data, {"threshold": 0.0}, progress.append)  # warm caches / threads

    t0 = time.perf_counter()
    out = pipeline.run(data, {"threshold": 0.0}, progress.append)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    print(f"\n[cxr-multilabel] CPU pipeline time (600x480, 5 heatmaps): {elapsed_ms:.0f} ms")

    t0 = time.perf_counter()
    pipeline.run(data, {"threshold": 1.0}, lambda _: None)
    print(
        f"[cxr-multilabel] CPU pipeline time (no heatmaps): "
        f"{(time.perf_counter() - t0) * 1000:.0f} ms"
    )

    assert progress[:2] == [40, 80]
    assert out.model_version == "0.1.0-xrv"
    assert {f.label for f in out.findings} == EXPECTED_LABELS
    confidences = [f.confidence for f in out.findings]
    assert confidences == sorted(confidences, reverse=True)
    assert all(0.0 <= c <= 1.0 for c in confidences)
    assert all(f.bbox is None for f in out.findings)

    # threshold 0 -> every label qualifies, capped at the 5 most confident
    assert list(out.heatmaps) == [f.label for f in out.findings[:5]]
    for png in out.heatmaps.values():
        img = Image.open(io.BytesIO(png))
        assert img.mode == "RGBA" and img.size == (600, 480)
        alpha = np.asarray(img)[..., 3]
        assert 0 < alpha.max() <= 154


def test_probabilities_match_model_forward(pipeline):
    """The replayed head (needed for Grad-CAM) must equal xrv's own forward()."""
    from worker.pipelines.imaging import decode_grayscale, letterbox

    data = synthetic_cxr(512, 512)
    out = pipeline.run(data, {"threshold": 1.0}, lambda _: None)
    pixels, maxval = decode_grayscale(data)
    square, _ = letterbox(xrv.datasets.normalize(pixels, maxval), 224, fill=-1024.0)
    model = pipeline._load().model
    with torch.no_grad():
        ref = model(torch.from_numpy(square)[None, None])[0].numpy()
    ref_by_label = {name: float(ref[i]) for i, name in enumerate(model.pathologies) if name}
    for f in out.findings:
        assert f.confidence == pytest.approx(ref_by_label[f.label], abs=1e-5)
    assert out.heatmaps == {}


def test_threshold_validation(pipeline):
    with pytest.raises(InvalidJobError):
        pipeline.run(synthetic_cxr(), {"threshold": 1.5}, lambda _: None)
    with pytest.raises(InvalidJobError):
        pipeline.run(synthetic_cxr(), {"threshold": "high"}, lambda _: None)
