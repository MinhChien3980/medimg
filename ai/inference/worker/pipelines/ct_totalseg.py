"""`ct-totalseg`: TotalSegmentator `total --fast` merged into 21 organ labels, plus meshes.

- Input: the normalised volume written by the ingest worker (`volume.nii.gz`: int16 HU,
  canonical RAS).
- Output: `segmentation.nii.gz` (uint8, voxel value = label index + 1, same shape and affine as
  the input), one finding per label of at least 1 ml (`confidence: null`, `volumeMl`), and one
  GLB mesh per such label in patient LPS mm. Labels under 1 ml are dropped everywhere, so the
  labelmap, findings and meshes always list the same organs.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
from scipy import ndimage

from worker.errors import BadInputError
from worker.geometry import voxel_volume_ml
from worker.pipelines.base import Finding, MeshArtifact, PipelineOutput, ProgressCallback
from worker.pipelines.ct_labels import LABELS, merge_lut
from worker.pipelines.meshing import MeshOptions, export_glb, label_surface
from worker.pipelines.totalseg_runner import TOTALSEG_VERSION, Segmenter

log = logging.getLogger(__name__)

MIN_VOLUME_ML = 1.0
PROGRESS_PREPROCESSED = 20
PROGRESS_SEGMENTED = 70
PROGRESS_MESHED = 90


def load_volume(path: Path) -> nib.Nifti1Image:
    try:
        img = nib.load(path)
        if len(img.shape) != 3:
            raise BadInputError(f"expected a 3D volume, got shape {img.shape}")
        data = np.asanyarray(img.dataobj)
    except BadInputError:
        raise
    except Exception as exc:
        raise BadInputError(f"cannot read the input volume: {exc}") from exc
    return nib.Nifti1Image(data, img.affine, img.header)


def write_labelmap(labels: np.ndarray, volume: nib.Nifti1Image, path: Path) -> None:
    """uint8 labelmap on exactly the volume's grid: same shape, affine, qform and sform."""
    header = volume.header.copy()
    header.set_data_dtype(np.uint8)
    header.set_slope_inter(None, None)
    header["descrip"] = b""
    seg = nib.Nifti1Image(labels.astype(np.uint8, copy=False), volume.affine, header)
    seg.set_qform(volume.affine, code=int(volume.header["qform_code"]) or 1)
    seg.set_sform(volume.affine, code=int(volume.header["sform_code"]) or 1)
    nib.save(seg, path)


class CtTotalSegPipeline:
    model_code = "ct-totalseg"
    model_version = f"{TOTALSEG_VERSION}-fast"

    def __init__(self, segmenter: Segmenter, mesh_options: MeshOptions | None = None) -> None:
        self._segmenter = segmenter
        self._mesh_options = mesh_options or MeshOptions()

    @property
    def loaded(self) -> bool:
        return self._segmenter.ready

    def warmup(self) -> None:
        self._segmenter.prepare()

    def run_file(
        self,
        input_path: Path,
        params: dict[str, Any],
        progress_cb: ProgressCallback,
        workdir: Path,
    ) -> PipelineOutput:
        volume = load_volume(input_path)
        lut = merge_lut(self._segmenter.class_map)
        progress_cb(PROGRESS_PREPROCESSED)

        raw = self._segmenter.segment(volume)
        if raw.shape != volume.shape:
            raise RuntimeError(f"segmenter returned shape {raw.shape} for {volume.shape}")
        labels = lut[raw.astype(np.uint8, copy=False)]
        progress_cb(PROGRESS_SEGMENTED)

        voxel_ml = voxel_volume_ml(volume.affine)
        counts = np.bincount(labels.ravel(), minlength=len(LABELS) + 1)
        present = [v for v in range(1, len(LABELS) + 1) if counts[v] * voxel_ml >= MIN_VOLUME_ML]
        dropped = [v for v in range(1, len(LABELS) + 1) if counts[v] and v not in present]
        if dropped:
            labels[np.isin(labels, dropped)] = 0

        segmentation = workdir / "segmentation.nii.gz"
        write_labelmap(labels, volume, segmentation)

        findings: list[Finding] = []
        meshes: list[MeshArtifact] = []
        mesh_dir = workdir / "meshes"
        mesh_dir.mkdir(exist_ok=True)
        boxes = ndimage.find_objects(labels, max_label=len(LABELS))
        for value in present:
            label = LABELS[value - 1]
            box = boxes[value - 1]
            surface = label_surface(
                labels[box] == value,
                volume.affine,
                self._mesh_options,
                offset=tuple(s.start for s in box),
            )
            volume_ml = round(surface.volume_ml, 2)
            path = mesh_dir / f"{label.name}.glb"
            export_glb(surface.mesh, label.color, label.name, path)
            findings.append(Finding(label=label.name, confidence=None, volume_ml=volume_ml))
            meshes.append(
                MeshArtifact(
                    label=label.name,
                    color=label.color,
                    path=path,
                    triangles=len(surface.mesh.faces),
                    volume_ml=volume_ml,
                    centroid=(
                        round(surface.centroid[0], 2),
                        round(surface.centroid[1], 2),
                        round(surface.centroid[2], 2),
                    ),
                )
            )
        progress_cb(PROGRESS_MESHED)
        log.info(
            "segmentation done",
            extra={"labels": [f.label for f in findings], "droppedSmall": len(dropped)},
        )
        return PipelineOutput(
            model_version=self.model_version,
            findings=findings,
            segmentation=segmentation,
            meshes=meshes,
        )
