# MedImg – AI Medical Imaging & 3D Visualization Platform

Web platform where clinicians upload chest X-rays (and, in later slices, CT/MRI volumes), run AI analysis and review
the results with heatmaps and 3D models. **Research demo – not for diagnostic use.**

## Status

| Slice | Scope | State |
| --- | --- | --- |
| 1 | Login (JWT) → cases → X-ray upload → AI job over Redis Streams → TorchXRayVision findings + Grad-CAM heatmaps, live progress (SSE) | ✅ done |
| 2 | DICOM / NIfTI / CT series, TotalSegmentator, MPR viewer (Cornerstone3D), 3D meshes (three.js) | planned |
| 3 | Finding review, annotations, PDF reports | planned |
| 4 | Dashboard, admin, audit UI, E2E tests, cloud deploy | planned |

## Architecture

```text
Browser ── web: Nginx (Docker) / Vite dev server ──┬─ /api/**    → core-service   Spring Boot 4, Java 21, modular monolith
                                                   └─ /medimg/** → SeaweedFS (S3)  presigned URLs, same origin
core-service ── PostgreSQL 17 · Redis 7 (Streams) · S3
ai-worker (Python 3.12, PyTorch CPU/GPU) ◄── Redis Streams ──► core-service
```

- **core-service** (`backend/core-service`): modules `identity`, `patient`, `imaging`, `prediction`, `audit` with
  ports & adapters; module boundaries enforced by ArchUnit. RS256 JWT with rotating refresh tokens, RFC 7807 errors,
  Flyway, append-only monthly-partitioned audit log (the app's DB role cannot update or delete it).
- **AI job pipeline**: attempt-aware state machine (QUEUED → RUNNING → DONE/FAILED), job dispatch through a
  transactional outbox (no lost jobs between PostgreSQL and Redis), retries with backoff, watchdog for silent workers,
  GPU/CPU routing by worker heartbeat, idempotent job creation.
- **ai-worker** (`ai/inference`): Redis Streams consumer, TorchXRayVision DenseNet-121 baseline, Grad-CAM heatmaps.
- **frontend** (`frontend`): React 19, TypeScript, Ant Design, TanStack Query, canvas viewer with heatmap overlay.
  In Docker an Nginx image serves the built SPA and reverse-proxies `/api/` and `/medimg/`; in development the Vite
  dev server does the same proxying. Both keep the browser's `Host` header, which presigned URLs are signed for.

## Design decisions

| Decision | Why | Where |
| --- | --- | --- |
| Modular monolith with ports & adapters | One deployable for a small team, with module seams kept explicit so a module can be extracted later; ArchUnit fails the build if a module reaches into another's internals | [`ModuleBoundariesTest`](backend/core-service/src/test/java/com/medimg/architecture/ModuleBoundariesTest.java), [`JobQueuePort`](backend/core-service/src/main/java/com/medimg/prediction/application/JobQueuePort.java), [`ObjectStoragePort`](backend/core-service/src/main/java/com/medimg/shared/storage/ObjectStoragePort.java) |
| State machines in the domain model | Job and upload transitions are checked in one place, and every result carries an attempt number, so stale or duplicate worker messages are ignored | [`PredictionJob`](backend/core-service/src/main/java/com/medimg/prediction/domain/PredictionJob.java), [`UploadSession`](backend/core-service/src/main/java/com/medimg/imaging/domain/UploadSession.java) |
| Transactional outbox | A job and its queue message are committed together; a relay publishes with `FOR UPDATE SKIP LOCKED`, so a crash or a Redis outage delays jobs instead of losing them, and several instances can run the relay | [`JobOutbox`](backend/core-service/src/main/java/com/medimg/prediction/application/JobOutbox.java), [`JobOutboxRelay`](backend/core-service/src/main/java/com/medimg/prediction/infrastructure/JobOutboxRelay.java) |
| Competing consumers on Redis Streams | Workers scale horizontally in one consumer group; a message is ACKed only after its result is published | [`consumer.py`](ai/inference/worker/consumer.py) |
| Retry, watchdog and dead-letter stream | Retryable failures come back with backoff, silent workers are timed out, and a poison result message ends up in `ai.results.dlq` instead of blocking the consumer | [`JobWatchdog`](backend/core-service/src/main/java/com/medimg/prediction/application/JobWatchdog.java), [`ResultStreamConsumer`](backend/core-service/src/main/java/com/medimg/prediction/infrastructure/ResultStreamConsumer.java) |
| Idempotency key | Retrying `POST /predictions` with the same `Idempotency-Key` returns the original job, also under concurrent requests | [`PredictionService`](backend/core-service/src/main/java/com/medimg/prediction/application/PredictionService.java) |
| Strategy + registry for models | Adding a model means adding one pipeline class; the consumer does not change | [`registry.py`](ai/inference/worker/pipelines/registry.py) |
| Rotating refresh tokens with reuse detection | Each refresh token works once; presenting a used one revokes all of the user's sessions | [`AuthService`](backend/core-service/src/main/java/com/medimg/identity/application/AuthService.java) |
| Role-based access in one place | Read, write and admin policies are named once on the server and mirrored by one helper in the UI | [`AccessPolicy`](backend/core-service/src/main/java/com/medimg/shared/security/AccessPolicy.java), [`permissions.ts`](frontend/src/features/auth/permissions.ts) |
| Append-only audit log | Written asynchronously from domain events; the application's database role has no UPDATE or DELETE on it | [`AuditWriter`](backend/core-service/src/main/java/com/medimg/audit/application/AuditWriter.java), [`V3__audit.sql`](backend/core-service/src/main/resources/db/migration/V3__audit.sql) |
| Defensive image intake | Magic-byte check, size limits read from the header before decoding, re-encoding to strip metadata, and a sweep that fails uploads stuck after a crash | [`ImageNormalizer`](backend/core-service/src/main/java/com/medimg/imaging/application/ImageNormalizer.java), [`StaleUploadSweeper`](backend/core-service/src/main/java/com/medimg/imaging/application/StaleUploadSweeper.java) |

Not used on purpose: CQRS, event sourcing, sagas and circuit breakers. They add moving parts that a single service
with one database does not need yet.

## Project layout

```text
backend/core-service/   Spring Boot API (Gradle), Flyway migrations, Dockerfile
ai/inference/           Python AI worker, pytest suite, Dockerfile (runtime and test targets)
frontend/               React SPA (Vite), Nginx Dockerfile
deploy/                 docker-compose.yml, PostgreSQL init scripts, SeaweedFS S3 identities
.github/workflows/      CI: backend, ai-worker and frontend jobs, each run when its directory changes
```

## Contracts

**REST** – base `/api/v1`, JSON, UUID ids, ISO-8601 UTC timestamps, errors as RFC 7807 `application/problem+json`.
The OpenAPI document is served by core-service at `/v3/api-docs` (Swagger UI: `/swagger-ui.html`).

**Redis Streams** – core-service and ai-worker only share these names and fields:

| Stream / key | Writer → reader | Content |
| --- | --- | --- |
| `ai.jobs.gpu`, `ai.jobs.cpu` | core → worker (group `ai-workers`, created by the worker) | `jobId`, `attempt`, `modelCode`, `modelVersion`, `task`, `inputType`, `inputUri`, `outputPrefix`, `params` (JSON) |
| `ai.results` | worker → core (group `core`) | `jobId`, `attempt`, `workerId`, `type` (`STARTED`/`PROGRESS`/`DONE`/`FAILED`), `progress`, `payload` (DONE, JSON), `error` + `retryable` (FAILED) |
| `ai:worker:{kind}:{workerId}` | worker heartbeat, TTL 30 s | core routes to `gpu` only while a GPU worker is alive |
| `ai:job:{jobId}:cancelled` | core → worker | worker skips the job and ACKs it without a result |
| `ai.results.dlq` | core | result messages that could not be applied after 5 deliveries, kept for inspection |

Core never publishes job messages directly. It writes them to the `outbox_message` table in the same transaction as
the job change, and a relay moves them to the job streams, so delivery is at-least-once. The worker publishes DONE/FAILED *before* it ACKs the job, so a crash re-delivers the job; core ignores results whose
`attempt` is not the job's current attempt, which makes redelivery safe. A job message the worker cannot parse is
ACKed and reported as FAILED with `retryable=false`, with `attempt=0` when the attempt itself is unreadable; core then
fails the job instead of waiting for the watchdog.

**Object storage** (bucket `medimg`):

```text
uploads/{uploadId}/{fileId}/{name}                    raw upload, deleted after processing
studies/{studyId}/series/{seriesId}/image.png         normalised grayscale PNG, metadata stripped
studies/{studyId}/series/{seriesId}/thumb.png         256 px thumbnail
predictions/{jobId}/{attempt}/heatmap-{label}.png     Grad-CAM overlay (RGBA)
predictions/{jobId}/{attempt}/result.json             full model output
```

The browser only ever sees short-lived presigned URLs, served from the same origin as the UI.

## Run locally

The first build downloads PyTorch and the model weights for the ai-worker image (a few GB, several minutes); later
builds are cached.

### Option A: everything in Docker

Requirements: Docker with Compose v2.

```bash
docker compose -f deploy/docker-compose.yml --profile full up --build
```

Open http://localhost:8088. The API is also published on http://localhost:8080 (Swagger UI: `/swagger-ui.html`).

### Option B: development mode

Requirements: Docker, Java 21, Node 24. Run each command from the repository root, in its own terminal:

```bash
# 1. PostgreSQL, Redis, SeaweedFS and the ai-worker (detached)
docker compose -f deploy/docker-compose.yml up -d --build

# 2. API on http://localhost:8080 (Swagger UI: /swagger-ui.html)
(cd backend/core-service && ./gradlew bootRun)

# 3. UI on http://localhost:5173, proxying /api and /medimg
(cd frontend && npm install && npm run dev)
```

On Windows, use Git Bash, or in PowerShell run steps 2 and 3 in their own terminals as
`cd backend/core-service; .\gradlew.bat bootRun` and `cd frontend; npm install; npm run dev`.

### Accounts and credentials

Demo accounts: `doctor`, `tech`, `admin` and `researcher` (read-only: sees cases, images and AI results, cannot
create, upload, run AI or delete) – password `Demo@12345`.

All credentials in `deploy/` and `application.yml` are local-development defaults, not meant for a deployed
environment. The services read them from environment variables (`DB_APP_PASSWORD`, `S3_SECRET_KEY`, `DEMO_PASSWORD`,
`JWT_PRIVATE_KEY`, …). The SeaweedFS identity itself lives in `deploy/seaweedfs/s3.json`.

## Tests

All commands run from the repository root.

| Part | Command | Covers |
| --- | --- | --- |
| backend | `(cd backend/core-service && ./gradlew test)` | unit, ArchUnit, integration with Testcontainers (PostgreSQL, Redis, SeaweedFS; needs Docker) |
| ai-worker | `docker build --target test -t medimg-ai-worker:test ai/inference` then `docker run --rm medimg-ai-worker:test sh -c "ruff check . && python -m pytest -q"` | Ruff, pytest with fakeredis/moto, real-model tests (marker `slow`; add `-m "not slow"` to skip them) |
| frontend | `(cd frontend && npm run lint && npm run typecheck && npm test -- --run)` | ESLint, TypeScript, Vitest, React Testing Library, MSW |

On pull requests CI runs only the jobs whose directory changed, and the ai-worker job skips the real-model tests.
Pushes to `main` run every job, including the real-model tests.

## Data and licences

Only public or anonymised data. An upload is a single PNG or JPEG of at most 50 MB and 50 megapixels. It is
re-encoded, which strips all embedded metadata; text burned into the pixels is **not** removed. Model weights:
TorchXRayVision (Apache-2.0); check the licence of each dataset before any non-research use.
