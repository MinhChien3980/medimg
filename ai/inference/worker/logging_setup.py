"""Structured JSON logging; every record carries the id of the job being processed (`jobId` for
AI jobs, `uploadId` for ingest jobs) when there is one."""

from __future__ import annotations

import contextvars
import json
import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

_job: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("job", default=None)

_STD_ATTRS = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {"message", "asctime"}


@contextmanager
def job_context(job_id: str | None, key: str = "jobId") -> Iterator[None]:
    token = _job.set((key, job_id) if job_id else None)
    try:
        yield
    finally:
        _job.reset(token)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        job = _job.get()
        if job:
            entry[job[0]] = job[1]
        for key, value in vars(record).items():
            if key not in _STD_ATTRS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, ensure_ascii=False)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for noisy in ("botocore", "boto3", "urllib3", "s3transfer"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
