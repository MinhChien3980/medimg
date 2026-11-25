# ai-worker (`ai/inference`)

Python 3.12 worker that consumes AI jobs from Redis Streams, runs a model pipeline and writes
results back to Redis and S3-compatible object storage (SeaweedFS locally).

The contract (stream names, fields, payload JSON, object keys) is described in the
[root README](../../README.md#contracts) and implemented in `worker/messages.py`. Do not change it
here without changing core-service too.

## What it does

1. Owns consumer group `ai-workers` on `ai.jobs.{WORKER_KIND}`: creates it at id `0` with
   `MKSTREAM` if missing, so jobs queued before the first worker starts are not lost. Consumer
   name = `WORKER_ID`. Re-processes its own pending entries first, then
   `XREADGROUP ... BLOCK 5000 COUNT 1`.
2. Per job: skips (ACK, no result) if `ai:job:{jobId}:cancelled` exists, also re-checked between
   steps. Publishes `STARTED`, `PROGRESS` 10/40/80/95, then `DONE` (with payload) or `FAILED`
   (`error`, `retryable`) to `ai.results`, and only then `XACK`s the job.
3. Heartbeat `SET ai:worker:{kind}:{workerId} 1 EX 30` every 10 s (key deleted on shutdown).
4. `GET /health` on `HEALTH_PORT` (stdlib HTTP server on a daemon thread, used by the image's
   `HEALTHCHECK`): `{status, workerId, kind, modelLoaded, models}`.
5. SIGTERM: finishes the current job, then exits.

Retry policy for `FAILED`: `retryable=false` for bad input (malformed message or params, unknown
`modelCode`, undecodable image, missing input object); `true` for storage/Redis/network
errors and unexpected errors (core caps attempts at 3). A message whose `attempt` is missing or
not a positive integer is reported with `attempt=0` and `retryable=false`, so core fails the job
instead of waiting for its watchdog. Entries without a `jobId` are ACKed and dropped.

### Pipelines

| modelCode | Model | Output |
| --- | --- | --- |
| `cxr-multilabel` (version `0.1.0-xrv`) | TorchXRayVision `densenet121-res224-all` | 18 labels with calibrated probabilities, highest first, `bbox: null`; Grad-CAM heatmaps (RGBA PNG, original image size, jet, alpha up to 0.6) for at most 5 labels with confidence >= `params.threshold` (default 0.5) |

The whole image is letterboxed to 224x224 (no center crop), so heatmaps cover the full original
image. Artifacts: `{outputPrefix}heatmap-{label}.png` (spaces in labels become `_`) and
`{outputPrefix}result.json` (the DONE payload).

Add a model: implement the `Pipeline` protocol in `worker/pipelines/base.py`
(`run(image_bytes, params, progress_cb) -> PipelineOutput`, findings sorted by confidence) and
register it in `worker/pipelines/registry.py`.

### CPU and GPU workers

`WORKER_KIND` selects the queue: `cpu` consumes `ai.jobs.cpu`, `gpu` consumes `ai.jobs.gpu` and
publishes the `ai:worker:gpu:{id}` heartbeat, which makes core route new jobs to the GPU queue.
A `gpu` worker runs the model on CUDA when PyTorch detects a device and falls back to the CPU
otherwise. The provided image installs the CPU build of PyTorch, so CUDA inference needs an
environment with a CUDA-enabled `torch`/`torchvision` of the versions pinned in `pyproject.toml`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `REDIS_URL` | `redis://localhost:6379/0` | |
| `S3_ENDPOINT` | `http://localhost:8333` | path-style addressing |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | empty | |
| `S3_REGION` | `us-east-1` | |
| `WORKER_KIND` | `cpu` | `cpu` or `gpu`, selects `ai.jobs.{kind}` |
| `WORKER_ID` | hostname | consumer name and heartbeat key |
| `HEALTH_PORT` | `8090` | |
| `LOG_LEVEL` | `INFO` | JSON logs on stdout, with `jobId` |

## Build, test, run

Everything runs in Docker (Python 3.12, CPU PyTorch). The model weights are downloaded at build
time, so the image works offline; the first build downloads PyTorch and the weights and takes
several minutes. Run from `ai/inference`:

```bash
docker build -t medimg-ai-worker:dev .                      # runtime image
docker build --target test -t medimg-ai-worker:test .       # + test deps and tests

docker run --rm medimg-ai-worker:test sh -c "ruff check . && python -m pytest -q"   # all tests
docker run --rm medimg-ai-worker:test python -m pytest -q -m "not slow"             # fast tests

# standalone worker on the network of the compose stack (deploy/docker-compose.yml)
docker run --rm --network medimg_default -e REDIS_URL=redis://redis:6379/0 \
  -e S3_ENDPOINT=http://seaweedfs:8333 -e S3_ACCESS_KEY=medimg -e S3_SECRET_KEY=medimg-dev-secret \
  -p 8090:8090 medimg-ai-worker:dev
```

Tests use fakeredis, moto (S3) and a fake pipeline. Tests marked `slow` run the real model on a
synthetic image; they are skipped when the weights are not cached. CI runs the fast tests on pull
requests and all tests on `main`.
