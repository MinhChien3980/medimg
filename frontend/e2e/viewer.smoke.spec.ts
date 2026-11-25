/**
 * Real-browser smoke test of the CT viewer: production build (`vite preview`) under the production
 * Content-Security-Policy from `nginx.conf`, REST API and object storage served from synthetic
 * in-memory fixtures. Checks that Cornerstone3D draws the three MPR views with the labelmap, that
 * react-three-fiber draws the meshes, and that clicking a structure in 3D moves the MPR to it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { generateSyntheticStudy, LABELS, DIMS, SPACING } from './fixtures/synthetic';

const SCREENSHOTS = path.resolve(import.meta.dirname, '../test-results/screenshots');

const STUDY_ID = '77777777-7777-4777-8777-777777777777';
const SERIES_ID = '88888888-8888-4888-8888-888888888888';
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SIGNED = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=e2e';

/** 1×1 grey PNG for the series thumbnail. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==',
  'base64',
);

const user = { id: 'u1', username: 'doctor', fullName: 'Dr. Demo', roles: ['DOCTOR'] };

function productionCsp(): string {
  const conf = readFileSync(path.resolve(import.meta.dirname, '../nginx.conf'), 'utf8');
  const match = /add_header Content-Security-Policy "([^"]+)"/.exec(conf);
  if (!match?.[1]) throw new Error('CSP not found in nginx.conf');
  return match[1];
}

const study = generateSyntheticStudy();

/** `expireFirstVolumeUrl`: the first study response carries a volume URL that storage refuses. */
async function mockBackend(page: Page, { expireFirstVolumeUrl = false } = {}) {
  const csp = productionCsp();
  const files = new Map<string, Buffer>([
    [`/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/thumb.png`, TINY_PNG],
    [`/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/volume.nii.gz`, study.volume],
    [`/medimg/predictions/${JOB_ID}/1/segmentation.nii.gz`, study.segmentation],
    ...study.structures.map(
      (s) => [`/medimg/predictions/${JOB_ID}/1/meshes/${s.label}.glb`, s.glb] as const,
    ),
  ]);

  const series = {
    id: SERIES_ID,
    modality: 'CT',
    rows: DIMS[1],
    cols: DIMS[0],
    numImages: DIMS[2],
    imageUrl: null,
    thumbnailUrl: `/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/thumb.png?${SIGNED}`,
    volumeUrl: `/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/volume.nii.gz?${SIGNED}`,
    dims: DIMS,
    spacing: SPACING,
  };
  const prediction = {
    jobId: JOB_ID,
    studyId: STUDY_ID,
    seriesId: SERIES_ID,
    status: 'DONE',
    progress: 100,
    attempt: 1,
    model: { code: 'ct-totalseg', version: '2.18.0-fast' },
    inferenceMs: 61_000,
    error: null,
    queuedAt: '2026-11-25T08:10:00Z',
    finishedAt: '2026-11-25T08:11:01Z',
    params: {},
    findings: study.structures.map((s, n) => ({
      id: `f${n}`,
      label: s.label,
      confidence: null,
      volumeMl: s.volumeMl,
      bbox: null,
      reviewStatus: 'PENDING',
    })),
    artifacts: {
      heatmaps: {},
      segmentation: `/medimg/predictions/${JOB_ID}/1/segmentation.nii.gz?${SIGNED}`,
      meshes: study.structures.map((s) => ({
        label: s.label,
        color: s.color,
        url: `/medimg/predictions/${JOB_ID}/1/meshes/${s.label}.glb?${SIGNED}`,
        triangles: 12,
        volumeMl: s.volumeMl,
        centroid: s.centroid,
      })),
    },
  };
  const api: Record<string, unknown> = {
    'POST /api/v1/auth/refresh': {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
      user,
    },
    'GET /api/v1/me': user,
    [`GET /api/v1/studies/${STUDY_ID}`]: {
      id: STUDY_ID,
      patientId: 'p1',
      inputType: 'NIFTI',
      modality: 'CT',
      bodyPart: 'ABDOMEN',
      createdAt: '2026-11-25T08:00:00Z',
      series: [series],
    },
    [`GET /api/v1/studies/${STUDY_ID}/predictions`]: [prediction],
    [`GET /api/v1/predictions/${JOB_ID}`]: prediction,
    // Slice 3: annotations and manual findings of the study (none here).
    [`GET /api/v1/studies/${STUDY_ID}/annotations`]: [],
    [`GET /api/v1/studies/${STUDY_ID}/findings`]: [],
    'GET /api/v1/models': [
      {
        id: 'm1',
        code: 'ct-totalseg',
        version: '2.18.0-fast',
        name: 'CT organ segmentation',
        task: 'SEGMENTATION_3D',
        labels: LABELS,
      },
    ],
  };

  let studyResponses = 0;
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === `/api/v1/studies/${STUDY_ID}`) {
      studyResponses += 1;
      const body = api[`GET ${url.pathname}`] as { series: Array<typeof series> };
      if (!expireFirstVolumeUrl || studyResponses > 1) return route.fulfill({ json: body });
      const expired = { ...series, volumeUrl: series.volumeUrl.replace('=e2e', '=expired') };
      return route.fulfill({ json: { ...body, series: [expired] } });
    }
    if (url.pathname.startsWith('/api/')) {
      const body = api[`${request.method()} ${url.pathname}`];
      if (body === undefined) return route.fulfill({ status: 404, json: { status: 404 } });
      return route.fulfill({ json: body });
    }
    if (url.pathname.startsWith('/medimg/')) {
      if (url.searchParams.get('X-Amz-Signature') !== 'e2e') return route.fulfill({ status: 403 });
      const file = files.get(url.pathname);
      if (!file) return route.fulfill({ status: 404 });
      // Like SeaweedFS: the gzip is the object itself, no Content-Encoding.
      const type = url.pathname.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      return route.fulfill({ body: file, contentType: type });
    }
    // The production CSP applies to the production build only: the dev server injects inline
    // scripts (React refresh), which that policy rightly refuses.
    if (request.resourceType() === 'document' && !process.env.E2E_BASE_URL) {
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': csp },
      });
    }
    return route.fallback();
  });

  await page.addInitScript((u) => {
    localStorage.setItem('medimg.lang', 'en');
    localStorage.setItem(
      'medimg.auth',
      JSON.stringify({ state: { refreshToken: 'refresh', user: u }, version: 1 }),
    );
  }, user);
}

