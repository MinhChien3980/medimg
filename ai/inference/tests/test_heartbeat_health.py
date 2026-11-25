from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Iterator

import pytest

from tests.helpers import FakePipeline
from worker.config import Settings
from worker.health import HealthServer, health_status
from worker.heartbeat import Heartbeat
from worker.pipelines.registry import PipelineRegistry


def test_heartbeat_sets_key_with_ttl_and_removes_it_on_stop(redis_client):
    hb = Heartbeat(redis_client, "ai:worker:cpu:w1", interval=0.05)
    hb.start()
    deadline = time.monotonic() + 2
    while not redis_client.exists("ai:worker:cpu:w1") and time.monotonic() < deadline:
        time.sleep(0.01)
    assert redis_client.get("ai:worker:cpu:w1") == "1"
    assert 0 < redis_client.ttl("ai:worker:cpu:w1") <= 30
    hb.stop()
    hb.join(timeout=2)
    assert not hb.is_alive()
    assert not redis_client.exists("ai:worker:cpu:w1")


def test_health_status_reports_worker_and_model_state():
    pipeline = FakePipeline()
    registry = PipelineRegistry([pipeline])

    assert health_status("w1", "cpu", registry, lambda: True) == {
        "status": "UP",
        "workerId": "w1",
        "kind": "cpu",
        "modelLoaded": False,
        "models": {"cxr-multilabel": False},
    }
    pipeline.warmup()
    assert health_status("w1", "cpu", registry, lambda: True)["modelLoaded"] is True
    assert health_status("w1", "cpu", registry, lambda: False)["status"] == "STOPPING"


@pytest.fixture
def health_server() -> Iterator[HealthServer]:
    server = HealthServer(lambda: {"status": "UP", "workerId": "w1"}, port=0, host="127.0.0.1")
    server.start()
    yield server
    server.stop()


def test_health_endpoint_serves_status_as_json(health_server):
    url = f"http://127.0.0.1:{health_server.port}/health"
    with urllib.request.urlopen(url, timeout=3) as response:
        assert response.status == 200
        assert response.headers["Content-Type"] == "application/json"
        assert json.loads(response.read()) == {"status": "UP", "workerId": "w1"}


def test_health_server_returns_404_for_other_paths(health_server):
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(f"http://127.0.0.1:{health_server.port}/metrics", timeout=3)
    assert err.value.code == 404


def test_health_server_stop_releases_the_port():
    server = HealthServer(dict, port=0, host="127.0.0.1")
    server.start()
    port = server.port
    server.stop()
    with pytest.raises(urllib.error.URLError):
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://redis:6379/0")
    monkeypatch.setenv("S3_ENDPOINT", "http://seaweedfs:8333")
    monkeypatch.setenv("S3_ACCESS_KEY", "ak")
    monkeypatch.setenv("S3_SECRET_KEY", "sk")
    monkeypatch.setenv("WORKER_KIND", "gpu")
    monkeypatch.setenv("WORKER_ID", "gpu-1")
    s = Settings()
    assert s.redis_url == "redis://redis:6379/0"
    assert s.s3_endpoint == "http://seaweedfs:8333"
    assert (s.s3_access_key, s.s3_secret_key) == ("ak", "sk")
    assert s.s3_region == "us-east-1"
    assert s.worker_kind == "gpu"
    assert s.worker_id == "gpu-1"
    assert s.health_port == 8090


def test_settings_defaults(monkeypatch):
    for var in ("WORKER_KIND", "WORKER_ID", "HEALTH_PORT", "S3_REGION"):
        monkeypatch.delenv(var, raising=False)
    s = Settings()
    assert s.worker_kind == "cpu"
    assert s.worker_id  # hostname
    assert s.health_port == 8090
