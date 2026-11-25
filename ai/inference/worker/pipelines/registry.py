"""modelCode -> pipeline registry."""

from __future__ import annotations

from collections.abc import Iterable

from worker.errors import UnknownModelError
from worker.pipelines.base import AnyPipeline


class PipelineRegistry:
    def __init__(self, pipelines: Iterable[AnyPipeline] = ()) -> None:
        self._pipelines: dict[str, AnyPipeline] = {}
        for pipeline in pipelines:
            self.register(pipeline)

    def register(self, pipeline: AnyPipeline) -> None:
        self._pipelines[pipeline.model_code] = pipeline

    def get(self, model_code: str) -> AnyPipeline:
        try:
            return self._pipelines[model_code]
        except KeyError:
            raise UnknownModelError(f"unknown modelCode: {model_code!r}") from None

    def all(self) -> list[AnyPipeline]:
        return list(self._pipelines.values())

    @property
    def models_loaded(self) -> dict[str, bool]:
        return {code: p.loaded for code, p in self._pipelines.items()}


def default_registry(
    device_kind: str = "cpu",
    seg_threads: int | None = None,
    seg_max_grid_voxels: int | None = None,
) -> PipelineRegistry:
    """All production pipelines. Imports torch lazily so tests with fake pipelines stay light."""
    from worker.pipelines.ct_totalseg import CtTotalSegPipeline
    from worker.pipelines.cxr_multilabel import CxrMultilabelPipeline
    from worker.pipelines.totalseg_runner import MAX_GRID_VOXELS, TotalSegmentatorRunner

    runner = TotalSegmentatorRunner(
        device_kind=device_kind,
        threads=seg_threads,
        max_grid_voxels=seg_max_grid_voxels or MAX_GRID_VOXELS,
    )
    return PipelineRegistry(
        [CxrMultilabelPipeline(device_kind=device_kind), CtTotalSegPipeline(runner)]
    )
