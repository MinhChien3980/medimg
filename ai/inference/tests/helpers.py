"""Shared test helpers (fake pipeline, message/image builders)."""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image

from worker.messages import RESULTS_STREAM
from worker.pipelines.base import Finding, PipelineOutput, ProgressCallback

BUCKET = "medimg"
WORKER_ID = "test-worker"
INPUT_URI = f"s3://{BUCKET}/studies/s1/series/se1/image.png"


def png_bytes(width: int = 320, height: int = 256, mode: str = "L") -> bytes:
    rng = np.random.default_rng(0)
    if mode == "I;16":
        arr = rng.integers(0, 65535, size=(height, width), dtype=np.uint16)
    else:
        arr = rng.integers(0, 255, size=(height, width), dtype=np.uint8)
    img = Image.fromarray(arr)
    if mode not in ("L", "I;16"):
        img = img.convert(mode)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class FakePipeline:
    """Deterministic pipeline: emits 40/80 progress and returns fixed findings (sorted, as the
    Pipeline contract requires)."""

    model_code: str = "cxr-multilabel"
    model_version: str = "0.1.0-xrv"
    findings: list[Finding] = field(
        default_factory=lambda: [
            Finding("Cardiomegaly", 0.87),
            Finding("Effusion", 0.61234567),
            Finding("Lung Opacity", 0.55),
            Finding("Hernia", 0.01),
        ]
    )
    threshold_default: float = 0.5
    before_run: Callable[[], None] | None = None
    error: BaseException | None = None
    calls: list[bytes] = field(default_factory=list)
    _loaded: bool = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    def warmup(self) -> None:
        self._loaded = True

    def run(
        self, image_bytes: bytes, params: dict[str, Any], progress_cb: ProgressCallback
    ) -> PipelineOutput:
        self._loaded = True
        self.calls.append(image_bytes)
        if self.before_run:
            self.before_run()
        progress_cb(40)
        if self.error is not None:
            raise self.error
        progress_cb(80)
        threshold = params.get("threshold", self.threshold_default)
        hot = sorted(
            (f for f in self.findings if f.confidence >= threshold),
            key=lambda f: f.confidence,
            reverse=True,
        )
        return PipelineOutput(
            model_version=self.model_version,
            findings=list(self.findings),
            heatmaps={f.label: b"\x89PNG-fake-" + f.label.encode() for f in hot},
        )


def job_fields(job_id: str = "11111111-1111-1111-1111-111111111111", **overrides: str):
    fields = {
        "jobId": job_id,
        "attempt": "1",
        "modelCode": "cxr-multilabel",
        "modelVersion": "0.1.0-xrv",
        "task": "CLASSIFICATION_2D",
        "inputType": "IMAGE_2D",
        "inputUri": INPUT_URI,
        "outputPrefix": f"s3://{BUCKET}/predictions/{job_id}/1/",
        "params": json.dumps({"threshold": 0.5}),
    }
    fields.update(overrides)
    return fields


def results(redis_client) -> list[dict[str, str]]:
    return [fields for _, fields in redis_client.xrange(RESULTS_STREAM)]
