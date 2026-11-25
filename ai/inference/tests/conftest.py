from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

import boto3
import fakeredis
import pytest
from moto import mock_aws

from tests.helpers import BUCKET, WORKER_ID, FakePipeline, png_bytes
from worker.consumer import JobConsumer
from worker.pipelines.registry import PipelineRegistry
from worker.storage import ObjectStorage


@pytest.fixture
def redis_client() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis(decode_responses=True)


@pytest.fixture
def s3() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


@pytest.fixture
def storage(s3: Any) -> ObjectStorage:
    return ObjectStorage(s3)


@pytest.fixture
def pipeline() -> FakePipeline:
    return FakePipeline()


@pytest.fixture
def consumer(redis_client, storage, pipeline) -> JobConsumer:
    c = JobConsumer(
        redis_client, storage, PipelineRegistry([pipeline]), "cpu", WORKER_ID, block_ms=50
    )
    c.ensure_group()
    return c


@pytest.fixture
def put_input(s3: Any) -> Callable[[bytes], None]:
    def _put(data: bytes = b"", key: str = "studies/s1/series/se1/image.png") -> None:
        s3.put_object(Bucket=BUCKET, Key=key, Body=data or png_bytes())

    return _put
