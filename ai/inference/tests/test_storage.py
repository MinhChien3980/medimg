from __future__ import annotations

import pytest
from botocore.exceptions import ClientError

from tests.helpers import BUCKET
from worker.errors import InvalidJobError, classify
from worker.storage import S3Uri, make_s3_client


def test_parse_s3_uri():
    uri = S3Uri.parse("s3://medimg/predictions/j/1/heatmap-Effusion.png")
    assert uri.bucket == "medimg"
    assert uri.key == "predictions/j/1/heatmap-Effusion.png"
    assert str(uri) == "s3://medimg/predictions/j/1/heatmap-Effusion.png"


@pytest.mark.parametrize("bad", ["medimg/key", "s3://", "s3://medimg", "s3://medimg/", "s3:///k"])
def test_parse_rejects_bad_uris(bad):
    with pytest.raises(InvalidJobError):
        S3Uri.parse(bad)


def test_put_and_get_round_trip(storage, s3):
    uri = f"s3://{BUCKET}/predictions/j/1/result.json"
    assert storage.put_bytes(uri, b'{"ok":true}', "application/json") == uri
    assert storage.get_bytes(uri) == b'{"ok":true}'
    head = s3.head_object(Bucket=BUCKET, Key="predictions/j/1/result.json")
    assert head["ContentType"] == "application/json"


def test_missing_object_is_not_retryable(storage):
    with pytest.raises(ClientError) as err:
        storage.get_bytes(f"s3://{BUCKET}/nope.png")
    _, retryable = classify(err.value)
    assert retryable is False


def test_client_uses_path_style_addressing():
    client = make_s3_client("http://seaweedfs:8333", "key", "secret", "us-east-1")
    assert client.meta.config.s3["addressing_style"] == "path"
    assert client.meta.endpoint_url == "http://seaweedfs:8333"
    assert client.meta.region_name == "us-east-1"
