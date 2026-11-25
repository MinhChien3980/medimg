"""The 21 organ labels of `ct-totalseg` and how TotalSegmentator `total` classes merge into them.

Label order is part of the contract: voxel value in `segmentation.nii.gz` = index + 1 (0 =
background). Colours are fixed so every client shows an organ in the same colour.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class OrganLabel:
    name: str
    color: str
    sources: tuple[str, ...]
    """TotalSegmentator `total` class names merged into this label."""


def _range(prefix: str, names: list[str]) -> tuple[str, ...]:
    return tuple(f"{prefix}{n}" for n in names)


_VERTEBRAE = _range("vertebrae_", [f"C{i}" for i in range(1, 8)] + [f"T{i}" for i in range(1, 13)])
_VERTEBRAE += _range("vertebrae_", [f"L{i}" for i in range(1, 6)] + ["S1"])
_RIBS = _range("rib_left_", [str(i) for i in range(1, 13)])
_RIBS += _range("rib_right_", [str(i) for i in range(1, 13)])

LABELS: tuple[OrganLabel, ...] = (
    OrganLabel("liver", "#C0573E", ("liver",)),
    OrganLabel("spleen", "#8E3F8F", ("spleen",)),
    OrganLabel("kidney_left", "#D9A03F", ("kidney_left",)),
    OrganLabel("kidney_right", "#B98330", ("kidney_right",)),
    OrganLabel("pancreas", "#E8C07D", ("pancreas",)),
    OrganLabel("stomach", "#D98A8A", ("stomach",)),
    OrganLabel("gallbladder", "#4F9D4A", ("gallbladder",)),
    OrganLabel("urinary_bladder", "#E6D26A", ("urinary_bladder",)),
    OrganLabel("lung_left", "#6FA8DC", ("lung_upper_lobe_left", "lung_lower_lobe_left")),
    OrganLabel(
        "lung_right",
        "#9CC9EC",
        ("lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right"),
    ),
    OrganLabel("heart", "#C62828", ("heart",)),
    OrganLabel("aorta", "#EF5350", ("aorta",)),
    OrganLabel("esophagus", "#B07AA1", ("esophagus",)),
    OrganLabel("trachea", "#7FB3B3", ("trachea",)),
    OrganLabel("colon", "#A1785C", ("colon",)),
    OrganLabel("small_bowel", "#E3A06F", ("small_bowel", "duodenum")),
    OrganLabel("spine", "#F2EBDC", ("sacrum", *_VERTEBRAE)),
    OrganLabel("ribs", "#E3D7BD", (*_RIBS, "sternum")),
    OrganLabel("hip", "#D8CFB8", ("hip_left", "hip_right")),
    OrganLabel("femur", "#CFC4A8", ("femur_left", "femur_right")),
    OrganLabel("adrenal_glands", "#F4A259", ("adrenal_gland_left", "adrenal_gland_right")),
)


def merge_lut(class_map: Mapping[int, str]) -> np.ndarray:
    """256-entry uint8 lookup table: TotalSegmentator class id -> our voxel value (0 = not kept).

    Raises ValueError if a source class is missing, so a TotalSegmentator upgrade that renames a
    class fails loudly instead of silently dropping an organ."""
    ids = {name: class_id for class_id, name in class_map.items()}
    missing = [s for label in LABELS for s in label.sources if s not in ids]
    if missing:
        raise ValueError(f"TotalSegmentator classes not found: {', '.join(missing)}")
    lut = np.zeros(256, dtype=np.uint8)
    for value, label in enumerate(LABELS, start=1):
        for source in label.sources:
            lut[ids[source]] = value
    return lut
