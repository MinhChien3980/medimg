"""Redis Streams consumer: `ai.jobs.{kind}` (group `ai-workers`) -> pipeline -> `ai.results`.

Ordering guarantees:
- STARTED, PROGRESS..., then exactly one DONE or FAILED per processed delivery.
- The DONE/FAILED result is XADDed *before* the job is XACKed, so a crash in between leaves the
  job in this consumer's PEL and it is reprocessed on restart (core ignores stale or duplicate
  results).
- Cancelled jobs (`ai:job:{jobId}:cancelled`) are ACKed without a result.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import redis

from worker import messages
from worker.errors import InvalidJobError, JobCancelled, JobError, classify
from worker.logging_setup import job_context
from worker.messages import CONSUMER_GROUP, RESULTS_STREAM, JobMessage
from worker.pipelines.base import PipelineOutput
from worker.pipelines.registry import PipelineRegistry
from worker.storage import ObjectStorage

log = logging.getLogger(__name__)

PROGRESS_LOADED = 10
PROGRESS_UPLOAD = 95
BLOCK_MS = 5000

HEATMAP_CONTENT_TYPE = "image/png"
RESULT_CONTENT_TYPE = "application/json"


def sanitize_label(label: str) -> str:
    """Object-key-safe label: spaces -> '_', path separators dropped."""
    return label.strip().replace(" ", "_").replace("/", "_").replace("\\", "_")


def reported_attempt(raw: str | None) -> int:
    """Attempt echoed in the FAILED result of a malformed job: 0 when it is not a valid attempt,
    which core treats as a permanent failure of the job's current attempt."""
    try:
        attempt = int(raw or "")
    except ValueError:
        return 0
    return attempt if attempt >= 1 else 0


@dataclass
class _Progress:
    """Emits PROGRESS events (monotonic) and checks for cancellation between steps."""

    consumer: JobConsumer
    job: JobMessage
    last: int = 0

    def __call__(self, pct: int) -> None:
        self.consumer.raise_if_cancelled(self.job.job_id)
        pct = max(self.last, min(99, int(pct)))
        self.last = pct
        self.consumer.emit(
            messages.progress(self.job.job_id, self.job.attempt, self.consumer.worker_id, pct)
        )


