from __future__ import annotations

import json

import pytest

from tests.helpers import job_fields
from worker import messages
from worker.errors import InvalidJobError
from worker.messages import JobMessage


def test_parse_full_job_message():
    job = JobMessage.parse(job_fields(params='{"threshold":0.3}'))
    assert job.job_id == "11111111-1111-1111-1111-111111111111"
    assert job.attempt == 1
    assert job.model_code == "cxr-multilabel"
    assert job.model_version == "0.1.0-xrv"
    assert job.task == "CLASSIFICATION_2D"
    assert job.input_type == "IMAGE_2D"
    assert job.input_uri.startswith("s3://medimg/studies/")
    assert job.params == {"threshold": 0.3}


@pytest.mark.parametrize("raw", [None, "", "null", "{}"])
def test_missing_or_empty_params_default_to_empty_dict(raw):
    fields = job_fields()
    if raw is None:
        del fields["params"]
    else:
        fields["params"] = raw
    assert JobMessage.parse(fields).params == {}


@pytest.mark.parametrize("missing", ["jobId", "attempt", "modelCode", "inputUri", "outputPrefix"])
def test_missing_required_field_is_invalid(missing):
    fields = job_fields()
    del fields[missing]
    with pytest.raises(InvalidJobError) as err:
        JobMessage.parse(fields)
    assert missing in str(err.value)
    assert err.value.retryable is False


@pytest.mark.parametrize(
    "override",
    [
        {"attempt": "one"},
        {"attempt": "0"},
        {"params": "{not json"},
        {"params": "[1,2]"},
        {"inputUri": "http://x/y.png"},
        {"outputPrefix": "/tmp/out/"},
    ],
)
def test_bad_values_are_invalid(override):
    with pytest.raises(InvalidJobError):
        JobMessage.parse(job_fields(**override))


def test_artifact_uri_handles_missing_trailing_slash():
    job = JobMessage.parse(job_fields(outputPrefix="s3://medimg/predictions/j/2"))
    assert job.artifact_uri("result.json") == "s3://medimg/predictions/j/2/result.json"
    job = JobMessage.parse(job_fields(outputPrefix="s3://medimg/predictions/j/2/"))
    assert job.artifact_uri("result.json") == "s3://medimg/predictions/j/2/result.json"


def test_result_messages_are_flat_string_maps():
    for msg in (
        messages.started("j", 1, "w"),
        messages.progress("j", 1, "w", 40),
        messages.done("j", 1, "w", {"a": 1}),
        messages.failed("j", 1, "w", "boom", retryable=True),
    ):
        assert all(isinstance(k, str) and isinstance(v, str) for k, v in msg.items())
        assert msg["jobId"] == "j"
        assert msg["attempt"] == "1"
        assert msg["workerId"] == "w"


def test_started_progress_done_shapes():
    assert messages.started("j", 2, "w") == {
        "jobId": "j",
        "attempt": "2",
        "workerId": "w",
        "type": "STARTED",
        "progress": "0",
    }
    assert messages.progress("j", 2, "w", 140)["progress"] == "100"
    assert messages.progress("j", 2, "w", 40)["type"] == "PROGRESS"
    done = messages.done("j", 2, "w", {"modelVersion": "v", "findings": []})
    assert done["type"] == "DONE"
    assert done["progress"] == "100"
    assert json.loads(done["payload"]) == {"modelVersion": "v", "findings": []}
    assert " " not in done["payload"]  # compact JSON
    assert "error" not in done and "retryable" not in done


@pytest.mark.parametrize(("retryable", "expected"), [(True, "true"), (False, "false")])
def test_failed_shape(retryable, expected):
    msg = messages.failed("j", 1, "w", "bad image", retryable=retryable, pct=10)
    assert msg["type"] == "FAILED"
    assert msg["error"] == "bad image"
    assert msg["retryable"] == expected
    assert msg["progress"] == "10"
    assert "payload" not in msg


def test_key_and_stream_names():
    assert messages.jobs_stream("cpu") == "ai.jobs.cpu"
    assert messages.jobs_stream("gpu") == "ai.jobs.gpu"
    assert messages.RESULTS_STREAM == "ai.results"
    assert messages.CONSUMER_GROUP == "ai-workers"
    assert messages.heartbeat_key("cpu", "w1") == "ai:worker:cpu:w1"
    assert messages.cancelled_key("j1") == "ai:job:j1:cancelled"
