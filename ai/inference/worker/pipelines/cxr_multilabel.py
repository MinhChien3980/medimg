"""`cxr-multilabel`: TorchXRayVision DenseNet-121 (`densenet121-res224-all`) + Grad-CAM.

- Input: grayscale PNG/JPEG of any size. The FULL image is letterboxed to 224x224 (no center
  crop), so heatmaps map back onto the whole original image.
- Output: calibrated probabilities for every model label (xrv applies its operating-point
  normalisation, so 0.5 ~ the model's operating threshold), plus Grad-CAM heatmaps (RGBA PNG,
  original size) for at most 5 labels with confidence >= params.threshold.
"""

from __future__ import annotations

import logging
import threading
import warnings
from typing import Any

import numpy as np

from worker.errors import InvalidJobError
from worker.pipelines.base import Finding, PipelineOutput, ProgressCallback
from worker.pipelines.imaging import (
    cam_to_original,
    decode_grayscale,
    encode_png,
    letterbox,
    normalize_cam,
    render_heatmap,
)

log = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 0.5
MAX_HEATMAPS = 5
PROGRESS_PREPROCESSED = 40
PROGRESS_INFERRED = 80


def parse_threshold(params: dict[str, Any]) -> float:
    value = params.get("threshold", DEFAULT_THRESHOLD)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise InvalidJobError(f"params.threshold must be a number, got {value!r}")
    if not 0.0 <= float(value) <= 1.0:
        raise InvalidJobError(f"params.threshold must be within [0, 1], got {value}")
    return float(value)


class _LoadedModel:
    def __init__(self, model: Any, device: Any, labels: list[tuple[int, str]]) -> None:
        self.model = model
        self.device = device
        self.labels = labels  # (output index, label) for non-empty pathologies


class CxrMultilabelPipeline:
    model_code = "cxr-multilabel"
    model_version = "0.1.0-xrv"
    weights = "densenet121-res224-all"
    input_size = 224

    def __init__(self, device_kind: str = "cpu") -> None:
        self._device_kind = device_kind
        self._lock = threading.Lock()
        self._loaded: _LoadedModel | None = None

    # ------------------------------------------------------------------ model (lazy singleton)
    @property
    def loaded(self) -> bool:
        return self._loaded is not None

    def warmup(self) -> None:
        self._load()

    def _load(self) -> _LoadedModel:
        if self._loaded is not None:
            return self._loaded
        with self._lock:
            if self._loaded is None:
                import torch
                import torchxrayvision as xrv

                use_cuda = self._device_kind == "gpu" and torch.cuda.is_available()
                device = torch.device("cuda" if use_cuda else "cpu")
                with warnings.catch_warnings():
                    # the pickled checkpoint predates the installed class sources; harmless
                    warnings.simplefilter("ignore", torch.serialization.SourceChangeWarning)
                    model = xrv.models.DenseNet(weights=self.weights)
                model = model.to(device).eval()
                for param in model.parameters():
                    param.requires_grad_(False)
                labels = [(i, name) for i, name in enumerate(model.pathologies) if name]
                self._loaded = _LoadedModel(model, device, labels)
                log.info(
                    "loaded %s on %s",
                    self.weights,
                    device,
                    extra={"labels": [name for _, name in labels]},
                )
        return self._loaded

    @property
    def labels(self) -> list[str]:
        return [name for _, name in self._load().labels]

    # ------------------------------------------------------------------ inference
    def run(
        self, image_bytes: bytes, params: dict[str, Any], progress_cb: ProgressCallback
    ) -> PipelineOutput:
        import torch
        import torch.nn.functional as F
        import torchxrayvision as xrv

        threshold = parse_threshold(params)
        pixels, maxval = decode_grayscale(image_bytes)
        lm = self._load()

        normalized = xrv.datasets.normalize(pixels, maxval)  # -> [-1024, 1024]
        square, box = letterbox(normalized, self.input_size, fill=-1024.0)
        x = torch.from_numpy(square)[None, None].to(lm.device)
        progress_cb(PROGRESS_PREPROCESSED)

        model = lm.model
        with torch.no_grad():
            backbone = model.features(x)  # last dense block + norm5: (1, 1024, 7, 7)
        # Grad-CAM only needs gradients from the head down to the feature map, so the backbone
        # runs once without autograd and the head is replayed on a leaf tensor.
        feats = backbone.detach().requires_grad_(True)
        with torch.enable_grad():
            pooled = F.adaptive_avg_pool2d(F.relu(feats), (1, 1)).flatten(1)
            logits = model.classifier(pooled)
            with torch.no_grad():
                probs = torch.sigmoid(logits)
                if getattr(model, "op_threshs", None) is not None:
                    probs = xrv.models.op_norm(probs, model.op_threshs.to(probs.device))
        probs_np = probs[0].detach().cpu().numpy()

        findings = [
            Finding(label=name, confidence=float(np.clip(probs_np[idx], 0.0, 1.0)), bbox=None)
            for idx, name in lm.labels
        ]
        findings.sort(key=lambda f: f.confidence, reverse=True)
        progress_cb(PROGRESS_INFERRED)

        index_of = {name: idx for idx, name in lm.labels}
        selected = [f for f in findings if f.confidence >= threshold][:MAX_HEATMAPS]
        heatmaps: dict[str, bytes] = {}
        for finding in selected:
            (grad,) = torch.autograd.grad(
                logits[0, index_of[finding.label]], feats, retain_graph=True
            )
            weights = grad.mean(dim=(2, 3), keepdim=True)  # alpha_k^c
            cam = torch.relu((weights * feats).sum(dim=1))[0].detach().cpu().numpy()
            intensity = normalize_cam(cam_to_original(normalize_cam(cam), box))
            heatmaps[finding.label] = encode_png(render_heatmap(intensity))

        return PipelineOutput(
            model_version=self.model_version, findings=findings, heatmaps=heatmaps
        )
