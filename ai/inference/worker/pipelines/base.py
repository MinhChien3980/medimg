"""Pipeline ports: `modelCode -> pipeline`. Pipelines are pure (input in, results out); the
consumer owns Redis and object storage.

- `Pipeline` takes the input object as bytes (2D images, small).
- `FilePipeline` takes it as a temporary file and may write its artifacts (segmentation, meshes)
  into the job's working directory; the consumer uploads them and removes the directory.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

ProgressCallback = Callable[[int], None]
"""Called with a 0-100 percentage between steps. May raise JobCancelled."""


@dataclass(frozen=True)
class Finding:
    label: str
    confidence: float | None
    """None for segmentation labels, which have a volume instead."""
    bbox: list[float] | None = None
    volume_ml: float | None = None


@dataclass(frozen=True)
class MeshArtifact:
    label: str
    color: str
    """`#RRGGBB`."""
    path: Path
    """GLB file, vertices in patient LPS millimetres."""
    triangles: int
    volume_ml: float
    centroid: tuple[float, float, float]
    """Centre of mass of the label's voxels, patient LPS millimetres."""


@dataclass
class PipelineOutput:
    model_version: str
    findings: list[Finding]
    """Classification: every label the model scores, highest confidence first.
    Segmentation: every label present, in label order."""
    heatmaps: dict[str, bytes] = field(default_factory=dict)
    """label -> PNG bytes (RGBA, same size as the input image)."""
    segmentation: Path | None = None
    """Labelmap NIfTI (uint8), same shape and affine as the input volume."""
    meshes: list[MeshArtifact] = field(default_factory=list)


class _ModelInfo(Protocol):
    model_code: str
    model_version: str

    @property
    def loaded(self) -> bool: ...

    def warmup(self) -> None:
        """Load weights eagerly (optional; `run` loads lazily otherwise)."""
        ...


@runtime_checkable
class Pipeline(_ModelInfo, Protocol):
    def run(
        self, image_bytes: bytes, params: dict[str, Any], progress_cb: ProgressCallback
    ) -> PipelineOutput: ...


@runtime_checkable
class FilePipeline(_ModelInfo, Protocol):
    def run_file(
        self,
        input_path: Path,
        params: dict[str, Any],
        progress_cb: ProgressCallback,
        workdir: Path,
    ) -> PipelineOutput: ...


AnyPipeline = Pipeline | FilePipeline
