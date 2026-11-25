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

    public record UploadDto(UUID uploadId, String status, String error, UUID studyId) {
    }

    public record SeriesDto(UUID id, String modality, Integer rows, Integer cols, Integer numImages,
                            URI imageUrl, URI thumbnailUrl) {
    }

    public record StudyDto(UUID id, UUID patientId, String inputType, String modality, String bodyPart,
                           Instant createdAt, List<SeriesDto> series) {
    }

    /** What the prediction module needs to schedule a job on a series. */
    public record SeriesRef(UUID studyId, UUID seriesId, UUID patientId, String inputType, String modality,
                            String bodyPart, String imageUri) {
    }
}
