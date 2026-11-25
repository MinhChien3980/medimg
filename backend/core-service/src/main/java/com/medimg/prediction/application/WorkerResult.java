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

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PayloadFinding(String label, double confidence, List<Double> bbox) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Artifacts(Map<String, String> heatmaps) {
    }
}
