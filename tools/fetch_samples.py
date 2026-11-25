#!/usr/bin/env python3
"""Download sample CT volumes from the TotalSegmentator small subset without fetching the archive.

The subset is one 3.2 GB ZIP on Zenodo (record 10047263, CC BY 4.0). This script reads the ZIP
central directory with HTTP Range requests and extracts only the chosen members, so a run
transfers a few hundred MB instead of the whole archive. Each subject's row of the dataset's
meta.csv is saved next to its CT as `meta.json` (seed_samples.py describes the sample with it).

    python tools/fetch_samples.py                  # default subjects -> data/samples/<id>/ct.nii.gz
    python tools/fetch_samples.py --list           # every subject with its study type and CT size
    python tools/fetch_samples.py --subjects s0058 s0513 --dest /tmp/samples

Standard library only (Python 3.12+).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

ARCHIVE_URL = (
    "https://zenodo.org/records/10047263/files/Totalsegmentator_dataset_small_v201.zip?download=1"
)
RECORD_URL = "https://zenodo.org/records/10047263"
DATASET_DOI = "10.5281/zenodo.10047263"
PAPER_DOI = "10.1148/ryai.230024"

# Chosen with --list: together they cover chest and abdomen, and each CT is well under 150 MB.
DEFAULT_SUBJECTS = ("s0011", "s0965")
MAX_MEMBER_BYTES = 150 * 1024 * 1024
DEFAULT_DEST = Path(__file__).resolve().parents[1] / "data" / "samples"

USER_AGENT = "medimg-fetch-samples/1.0 (+https://github.com/MinhChien3980/medimg)"
CHUNK = 1024 * 1024

_EOCD = struct.Struct("<4s4H2IH")
_EOCD_SIG = b"PK\x05\x06"
_ZIP64_LOCATOR = struct.Struct("<4sIQI")
_ZIP64_LOCATOR_SIG = b"PK\x06\x07"
_ZIP64_EOCD = struct.Struct("<4sQ2H2I4Q")
_ZIP64_EOCD_SIG = b"PK\x06\x06"
_CENTRAL = struct.Struct("<4s6H3I5H2I")
_CENTRAL_SIG = b"PK\x01\x02"
_LOCAL = struct.Struct("<4s5H3I2H")
_LOCAL_SIG = b"PK\x03\x04"
_MAX_EOCD_SEARCH = _EOCD.size + 0xFFFF  # the EOCD comment is at most 64 KiB

STORED, DEFLATED = 0, 8


class ZipFormatError(Exception):
    """The archive does not look like what the ZIP specification says it should."""


class RangeSource(Protocol):
    """Random access to a remote (or in-memory) byte string."""

    @property
    def size(self) -> int: ...

    def read(self, offset: int, length: int) -> bytes: ...

    def stream(self, offset: int, length: int) -> Iterator[bytes]: ...


class BytesSource:
    """In-memory RangeSource (tests, small archives)."""

    def __init__(self, data: bytes) -> None:
        self._data = data

    @property
    def size(self) -> int:
        return len(self._data)

    def read(self, offset: int, length: int) -> bytes:
        if offset < 0 or offset + length > len(self._data):
            raise ZipFormatError(f"read past end: {offset}+{length} > {len(self._data)}")
        return self._data[offset : offset + length]

    def stream(self, offset: int, length: int) -> Iterator[bytes]:
        for start in range(offset, offset + length, CHUNK):
            yield self.read(start, min(CHUNK, offset + length - start))


_CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+|\*)")


class HttpRangeSource:
    """RangeSource over HTTP(S) `Range` requests; a server that ignores Range is an error."""

    def __init__(self, url: str, timeout: float = 60.0, retries: int = 4) -> None:
        self.url = url
        self.timeout = timeout
        self.retries = retries
        self._size: int | None = None

    @property
    def size(self) -> int:
        if self._size is None:
            with self._open(0, 1) as response:
                self._size = self._check_range(response, 0)[1]
        return self._size

    def read(self, offset: int, length: int) -> bytes:
        return b"".join(self.stream(offset, length))

    def stream(self, offset: int, length: int) -> Iterator[bytes]:
        """Yield `length` bytes from `offset`, resuming with a new request after a network error."""
        position, end = offset, offset + length
        failures = 0
        while position < end:
            try:
                with self._open(position, end - position) as response:
                    self._check_range(response, position)
                    while position < end:
                        block = response.read(min(CHUNK, end - position))
                        if not block:
                            raise ConnectionError("connection closed before the range ended")
                        position += len(block)
                        failures = 0
                        yield block
            except (OSError, urllib.error.URLError) as exc:
                failures += 1
                if failures > self.retries:
                    raise
                delay = 2**failures
                print(f"  network error ({exc}), retrying in {delay} s", file=sys.stderr)
                time.sleep(delay)

    def _open(self, offset: int, length: int):
        request = urllib.request.Request(
            self.url,
            headers={"Range": f"bytes={offset}-{offset + length - 1}", "User-Agent": USER_AGENT},
        )
        return urllib.request.urlopen(request, timeout=self.timeout)

    @staticmethod
    def _check_range(response, offset: int) -> tuple[int, int]:
        if response.status != 206:
            raise ZipFormatError(f"server ignored the Range header (HTTP {response.status})")
        match = _CONTENT_RANGE.fullmatch(response.headers.get("Content-Range", ""))
        if not match or int(match.group(1)) != offset or match.group(3) == "*":
            raise ZipFormatError(
                f"unexpected Content-Range: {response.headers.get('Content-Range')}"
            )
        return int(match.group(1)), int(match.group(3))


@dataclass(frozen=True)
class ZipEntry:
    name: str
    method: int
    flags: int
    crc32: int
    compressed_size: int
    uncompressed_size: int
    header_offset: int


@dataclass(frozen=True)
class CentralDirectory:
    offset: int
    size: int
    count: int


def locate_central_directory(source: RangeSource) -> CentralDirectory:
    """Find the (ZIP64) end-of-central-directory record in the archive tail."""
    tail_len = min(source.size, _MAX_EOCD_SEARCH)
    tail_start = source.size - tail_len
    tail = source.read(tail_start, tail_len)
    pos = tail.rfind(_EOCD_SIG)
    while pos >= 0 and pos + _EOCD.size <= len(tail):
        fields = _EOCD.unpack_from(tail, pos)
        if pos + _EOCD.size + fields[7] == len(tail):  # comment runs to the end of the file
            break
        pos = tail.rfind(_EOCD_SIG, 0, pos)
    else:
        raise ZipFormatError("end of central directory record not found")
    _, disk, cd_disk, _, count, cd_size, cd_offset, _ = fields
    if disk != 0 or cd_disk != 0:
        raise ZipFormatError("multi-disk archives are not supported")
    if count != 0xFFFF and cd_size != 0xFFFFFFFF and cd_offset != 0xFFFFFFFF:
        return CentralDirectory(offset=cd_offset, size=cd_size, count=count)

    locator_pos = pos - _ZIP64_LOCATOR.size
    if locator_pos < 0:
        raise ZipFormatError("ZIP64 locator missing")
    sig, _, eocd64_offset, _ = _ZIP64_LOCATOR.unpack_from(tail, locator_pos)
    if sig != _ZIP64_LOCATOR_SIG:
        raise ZipFormatError("ZIP64 locator missing")
    record = source.read(eocd64_offset, _ZIP64_EOCD.size)
    sig, _, _, _, _, _, _, count64, cd_size64, cd_offset64 = _ZIP64_EOCD.unpack(record)
    if sig != _ZIP64_EOCD_SIG:
        raise ZipFormatError("ZIP64 end of central directory record not found")
    return CentralDirectory(offset=cd_offset64, size=cd_size64, count=count64)


def _zip64_values(extra: bytes, needed: list[str]) -> dict[str, int]:
    """Read the ZIP64 extended information extra field (id 0x0001). Only the fields whose
    32-bit value is saturated are present, in the order usize, csize, offset."""
    pos = 0
    while pos + 4 <= len(extra):
        header_id, size = struct.unpack_from("<HH", extra, pos)
        if header_id == 0x0001:
            values = struct.unpack_from(f"<{len(needed)}Q", extra, pos + 4)
            return dict(zip(needed, values, strict=True))
        pos += 4 + size
    raise ZipFormatError("ZIP64 extra field missing")


def parse_central_directory(data: bytes, count: int) -> list[ZipEntry]:
    entries: list[ZipEntry] = []
    pos = 0
    for _ in range(count):
        if data[pos : pos + 4] != _CENTRAL_SIG:
            raise ZipFormatError(f"bad central directory entry at +{pos}")
        fields = _CENTRAL.unpack_from(data, pos)
        flags, method = fields[3], fields[4]
        crc, csize, usize = fields[7:10]
        name_len, extra_len, comment_len = fields[10:13]
        offset = fields[16]
        name_raw = data[pos + _CENTRAL.size : pos + _CENTRAL.size + name_len]
        extra = data[pos + _CENTRAL.size + name_len : pos + _CENTRAL.size + name_len + extra_len]
        needed = [
            key
            for key, value in (("usize", usize), ("csize", csize), ("offset", offset))
            if value == 0xFFFFFFFF
        ]
        if needed:
            big = _zip64_values(extra, needed)
            usize = big.get("usize", usize)
            csize = big.get("csize", csize)
            offset = big.get("offset", offset)
        name = name_raw.decode("utf-8" if flags & 0x800 else "cp437")
        entries.append(ZipEntry(name, method, flags, crc, csize, usize, offset))
        pos += _CENTRAL.size + name_len + extra_len + comment_len
    return entries


def read_entries(source: RangeSource) -> list[ZipEntry]:
    directory = locate_central_directory(source)
    return parse_central_directory(source.read(directory.offset, directory.size), directory.count)


def data_offset(source: RangeSource, entry: ZipEntry) -> int:
    """Offset of the member's data: its local header has its own name/extra lengths."""
    header = source.read(entry.header_offset, _LOCAL.size)
    sig, *_, name_len, extra_len = _LOCAL.unpack(header)
    if sig != _LOCAL_SIG:
        raise ZipFormatError(f"bad local header for {entry.name}")
    return entry.header_offset + _LOCAL.size + name_len + extra_len


