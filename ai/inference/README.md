# Workers (`ai/inference`)

Python 3.12 workers that consume jobs from Redis Streams and write results back to Redis and
S3-compatible object storage (SeaweedFS locally). One Docker image, two roles chosen by
`WORKER_ROLE`, each run as its own process (compose services `ai-worker` and `ingest-worker`):

| Role | Consumes (group) | Produces | Does |
| --- | --- | --- | --- |
| `ai` (default) | `ai.jobs.{WORKER_KIND}` (`ai-workers`) | `ai.results` | runs a model pipeline on a study |
| `ingest` | `imaging.jobs` (`ingest-workers`) | `imaging.results` | turns an upload (NIfTI, ZIP of DICOM or of PNG/JPEG slices, one DICOM radiograph) into a normalised NIfTI volume or 8-bit PNG + thumbnail |

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

Job fields: `uploadId`, `attempt`, `inputType`, `inputUri`, `outputPrefix`, `modalityHint`,
`bodyPartHint`, `sliceSpacingMm`. Core sets `inputType` from the upload's magic bytes:

| `inputType` | Upload | Becomes (`inputType` of the `DONE` payload) |
| --- | --- | --- |
| `DICOM_2D` | one DICOM file (`DICM` at byte 128) | `DICOM_2D`: `image.png` + `thumb.png` |
| `NIFTI` | `.nii` / `.nii.gz` | `NIFTI`: `volume.nii.gz` + `thumb.png` |
| `ZIP` | a ZIP; the worker looks inside | `DICOM_SERIES` or `IMAGE_STACK`: `volume.nii.gz` + `thumb.png` |

(`DICOM_SERIES` is still accepted as a job `inputType` and treated as `ZIP`, for jobs queued
before the slice 2b upgrade.) `sliceSpacingMm` is `""` or a JSON array `[x, y, z]` of numbers in
0.01-20 mm; anything else fails the job as an invalid message (`retryable=false`). It only
matters for an image stack and is ignored, with a log line, for a DICOM series.

Progress 10 (downloaded), 40 (validated/parsed), 70 (image or volume built), 90 (encoded), 95
(uploaded). Every output is written under `outputPrefix`.

### Volumes (`NIFTI`, `DICOM_SERIES`, `IMAGE_STACK`)

- `volume.nii.gz`: reoriented to the closest canonical RAS+ orientation with nibabel (axis
  permutations/flips only, no interpolation), qform = sform (code 1), units mm, empty `descrip`,
  no extensions: nothing from the DICOM header survives except modality, spacing and
  orientation. int16 (HU for CT; values below -1024 clipped to air); an image stack whose 16-bit
  values exceed 32767 stays uint16.
- `thumb.png`: middle axial slice in radiological orientation (patient's right on the left,
  anterior at the top), longest side 256 px with the true aspect ratio; window 400/40 for CT,
  the slice's own value range otherwise.

```json
{"inputType": "DICOM_SERIES",
 "volumeUri": "s3://medimg/studies/{studyId}/series/{seriesId}/volume.nii.gz",
 "thumbnailUri": "s3://medimg/studies/{studyId}/series/{seriesId}/thumb.png",
 "modality": "CT", "dims": [512, 512, 301], "spacing": [0.78, 0.78, 1.25],
 "spacingAssumed": false, "numSlices": 301, "huRange": [-1024, 3071],
 "sourceSeries": {"slices": 301, "seriesCount": 2}}
```

`dims`/`spacing` are those of the canonical volume (`numSlices` = `dims[2]`, axial);
`sourceSeries.slices` is the number of DICOM images, NIfTI slices or plain images used.
`huRange` is the voxel value range (Hounsfield units only for CT). `spacingAssumed` is `true`
only for an image stack uploaded without `sliceSpacingMm`. NIfTI carries no modality:
`modalityHint` wins, else `CT` when air-like values (< -500) are present, else `OT`.

### What a ZIP holds

Every regular file is classified by its content, never by its name: a DICOM image slice
(readable by pydicom, with position, orientation and pixel spacing), a PNG or JPEG image (magic
bytes), or something else (DICOMDIR, reports, text), which is ignored. `__MACOSX/` and hidden
files or folders (`.DS_Store`, `._img1.png`) are not even extracted. The more numerous of the
two usable kinds wins (a tie goes to DICOM); the other kind is ignored with a log line. Fewer
than 20 slices of the winning kind is an error.

**DICOM series.** The series with the most slices is used (`seriesCount` reports how many there
were); multi-frame (enhanced) objects and gantry tilt (> 0.5°) are refused. Slices are ordered by
`ImagePositionPatient` along the slice normal, duplicates are dropped, and uneven spacing or
missing slices are resampled linearly onto a uniform grid (warning in the log). Pixel data is
decoded by SimpleITK/GDCM, so compressed transfer syntaxes work.

**Image stack.** Plain images have no geometry, so the volume is built by convention:

- **Slice order**: natural sort of the paths inside the ZIP, case-insensitive (`img2.png` before
  `img10.png`). **The first file is the most inferior slice** (k = 0, lowest z) and the last the
  most superior: name the files from the feet towards the head.
