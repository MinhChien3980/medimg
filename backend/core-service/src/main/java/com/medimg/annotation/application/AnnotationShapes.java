package com.medimg.annotation.application;

import org.springframework.stereotype.Component;

import com.medimg.annotation.application.AnnotationDtos.MeasurementDto;
import com.medimg.annotation.domain.AnnotationKind;
import com.medimg.annotation.domain.Geometry;
import com.medimg.annotation.domain.InvalidAnnotationException;
import com.medimg.annotation.domain.Measurement;
import com.medimg.annotation.domain.SeriesFrame;
import com.medimg.shared.web.ApiException;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Reads the geometry and measurement the client sent into their domain form, strictly (unknown fields are errors),
 * checks them against the kind and the series, and gives the JSON to store.
 */
@Component
class AnnotationShapes {

    /** A shape checked against its series, in its stored JSON form; {@code measurementJson} is null without values. */
    record Shape(String geometryJson, String measurementJson) {
    }

    private final ObjectMapper json;

    AnnotationShapes(ObjectMapper json) {
        this.json = json;
    }

    Shape read(AnnotationKind kind, SeriesFrame frame, JsonNode geometryNode, JsonNode measurementNode) {
        Class<? extends Geometry> type = kind.geometryType(frame.space()).orElseThrow(() -> ApiException.badRequest(
                kind + " annotations are not drawn on " + (frame.space() == SeriesFrame.Space.WORLD ? "volumes" : "2D images")));
        Geometry geometry = strict(geometryNode, type, "geometry");
        Measurement measurement = measurementNode == null || measurementNode.isNull() ? null
                : strict(measurementNode, Measurement.class, "measurement");
        try {
            geometry.validate(kind, frame);
            if (measurement != null) {
                measurement.validate(kind, geometry, frame);
            }
        } catch (InvalidAnnotationException e) {
            throw ApiException.badRequest(e.getMessage());
        }
        return new Shape(json.writeValueAsString(geometry), measurement == null || !measurement.hasValues() ? null
                : json.writeValueAsString(new MeasurementDto(measurement.lengthMm(), measurement.lengthPx(),
                        measurement.areaMm2(), measurement.areaPx2(), measurement.meanHu(), measurement.stdHu())));
    }

    private <T> T strict(JsonNode node, Class<T> type, String field) {
        if (node == null || !node.isObject()) {
            throw ApiException.badRequest(field + " must be an object");
        }
        try {
            return json.readerFor(type).with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).readValue(node);
        } catch (JacksonException e) {
            throw ApiException.badRequest(field + " is not valid: " + e.getOriginalMessage());
        }
    }
}
