"""AI jobs: `ai.jobs.{kind}` (group `ai-workers`) -> pipeline -> `ai.results`.

Stream mechanics (ordering, PEL replay, XADD before XACK) live in `worker.stream_consumer`; this
module fetches the input, runs the pipeline and uploads its artifacts. Cancelled jobs
(`ai:job:{jobId}:cancelled`) are ACKed without a result.
"""

from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Any

import redis

from worker import messages
from worker.messages import CONSUMER_GROUP, JobMessage
from worker.pipelines.base import FilePipeline, Finding, PipelineOutput, ProgressCallback
from worker.pipelines.registry import PipelineRegistry
from worker.storage import ObjectStorage
from worker.stream_consumer import BLOCK_MS, StreamConsumer, reported_attempt

__all__ = ["BLOCK_MS", "AiJobWorkload", "JobConsumer", "reported_attempt", "sanitize_label"]

PROGRESS_LOADED = 10
PROGRESS_UPLOAD = 95

HEATMAP_CONTENT_TYPE = "image/png"
RESULT_CONTENT_TYPE = "application/json"
SEGMENTATION_CONTENT_TYPE = "application/gzip"
MESH_CONTENT_TYPE = "model/gltf-binary"


def sanitize_label(label: str) -> str:
    """Object-key-safe label: spaces -> '_', path separators dropped."""
    return label.strip().replace(" ", "_").replace("/", "_").replace("\\", "_")


def _input_name(uri: str) -> str:
    """Local file name for a downloaded input; keeps the extension (nibabel relies on it)."""
    name = uri.rsplit("/", 1)[-1]
    return sanitize_label(name) or "input"


class AiJobWorkload:
    group = CONSUMER_GROUP
    results = messages.AI_RESULTS

    def __init__(
        self, client: redis.Redis, storage: ObjectStorage, registry: PipelineRegistry, kind: str
    ) -> None:
        self.client = client
        self.storage = storage
        self.registry = registry
        self.jobs_stream = messages.jobs_stream(kind)

    def parse(self, fields: dict[str, str]) -> JobMessage:
        return JobMessage.parse(fields)

    def is_cancelled(self, job: JobMessage) -> bool:
        return bool(self.client.exists(messages.cancelled_key(job.job_id)))

    def describe(self, job: JobMessage) -> dict[str, Any]:
        return {"modelCode": job.model_code}

    def summarize(self, payload: dict[str, Any]) -> dict[str, Any]:
        artifacts = payload["artifacts"]
        return {
            "inferenceMs": payload["inferenceMs"],
            "findings": len(payload["findings"]),
            "heatmaps": len(artifacts["heatmaps"]),
            "meshes": len(artifacts.get("meshes", [])),
        }

    def execute(self, job: JobMessage, progress: ProgressCallback) -> dict[str, Any]:
        pipeline = self.registry.get(job.model_code)
        if isinstance(pipeline, FilePipeline):
            with tempfile.TemporaryDirectory(prefix="job-") as tmp:
                workdir = Path(tmp)
                input_path = workdir / _input_name(job.input_uri)
                self.storage.download_file(job.input_uri, input_path)
                progress(PROGRESS_LOADED)
                t0 = time.perf_counter()
                output = pipeline.run_file(input_path, job.params, progress, workdir)
                inference_ms = round((time.perf_counter() - t0) * 1000)
                progress(PROGRESS_UPLOAD)
                return self.upload_artifacts(job, output, inference_ms)

        image_bytes = self.storage.get_bytes(job.input_uri)
        progress(PROGRESS_LOADED)
        t0 = time.perf_counter()
        output = pipeline.run(image_bytes, job.params, progress)
        inference_ms = round((time.perf_counter() - t0) * 1000)
        progress(PROGRESS_UPLOAD)
        return self.upload_artifacts(job, output, inference_ms)

    def upload_artifacts(
        self, job: JobMessage, output: PipelineOutput, inference_ms: int
    ) -> dict[str, Any]:
        heatmap_uris: dict[str, str] = {}
        for label, png in output.heatmaps.items():
            uri = job.artifact_uri(f"heatmap-{sanitize_label(label)}.png")
            heatmap_uris[label] = self.storage.put_bytes(uri, png, HEATMAP_CONTENT_TYPE)

        artifacts: dict[str, Any] = {"heatmaps": heatmap_uris}
        if output.segmentation is not None:
            artifacts["segmentation"] = self.storage.put_file(
                job.artifact_uri("segmentation.nii.gz"),
                output.segmentation,
                SEGMENTATION_CONTENT_TYPE,
            )
            artifacts["meshes"] = [
                {
                    "label": mesh.label,
                    "color": mesh.color,
                    "uri": self.storage.put_file(
                        job.artifact_uri(f"meshes/{sanitize_label(mesh.label)}.glb"),
                        mesh.path,
                        MESH_CONTENT_TYPE,
                    ),
                    "triangles": mesh.triangles,
                    "volumeMl": mesh.volume_ml,
                    "centroid": list(mesh.centroid),
                }
                for mesh in output.meshes
            ]

        payload: dict[str, Any] = {
            "modelVersion": output.model_version,
            "inferenceMs": inference_ms,
            "findings": [_finding(f) for f in output.findings],
            "artifacts": artifacts,
        }
        self.storage.put_bytes(
            job.artifact_uri("result.json"),
            messages.dump_json(payload).encode("utf-8"),
            RESULT_CONTENT_TYPE,
        )
        return payload


def _finding(f: Finding) -> dict[str, Any]:
    out: dict[str, Any] = {
        "label": f.label,
        "confidence": None
        if f.confidence is None
        else round(min(1.0, max(0.0, float(f.confidence))), 4),
    }
    if f.volume_ml is not None:
        out["volumeMl"] = f.volume_ml
    out["bbox"] = f.bbox
    return out


class JobConsumer(StreamConsumer[JobMessage]):
    """The AI worker's consumer: `StreamConsumer` bound to `AiJobWorkload`."""

    def __init__(
        self,
        client: redis.Redis,
        storage: ObjectStorage,
        registry: PipelineRegistry,
        kind: str,
        worker_id: str,
        block_ms: int = BLOCK_MS,
    ) -> None:
        self.ai_workload = AiJobWorkload(client, storage, registry, kind)
        super().__init__(client, self.ai_workload, worker_id, block_ms)
        self.kind = kind

    @property
    def storage(self) -> ObjectStorage:
        return self.ai_workload.storage

    @property
    def registry(self) -> PipelineRegistry:
        return self.ai_workload.registry
