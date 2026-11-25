"""modelCode -> Pipeline registry."""

from __future__ import annotations

from collections.abc import Iterable

from worker.errors import UnknownModelError
from worker.pipelines.base import Pipeline


class PipelineRegistry:
    def __init__(self, pipelines: Iterable[Pipeline] = ()) -> None:
        self._pipelines: dict[str, Pipeline] = {}
        for pipeline in pipelines:
            self.register(pipeline)

    def register(self, pipeline: Pipeline) -> None:
        self._pipelines[pipeline.model_code] = pipeline

    def get(self, model_code: str) -> Pipeline:
        try:
            return self._pipelines[model_code]
        except KeyError:
            raise UnknownModelError(f"unknown modelCode: {model_code!r}") from None

    def all(self) -> list[Pipeline]:
        return list(self._pipelines.values())

    @property
    def models_loaded(self) -> dict[str, bool]:
        return {code: p.loaded for code, p in self._pipelines.items()}


def default_registry(device_kind: str = "cpu") -> PipelineRegistry:
    """All production pipelines. Imports torch lazily so tests with fake pipelines stay light."""
    from worker.pipelines.cxr_multilabel import CxrMultilabelPipeline

    return PipelineRegistry([CxrMultilabelPipeline(device_kind=device_kind)])
