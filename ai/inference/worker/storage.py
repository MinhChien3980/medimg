"""S3-compatible object storage (SeaweedFS locally, any S3 API in other environments) via boto3."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config

from worker.errors import InvalidJobError


@dataclass(frozen=True)
class S3Uri:
    bucket: str
    key: str

    @classmethod
    def parse(cls, uri: str) -> S3Uri:
        if not uri.startswith("s3://"):
            raise InvalidJobError(f"not an s3:// URI: {uri!r}")
        bucket, sep, key = uri[len("s3://") :].partition("/")
        if not bucket or not sep or not key:
            raise InvalidJobError(f"s3 URI needs a bucket and a key: {uri!r}")
        return cls(bucket=bucket, key=key)

    def __str__(self) -> str:
        return f"s3://{self.bucket}/{self.key}"


def make_s3_client(
    endpoint: str | None, access_key: str, secret_key: str, region: str = "us-east-1"
) -> Any:
    """Path-style addressing (`http://host/bucket/key`) so SeaweedFS works without DNS tricks."""
    return boto3.client(
        "s3",
        endpoint_url=endpoint or None,
        aws_access_key_id=access_key or None,
        aws_secret_access_key=secret_key or None,
        region_name=region,
        config=Config(
            s3={"addressing_style": "path"},
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "standard"},
            connect_timeout=5,
            read_timeout=30,
        ),
    )


class ObjectStorage:
    def __init__(self, client: Any) -> None:
        self._client = client

    def get_bytes(self, uri: str) -> bytes:
        loc = S3Uri.parse(uri)
        response = self._client.get_object(Bucket=loc.bucket, Key=loc.key)
        with response["Body"] as body:
            return body.read()

    def put_bytes(self, uri: str, data: bytes, content_type: str) -> str:
        loc = S3Uri.parse(uri)
        self._client.put_object(Bucket=loc.bucket, Key=loc.key, Body=data, ContentType=content_type)
        return str(loc)
