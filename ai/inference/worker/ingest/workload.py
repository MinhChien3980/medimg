"""Ingest jobs: `imaging.jobs` (group `ingest-workers`) -> normalised study -> `imaging.results`.

Input (`inputType`, recognised by core from the upload's magic bytes):

- `DICOM_2D`: one DICOM radiograph -> `image.png` (8-bit grayscale) + `thumb.png`.
- `NIFTI`: `.nii` / `.nii.gz` -> `volume.nii.gz` + `thumb.png`.
- `ZIP`: the content decides. DICOM image files -> `DICOM_SERIES`; PNG/JPEG files ->
  `IMAGE_STACK`; both -> the more numerous kind, the other ignored (logged). Either way
  `volume.nii.gz` (canonical RAS, true or given spacing, no metadata beyond the geometry) +
  `thumb.png` (middle axial slice, 256 px).

The DONE payload's `inputType` names what the upload turned out to be.
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import nibabel as nib

from worker import messages
from worker.errors import BadInputError
from worker.geometry import ras_affine_from_lps
from worker.ingest import dicom
from worker.ingest.archive import ZipLimits, ZipMember, extract_members
from worker.ingest.image_stack import MIN_SLICES as MIN_IMAGES
from worker.ingest.image_stack import image_format, ingest_image_stack
from worker.ingest.nifti import MAX_VOXELS, load_nifti
from worker.ingest.radiograph import Radiograph, ingest_radiograph
from worker.ingest.volume import (
    THUMB_WINDOW,
    NormalizedVolume,
    axial_thumbnail,
    canonical_volume,
    infer_modality,
)
from worker.messages import IngestInputType, IngestJob, IngestResultType
from worker.pipelines.base import ProgressCallback
from worker.storage import ObjectStorage

log = logging.getLogger(__name__)

PROGRESS_DOWNLOADED = 10
PROGRESS_PARSED = 40
PROGRESS_BUILT = 70
PROGRESS_ENCODED = 90
PROGRESS_UPLOADED = 95

VOLUME_CONTENT_TYPE = "application/gzip"
PNG_CONTENT_TYPE = "image/png"


def ingest_nifti(
    path: Path, workdir: Path, modality_hint: str, progress: ProgressCallback
) -> NormalizedVolume:
    raw = load_nifti(path, workdir)
    progress(PROGRESS_PARSED)
    modality = infer_modality(modality_hint, raw.data)
    image = canonical_volume(raw.data, raw.ras_affine, modality)
    return NormalizedVolume(
        image, modality, raw.source_slices, series_count=1, input_type=IngestResultType.NIFTI
    )


def ingest_dicom_series(
    headers: list[dicom.SliceHeader], progress: ProgressCallback
) -> NormalizedVolume:
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
    return NormalizedVolume(
        image,
        modality,
        len(geometry.slices),
        selection.series_count,
        input_type=IngestResultType.DICOM_SERIES,
    )


@dataclass(frozen=True)
class ZipContent:
    dicom: list[dicom.SliceHeader]
    images: list[ZipMember]
    other: int

    @property
    def kind(self) -> IngestResultType:
        """The more numerous usable kind; a tie goes to DICOM, which carries real geometry."""
        if not self.dicom and not self.images:
            ignored = f" ({self.other} other files ignored)" if self.other else ""
            raise BadInputError(
                f"the ZIP contains no DICOM image slices and no PNG/JPEG images{ignored}"
            )
        if len(self.dicom) >= len(self.images):
            return IngestResultType.DICOM_SERIES
        return IngestResultType.IMAGE_STACK


def survey_zip(members: list[ZipMember]) -> ZipContent:
    """Sort extracted members into DICOM image slices, PNG/JPEG images (by magic bytes) and the
    rest (reports, DICOMDIR, text files, ...), which is ignored."""
    headers: list[dicom.SliceHeader] = []
    images: list[ZipMember] = []
    other = 0
    for member in members:
        if image_format(member.path):
            images.append(member)
        elif (header := dicom.read_header(member.path)) is not None:
            headers.append(header)
        else:
            other += 1
    log.info("zip content", extra={"dicom": len(headers), "images": len(images), "other": other})
    return ZipContent(headers, images, other)


def ingest_zip(
    path: Path,
    workdir: Path,
    progress: ProgressCallback,
    limits: ZipLimits | None = None,
    slice_spacing: tuple[float, float, float] | None = None,
) -> NormalizedVolume:
    members = extract_members(path, workdir / "zip", limits)
    path.unlink()
    content = survey_zip(members)
    if content.kind is IngestResultType.DICOM_SERIES:
        if content.images:
            log.warning(
                "PNG/JPEG images ignored, the ZIP holds more DICOM slices",
                extra={"ignored": len(content.images)},
            )
        if slice_spacing is not None:
            log.info("sliceSpacingMm ignored: a DICOM series has its own geometry")
        return ingest_dicom_series(content.dicom, progress)

    if content.dicom:
        log.warning(
            "DICOM files ignored, the ZIP holds more PNG/JPEG images",
            extra={"ignored": len(content.dicom)},
        )
        if len(content.images) < MIN_IMAGES:
            raise BadInputError(
                f"the ZIP has {len(content.dicom)} DICOM slices and {len(content.images)} "
                f"PNG/JPEG images; a 3D volume needs at least {MIN_IMAGES} slices of one kind"
            )
    return ingest_image_stack(content.images, progress, slice_spacing, parsed=PROGRESS_PARSED)


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
        fields: dict[str, Any] = {"inputType": job.input_type.value}
        if job.slice_spacing_mm is not None:
            fields["sliceSpacingMm"] = list(job.slice_spacing_mm)
        return fields

    def summarize(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "resultType": payload["inputType"],
            "dims": payload["dims"],
            "modality": payload["modality"],
        }

    def execute(self, job: IngestJob, progress: ProgressCallback) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="ingest-") as tmp:
            workdir = Path(tmp)
            upload = workdir / "upload"
            self.storage.download_file(job.input_uri, upload)
            progress(PROGRESS_DOWNLOADED)

            if job.input_type is IngestInputType.DICOM_2D:
                image = ingest_radiograph(upload, progress, PROGRESS_PARSED, PROGRESS_BUILT)
                progress(PROGRESS_ENCODED)
                payload = self._image_payload(job, image)
            else:
                if job.input_type is IngestInputType.NIFTI:
                    volume = ingest_nifti(upload, workdir, job.modality_hint, progress)
                else:
                    volume = ingest_zip(
                        upload, workdir, progress, self.zip_limits, job.slice_spacing_mm
                    )
                progress(PROGRESS_BUILT)
                payload = self._volume_payload(job, volume, workdir, progress)
            progress(PROGRESS_UPLOADED)
            return payload

    def _image_payload(self, job: IngestJob, image: Radiograph) -> dict[str, Any]:
        return {
            "inputType": IngestResultType.DICOM_2D.value,
            "imageUri": self.storage.put_bytes(
                job.artifact_uri("image.png"), image.png, PNG_CONTENT_TYPE
            ),
            "thumbnailUri": self.storage.put_bytes(
                job.artifact_uri("thumb.png"), image.thumbnail, PNG_CONTENT_TYPE
            ),
            "modality": image.modality,
            "dims": [image.width, image.height, 1],
            "spacing": None if image.spacing is None else [*image.spacing, None],
        }

    def _volume_payload(
        self, job: IngestJob, volume: NormalizedVolume, workdir: Path, progress: ProgressCallback
    ) -> dict[str, Any]:
        volume_path = workdir / "volume.nii.gz"
        nib.save(volume.image, volume_path)
        # CT: soft-tissue window. Anything else (MR, plain images) has no fixed value scale.
        thumb = axial_thumbnail(
            volume.image, window=THUMB_WINDOW if volume.modality == "CT" else None
        )
        progress(PROGRESS_ENCODED)
        return {
            "inputType": volume.input_type.value,
            "volumeUri": self.storage.put_file(
                job.artifact_uri("volume.nii.gz"), volume_path, VOLUME_CONTENT_TYPE
            ),
            "thumbnailUri": self.storage.put_bytes(
                job.artifact_uri("thumb.png"), thumb, PNG_CONTENT_TYPE
            ),
            "modality": volume.modality,
            "dims": volume.dims,
            "spacing": volume.spacing,
            "spacingAssumed": volume.spacing_assumed,
            "numSlices": volume.dims[2],
            "huRange": volume.hu_range(),
            "sourceSeries": {
                "slices": volume.source_slices,
                "seriesCount": volume.series_count,
            },
        }
