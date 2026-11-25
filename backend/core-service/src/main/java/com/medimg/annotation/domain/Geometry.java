package com.medimg.annotation.domain;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.OptionalDouble;

/**
 * The shape of an annotation, in the coordinates of its {@link SeriesFrame}. The JSON form of each record is its API
 * form: {@code RECTANGLE {x, y, width, height}}, {@code POLYGON {points: [[x, y], ...]}}, {@code ARROW {from: [x, y],
 * to: [x, y], text}}, 2D {@code LENGTH {from, to}} and, on volumes, {@code {points: [[x, y, z], ...],
 * viewPlaneNormal, viewUp, sliceIndex}} — enough for Cornerstone to draw the annotation again on its slice.
 */
public sealed interface Geometry {

    /**
     * Checks the shape against its kind and the image or volume it is drawn on.
     *
     * @throws InvalidAnnotationException naming the offending field
     */
    void validate(AnnotationKind kind, SeriesFrame frame);

    /** The length the shape defines, in mm (or pixels on an uncalibrated image); empty for shapes without one. */
    default OptionalDouble length(SeriesFrame frame) {
        return OptionalDouble.empty();
    }

    /** The area a 2D shape encloses, in mm² (or px² on an uncalibrated image); empty for other shapes. */
    default OptionalDouble area(SeriesFrame frame) {
        return OptionalDouble.empty();
    }

    record Rectangle(Double x, Double y, Double width, Double height) implements Geometry {

        @Override
        public void validate(AnnotationKind kind, SeriesFrame frame) {
            double left = finite(x, "geometry.x");
            double top = finite(y, "geometry.y");
            if (finite(width, "geometry.width") <= 0 || finite(height, "geometry.height") <= 0) {
                throw invalid("geometry.width and geometry.height must be positive");
            }
            requireInImage(new double[] {left, top}, frame, "geometry (x, y)");
            requireInImage(new double[] {left + width, top + height}, frame, "geometry (x + width, y + height)");
        }

        @Override
        public OptionalDouble area(SeriesFrame frame) {
            return OptionalDouble.of(width * height * frame.scaleX() * frame.scaleY());
        }
    }

    record Polygon(List<List<Double>> points) implements Geometry {

        static final int MIN_POINTS = 3;
        static final int MAX_POINTS = 200;

        @Override
        public void validate(AnnotationKind kind, SeriesFrame frame) {
            List<double[]> vertices = Geometry.points(points, 2, MIN_POINTS, MAX_POINTS, "geometry.points");
            for (int i = 0; i < vertices.size(); i++) {
                requireInImage(vertices.get(i), frame, "geometry.points[" + i + "]");
            }
            if (shoelace(vertices) == 0) {
                throw invalid("geometry.points must not all lie on one line");
            }
        }

        @Override
        public OptionalDouble area(SeriesFrame frame) {
            return OptionalDouble.of(shoelace(Geometry.points(points, 2, MIN_POINTS, MAX_POINTS, "geometry.points"))
                    * frame.scaleX() * frame.scaleY());
        }

        private static double shoelace(List<double[]> vertices) {
            double twice = 0;
            for (int i = 0; i < vertices.size(); i++) {
                double[] a = vertices.get(i);
                double[] b = vertices.get((i + 1) % vertices.size());
                twice += a[0] * b[1] - b[0] * a[1];
            }
            return Math.abs(twice) / 2;
        }
    }

    record Arrow(List<Double> from, List<Double> to, String text) implements Geometry {

        static final int MAX_TEXT = 100;

        @Override
        public void validate(AnnotationKind kind, SeriesFrame frame) {
            imageSegment(from, to, frame);
            if (text != null && text.length() > MAX_TEXT) {
                throw invalid("geometry.text must be at most " + MAX_TEXT + " characters");
            }
        }
    }

    /** A 2D LENGTH. */
    record Line(List<Double> from, List<Double> to) implements Geometry {

        @Override
        public void validate(AnnotationKind kind, SeriesFrame frame) {
            imageSegment(from, to, frame);
        }

        @Override
        public OptionalDouble length(SeriesFrame frame) {
            return OptionalDouble.of(Math.hypot((to.get(0) - from.get(0)) * frame.scaleX(),
                    (to.get(1) - from.get(1)) * frame.scaleY()));
        }
    }

