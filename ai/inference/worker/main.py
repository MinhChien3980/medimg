"""Entry point: `python -m worker.main`."""

from __future__ import annotations

import logging
import signal
import sys
from types import FrameType

import redis

from worker.config import Settings, get_settings
from worker.consumer import BLOCK_MS, JobConsumer
from worker.health import HealthServer, health_status
from worker.heartbeat import Heartbeat
from worker.logging_setup import configure_logging
from worker.pipelines.registry import PipelineRegistry, default_registry
from worker.storage import ObjectStorage, make_s3_client

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


def main() -> int:
    settings = get_settings()
    configure_logging(settings.log_level)
    log.info(
        "starting ai-worker", extra={"workerId": settings.worker_id, "kind": settings.worker_kind}
    )

    client = make_redis(settings)
    storage = ObjectStorage(
        make_s3_client(
            settings.s3_endpoint, settings.s3_access_key, settings.s3_secret_key, settings.s3_region
        )
    )
    registry = default_registry(settings.worker_kind)
    consumer = JobConsumer(client, storage, registry, settings.worker_kind, settings.worker_id)

    health = HealthServer(
        lambda: health_status(
            settings.worker_id,
            settings.worker_kind,
            registry,
            is_running=lambda: not consumer.stopping,
        ),
        settings.health_port,
    )
    health.start()

    def on_signal(signum: int, _frame: FrameType | None) -> None:
        log.info("received %s, finishing current job then exiting", signal.Signals(signum).name)
        consumer.stop()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    warmup(registry)

    heartbeat = Heartbeat(client, settings.worker_kind, settings.worker_id)
    heartbeat.start()
    try:
        consumer.run()
    finally:
        heartbeat.stop()
        health.stop()
        log.info("ai-worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
