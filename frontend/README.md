# MedImg frontend

React + TypeScript SPA: login, cases, a gallery of sample cases, upload of chest X-rays (PNG/JPG or
one DICOM file) and volumes (NIfTI, a ZIP of a DICOM series or of PNG/JPG slices; multipart above
64 MB), a 2D viewer with Grad-CAM heatmaps, a volume viewer (MPR with the organ segmentation
overlaid, and 3D meshes) and live AI job progress. The REST API it talks to is
documented by core-service's OpenAPI spec (Swagger UI at `/swagger-ui.html`); the matching types
live in `src/api/types.ts`.

Stack: React 19, Vite 8, TypeScript 6 (strict), Ant Design 6, TanStack Query 5, Zustand 5,
Axios, React Router 8, react-i18next (Vietnamese default, English), `@microsoft/fetch-event-source`
for SSE, Cornerstone3D 5.19 (`core`, `tools`, `nifti-volume-loader`) for MPR, three.js 0.187 with
react-three-fiber 9 and drei 10 for 3D. Tests: Vitest, React Testing Library, MSW; Playwright for
one browser smoke test. Production: static build served by Nginx.

## Run

Requires Node 24 (Node >= 22.22 works) and the backend stack from `../deploy` (core-service on
`:8080`, SeaweedFS S3 on `:8333`).

```bash
npm install
npm run dev        # http://localhost:5173
```

Demo accounts (shown on the login page, click to fill), password `Demo@12345`:

| User         | Role       | Can do                                                       |
| ------------ | ---------- | ------------------------------------------------------------ |
| `doctor`     | Doctor     | everything below                                             |
| `tech`       | Technician | create cases, upload images, run / cancel / retry AI jobs    |
| `admin`      | Admin      | same as doctor, plus marking cases as sample cases           |
| `researcher` | Researcher | read-only: cases, samples, viewer, AI results, live progress |

## Dev proxy

The browser only ever talks to `http://localhost:5173`; Vite proxies:

| Path         | Target                  | Notes                                                                           |
| ------------ | ----------------------- | ------------------------------------------------------------------------------- |
| `/api/**`    | `http://localhost:8080` | core-service REST + SSE                                                         |
| `/medimg/**` | `http://localhost:8333` | SeaweedFS S3, `changeOrigin: false` so the `Host` header stays `localhost:5173` |

Why the Host header matters: the backend presigns S3 URLs (SigV4) for the public host
(`S3_PUBLIC_ENDPOINT`, `http://localhost:5173` in dev), and SigV4 signs the `Host` header. If the
proxy rewrote it to `localhost:8333` the signature check would fail. Serving storage on the same
origin also means no CORS setup.

Uploads are a direct `PUT` of the raw file body to the presigned `putUrl` with the file's
`Content-Type` and **no** `Authorization` header (a separate Axios instance without interceptors),
or, for a multipart upload, one `fetch` `PUT` per part (see Design notes).

## Production image (Nginx)

`Dockerfile` builds the app with `npm ci && npm run build` on `node:24-alpine` and serves `dist/`
from `nginxinc/nginx-unprivileged` (runs as a non-root user, listens on **8080**, health check on
`/healthz`). `nginx.conf` does what the Vite proxy does in dev:

| Path                              | Behaviour                                                               |
| --------------------------------- | ----------------------------------------------------------------------- |
| `/assets/**`                      | hashed bundles, `Cache-Control: immutable` for a year, 404 when missing |
| anything else                     | file if it exists, otherwise `index.html` (SPA routes), `no-cache`      |
| `/api/**`                         | `core-service:8080` with `X-Forwarded-For` / `X-Forwarded-Proto`        |
| `/api/v1/predictions/{id}/events` | same upstream, unbuffered, 1 h read timeout (SSE)                       |
| `/medimg/**`                      | `seaweedfs:8333`, `Host` unchanged, 70 MB body cap, streamed PUT        |

Responses carry `X-Content-Type-Options`, `Referrer-Policy` and a Content-Security-Policy
(`style-src 'unsafe-inline'` is needed for Ant Design's CSS-in-JS; `img-src` allows `blob:` and
`data:` for the canvas viewer). The CT viewer needs nothing more: Cornerstone3D 5.x renders with
WebGL on the main thread (no `SharedArrayBuffer`, so no COOP/COEP headers), the NIfTI path uses no
WebAssembly codec and no blob: worker, and three.js / react-three-fiber need no `eval`. The
Playwright smoke test runs the production build under exactly this policy (read from
`nginx.conf`) and fails on any violation. Upstream host names are resolved per request through
Docker's embedded DNS (`127.0.0.11`), so the container starts even before core-service is up.
No request body to storage exceeds 64 MB (one PUT up to 64 MB, 32 MB parts above), so the body cap
is 70 MB, which also keeps every request under the 100 MB limit of a Cloudflare Tunnel.