    /**
     * A volume annotation: its points (LPS mm) lie in the view plane given by its normal; {@code viewUp} orients the
     * view and {@code sliceIndex}, when given, is the slice of that view.
     */
    record PlaneShape(List<List<Double>> points, List<Double> viewPlaneNormal, List<Double> viewUp, Integer sliceIndex)
            implements Geometry {

        /** Distance from the view plane tolerated for rounding of the client's coordinates. */
        static final double PLANE_TOLERANCE_MM = 0.01;
        static final double UNIT_TOLERANCE = 1e-3;

        @Override
        public void validate(AnnotationKind kind, SeriesFrame frame) {
            int count = kind.planePoints();
            List<double[]> world = Geometry.points(points, 3, count, count, "geometry.points");
            double[] normal = unit(viewPlaneNormal, "geometry.viewPlaneNormal");
            double[] up = unit(viewUp, "geometry.viewUp");
            if (Math.abs(dot(normal, up)) > UNIT_TOLERANCE) {
                throw invalid("geometry.viewUp must be perpendicular to geometry.viewPlaneNormal");
            }
            double[] origin = world.getFirst();
            for (int i = 1; i < world.size(); i++) {
                if (Math.abs(dot(minus(world.get(i), origin), normal)) > PLANE_TOLERANCE_MM) {
                    throw invalid("geometry.points[" + i + "] is not in the view plane of geometry.points[0]");
                }
            }
            if (world.stream().allMatch(p -> Arrays.equals(p, origin))) {
                throw invalid("geometry.points must not all be the same point");
            }
            if (sliceIndex != null && (sliceIndex < 0 || sliceIndex >= frame.maxSlices())) {
                throw invalid("geometry.sliceIndex must be between 0 and " + (frame.maxSlices() - 1));
            }
        }

        /** The distance between the two ends of a LENGTH. */
        @Override
        public OptionalDouble length(SeriesFrame frame) {
            if (points.size() != 2) {
                return OptionalDouble.empty();
            }
            List<double[]> ends = Geometry.points(points, 3, 2, 2, "geometry.points");
            double[] d = minus(ends.get(1), ends.get(0));
            return OptionalDouble.of(Math.sqrt(dot(d, d)));
        }

        private static double[] unit(List<Double> vector, String name) {
            double[] v = point(vector, 3, name);
            if (Math.abs(Math.sqrt(dot(v, v)) - 1) > UNIT_TOLERANCE) {
                throw invalid(name + " must be a unit vector");
            }
            return v;
        }

        private static double dot(double[] a, double[] b) {
            return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        }

        private static double[] minus(double[] a, double[] b) {
            return new double[] {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
        }
    }

    private static void imageSegment(List<Double> from, List<Double> to, SeriesFrame frame) {
        double[] start = point(from, 2, "geometry.from");
        double[] end = point(to, 2, "geometry.to");
        requireInImage(start, frame, "geometry.from");
        requireInImage(end, frame, "geometry.to");
        if (start[0] == end[0] && start[1] == end[1]) {
            throw invalid("geometry.from and geometry.to must be different points");
        }
    }

    private static List<double[]> points(List<List<Double>> points, int dimensions, int min, int max, String name) {
        if (points == null || points.size() < min || points.size() > max) {
            throw invalid(name + (min == max ? " must have " + min : " must have " + min + " to " + max) + " points");
        }
        List<double[]> out = new ArrayList<>(points.size());
        for (int i = 0; i < points.size(); i++) {
            out.add(point(points.get(i), dimensions, name + "[" + i + "]"));
        }
        return out;
    }

    private static double[] point(List<Double> coordinates, int dimensions, String name) {
        if (coordinates == null || coordinates.size() != dimensions) {
            throw invalid(name + " must be " + (dimensions == 2 ? "[x, y]" : "[x, y, z]"));
        }
        double[] out = new double[dimensions];
        for (int i = 0; i < dimensions; i++) {
            out[i] = finite(coordinates.get(i), name + "[" + i + "]");
        }
        return out;
    }

    private static double finite(Double value, String name) {
        if (value == null || !Double.isFinite(value)) {
            throw invalid(name + " must be a finite number");
        }
        return value;
    }

    private static void requireInImage(double[] p, SeriesFrame frame, String name) {
        if (p[0] < 0 || p[1] < 0 || p[0] > frame.width() || p[1] > frame.height()) {
            throw invalid(name + " is outside the image (" + frame.width() + " x " + frame.height() + " px)");
        }
    }

    private static InvalidAnnotationException invalid(String message) {
        return new InvalidAnnotationException(message);
    }
}
