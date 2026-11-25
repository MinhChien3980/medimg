"""The ingest role end to end on fakeredis + moto: `imaging.jobs` -> S3 -> `imaging.results`."""

from __future__ import annotations

import gzip
import io
import json

import nibabel as nib
import numpy as np
import pytest
from botocore.exceptions import EndpointConnectionError

from tests.helpers import BUCKET, WORKER_ID
from tests.volumes import SeriesSpec, nifti_bytes, series_zip
from worker.ingest.archive import ZipLimits
from worker.ingest.workload import IngestWorkload
from worker.messages import (
    IMAGING_JOBS_STREAM,
    IMAGING_RESULTS_STREAM,
    INGEST_CONSUMER_GROUP,
    IngestJob,
    imaging_heartbeat_key,
)
from worker.stream_consumer import StreamConsumer

UPLOAD_ID = "22222222-2222-2222-2222-222222222222"
PREFIX = f"s3://{BUCKET}/studies/st1/series/se1/"


@pytest.fixture
def ingest(redis_client, storage):
    consumer = StreamConsumer(
        redis_client, IngestWorkload(storage, ZipLimits(max_entries=200)), WORKER_ID, block_ms=50
    )
    consumer.ensure_group()
    return consumer


def ingest_fields(**overrides: str) -> dict[str, str]:
    fields = {
        "uploadId": UPLOAD_ID,
        "attempt": "1",
        "inputType": "NIFTI",
        "inputUri": f"s3://{BUCKET}/uploads/{UPLOAD_ID}/f1/ct.nii.gz",
        "outputPrefix": PREFIX,
        "modalityHint": "",
        "bodyPartHint": "CHEST",
    }
    fields.update(overrides)
    return fields


def out(redis_client) -> list[dict[str, str]]:
    return [fields for _, fields in redis_client.xrange(IMAGING_RESULTS_STREAM)]


def pending(redis_client) -> int:
    return redis_client.xpending(IMAGING_JOBS_STREAM, INGEST_CONSUMER_GROUP)["pending"]


def put(s3, key: str, data: bytes) -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=data)


def test_nifti_upload_becomes_volume_and_thumbnail(redis_client, ingest, s3):
    data = np.full((40, 30, 24), -1000, dtype=np.int16)
    data[10:30, 5:25, :] = 40
    affine = np.diag([-0.7, -0.7, 2.5, 1.0])
    put(s3, f"uploads/{UPLOAD_ID}/f1/ct.nii.gz", nifti_bytes(data, affine, descrip=b"secret"))
    entry = redis_client.xadd(IMAGING_JOBS_STREAM, ingest_fields())
    calls: list[str] = []
    emit, ack = ingest.emit, ingest.ack
    ingest.emit = lambda f: (calls.append(f"XADD {f['type']}"), emit(f))  # type: ignore[method-assign]
    ingest.ack = lambda e: (calls.append(f"XACK {e}"), ack(e))  # type: ignore[method-assign]

    assert ingest.poll_once()

    results = out(redis_client)
    assert [(m["type"], m["progress"]) for m in results] == [
        ("STARTED", "0"),
        ("PROGRESS", "10"),
        ("PROGRESS", "40"),
        ("PROGRESS", "70"),
        ("PROGRESS", "90"),
        ("PROGRESS", "95"),
        ("DONE", "100"),
    ]
    assert all(
        m["uploadId"] == UPLOAD_ID and m["attempt"] == "1" and m["workerId"] == WORKER_ID
        for m in results
    )
    assert "jobId" not in results[0]
    assert calls[-2:] == ["XADD DONE", f"XACK {entry}"]
    assert pending(redis_client) == 0

    payload = json.loads(results[-1]["payload"])
    assert payload == {
        "volumeUri": f"{PREFIX}volume.nii.gz",
        "thumbnailUri": f"{PREFIX}thumb.png",
        "modality": "CT",
        "dims": [40, 30, 24],
        "spacing": [0.7, 0.7, 2.5],
        "numSlices": 24,
        "huRange": [-1000, 40],
        "sourceSeries": {"slices": 24, "seriesCount": 1},
    }

    stored = s3.get_object(Bucket=BUCKET, Key="studies/st1/series/se1/volume.nii.gz")
    assert stored["ContentType"] == "application/gzip"
    assert "ContentEncoding" not in stored  # Cornerstone gunzips itself; the browser must not
    image = nib.Nifti1Image.from_bytes(gzip.decompress(stored["Body"].read()))
    assert nib.aff2axcodes(image.affine) == ("R", "A", "S")
    assert image.header["descrip"].item() == b""
    thumb = s3.get_object(Bucket=BUCKET, Key="studies/st1/series/se1/thumb.png")
    assert thumb["ContentType"] == "image/png"
    assert thumb["Body"].read()[:8] == b"\x89PNG\r\n\x1a\n"


