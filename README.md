# MedImg – AI Medical Imaging & 3D Visualization Platform

Web platform where clinicians upload chest X-rays (PNG, JPEG or DICOM) and CT scans (NIfTI or a DICOM series), run AI
analysis and review the results: Grad-CAM heatmaps for X-rays, and for CT a three-plane MPR viewer with organ
segmentation and rotatable 3D organ models. Doctors review the AI findings, annotate and measure, and sign a PDF
report. Ready-made sample cases let anyone try it without data of their own.
**Research demo – not for diagnostic use.**

## Status

| Slice | Scope | State |
| --- | --- | --- |
| 1 | Login (JWT) → cases → X-ray upload → AI job over Redis Streams → TorchXRayVision findings + Grad-CAM heatmaps, live progress (SSE) | ✅ done |
| 2a | CT upload (NIfTI, DICOM series ZIP) → ingest to a normalised volume → MPR viewer (Cornerstone3D) → TotalSegmentator organ segmentation on CPU → labelmap overlay + 3D organ meshes (three.js) with volumes | ✅ done |
| 2b | DICOM X-ray input, ZIPs of PNG/JPEG slices, multipart upload for files over 64 MB, sample-case gallery | ✅ done |
| 3 | Finding review (accept / edit / reject, manual findings), annotations and measurements on X-ray and CT, signed PDF reports with key images and amendments | ✅ done |
| 4a | Dashboard for every role, user administration (lock, password reset, forced change), model enable/disable, audit log search and CSV export | ✅ done |
| 4b | End-to-end tests on the Docker stack in CI, cloud deploy | planned |

## Architecture

```text
Browser ── web: Nginx (Docker) / Vite dev server ──┬─ /api/**    → core-service   Spring Boot 4, Java 21, modular monolith
                                                   └─ /medimg/** → SeaweedFS (S3)  presigned URLs, same origin
core-service ── PostgreSQL 17 · Redis 7 (Streams) · S3
ai-worker     (Python 3.12, PyTorch CPU/GPU)  ◄── ai.jobs.* / ai.results ──────────► core-service
ingest-worker (same image, WORKER_ROLE=ingest) ◄── imaging.jobs / imaging.results ──► core-service
```