def iter_member(source: RangeSource, entry: ZipEntry) -> Iterator[bytes]:
    """Yield the decompressed bytes of one member, checking its size and CRC-32."""
    if entry.flags & 0x1:
        raise ZipFormatError(f"{entry.name} is encrypted")
    if entry.method not in (STORED, DEFLATED):
        raise ZipFormatError(f"{entry.name}: unsupported compression method {entry.method}")
    inflater = zlib.decompressobj(-zlib.MAX_WBITS) if entry.method == DEFLATED else None
    crc, produced = 0, 0
    for block in source.stream(data_offset(source, entry), entry.compressed_size):
        out = inflater.decompress(block) if inflater else block
        if out:
            crc = zlib.crc32(out, crc)
            produced += len(out)
            if produced > entry.uncompressed_size:
                raise ZipFormatError(f"{entry.name} is larger than its declared size")
            yield out
    if inflater:
        out = inflater.flush()
        if out:
            crc = zlib.crc32(out, crc)
            produced += len(out)
            yield out
    if produced != entry.uncompressed_size or crc != entry.crc32:
        raise ZipFormatError(f"{entry.name}: size or CRC-32 mismatch")


def extract_member(source: RangeSource, entry: ZipEntry, dest: Path) -> None:
    """Write the member to `dest` atomically (a partial file never has the final name)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".part")
    try:
        with partial.open("wb") as out:
            for block in iter_member(source, entry):
                out.write(block)
        partial.replace(dest)
    finally:
        partial.unlink(missing_ok=True)


def read_member(source: RangeSource, entry: ZipEntry) -> bytes:
    return b"".join(iter_member(source, entry))


# ---------------------------------------------------------------------- dataset layout


@dataclass(frozen=True)
class Subject:
    subject_id: str
    ct: ZipEntry
    meta: dict[str, str]


def _strip_root(name: str) -> str:
    """Archive members may sit under one top-level folder; drop it."""
    parts = name.split("/")
    return "/".join(parts[1:]) if len(parts) > 1 and not re.fullmatch(r"s\d{4}", parts[0]) else name


def index_subjects(source: RangeSource, entries: list[ZipEntry]) -> dict[str, Subject]:
    by_name = {_strip_root(e.name): e for e in entries}
    meta_rows: dict[str, dict[str, str]] = {}
    if "meta.csv" in by_name:
        text = read_member(source, by_name["meta.csv"]).decode("utf-8-sig")
        dialect = csv.Sniffer().sniff(text.splitlines()[0], delimiters=";,")
        for row in csv.DictReader(io.StringIO(text), dialect=dialect):
            meta_rows[row.get("image_id", "")] = row
    subjects: dict[str, Subject] = {}
    for name, entry in by_name.items():
        match = re.fullmatch(r"(s\d{4})/ct\.nii\.gz", name)
        if match:
            sid = match.group(1)
            subjects[sid] = Subject(sid, entry, meta_rows.get(sid, {}))
    return subjects


def write_meta(subject: Subject, dest: Path) -> Path:
    """The subject's meta.csv row as `<dest>/<id>/meta.json` (seed_samples.py builds the sample's
    title and description from it)."""
    path = dest / subject.subject_id / "meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(subject.meta, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return path


def attribution(subjects: list[Subject]) -> str:
    lines = [
        "# Sample data attribution",
        "",
        "The CT volumes in this folder are unmodified `ct.nii.gz` files from the",
        "**Small subset of the TotalSegmentator dataset** (v2.0.1), downloaded from Zenodo by",
        "`tools/fetch_samples.py`.",
        "",
        f"- Record: {RECORD_URL} (DOI [{DATASET_DOI}](https://doi.org/{DATASET_DOI}))",
        "- License: [Creative Commons Attribution 4.0 International (CC BY 4.0)]"
        "(https://creativecommons.org/licenses/by/4.0/)",
        "- Citation: Wasserthal J, Breit H-C, Meyer MT, et al. TotalSegmentator: Robust "
        "Segmentation of 104 Anatomic Structures in CT Images. *Radiology: Artificial "
        f"Intelligence* 2023;5(5):e230024. DOI [{PAPER_DOI}](https://doi.org/{PAPER_DOI})",
        "",
        "| Subject | Study type | Size |",
        "| --- | --- | --- |",
    ]
    for s in subjects:
        study = s.meta.get("study_type", "") or "-"
        lines.append(f"| {s.subject_id} | {study} | {s.ct.uncompressed_size / 1e6:.1f} MB |")
    lines += ["", "These files are not part of the repository (`data/` is git-ignored).", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--subjects", nargs="+", default=list(DEFAULT_SUBJECTS), metavar="ID")
    parser.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    parser.add_argument("--url", default=ARCHIVE_URL)
    parser.add_argument("--list", action="store_true", help="list subjects and exit")
    args = parser.parse_args(argv)

    source = HttpRangeSource(args.url)
    print(f"reading the central directory of {args.url} ({source.size / 1e9:.2f} GB)")
    subjects = index_subjects(source, read_entries(source))
    if args.list:
        for sid in sorted(subjects):
            s = subjects[sid]
            print(f"{sid}  {s.ct.uncompressed_size / 1e6:7.1f} MB  {s.meta.get('study_type', '')}")
        return 0

    missing = [sid for sid in args.subjects if sid not in subjects]
    if missing:
        parser.error(f"not in the archive: {', '.join(missing)}")
    chosen = [subjects[sid] for sid in args.subjects]
    for s in chosen:
        if s.ct.uncompressed_size > MAX_MEMBER_BYTES:
            parser.error(f"{s.subject_id} is {s.ct.uncompressed_size / 1e6:.0f} MB (> 150 MB)")

    for s in chosen:
        dest = args.dest / s.subject_id / "ct.nii.gz"
        write_meta(s, args.dest)
        if dest.exists() and dest.stat().st_size == s.ct.uncompressed_size:
            print(f"{s.subject_id}: already present ({dest})")
            continue
        print(f"{s.subject_id}: downloading {s.ct.compressed_size / 1e6:.1f} MB -> {dest}")
        extract_member(source, s.ct, dest)
    (args.dest / "ATTRIBUTION.md").write_text(attribution(chosen), encoding="utf-8")
    print(f"wrote {args.dest / 'ATTRIBUTION.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
