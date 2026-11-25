"""Redis Streams message contracts shared with core-service.

AI jobs (stream `ai.jobs.{cpu|gpu}`, group `ai-workers`): jobId, attempt, modelCode, modelVersion,
task, inputType, inputUri, outputPrefix, params (JSON string).
Results (stream `ai.results`): jobId, attempt, workerId, type (STARTED|PROGRESS|DONE|FAILED),
progress (0-100), payload (DONE, JSON string), error + retryable ("true"/"false") (FAILED).

Ingest jobs (stream `imaging.jobs`, group `ingest-workers`): uploadId, attempt, inputType
(DICOM_2D|ZIP|NIFTI), inputUri, outputPrefix, modalityHint, bodyPartHint, sliceSpacingMm (JSON
array `[x, y, z]` mm or empty).
Results (stream `imaging.results`): the AI result fields with `uploadId` instead of `jobId`; the
DONE payload names the final input type (DICOM_2D|DICOM_SERIES|IMAGE_STACK|NIFTI).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from worker.errors import InvalidJobError

RESULTS_STREAM = "ai.results"
CONSUMER_GROUP = "ai-workers"

IMAGING_JOBS_STREAM = "imaging.jobs"
IMAGING_RESULTS_STREAM = "imaging.results"
INGEST_CONSUMER_GROUP = "ingest-workers"


def jobs_stream(kind: str) -> str:
    return f"ai.jobs.{kind}"


def heartbeat_key(kind: str, worker_id: str) -> str:
    return f"ai:worker:{kind}:{worker_id}"


def imaging_heartbeat_key(worker_id: str) -> str:
    return f"imaging:worker:{worker_id}"


def cancelled_key(job_id: str) -> str:
    return f"ai:job:{job_id}:cancelled"


class ResultType(StrEnum):
    STARTED = "STARTED"
    PROGRESS = "PROGRESS"
    DONE = "DONE"
    FAILED = "FAILED"


def _missing(fields: dict[str, str], required: tuple[str, ...]) -> None:
    missing = [name for name in required if not fields.get(name)]
    if missing:
        raise InvalidJobError(f"job message missing field(s): {', '.join(missing)}")


def _attempt(raw: str) -> int:
    try:
        attempt = int(raw)
    except ValueError as exc:
        raise InvalidJobError(f"attempt is not an integer: {raw!r}") from exc
    if attempt < 1:
        raise InvalidJobError(f"attempt must be >= 1, got {attempt}")
    return attempt


def _s3_uris(fields: dict[str, str], names: tuple[str, ...]) -> None:
    for name in names:
        if not fields[name].startswith("s3://"):
            raise InvalidJobError(f"{name} must be an s3:// URI")


def _join(prefix: str, name: str) -> str:
    return prefix + name if prefix.endswith("/") else f"{prefix}/{name}"


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

    @property
    def id(self) -> str:
        return self.job_id

    @classmethod
    def parse(cls, fields: dict[str, str]) -> JobMessage:
        """Parse raw stream fields. Raises InvalidJobError (non-retryable) on bad input."""
        _missing(fields, _REQUIRED)
        attempt = _attempt(fields["attempt"])

        raw_params = fields.get("params") or "{}"
        try:
            params = json.loads(raw_params)
        except json.JSONDecodeError as exc:
            raise InvalidJobError(f"params is not valid JSON: {exc.msg}") from exc
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise InvalidJobError("params must be a JSON object")

        _s3_uris(fields, ("inputUri", "outputPrefix"))
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
        return _join(self.output_prefix, name)


class IngestInputType(StrEnum):
    """What core recognised from the upload's magic bytes; a ZIP's content is the worker's call."""

    DICOM_2D = "DICOM_2D"
    ZIP = "ZIP"
    NIFTI = "NIFTI"


class IngestResultType(StrEnum):
    """`inputType` of the DONE payload: what the upload turned out to be."""

    DICOM_2D = "DICOM_2D"
    DICOM_SERIES = "DICOM_SERIES"
    IMAGE_STACK = "IMAGE_STACK"
    NIFTI = "NIFTI"


_LEGACY_INPUT_TYPES = {"DICOM_SERIES": IngestInputType.ZIP}
"""Slice 2a name of `ZIP`, still accepted for jobs queued before an upgrade."""

_INGEST_REQUIRED = ("uploadId", "attempt", "inputType", "inputUri", "outputPrefix")

