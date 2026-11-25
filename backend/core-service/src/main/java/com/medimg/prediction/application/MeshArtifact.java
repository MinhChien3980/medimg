package com.medimg.prediction.application;

import java.util.List;

/** Entry of the mesh manifest stored with a result; {@code key} is the bucket-relative key of the GLB file. */
record MeshArtifact(String label, String color, String key, Integer triangles, Double volumeMl, List<Double> centroid) {
}
