package com.medimg.annotation.application;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.medimg.identity.application.UserRef;

import tools.jackson.databind.JsonNode;

/** Public contract of the annotation module. */
public final class AnnotationDtos {

    private AnnotationDtos() {
    }

    /** {@code geometry} is in image pixels on a 2D image and in patient LPS mm on a volume (see the kinds). */
    public record AnnotationDto(UUID id, UUID studyId, UUID seriesId, String kind, JsonNode geometry, String label,
                                String note, MeasurementDto measurement, UserRef author, Instant createdAt,
                                Instant updatedAt, long version) {
    }

    /** Lengths and areas in mm (mm²), or in px (px²) on an uncalibrated image; HU statistics of a volume ROI. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MeasurementDto(Double lengthMm, Double lengthPx, Double areaMm2, Double areaPx2, Double meanHu,
                                 Double stdHu) {
    }

    /** {@code geometry} and {@code measurement} as sent by the client, checked against the kind and the series. */
    public record CreateAnnotation(UUID studyId, UUID seriesId, String kind, JsonNode geometry, String label,
                                   String note, JsonNode measurement) {
    }

    /** {@code version} is the version of the annotation the change was made on. */
    public record UpdateAnnotation(JsonNode geometry, String label, String note, JsonNode measurement, long version) {
    }
}