SLICE_SPACING_RANGE_MM = (0.01, 20.0)


def _slice_spacing(raw: str) -> tuple[float, float, float] | None:
    """`sliceSpacingMm`: empty, or a JSON array of three numbers in 0.01-20 mm."""
    if not raw.strip():
        return None
    lo, hi = SLICE_SPACING_RANGE_MM
    error = InvalidJobError(
        f"sliceSpacingMm must be a JSON array of three numbers between {lo:g} and {hi:g} mm, "
        f"got {raw[:100]!r}"
    )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise error from None
    if not isinstance(value, list) or len(value) != 3:
        raise error
    spacing: list[float] = []
    for v in value:
        if isinstance(v, bool) or not isinstance(v, int | float):
            raise error
        if not (math.isfinite(v) and lo <= v <= hi):
            raise error
        spacing.append(float(v))
    return spacing[0], spacing[1], spacing[2]


@dataclass(frozen=True)
class IngestJob:
    upload_id: str
    attempt: int
    input_type: IngestInputType
    input_uri: str
    output_prefix: str
    modality_hint: str = ""
    body_part_hint: str = ""
    slice_spacing_mm: tuple[float, float, float] | None = None
    """Voxel size `[x, y, z]` given by the uploader for a ZIP of plain images; None = unknown."""

    @property
    def id(self) -> str:
        return self.upload_id

    @classmethod
    def parse(cls, fields: dict[str, str]) -> IngestJob:
        _missing(fields, _INGEST_REQUIRED)
        attempt = _attempt(fields["attempt"])
        raw_type = fields["inputType"]
        try:
            input_type = _LEGACY_INPUT_TYPES.get(raw_type) or IngestInputType(raw_type)
        except ValueError:
            allowed = ", ".join(t.value for t in IngestInputType)
            raise InvalidJobError(f"inputType must be one of {allowed}, got {raw_type!r}") from None
        _s3_uris(fields, ("inputUri", "outputPrefix"))
        return cls(
            upload_id=fields["uploadId"],
            attempt=attempt,
            input_type=input_type,
            input_uri=fields["inputUri"],
            output_prefix=fields["outputPrefix"],
            modality_hint=fields.get("modalityHint", "").strip().upper(),
            body_part_hint=fields.get("bodyPartHint", "").strip(),
            slice_spacing_mm=_slice_spacing(fields.get("sliceSpacingMm", "")),
        )

    def artifact_uri(self, name: str) -> str:
        return _join(self.output_prefix, name)


@dataclass(frozen=True)
class ResultSchema:
    """Builds the flat string maps XADDed to a results stream keyed by `id_field`."""

    stream: str
    id_field: str

    def _base(self, id_: str, attempt: int | str, worker_id: str, type_: ResultType, pct: int):
        return {
            self.id_field: id_,
            "attempt": str(attempt),
            "workerId": worker_id,
            "type": type_.value,
            "progress": str(int(pct)),
        }

    def started(self, id_: str, attempt: int | str, worker_id: str) -> dict[str, str]:
        return self._base(id_, attempt, worker_id, ResultType.STARTED, 0)

    def progress(self, id_: str, attempt: int | str, worker_id: str, pct: int) -> dict[str, str]:
        return self._base(id_, attempt, worker_id, ResultType.PROGRESS, max(0, min(100, pct)))

    def done(
        self, id_: str, attempt: int | str, worker_id: str, payload: dict[str, Any]
    ) -> dict[str, str]:
        msg = self._base(id_, attempt, worker_id, ResultType.DONE, 100)
        msg["payload"] = dump_json(payload)
        return msg

    def failed(
        self,
        id_: str,
        attempt: int | str,
        worker_id: str,
        error: str,
        retryable: bool,
        pct: int = 0,
    ) -> dict[str, str]:
        msg = self._base(id_, attempt, worker_id, ResultType.FAILED, pct)
        msg["error"] = error[:2000]
        msg["retryable"] = "true" if retryable else "false"
        return msg


AI_RESULTS = ResultSchema(stream=RESULTS_STREAM, id_field="jobId")
IMAGING_RESULTS = ResultSchema(stream=IMAGING_RESULTS_STREAM, id_field="uploadId")

started = AI_RESULTS.started
progress = AI_RESULTS.progress
done = AI_RESULTS.done
failed = AI_RESULTS.failed


def dump_json(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
