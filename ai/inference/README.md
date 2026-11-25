# Workers (`ai/inference`)

Python 3.12 workers that consume jobs from Redis Streams and write results back to Redis and
S3-compatible object storage (SeaweedFS locally). One Docker image, two roles chosen by
`WORKER_ROLE`, each run as its own process (compose services `ai-worker` and `ingest-worker`):

| Role | Consumes (group) | Produces | Does |
| --- | --- | --- | --- |
| `ai` (default) | `ai.jobs.{WORKER_KIND}` (`ai-workers`) | `ai.results` | runs a model pipeline on a study |
| `ingest` | `imaging.jobs` (`ingest-workers`) | `imaging.results` | turns an uploaded CT (NIfTI or ZIP of DICOM) into one normalised NIfTI volume + thumbnail |

The contract (stream names, fields, payload JSON, object keys) is described in the
[root README](../../README.md#contracts) and implemented in `worker/messages.py`. Do not change it
here without changing core-service too.

## Stream mechanics (both roles)

`worker/stream_consumer.py` holds the consumer machinery; a role only provides a `Workload`
(parse a message, process it, describe it in logs).

1. Owns its consumer group: creates it at id `0` with `MKSTREAM` if missing, so jobs queued
   before the first worker starts are not lost. Consumer name = `WORKER_ID`. Re-processes its
   own pending entries first, then `XREADGROUP ... BLOCK 5000 COUNT 1`.
2. Per job: `STARTED`, `PROGRESS`..., then `DONE` (with `payload`) or `FAILED` (`error`,
   `retryable`), and only then `XACK`. A crash in between leaves the job pending; it is
   reprocessed on restart and core ignores duplicates and stale attempts.
3. Heartbeat every 10 s with a 30 s TTL: `ai:worker:{kind}:{workerId}` or
   `imaging:worker:{workerId}` (key deleted on shutdown).
4. `GET /health` on `HEALTH_PORT` (used by the image's `HEALTHCHECK`): `{status, workerId, kind,
   modelLoaded, models}` for `ai`, `{status, workerId, role}` for `ingest`.
5. SIGTERM: finishes the current job, then exits.

`retryable=false` for bad input (malformed message, unknown `modelCode`, undecodable or invalid
image/volume, missing input object); `true` for storage, Redis, network and unexpected errors
(core caps attempts). A message whose `attempt` is missing or not a positive integer is reported
with `attempt=0` and `retryable=false`. Entries without an id (`jobId` / `uploadId`) are ACKed
and dropped. AI jobs flagged `ai:job:{jobId}:cancelled` are ACKed without a result.

## Ingest role

Input `inputType=NIFTI` (`.nii` / `.nii.gz`) or `DICOM_SERIES` (ZIP). Output under `outputPrefix`:

- `volume.nii.gz`: int16 (HU for CT; values below -1024 clipped to air), reoriented to the
  closest canonical RAS+ orientation with nibabel (axis permutations/flips only, no
  interpolation), true spacing, qform = sform (code 1), units mm, empty `descrip`, no extensions:
  nothing from the DICOM header survives except modality, spacing and orientation.
- `thumb.png`: middle axial slice, window 400/40, radiological orientation (patient's right on
  the left, anterior at the top), longest side 256 px with the true aspect ratio.

Progress 10 (downloaded), 40 (validated/parsed), 70 (volume built), 90 (encoded), 95
(uploaded). `DONE` payload:

```json
{"volumeUri": "s3://medimg/studies/{studyId}/series/{seriesId}/volume.nii.gz",
 "thumbnailUri": "s3://medimg/studies/{studyId}/series/{seriesId}/thumb.png",
 "modality": "CT", "dims": [512, 512, 301], "spacing": [0.78, 0.78, 1.25], "numSlices": 301,
 "huRange": [-1024, 3071], "sourceSeries": {"slices": 301, "seriesCount": 2}}
```

`dims`/`spacing` are those of the canonical volume (`numSlices` = `dims[2]`, axial);
`sourceSeries.slices` is the number of DICOM images (or NIfTI slices) used. NIfTI carries no
modality: `modalityHint` wins, else `CT` when air-like values (< -500) are present, else `OT`.

Rejected with `retryable=false` and a readable `error`:

- ZIP: more than 2 000 entries, more than 2 GiB once inflated, an entry with `..` or an absolute
  path (zip slip), a symbolic link, encryption, a nested ZIP (by name or by content). Members are
  written under generated names, never under their archive path. Files that are not DICOM
  image slices (no `DICM` magic and not readable by pydicom, or no geometry: DICOMDIR, reports,
  ...) are ignored.
- DICOM: the series with the most slices is used (`seriesCount` reports how many there were);
  fewer than 20 slices, multi-frame (enhanced) objects and gantry tilt (> 0.5°) are refused.
  Slices are ordered by `ImagePositionPatient` along the slice normal, duplicates are dropped,
  and uneven spacing or missing slices are resampled linearly onto a uniform grid (warning in
  the log). Pixel data is decoded by SimpleITK/GDCM, so compressed transfer syntaxes work.
- NIfTI: must be 3D (4D only with a single volume), at least 20 slices and at most 300 million
  voxels, all checked on the header before any voxel is read; a `.nii.gz` is never inflated past
  the size its header announces.

## AI role: pipelines

| modelCode | Model | Output |
| --- | --- | --- |
| `cxr-multilabel` (`0.1.0-xrv`) | TorchXRayVision `densenet121-res224-all` | 18 labels with calibrated probabilities, highest first, `bbox: null`; Grad-CAM heatmaps (RGBA PNG, original size) for at most 5 labels with confidence >= `params.threshold` (default 0.5) |
| `ct-totalseg` (`2.18.0-fast`) | TotalSegmentator 2.18.0, task `total`, `--fast` (3 mm) | `segmentation.nii.gz` + one GLB mesh and one finding per organ of at least 1 ml |

Progress: 10 (input downloaded) -> pipeline steps (`cxr`: 40/80; `ct-totalseg`: 20 preprocessed,
70 segmented, 90 meshes) -> 95 (uploading) -> `DONE`.

### `ct-totalseg`

Input: the `volume.nii.gz` written by the ingest role. TotalSegmentator's 117 classes are merged
into 21 labels; voxel value = position in this list (0 = background):

`liver, spleen, kidney_left, kidney_right, pancreas, stomach, gallbladder, urinary_bladder,
lung_left, lung_right, heart, aorta, esophagus, trachea, colon, small_bowel, spine, ribs, hip,
femur, adrenal_glands`

(lungs merge their lobes, `small_bowel` includes the duodenum, `spine` all vertebrae and the
sacrum, `ribs` the 24 ribs and the sternum, `hip`/`femur`/`adrenal_glands` both sides). Colours
are fixed in `worker/pipelines/ct_labels.py`. Labels under 1 ml are removed from the labelmap,
the findings and the meshes alike.

```json
{"modelVersion": "2.18.0-fast", "inferenceMs": 80038,
 "findings": [{"label": "liver", "confidence": null, "volumeMl": 1258.39, "bbox": null}],
 "artifacts": {"heatmaps": {},
   "segmentation": "s3://medimg/predictions/{jobId}/{attempt}/segmentation.nii.gz",
   "meshes": [{"label": "liver", "color": "#C0573E",
               "uri": "s3://medimg/predictions/{jobId}/{attempt}/meshes/liver.glb",
               "triangles": 50000, "volumeMl": 1258.39, "centroid": [-37.65, -109.5, -586.11]}]}}
```

`cxr-multilabel` payloads are unchanged: findings have no `volumeMl` and `artifacts` only has
`heatmaps`.

**Coordinates.** `segmentation.nii.gz` is uint8 with exactly the shape, affine, qform and sform
of `volume.nii.gz`. Mesh vertices and `centroid` are patient **LPS millimetres**, the DICOM
world space Cornerstone3D uses: `LPS = diag(-1, -1, 1) @ affine_RAS @ [i, j, k, 1]`. The GLB
stores them as they are (no glTF Y-up conversion, no node transform): +x = patient's left,
+y = posterior, +z = superior. `centroid` is the centre of mass of the label's voxels, so
jumping the MPR to it lands inside the organ. `volumeMl` = voxel count x voxel volume.

Meshes: marching cubes at 0.5 on the label's bounding box (padded so surfaces close at the
volume border) -> Taubin smoothing (100 passes, volume within ~3 %) -> quadric decimation
(fast-simplification) to at most 50 000 triangles -> GLB with normals and a matte material in
the label colour. Faces are wound outwards.

TotalSegmentator runs through its Python API behind a small seam
(`worker/pipelines/totalseg_runner.py`), so tests use a fake segmenter. The weights (nnU-Net
Dataset 297, 3 mm) are baked into the image and its usage statistics are disabled: the worker
runs offline. A `gpu` worker uses CUDA when PyTorch sees a device (the provided image ships the
CPU build of PyTorch). nnU-Net sizes its thread pool from the host CPU count; the runner caps it
at the container's CPU quota (or `SEG_THREADS`).

Measured end to end in the compose stack (laptop CPU, 3-4 cores, Docker Desktop; ingest of the
same files takes 1.5 s and 5.5 s with a peak of 0.2 GB):

| Case (TotalSegmentator small subset) | 3 mm grid | Segmentation job | ai-worker peak | Meshes / GLB |
| --- | --- | --- | --- | --- |
| s0965, 215 x 215 x 309 at 1.5 mm | 1.8 M voxels | 35-80 s | 4.1 GB | 20 / 15.0 MB |
| s0011, 311 x 311 x 431 at 1.5 mm | 5.3 M voxels | 170 s | 5.1 GB | 21 / 18.1 MB |

Memory is dominated by the 3D U-Net (~3.6 GB of activations per patch) plus ~0.2 KB per voxel of
the 3 mm grid; volumes whose grid exceeds `SEG_MAX_GRID_VOXELS` (default 6.5 M, about
500 x 500 x 700 mm) are refused with a clear error instead of getting the worker OOM-killed.
TotalSegmentator's `force_split` (three z-chunks) was measured worse (5.9 GB, slower), and
cropping to the body only shrinks the grid by ~25 %, so neither is used.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `WORKER_ROLE` | `ai` | `ai` or `ingest` |
| `REDIS_URL` | `redis://localhost:6379/0` | |
| `S3_ENDPOINT` | `http://localhost:8333` | path-style addressing |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | empty | |
| `S3_REGION` | `us-east-1` | |
| `WORKER_KIND` | `cpu` | `ai` role: `cpu` or `gpu`, selects `ai.jobs.{kind}` |
| `WORKER_ID` | hostname | consumer name and heartbeat key |
| `HEALTH_PORT` | `8090` | |
| `LOG_LEVEL` | `INFO` | JSON logs on stdout, with `jobId` / `uploadId` |
| `SEG_THREADS` | CPU quota | threads for TotalSegmentator |
| `SEG_MAX_GRID_VOXELS` | `6500000` | largest 3 mm grid `ct-totalseg` accepts |

Temporary files (downloaded inputs, extracted ZIPs, meshes) live in a per-job directory under
`TMPDIR` and are removed when the job ends.

## Build, test, run

Everything runs in Docker (Python 3.12, CPU PyTorch). Model weights are downloaded at build
time, so the image works offline; the first build downloads PyTorch, TotalSegmentator/nnU-Net
and the weights (image ~4 GB). Run from `ai/inference`:

```bash
docker build -t medimg-ai-worker:dev .                      # runtime image
docker build --target test -t medimg-ai-worker:test .       # + test deps and tests

docker run --rm medimg-ai-worker:test sh -c "ruff check . && ruff format --check . && python -m pytest -q"
docker run --rm medimg-ai-worker:test python -m pytest -q -m "not slow"   # fast tests only

# the real segmentation on a downloaded sample (python tools/fetch_samples.py at the repo root)
docker run --rm -v "$PWD/../../data/samples:/samples:ro" -e MEDIMG_SAMPLE_CT=/samples/s0965/ct.nii.gz \
  medimg-ai-worker:test python -m pytest -q -m slow -s

# standalone workers on the network of the compose stack (deploy/docker-compose.yml)
docker run --rm --network medimg_default -e REDIS_URL=redis://redis:6379/0 \
  -e S3_ENDPOINT=http://seaweedfs:8333 -e S3_ACCESS_KEY=medimg -e S3_SECRET_KEY=medimg-dev-secret \
  -p 8090:8090 medimg-ai-worker:dev                          # add -e WORKER_ROLE=ingest for ingest
```

Tests use fakeredis, moto (S3), synthetic DICOM series and NIfTI files, and a fake segmenter.
Coordinate tests check that a marker voxel keeps its patient position through ingest for axial,
sagittal, coronal, oblique and flipped acquisitions (cross-checked against ITK's series reader),
and that a cube in a labelmap yields a mesh and centroid at the Cornerstone3D world position.
Tests marked `slow` run the real models (TorchXRayVision on a synthetic X-ray, TotalSegmentator
on a synthetic torso or on `MEDIMG_SAMPLE_CT`); they are skipped when the weights are missing.
CI runs the fast tests on pull requests and all tests on `main`.
