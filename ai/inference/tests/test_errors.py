from __future__ import annotations

import pytest
import redis
from botocore.exceptions import ClientError, EndpointConnectionError, ReadTimeoutError

from worker.errors import BadInputError, InvalidJobError, UnknownModelError, classify


def client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "GetObject")


@pytest.mark.parametrize(
    ("exc", "retryable"),
    [
        (InvalidJobError("bad params"), False),
        (UnknownModelError("nope"), False),
        (BadInputError("cannot decode"), False),
        (client_error("NoSuchKey"), False),
        (client_error("NoSuchBucket"), False),
        (client_error("InternalError"), True),
        (client_error("SlowDown"), True),
        (EndpointConnectionError(endpoint_url="http://s3"), True),
        (ReadTimeoutError(endpoint_url="http://s3"), True),
        (redis.ConnectionError("down"), True),
        (ConnectionResetError("reset"), True),
        (TimeoutError("slow"), True),
        (RuntimeError("unexpected"), True),
    ],
)
def test_classify(exc, retryable):
    message, is_retryable = classify(exc)
    assert is_retryable is retryable
    assert message
