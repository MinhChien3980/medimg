"""Entry point: `python -m worker.main`. `WORKER_ROLE` picks what the process consumes:

- `ai` (default): `ai.jobs.{WORKER_KIND}` -> model pipelines -> `ai.results`
- `ingest`: `imaging.jobs` -> normalised CT volume + thumbnail -> `imaging.results`
"""

from __future__ import annotations

import logging
import signal
import sys
from collections.abc import Callable
from dataclasses import dataclass
from types import FrameType
from typing import Any

import redis

from worker.config import Settings, get_settings
from worker.consumer import JobConsumer
from worker.health import HealthServer, health_status, ingest_health_status
from worker.heartbeat import Heartbeat
from worker.logging_setup import configure_logging
from worker.messages import heartbeat_key, imaging_heartbeat_key
from worker.pipelines.registry import PipelineRegistry, default_registry
from worker.storage import ObjectStorage, make_s3_client
from worker.stream_consumer import BLOCK_MS, StreamConsumer

log = logging.getLogger("worker")


def make_redis(settings: Settings) -> redis.Redis:
    return redis.Redis.from_url(
        settings.redis_url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=BLOCK_MS / 1000 + 10,  # must outlive XREADGROUP BLOCK
        health_check_interval=30,
    )


def warmup(registry: PipelineRegistry) -> None:
    for pipeline in registry.all():
        try:
            pipeline.warmup()
            log.info(
                "model loaded",
                extra={"modelCode": pipeline.model_code, "modelVersion": pipeline.model_version},
            )
        except Exception:
            # Keep running: jobs will fail (retryable) until the model can be loaded.
            log.exception("model warmup failed", extra={"modelCode": pipeline.model_code})


@dataclass(frozen=True)
class Role:
    consumer: StreamConsumer[Any]
    heartbeat_key: str
    status: Callable[[], dict[str, Any]]
    warmup: Callable[[], None]


def build_role(settings: Settings, client: redis.Redis, storage: ObjectStorage) -> Role:
    if settings.worker_role == "ingest":
        from worker.ingest.workload import IngestWorkload

        ingest = StreamConsumer(client, IngestWorkload(storage), settings.worker_id)
        return Role(
            consumer=ingest,
            heartbeat_key=imaging_heartbeat_key(settings.worker_id),
            status=lambda: ingest_health_status(settings.worker_id, lambda: not ingest.stopping),
            warmup=lambda: None,
        )

    registry = default_registry(
        settings.worker_kind, settings.seg_threads, settings.seg_max_grid_voxels
    )
    consumer = JobConsumer(client, storage, registry, settings.worker_kind, settings.worker_id)
    return Role(
        consumer=consumer,
        heartbeat_key=heartbeat_key(settings.worker_kind, settings.worker_id),
        status=lambda: health_status(
            settings.worker_id,
            settings.worker_kind,
            registry,
            is_running=lambda: not consumer.stopping,
        ),
        warmup=lambda: warmup(registry),
    )


def main() -> int:
    settings = get_settings()
    configure_logging(settings.log_level)
    log.info(
        "starting worker",
        extra={
            "role": settings.worker_role,
            "workerId": settings.worker_id,
            "kind": settings.worker_kind,
        },
    )

    client = make_redis(settings)
    storage = ObjectStorage(
        make_s3_client(
            settings.s3_endpoint, settings.s3_access_key, settings.s3_secret_key, settings.s3_region
        )
    )
    role = build_role(settings, client, storage)
    consumer = role.consumer

    health = HealthServer(role.status, settings.health_port)
    health.start()

    def on_signal(signum: int, _frame: FrameType | None) -> None:
        log.info("received %s, finishing current job then exiting", signal.Signals(signum).name)
        consumer.stop()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    role.warmup()

    heartbeat = Heartbeat(client, role.heartbeat_key)
    heartbeat.start()
    try:
        consumer.run()
    finally:
        heartbeat.stop()
        health.stop()
        log.info("worker stopped", extra={"role": settings.worker_role})
    return 0


if __name__ == "__main__":
    sys.exit(main())