- **In-plane**: each image is an axial slice in radiological convention, so the axial view shows
  it exactly as stored (image left = patient's right, image top = anterior). Voxel (i, j, k) is
  pixel (row H-1-j, column W-1-i) of image k.
- **Spacing**: `sliceSpacingMm` `[x, y, z]` (x between columns, y between rows, z between
  slices), else 1 x 1 x 1 mm with `spacingAssumed: true`. Affine `diag(x, y, z)`, origin at
  voxel (0, 0, 0). Modality `OT`.
- **Values**: colour (RGB, RGBA, palette, CMYK) becomes luminance (ITU-R BT.601); 8- and 16-bit
  values keep their range, nothing is rescaled. EXIF orientation is ignored.
- All images must have the same size and bit depth; sizes and the voxel budget are read from the
  image headers before any pixel is decoded.

### 2D DICOM (`DICOM_2D`)

- `image.png`: 8-bit grayscale, original pixel grid, no metadata (only `IHDR`, `IDAT`, `IEND`).
  Rendering follows the DICOM grayscale pipeline: Modality LUT (Modality LUT Sequence, else
  Rescale Slope/Intercept) -> VOI (first VOI LUT Sequence item, else the first Window
  Center/Width with its VOI LUT Function `LINEAR`, `LINEAR_EXACT` or `SIGMOID`, else the image's
  min-max) -> inversion for `MONOCHROME1` (or Presentation LUT Shape `INVERSE`), so the PNG is
  always "high = white". A VOI LUT is normalised by its largest entry (some writers overstate
  its bits per entry). Colour secondary captures become luminance without the LUT steps.
- `thumb.png`: the same rendering, longest side 256 px, aspect ratio from the pixel spacing.

```json
{"inputType": "DICOM_2D",
 "imageUri": "s3://medimg/studies/{studyId}/series/{seriesId}/image.png",
 "thumbnailUri": "s3://medimg/studies/{studyId}/series/{seriesId}/thumb.png",
 "modality": "DX", "dims": [2500, 3000, 1], "spacing": [0.14, 0.14, null]}
```

`dims` is `[width, height, 1]`. `spacing` is `[x, y, null]` mm (x between columns, y between
rows) from `PixelSpacing`, else `ImagerPixelSpacing` (at the detector, not corrected for
magnification), else `null`.

Pixel data is decoded by pydicom with the GDCM plugin (`python-gdcm`, pinned in
`pyproject.toml`): JPEG Baseline/Extended, JPEG Lossless, JPEG-LS and JPEG 2000; Pillow is
pydicom's fallback for JPEG Baseline and JPEG 2000, and RLE is built in. GDCM was chosen over
the pylibjpeg family because one BSD-licensed library covers every syntax above (the pylibjpeg
JPEG plugin, `pylibjpeg-libjpeg`, is GPL-3.0) and it was already in the image through
TotalSegmentator's `dicom2nifti`; wheels exist for linux/amd64 and linux/arm64.

### Refusals

Rejected with `retryable=false` and a readable `error`:

- ZIP: more than 2 000 entries, more than 2 GiB once inflated, an entry with `..` or an absolute
  path (zip slip), a symbolic link, encryption, a nested ZIP (by name or by content). Members are
  written under generated names, never under their archive path.
- ZIP content: no DICOM slice and no image; fewer than 20 slices of the winning kind; images of
  different sizes or bit depths (the message names two offending files); an undecodable image;
  more than 300 million voxels or 50 million pixels per image.
- 2D DICOM: a CT, MR, PT or US file ("this DICOM file is a single CT slice; upload the whole
  series as a ZIP of its DICOM files"); another modality than CR, DX, RG, MG, PX or OT;
  multi-frame; no pixel data; palette colour; fewer than 256 pixels on a side or more than
  50 million pixels (checked on the header, before decoding); undecodable pixel data (the
  message names the transfer syntax).
- NIfTI: must be 3D (4D only with a single volume), at least 20 slices and at most 300 million
  voxels, all checked on the header before any voxel is read; a `.nii.gz` is never inflated past
  the size its header announces.

### Memory and time

Measured with the fast-test image, one job per container capped at 2 GB like the compose
`ingest-worker` (laptop CPU, 2 cores; S3 transfer not included):

| Input | Time | Peak RSS |
| --- | --- | --- |
| 300 PNG slices of 512 x 512 (66 MB ZIP) -> 79 MB `volume.nii.gz` | 4.2 s | 0.25 GB |
| 280 PNG slices of 1024 x 1024 (293 M voxels, near the limit; 245 MB ZIP) | 14.1 s | 0.67 GB |
| DICOM 5000 x 5000, 16-bit uncompressed (50 MB, the upload limit) | 4.5 s | 0.24 GB |
| DICOM 7000 x 7000, JPEG Lossless (43 MB, 49 MP) | 10.5 s | 0.53 GB |

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

Tests use fakeredis, moto (S3), synthetic DICOM series, radiographs (uncompressed, JPEG,
JPEG 2000, JPEG Lossless and JPEG-LS written by Pillow or GDCM), PNG/JPEG stacks and NIfTI
files, and a fake segmenter. Radiograph tests pin the grayscale pipeline to exact pixel values
(rescale + window, VOI LUT, MONOCHROME1 = inverse of MONOCHROME2); stack tests check the slice
order and that a marker pixel lands on the expected voxel.
Coordinate tests check that a marker voxel keeps its patient position through ingest for axial,
sagittal, coronal, oblique and flipped acquisitions (cross-checked against ITK's series reader),
and that a cube in a labelmap yields a mesh and centroid at the Cornerstone3D world position.
Tests marked `slow` run the real models (TorchXRayVision on a synthetic X-ray, TotalSegmentator
on a synthetic torso or on `MEDIMG_SAMPLE_CT`); they are skipped when the weights are missing.
CI runs the fast tests on pull requests and all tests on `main`.
