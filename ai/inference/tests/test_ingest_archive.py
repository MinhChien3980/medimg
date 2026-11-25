from __future__ import annotations

import io
import stat
import zipfile

import pytest

from tests.volumes import zip_files
from worker.errors import BadInputError
from worker.ingest.archive import ZipLimits, extract_members, is_clutter


def write(tmp_path, data: bytes):
    path = tmp_path / "upload"
    path.write_bytes(data)
    return path


def test_extracts_regular_files_under_generated_names(tmp_path):
    archive = write(tmp_path, zip_files([("a/b/1.dcm", b"one"), ("a/2.dcm", b"two")]))
    out = extract_members(archive, tmp_path / "out")
    assert [m.path.name for m in out] == ["00000", "00001"]
    assert [m.name for m in out] == ["a/b/1.dcm", "a/2.dcm"]
    assert [m.path.read_bytes() for m in out] == [b"one", b"two"]
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["00000", "00001"]


def test_skips_macos_resource_forks_and_hidden_files(tmp_path):
    entries = [
        ("__MACOSX/scan/._1.png", b"fork"),
        ("scan/.DS_Store", b"store"),
        (".hidden/1.png", b"hidden"),
        ("scan/1.png", b"kept"),
        ("scan/.../x", b"dots"),
    ]
    out = extract_members(write(tmp_path, zip_files(entries)), tmp_path / "out")
    assert [(m.name, m.path.read_bytes()) for m in out] == [("scan/1.png", b"kept")]


@pytest.mark.parametrize(
    ("name", "clutter"),
    [
        ("__MACOSX/a.png", True),
        ("a/__MACOSX/b", True),
        (".DS_Store", True),
        ("a/._b.png", True),
        ("a/b.png", False),
        ("a.b/c.png", False),
        ("MACOSX/a.png", False),
    ],
)
def test_is_clutter(name, clutter):
    assert is_clutter(name) is clutter


@pytest.mark.parametrize(
    "name", ["../evil.dcm", "a/../../evil.dcm", "/etc/passwd", "\\\\server\\x", "C:/x.dcm"]
)
def test_rejects_zip_slip_and_absolute_paths(tmp_path, name):
    archive = write(tmp_path, zip_files([("ok.dcm", b"x"), (name, b"y")]))
    with pytest.raises(BadInputError, match="unsafe path"):
        extract_members(archive, tmp_path / "out")
    assert not (tmp_path / "evil.dcm").exists()


def test_rejects_too_many_entries(tmp_path):
    archive = write(tmp_path, zip_files((f"{i}.dcm", b"x") for i in range(6)))
    with pytest.raises(BadInputError, match="6 entries"):
        extract_members(archive, tmp_path / "out", ZipLimits(max_entries=5))


def test_rejects_archives_expanding_past_the_limit(tmp_path):
    archive = write(tmp_path, zip_files([("big.dcm", b"\0" * 10_000)]))
    with pytest.raises(BadInputError, match="expands"):
        extract_members(archive, tmp_path / "out", ZipLimits(max_total_bytes=5_000))


def test_rejects_nested_zip_by_name(tmp_path):
    archive = write(tmp_path, zip_files([("inner.ZIP", b"anything")]))
    with pytest.raises(BadInputError, match="nested ZIP"):
        extract_members(archive, tmp_path / "out")


def test_rejects_nested_zip_by_content(tmp_path):
    inner = zip_files([("x.dcm", b"x")])
    archive = write(tmp_path, zip_files([("series/disguised.dcm", inner)]))
    with pytest.raises(BadInputError, match="nested ZIP"):
        extract_members(archive, tmp_path / "out")


def test_rejects_symlinks(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        info = zipfile.ZipInfo("link.dcm")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, "/etc/passwd")
    with pytest.raises(BadInputError, match="symbolic link"):
        extract_members(write(tmp_path, buf.getvalue()), tmp_path / "out")


def test_rejects_non_zip(tmp_path):
    with pytest.raises(BadInputError, match="not a valid ZIP"):
        extract_members(write(tmp_path, b"PK\x03\x04 truncated"), tmp_path / "out")


def test_rejects_corrupt_member(tmp_path):
    data = bytearray(zip_files([("a.dcm", b"A" * 1000)]))
    payload_at = data.index(b"a.dcm") + len("a.dcm")
    data[payload_at + 2] ^= 0xFF  # flip a byte of the deflate stream
    with pytest.raises(BadInputError):
        extract_members(write(tmp_path, bytes(data)), tmp_path / "out")