```bash
docker build -t medimg-web:dev .
docker compose -f ../deploy/docker-compose.yml --profile full up --build   # http://localhost:8088
```

Behind the `web` container the backend must presign for the host the browser uses, e.g.
`S3_PUBLIC_ENDPOINT=http://localhost:8088`.

## Scripts

| Script                | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| `npm run dev`         | Vite dev server on port 5173 with the proxy above         |
| `npm run build`       | Type-check (`tsc -b`) and production build into `dist/`   |
| `npm run lint`        | ESLint (type-aware) + Prettier check                      |
| `npm run format`      | Prettier write                                            |
| `npm run typecheck`   | `tsc -b --noEmit`                                         |
| `npm test`            | Vitest (watch); `npm test -- --run` for a single run      |
| `npm run e2e`         | Playwright smoke test (builds, serves, headless Chromium) |
| `npm run e2e:install` | Downloads the Playwright Chromium build (once)            |

The scripts call `node node_modules/<pkg>/...` directly instead of the `.bin` shims: the npm
`.cmd` shims on Windows break when the project path contains `&`.

## Layout

```text
src/
  api/          typed REST client (types.ts = contract), axios + refresh interceptor, SSE stream,
                multipart part scheduler (multipartUpload.ts)
  app/          providers, router (viewer/upload lazy-loaded), theme, global CSS
  features/
    auth/       session store, login page, route guard, role permissions (`can` / `useCan`)
    layout/     shell: sidebar, header, demo banner, language switch
    cases/      case list, new-case modal, case detail (studies + AI history)
    samples/    sample gallery (`/samples`), admin "sample case" section of the case page
    upload/     3-step upload wizard, file checks (kind, content type, size, slice spacing),
                ZIP content / spacing fields, state machine hook (single PUT or multipart)
    viewer/     viewer page (routes by input type), 2D view with ImageViewer2D (canvas),
                pure viewport / window-level / CT window / clipping / camera math
      volume/   CT view: tabs MPR | 3D, structure list, label → colour mapping (structures.ts)
        mpr/    MprView + MprEngine interface; cornerstoneMprEngine.ts (lazy chunk)
        mesh/   MeshView (clipping UI) + MeshScene (react-three-fiber, lazy chunk)
    ai/         AI panel, findings / structures tables, live prediction hook (SSE → polling)
  i18n/         vi (default) / en messages, typed keys
  shared/       ProblemDetail alert, presigned thumbnail, error boundary, 404, formatting helpers
  test/         MSW server, fixtures (2D and CT), render helpers, fake MPR / 3D backends
e2e/            Playwright smoke tests and their synthetic CT / image stack fixture generator
```

`/studies/:id` loads the study and picks the view from `inputType`: `IMAGE_2D` and `DICOM_2D` (a
DICOM X-ray, normalised by the worker to an 8-bit PNG) get the canvas viewer; `NIFTI`,
`DICOM_SERIES` and `IMAGE_STACK` (all served as one normalised NIfTI volume) get the volume view.
Later slices (review/report, dashboard) are meant to land as new folders under `features/` and new
lazy routes in `app/router.tsx`.

## Design notes

- **Tokens.** The access token (15 min) is kept in memory only; the refresh token and user are
  persisted in `localStorage` (`medimg.auth`) so a reload keeps the session. After a reload the
  client refreshes before the first API call. On a 401 the interceptor refreshes once
  (single-flight: concurrent requests share one `/auth/refresh`, which matters because refresh
  tokens rotate) and replays the requests. If the server rejects the refresh the session is
  cleared, the route guard sends the user to `/login` and the login page says the session
  expired. `/auth/*` calls use a client without interceptors: login and logout never carry an
  access token, and logout clears the local session first, then revokes the refresh token.
- **Permissions.** `features/auth/permissions.ts` maps roles to UI actions (create case, upload,
  run AI, cancel / retry a job, and, for admins only, manage sample cases), mirroring
  core-service's `@PreAuthorize` rules. Components ask
  `useCan()` instead of checking roles; `/upload` is guarded by `RequirePermission`.
- **Errors.** Every non-2xx body is read as RFC 7807 ProblemDetail and its `detail` is shown
  (field errors are listed and mapped onto form fields where possible). The new-case form mirrors
  the server limits (code up to 32 letters, digits, `-`, `_`; note up to 500 characters; birth
  year 1900 to the current year).
