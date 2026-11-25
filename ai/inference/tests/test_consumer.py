from __future__ import annotations

import json
import threading

import pytest
from botocore.exceptions import EndpointConnectionError

from tests.helpers import BUCKET, WORKER_ID, job_fields, png_bytes, results
from worker import messages
from worker.consumer import JobConsumer, sanitize_label
from worker.messages import CONSUMER_GROUP
from worker.pipelines.imaging import decode_grayscale
from worker.pipelines.registry import PipelineRegistry

STREAM = "ai.jobs.cpu"


def add_job(redis_client, **overrides) -> str:
    return redis_client.xadd(STREAM, job_fields(**overrides))


def pending_count(redis_client) -> int:
    return redis_client.xpending(STREAM, CONSUMER_GROUP)["pending"]


def record_calls(consumer: JobConsumer) -> list[tuple[str, str]]:
    """Spy on XADD-to-results and XACK, in call order."""
    calls: list[tuple[str, str]] = []
    emit, ack = consumer.emit, consumer.ack

    def spy_emit(fields):
        calls.append(("XADD", fields["type"]))
        emit(fields)

    def spy_ack(entry_id):
        calls.append(("XACK", entry_id))
        ack(entry_id)

    consumer.emit = spy_emit  # type: ignore[method-assign]
    consumer.ack = spy_ack  # type: ignore[method-assign]
    return calls


def test_ensure_group_is_idempotent(redis_client, consumer):
    consumer.ensure_group()  # BUSYGROUP ignored
    groups = redis_client.xinfo_groups(STREAM)
    assert [g["name"] for g in groups] == [CONSUMER_GROUP]


def test_happy_path_emits_started_progress_done_then_acks(redis_client, consumer, put_input, s3):
    put_input()
    entry_id = add_job(redis_client)
    calls = record_calls(consumer)

    assert consumer.poll_once() is True

    out = results(redis_client)
    assert [m["type"] for m in out] == [
        "STARTED",
        "PROGRESS",
        "PROGRESS",
        "PROGRESS",
        "PROGRESS",
        "DONE",
    ]
    assert [int(m["progress"]) for m in out] == [0, 10, 40, 80, 95, 100]
    assert all(m["jobId"] == job_fields()["jobId"] for m in out)
    assert all(m["attempt"] == "1" and m["workerId"] == WORKER_ID for m in out)

    # result XADDed before the job is ACKed, and nothing left pending
    assert calls[-2:] == [("XADD", "DONE"), ("XACK", entry_id)]
    assert pending_count(redis_client) == 0


def test_done_payload_matches_contract(redis_client, consumer, put_input, s3):
    put_input()
    job = job_fields()
    add_job(redis_client)
    consumer.poll_once()

    done = results(redis_client)[-1]
    payload = json.loads(done["payload"])
    assert set(payload) == {"modelVersion", "inferenceMs", "findings", "artifacts"}
    assert payload["modelVersion"] == "0.1.0-xrv"
    assert isinstance(payload["inferenceMs"], int)
    assert payload["findings"] == [
        {"label": "Cardiomegaly", "confidence": 0.87, "bbox": None},
        {"label": "Effusion", "confidence": 0.6123, "bbox": None},
        {"label": "Lung Opacity", "confidence": 0.55, "bbox": None},
        {"label": "Hernia", "confidence": 0.01, "bbox": None},
    ]
    prefix = job["outputPrefix"]
    assert payload["artifacts"] == {
        "heatmaps": {
            "Cardiomegaly": f"{prefix}heatmap-Cardiomegaly.png",
            "Effusion": f"{prefix}heatmap-Effusion.png",
            "Lung Opacity": f"{prefix}heatmap-Lung_Opacity.png",
        }
    }

    key_prefix = prefix.removeprefix(f"s3://{BUCKET}/")
    heat = s3.get_object(Bucket=BUCKET, Key=f"{key_prefix}heatmap-Lung_Opacity.png")
    assert heat["ContentType"] == "image/png"
    assert heat["Body"].read() == b"\x89PNG-fake-Lung Opacity"
    stored = s3.get_object(Bucket=BUCKET, Key=f"{key_prefix}result.json")
    assert stored["ContentType"] == "application/json"
    assert json.loads(stored["Body"].read()) == payload


def test_threshold_param_is_passed_to_pipeline(redis_client, consumer, put_input):
    put_input()
    add_job(redis_client, params='{"threshold":0.9}')
    consumer.poll_once()
    payload = json.loads(results(redis_client)[-1]["payload"])
    assert payload["artifacts"]["heatmaps"] == {}
    assert len(payload["findings"]) == 4


def test_job_cancelled_before_start_is_acked_without_results(
    redis_client, consumer, pipeline, put_input
):
    put_input()
    job = job_fields()
    redis_client.set(messages.cancelled_key(job["jobId"]), "1", ex=86400)
    add_job(redis_client)

    consumer.poll_once()

    assert results(redis_client) == []
    assert pipeline.calls == []
    assert pending_count(redis_client) == 0


def test_job_cancelled_mid_run_stops_without_done(redis_client, consumer, pipeline, put_input):
    put_input()
    job = job_fields()
    pipeline.before_run = lambda: redis_client.set(messages.cancelled_key(job["jobId"]), "1")
    add_job(redis_client)

    consumer.poll_once()

    types = [m["type"] for m in results(redis_client)]
    assert "DONE" not in types and "FAILED" not in types
    assert pending_count(redis_client) == 0


