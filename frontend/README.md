# MedImg frontend

React + TypeScript SPA for the chest X-ray slice: login, cases, upload, 2D viewer with
Grad-CAM heatmaps and live AI job progress. The REST API it talks to is documented by
core-service's OpenAPI spec (Swagger UI at `/swagger-ui.html`); the matching types live in
`src/api/types.ts`.

Stack: React 19, Vite 8, TypeScript 6 (strict), Ant Design 6, TanStack Query 5, Zustand 5,
Axios, React Router 8, react-i18next (Vietnamese default, English), `@microsoft/fetch-event-source`
for SSE. Tests: Vitest, React Testing Library, MSW. Production: static build served by Nginx.

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
| `admin`      | Admin      | same as doctor                                               |
| `researcher` | Researcher | read-only: cases, studies, viewer, AI results, live progress |

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
`Content-Type` and **no** `Authorization` header (a separate Axios instance without interceptors).

## Production image (Nginx)

`Dockerfile` builds the app with `npm ci && npm run build` on `node:24-alpine` and serves `dist/`
from `nginxinc/nginx-unprivileged` (runs as a non-root user, listens on **8080**, health check on
`/healthz`). `nginx.conf` does what the Vite proxy does in dev:

| Path                              | Behaviour                                                                   |
| --------------------------------- | --------------------------------------------------------------------------- |
| `/assets/**`                      | hashed bundles, `Cache-Control: immutable` for a year, 404 when missing     |
| anything else                     | file if it exists, otherwise `index.html` (SPA routes), `no-cache`          |
| `/api/**`                         | `core-service:8080` with `X-Forwarded-For` / `X-Forwarded-Proto`            |
| `/api/v1/predictions/{id}/events` | same upstream, unbuffered, 1 h read timeout (SSE)                           |
| `/medimg/**`                      | `seaweedfs:8333`, `Host` passed through unchanged, 60 MB body, streamed PUT |

Responses carry `X-Content-Type-Options`, `Referrer-Policy` and a Content-Security-Policy
(`style-src 'unsafe-inline'` is needed for Ant Design's CSS-in-JS; `img-src` allows `blob:` and
`data:` for the canvas viewer). Upstream host names are resolved per request through Docker's
embedded DNS (`127.0.0.11`), so the container starts even before core-service is up.

```bash
docker build -t medimg-web:dev .
docker compose -f ../deploy/docker-compose.yml --profile full up --build   # http://localhost:8088
```

Behind the `web` container the backend must presign for the host the browser uses, e.g.
`S3_PUBLIC_ENDPOINT=http://localhost:8088`.

## Scripts

| Script              | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | Vite dev server on port 5173 with the proxy above       |
| `npm run build`     | Type-check (`tsc -b`) and production build into `dist/` |
| `npm run lint`      | ESLint (type-aware) + Prettier check                    |
| `npm run format`    | Prettier write                                          |
| `npm run typecheck` | `tsc -b --noEmit`                                       |
| `npm test`          | Vitest (watch); `npm test -- --run` for a single run    |

The scripts call `node node_modules/<pkg>/...` directly instead of the `.bin` shims: the npm
`.cmd` shims on Windows break when the project path contains `&`.

## Layout

```text
src/
  api/          typed REST client (types.ts = contract), axios + refresh interceptor, SSE stream
  app/          providers, router (viewer/upload lazy-loaded), theme, global CSS
  features/
    auth/       session store, login page, route guard, role permissions (`can` / `useCan`)
    layout/     shell: sidebar, header, demo banner, language switch
    cases/      case list, new-case modal, case detail (studies + AI history)
    upload/     3-step upload wizard and its state machine hook
    viewer/     viewer page, ImageViewer2D (canvas), pure viewport / window-level math
    ai/         AI panel, findings table, live prediction hook (SSE → polling fallback)
  i18n/         vi (default) / en messages, typed keys
  shared/       ProblemDetail alert, error boundary, 404, formatting helpers
  test/         MSW server, fixtures, render helpers
```

New slices (DICOM/MPR with Cornerstone3D, 3D meshes with three.js, review/report, dashboard)
are meant to land as new folders under `features/` and new lazy routes in `app/router.tsx`.
`ImageViewer2D` takes only `imageUrl`, `overlays[]`, `tool` and exposes `reset()` / `toBlob()`,
so it can be swapped for a Cornerstone3D viewport behind the same interface.

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
  run AI, cancel / retry a job), mirroring core-service's `@PreAuthorize` rules. Components ask
  `useCan()` instead of checking roles; `/upload` is guarded by `RequirePermission`.
- **Errors.** Every non-2xx body is read as RFC 7807 ProblemDetail and its `detail` is shown
  (field errors are listed and mapped onto form fields where possible). The new-case form mirrors
  the server limits (code up to 32 letters, digits, `-`, `_`; note up to 500 characters; birth
  year 1900 to the current year).
- **Upload.** `uploads/init` → presigned PUT with progress → `uploads/{id}/complete` → poll
  `GET /uploads/{id}` every second. Polling stops after 2 minutes with a translated error and
  retry / back actions; images the server rejects (e.g. over 50 megapixels) show its reason.
- **Live AI progress.** `GET /predictions/{id}/events` is consumed with fetch streaming (EventSource
  cannot send `Authorization`). `:hb` heartbeats are ignored by the parser. The stream reconnects
  with backoff (1 s, 2 s) and a fresh token; after 3 consecutive failures the UI falls back to
  polling `GET /predictions/{id}` every 2 s until a terminal status. The findings table draws the
  threshold the run was started with (`prediction.params.threshold`, default 0.5).
- **Presigned URLs** expire after 15 minutes. When an image, thumbnail or heatmap fails to load,
  the study / prediction is refetched to get fresh URLs (capped retries).
- **Window/level** is applied on the decoded 8-bit luminance with a lookup table; viewport and W/L
  math live in `features/viewer/lib/*` as pure, unit-tested functions.
