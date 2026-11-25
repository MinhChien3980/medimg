#!/usr/bin/env python3
"""Upload the sample CT volumes (see fetch_samples.py) into a running stack, mark them as samples.

For every `data/samples/<id>/ct.nii.gz`: log in, create the case `SAMPLE-<ID>` (or reuse it),
upload the file with `/api/v1/uploads/init` + presigned PUT + `complete`, wait until the server
has turned it into a study, then mark the case as a sample (`PUT /patients/{id}/sample`) with a
title and description built from the subject's `meta.json` and the dataset's licence. With
`--segment`, also run `ct-totalseg` on each sample, one at a time, and wait for it to finish.

    python tools/seed_samples.py                                 # http://localhost:8088, admin
    python tools/seed_samples.py --segment                       # + organ segmentation (slow)
    python tools/seed_samples.py --base-url http://localhost:8080 --username doctor

Cases that already have a study are not uploaded again unless --force is given (they are still
marked, and segmented with --segment); a sample whose study already has a finished `ct-totalseg`
job is not segmented again. Marking needs an ADMIN account. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_BASE = "http://localhost:8088"
DEFAULT_SAMPLES = Path(__file__).resolve().parents[1] / "data" / "samples"
CONTENT_TYPE = "application/gzip"
UPLOAD_TERMINAL = {"DONE", "FAILED"}
JOB_ACTIVE = {"QUEUED", "RUNNING"}
SEGMENT_MODEL = "ct-totalseg"
SOURCE = "TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0, Wasserthal et al. 2023"
TITLE_MAX, DESCRIPTION_MAX = 120, 500


class ApiError(Exception):
    pass


class Api:
    def __init__(self, base_url: str, timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.token: str | None = None

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: dict | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        url = f"{self.base_url}/api/v1{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        sent = {"Accept": "application/json", **(headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            sent["Content-Type"] = "application/json"
        if self.token:
            sent["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, data=data, method=method, headers=sent)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raise ApiError(f"{method} {path}: HTTP {exc.code} {_problem(exc)}") from None
        except urllib.error.URLError as exc:
            raise ApiError(f"{method} {path}: {exc.reason} (is the stack running?)") from None
        return json.loads(raw) if raw else None

    def login(self, username: str, password: str) -> None:
        self.token = self.call("POST", "/auth/login", {"username": username, "password": password})[
            "accessToken"
        ]

    def put_file(self, put_url: str, path: Path) -> None:
        """PUT the file body to a presigned URL (no Authorization header: S3 would reject it)."""
        url = urllib.parse.urljoin(self.base_url + "/", put_url)
        size = path.stat().st_size
        with path.open("rb") as body:
            request = urllib.request.Request(
                url,
                data=body,
                method="PUT",
                headers={"Content-Type": CONTENT_TYPE, "Content-Length": str(size)},
            )
            try:
                with urllib.request.urlopen(request, timeout=max(self.timeout, 600)) as response:
                    response.read()
            except urllib.error.HTTPError as exc:
                raise ApiError(f"PUT {url}: HTTP {exc.code} {_problem(exc)}") from None


def _problem(exc: urllib.error.HTTPError) -> str:
    """RFC 7807 `detail` (or the raw body) of an error response."""
    try:
        body = exc.read().decode("utf-8", "replace")
        return json.loads(body).get("detail") or body
    except (ValueError, AttributeError):
        return ""


# ---------------------------------------------------------------------- sample description


def load_meta(sample_dir: Path) -> dict[str, str]:
    """The subject's row of the dataset's meta.csv, written by fetch_samples.py (may be absent)."""
    path = sample_dir / "meta.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def _clean(value: str | None) -> str:
    text = (value or "").replace("_", " ").strip()
    return "" if text.lower() in {"", "nan", "none", "unknown", "-"} else text


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def sample_info(subject_id: str, meta: dict[str, str]) -> dict[str, str]:
    """Title, description and source of a sample case, from the subject's meta.csv row.

    Columns used when present: study_type, age, gender (f/m), pathology, pathology_location,
    manufacturer, scanner_model, kvp.
    """
    study = _clean(meta.get("study_type"))
    if study.lower().startswith("ct "):
        study = "CT " + study[3:]
    title = f"{study or 'CT scan'} ({subject_id})"

    parts: list[str] = []
    age = _clean(meta.get("age"))
    sex = {"f": "female", "m": "male"}.get(_clean(meta.get("gender")).lower(), "")
    if age and sex:
        parts.append(f"{age}-year-old {sex} patient.")
    elif age or sex:
        parts.append(f"Patient: {age + ' years' if age else sex}.")
    pathology = _clean(meta.get("pathology"))
    if pathology and pathology.lower() not in {"no pathology", "no"}:
        where = ", ".join(
            p.strip() for p in _clean(meta.get("pathology_location")).split(",") if p.strip()
        )
        parts.append(f"Pathology: {pathology}{f' ({where})' if where else ''}.")
    # the dataset writes most scanner names in lower case ("siemens", "somatom force")
    scanner = " ".join(
        v.title() if v.islower() else v
        for v in (_clean(meta.get("manufacturer")), _clean(meta.get("scanner_model")))
        if v
    )
    kvp = _clean(meta.get("kvp"))
    if scanner or kvp:
        parts.append(f"Scanner: {scanner or 'unknown'}{f', {kvp} kVp' if kvp else ''}.")
    parts.append(f"Subject {subject_id} of the TotalSegmentator small subset.")
    return {
        "title": _clip(title, TITLE_MAX),
        "description": _clip(" ".join(parts), DESCRIPTION_MAX),
        "source": SOURCE,
    }


# ---------------------------------------------------------------------- API steps


def find_or_create_case(api: Api, code: str, note: str) -> dict[str, Any]:
    page = api.call("GET", "/patients", query={"q": code, "size": 50})
    for patient in page.get("content", []):
        if patient.get("code") == code:
            return patient
    return api.call("POST", "/patients", {"code": code, "note": note})


def latest_study(api: Api, patient_id: str) -> dict[str, Any] | None:
    """The case's newest study that has a volume (studies come newest first)."""
    for study in api.call("GET", f"/patients/{patient_id}/studies") or []:
        if any(series.get("volumeUrl") for series in study.get("series", [])):
            return study
    return None


