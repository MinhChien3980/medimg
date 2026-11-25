package com.medimg.imaging.application;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.medimg.imaging.domain.Study;
import com.medimg.shared.storage.ObjectStoragePort.UploadedPart;

/** Public contract of the imaging module (REST DTOs and data handed to other modules). */
public final class ImagingDtos {

    private ImagingDtos() {
    }

    public record FileSpec(String name, long size, String contentType) {
    }

    /** {@code sliceSpacingMm} ({@code [x, y, z]}, optional) is the voxel spacing of a ZIP of 2D image slices. */
    public record InitUpload(UUID patientId, List<FileSpec> files, String modalityHint, String bodyPartHint,
                             List<Double> sliceSpacingMm) {
    }

    public record PartUrl(int partNumber, URI url) {
    }

    /** Part {@code n} is bytes {@code [(n - 1) * partSize, min(n * partSize, size))} of the file. */
    public record MultipartUpload(long partSize, List<PartUrl> parts) {
    }

    /** A file is uploaded either with one PUT to {@code putUrl} or, when it is large, in parts ({@code multipart}). */
    public record PresignedFile(UUID fileId, String name, URI putUrl, MultipartUpload multipart, Instant expiresAt) {
    }

    /** The parts of a file uploaded in parts, as uploaded by the client. */
    public record CompletedFile(UUID fileId, List<UploadedPart> parts) {
    }

    public record InitUploadResponse(UUID uploadId, List<PresignedFile> files) {
    }

    /**
     * {@code progress} is 0-100; {@code inputType} is null until the file type has been recognised (for a ZIP, by the
     * ingest worker once it is done).
     */
    public record UploadDto(UUID uploadId, String status, int progress, String inputType, String error, UUID studyId) {
    }

    /**
     * {@code imageUrl} is set for a 2D image, with {@code pixelSpacing} ({@code [x, y]} mm) when the image is calibrated
     * (a DICOM X-ray; null for PNG and JPEG, measured in pixels); {@code volumeUrl} (NIfTI), {@code dims}
     * ({@code [x, y, z]} voxels) and {@code spacing} ({@code [x, y, z]} mm) for a volume. {@code spacingAssumed} is true
     * when the spacing of a stack of 2D images was not given (1 mm assumed, so measurements are not reliable).
     */
    public record SeriesDto(UUID id, String modality, Integer rows, Integer cols, Integer numImages,
                            URI imageUrl, URI thumbnailUrl, URI volumeUrl, List<Integer> dims, List<Double> spacing,
                            boolean spacingAssumed, List<Double> pixelSpacing) {
    }

    public record StudyDto(UUID id, UUID patientId, String inputType, String modality, String bodyPart,
                           Instant createdAt, List<SeriesDto> series) {
    }

    /**
     * A series as other modules see it. {@code inputType} is that of the study; {@code normalizedUri} is the stored
     * image or volume a worker reads, in format {@code normalizedType}. {@code dims} is {@code [x, y, z]} ({@code z} is
     * 1 for a 2D image); {@code spacing} is in mm, {@code [x, y, z]} for a volume, {@code [x, y]} for a calibrated 2D
     * image and null for an uncalibrated one.
     */
    public record SeriesRef(UUID studyId, UUID seriesId, UUID patientId, String inputType, String modality,
                            String bodyPart, String normalizedType, String normalizedUri, List<Integer> dims,
                            List<Double> spacing) {

        public boolean isVolume() {
            return Study.InputType.valueOf(normalizedType).isVolume();
        }
    }

    /** A study and its series, without the URLs of their files. */
    public record StudyRef(UUID id, UUID patientId, String inputType, String modality, String bodyPart,
                           Instant createdAt, List<SeriesRef> series) {

        public boolean isVolume() {
            return Study.InputType.valueOf(inputType).isVolume();
        }
    }
}