- **Upload.** One file: a PNG/JPG or a DICOM X-ray `.dcm` (up to 50 MB), or a volume, `.nii`,
  `.nii.gz` or `.zip` (up to 500 MB). The content type is fixed per extension (`application/gzip`,
  `application/octet-stream`, `application/zip`, `application/dicom`, `image/png`, `image/jpeg`),
  because the presigned PUT is signed with the one declared at `uploads/init` and browsers report
  these files inconsistently (a `.dcm` usually as nothing at all). For a ZIP the wizard asks what it
  holds: a DICOM series, or PNG/JPG slices, which reveals three optional voxel spacing inputs (mm,
  each 0.01 to 20, all three or none, sent as `sliceSpacingMm`). Left empty, a warning says up front
  that the server will assume 1 mm. The worker decides from the content either way. `uploads/init`
  → upload (below) → `uploads/{id}/complete` → poll `GET /uploads/{id}` every second, showing the
  server's `progress`. Polling stops after 2 minutes (image), 5 minutes (DICOM X-ray, which waits in
  the ingest queue with the volumes) or 10 minutes (volume) with a translated error and retry / back
  actions; files the server rejects (at completion or while processing) show its reason verbatim.
  An automatic server-side retry (`UPLOADED`, 0 %) is shown as progress, not as an error. Leaving
  the page aborts the transfer; closing the tab during it asks for confirmation.