@dataclass
class Waiter:
    """Polling with an injectable clock, so the waits can be tested without sleeping."""

    timeout: float
    interval: float = 2.0
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic

    def until(
        self,
        fetch: Callable[[], dict],
        done: Callable[[dict], bool],
        what: str,
        first: dict | None = None,
    ) -> dict:
        """Poll `fetch` (starting from `first` when given) until `done`; ApiError on timeout."""
        deadline = self.clock() + self.timeout
        state = first if first is not None else fetch()
        shown = None
        while not done(state):
            if self.clock() > deadline:
                raise ApiError(f"{what} still {state.get('status')} after {self.timeout:.0f} s")
            now = (state.get("status"), state.get("progress"))
            if now != shown:
                print(f"    {now[0]} {now[1] or 0}%", flush=True)
                shown = now
            self.sleep(self.interval)
            state = fetch()
        return state


def upload(api: Api, patient_id: str, path: Path, waiter: Waiter) -> dict[str, Any]:
    init = api.call(
        "POST",
        "/uploads/init",
        {
            "patientId": patient_id,
            "files": [
                {"name": path.name, "size": path.stat().st_size, "contentType": CONTENT_TYPE}
            ],
            "modalityHint": "CT",
        },
    )
    upload_id = init["uploadId"]
    api.put_file(init["files"][0]["putUrl"], path)
    return waiter.until(
        lambda: api.call("GET", f"/uploads/{upload_id}"),
        lambda s: s["status"] in UPLOAD_TERMINAL,
        f"upload {upload_id}",
        first=api.call("POST", f"/uploads/{upload_id}/complete"),
    )


def mark_sample(api: Api, patient_id: str, info: dict[str, str]) -> None:
    api.call("PUT", f"/patients/{patient_id}/sample", info)


