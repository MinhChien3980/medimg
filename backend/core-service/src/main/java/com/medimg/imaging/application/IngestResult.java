package com.medimg.imaging.application;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.medimg.imaging.domain.Study.InputType;

/** A message read from the {@code imaging.results} stream. */
public record IngestResult(UUID uploadId, int attempt, String workerId, Type type, int progress, String payloadJson,
                           String error, boolean retryable) {

    public enum Type { STARTED, PROGRESS, DONE, FAILED }

    /**
     * Shape of {@code payload} for DONE messages, written by the ingest worker. {@code inputType} is what the input
     * turned out to be. A 2D image ({@code DICOM_2D}) comes as {@code imageUri} (PNG) with {@code dims [w, h, 1]}; a
     * volume as {@code volumeUri} (NIfTI) with {@code dims} and {@code spacing} {@code [x, y, z]}, where
     * {@code spacingAssumed} tells that the spacing of a stack of 2D images was not given.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Payload(InputType inputType, String imageUri, String volumeUri, String thumbnailUri, String modality,
                          List<Integer> dims, List<Double> spacing, Boolean spacingAssumed) {
    }
}
