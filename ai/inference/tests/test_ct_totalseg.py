from __future__ import annotations

import json

import nibabel as nib
import numpy as np
import pytest

from tests.helpers import BUCKET, WORKER_ID, job_fields, results
from worker.consumer import JobConsumer
from worker.errors import BadInputError
from worker.pipelines.ct_labels import LABELS, merge_lut
from worker.pipelines.ct_totalseg import CtTotalSegPipeline
from worker.pipelines.registry import PipelineRegistry
from worker.pipelines.totalseg_runner import TotalSegmentatorRunner, grid_voxels

STREAM = "ai.jobs.cpu"
# Every source class of our labels plus one we do not keep, with made-up ids.
CLASS_MAP = dict(enumerate([*(s for label in LABELS for s in label.sources), "brain"], start=1))
ID = {name: class_id for class_id, name in CLASS_MAP.items()}
SPACING = (1.5, 1.5, 2.0)


def volume_affine() -> np.ndarray:
    affine = np.diag([*SPACING, 1.0])
    affine[:3, 3] = (-60.0, -50.0, -400.0)
    return affine


class FakeSegmenter:
    """Liver block (> 1 ml), two lobes of the left lung, spine from sacrum + L1, a 1-voxel spleen
    (< 1 ml, dropped) and an unmapped class."""

    class_map = CLASS_MAP
    ready = True

    def __init__(self) -> None:
        self.seen: list[nib.Nifti1Image] = []

    def prepare(self) -> None:
        pass

    def segment(self, volume: nib.Nifti1Image) -> np.ndarray:
        self.seen.append(volume)
        out = np.zeros(volume.shape, dtype=np.uint8)
        out[5:15, 5:15, 5:15] = ID["liver"]
        out[20:25, 5:10, 2:8] = ID["lung_upper_lobe_left"]
        out[20:25, 5:10, 8:14] = ID["lung_lower_lobe_left"]
        out[30:36, 20:26, 2:7] = ID["sacrum"]
        out[30:36, 20:26, 7:12] = ID["vertebrae_L1"]
        out[2, 2, 2] = ID["spleen"]
        out[38:40, 28:30, 18:20] = ID["brain"]
        return out


def make_full_class_map():
    from totalsegmentator.map_to_binary import class_map

    return class_map["total"]


@pytest.fixture
def volume_file(tmp_path):
    data = np.full((40, 30, 20), -1000, dtype=np.int16)
    data[5:15, 5:15, 5:15] = 60
    img = nib.Nifti1Image(data, volume_affine())
    img.set_qform(volume_affine(), code=1)
    img.set_sform(volume_affine(), code=1)
    path = tmp_path / "volume.nii.gz"
    nib.save(img, path)
    return path


def run(pipeline, volume_file, tmp_path):
    progress: list[int] = []
    workdir = tmp_path / "work"
    workdir.mkdir()
    out = pipeline.run_file(volume_file, {}, progress.append, workdir)
    return out, progress


def test_lut_merges_sources_in_label_order():
    lut = merge_lut(CLASS_MAP)
    assert lut.shape == (256,)
    assert lut[ID["brain"]] == 0
    assert len(LABELS) == 21
    assert [label.name for label in LABELS[:4]] == [
        "liver",
        "spleen",
        "kidney_left",
        "kidney_right",
    ]
    assert sorted(set(lut[1:].tolist()) - {0}) == list(range(1, 22))


def test_every_source_class_exists_in_totalsegmentator():
    pytest.importorskip("totalsegmentator")
    lut = merge_lut(make_full_class_map())
    full = make_full_class_map()
    names = {v: k for k, v in full.items()}
    assert lut[names["duodenum"]] == lut[names["small_bowel"]] == 16
    assert lut[names["vertebrae_S1"]] == lut[names["sacrum"]] == lut[names["vertebrae_C1"]] == 17
    assert lut[names["sternum"]] == lut[names["rib_right_12"]] == 18
    assert lut[names["lung_middle_lobe_right"]] == 10
    assert lut[names["brain"]] == 0


def test_lut_refuses_a_class_map_missing_a_source():
    with pytest.raises(ValueError, match="kidney_left"):
        merge_lut({1: "liver"})


def test_colors_are_unique_hex():
    colors = [label.color for label in LABELS]
    assert len(set(colors)) == len(colors)
    assert all(c.startswith("#") and len(c) == 7 and int(c[1:], 16) >= 0 for c in colors)


