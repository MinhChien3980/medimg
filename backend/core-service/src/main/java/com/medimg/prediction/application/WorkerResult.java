package com.medimg.prediction.application;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** A message read from the {@code ai.results} stream. */
public record WorkerResult(UUID jobId, int attempt, String workerId, Type type, int progress, String payloadJson,
                           String error, boolean retryable) {

    public enum Type { STARTED, PROGRESS, DONE, FAILED }

    /** Shape of {@code payload} for DONE messages (produced by the ai-worker). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Payload(String modelVersion, Integer inferenceMs, List<PayloadFinding> findings, Artifacts artifacts) {
    }

    /** Classification findings carry a confidence, segmentation findings the segmented volume. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PayloadFinding(String label, Double confidence, Double volumeMl, List<Double> bbox) {
    }

    /** {@code segmentation} and {@code meshes} are produced by 3D segmentation models only. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Artifacts(Map<String, String> heatmaps, String segmentation, List<PayloadMesh> meshes) {
    }

    /** One organ surface (GLB, patient LPS coordinates in mm). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PayloadMesh(String label, String color, String uri, Integer triangles, Double volumeMl,
                              List<Double> centroid) {
    }
}
