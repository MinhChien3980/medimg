package com.medimg.annotation.domain;

import java.util.Collections;
import java.util.List;

/**
 * The image or volume an annotation is drawn on. On a 2D image ({@link Space#IMAGE}) coordinates are image pixels,
 * origin top-left, x to the right and y down, and {@code pixelSpacing} ({@code [x, y]} mm) is known for a calibrated
 * image only. On a volume ({@link Space#WORLD}) coordinates are patient LPS millimetres, like the meshes.
 */
public record SeriesFrame(Space space, int width, int height, int depth, List<Double> pixelSpacing) {

    public enum Space { IMAGE, WORLD }

    public static SeriesFrame image(int width, int height, List<Double> pixelSpacing) {
        return new SeriesFrame(Space.IMAGE, width, height, 1, pixelSpacing);
    }

    /** {@code dims} is {@code [x, y, z]} voxels. */
    public static SeriesFrame volume(List<Integer> dims) {
        return new SeriesFrame(Space.WORLD, dims.get(0), dims.get(1), dims.get(2), null);
    }

    /** True when lengths and areas are measured in millimetres, false when in pixels (an uncalibrated image). */
    public boolean calibrated() {
        return space == Space.WORLD || pixelSpacing != null;
    }

    /** Size in mm of a pixel along x on a 2D image; 1 when uncalibrated, so that measurements stay in pixels. */
    double scaleX() {
        return pixelSpacing == null ? 1 : pixelSpacing.get(0);
    }

    double scaleY() {
        return pixelSpacing == null ? 1 : pixelSpacing.get(1);
    }

    /** The largest slice index of any view of the volume (axial, coronal, sagittal) plus one. */
    int maxSlices() {
        return Collections.max(List.of(width, height, depth));
    }
}
