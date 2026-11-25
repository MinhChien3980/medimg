"""Error taxonomy: decides whether a failed job is worth retrying (contract field `retryable`)."""

from __future__ import annotations

from botocore.exceptions import BotoCoreError, ClientError
from redis.exceptions import RedisError


class JobError(Exception):
    """An error with an explicit retry decision."""

    retryable: bool = True

    def __init__(self, message: str, *, retryable: bool | None = None) -> None:
        super().__init__(message)
        if retryable is not None:
            self.retryable = retryable


class InvalidJobError(JobError):
    """Malformed job message or params (missing fields, bad JSON, out-of-range values)."""

    retryable = False


class UnknownModelError(JobError):
    """No pipeline registered for the requested modelCode."""

    retryable = False


class BadInputError(JobError):
    """The input object exists but cannot be used (undecodable image, wrong size, ...)."""

    retryable = False


class JobCancelled(Exception):
    """Raised when `ai:job:{jobId}:cancelled` is seen between pipeline steps."""


_NOT_FOUND_CODES = {"404", "NoSuchKey", "NoSuchBucket", "NotFound"}


def classify(exc: BaseException) -> tuple[str, bool]:
    """Return `(error message, retryable)` for any exception raised while processing a job."""
    if isinstance(exc, JobError):
        return str(exc), exc.retryable
    if isinstance(exc, ClientError):
        code = str(exc.response.get("Error", {}).get("Code", ""))
        message = f"storage error: {code or exc}"
        # A missing input object will not appear by retrying; everything else (5xx, throttling,
        # auth hiccups on a restarting SeaweedFS) is treated as transient.
        return message, code not in _NOT_FOUND_CODES
    if isinstance(exc, BotoCoreError):  # endpoint unreachable, read timeout, ...
        return f"storage error: {exc}", True
    if isinstance(exc, RedisError):
        return f"redis error: {exc}", True
    if isinstance(exc, OSError):  # includes ConnectionError and TimeoutError
        return f"network error: {exc}", True
    if isinstance(exc, MemoryError):
        return "out of memory", True
    # Unknown failure (bug, torch runtime error): let core retry; it caps attempts at 3.
    return f"internal error: {type(exc).__name__}: {exc}", True
