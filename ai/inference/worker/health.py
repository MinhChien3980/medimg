"""`GET /health`: a stdlib HTTP server on a daemon thread, used by the container healthcheck."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from worker.pipelines.registry import PipelineRegistry

StatusProvider = Callable[[], dict[str, Any]]


def health_status(
    worker_id: str, kind: str, registry: PipelineRegistry, is_running: Callable[[], bool]
) -> dict[str, Any]:
    models = registry.models_loaded
    return {
        "status": "UP" if is_running() else "STOPPING",
        "workerId": worker_id,
        "kind": kind,
        "modelLoaded": bool(models) and all(models.values()),
        "models": models,
    }


class _HealthHandler(BaseHTTPRequestHandler):
    server: _HealthHttpServer

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = json.dumps(self.server.status()).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        """Silence per-request access logs (the healthcheck polls every 30 s)."""


class _HealthHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], status: StatusProvider) -> None:
        super().__init__(address, _HealthHandler)
        self.status = status


class HealthServer:
    def __init__(self, status: StatusProvider, port: int, host: str = "0.0.0.0") -> None:
        self._httpd = _HealthHttpServer((host, port), status)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever, name="health", daemon=True
        )

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    def start(self) -> None:
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        if self._thread.is_alive():
            self._httpd.shutdown()
            self._thread.join(timeout)
        self._httpd.server_close()
