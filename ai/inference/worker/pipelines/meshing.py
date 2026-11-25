"""Labelmap -> one GLB surface mesh per label, in patient LPS millimetres.

Per label: crop the mask to its bounding box (+1 voxel of background so the surface closes at the
volume border) -> marching cubes at 0.5 in voxel index space -> voxel indices to LPS mm through
the NIfTI affine -> Taubin smoothing (low shrinkage) -> quadric decimation to at most
`max_triangles` -> GLB. The centroid is the centre of mass of the label's voxels, so it does not
depend on smoothing or decimation.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import fast_simplification
import numpy as np
import trimesh
from skimage.measure import marching_cubes
from trimesh.visual.material import PBRMaterial

from worker.geometry import apply_affine, lps_affine, voxel_volume_ml


@dataclass(frozen=True)
class MeshOptions:
    smoothing_iterations: int = 100
    """Single passes, alternating shrink (lambda) and inflate (nu): 100 = 50 Taubin steps. Enough to
    round off the 3 mm steps of TotalSegmentator --fast masks resampled to the CT grid; measured
    on a real case, label volumes stay within 3 % and no label splits or merges (a Gaussian
    pre-blur smooths more but erodes ribs and adrenal glands)."""
    smoothing_lambda: float = 0.5
    smoothing_nu: float = 0.52
    """trimesh's inflate factor (positive; Taubin's mu = -nu). 1/lambda - 1/nu = 0.077 keeps the
    pass band in trimesh's recommended (0, 0.1), so the volume is preserved."""
    max_triangles: int = 50_000


@dataclass(frozen=True)
class LabelSurface:
    mesh: trimesh.Trimesh
    """Vertices in patient LPS mm, faces wound so that normals point outwards."""
    centroid: tuple[float, float, float]
    volume_ml: float
    voxels: int


def label_surface(
    mask: np.ndarray,
    ras_affine: np.ndarray,
    options: MeshOptions,
    offset: tuple[int, int, int] = (0, 0, 0),
) -> LabelSurface:
    """Surface of a non-empty boolean mask. `mask[0, 0, 0]` is voxel `offset` of the volume whose
    voxel -> RAS mm map is `ras_affine` (pass a crop of the labelmap to save work)."""
    coords = np.argwhere(mask)
    if coords.size == 0:
        raise ValueError("empty mask")
    lo = coords.min(axis=0)
    hi = coords.max(axis=0) + 1
    coords += np.asarray(offset)
    crop = np.pad(mask[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]], 1).astype(np.float32)

    verts, faces, _, _ = marching_cubes(crop, level=0.5, allow_degenerate=False)
    verts += lo + np.asarray(offset) - 1  # back to volume voxel indices (undo crop and padding)

    affine = lps_affine(ras_affine)
    mesh = trimesh.Trimesh(apply_affine(affine, verts), faces, process=True)
    if mesh.volume < 0:  # winding depends on skimage's convention and the affine's handedness
        mesh.invert()
    trimesh.smoothing.filter_taubin(
        mesh,
        lamb=options.smoothing_lambda,
        nu=options.smoothing_nu,
        iterations=options.smoothing_iterations,
    )
    mesh = decimate(mesh, options.max_triangles)

    centroid = apply_affine(affine, coords.mean(axis=0, keepdims=True))[0]
    return LabelSurface(
        mesh=mesh,
        centroid=(float(centroid[0]), float(centroid[1]), float(centroid[2])),
        volume_ml=len(coords) * voxel_volume_ml(ras_affine),
        voxels=len(coords),
    )


def decimate(mesh: trimesh.Trimesh, max_triangles: int) -> trimesh.Trimesh:
    target = max_triangles
    while len(mesh.faces) > max_triangles:
        points, faces = fast_simplification.simplify(
            np.asarray(mesh.vertices, dtype=np.float64),
            np.asarray(mesh.faces, dtype=np.int32),
            target_count=target,
        )
        mesh = trimesh.Trimesh(points, faces, process=True)
        target = int(target * 0.9)  # quadric decimation may stop a little above its target
    return mesh


def hex_to_rgba(color: str) -> list[int]:
    return [int(color[i : i + 2], 16) for i in (1, 3, 5)] + [255]


def export_glb(mesh: trimesh.Trimesh, color: str, name: str, path: Path) -> None:
    """Binary glTF with vertex normals and a matte material in the label colour. Coordinates are
    written as they are (no glTF Y-up conversion): the scene is in patient LPS mm."""
    mesh = mesh.copy()
    mesh.visual = trimesh.visual.TextureVisuals(
        material=PBRMaterial(
            name=name, baseColorFactor=hex_to_rgba(color), metallicFactor=0.0, roughnessFactor=0.7
        )
    )
    scene = trimesh.Scene()
    scene.add_geometry(mesh, node_name=name, geom_name=name)
    path.write_bytes(trimesh.exchange.gltf.export_glb(scene, include_normals=True))
