package com.medimg.annotation.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.medimg.annotation.domain.Geometry.Arrow;
import com.medimg.annotation.domain.Geometry.Line;
import com.medimg.annotation.domain.Geometry.PlaneShape;
import com.medimg.annotation.domain.Geometry.Polygon;
import com.medimg.annotation.domain.Geometry.Rectangle;
import com.medimg.annotation.domain.SeriesFrame.Space;

class GeometryTest {

    /** 400 x 300 px image, uncalibrated. */
    private static final SeriesFrame IMAGE = SeriesFrame.image(400, 300, null);
    /** Same image with 0.2 x 0.5 mm pixels. */
    private static final SeriesFrame CALIBRATED = SeriesFrame.image(400, 300, List.of(0.2, 0.5));
    private static final SeriesFrame VOLUME = SeriesFrame.volume(List.of(512, 512, 120));

    private static final List<Double> AXIAL = List.of(0.0, 0.0, 1.0);
    private static final List<Double> UP = List.of(0.0, -1.0, 0.0);

    @Test
    void kindsAreDrawnOnTheirSpaceOnly() {
        assertThat(AnnotationKind.RECTANGLE.geometryType(Space.IMAGE)).contains(Rectangle.class);
        assertThat(AnnotationKind.POLYGON.geometryType(Space.IMAGE)).contains(Polygon.class);
        assertThat(AnnotationKind.ARROW.geometryType(Space.IMAGE)).contains(Arrow.class);
        assertThat(AnnotationKind.LENGTH.geometryType(Space.IMAGE)).contains(Line.class);
        assertThat(AnnotationKind.LENGTH.geometryType(Space.WORLD)).contains(PlaneShape.class);
        assertThat(AnnotationKind.ELLIPSE_ROI.geometryType(Space.WORLD)).contains(PlaneShape.class);
        assertThat(AnnotationKind.RECTANGLE_ROI.geometryType(Space.IMAGE)).isEmpty();
        assertThat(AnnotationKind.RECTANGLE.geometryType(Space.WORLD)).isEmpty();
        assertThat(AnnotationKind.ARROW.geometryType(Space.WORLD)).isEmpty();
    }

    @Test
    void rectangleWithinTheImageIsValidUpToItsEdges() {
        assertThatCode(() -> new Rectangle(0.0, 0.0, 400.0, 300.0).validate(AnnotationKind.RECTANGLE, IMAGE))
                .doesNotThrowAnyException();
        assertThat(new Rectangle(10.0, 20.0, 30.0, 40.0).area(IMAGE)).hasValue(1200);
        assertThat(new Rectangle(10.0, 20.0, 30.0, 40.0).area(CALIBRATED)).hasValueCloseTo(120.0, within(1e-9));
    }

    @Test
    void rectangleOutsideTheImageOrEmptyIsRejected() {
        assertInvalid(new Rectangle(350.0, 10.0, 60.0, 10.0), AnnotationKind.RECTANGLE, IMAGE, "outside the image");
        assertInvalid(new Rectangle(-1.0, 10.0, 6.0, 10.0), AnnotationKind.RECTANGLE, IMAGE, "outside the image");
        assertInvalid(new Rectangle(10.0, 10.0, 0.0, 10.0), AnnotationKind.RECTANGLE, IMAGE, "must be positive");
        assertInvalid(new Rectangle(10.0, null, 5.0, 10.0), AnnotationKind.RECTANGLE, IMAGE, "geometry.y must be a finite");
        assertInvalid(new Rectangle(Double.NaN, 1.0, 5.0, 10.0), AnnotationKind.RECTANGLE, IMAGE, "geometry.x");
    }

    @Test
    void polygonHas3To200PointsInsideTheImageAndAnArea() {
        Polygon triangle = new Polygon(List.of(List.of(0.0, 0.0), List.of(40.0, 0.0), List.of(0.0, 30.0)));
        assertThatCode(() -> triangle.validate(AnnotationKind.POLYGON, IMAGE)).doesNotThrowAnyException();
        assertThat(triangle.area(IMAGE)).hasValue(600);

        assertInvalid(new Polygon(List.of(List.of(0.0, 0.0), List.of(1.0, 1.0))), AnnotationKind.POLYGON, IMAGE,
                "3 to 200 points");
        List<List<Double>> many = new ArrayList<>();
        for (int i = 0; i < 201; i++) {
            many.add(List.of((double) i, (double) (i % 2)));
        }
        assertInvalid(new Polygon(many), AnnotationKind.POLYGON, IMAGE, "3 to 200 points");
        assertInvalid(new Polygon(List.of(List.of(0.0, 0.0), List.of(10.0, 10.0), List.of(20.0, 20.0))),
                AnnotationKind.POLYGON, IMAGE, "one line");
        assertInvalid(new Polygon(List.of(List.of(0.0, 0.0), List.of(10.0, 0.0), List.of(10.0, 301.0))),
                AnnotationKind.POLYGON, IMAGE, "geometry.points[2] is outside");
        assertInvalid(new Polygon(List.of(List.of(0.0, 0.0), List.of(10.0), List.of(10.0, 30.0))),
                AnnotationKind.POLYGON, IMAGE, "geometry.points[1] must be [x, y]");
    }

