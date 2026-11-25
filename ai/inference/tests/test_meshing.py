"""Mesh coordinates must land on the same patient point as the MPR (Cornerstone3D, LPS mm)."""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest

from worker.geometry import apply_affine, lps_affine, voxel_volume_ml
from worker.pipelines.meshing import MeshOptions, decimate, export_glb, label_surface

SPACING = (0.8, 0.9, 2.5)
ORIGIN_RAS = (-120.0, 40.0, -310.0)
CUBE = (slice(10, 20), slice(5, 15), slice(3, 13))  # 10 x 10 x 10 voxels


def diagonal_affine() -> np.ndarray:
    affine = np.diag([*SPACING, 1.0])
    affine[:3, 3] = ORIGIN_RAS
    return affine


def rotated_affine(degrees: float = 25.0) -> np.ndarray:
    a = np.radians(degrees)
    rotation = np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])
    affine = np.eye(4)
    affine[:3, :3] = rotation @ np.diag(SPACING)
    affine[:3, 3] = ORIGIN_RAS
    return affine


def cube_mask(shape=(40, 30, 20)) -> np.ndarray:
    mask = np.zeros(shape, dtype=bool)
    mask[CUBE] = True
    return mask


def cornerstone_world(ras_affine: np.ndarray, ijk) -> np.ndarray:
    """What Cornerstone3D computes for a NIfTI voxel: RAS affine, then x and y negated."""
    x, y, z = (ras_affine @ np.array([*ijk, 1.0]))[:3]
    return np.array([-x, -y, z])


@pytest.mark.parametrize("affine", [diagonal_affine(), rotated_affine()], ids=["axis", "oblique"])
def test_cube_centroid_is_the_cornerstone_world_point(affine):
    surface = label_surface(cube_mask(), affine, MeshOptions())
    center_ijk = [(s.start + s.stop - 1) / 2 for s in CUBE]  # 14.5, 9.5, 7.5
    np.testing.assert_allclose(surface.centroid, cornerstone_world(affine, center_ijk), atol=1e-9)
    np.testing.assert_allclose(surface.mesh.centroid, surface.centroid, atol=0.5)


def test_cube_mesh_bounds_in_lps_mm():
    affine = diagonal_affine()
    surface = label_surface(cube_mask(), affine, MeshOptions())
    # The surface at level 0.5 runs half a voxel outside the outermost voxel centres.
    lo = cornerstone_world(affine, [s.start - 0.5 for s in CUBE])
    hi = cornerstone_world(affine, [s.stop - 0.5 for s in CUBE])
    expected_min, expected_max = np.minimum(lo, hi), np.maximum(lo, hi)
    # LPS: x = -(RAS x), so the cube lies at negative-of-RAS x and y.
    assert expected_max[0] == pytest.approx(-(ORIGIN_RAS[0] + 9.5 * SPACING[0]))
    bounds = surface.mesh.bounds
    tolerance = np.asarray(SPACING) * 0.6  # Taubin smoothing rounds the corners slightly
    assert np.all(np.abs(bounds[0] - expected_min) <= tolerance)
    assert np.all(np.abs(bounds[1] - expected_max) <= tolerance)


def test_volume_ml_is_voxel_count_times_voxel_volume():
    affine = rotated_affine()
    surface = label_surface(cube_mask(), affine, MeshOptions())
    assert surface.voxels == 1000
    assert surface.volume_ml == pytest.approx(1000 * 0.8 * 0.9 * 2.5 / 1000)
    assert voxel_volume_ml(affine) == pytest.approx(0.8 * 0.9 * 2.5 / 1000)


@pytest.mark.parametrize("flip", [False, True], ids=["ras", "mirrored-affine"])
def test_mesh_is_closed_and_outward_facing(flip):
    affine = diagonal_affine()
    if flip:
        affine[0] *= -1  # left-handed voxel axes
    mesh = label_surface(cube_mask(), affine, MeshOptions()).mesh
    assert mesh.is_watertight
    assert mesh.volume > 0  # positive signed volume = faces wound outwards
    radial = mesh.triangles_center - mesh.centroid
    assert np.all(np.einsum("ij,ij->i", mesh.face_normals, radial) > 0)  # convex: all outwards


