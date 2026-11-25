"""seed_samples.py without a server: sample descriptions and the API flow against a fake API.

Run from `tools/`: python -m unittest discover -s tests
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

import seed_samples as ss

META = {
    "image_id": "s0011",
    "age": "63",
    "gender": "f",
    "institute": "B",
    "study_type": "ct neck-thorax-abdomen-pelvis",
    "split": "train",
    "manufacturer": "Siemens",
    "scanner_model": "SOMATOM Definition AS+",
    "kvp": "120",
    "pathology": "no_pathology",
    "pathology_location": "",
}


class SampleInfoTest(unittest.TestCase):
    def test_title_and_description_from_meta(self):
        info = ss.sample_info("s0011", META)
        self.assertEqual(info["title"], "CT neck-thorax-abdomen-pelvis (s0011)")
        self.assertEqual(
            info["description"],
            "63-year-old female patient. Scanner: Siemens SOMATOM Definition AS+, 120 kVp. "
            "Subject s0011 of the TotalSegmentator small subset.",
        )
        self.assertEqual(
            info["source"],
            "TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0, Wasserthal et al. 2023",
        )

    def test_pathology_and_lower_case_scanner(self):
        # as in the dataset's meta.csv for s0011
        meta = {
            **META,
            "pathology": "tumor",
            "pathology_location": "thorax,abdomen,pelvis",
            "manufacturer": "siemens",
            "scanner_model": "emotion 16",
        }
        self.assertIn(
            "Pathology: tumor (thorax, abdomen, pelvis). Scanner: Siemens Emotion 16, 120 kVp.",
            ss.sample_info("s0011", meta)["description"],
        )

    def test_without_meta(self):
        info = ss.sample_info("s0965", {})
        self.assertEqual(info["title"], "CT scan (s0965)")
        self.assertEqual(info["description"], "Subject s0965 of the TotalSegmentator small subset.")

    def test_lengths_fit_the_api_limits(self):
        long = {**META, "study_type": "ct " + "x" * 300, "scanner_model": "y" * 600}
        info = ss.sample_info("s0001", long)
        self.assertLessEqual(len(info["title"]), 120)
        self.assertLessEqual(len(info["description"]), 500)
        self.assertTrue(info["title"].endswith("…"))

    def test_load_meta(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            self.assertEqual(ss.load_meta(folder), {})
            (folder / "meta.json").write_text(json.dumps({"age": 63}), encoding="utf-8")
            self.assertEqual(ss.load_meta(folder), {"age": "63"})
            (folder / "meta.json").write_text("not json", encoding="utf-8")
            self.assertEqual(ss.load_meta(folder), {})


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def sleep(self, seconds: float) -> None:
        self.now += seconds

    def __call__(self) -> float:
        return self.now


class Seq:
    """Successive answers of one route; the last one repeats."""

    def __init__(self, *values: Any) -> None:
        self.values = list(values)

    def next(self) -> Any:
        return self.values.pop(0) if len(self.values) > 1 else self.values[0]


class FakeApi:
    """Records calls; answers from `routes`: (method, path) -> value or Seq."""

    def __init__(self, routes: dict[tuple[str, str], Any]) -> None:
        self.routes = routes
        self.calls: list[tuple[str, str, Any, dict | None]] = []

    def call(self, method, path, body=None, query=None, headers=None):
        self.calls.append((method, path, body, headers))
        value = self.routes[(method, path)]
        return value.next() if isinstance(value, Seq) else value

    def put_file(self, url, path):
        self.calls.append(("PUT-FILE", url, path.name, None))

    def paths(self, method: str) -> list[str]:
        return [path for m, path, _, _ in self.calls if m == method]


STUDY = {"id": "st1", "series": [{"id": "se1", "volumeUrl": "/medimg/v.nii.gz"}]}


def job(status: str, progress: int = 0, **extra: Any) -> dict[str, Any]:
    return {
        "jobId": "j1",
        "status": status,
        "progress": progress,
        "model": {"code": "ct-totalseg"},
        **extra,
    }


def waiter(timeout: float = 100) -> ss.Waiter:
    clock = FakeClock()
    return ss.Waiter(timeout, interval=5, sleep=clock.sleep, clock=clock)


class SegmentTest(unittest.TestCase):
    def run_segment(self, api: FakeApi, timeout: float = 100):
        with redirect_stdout(io.StringIO()):
            return ss.segment(api, STUDY, waiter(timeout))

    def test_creates_a_job_and_waits_for_done(self):
        api = FakeApi(
            {
                ("GET", "/studies/st1/predictions"): [],
                ("POST", "/predictions"): {"jobId": "j1", "status": "QUEUED"},
                ("GET", "/predictions/j1"): Seq(
                    job("QUEUED"), job("RUNNING", 20), job("DONE", 100, findings=[{}, {}])
                ),
            }
        )
        result = self.run_segment(api)
        self.assertEqual(result["status"], "DONE")
        _, _, body, headers = next(c for c in api.calls if c[0] == "POST")
        self.assertEqual(body, {"studyId": "st1", "seriesId": "se1", "modelCode": "ct-totalseg"})
        self.assertEqual(headers, {"Idempotency-Key": "seed-ct-totalseg-se1"})
        self.assertEqual(api.paths("GET").count("/predictions/j1"), 3)

    def test_already_segmented_study_is_skipped(self):
        other = {**job("DONE"), "model": {"code": "cxr-multilabel"}}
        api = FakeApi({("GET", "/studies/st1/predictions"): [job("FAILED"), job("DONE"), other]})
        self.assertIsNone(self.run_segment(api))
        self.assertEqual(api.paths("POST"), [])

    def test_waits_for_a_job_already_running(self):
        api = FakeApi(
            {
                ("GET", "/studies/st1/predictions"): [job("RUNNING", 40)],
                ("GET", "/predictions/j1"): Seq(job("RUNNING", 60), job("DONE", 100)),
            }
        )
        self.assertEqual(self.run_segment(api)["status"], "DONE")
        self.assertEqual(api.paths("POST"), [])

    def test_failed_job_is_an_error(self):
        api = FakeApi(
            {
                ("GET", "/studies/st1/predictions"): [],
                ("POST", "/predictions"): {"jobId": "j1"},
                ("GET", "/predictions/j1"): job("FAILED", error="out of memory"),
            }
        )
        with self.assertRaisesRegex(ss.ApiError, "j1 FAILED: out of memory"):
            self.run_segment(api)

    def test_timeout(self):
        api = FakeApi(
            {
                ("GET", "/studies/st1/predictions"): [],
                ("POST", "/predictions"): {"jobId": "j1"},
                ("GET", "/predictions/j1"): job("RUNNING", 50),
            }
        )
        with self.assertRaisesRegex(ss.ApiError, "still RUNNING after 30 s"):
            self.run_segment(api, timeout=30)


class SeedOneTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ct = Path(tmp.name) / "s0011" / "ct.nii.gz"
        self.ct.parent.mkdir()
        self.ct.write_bytes(b"\x1f\x8b fake ct")
        (self.ct.parent / "meta.json").write_text(json.dumps(META), encoding="utf-8")

    def seed(self, api: FakeApi, **options: Any) -> None:
        opts = ss.Options(upload_wait=waiter(), segment_wait=waiter(), **options)
        with redirect_stdout(io.StringIO()):
            ss.seed_one(api, self.ct, opts)

    def test_new_case_is_uploaded_marked_and_segmented(self):
        api = FakeApi(
            {
                ("GET", "/patients"): {"content": []},
                ("POST", "/patients"): {"id": "p1", "code": "SAMPLE-S0011", "studyCount": 0},
                ("POST", "/uploads/init"): {"uploadId": "u1", "files": [{"putUrl": "/medimg/x"}]},
                ("POST", "/uploads/u1/complete"): {"status": "PROCESSING", "progress": 10},
                ("GET", "/uploads/u1"): {"status": "DONE", "studyId": "st1"},
                ("GET", "/studies/st1"): STUDY,
                ("PUT", "/patients/p1/sample"): None,
                ("GET", "/studies/st1/predictions"): [],
                ("POST", "/predictions"): {"jobId": "j1"},
                ("GET", "/predictions/j1"): job("DONE", 100),
            }
        )
        self.seed(api, segment=True)
        methods = [(m, p) for m, p, _, _ in api.calls]
        self.assertLess(
            methods.index(("GET", "/uploads/u1")), methods.index(("PUT", "/patients/p1/sample"))
        )
        self.assertLess(
            methods.index(("PUT", "/patients/p1/sample")), methods.index(("POST", "/predictions"))
        )
        mark = next(body for m, p, body, _ in api.calls if m == "PUT")
        self.assertEqual(mark, ss.sample_info("s0011", META))

    def test_existing_study_is_marked_without_uploading(self):
        api = FakeApi(
            {
                ("GET", "/patients"): {
                    "content": [{"id": "p1", "code": "SAMPLE-S0011", "studyCount": 1}]
                },
                ("GET", "/patients/p1/studies"): [{"id": "old", "series": [{"id": "x"}]}, STUDY],
                ("PUT", "/patients/p1/sample"): None,
            }
        )
        self.seed(api)
        self.assertEqual(api.paths("POST"), [])
        self.assertEqual(api.paths("PUT"), ["/patients/p1/sample"])

    def test_failed_upload_is_an_error_and_nothing_is_marked(self):
        api = FakeApi(
            {
                ("GET", "/patients"): {
                    "content": [{"id": "p1", "code": "SAMPLE-S0011", "studyCount": 0}]
                },
                ("POST", "/uploads/init"): {"uploadId": "u1", "files": [{"putUrl": "/medimg/x"}]},
                ("POST", "/uploads/u1/complete"): {"status": "FAILED", "error": "bad file"},
            }
        )
        with self.assertRaisesRegex(ss.ApiError, "upload FAILED: bad file"):
            self.seed(api)
        self.assertEqual(api.paths("PUT"), [])


if __name__ == "__main__":
    unittest.main()
