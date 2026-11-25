"""Uploaded NIfTI -> int16 voxel array + RAS affine, with the checks done on the header first.

The shape and voxel count are validated before any voxel is read. A gzip file is inflated to a
plain `.nii` in the job directory, never past the size its header announces (a gzip bomb
stops there), so nibabel can memory-map it and the int16 conversion runs slab by slab without
holding a float64 copy of the volume.
"""

from __future__ import annotations

import gzip
import zlib
from dataclasses import dataclass
from pathlib import Path

import nibabel as nib
import numpy as np

from worker.errors import BadInputError

GZIP_MAGIC = b"\x1f\x8b"
MAX_VOXELS = 300_000_000
MIN_SLICES = 20
SLAB = 16
INT16_MIN, INT16_MAX = -32768, 32767


@dataclass(frozen=True)
class RawVolume:
    data: np.ndarray
    """int16, axes as stored in the file (i, j, k)."""
    ras_affine: np.ndarray
    source_slices: int


def _load_header(path: Path) -> nib.Nifti1Image:
    try:
        img = nib.load(path)
    except Exception as exc:
        raise BadInputError(f"not a readable NIfTI file: {exc}") from exc
    if not isinstance(img, nib.Nifti1Image | nib.Nifti2Image):
        raise BadInputError("not a NIfTI-1 or NIfTI-2 file")
    return img


def _check_shape(shape: tuple[int, ...], max_voxels: int) -> tuple[int, int, int]:
    if len(shape) == 4 and shape[3] == 1:
        shape = shape[:3]
    if len(shape) != 3:
        raise BadInputError(
            f"NIfTI must be 3D (or 4D with a single volume), got shape {tuple(shape)}"
        )
    if shape[2] < MIN_SLICES:
        raise BadInputError(f"the volume has {shape[2]} slices; at least {MIN_SLICES} are needed")
    voxels = int(np.prod(shape, dtype=np.int64))
    if voxels > max_voxels:
        raise BadInputError(
            f"the volume has {voxels / 1e6:.0f} million voxels; at most "
            f"{max_voxels / 1e6:.0f} million are accepted"
        )
    return shape[0], shape[1], shape[2]


def _inflate(src: Path, dest: Path, limit: int) -> None:
    try:
        with gzip.open(src, "rb") as fin, dest.open("wb") as fout:
            remaining = limit
            while remaining > 0:
                block = fin.read(min(1024 * 1024, remaining))
                if not block:
                    break
                fout.write(block)
                remaining -= len(block)
    except (OSError, EOFError, zlib.error) as exc:
        raise BadInputError(f"corrupt gzip stream: {exc}") from exc
    if remaining > 0:
        raise BadInputError("the NIfTI file is truncated")


def load_nifti(path: Path, workdir: Path, max_voxels: int = MAX_VOXELS) -> RawVolume:
    with path.open("rb") as fh:
        compressed = fh.read(2) == GZIP_MAGIC
    named = workdir / ("upload.nii.gz" if compressed else "upload.nii")
    path.replace(named)  # nibabel picks the reader from the extension

    header_img = _load_header(named)
    shape = _check_shape(header_img.shape, max_voxels)
    dtype = header_img.get_data_dtype()
    if dtype.kind not in "iuf" or dtype.fields is not None:
        raise BadInputError(f"unsupported NIfTI data type {dtype}")

    if compressed:
        plain = workdir / "upload.nii"
        offset = int(header_img.dataobj.offset)
        _inflate(named, plain, offset + int(np.prod(shape)) * dtype.itemsize)
        named.unlink()
        header_img = _load_header(plain)

    proxy = header_img.dataobj
    out = np.empty(shape, dtype=np.int16)
    try:
        for z0 in range(0, shape[2], SLAB):
            z1 = min(z0 + SLAB, shape[2])
            index = (slice(None), slice(None), slice(z0, z1))
            slab = np.asarray(proxy[index + ((0,) if len(header_img.shape) == 4 else ())])
            slab = np.nan_to_num(slab.astype(np.float32, copy=False), nan=0.0)
            out[:, :, z0:z1] = np.clip(np.rint(slab), INT16_MIN, INT16_MAX)
    except (OSError, ValueError, EOFError) as exc:
        raise BadInputError(f"cannot read the NIfTI voxel data: {exc}") from exc

    affine = header_img.affine
    if (
        affine is None
        or not np.all(np.isfinite(affine))
        or abs(np.linalg.det(affine[:3, :3])) < 1e-9
    ):
        raise BadInputError("the NIfTI file has no valid voxel-to-world affine")
    return RawVolume(
        data=out, ras_affine=np.asarray(affine, dtype=np.float64), source_slices=shape[2]
    )
