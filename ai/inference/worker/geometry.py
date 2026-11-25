"""Voxel <-> patient coordinates.

A NIfTI affine maps voxel indices (i, j, k) to RAS+ millimetres: x grows towards the patient's
Right, y towards Anterior, z towards Superior. DICOM, and therefore Cornerstone3D's world space,
uses LPS+ (Left, Posterior, Superior). The two differ by the sign of x and y:

    LPS = diag(-1, -1, 1) @ RAS
"""

from __future__ import annotations

import numpy as np

LPS_FROM_RAS = np.diag([-1.0, -1.0, 1.0, 1.0])


def lps_affine(ras_affine: np.ndarray) -> np.ndarray:
    """Voxel index -> patient LPS mm, from a NIfTI (RAS) affine."""
    return LPS_FROM_RAS @ np.asarray(ras_affine, dtype=np.float64)


def ras_affine_from_lps(lps: np.ndarray) -> np.ndarray:
    return LPS_FROM_RAS @ np.asarray(lps, dtype=np.float64)


def apply_affine(affine: np.ndarray, points: np.ndarray) -> np.ndarray:
    """(N, 3) voxel coordinates -> (N, 3) world coordinates."""
    pts = np.asarray(points, dtype=np.float64)
    return pts @ affine[:3, :3].T + affine[:3, 3]


def voxel_volume_ml(affine: np.ndarray) -> float:
    """Volume of one voxel in millilitres (1 ml = 1000 mm^3)."""
    return abs(float(np.linalg.det(np.asarray(affine, dtype=np.float64)[:3, :3]))) / 1000.0