class JobConsumer:
    def __init__(
        self,
        client: redis.Redis,
        storage: ObjectStorage,
        registry: PipelineRegistry,
        kind: str,
        worker_id: str,
        block_ms: int = BLOCK_MS,
    ) -> None:
        self.client = client
        self.storage = storage
        self.registry = registry
        self.kind = kind
        self.worker_id = worker_id
        self.stream = messages.jobs_stream(kind)
        self.block_ms = block_ms
        self._stop = threading.Event()

    # ------------------------------------------------------------------ lifecycle
    def ensure_group(self) -> None:
        try:
            self.client.xgroup_create(self.stream, CONSUMER_GROUP, id="0", mkstream=True)
            log.info("created consumer group", extra={"stream": self.stream})
        except redis.ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def stop(self) -> None:
        self._stop.set()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def run(self) -> None:
        """Main loop: own pending entries first, then new ones, until stop() is called."""
        needs_group = needs_drain = True
        while not self._stop.is_set():
            try:
                if needs_group:  # Redis may still be starting (compose)
                    self.ensure_group()
                    needs_group = False
                if needs_drain:
                    # Also after a Redis outage: a job whose result could not be written is
                    # still in this consumer's PEL and must be retried before taking new work.
                    self.drain_pending()
                    needs_drain = False
                self.poll_once()
            except (redis.ConnectionError, redis.TimeoutError) as exc:
                log.warning("redis unavailable, retrying: %s", exc)
                needs_drain = True
                self._stop.wait(2.0)

    def drain_pending(self) -> int:
        """Re-process entries delivered to this consumer before a crash/restart."""
        handled = 0
        while not self._stop.is_set():
            batch = self._read(start_id="0", block=None, count=10)
            if not batch:
                break
            for entry_id, fields in batch:
                self.handle(entry_id, fields)
                handled += 1
        if handled:
            log.info("processed pending entries", extra={"count": handled})
        return handled

    def poll_once(self) -> bool:
        """Read and process at most one new job. Returns True if a job was handled."""
        batch = self._read(start_id=">", block=self.block_ms, count=1)
        for entry_id, fields in batch:
            self.handle(entry_id, fields)
        return bool(batch)

    def _read(self, start_id: str, block: int | None, count: int) -> list[tuple[str, Any]]:
        response = self.client.xreadgroup(
            CONSUMER_GROUP, self.worker_id, {self.stream: start_id}, count=count, block=block
        )
        if not response:
            return []
        # RESP2 shape (redis-py default): [[stream, [(id, fields), ...]]]
        entries = response[0][1]
        return [(entry_id, fields) for entry_id, fields in entries]

    # ------------------------------------------------------------------ redis helpers
    def emit(self, fields: dict[str, str]) -> None:
        self.client.xadd(RESULTS_STREAM, fields)

    def ack(self, entry_id: str) -> None:
        self.client.xack(self.stream, CONSUMER_GROUP, entry_id)

    def is_cancelled(self, job_id: str) -> bool:
        return bool(self.client.exists(messages.cancelled_key(job_id)))

    def raise_if_cancelled(self, job_id: str) -> None:
        if self.is_cancelled(job_id):
            raise JobCancelled(job_id)

    # ------------------------------------------------------------------ job handling
    def handle(self, entry_id: str, fields: dict[str, str] | None) -> None:
        if not fields:  # entry was trimmed/deleted while pending
            log.warning("empty job entry, acking", extra={"entryId": entry_id})
            self.ack(entry_id)
            return

        job_id = fields.get("jobId") or None
        with job_context(job_id):
            try:
                job = JobMessage.parse(fields)
            except InvalidJobError as exc:
                log.error("invalid job message: %s", exc, extra={"entryId": entry_id})
                if job_id:
                    self.emit(
                        messages.failed(
                            job_id,
                            reported_attempt(fields.get("attempt")),
                            self.worker_id,
                            str(exc),
                            retryable=False,
                        )
                    )
                self.ack(entry_id)
                return
            self.process(entry_id, job)

    def process(self, entry_id: str, job: JobMessage) -> None:
        if self.is_cancelled(job.job_id):
            log.info("job cancelled before start, skipping")
            self.ack(entry_id)
            return

        progress = _Progress(self, job)
        started_at = time.monotonic()
        log.info(
            "job started",
            extra={"modelCode": job.model_code, "attempt": job.attempt, "entryId": entry_id},
        )
        self.emit(messages.started(job.job_id, job.attempt, self.worker_id))
        try:
            pipeline = self.registry.get(job.model_code)
            image_bytes = self.storage.get_bytes(job.input_uri)
            progress(PROGRESS_LOADED)

            t0 = time.perf_counter()
            output = pipeline.run(image_bytes, job.params, progress)
            inference_ms = round((time.perf_counter() - t0) * 1000)

            progress(PROGRESS_UPLOAD)
            payload = self.upload_artifacts(job, output, inference_ms)
            self.raise_if_cancelled(job.job_id)
        except JobCancelled:
            log.info("job cancelled while running, acking without result")
            self.ack(entry_id)
            return
        except Exception as exc:
            error, retryable = classify(exc)
            log.error(
                "job failed: %s",
                error,
                exc_info=not isinstance(exc, JobError),  # traceback only for unexpected errors
                extra={"retryable": retryable},
            )
            self.emit(
                messages.failed(
                    job.job_id, job.attempt, self.worker_id, error, retryable, progress.last
                )
            )
            self.ack(entry_id)
            return

        self.emit(messages.done(job.job_id, job.attempt, self.worker_id, payload))
        self.ack(entry_id)
        log.info(
            "job done",
            extra={
                "inferenceMs": payload["inferenceMs"],
                "totalMs": int((time.monotonic() - started_at) * 1000),
                "findings": len(payload["findings"]),
                "heatmaps": len(payload["artifacts"]["heatmaps"]),
            },
        )

    def upload_artifacts(
        self, job: JobMessage, output: PipelineOutput, inference_ms: int
    ) -> dict[str, Any]:
        heatmap_uris: dict[str, str] = {}
        for label, png in output.heatmaps.items():
            uri = job.artifact_uri(f"heatmap-{sanitize_label(label)}.png")
            heatmap_uris[label] = self.storage.put_bytes(uri, png, HEATMAP_CONTENT_TYPE)

        payload: dict[str, Any] = {
            "modelVersion": output.model_version,
            "inferenceMs": inference_ms,
            "findings": [
                {
                    "label": f.label,
                    "confidence": round(min(1.0, max(0.0, float(f.confidence))), 4),
                    "bbox": f.bbox,
                }
                for f in output.findings
            ],
            "artifacts": {"heatmaps": heatmap_uris},
        }
        self.storage.put_bytes(
            job.artifact_uri("result.json"),
            messages.dump_json(payload).encode("utf-8"),
            RESULT_CONTENT_TYPE,
        )
        return payload
