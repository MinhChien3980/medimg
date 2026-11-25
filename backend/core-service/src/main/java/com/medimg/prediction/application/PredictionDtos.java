package com.medimg.prediction.application;

import java.math.BigDecimal;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.medimg.identity.application.UserRef;

public final class PredictionDtos {

    private PredictionDtos() {
    }

    public record ModelDto(UUID id, String code, String version, String name, String task, List<String> labels) {
    }

    public record ModelRef(String code, String version) {
    }

    /**
     * A finding of the AI ({@code source} AI) or added by a doctor (MANUAL). {@code confidence} is null for
     * segmentation and manual findings, {@code volumeMl} (segmented volume) for 2D and manual ones. {@code review} is
     * null while the finding is PENDING; a manual finding is ACCEPTED, reviewed by its author, and may point at an
     * annotation. {@code version} is sent back with a review.
     */
    public record FindingDto(UUID id, UUID seriesId, String source, String label, BigDecimal confidence,
                             BigDecimal volumeMl, List<Double> bbox, String reviewStatus, ReviewDto review,
                             UUID annotationId, long version) {
    }

    /** {@code label} is the corrected label of an EDITED finding, null otherwise. */
    public record ReviewDto(String status, String label, String note, UserRef reviewedBy, Instant reviewedAt) {
    }

    public record ReviewFinding(String status, String label, String note, long version) {
    }

    public record AddFinding(UUID studyId, UUID seriesId, String label, String note, UUID annotationId) {
    }

    /** One organ surface as GLB; {@code centroid} in patient LPS coordinates (mm). */
    public record MeshDto(String label, String color, URI url, Integer triangles, Double volumeMl, List<Double> centroid) {
    }

    /** {@code segmentation} (labelmap NIfTI) and {@code meshes} come from 3D segmentation; null and empty otherwise. */
    public record ArtifactsDto(Map<String, URI> heatmaps, URI segmentation, List<MeshDto> meshes) {
    }

    /** {@code params} holds the job parameters as given at creation (e.g. {@code threshold}); empty when none. */
    public record PredictionDto(UUID jobId, UUID studyId, UUID seriesId, String status, int progress, int attempt,
                                ModelRef model, Map<String, Object> params, Integer inferenceMs, String error,
                                Instant queuedAt, Instant finishedAt, List<FindingDto> findings, ArtifactsDto artifacts) {
    }

    public record CreatedJob(UUID jobId, String status, long queuePosition) {
    }

    public record JobSummary(UUID jobId, String modelCode, String status) {
    }

    public record CreatePrediction(UUID studyId, UUID seriesId, String modelCode, Map<String, Object> params,
                                   String idempotencyKey) {
    }

    /** Published (after commit) whenever a job changes; drives SSE pushes. */
    public record PredictionChanged(UUID jobId, String status, int progress) {
    }
}