def test_dicom_zip_upload(redis_client, ingest, s3, tmp_path):
    spec = SeriesSpec(slices=22)
    other = SeriesSpec(slices=20, origin=(5.0, 5.0, 5.0))
    put(s3, "uploads/u/f/series.zip", series_zip(spec, other, tmp=tmp_path))
    redis_client.xadd(
        IMAGING_JOBS_STREAM,
        ingest_fields(inputType="DICOM_SERIES", inputUri=f"s3://{BUCKET}/uploads/u/f/series.zip"),
    )
    ingest.poll_once()

    payload = json.loads(out(redis_client)[-1]["payload"])
    assert payload["modality"] == "CT"
    assert payload["sourceSeries"] == {"slices": 22, "seriesCount": 2}
    assert payload["huRange"] == [0, 1000]
    assert sorted(payload["dims"]) == sorted([12, 10, 22])


def test_bad_data_fails_not_retryable_with_a_clear_message(redis_client, ingest, s3, tmp_path):
    put(s3, "uploads/u/f/series.zip", series_zip(SeriesSpec(slices=5), tmp=tmp_path))
    redis_client.xadd(
        IMAGING_JOBS_STREAM,
        ingest_fields(inputType="DICOM_SERIES", inputUri=f"s3://{BUCKET}/uploads/u/f/series.zip"),
    )
    ingest.poll_once()

    failed = out(redis_client)[-1]
    assert failed["type"] == "FAILED"
    assert failed["retryable"] == "false"
    assert failed["error"] == "the series has 5 slices; a 3D volume needs at least 20"
    assert failed["progress"] == "10"
    assert pending(redis_client) == 0


def test_storage_outage_is_retryable(redis_client, ingest, monkeypatch):
    def boom(uri, path):
        raise EndpointConnectionError(endpoint_url="http://seaweedfs:8333")

    monkeypatch.setattr(ingest.workload.storage, "download_file", boom)
    redis_client.xadd(IMAGING_JOBS_STREAM, ingest_fields())
    ingest.poll_once()
    assert [(m["type"], m.get("retryable")) for m in out(redis_client)] == [
        ("STARTED", None),
        ("FAILED", "true"),
    ]


def test_missing_upload_is_not_retryable(redis_client, ingest):
    redis_client.xadd(IMAGING_JOBS_STREAM, ingest_fields())
    ingest.poll_once()
    failed = out(redis_client)[-1]
    assert (failed["type"], failed["retryable"]) == ("FAILED", "false")


@pytest.mark.parametrize(
    ("override", "attempt"),
    [({"inputType": "IMAGE_2D"}, "1"), ({"attempt": "zero"}, "0"), ({"inputUri": "/x"}, "1")],
)
def test_invalid_message_fails_not_retryable(redis_client, ingest, override, attempt):
    redis_client.xadd(IMAGING_JOBS_STREAM, ingest_fields(**override))
    ingest.poll_once()
    assert [(m["type"], m["attempt"], m["retryable"]) for m in out(redis_client)] == [
        ("FAILED", attempt, "false")
    ]
    assert pending(redis_client) == 0


def test_group_is_created_from_the_beginning_of_the_stream(redis_client, storage):
    redis_client.xadd(IMAGING_JOBS_STREAM, ingest_fields(uploadId="early"))
    consumer = StreamConsumer(redis_client, IngestWorkload(storage), WORKER_ID, block_ms=50)
    consumer.ensure_group()
    consumer.poll_once()
    assert out(redis_client)[0]["uploadId"] == "early"


def test_parse_ingest_job():
    job = IngestJob.parse(ingest_fields(modalityHint=" ct "))
    assert job.id == UPLOAD_ID
    assert job.modality_hint == "CT"
    assert job.body_part_hint == "CHEST"
    assert job.artifact_uri("thumb.png") == f"{PREFIX}thumb.png"
    assert imaging_heartbeat_key("w1") == "imaging:worker:w1"


def test_thumbnail_png_decodes(redis_client, ingest, s3):
    from PIL import Image

    put(
        s3,
        f"uploads/{UPLOAD_ID}/f1/ct.nii.gz",
        nifti_bytes(np.zeros((64, 32, 20), np.int16), np.eye(4)),
    )
    redis_client.xadd(IMAGING_JOBS_STREAM, ingest_fields())
    ingest.poll_once()
    body = s3.get_object(Bucket=BUCKET, Key="studies/st1/series/se1/thumb.png")["Body"].read()
    assert Image.open(io.BytesIO(body)).size == (256, 128)