- **Multipart upload.** The server decides: for a file over 64 MB `uploads/init` returns
  `putUrl: null` and `multipart: {partSize, parts[{partNumber, url}]}` (32 MB parts).
  `api/multipartUpload.ts` checks the plan against the file (parts numbered 1..N with N =
  ceil(size / partSize)), slices the `File` (part n = bytes `[(n-1)·partSize, n·partSize)`), and
  runs at most 3 parts at a time with `fetch` (no `Authorization`, no `Content-Type`: a
  `Blob.slice()` has none and the part URLs do not sign one). A part that fails with a network
  error, 5xx, 408 or 429 is retried up to 3 times after 1 s, 2 s and 4 s; anything else (an expired
  signature's 403, a response without `ETag`) fails at once. The first part that fails for good
  aborts the others through one `AbortController`, which the wizard's cancel button and unmounting
  also trigger (pending backoff waits included); the promise settles only once nothing is in
  flight. Progress is counted in bytes of finished parts (fetch reports no upload progress), with
  "parts uploaded: n of N". Each part's `ETag` response header is kept exactly as returned, quotes
  included, and `uploads/{id}/complete` gets `{files: [{fileId, parts: [{partNumber, etag}]}]}` in
  ascending part order. A single PUT completes without a body.
- **Sample cases.** `/samples` (every role) lists `GET /samples`: one card per case with the first
  study's thumbnail, title, description, modality and input type, source / licence, and a
  "Segmented" badge when a volume's latest run is DONE. "Open" goes to the viewer, on that run when
  it is DONE. An empty case list links to it. On the case page an admin marks the case as a sample,
  edits its title (required, up to 120), description (up to 500) and source (required, up to 300),
  or removes it (`PUT` / `DELETE /patients/{id}/sample`); other roles see the sample details
  read-only.
- **Live AI progress.** `GET /predictions/{id}/events` is consumed with fetch streaming (EventSource
  cannot send `Authorization`). `:hb` heartbeats are ignored by the parser. The stream reconnects
  with backoff (1 s, 2 s) and a fresh token; after 3 consecutive failures the UI falls back to
  polling `GET /predictions/{id}` every 2 s until a terminal status. The findings table draws the
  threshold the run was started with (`prediction.params.threshold`, default 0.5).
- **Presigned URLs** expire after 15 minutes. When an image, thumbnail or heatmap fails to load,
  the study / prediction is refetched to get fresh URLs (capped retries).
- **Window/level** is applied on the decoded 8-bit luminance with a lookup table; viewport and W/L
  math live in `features/viewer/lib/*` as pure, unit-tested functions.

- **Volumes that are not CT.** Only a CT read from DICOM or NIfTI is in Hounsfield units
  (`hasHounsfieldUnits`). Any other volume (an image stack, stored as `OT`, or an MR) gets no CT
  presets; its default window covers the data range, which the MPR engine reports after loading
  (the voxel manager's per-slice range, a full scan as fallback), and Reset returns to it. It has no
  3D tab while it has no meshes (no model segments it), and when the server had to assume the
  spacing (`spacingAssumed`) a warning sits above the views and the spacing tag says "assumed". The
  AI panel says "No AI model for this image type" when `GET /models` returns none.
- **CT viewer, MPR.** Cornerstone3D is initialised once per page, on first use (`initCornerstone`:
  core, tools, the `nifti:` image loader, tools registered). Each mount of `MprView` creates one
  `MprEngine` (one rendering engine with axial, coronal and sagittal orthographic viewports, one
  tool group, one VOI synchroniser) and destroys it on unmount: tool group, synchroniser,
  rendering engine, segmentation and colour LUT, and the cached volumes and slice images (which
  also frees the NIfTI loader's buffer). Tabs keep the MPR mounted, so going to 3D and back
  neither reloads nor leaks anything. The NIfTI loader needs an absolute URL (it parses it with
  `new URL()`, detects gzip from the path and fetches the URL verbatim), so the same-origin
  presigned path is resolved against the page origin with its signed query untouched; objects must
  be served without `Content-Encoding` (the loader gunzips the bytes itself). Presigned URLs change
  on every refetch, so volume and labelmap loads are keyed by object path: a refetch never reloads
  them, a failed load refetches the study for a fresh URL and offers a retry. Tools: left button =
  selected tool (crosshairs, W/L, pan, zoom), right-drag W/L, middle-drag pan, wheel or arrow keys
  scroll slices; presets Soft tissue 400/40, Lung 1500/-600, Bone 1800/400.
- **Labelmap colours.** `segmentation.nii.gz` stores voxel value `i + 1` for the i-th label of the
  model (`GET /models?inputType=…` → `labels`), 0 being background. The label order is taken from
  the model with the run's exact code and version, never from the order of `meshes[]`; colours come
  from `meshes[].color` by label (`features/viewer/volume/structures.ts`, unit-tested). Labels with
  no mesh (absent or under 1 ml) stay transparent. If the model is unknown the overlay is not drawn
  (with a warning) rather than drawn with wrong colours; the 3D meshes still work.
- **CT viewer, 3D.** One GLB per structure, loaded when the 3D tab first opens and only once per
  object path. Meshes and centroids are in LPS millimetres, the world space Cornerstone3D derives
  from the NIfTI affine (RAS with x and y negated), so the scene draws them as they are, framed from
  the front with superior up. Visibility, colour and opacity per structure are shared with the MPR
  overlay; a clipping box (one range slider per axis, LPS mm over the meshes' bounds) cuts all
  meshes. Clicking a mesh, or the locate button of a structure, switches to MPR and moves the
  crosshair to the structure's `centroid` unchanged.
- **Testability.** Cornerstone3D and react-three-fiber sit behind `VolumeBackends` (an MPR engine
  factory and a scene component), provided by context with the real lazy implementations as
  default. jsdom tests inject fakes (`src/test/fakeVolumeBackends.tsx`) and check what the views ask
  of them; the browser smoke test checks the real rendering.
- **Bundle.** The initial load is unchanged from slice 1 (about 1.4 MB minified, 460 kB gzip).
  Cornerstone3D (with vtk.js and the DICOM metadata libraries it imports) is one lazy chunk of
  about 3.6 MB (1 MB gzip), loaded only by a CT study; three.js with react-three-fiber is a lazy
  chunk of about 1 MB (260 kB gzip), loaded when the 3D tab opens. Vite also emits Cornerstone's
  compute worker (about 3 MB), which this viewer never starts, hence the chunk size warning. The
  `events` package is a dependency only so that vtk.js's XML module, which extends Node's
  `EventEmitter`, can be evaluated in the browser.

## Browser smoke test (Playwright)

`npm run e2e` builds the app, serves it with `vite preview` and runs two specs in headless
Chromium (WebGL on SwiftShader). `viewer.smoke.spec.ts` opens a CT study. The REST API and object storage are answered by `page.route`
from an in-memory synthetic study (`e2e/fixtures/synthetic.ts`: a 96×96×64 int16 NIfTI with a
liver box and a spleen ball, its uint8 labelmap on the same affine, one GLB per structure in LPS
mm). Nothing is written to disk except screenshots in `test-results/screenshots/` (ignored). The
test checks that the three MPR views draw the volume and the labelmap in the expected colours,
that a window preset applies, that the 3D canvas draws the meshes, and that locating the spleen
moves the crosshair to its centroid and brings it into the axial view. Any page error, console
error or CSP violation fails it. `inputs.smoke.spec.ts` opens the sample gallery as a researcher,
checks a card (thumbnail, modality, source) and opens its study: a synthetic 8-bit image stack with
an assumed spacing, which must be drawn in all three views with the window over its data range (W
220 / L 110), no CT presets, no 3D tab and the spacing warning.
`E2E_BASE_URL=http://localhost:5173 npm run e2e` runs them against the dev server instead (without
the production CSP). Run `npm run e2e:install` once first.
