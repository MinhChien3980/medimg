"""Ingest jobs: `imaging.jobs` (group `ingest-workers`) -> normalised volume -> `imaging.results`.

Input: an uploaded NIfTI (`.nii` / `.nii.gz`) or a ZIP of one DICOM study. Output, under the
job's `outputPrefix`: `volume.nii.gz` (int16, canonical RAS, true spacing, no metadata beyond
the geometry) and `thumb.png` (middle axial slice, window 400/40, 256 px).
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

import nibabel as nib

from worker import messages
from worker.errors import BadInputError
from worker.geometry import ras_affine_from_lps
from worker.ingest import dicom
from worker.ingest.archive import ZipLimits, extract_members
from worker.ingest.nifti import MAX_VOXELS, load_nifti
from worker.ingest.volume import NormalizedVolume, axial_thumbnail, canonical_volume, infer_modality
from worker.messages import IngestInputType, IngestJob
from worker.pipelines.base import ProgressCallback
from worker.storage import ObjectStorage

log = logging.getLogger(__name__)

PROGRESS_DOWNLOADED = 10
PROGRESS_PARSED = 40
PROGRESS_BUILT = 70
PROGRESS_ENCODED = 90
PROGRESS_UPLOADED = 95

VOLUME_CONTENT_TYPE = "application/gzip"
THUMB_CONTENT_TYPE = "image/png"


def ingest_nifti(
    path: Path, workdir: Path, modality_hint: str, progress: ProgressCallback
) -> NormalizedVolume:
    raw = load_nifti(path, workdir)
    progress(PROGRESS_PARSED)
    modality = infer_modality(modality_hint, raw.data)
    image = canonical_volume(raw.data, raw.ras_affine, modality)
    return NormalizedVolume(image, modality, raw.source_slices, series_count=1)


def ingest_dicom_zip(
    path: Path, workdir: Path, progress: ProgressCallback, limits: ZipLimits | None = None
) -> NormalizedVolume:
    files = extract_members(path, workdir / "dicom", limits)
    path.unlink()
    headers = [h for f in files if (h := dicom.read_header(f)) is not None]
    log.info("dicom files scanned", extra={"files": len(files), "slices": len(headers)})
    selection = dicom.select_series(headers)
    geometry = dicom.slice_geometry(selection.slices)
    first = geometry.slices[0]
    count = dicom.uniform_slice_count(geometry)
    if first.rows * first.columns * count > MAX_VOXELS:
        raise BadInputError(
            f"the series has {first.rows * first.columns * count / 1e6:.0f} million voxels; "
            f"at most {MAX_VOXELS / 1e6:.0f} million are accepted"
        )
    progress(PROGRESS_PARSED)

    stack = dicom.read_pixels(geometry.slices)
    if not geometry.uniform:
        stack = dicom.resample_uniform(stack, geometry)
    modality = first.modality or "OT"
    data = stack.transpose(2, 1, 0)  # (slice, row, column) -> (i=column, j=row, k=slice)
    image = canonical_volume(data, ras_affine_from_lps(geometry.lps_affine), modality)
    return NormalizedVolume(image, modality, len(geometry.slices), selection.series_count)


class IngestWorkload:
    jobs_stream = messages.IMAGING_JOBS_STREAM
    group = messages.INGEST_CONSUMER_GROUP
    results = messages.IMAGING_RESULTS

    def __init__(self, storage: ObjectStorage, zip_limits: ZipLimits | None = None) -> None:
        self.storage = storage
        self.zip_limits = zip_limits

    def parse(self, fields: dict[str, str]) -> IngestJob:
        return IngestJob.parse(fields)

    def is_cancelled(self, job: IngestJob) -> bool:
        return False

    def describe(self, job: IngestJob) -> dict[str, Any]:
        return {"inputType": job.input_type.value}

    def summarize(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"dims": payload["dims"], "modality": payload["modality"]}

    def execute(self, job: IngestJob, progress: ProgressCallback) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="ingest-") as tmp:
            workdir = Path(tmp)
            upload = workdir / "upload"
            self.storage.download_file(job.input_uri, upload)
            progress(PROGRESS_DOWNLOADED)

            if job.input_type is IngestInputType.NIFTI:
                volume = ingest_nifti(upload, workdir, job.modality_hint, progress)
            else:
                volume = ingest_dicom_zip(upload, workdir, progress, self.zip_limits)
            progress(PROGRESS_BUILT)

            volume_path = workdir / "volume.nii.gz"
            nib.save(volume.image, volume_path)
            thumb = axial_thumbnail(volume.image)
            progress(PROGRESS_ENCODED)

            payload = {
                "volumeUri": self.storage.put_file(
                    job.artifact_uri("volume.nii.gz"), volume_path, VOLUME_CONTENT_TYPE
                ),
                "thumbnailUri": self.storage.put_bytes(
                    job.artifact_uri("thumb.png"), thumb, THUMB_CONTENT_TYPE
                ),
                "modality": volume.modality,
                "dims": volume.dims,
                "spacing": volume.spacing,
                "numSlices": volume.dims[2],
                "huRange": volume.hu_range(),
                "sourceSeries": {
                    "slices": volume.source_slices,
                    "seriesCount": volume.series_count,
                },
            }
            progress(PROGRESS_UPLOADED)
            return payload
