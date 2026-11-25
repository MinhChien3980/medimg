"""Redis Streams message contract shared with core-service.

Job (stream `ai.jobs.{cpu|gpu}`): jobId, attempt, modelCode, modelVersion, task, inputType,
inputUri, outputPrefix, params (JSON string).

Result (stream `ai.results`): jobId, attempt, workerId, type (STARTED|PROGRESS|DONE|FAILED),
progress (0-100), payload (DONE, JSON string), error + retryable ("true"/"false") (FAILED).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from worker.errors import InvalidJobError

RESULTS_STREAM = "ai.results"
CONSUMER_GROUP = "ai-workers"


def jobs_stream(kind: str) -> str:
    return f"ai.jobs.{kind}"


def heartbeat_key(kind: str, worker_id: str) -> str:
    return f"ai:worker:{kind}:{worker_id}"


def cancelled_key(job_id: str) -> str:
    return f"ai:job:{job_id}:cancelled"


class ResultType(StrEnum):
    STARTED = "STARTED"
    PROGRESS = "PROGRESS"
    DONE = "DONE"
    FAILED = "FAILED"


_REQUIRED = ("jobId", "attempt", "modelCode", "inputUri", "outputPrefix")


@dataclass(frozen=True)
class JobMessage:
    job_id: str
    attempt: int
    model_code: str
    input_uri: str
    output_prefix: str
    model_version: str = ""
    task: str = ""
    input_type: str = ""
    params: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def parse(cls, fields: dict[str, str]) -> JobMessage:
        """Parse raw stream fields. Raises InvalidJobError (non-retryable) on bad input."""
        missing = [name for name in _REQUIRED if not fields.get(name)]
        if missing:
            raise InvalidJobError(f"job message missing field(s): {', '.join(missing)}")
        try:
            attempt = int(fields["attempt"])
        except ValueError as exc:
            raise InvalidJobError(f"attempt is not an integer: {fields['attempt']!r}") from exc
        if attempt < 1:
            raise InvalidJobError(f"attempt must be >= 1, got {attempt}")

        raw_params = fields.get("params") or "{}"
        try:
            params = json.loads(raw_params)
        except json.JSONDecodeError as exc:
            raise InvalidJobError(f"params is not valid JSON: {exc.msg}") from exc
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise InvalidJobError("params must be a JSON object")

        for uri_field in ("inputUri", "outputPrefix"):
            if not fields[uri_field].startswith("s3://"):
                raise InvalidJobError(f"{uri_field} must be an s3:// URI")

        return cls(
            job_id=fields["jobId"],
            attempt=attempt,
            model_code=fields["modelCode"],
            input_uri=fields["inputUri"],
            output_prefix=fields["outputPrefix"],
            model_version=fields.get("modelVersion", ""),
            task=fields.get("task", ""),
            input_type=fields.get("inputType", ""),
            params=params,
        )

    def artifact_uri(self, name: str) -> str:
        prefix = self.output_prefix
        if not prefix.endswith("/"):
            prefix += "/"
        return prefix + name


def _base(job_id: str, attempt: int | str, worker_id: str, type_: ResultType, progress: int):
    return {
        "jobId": job_id,
        "attempt": str(attempt),
        "workerId": worker_id,
        "type": type_.value,
        "progress": str(int(progress)),
    }


def started(job_id: str, attempt: int | str, worker_id: str) -> dict[str, str]:
    return _base(job_id, attempt, worker_id, ResultType.STARTED, 0)


def progress(job_id: str, attempt: int | str, worker_id: str, pct: int) -> dict[str, str]:
    return _base(job_id, attempt, worker_id, ResultType.PROGRESS, max(0, min(100, pct)))


def done(
    job_id: str, attempt: int | str, worker_id: str, payload: dict[str, Any]
) -> dict[str, str]:
    msg = _base(job_id, attempt, worker_id, ResultType.DONE, 100)
    msg["payload"] = dump_json(payload)
    return msg


def failed(
    job_id: str, attempt: int | str, worker_id: str, error: str, retryable: bool, pct: int = 0
) -> dict[str, str]:
    msg = _base(job_id, attempt, worker_id, ResultType.FAILED, pct)
    msg["error"] = error[:2000]
    msg["retryable"] = "true" if retryable else "false"
    return msg


def dump_json(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
