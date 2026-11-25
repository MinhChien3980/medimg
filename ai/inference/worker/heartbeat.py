"""Worker liveness key read by core-service: `ai:worker:{kind}:{workerId}` (routes AI jobs to
the GPU queue when a GPU worker is alive) or `imaging:worker:{workerId}` (ingest)."""

from __future__ import annotations

import logging
import threading

import redis

log = logging.getLogger(__name__)

HEARTBEAT_TTL_SECONDS = 30
HEARTBEAT_INTERVAL_SECONDS = 10.0


class Heartbeat(threading.Thread):
    def __init__(
        self,
        client: redis.Redis,
        key: str,
        interval: float = HEARTBEAT_INTERVAL_SECONDS,
        ttl: int = HEARTBEAT_TTL_SECONDS,
    ) -> None:
        super().__init__(name="heartbeat", daemon=True)
        self._client = client
        self.key = key
        self._interval = interval
        self._ttl = ttl
        self._stop_event = threading.Event()

    def beat(self) -> None:
        self._client.set(self.key, "1", ex=self._ttl)

    def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.beat()
            except redis.RedisError as exc:
                log.warning("heartbeat failed: %s", exc)
            self._stop_event.wait(self._interval)

    def stop(self, remove_key: bool = True) -> None:
        """Stop beating; by default delete the key so core stops routing to us right away."""
        self._stop_event.set()
        if remove_key:
            try:
                self._client.delete(self.key)
            except redis.RedisError as exc:
                log.warning("could not remove heartbeat key: %s", exc)
