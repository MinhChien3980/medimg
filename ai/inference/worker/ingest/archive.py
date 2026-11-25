"""Defensive ZIP extraction for uploaded DICOM series.

Archive member names never reach the file system: members are written as `00000`, `00001`, ...
in a fresh directory. Names are still checked, and an archive with a path-traversal name is
rejected as a whole: it is either broken or hostile. The size limit is checked on the sizes
declared in the central directory; `zipfile` never inflates a member past its declared size and
verifies its CRC-32, so the declared total bounds what reaches the disk.
"""

from __future__ import annotations

import re
import shutil
import stat
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from worker.errors import BadInputError

ZIP_MAGIC = b"PK\x03\x04"
CHUNK = 1024 * 1024


@dataclass(frozen=True)
class ZipLimits:
    max_entries: int = 2_000
    max_total_bytes: int = 2 * 1024**3


def _unsafe_name(name: str) -> bool:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return True
    return ".." in PurePosixPath(normalized).parts


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def extract_members(archive: Path, dest: Path, limits: ZipLimits | None = None) -> list[Path]:
    """Extract every regular file of `archive` into `dest`; returns the written paths."""
    limits = limits or ZipLimits()
    try:
        zf = zipfile.ZipFile(archive)
    except (zipfile.BadZipFile, OSError) as exc:
        raise BadInputError(f"not a valid ZIP archive: {exc}") from exc

    with zf:
        infos = zf.infolist()
        if len(infos) > limits.max_entries:
            raise BadInputError(
                f"ZIP has {len(infos)} entries; at most {limits.max_entries} are accepted"
            )
        declared = sum(i.file_size for i in infos)
        if declared > limits.max_total_bytes:
            raise BadInputError(
                f"ZIP expands to {declared / 1024**3:.1f} GiB; at most "
                f"{limits.max_total_bytes / 1024**3:.0f} GiB are accepted"
            )
        for info in infos:
            if _unsafe_name(info.filename):
                raise BadInputError(f"ZIP entry has an unsafe path: {info.filename!r}")
            if _is_symlink(info):
                raise BadInputError(f"ZIP entry is a symbolic link: {info.filename!r}")
            if info.flag_bits & 0x1:
                raise BadInputError("encrypted ZIP archives are not supported")
            if not info.is_dir() and info.filename.lower().endswith(".zip"):
                raise BadInputError(f"nested ZIP archives are not supported: {info.filename!r}")

        dest.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []
        for info in infos:
            if info.is_dir():
                continue
            path = dest / f"{len(written):05d}"
            try:
                with zf.open(info) as src, path.open("wb") as out:
                    head = src.read(len(ZIP_MAGIC))
                    if head == ZIP_MAGIC:
                        raise BadInputError(
                            f"nested ZIP archives are not supported: {info.filename!r}"
                        )
                    out.write(head)
                    shutil.copyfileobj(src, out, CHUNK)
            except (
                zipfile.BadZipFile,
                zipfile.LargeZipFile,
                zlib.error,
                NotImplementedError,
                EOFError,
            ) as exc:
                raise BadInputError(f"corrupt ZIP entry {info.filename!r}: {exc}") from exc
            except RuntimeError as exc:  # e.g. password required
                raise BadInputError(f"cannot read ZIP entry {info.filename!r}: {exc}") from exc
            written.append(path)
        return written
