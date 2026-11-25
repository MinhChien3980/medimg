"""Real TotalSegmentator run (weights baked into the Docker image).

Uses `MEDIMG_SAMPLE_CT` (a CT NIfTI, e.g. from `tools/fetch_samples.py`) when set, otherwise a
small synthetic torso. Run: pytest -m slow -s
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

pytest.importorskip("totalsegmentator")

from worker.ingest.volume import canonical_volume
from worker.pipelines.ct_labels import LABELS
from worker.pipelines.ct_totalseg import CtTotalSegPipeline
from worker.pipelines.totalseg_runner import TotalSegmentatorRunner

pytestmark = pytest.mark.slow

if not TotalSegmentatorRunner.weights_folder().is_dir():
    pytest.skip("TotalSegmentator weights not downloaded", allow_module_level=True)

runner = TotalSegmentatorRunner("cpu")


def synthetic_torso(path: Path) -> None:
    """Air around an elliptic soft-tissue body with two lungs, a liver and a spine column."""
    shape, spacing = (110, 90, 70), 3.0
    x, y, z = np.meshgrid(*(np.arange(n) for n in shape), indexing="ij")
    cx, cy = shape[0] / 2, shape[1] / 2
    data = np.full(shape, -1000, dtype=np.int16)
    body = ((x - cx) / 48) ** 2 + ((y - cy) / 36) ** 2 < 1
    data[body] = 40
    upper = z > 35
    data[body & upper & ((((x - cx + 22) / 15) ** 2 + ((y - cy - 3) / 22) ** 2) < 1)] = -850
    data[body & upper & ((((x - cx - 22) / 15) ** 2 + ((y - cy - 3) / 22) ** 2) < 1)] = -850
    data[body & ~upper & ((((x - cx + 15) / 20) ** 2 + ((y - cy - 5) / 18) ** 2) < 1)] = 60
    data[((x - cx) / 5) ** 2 + ((y - cy + 25) / 5) ** 2 < 1] = 700
    affine = np.diag([spacing, spacing, spacing, 1.0])
    affine[:3, 3] = -np.asarray(shape) * spacing / 2
    nib.save(canonical_volume(data, affine, "CT"), path)


@pytest.fixture(scope="module")
def volume_path(tmp_path_factory) -> tuple[Path, bool]:
    sample = os.environ.get("MEDIMG_SAMPLE_CT")
    if sample:
        return Path(sample), True
    path = tmp_path_factory.mktemp("ct") / "volume.nii.gz"
    synthetic_torso(path)
    return path, False


def test_real_segmentation_meshes_and_grid(volume_path, tmp_path):
    path, real = volume_path
    progress: list[int] = []
    t0 = time.perf_counter()
    out = CtTotalSegPipeline(runner).run_file(path, {}, progress.append, tmp_path)
    elapsed = time.perf_counter() - t0
    glb_bytes = sum(m.path.stat().st_size for m in out.meshes)
    print(
        f"\n[ct-totalseg] {path.name}: {elapsed:.1f} s, {len(out.meshes)} meshes, "
        f"{sum(m.triangles for m in out.meshes)} triangles, {glb_bytes / 1e6:.1f} MB GLB"
    )

    assert progress == [20, 70, 90]
    volume = nib.load(path)
    seg = nib.load(out.segmentation)
    assert seg.shape == volume.shape
    np.testing.assert_allclose(seg.affine, volume.affine)
    labels = np.asanyarray(seg.dataobj)
    assert labels.dtype == np.uint8
    assert int(labels.max()) <= len(LABELS)
    assert [f.label for f in out.findings] == [m.label for m in out.meshes]
    assert all(f.volume_ml is not None and f.volume_ml >= 1.0 for f in out.findings)
    assert all(0 < m.triangles <= 50_000 for m in out.meshes)
    if real:
        found = {f.label for f in out.findings}
        assert {"liver", "spleen", "lung_left", "lung_right", "heart", "aorta", "spine"} <= found
        assert len(found) >= 10