def test_unknown_model_fails_not_retryable(redis_client, consumer, put_input):
    put_input()
    entry_id = add_job(redis_client, modelCode="does-not-exist")
    calls = record_calls(consumer)
    consumer.poll_once()

    failed = results(redis_client)[-1]
    assert failed["type"] == "FAILED"
    assert failed["retryable"] == "false"
    assert "does-not-exist" in failed["error"]
    assert calls[-2:] == [("XADD", "FAILED"), ("XACK", entry_id)]
    assert pending_count(redis_client) == 0


def test_undecodable_image_fails_not_retryable(redis_client, storage, put_input):
    class DecodingPipeline:
        model_code = "cxr-multilabel"
        model_version = "0.1.0-xrv"
        loaded = True

        def warmup(self):
            pass

        def run(self, image_bytes, params, progress_cb):
            decode_grayscale(image_bytes)
            raise AssertionError("unreachable")

    consumer = JobConsumer(
        redis_client, storage, PipelineRegistry([DecodingPipeline()]), "cpu", WORKER_ID, block_ms=50
    )
    consumer.ensure_group()
    put_input(b"this is not an image")
    add_job(redis_client)
    consumer.poll_once()

    failed = results(redis_client)[-1]
    assert failed["type"] == "FAILED"
    assert failed["retryable"] == "false"
    assert "decode" in failed["error"]


def test_invalid_params_fail_not_retryable(redis_client, consumer, put_input):
    put_input()
    add_job(redis_client, params="{oops")
    consumer.poll_once()
    out = results(redis_client)
    assert [m["type"] for m in out] == ["FAILED"]
    assert out[0]["retryable"] == "false"
    assert out[0]["attempt"] == "1"
    assert pending_count(redis_client) == 0


@pytest.mark.parametrize("attempt", ["one", "0", "-2", "1.5", ""])
def test_unparseable_attempt_fails_with_attempt_zero_and_is_acked(redis_client, consumer, attempt):
    entry_id = add_job(redis_client, attempt=attempt)
    calls = record_calls(consumer)
    consumer.poll_once()

    out = results(redis_client)
    assert [m["type"] for m in out] == ["FAILED"]
    assert out[0]["attempt"] == "0"
    assert out[0]["retryable"] == "false"
    assert calls == [("XADD", "FAILED"), ("XACK", entry_id)]
    assert pending_count(redis_client) == 0


def test_message_without_job_id_is_acked_and_dropped(redis_client, consumer):
    redis_client.xadd(STREAM, {"garbage": "1"})
    consumer.poll_once()
    assert results(redis_client) == []
    assert pending_count(redis_client) == 0


def test_missing_input_object_fails_not_retryable(redis_client, consumer):
    add_job(redis_client)  # nothing uploaded
    consumer.poll_once()
    failed = results(redis_client)[-1]
    assert failed["type"] == "FAILED"
    assert failed["retryable"] == "false"
    assert "NoSuchKey" in failed["error"]


def test_storage_outage_fails_retryable(redis_client, consumer, monkeypatch):
    def boom(uri):
        raise EndpointConnectionError(endpoint_url="http://seaweedfs:8333")

    monkeypatch.setattr(consumer.storage, "get_bytes", boom)
    add_job(redis_client)
    consumer.poll_once()
    failed = results(redis_client)[-1]
    assert failed["type"] == "FAILED"
    assert failed["retryable"] == "true"
    assert [m["type"] for m in results(redis_client)] == ["STARTED", "FAILED"]


def test_unexpected_pipeline_error_fails_retryable_with_last_progress(
    redis_client, consumer, pipeline, put_input
):
    put_input()
    pipeline.error = RuntimeError("torch exploded")
    add_job(redis_client)
    consumer.poll_once()
    failed = results(redis_client)[-1]
    assert failed["type"] == "FAILED"
    assert failed["retryable"] == "true"
    assert failed["progress"] == "40"
    assert "torch exploded" in failed["error"]


def test_pending_entries_are_processed_first(redis_client, consumer, pipeline, put_input):
    put_input()
    first = job_fields("aaaaaaaa-0000-0000-0000-000000000001")
    second = job_fields("aaaaaaaa-0000-0000-0000-000000000002")
    redis_client.xadd(STREAM, first)
    # simulate a crash: delivered to this consumer but never ACKed
    redis_client.xreadgroup(CONSUMER_GROUP, WORKER_ID, {STREAM: ">"}, count=1)
    redis_client.xadd(STREAM, second)
    assert pending_count(redis_client) == 1

    assert consumer.drain_pending() == 1
    consumer.poll_once()

    done_ids = [m["jobId"] for m in results(redis_client) if m["type"] == "DONE"]
    assert done_ids == [first["jobId"], second["jobId"]]
    assert pending_count(redis_client) == 0


def test_run_loop_stops_gracefully(redis_client, consumer, put_input):
    put_input()
    add_job(redis_client)
    thread = threading.Thread(target=consumer.run)
    thread.start()
    try:
        for _ in range(100):
            if any(m["type"] == "DONE" for m in results(redis_client)):
                break
            threading.Event().wait(0.05)
    finally:
        consumer.stop()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert any(m["type"] == "DONE" for m in results(redis_client))


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("Cardiomegaly", "Cardiomegaly"),
        ("Lung Opacity", "Lung_Opacity"),
        ("Enlarged Cardiomediastinum", "Enlarged_Cardiomediastinum"),
        ("Pleural_Thickening", "Pleural_Thickening"),
        ("a/b", "a_b"),
    ],
)
def test_sanitize_label(label, expected):
    assert sanitize_label(label) == expected


def test_png_helper_round_trip():
    arr, maxval = decode_grayscale(png_bytes(64, 32))
    assert arr.shape == (32, 64) and maxval == 255.0
