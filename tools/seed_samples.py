#!/usr/bin/env python3
"""Upload the sample CT volumes (see fetch_samples.py) into a running stack through its REST API.

For every `data/samples/<id>/ct.nii.gz`: log in, create the case `SAMPLE-<ID>` (or reuse it),
upload the file with `/api/v1/uploads/init` + presigned PUT + `complete`, and wait until the
server has turned it into a study.

    python tools/seed_samples.py                                 # http://localhost:8088, admin
    python tools/seed_samples.py --base-url http://localhost:8080 --username doctor

Cases that already have a study are skipped unless --force is given. Standard library only.
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
from pathlib import Path
from typing import Any

DEFAULT_BASE = "http://localhost:8088"
DEFAULT_SAMPLES = Path(__file__).resolve().parents[1] / "data" / "samples"
CONTENT_TYPE = "application/gzip"
TERMINAL = {"DONE", "FAILED"}


class ApiError(Exception):
    pass


class Api:
    def __init__(self, base_url: str, timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.token: str | None = None

    def call(self, method: str, path: str, body: Any = None, query: dict | None = None) -> Any:
        url = f"{self.base_url}/api/v1{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
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


def find_or_create_case(api: Api, code: str, note: str) -> dict[str, Any]:
    page = api.call("GET", "/patients", query={"q": code, "size": 50})
    for patient in page.get("content", []):
        if patient.get("code") == code:
            return patient
    return api.call("POST", "/patients", {"code": code, "note": note})


def upload(api: Api, patient_id: str, path: Path, timeout: float) -> dict[str, Any]:
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
    status = api.call("POST", f"/uploads/{upload_id}/complete")
    deadline = time.monotonic() + timeout
    shown = None
    while status["status"] not in TERMINAL:
        if time.monotonic() > deadline:
            raise ApiError(f"upload {upload_id} still {status['status']} after {timeout:.0f} s")
        now = (status["status"], status.get("progress"))
        if now != shown:
            print(f"    {status['status']} {status.get('progress', 0)}%", flush=True)
            shown = now
        time.sleep(2)
        status = api.call("GET", f"/uploads/{upload_id}")
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default=os.environ.get("DEMO_PASSWORD", "Demo@12345"))
    parser.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    parser.add_argument("--timeout", type=float, default=600, help="seconds per upload")
    parser.add_argument("--force", action="store_true", help="upload even if the case has a study")
    args = parser.parse_args(argv)

    samples = sorted(p for p in args.samples.glob("*/ct.nii.gz"))
    if not samples:
        parser.error(f"no samples in {args.samples}; run tools/fetch_samples.py first")

    api = Api(args.base_url)
    try:
        api.login(args.username, args.password)
        failures = 0
        for path in samples:
            sid = path.parent.name
            code = f"SAMPLE-{sid.upper()}"
            case = find_or_create_case(
                api, code, f"TotalSegmentator sample {sid} (CC BY 4.0, Wasserthal et al. 2023)"
            )
            if case.get("studyCount", 0) and not args.force:
                print(f"{code}: already has a study, skipped")
                continue
            print(f"{code}: uploading {path.stat().st_size / 1e6:.1f} MB")
            result = upload(api, case["id"], path, args.timeout)
            if result["status"] == "DONE":
                print(f"{code}: DONE, study {result['studyId']}")
            else:
                failures += 1
                print(f"{code}: FAILED: {result.get('error')}", file=sys.stderr)
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