def test_pipeline_outputs(volume_file, tmp_path):
    segmenter = FakeSegmenter()
    out, progress = run(CtTotalSegPipeline(segmenter), volume_file, tmp_path)

    assert progress == [20, 70, 90]
    assert out.model_version == "2.18.0-fast"
    assert segmenter.seen[0].get_data_dtype() == np.int16

    voxel_ml = np.prod(SPACING) / 1000
    assert [(f.label, f.confidence, f.bbox) for f in out.findings] == [
        ("liver", None, None),
        ("lung_left", None, None),
        ("spine", None, None),
    ]
    volumes = {f.label: f.volume_ml for f in out.findings}
    assert volumes["liver"] == pytest.approx(1000 * voxel_ml, abs=0.01)
    assert volumes["lung_left"] == pytest.approx(300 * voxel_ml, abs=0.01)
    assert volumes["spine"] == pytest.approx(360 * voxel_ml, abs=0.01)

    seg = nib.load(out.segmentation)
    volume = nib.load(volume_file)
    assert seg.shape == volume.shape
    np.testing.assert_array_equal(seg.affine, volume.affine)
    np.testing.assert_array_equal(seg.get_qform(), volume.get_qform())
    assert seg.get_data_dtype() == np.uint8
    labels = np.asanyarray(seg.dataobj)
    assert set(np.unique(labels).tolist()) == {0, 1, 9, 17}
    assert labels[2, 2, 2] == 0  # spleen below 1 ml removed from the labelmap too
    assert labels[39, 29, 19] == 0  # unmapped class

    assert [m.label for m in out.meshes] == ["liver", "lung_left", "spine"]
    liver = out.meshes[0]
    assert liver.color == LABELS[0].color
    assert liver.path.read_bytes()[:4] == b"glTF"
    assert 0 < liver.triangles <= 50_000
    assert liver.volume_ml == volumes["liver"]
    center_ras = volume_affine() @ np.array([9.5, 9.5, 9.5, 1.0])
    assert liver.centroid == pytest.approx((-center_ras[0], -center_ras[1], center_ras[2]))


def test_segmenter_must_return_the_input_grid(volume_file, tmp_path):
    class WrongShape(FakeSegmenter):
        def segment(self, volume):
            return np.zeros((2, 2, 2), dtype=np.uint8)

    with pytest.raises(RuntimeError, match="shape"):
        run(CtTotalSegPipeline(WrongShape()), volume_file, tmp_path)


def test_non_volume_input_is_bad_input(tmp_path):
    path = tmp_path / "x.nii.gz"
    path.write_bytes(b"not a nifti")
    with pytest.raises(BadInputError):
        run(CtTotalSegPipeline(FakeSegmenter()), path, tmp_path)


def test_runner_refuses_a_field_of_view_too_large_for_memory():
    img = nib.Nifti1Image(np.zeros((10, 10, 10), dtype=np.int16), np.diag([60.0, 60.0, 60.0, 1]))
    assert grid_voxels(img) == 200 * 200 * 200
    with pytest.raises(BadInputError, match="field of view"):
        TotalSegmentatorRunner(max_grid_voxels=1_000_000).segment(img)


# ---------------------------------------------------------------- through the AI consumer


def test_consumer_downloads_runs_and_uploads_segmentation_and_meshes(
    redis_client, storage, s3, volume_file
):
    key = "studies/st1/series/se1/volume.nii.gz"
    s3.put_object(Bucket=BUCKET, Key=key, Body=volume_file.read_bytes())
    consumer = JobConsumer(
        redis_client,
        storage,
        PipelineRegistry([CtTotalSegPipeline(FakeSegmenter())]),
        "cpu",
        WORKER_ID,
        block_ms=50,
    )
    consumer.ensure_group()
    job = job_fields(
        modelCode="ct-totalseg",
        modelVersion="2.18.0-fast",
        task="SEGMENTATION_3D",
        inputType="NIFTI",
        inputUri=f"s3://{BUCKET}/{key}",
        params="{}",
    )
    redis_client.xadd(STREAM, job)
    consumer.poll_once()

    out = results(redis_client)
    assert [(m["type"], m["progress"]) for m in out] == [
        ("STARTED", "0"),
        ("PROGRESS", "10"),
        ("PROGRESS", "20"),
        ("PROGRESS", "70"),
        ("PROGRESS", "90"),
        ("PROGRESS", "95"),
        ("DONE", "100"),
    ]
    payload = json.loads(out[-1]["payload"])
    prefix = job["outputPrefix"]
    assert payload["modelVersion"] == "2.18.0-fast"
    assert payload["findings"][0] == {
        "label": "liver",
        "confidence": None,
        "volumeMl": 4.5,
        "bbox": None,
    }
    artifacts = payload["artifacts"]
    assert artifacts["heatmaps"] == {}
    assert artifacts["segmentation"] == f"{prefix}segmentation.nii.gz"
    assert [m["label"] for m in artifacts["meshes"]] == ["liver", "lung_left", "spine"]
    liver = artifacts["meshes"][0]
    assert set(liver) == {"label", "color", "uri", "triangles", "volumeMl", "centroid"}
    assert liver["uri"] == f"{prefix}meshes/liver.glb"
    assert liver["color"] == "#C0573E"
    assert liver["volumeMl"] == 4.5
    assert len(liver["centroid"]) == 3

    key_prefix = prefix.removeprefix(f"s3://{BUCKET}/")
    glb = s3.get_object(Bucket=BUCKET, Key=f"{key_prefix}meshes/liver.glb")
    assert glb["ContentType"] == "model/gltf-binary"
    seg = s3.get_object(Bucket=BUCKET, Key=f"{key_prefix}segmentation.nii.gz")
    assert seg["ContentType"] == "application/gzip"
    assert "ContentEncoding" not in seg and "ContentEncoding" not in glb
    stored = json.loads(s3.get_object(Bucket=BUCKET, Key=f"{key_prefix}result.json")["Body"].read())
    assert stored == payload
