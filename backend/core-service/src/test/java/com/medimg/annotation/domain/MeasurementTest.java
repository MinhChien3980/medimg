package com.medimg.annotation.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.Test;

import com.medimg.annotation.domain.Geometry.Arrow;
import com.medimg.annotation.domain.Geometry.Line;
import com.medimg.annotation.domain.Geometry.PlaneShape;
import com.medimg.annotation.domain.Geometry.Rectangle;

class MeasurementTest {

    private static final SeriesFrame IMAGE = SeriesFrame.image(400, 300, null);
    private static final SeriesFrame CALIBRATED = SeriesFrame.image(400, 300, List.of(0.2, 0.2));
    private static final SeriesFrame VOLUME = SeriesFrame.volume(List.of(512, 512, 120));

    private static final Line LINE = new Line(List.of(0.0, 0.0), List.of(30.0, 40.0)); // 50 px, 10 mm
    private static final PlaneShape ROI = new PlaneShape(List.of(List.of(0.0, 10.0, 0.0), List.of(0.0, -10.0, 0.0),
            List.of(-15.0, 0.0, 0.0), List.of(15.0, 0.0, 0.0)), List.of(0.0, 0.0, 1.0), List.of(0.0, -1.0, 0.0), null);

    @Test
    void lengthOnAnUncalibratedImageIsInPixels() {
        assertThatCode(() -> length(null, 50.0).validate(AnnotationKind.LENGTH, LINE, IMAGE)).doesNotThrowAnyException();
        assertInvalid(length(10.0, null), AnnotationKind.LENGTH, LINE, IMAGE, "lengthMm is not allowed");
    }

    @Test
    void lengthOnACalibratedImageIsInMillimetres() {
        assertThatCode(() -> length(10.0, null).validate(AnnotationKind.LENGTH, LINE, CALIBRATED)).doesNotThrowAnyException();
        assertInvalid(length(null, 50.0), AnnotationKind.LENGTH, LINE, CALIBRATED, "lengthPx is not allowed");
    }

    @Test
    void lengthMustAgreeWithTheGeometry() {
        assertThatCode(() -> length(10.09, null).validate(AnnotationKind.LENGTH, LINE, CALIBRATED))
                .doesNotThrowAnyException();
        assertInvalid(length(11.0, null), AnnotationKind.LENGTH, LINE, CALIBRATED, "does not match the geometry (10.0)");
    }

    @Test
    void valuesArePositiveAndFinite() {
        assertInvalid(length(null, -50.0), AnnotationKind.LENGTH, LINE, IMAGE, "lengthPx must be positive");
        assertInvalid(length(null, Double.POSITIVE_INFINITY), AnnotationKind.LENGTH, LINE, IMAGE, "finite");
        assertInvalid(new Measurement(null, null, 100.0, null, 20.0, -1.0), AnnotationKind.ELLIPSE_ROI, ROI, VOLUME,
                "stdHu must not be negative");
        assertInvalid(new Measurement(null, null, 100.0, null, 40000.0, 1.0), AnnotationKind.ELLIPSE_ROI, ROI, VOLUME,
                "meanHu must be between");
    }

    @Test
    void volumeRoiHasAreaAndHuStatistics() {
        assertThatCode(() -> new Measurement(null, null, 471.2, null, -35.5, 12.0)
                .validate(AnnotationKind.ELLIPSE_ROI, ROI, VOLUME)).doesNotThrowAnyException();
        assertInvalid(new Measurement(12.0, null, null, null, null, null), AnnotationKind.ELLIPSE_ROI, ROI, VOLUME,
                "lengthMm is not allowed for ELLIPSE_ROI on this volume");
    }

    @Test
    void rectangleAreaFollowsTheGeometryAndHuIsOnlyMeasuredOnVolumes() {
        Rectangle rectangle = new Rectangle(0.0, 0.0, 10.0, 20.0);

        assertThatCode(() -> new Measurement(null, null, null, 200.0, null, null)
                .validate(AnnotationKind.RECTANGLE, rectangle, IMAGE)).doesNotThrowAnyException();
        assertInvalid(new Measurement(null, null, null, 150.0, null, null), AnnotationKind.RECTANGLE, rectangle, IMAGE,
                "area 150.0 does not match");
        assertInvalid(new Measurement(null, null, null, 200.0, 40.0, null), AnnotationKind.RECTANGLE, rectangle, IMAGE,
                "meanHu is not allowed for RECTANGLE on this uncalibrated image");
    }

    @Test
    void arrowIsNotMeasured() {
        Arrow arrow = new Arrow(List.of(0.0, 0.0), List.of(3.0, 4.0), null);

        assertInvalid(length(null, 5.0), AnnotationKind.ARROW, arrow, IMAGE, "not allowed for ARROW");
    }

    @Test
    void measurementWithoutValuesIsNotStored() {
        assertThat(new Measurement(null, null, null, null, null, null).hasValues()).isFalse();
        assertThat(length(null, 1.0).hasValues()).isTrue();
    }

    private static Measurement length(Double mm, Double px) {
        return new Measurement(mm, px, null, null, null, null);
    }

    private static void assertInvalid(Measurement m, AnnotationKind kind, Geometry geometry, SeriesFrame frame,
                                      String message) {
        assertThatThrownBy(() -> m.validate(kind, geometry, frame))
                .isInstanceOf(InvalidAnnotationException.class)
                .hasMessageContaining(message);
    }
}
