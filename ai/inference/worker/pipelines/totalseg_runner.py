"""Seam around TotalSegmentator, so the `ct-totalseg` pipeline can be tested without the model.

`Segmenter.segment` takes the canonical volume and returns TotalSegmentator `total` class ids
(uint8) with the same shape and affine.
"""

from __future__ import annotations

import contextlib
import logging
import math
import multiprocessing
import os
import threading
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Protocol

import nibabel as nib
import numpy as np

from worker.errors import BadInputError

log = logging.getLogger(__name__)

TOTALSEG_VERSION = "2.18.0"
FAST_TASK_ID = 297  # nnU-Net Dataset297_TotalSegmentator_total_3mm (`total`, --fast)
FAST_SPACING_MM = 3.0
MAX_GRID_VOXELS = 6_500_000
"""Largest 3 mm grid accepted (e.g. 500 x 500 x 700 mm). Measured on CPU: the 3D U-Net needs
~3.6 GB for its per-patch activations whatever the volume, plus ~0.2 KB per grid voxel for the
logits of its 118 outputs (1.8 M voxels -> 4.1 GB peak, 5.3 M -> 5.1 GB for the whole ai-worker).
Past the cap the worker would be OOM-killed under its 6 GB limit and the job redelivered after
every restart, so it is refused."""


class Segmenter(Protocol):
    @property
    def class_map(self) -> Mapping[int, str]:
        """TotalSegmentator class id -> class name."""
        ...

    @property
    def ready(self) -> bool: ...

    def prepare(self) -> None:
        """Import the model code and check that the weights are present."""
        ...

    def segment(self, volume: nib.Nifti1Image) -> np.ndarray: ...


def available_cpus() -> int:
    """CPUs this process may use: the cgroup v2 quota (`docker --cpus`) when set, else affinity."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            return max(1, math.ceil(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except AttributeError:  # not Linux
        return max(1, os.cpu_count() or 1)


@contextlib.contextmanager
def _cpu_count(n: int) -> Iterator[None]:
    """nnU-Net sets torch's thread count to `multiprocessing.cpu_count()`, which is the host's CPU
    count inside a container: on a 16-core host limited to 4 CPUs that oversubscribes 4x."""
    original = multiprocessing.cpu_count
    multiprocessing.cpu_count = lambda: n
    try:
        yield
    finally:
        multiprocessing.cpu_count = original


def grid_voxels(volume: nib.Nifti1Image, spacing_mm: float = FAST_SPACING_MM) -> int:
    extent = np.asarray(volume.shape[:3]) * np.asarray(volume.header.get_zooms()[:3])
    return int(np.prod(np.ceil(extent / spacing_mm)))


class TotalSegmentatorRunner:
    """TotalSegmentator 2.18.0 `total --fast` (3 mm) through its Python API, fully offline: the
    weights are baked into the image and usage statistics are disabled in its config."""

    def __init__(
        self,
        device_kind: str = "cpu",
        threads: int | None = None,
        max_grid_voxels: int = MAX_GRID_VOXELS,
    ) -> None:
        self._device_kind = device_kind
        self._threads = threads
        self._max_grid_voxels = max_grid_voxels
        self._lock = threading.Lock()
        self._ready = False

    @property
    def class_map(self) -> Mapping[int, str]:
        from totalsegmentator.map_to_binary import class_map

        return class_map["total"]

    @property
    def ready(self) -> bool:
        return self._ready

    @staticmethod
    def weights_folder() -> Path:
        from totalsegmentator.config import get_weights_dir
        from totalsegmentator.map_tasks_config import TASK_ID_WEIGHTS_CONFIGS

        return get_weights_dir() / TASK_ID_WEIGHTS_CONFIGS[FAST_TASK_ID]["foldername"]

    def prepare(self) -> None:
        with self._lock:
            if self._ready:
                return
            folder = self.weights_folder()
            if not folder.is_dir():
                raise RuntimeError(f"TotalSegmentator weights not found in {folder}")
            import totalsegmentator.python_api  # noqa: F401  (torch + nnU-Net, a few seconds)

            self._ready = True

    def device(self) -> str:
        if self._device_kind == "gpu":
            import torch

            if torch.cuda.is_available():
                return "gpu"
        return "cpu"

    def segment(self, volume: nib.Nifti1Image) -> np.ndarray:
        from totalsegmentator.python_api import totalsegmentator

        grid = grid_voxels(volume)
        if grid > self._max_grid_voxels:
            extent = np.asarray(volume.shape[:3]) * np.asarray(volume.header.get_zooms()[:3])
            raise BadInputError(
                "the field of view is too large for CPU segmentation "
                f"({' x '.join(f'{e:.0f}' for e in extent)} mm; at most about "
                f"{self._max_grid_voxels * FAST_SPACING_MM**3 / 1e6:.0f} litres)"
            )
        self.prepare()
        threads = self._threads or available_cpus()
        log.info(
            "running TotalSegmentator",
            extra={"device": self.device(), "threads": threads, "gridVoxels": grid},
        )
        with _cpu_count(threads):
            result = totalsegmentator(
                volume,
                None,
                ml=True,
                fast=True,
                task="total",
                device=self.device(),
                nr_thr_resamp=1,
                nr_thr_saving=1,
                quiet=True,
            )
        labels = np.asanyarray(result.dataobj)
        if labels.shape != volume.shape[:3] or not np.allclose(result.affine, volume.affine):
            raise RuntimeError("TotalSegmentator output does not match the input grid")
        return labels.astype(np.uint8, copy=False)