interface PixelStats {
  /** Pixels that are not (near) black. */
  lit: number;
  /** Pixels close to the labelmap fill of each structure. */
  tinted: Record<string, number>;
}

/** Soft-tissue window (W 400 / L 40) as a VOI range, and the default labelmap fill opacity. */
const SOFT_TISSUE = { lower: -160, upper: 239 };
const FILL_ALPHA = 0.5;

/** Expected colour of a structure's fill: its colour blended over its grey level. */
function expectedFill(hex: string, hu: number): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const t = (hu - SOFT_TISSUE.lower) / (SOFT_TISSUE.upper - SOFT_TISSUE.lower);
  const grey = Math.min(1, Math.max(0, t)) * 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(
    (c) => FILL_ALPHA * c + (1 - FILL_ALPHA) * grey,
  ) as [number, number, number];
}

/** Decodes an element screenshot in the page (no image library needed in Node). */
async function pixelStats(page: Page, target: Locator): Promise<PixelStats> {
  const data = (await target.screenshot()).toString('base64');
  const fills = study.structures.map((s) => ({ label: s.label, rgb: expectedFill(s.color, s.hu) }));
  return page.evaluate(
    async ({ data, fills }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(image, 0, 0);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const tinted: Record<string, number> = Object.fromEntries(fills.map((f) => [f.label, 0]));
      let lit = 0;
      for (let p = 0; p < px.length; p += 4) {
        const r = px[p] ?? 0;
        const g = px[p + 1] ?? 0;
        const b = px[p + 2] ?? 0;
        if (r + g + b > 45) lit += 1;
        for (const f of fills) {
          const d = Math.hypot(r - f.rgb[0], g - f.rgb[1], b - f.rgb[2]);
          if (d < 24) tinted[f.label] = (tinted[f.label] ?? 0) + 1;
        }
      }
      return { lit, tinted };
    },
    { data, fills },
  );
}

