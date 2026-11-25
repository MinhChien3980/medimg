"""Generic Redis Streams job consumer: jobs stream (consumer group) -> workload -> results stream.

Ordering guarantees, for every workload:
- STARTED, PROGRESS..., then exactly one DONE or FAILED per processed delivery.
- The DONE/FAILED result is XADDed *before* the job is XACKed, so a crash in between leaves the
  job in this consumer's PEL and it is reprocessed on restart (core ignores stale or duplicate
  results).
- Cancelled jobs (when the workload supports cancellation) are ACKed without a result.

What a job is and what processing it means is up to the `Workload`; this module owns the
stream mechanics only.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol

import redis

from worker.errors import InvalidJobError, JobCancelled, JobError, classify
from worker.logging_setup import job_context
from worker.messages import ResultSchema
from worker.pipelines.base import ProgressCallback

log = logging.getLogger(__name__)

BLOCK_MS = 5000


class Job(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def attempt(self) -> int: ...


class Workload[JobT: Job](Protocol):
    """One kind of job: where it comes from, how it is parsed and what processing it means."""

    jobs_stream: str
    group: str
    results: ResultSchema

    def parse(self, fields: dict[str, str]) -> JobT:
        """Raise InvalidJobError for a malformed message (reported as non-retryable)."""
        ...

    def is_cancelled(self, job: JobT) -> bool: ...

    def execute(self, job: JobT, progress: ProgressCallback) -> dict[str, Any]:
        """Process the job and return the DONE payload. Exceptions become FAILED results."""
        ...

    def describe(self, job: JobT) -> dict[str, Any]:
        """Log fields for the `job started` record."""
        ...

    def summarize(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Log fields for the `job done` record."""
        ...


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

    consumer: StreamConsumer[Any]
    job: Job
    last: int = 0

    def __call__(self, pct: int) -> None:
        self.consumer.raise_if_cancelled(self.job)
        pct = max(self.last, min(99, int(pct)))
        self.last = pct
        self.consumer.emit(
            self.consumer.results.progress(
                self.job.id, self.job.attempt, self.consumer.worker_id, pct
            )
        )


class StreamConsumer[JobT: Job]:
    def __init__(
        self,
        client: redis.Redis,
        workload: Workload[JobT],
        worker_id: str,
        block_ms: int = BLOCK_MS,
    ) -> None:
        self.client = client
        self.workload = workload
        self.worker_id = worker_id
        self.stream = workload.jobs_stream
        self.group = workload.group
        self.results = workload.results
        self.block_ms = block_ms
        self._stop = threading.Event()

    # ------------------------------------------------------------------ lifecycle
    def ensure_group(self) -> None:
        try:
            self.client.xgroup_create(self.stream, self.group, id="0", mkstream=True)
            log.info("created consumer group", extra={"stream": self.stream, "group": self.group})
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
            self.group, self.worker_id, {self.stream: start_id}, count=count, block=block
        )
        if not response:
            return []
        # RESP2 shape (redis-py default): [[stream, [(id, fields), ...]]]
        entries = response[0][1]
        return [(entry_id, fields) for entry_id, fields in entries]

    # ------------------------------------------------------------------ redis helpers
    def emit(self, fields: dict[str, str]) -> None:
        self.client.xadd(self.results.stream, fields)

    def ack(self, entry_id: str) -> None:
        self.client.xack(self.stream, self.group, entry_id)

    def raise_if_cancelled(self, job: JobT) -> None:
        if self.workload.is_cancelled(job):
            raise JobCancelled(job.id)

    # ------------------------------------------------------------------ job handling
    def handle(self, entry_id: str, fields: dict[str, str] | None) -> None:
        if not fields:  # entry was trimmed/deleted while pending
            log.warning("empty job entry, acking", extra={"entryId": entry_id})
            self.ack(entry_id)
            return

        id_field = self.results.id_field
        job_id = fields.get(id_field) or None
        with job_context(job_id, id_field):
            try:
                job = self.workload.parse(fields)
            except InvalidJobError as exc:
                log.error("invalid job message: %s", exc, extra={"entryId": entry_id})
                if job_id:
                    self.emit(
                        self.results.failed(
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

    def process(self, entry_id: str, job: JobT) -> None:
        if self.workload.is_cancelled(job):
            log.info("job cancelled before start, skipping")
            self.ack(entry_id)
            return

        progress = _Progress(self, job)
        started_at = time.monotonic()
        log.info(
            "job started",
            extra={**self.workload.describe(job), "attempt": job.attempt, "entryId": entry_id},
        )
        self.emit(self.results.started(job.id, job.attempt, self.worker_id))
        try:
            payload = self.workload.execute(job, progress)
            self.raise_if_cancelled(job)
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
                self.results.failed(
                    job.id, job.attempt, self.worker_id, error, retryable, progress.last
                )
            )
            self.ack(entry_id)
            return

        self.emit(self.results.done(job.id, job.attempt, self.worker_id, payload))
        self.ack(entry_id)
        log.info(
            "job done",
            extra={
                **self.workload.summarize(payload),
                "totalMs": int((time.monotonic() - started_at) * 1000),
            },
        )
