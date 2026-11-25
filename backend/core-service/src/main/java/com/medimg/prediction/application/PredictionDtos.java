package com.medimg.prediction.application;

import java.math.BigDecimal;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class PredictionDtos {

    private PredictionDtos() {
    }

    public record ModelDto(UUID id, String code, String version, String name, String task, List<String> labels) {
    }

    public record ModelRef(String code, String version) {
    }

    /** {@code confidence} is null for segmentation findings, {@code volumeMl} (segmented volume) for 2D ones. */
    public record FindingDto(UUID id, String label, BigDecimal confidence, BigDecimal volumeMl, List<Double> bbox,
                             String reviewStatus) {
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