def segment(api: Api, study: dict[str, Any], waiter: Waiter) -> dict[str, Any] | None:
    """Run ct-totalseg on the study's volume and wait for it. Returns the finished job, or None
    when the study already had one. Raises ApiError when the job fails or times out."""
    study_id = study["id"]
    jobs = [
        job
        for job in api.call("GET", f"/studies/{study_id}/predictions") or []
        if (job.get("model") or {}).get("code") == SEGMENT_MODEL
    ]
    if any(job["status"] == "DONE" for job in jobs):
        return None
    active = next((job for job in jobs if job["status"] in JOB_ACTIVE), None)
    if active:
        job_id = active["jobId"]
        print(f"    waiting for the running {SEGMENT_MODEL} job {job_id}", flush=True)
    else:
        series = next((s for s in study.get("series", []) if s.get("volumeUrl")), None)
        if series is None:
            raise ApiError(f"study {study_id} has no volume to segment")
        created = api.call(
            "POST",
            "/predictions",
            {"studyId": study_id, "seriesId": series["id"], "modelCode": SEGMENT_MODEL},
            headers={"Idempotency-Key": f"seed-{SEGMENT_MODEL}-{series['id']}"},
        )
        job_id = created["jobId"]
    job = waiter.until(
        lambda: api.call("GET", f"/predictions/{job_id}"),
        lambda j: j["status"] not in JOB_ACTIVE,
        f"{SEGMENT_MODEL} job {job_id}",
    )
    if job["status"] != "DONE":
        raise ApiError(f"{SEGMENT_MODEL} job {job_id} {job['status']}: {job.get('error')}")
    return job


@dataclass
class Options:
    force: bool = False
    segment: bool = False
    upload_wait: Waiter | None = None
    segment_wait: Waiter | None = None


def seed_one(api: Api, path: Path, options: Options) -> None:
    """Upload (if needed), mark and optionally segment one sample. Raises ApiError on failure."""
    sid = path.parent.name
    code = f"SAMPLE-{sid.upper()}"
    case = find_or_create_case(
        api, code, f"TotalSegmentator sample {sid} (CC BY 4.0, Wasserthal et al. 2023)"
    )
    study = None
    if case.get("studyCount", 0) and not options.force:
        study = latest_study(api, case["id"])
    if study is not None:
        print(f"{code}: already has a study, not uploaded again")
    else:
        print(f"{code}: uploading {path.stat().st_size / 1e6:.1f} MB")
        result = upload(api, case["id"], path, options.upload_wait or Waiter(600))
        if result["status"] != "DONE":
            raise ApiError(f"upload FAILED: {result.get('error')}")
        print(f"{code}: DONE, study {result['studyId']}")
        study = api.call("GET", f"/studies/{result['studyId']}")

    info = sample_info(sid, load_meta(path.parent))
    mark_sample(api, case["id"], info)
    print(f"{code}: marked as sample {info['title']!r}")

    if options.segment:
        print(f"{code}: segmenting with {SEGMENT_MODEL}")
        job = segment(api, study, options.segment_wait or Waiter(1800, interval=5))
        if job is None:
            print(f"{code}: already segmented")
        else:
            print(f"{code}: segmented, {len(job.get('findings') or [])} organs")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default=os.environ.get("DEMO_PASSWORD", "Demo@12345"))
    parser.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    parser.add_argument("--timeout", type=float, default=600, help="seconds per upload")
    parser.add_argument("--force", action="store_true", help="upload even if the case has a study")
    parser.add_argument(
        "--segment", action="store_true", help=f"run {SEGMENT_MODEL} on each sample and wait"
    )
    parser.add_argument(
        "--segment-timeout",
        type=float,
        default=1800,
        help="seconds per segmentation job, queue time included (default 1800)",
    )
    args = parser.parse_args(argv)

    samples = sorted(p for p in args.samples.glob("*/ct.nii.gz"))
    if not samples:
        parser.error(f"no samples in {args.samples}; run tools/fetch_samples.py first")

    api = Api(args.base_url)
    options = Options(
        force=args.force,
        segment=args.segment,
        upload_wait=Waiter(args.timeout),
        segment_wait=Waiter(args.segment_timeout, interval=5),
    )
    try:
        api.login(args.username, args.password)
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    failures = 0
    for path in samples:
        try:
            seed_one(api, path, options)
        except ApiError as exc:
            failures += 1
            print(f"SAMPLE-{path.parent.name.upper()}: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
