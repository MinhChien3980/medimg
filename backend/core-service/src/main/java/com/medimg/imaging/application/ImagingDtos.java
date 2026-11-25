package com.medimg.imaging.application;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Public contract of the imaging module (REST DTOs and data handed to other modules). */
public final class ImagingDtos {

    private ImagingDtos() {
    }

    public record FileSpec(String name, long size, String contentType) {
    }

    public record InitUpload(UUID patientId, List<FileSpec> files, String modalityHint, String bodyPartHint) {
    }

    public record PresignedFile(UUID fileId, String name, URI putUrl, Instant expiresAt) {
    }

    public record InitUploadResponse(UUID uploadId, List<PresignedFile> files) {
    }

    /** {@code progress} is 0-100; {@code inputType} is null until the file type has been recognised. */
    public record UploadDto(UUID uploadId, String status, int progress, String inputType, String error, UUID studyId) {
    }

    /**
     * {@code imageUrl} is set for a 2D image, {@code volumeUrl} (NIfTI), {@code dims} ({@code [x, y, z]} voxels) and
     * {@code spacing} ({@code [x, y, z]} mm) for a volume.
     */
    public record SeriesDto(UUID id, String modality, Integer rows, Integer cols, Integer numImages,
                            URI imageUrl, URI thumbnailUrl, URI volumeUrl, List<Integer> dims, List<Double> spacing) {
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