    @Test
    void arrowAndLengthJoinTwoDifferentPointsInsideTheImage() {
        assertThatCode(() -> new Arrow(List.of(1.0, 1.0), List.of(50.0, 60.0), "nodule")
                .validate(AnnotationKind.ARROW, IMAGE)).doesNotThrowAnyException();
        assertInvalid(new Arrow(List.of(1.0, 1.0), List.of(1.0, 1.0), null), AnnotationKind.ARROW, IMAGE,
                "different points");
        assertInvalid(new Arrow(List.of(1.0, 1.0), List.of(5.0, 1.0), "t".repeat(101)), AnnotationKind.ARROW, IMAGE,
                "geometry.text");
        assertInvalid(new Line(List.of(1.0, 1.0), List.of(401.0, 1.0)), AnnotationKind.LENGTH, IMAGE, "geometry.to");
        assertInvalid(new Line(null, List.of(4.0, 1.0)), AnnotationKind.LENGTH, IMAGE, "geometry.from");
    }

    @Test
    void lengthIsInPixelsOrInMillimetresWhenCalibrated() {
        Line line = new Line(List.of(0.0, 0.0), List.of(30.0, 40.0));

        assertThat(line.length(IMAGE)).hasValue(50);
        assertThat(line.length(CALIBRATED)).hasValueCloseTo(Math.hypot(6, 20), within(1e-9));
    }

    @Test
    void volumeRoiHasFourPointsInTheViewPlane() {
        PlaneShape ellipse = ellipse(-40.5);

        assertThatCode(() -> ellipse.validate(AnnotationKind.ELLIPSE_ROI, VOLUME)).doesNotThrowAnyException();
        assertThat(ellipse.length(VOLUME)).isEmpty();
        assertInvalid(ellipse, AnnotationKind.LENGTH, VOLUME, "must have 2 points");
    }

    @Test
    void volumePointsOutsideTheViewPlaneAreRejected() {
        List<List<Double>> points = new ArrayList<>(ellipse(-40.5).points());
        points.set(3, List.of(10.0, 0.0, -39.0));

        assertInvalid(new PlaneShape(points, AXIAL, UP, null), AnnotationKind.ELLIPSE_ROI, VOLUME,
                "geometry.points[3] is not in the view plane");
    }

    @Test
    void viewVectorsAreUnitAndPerpendicular() {
        List<List<Double>> points = ellipse(0).points();

        assertInvalid(new PlaneShape(points, List.of(0.0, 0.0, 2.0), UP, null), AnnotationKind.ELLIPSE_ROI, VOLUME,
                "viewPlaneNormal must be a unit vector");
        assertInvalid(new PlaneShape(points, AXIAL, AXIAL, null), AnnotationKind.ELLIPSE_ROI, VOLUME, "perpendicular");
        assertInvalid(new PlaneShape(points, AXIAL, List.of(0.0, -1.0), null), AnnotationKind.ELLIPSE_ROI, VOLUME,
                "geometry.viewUp must be [x, y, z]");
    }

    @Test
    void sliceIndexIsWithinTheVolume() {
        List<List<Double>> points = ellipse(0).points();

        assertThatCode(() -> new PlaneShape(points, AXIAL, UP, 511).validate(AnnotationKind.ELLIPSE_ROI, VOLUME))
                .doesNotThrowAnyException();
        assertInvalid(new PlaneShape(points, AXIAL, UP, 512), AnnotationKind.ELLIPSE_ROI, VOLUME, "sliceIndex");
        assertInvalid(new PlaneShape(points, AXIAL, UP, -1), AnnotationKind.ELLIPSE_ROI, VOLUME, "sliceIndex");
    }

    @Test
    void volumeLengthIsTheDistanceBetweenItsEnds() {
        PlaneShape length = new PlaneShape(List.of(List.of(0.0, 0.0, 5.0), List.of(3.0, 4.0, 5.0)), AXIAL, UP, null);

        assertThatCode(() -> length.validate(AnnotationKind.LENGTH, VOLUME)).doesNotThrowAnyException();
        assertThat(length.length(VOLUME)).hasValue(5);
        assertInvalid(new PlaneShape(List.of(List.of(1.0, 1.0, 5.0), List.of(1.0, 1.0, 5.0)), AXIAL, UP, null),
                AnnotationKind.LENGTH, VOLUME, "same point");
        assertInvalid(new PlaneShape(List.of(List.of(1.0, 1.0, 5.0), Arrays.asList(1.0, null, 5.0)), AXIAL, UP, null),
                AnnotationKind.LENGTH, VOLUME, "geometry.points[1][1] must be a finite number");
    }

    /** An axial ellipse at z: bottom, top, left, right handles, as Cornerstone stores them. */
    private static PlaneShape ellipse(double z) {
        return new PlaneShape(List.of(List.of(0.0, 10.0, z), List.of(0.0, -10.0, z), List.of(-15.0, 0.0, z),
                List.of(15.0, 0.0, z)), AXIAL, UP, 40);
    }

    private static void assertInvalid(Geometry geometry, AnnotationKind kind, SeriesFrame frame, String message) {
        assertThatThrownBy(() -> geometry.validate(kind, frame))
                .isInstanceOf(InvalidAnnotationException.class)
                .hasMessageContaining(message);
    }
}
