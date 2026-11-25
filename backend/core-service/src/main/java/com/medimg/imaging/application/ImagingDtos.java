package com.medimg.imaging.application;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

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
     * {@code imageUrl} is set for a 2D image, {@code volumeUrl} (NIfTI), {@code dims} ({@code [x, y, z]} voxels) and
     * {@code spacing} ({@code [x, y, z]} mm) for a volume. {@code spacingAssumed} is true when the spacing of a stack
     * of 2D images was not given (1 mm assumed, so measurements are not reliable).
     */
    public record SeriesDto(UUID id, String modality, Integer rows, Integer cols, Integer numImages,
                            URI imageUrl, URI thumbnailUrl, URI volumeUrl, List<Integer> dims, List<Double> spacing,
                            boolean spacingAssumed) {
    }

    public record StudyDto(UUID id, UUID patientId, String inputType, String modality, String bodyPart,
                           Instant createdAt, List<SeriesDto> series) {
    }

    /**
     * What the prediction module needs to schedule a job on a series. {@code inputType} is that of the study;
     * {@code normalizedUri} is the stored image or volume a worker reads, in format {@code normalizedType}.
     */
    public record SeriesRef(UUID studyId, UUID seriesId, UUID patientId, String inputType, String modality,
                            String bodyPart, String normalizedType, String normalizedUri) {
    }
}