async function expectRendered(page: Page, target: Locator, name: string) {
  await expect
    .poll(async () => (await pixelStats(page, target)).lit, { timeout: 30_000 })
    .toBeGreaterThan(500);
  await target.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
}

test('CT viewer renders MPR with the labelmap and 3D meshes, and jumps from 3D to MPR', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    // React/antd development warnings only exist on the dev server.
    if (text.startsWith('Warning: [antd:')) return;
    if (msg.type() === 'error' || /Content Security Policy|Refused to/i.test(text)) {
      problems.push(`console.${msg.type()}: ${text}`);
    }
  });

  await mockBackend(page);
  await page.goto(`/studies/${STUDY_ID}`);

  // ---- MPR: three views drawn by Cornerstone3D, labelmap overlaid ----
  const views = ['axial', 'coronal', 'sagittal'].map((o) => page.getByTestId(`mpr-${o}`));
  await expect(page.getByRole('tab', { name: 'MPR' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Loading CT volume…')).toBeHidden({ timeout: 60_000 });
  for (const [n, view] of views.entries()) {
    await expect(view.locator('canvas').first()).toBeVisible();
    await expectRendered(page, view, `mpr-${['axial', 'coronal', 'sagittal'][n]}`);
  }
  await expect(page.getByText('Loading segmentation…')).toBeHidden({ timeout: 30_000 });
  const [axial, coronal] = views as [Locator, Locator, Locator];
  // Initial crosshair at the volume centre: the coronal slice cuts both structures, the axial
  // slice (z = -320 mm) is above the spleen ball and below the liver box.
  await expect
    .poll(async () => (await pixelStats(page, coronal)).tinted.liver, { timeout: 20_000 })
    .toBeGreaterThan(200);
  expect((await pixelStats(page, coronal)).tinted.spleen).toBeGreaterThan(20);
  expect((await pixelStats(page, axial)).tinted.spleen).toBe(0);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'mpr-page.png') });

  // Window presets.
  await page.getByText('Lung', { exact: true }).click();
  await expect(page.getByTestId('mpr-window')).toHaveText('W 1500 / L -600');
  await page.getByText('Soft tissue', { exact: true }).click();
  await expect(page.getByTestId('mpr-window')).toHaveText('W 400 / L 40');

  // ---- 3D: meshes drawn by react-three-fiber ----
  await page.getByRole('tab', { name: '3D' }).click();
  const scene = page.getByTestId('mesh-canvas');
  await expect(scene.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('clip-x')).toBeVisible({ timeout: 30_000 });
  await expectRendered(page, scene, 'mesh-3d');
  await page.screenshot({ path: path.join(SCREENSHOTS, 'mesh-page.png') });

  // ---- Locate the spleen: back to MPR, crosshair at its centroid (LPS mm), spleen visible ----
  const spleen = study.structures.find((s) => s.label === 'spleen');
  if (!spleen) throw new Error('fixture without spleen');
  await page.getByRole('button', { name: 'Show Spleen on MPR' }).click();
  await expect(page.getByRole('tab', { name: 'MPR' })).toHaveAttribute('aria-selected', 'true');
  const expected = spleen.centroid.map((v) => v.toFixed(1)).join(', ');
  await expect(page.getByTestId('mpr-crosshair')).toContainText(expected);
  await expect
    .poll(async () => (await pixelStats(page, axial)).tinted.spleen, { timeout: 20_000 })
    .toBeGreaterThan(100);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'mpr-after-locate.png') });

  expect(problems).toEqual([]);
});

test('an expired volume URL is refreshed from the API and the volume loads on retry', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await mockBackend(page, { expireFirstVolumeUrl: true });
  await page.goto(`/studies/${STUDY_ID}`);

  await expect(page.getByText('Could not load the CT volume')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Retry/ }).click();
  await expect(page.getByText('Could not load the CT volume')).toBeHidden();
  await expect(page.getByText('Loading CT volume…')).toBeHidden({ timeout: 60_000 });
  await expectRendered(page, page.getByTestId('mpr-axial'), 'mpr-axial-after-retry');
  expect(errors).toEqual([]);
});
