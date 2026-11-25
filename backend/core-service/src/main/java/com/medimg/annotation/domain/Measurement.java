package com.medimg.annotation.domain;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.OptionalDouble;
import java.util.Set;

/**
 * Values the client measured on an annotation. Lengths and areas are in mm (mm²) on a volume or a calibrated image and
 * in pixels (px²) on an uncalibrated one; {@code meanHu} and {@code stdHu} are the CT statistics of a volume ROI.
 * A length or area that follows from the geometry must agree with it.
 */
public record Measurement(Double lengthMm, Double lengthPx, Double areaMm2, Double areaPx2, Double meanHu, Double stdHu) {

    /** Relative difference tolerated between a measured value and the one the geometry gives. */
    static final double TOLERANCE = 0.01;
    static final double MIN_HU = -32768;
    static final double MAX_HU = 32767;

    /** False when no value was measured; such a measurement is not stored. */
    public boolean hasValues() {
        return !values().isEmpty();
    }

    /** @throws InvalidAnnotationException naming the offending field */
    public void validate(AnnotationKind kind, Geometry geometry, SeriesFrame frame) {
        Set<String> allowed = allowedFields(kind, frame.calibrated());
        values().forEach((field, value) -> {
            if (!allowed.contains(field)) {
                throw invalid("measurement." + field + " is not allowed for " + kind + " on this "
                        + (frame.space() == SeriesFrame.Space.WORLD ? "volume" : frame.calibrated()
                        ? "calibrated image" : "uncalibrated image (measure in px)"));
            }
            if (!Double.isFinite(value)) {
                throw invalid("measurement." + field + " must be a finite number");
            }
        });
        requirePositive("lengthMm", lengthMm);
        requirePositive("lengthPx", lengthPx);
        requirePositive("areaMm2", areaMm2);
        requirePositive("areaPx2", areaPx2);
        if (stdHu != null && stdHu < 0) {
            throw invalid("measurement.stdHu must not be negative");
        }
        if (meanHu != null && (meanHu < MIN_HU || meanHu > MAX_HU)) {
            throw invalid("measurement.meanHu must be between " + (int) MIN_HU + " and " + (int) MAX_HU);
        }
        requireAgrees("length", frame.calibrated() ? lengthMm : lengthPx, geometry.length(frame));
        requireAgrees("area", frame.calibrated() ? areaMm2 : areaPx2, geometry.area(frame));
    }

    private static Set<String> allowedFields(AnnotationKind kind, boolean calibrated) {
        String length = calibrated ? "lengthMm" : "lengthPx";
        String area = calibrated ? "areaMm2" : "areaPx2";
        return switch (kind) {
            case LENGTH -> Set.of(length);
            case RECTANGLE, POLYGON -> Set.of(area);
            case RECTANGLE_ROI, ELLIPSE_ROI -> Set.of("areaMm2", "meanHu", "stdHu");
            case ARROW -> Set.of();
        };
    }

    private Map<String, Double> values() {
        Map<String, Double> values = new LinkedHashMap<>();
        values.put("lengthMm", lengthMm);
        values.put("lengthPx", lengthPx);
        values.put("areaMm2", areaMm2);
        values.put("areaPx2", areaPx2);
        values.put("meanHu", meanHu);
        values.put("stdHu", stdHu);
        values.values().removeIf(v -> v == null);
        return values;
    }

    private static void requirePositive(String field, Double value) {
        if (value != null && value <= 0) {
            throw invalid("measurement." + field + " must be positive");
        }
    }

    private static void requireAgrees(String what, Double measured, OptionalDouble expected) {
        if (measured != null && expected.isPresent()
                && Math.abs(measured - expected.getAsDouble()) > TOLERANCE * expected.getAsDouble()) {
            throw invalid("measurement: the " + what + " " + measured + " does not match the geometry ("
                    + Math.round(expected.getAsDouble() * 100) / 100.0 + ")");
        }
    }

    private static InvalidAnnotationException invalid(String message) {
        return new InvalidAnnotationException(message);
    }
}
