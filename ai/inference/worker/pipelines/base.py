"""Pipeline port: `modelCode -> Pipeline`. Pipelines are pure (bytes in, results out); the
consumer owns Redis and object storage."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

ProgressCallback = Callable[[int], None]
"""Called with a 0-100 percentage between steps. May raise JobCancelled."""


@dataclass(frozen=True)
class Finding:
    label: str
    confidence: float
    bbox: list[float] | None = None


@dataclass
class PipelineOutput:
    model_version: str
    findings: list[Finding]
    """Every label the model scores, highest confidence first (the order of the DONE payload)."""
    heatmaps: dict[str, bytes] = field(default_factory=dict)
    """label -> PNG bytes (RGBA, same size as the input image)."""


@runtime_checkable
class Pipeline(Protocol):
    model_code: str
    model_version: str

    @property
    def loaded(self) -> bool: ...

    def warmup(self) -> None:
        """Load weights eagerly (optional; `run` loads lazily otherwise)."""
        ...

    def run(
        self, image_bytes: bytes, params: dict[str, Any], progress_cb: ProgressCallback
    ) -> PipelineOutput: ...
