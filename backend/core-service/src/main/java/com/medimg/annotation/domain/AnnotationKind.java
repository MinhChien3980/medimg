package com.medimg.annotation.domain;

import java.util.Optional;

import com.medimg.annotation.domain.SeriesFrame.Space;

/**
 * RECTANGLE, POLYGON and ARROW are drawn on 2D images, RECTANGLE_ROI and ELLIPSE_ROI on volumes (the Cornerstone
 * tools of the same name), LENGTH on both.
 */
public enum AnnotationKind {
    RECTANGLE, POLYGON, ARROW, LENGTH, RECTANGLE_ROI, ELLIPSE_ROI;

    /** The geometry of this kind on a frame of the given space; empty if the kind is not drawn there. */
    public Optional<Class<? extends Geometry>> geometryType(Space space) {
        boolean image = space == Space.IMAGE;
        return Optional.ofNullable(switch (this) {
            case RECTANGLE -> image ? Geometry.Rectangle.class : null;
            case POLYGON -> image ? Geometry.Polygon.class : null;
            case ARROW -> image ? Geometry.Arrow.class : null;
            case LENGTH -> image ? Geometry.Line.class : Geometry.PlaneShape.class;
            case RECTANGLE_ROI, ELLIPSE_ROI -> image ? null : Geometry.PlaneShape.class;
        });
    }

    /** Points of a volume annotation, as Cornerstone stores them: the 4 handles of a ROI, the 2 ends of a length. */
    int planePoints() {
        return this == LENGTH ? 2 : 4;
    }
}
