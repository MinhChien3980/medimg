from __future__ import annotations

import pytest

from worker.config import Settings
from worker.main import build_role


@pytest.fixture
def settings(monkeypatch):
    def make(**env: str) -> Settings:
        for key in ("WORKER_ROLE", "WORKER_KIND", "SEG_THREADS", "SEG_MAX_GRID_VOXELS"):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        monkeypatch.setenv("WORKER_ID", "w1")
        return Settings()

    return make


def test_default_role_consumes_ai_jobs(settings, redis_client, storage):
    role = build_role(settings(), redis_client, storage)
    assert role.consumer.stream == "ai.jobs.cpu"
    assert role.consumer.group == "ai-workers"
    assert role.consumer.results.stream == "ai.results"
    assert role.heartbeat_key == "ai:worker:cpu:w1"
    status = role.status()
    assert status["models"] == {"cxr-multilabel": False, "ct-totalseg": False}
    assert status["kind"] == "cpu"


def test_ingest_role(settings, redis_client, storage):
    role = build_role(settings(WORKER_ROLE="ingest"), redis_client, storage)
    assert role.consumer.stream == "imaging.jobs"
    assert role.consumer.group == "ingest-workers"
    assert role.consumer.results.stream == "imaging.results"
    assert role.heartbeat_key == "imaging:worker:w1"
    assert role.status() == {"status": "UP", "workerId": "w1", "role": "ingest"}
    role.consumer.stop()
    assert role.status()["status"] == "STOPPING"


def test_segmentation_settings(settings):
    s = settings(SEG_THREADS="3", SEG_MAX_GRID_VOXELS="1000")
    assert (s.seg_threads, s.seg_max_grid_voxels) == (3, 1000)
    assert settings().worker_role == "ai"
    with pytest.raises(ValueError):
        settings(WORKER_ROLE="both")
