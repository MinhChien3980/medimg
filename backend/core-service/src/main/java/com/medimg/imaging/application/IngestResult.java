package com.medimg.imaging.application;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** A message read from the {@code imaging.results} stream. */
public record IngestResult(UUID uploadId, int attempt, String workerId, Type type, int progress, String payloadJson,
                           String error, boolean retryable) {

    public enum Type { STARTED, PROGRESS, DONE, FAILED }

    /** Shape of {@code payload} for DONE messages: the normalised volume (produced by the ingest worker). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Payload(String volumeUri, String thumbnailUri, String modality, List<Integer> dims, List<Double> spacing) {
    }
}
