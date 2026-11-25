"""Zip-over-HTTP-Range reader. Run from `tools/`: python -m unittest discover -s tests"""

from __future__ import annotations

import io
import struct
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import fetch_samples as fs

CT = bytes(range(256)) * 400  # compressible, 100 KiB


def make_zip(root: str = "Totalsegmentator_dataset_small_v201/") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(f"{root}meta.csv", "image_id;age;study_type\ns0001;60;ct thorax\n")
        zf.writestr(f"{root}s0001/ct.nii.gz", CT, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr(f"{root}s0001/segmentations/liver.nii.gz", b"x" * 10)
        zf.writestr(f"{root}s0002/ct.nii.gz", b"stored ct", compress_type=zipfile.ZIP_STORED)
    return buf.getvalue()


def as_zip64(data: bytes) -> bytes:
    """Rewrite the end of a small archive the way large ones look: saturated EOCD fields and a
    ZIP64 end-of-central-directory record + locator in front of it."""
    eocd_at = data.rindex(fs._EOCD_SIG)
    _, _, _, n_disk, count, cd_size, cd_offset, _ = fs._EOCD.unpack_from(data, eocd_at)
    body = data[:eocd_at]
    record = fs._ZIP64_EOCD.pack(
        fs._ZIP64_EOCD_SIG,
        fs._ZIP64_EOCD.size - 12,
        45,
        45,
        0,
        0,
        n_disk,
        count,
        cd_size,
        cd_offset,
    )
    locator = fs._ZIP64_LOCATOR.pack(fs._ZIP64_LOCATOR_SIG, 0, len(body), 1)
    eocd = fs._EOCD.pack(fs._EOCD_SIG, 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)
    return body + record + locator + eocd


class CentralDirectoryTest(unittest.TestCase):
    def test_lists_entries_with_sizes_and_offsets(self):
        data = make_zip()
        entries = fs.read_entries(fs.BytesSource(data))
        reference = zipfile.ZipFile(io.BytesIO(data)).infolist()
        self.assertEqual([e.name for e in entries], [i.filename for i in reference])
        for entry, info in zip(entries, reference, strict=True):
            self.assertEqual(entry.header_offset, info.header_offset)
            self.assertEqual(entry.compressed_size, info.compress_size)
            self.assertEqual(entry.uncompressed_size, info.file_size)
            self.assertEqual(entry.crc32, info.CRC)

    def test_reads_zip64_end_records(self):
        entries = fs.read_entries(fs.BytesSource(as_zip64(make_zip())))
        self.assertEqual(len(entries), 4)

    def test_archive_comment_is_skipped(self):
        buf = io.BytesIO(make_zip())
        with zipfile.ZipFile(buf, "a") as zf:
            zf.comment = b"PK\x05\x06 looks like an EOCD but is a comment"
        self.assertEqual(len(fs.read_entries(fs.BytesSource(buf.getvalue()))), 4)

    def test_zip64_extra_field_values(self):
        extra = struct.pack("<HHQQ", 0x0001, 16, 5_000_000_000, 6_000_000_000)
        values = fs._zip64_values(b"\x0a\x00\x04\x00abcd" + extra, ["usize", "offset"])
        self.assertEqual(values, {"usize": 5_000_000_000, "offset": 6_000_000_000})

    def test_not_a_zip(self):
        with self.assertRaises(fs.ZipFormatError):
            fs.read_entries(fs.BytesSource(b"no zip here" * 10))


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.data = make_zip()
        self.source = fs.BytesSource(self.data)
        self.entries = {e.name.split("/", 1)[1]: e for e in fs.read_entries(self.source)}

    def test_deflated_and_stored_members(self):
        self.assertEqual(fs.read_member(self.source, self.entries["s0001/ct.nii.gz"]), CT)
        self.assertEqual(fs.read_member(self.source, self.entries["s0002/ct.nii.gz"]), b"stored ct")

    def test_extract_writes_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "s0001" / "ct.nii.gz"
            fs.extract_member(self.source, self.entries["s0001/ct.nii.gz"], dest)
            self.assertEqual(dest.read_bytes(), CT)
            self.assertEqual(list(dest.parent.iterdir()), [dest])

    def test_crc_mismatch_is_detected_and_leaves_no_file(self):
        entry = self.entries["s0002/ct.nii.gz"]
        offset = fs.data_offset(self.source, entry)
        broken = bytearray(self.data)
        broken[offset] ^= 0xFF
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "ct.nii.gz"
            with self.assertRaises(fs.ZipFormatError):
                fs.extract_member(fs.BytesSource(bytes(broken)), entry, dest)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_index_subjects_reads_meta_csv(self):
        subjects = fs.index_subjects(self.source, list(self.entries.values()))
        self.assertEqual(sorted(subjects), ["s0001", "s0002"])
        self.assertEqual(subjects["s0001"].meta["study_type"], "ct thorax")
        self.assertEqual(subjects["s0002"].meta, {})

    def test_attribution_cites_license_and_paper(self):
        subjects = fs.index_subjects(self.source, list(self.entries.values()))
        text = fs.attribution([subjects["s0001"]])
        self.assertIn("CC BY 4.0", text)
        self.assertIn("10.1148/ryai.230024", text)
        self.assertIn("10.5281/zenodo.10047263", text)
        self.assertIn("| s0001 | ct thorax |", text)


class _RangeHandler(BaseHTTPRequestHandler):
    payload = b""
    honour_range = True

    def do_GET(self):
        spec = self.headers.get("Range", "")
        if not self.honour_range or not spec.startswith("bytes="):
            self.send_response(200)
            self.send_header("Content-Length", str(len(self.payload)))
            self.end_headers()
            self.wfile.write(self.payload)
            return
        start, end = (int(v) for v in spec[len("bytes=") :].split("-"))
        body = self.payload[start : end + 1]
        self.send_response(206)
        self.send_header(
            "Content-Range", f"bytes {start}-{start + len(body) - 1}/{len(self.payload)}"
        )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class HttpRangeSourceTest(unittest.TestCase):
    def serve(self, honour_range: bool) -> str:
        handler = type("H", (_RangeHandler,), {"payload": make_zip(), "honour_range": honour_range})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/archive.zip"

    def test_extracts_over_http_ranges(self):
        source = fs.HttpRangeSource(self.serve(honour_range=True), retries=0)
        self.assertEqual(source.size, len(make_zip()))
        entries = {e.name.split("/", 1)[1]: e for e in fs.read_entries(source)}
        self.assertEqual(fs.read_member(source, entries["s0001/ct.nii.gz"]), CT)

    def test_server_ignoring_range_is_an_error(self):
        source = fs.HttpRangeSource(self.serve(honour_range=False), retries=0)
        with self.assertRaises(fs.ZipFormatError):
            _ = source.size


if __name__ == "__main__":
    unittest.main()