def test_smoothed_sphere_keeps_its_volume():
    zz, yy, xx = np.mgrid[:40, :40, :40]
    sphere = (xx - 20) ** 2 + (yy - 20) ** 2 + (zz - 20) ** 2 < 14**2
    surface = label_surface(sphere, diagonal_affine(), MeshOptions())
    voxel_mm3 = surface.volume_ml * 1000
    assert surface.mesh.volume == pytest.approx(voxel_mm3, rel=0.01)


def test_mask_touching_the_volume_border_is_still_closed():
    mask = np.zeros((12, 12, 12), dtype=bool)
    mask[:5, :, 4:9] = True
    surface = label_surface(mask, diagonal_affine(), MeshOptions())
    assert surface.mesh.is_watertight


def test_crop_offset_gives_the_same_surface():
    affine = diagonal_affine()
    full = label_surface(cube_mask(), affine, MeshOptions())
    crop = cube_mask()[8:22, 3:17, 1:15]
    cropped = label_surface(crop, affine, MeshOptions(), offset=(8, 3, 1))
    np.testing.assert_allclose(cropped.centroid, full.centroid)
    np.testing.assert_allclose(cropped.mesh.bounds, full.mesh.bounds, atol=1e-9)


def test_decimation_caps_triangles():
    yy, xx, zz = np.mgrid[:60, :60, :60]
    sphere = (xx - 30) ** 2 + (yy - 30) ** 2 + (zz - 30) ** 2 < 25**2
    surface = label_surface(sphere, np.eye(4), MeshOptions(max_triangles=2_000))
    assert 0 < len(surface.mesh.faces) <= 2_000
    raw = label_surface(sphere, np.eye(4), MeshOptions(max_triangles=10**9))
    assert len(raw.mesh.faces) > 2_000
    assert len(decimate(raw.mesh, 500).faces) <= 500


def read_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, _ = struct.unpack_from("<4sII", data, 0)
    assert (magic, version) == (b"glTF", 2)
    json_len, json_type = struct.unpack_from("<I4s", data, 12)
    assert json_type == b"JSON"
    gltf = json.loads(data[20 : 20 + json_len])
    bin_len, bin_type = struct.unpack_from("<I4s", data, 20 + json_len)
    assert bin_type == b"BIN\x00"
    return gltf, data[28 + json_len : 28 + json_len + bin_len]


def test_glb_stores_lps_coordinates_untransformed(tmp_path):
    affine = diagonal_affine()
    surface = label_surface(cube_mask(), affine, MeshOptions())
    path = tmp_path / "liver.glb"
    export_glb(surface.mesh, "#C0573E", "liver", path)

    gltf, binary = read_glb(path.read_bytes())
    for node in gltf["nodes"]:
        assert not {"matrix", "rotation", "scale", "translation"} & set(node)
    primitive = gltf["meshes"][0]["primitives"][0]
    position = gltf["accessors"][primitive["attributes"]["POSITION"]]
    np.testing.assert_allclose(position["min"], surface.mesh.bounds[0], atol=1e-4)
    np.testing.assert_allclose(position["max"], surface.mesh.bounds[1], atol=1e-4)
    assert "NORMAL" in primitive["attributes"]

    view = gltf["bufferViews"][position["bufferView"]]
    start = view.get("byteOffset", 0) + position.get("byteOffset", 0)
    vertices = np.frombuffer(binary, np.float32, position["count"] * 3, start).reshape(-1, 3)
    np.testing.assert_allclose(vertices.mean(axis=0), surface.mesh.vertices.mean(axis=0), atol=1e-3)

    material = gltf["materials"][primitive["material"]]
    color = material["pbrMetallicRoughness"]["baseColorFactor"]
    np.testing.assert_allclose(color[:3], [0xC0 / 255, 0x57 / 255, 0x3E / 255], atol=1e-3)


def test_apply_affine_matches_homogeneous_multiplication():
    affine = lps_affine(rotated_affine())
    points = np.array([[0, 0, 0], [1.5, 2.0, -3.0]])
    expected = (affine @ np.c_[points, np.ones(2)].T).T[:, :3]
    np.testing.assert_allclose(apply_affine(affine, points), expected)