- **core-service** (`backend/core-service`): modules `identity`, `patient`, `imaging`, `prediction`, `annotation`, `report`, `sample`, `audit` with
  ports & adapters; module boundaries enforced by ArchUnit. RS256 JWT with rotating refresh tokens, RFC 7807 errors,
  Flyway, append-only monthly-partitioned audit log (the app's DB role cannot update or delete it).
- **AI job pipeline**: attempt-aware state machine (QUEUED → RUNNING → DONE/FAILED), dispatch through a
  transactional outbox (no lost jobs between PostgreSQL and Redis), retries with backoff, watchdog for silent workers,
  GPU/CPU routing by worker heartbeat, idempotent job creation.
- **Ingest**: PNG/JPEG X-rays are re-encoded in core-service; everything else is checked by magic bytes and handed to
  the ingest-worker. A DICOM X-ray becomes an 8-bit PNG after the modality LUT, VOI LUT/window and MONOCHROME1
  inversion (JPEG, JPEG-LS and JPEG 2000 decoded by GDCM). A ZIP is inspected: a DICOM series or a stack of PNG/JPEG
  slices (natural file order, first file = most inferior slice, optional slice spacing) becomes one canonical
  `volume.nii.gz` (RAS, true spacing, no DICOM tags) that the viewer and the AI both read. ZIP handling guards against
  zip slip, nested archives and decompression bombs.
- **Uploads**: the browser uploads straight to object storage through presigned URLs; files over 64 MB go as a
  multipart upload in 32 MB parts (three in parallel, each retried), so they pass proxies with a 100 MB request limit.
  Unfinished multipart uploads are aborted by a sweeper.
- **ai-worker** (`ai/inference`): one image, two roles. `ai` runs TorchXRayVision DenseNet-121 with Grad-CAM for X-rays
  and TotalSegmentator 2.18 (`--fast`, CPU) for CT, merging its classes into 21 structures and building one smoothed,
  decimated GLB mesh per organ in patient LPS millimetres; `ingest` normalises CT uploads.
- **frontend** (`frontend`): React 19, TypeScript, Ant Design, TanStack Query. X-rays use a canvas viewer with heatmap
  overlays; CT uses Cornerstone3D (axial/coronal/sagittal MPR, crosshairs, window presets, labelmap overlay) and
  react-three-fiber (organ meshes, per-organ visibility/colour/opacity, clipping box, click an organ to jump the MPR
  to it).
  In Docker an Nginx image serves the built SPA and reverse-proxies `/api/` and `/medimg/`; in development the Vite
  dev server does the same proxying. Both keep the browser's `Host` header, which presigned URLs are signed for.

## Design decisions

| Decision | Why | Where |
| --- | --- | --- |
| Modular monolith with ports & adapters | One deployable for a small team, with module seams kept explicit so a module can be extracted later; ArchUnit fails the build if a module reaches into another's internals | [`ModuleBoundariesTest`](backend/core-service/src/test/java/com/medimg/architecture/ModuleBoundariesTest.java), [`JobQueuePort`](backend/core-service/src/main/java/com/medimg/prediction/application/JobQueuePort.java), [`ObjectStoragePort`](backend/core-service/src/main/java/com/medimg/shared/storage/ObjectStoragePort.java) |
| State machines in the domain model | Job and upload transitions are checked in one place, and every result carries an attempt number, so stale or duplicate worker messages are ignored | [`PredictionJob`](backend/core-service/src/main/java/com/medimg/prediction/domain/PredictionJob.java), [`UploadSession`](backend/core-service/src/main/java/com/medimg/imaging/domain/UploadSession.java) |
| Transactional outbox, shared by two modules | AI jobs and CT ingest jobs are committed together with their queue messages; one relay publishes with `FOR UPDATE SKIP LOCKED`, so a crash or a Redis outage delays work instead of losing it, and several instances can run the relay. ArchUnit enforces that every stream entry goes through it | [`Outbox`](backend/core-service/src/main/java/com/medimg/shared/outbox/Outbox.java), [`OutboxRelay`](backend/core-service/src/main/java/com/medimg/shared/outbox/OutboxRelay.java), [`JobOutbox`](backend/core-service/src/main/java/com/medimg/prediction/application/JobOutbox.java) |
| Competing consumers on Redis Streams | Workers scale horizontally in one consumer group; a message is ACKed only after its result is published. One generic consumer serves both worker roles, and one base class serves both result streams in core | [`stream_consumer.py`](ai/inference/worker/stream_consumer.py), [`StreamConsumer`](backend/core-service/src/main/java/com/medimg/shared/messaging/StreamConsumer.java) |
| Retry, watchdog and dead-letter streams | Retryable failures come back with backoff, silent workers are timed out, and a poison result message ends up in `<stream>.dlq` instead of blocking the consumer | [`JobWatchdog`](backend/core-service/src/main/java/com/medimg/prediction/application/JobWatchdog.java), [`IngestResultHandler`](backend/core-service/src/main/java/com/medimg/imaging/application/IngestResultHandler.java) |
| One normalised volume, one coordinate system | Every CT becomes a canonical NIfTI; the labelmap shares its grid and affine, and meshes and organ centroids are in patient LPS mm, the world space Cornerstone3D uses, so 3D, MPR and overlay always line up. Tests pin this with known cubes under rotated and oblique affines | [`meshing.py`](ai/inference/worker/pipelines/meshing.py), [`geometry.py`](ai/inference/worker/geometry.py) |
| Idempotency key | Retrying `POST /predictions` with the same `Idempotency-Key` returns the original job, also under concurrent requests | [`PredictionService`](backend/core-service/src/main/java/com/medimg/prediction/application/PredictionService.java) |
| Strategy + registry for models | Adding a model means adding one pipeline class; the consumer does not change | [`registry.py`](ai/inference/worker/pipelines/registry.py) |
| Rotating refresh tokens with reuse detection | Each refresh token works once; presenting a used one revokes all of the user's sessions | [`AuthService`](backend/core-service/src/main/java/com/medimg/identity/application/AuthService.java) |
| Account state checked on every request | Locking an account or resetting its password ends its sessions at the next request, not when the 15-minute access token expires; a temporary password blocks every API except the password change | [`AccountAccessInterceptor`](backend/core-service/src/main/java/com/medimg/identity/api/AccountAccessInterceptor.java), [`UserAdminService`](backend/core-service/src/main/java/com/medimg/identity/application/UserAdminService.java) |
| Role-based access in one place | Read, write and admin policies are named once on the server and mirrored by one helper in the UI | [`AccessPolicy`](backend/core-service/src/main/java/com/medimg/shared/security/AccessPolicy.java), [`permissions.ts`](frontend/src/features/auth/permissions.ts) |
| Append-only audit log | Written asynchronously from domain events; the application's database role has no UPDATE or DELETE on it | [`AuditWriter`](backend/core-service/src/main/java/com/medimg/audit/application/AuditWriter.java), [`V3__audit.sql`](backend/core-service/src/main/resources/db/migration/V3__audit.sql) |
| Multipart upload through presigned part URLs | Large CTs never pass through the API, each part URL signs its exact byte length, ETags are checked on completion, and abandoned uploads are aborted | [`UploadService`](backend/core-service/src/main/java/com/medimg/imaging/application/UploadService.java), [`multipartUpload.ts`](frontend/src/api/multipartUpload.ts) |
| Defensive file intake | Magic-byte detection of PNG/JPEG/ZIP/NIfTI, size limits read from headers before decoding, metadata stripped by re-encoding, safe ZIP extraction, a grid-size cap so a huge CT cannot OOM-kill the AI worker, and a sweep that fails uploads stuck after a crash | [`FileTypeDetector`](backend/core-service/src/main/java/com/medimg/imaging/application/FileTypeDetector.java), [`ImageNormalizer`](backend/core-service/src/main/java/com/medimg/imaging/application/ImageNormalizer.java), [`archive.py`](ai/inference/worker/ingest/archive.py), [`StaleUploadSweeper`](backend/core-service/src/main/java/com/medimg/imaging/application/StaleUploadSweeper.java) |

| Signed reports are immutable | A report is a draft until a doctor signs it; after that the domain refuses changes and a database trigger rejects any UPDATE or DELETE, so a correction is a new amended version that points at the original | [`Report`](backend/core-service/src/main/java/com/medimg/report/domain/Report.java), [`V7__review_annotations_reports.sql`](backend/core-service/src/main/resources/db/migration/V7__review_annotations_reports.sql) |
| PDFs from templates, not string building | The report is an escaped Thymeleaf template with its own CSS and message bundles (vi/en), rendered by openhtmltopdf with an embedded font, so Vietnamese diacritics and layout are testable | [`report.html`](backend/core-service/src/main/resources/report/report.html), [`HtmlReportPdfRenderer`](backend/core-service/src/main/java/com/medimg/report/infrastructure/HtmlReportPdfRenderer.java) |
| Annotations in the image's own coordinates | X-ray shapes are stored in image pixels and drawn through the viewer's transform; CT shapes are stored in patient LPS mm with their view plane, so they survive zoom, pan, window changes and reloads | [`AnnotationLayer2D`](frontend/src/features/annotations/AnnotationLayer2D.tsx), [`annotationConverters.ts`](frontend/src/features/viewer/volume/mpr/annotationConverters.ts) |

Not used on purpose: CQRS, event sourcing, sagas and circuit breakers. They add moving parts that a single service
with one database does not need yet.

## Project layout

```text
backend/core-service/   Spring Boot API (Gradle), Flyway migrations, Dockerfile
ai/inference/           Python worker (AI and ingest roles), pytest suite, Dockerfile (runtime and test targets)
frontend/               React SPA (Vite), Playwright smoke test, Nginx Dockerfile
deploy/                 docker-compose.yml, PostgreSQL init scripts, SeaweedFS S3 identities
tools/                  fetch and seed the sample CT scans
.github/workflows/      CI: backend, ai-worker, tools and frontend jobs, each run when its directory changes
```

## Contracts

**REST** – base `/api/v1`, JSON, UUID ids, ISO-8601 UTC timestamps, errors as RFC 7807 `application/problem+json`.
The OpenAPI document is served by core-service at `/v3/api-docs` (Swagger UI: `/swagger-ui.html`).

**Redis Streams** – core-service and the workers only share these names and fields:

| Stream / key | Writer → reader | Content |
| --- | --- | --- |
| `ai.jobs.gpu`, `ai.jobs.cpu` | core → worker (group `ai-workers`, created by the worker) | `jobId`, `attempt`, `modelCode`, `modelVersion`, `task`, `inputType`, `inputUri`, `outputPrefix`, `params` (JSON) |
| `ai.results` | worker → core (group `core`) | `jobId`, `attempt`, `workerId`, `type` (`STARTED`/`PROGRESS`/`DONE`/`FAILED`), `progress`, `payload` (DONE, JSON), `error` + `retryable` (FAILED) |
| `ai:worker:{kind}:{workerId}` | worker heartbeat, TTL 30 s | core routes to `gpu` only while a GPU worker is alive |
| `ai:job:{jobId}:cancelled` | core → worker | worker skips the job and ACKs it without a result |
| `imaging.jobs` | core → ingest-worker (group `ingest-workers`, created by the worker) | `uploadId`, `attempt`, `inputType` (`DICOM_2D`/`ZIP`/`NIFTI`), `inputUri`, `outputPrefix`, `modalityHint`, `bodyPartHint`, `sliceSpacingMm` (JSON `[x,y,z]` or empty) |
| `imaging.results` | ingest-worker → core (group `core-imaging`) | `uploadId`, `attempt`, `workerId`, `type`, `progress`, `payload` (DONE: the final `inputType` – `DICOM_2D`, `DICOM_SERIES`, `IMAGE_STACK` or `NIFTI` – with `imageUri` for 2D or `volumeUri` and `spacingAssumed` for volumes, plus `thumbnailUri`, `modality`, `dims`, `spacing`), `error` + `retryable` |
| `ai.results.dlq`, `imaging.results.dlq` | core | result messages that could not be applied after 5 deliveries, kept for inspection |

A CT segmentation (`ct-totalseg`) uses the same job streams. Its DONE payload carries one finding per organ with
`volumeMl`, the labelmap (`artifacts.segmentation`, voxel value = index + 1 in the model's `labels`) and
`artifacts.meshes[]` (`label`, `color`, `uri`, `triangles`, `volumeMl`, `centroid` in LPS mm).

Core never publishes job messages directly. It writes them to the `outbox_message` table in the same transaction as
the state change, and a relay moves them to the streams, so delivery is at-least-once. The workers publish
DONE/FAILED *before* they ACK a job, so a crash re-delivers the job; core ignores results whose
`attempt` is not the job's current attempt, which makes redelivery safe. A job message the worker cannot parse is
ACKed and reported as FAILED with `retryable=false`, with `attempt=0` when the attempt itself is unreadable; core then
fails the job instead of waiting for the watchdog.

**Object storage** (bucket `medimg`):

```text
uploads/{uploadId}/{fileId}/{name}                    raw upload, deleted after processing
studies/{studyId}/series/{seriesId}/image.png         X-ray: normalised grayscale PNG, metadata stripped
studies/{studyId}/series/{seriesId}/volume.nii.gz     CT: normalised volume (int16 HU, RAS)
studies/{studyId}/series/{seriesId}/thumb.png         256 px thumbnail
predictions/{jobId}/{attempt}/heatmap-{label}.png     X-ray: Grad-CAM overlay (RGBA)
predictions/{jobId}/{attempt}/segmentation.nii.gz     CT: labelmap on the volume's grid
predictions/{jobId}/{attempt}/meshes/{label}.glb      CT: one mesh per organ
predictions/{jobId}/{attempt}/result.json             full model output
```

The browser only ever sees short-lived presigned URLs, served from the same origin as the UI.

## Run locally

The first build downloads PyTorch, TotalSegmentator and the model weights for the worker image (about 4 GB, several
minutes); later builds are cached. CT segmentation needs about 5 GB of RAM for the ai-worker (the compose file caps it
at 6 GB and 3 CPUs); on a laptop CPU a thorax-abdomen CT takes roughly 0.5–3 minutes.

### Option A: everything in Docker

Requirements: Docker with Compose v2.

```bash
docker compose -f deploy/docker-compose.yml --profile full up --build
```

Open http://localhost:8088. The API is also published on http://localhost:8080 (Swagger UI: `/swagger-ui.html`).

### Upgrading an existing database

core-service applies the Flyway migrations when it starts. Migration V9 needs the `pg_trgm` extension, which the init
script installs only when it creates a new database. A database created before V9 needs it once, as the superuser:

```bash
docker compose -f deploy/docker-compose.yml exec postgres psql -U postgres -d medimg -c "CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA medimg"
```

Without it core-service stops at V9 with `permission denied to create extension "pg_trgm"`.

### Sample CT scans

Two CT scans from the TotalSegmentator dataset can be fetched (about 65 MB; only the needed files are downloaded from
the 3.2 GB archive) and loaded into a running stack as sample cases:

```bash
python tools/fetch_samples.py                                               # -> data/samples/ (git-ignored)
python tools/seed_samples.py --base-url http://localhost:8088 --segment     # upload, mark as samples, segment
```

The seed script logs in as `admin`, uploads each scan, marks the case as a sample (with its source and licence) and,
with `--segment`, runs the organ segmentation so the results are ready. Every role then finds them under
**Sample cases** (`/samples`).

### Option B: development mode

Requirements: Docker, Java 21, Node 24. Run each command from the repository root, in its own terminal:

```bash
# 1. PostgreSQL, Redis, SeaweedFS, the ai-worker and the ingest-worker (detached)
docker compose -f deploy/docker-compose.yml up -d --build

# 2. API on http://localhost:8080 (Swagger UI: /swagger-ui.html)
(cd backend/core-service && ./gradlew bootRun)

# 3. UI on http://localhost:5173, proxying /api and /medimg
(cd frontend && npm install && npm run dev)
```

On Windows, use Git Bash, or in PowerShell run steps 2 and 3 in their own terminals as
`cd backend/core-service; .\gradlew.bat bootRun` and `cd frontend; npm install; npm run dev`.

### Accounts and credentials

Demo accounts, all with the password `Demo@12345`:

| Account | Can |
| --- | --- |
| `doctor` | everything clinical: cases, uploads, AI runs, review findings, annotate, write and sign reports |
| `tech` | cases, uploads, AI runs, own annotations; reads draft reports |
| `admin` | cases, uploads, AI runs, delete cases, manage sample cases; administers users and AI models, reads the audit log; reads draft reports |
| `researcher` | read-only: cases, images, AI results, annotations and signed reports |

Lesion boxes come from doctors' annotations: the planned box-detection model for chest X-rays (`cxr-detect`) is not
part of the demo until it has been trained.

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
| frontend (browser) | `(cd frontend && npm run e2e:install && npm run e2e)` | Playwright in headless Chromium: MPR, labelmap overlay, 3D meshes and the 3D → MPR jump on a synthetic CT, under the production CSP |
| tools | `(cd tools && python -m unittest discover -s tests)` | the HTTP-range ZIP reader that fetches the samples |

On pull requests CI runs only the jobs whose directory changed, and the ai-worker job skips the real-model tests.
Pushes to `main` run every job, including the real-model tests.

## Performance

Measured on PostgreSQL 17 (Docker, 768 MB, warm cache) seeded with a busy year: 200 000 cases, 250 000 AI jobs,
690 000 findings, 100 000 reports and 2 million audit entries. Times are the database time of one request (the page
and its total, or every query of the dashboard).

| Request | Before | After |
| --- | --- | --- |
| Case search by text | 155 ms | 7 ms |
| Dashboard, last 30 days (the landing page) | 400 ms | 140 ms |
| Dashboard, 366 days (the longest range) | 1.7 s | 0.9 s |
| Case list, page 5 001 (OFFSET 100 000) | 50 ms | 50 ms |
| Audit log, 93 days, first page and total | 30 ms | 30 ms |

- **Case search:** trigram indexes on the code and note
  ([`V9`](backend/core-service/src/main/resources/db/migration/V9__case_search_trigram.sql)). A test checks that the
  query can use them.
- **Dashboard:**
  - each row is checked against the small set of studies of deleted cases, instead of being joined with every study
    and case;
  - the job and review indexes cover the columns the figures need
    ([`V10`](backend/core-service/src/main/resources/db/migration/V10__dashboard_indexes.sql));
  - PostgreSQL runs with `random_page_cost=1.1`, the usual value for SSD storage.
- **Left as is:**
  - offset paging, still about 50 ms on page 5 001;
  - the audit log, already partitioned by month with indexes;
  - a search word found in a third of all cases, which still counts every match (about 110 ms).
- **Next step if the data grows tenfold:** the 366-day dashboard is mostly percentiles and per-day totals over every
  job of the year. A daily summary table would remove that work.

## Administration and security

- The dashboard is the landing page for every role. It shows totals only: no patient data. Days are counted in the
  zone set by `APP_ZONE` (default `Asia/Ho_Chi_Minh`).
- Admins create users and reset passwords. Both give a temporary password, shown once, that must be changed at the
  next sign-in.
- Passwords need at least 10 characters (at most 72 bytes), a letter and a digit, must not contain the username, and
  must differ from the current one.
- Users are never deleted, only locked. A locked account gets the same answer as wrong credentials, and its open
  sessions end at their next request.
- An admin cannot lock, demote or reset their own account, and the last active admin can be neither locked nor
  demoted.
- A disabled AI model takes no new jobs and no manual retries; jobs already queued or running finish.
- The audit log can be searched over at most 93 days. The CSV export is limited to 100 000 rows (larger exports are
  refused), neutralises spreadsheet formulas, and is itself audited.

## Data and licences

Only public or anonymised data.

- X-ray: one PNG, JPEG or DICOM file (`.dcm`, CR/DX), at most 50 MB and 50 megapixels. It is re-encoded to PNG, which
  drops all embedded metadata and every DICOM tag.
- Volume: one NIfTI (`.nii`, `.nii.gz`), or one ZIP of a DICOM series or of PNG/JPEG slices, at most 500 MB. It is
  converted to NIfTI and no DICOM tag is kept. Without a slice spacing an image stack assumes 1 mm, and the viewer
  says so.
- Text burned into the pixels is **not** removed.

- Model weights: TorchXRayVision (Apache-2.0), TotalSegmentator (Apache-2.0).
- Report font: Noto Sans, SIL Open Font License 1.1
  ([`OFL.txt`](backend/core-service/src/main/resources/report/fonts/OFL.txt)).
- Sample CT scans: TotalSegmentator dataset, small subset ([Zenodo 10047263](https://zenodo.org/records/10047263)),
  CC BY 4.0 – Wasserthal J. et al., *TotalSegmentator: Robust Segmentation of 104 Anatomic Structures in CT Images*,
  Radiology: Artificial Intelligence, 2023.
- Check the licence of each dataset before any non-research use.

## License

[MIT](LICENSE). Third-party model weights and datasets keep their own licences (see above).
