/**
 * Real-browser smoke test of slice 3 on a DICOM X-ray, on the production build under the
 * production Content-Security-Policy: draw a rectangle and a calibrated length on the 2D viewer,
 * accept an AI finding, add the view (with its annotations) to a new report as a key image, write
 * the impression, refill the pre-filled sections from the reviewed findings and sign. The REST API and object storage are an in-memory fake answering through
 * `page.route`, so the requests the UI sends are checked too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { syntheticChestXray } from './fixtures/png';

const SCREENSHOTS = path.resolve(import.meta.dirname, '../test-results/screenshots');

const PATIENT_ID = '31313131-3131-4313-8313-313131313131';
const STUDY_ID = '32323232-3232-4323-8323-323232323232';
const SERIES_ID = '33333333-3333-4333-8333-333333333334';
const JOB_ID = '34343434-3434-4343-8343-343434343434';
const SIGNED = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=e2e';
const SIZE = 512;
const SPACING = 0.3;

const user = { id: 'u1', username: 'doctor', fullName: 'Dr. Demo', roles: ['DOCTOR'] };
const userRef = { id: user.id, fullName: user.fullName };

function productionCsp(): string {
  const conf = readFileSync(path.resolve(import.meta.dirname, '../nginx.conf'), 'utf8');
  const match = /add_header Content-Security-Policy "([^"]+)"/.exec(conf);
  if (!match?.[1]) throw new Error('CSP not found in nginx.conf');
  return match[1];
}

type Json = Record<string, unknown>;

interface Recorded {
  annotations: Json[];
  reviews: Array<{ id: string; body: Json }>;
  reportPuts: Json[];
  refills: Json[];
  finalized: Json[];
  keyImages: Buffer[];
}

async function mockBackend(page: Page): Promise<Recorded> {
  const csp = productionCsp();
  const imagePath = `/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/image.png`;
  const files = new Map<string, Buffer>([
    [imagePath, syntheticChestXray(SIZE)],
    [`/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/thumb.png`, syntheticChestXray(64)],
  ]);
  const rec: Recorded = {
    annotations: [],
    reviews: [],
    reportPuts: [],
    refills: [],
    finalized: [],
    keyImages: [],
  };

  const study = {
    id: STUDY_ID,
    patientId: PATIENT_ID,
    inputType: 'DICOM_2D',
    modality: 'DX',
    bodyPart: 'CHEST',
    createdAt: '2026-11-25T08:00:00Z',
    series: [
      {
        id: SERIES_ID,
        modality: 'DX',
        rows: SIZE,
        cols: SIZE,
        numImages: 1,
        imageUrl: `${imagePath}?${SIGNED}`,
        thumbnailUrl: `/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/thumb.png?${SIGNED}`,
        volumeUrl: null,
        dims: null,
        spacing: null,
        spacingAssumed: false,
        pixelSpacing: [SPACING, SPACING],
      },
    ],
  };
  const finding = (id: string, label: string, confidence: number) => ({
    id,
    seriesId: SERIES_ID,
    source: 'AI',
    label,
    confidence,
    volumeMl: null,
    bbox: null,
    reviewStatus: 'PENDING',
    review: null,
    annotationId: null,
    version: 0,
  });
  const findings: Json[] = [finding('f1', 'Cardiomegaly', 0.87), finding('f2', 'Effusion', 0.31)];
  const prediction = () => ({
    jobId: JOB_ID,
    studyId: STUDY_ID,
    seriesId: SERIES_ID,
    status: 'DONE',
    progress: 100,
    attempt: 1,
    model: { code: 'cxr-multilabel', version: '0.1.0-xrv' },
    inferenceMs: 812,
    error: null,
    queuedAt: '2026-11-25T08:10:00Z',
    finishedAt: '2026-11-25T08:10:01Z',
    params: { threshold: 0.5 },
    findings,
    artifacts: { heatmaps: {}, segmentation: null, meshes: [] },
  });
  const annotations: Json[] = [];
  const reports: Json[] = [];
  const now = () => new Date().toISOString();

  type Handler = (match: RegExpMatchArray, body: Json) => unknown;
  const routes: Array<[string, RegExp, Handler]> = [
    [
      'POST',
      /^\/api\/v1\/auth\/refresh$/,
      () => ({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 900, user }),
    ],
    ['GET', /^\/api\/v1\/me$/, () => user],
    ['GET', new RegExp(`^/api/v1/studies/${STUDY_ID}$`), () => study],
    ['GET', new RegExp(`^/api/v1/studies/${STUDY_ID}/predictions$`), () => [prediction()]],
    ['GET', new RegExp(`^/api/v1/predictions/${JOB_ID}$`), () => prediction()],
    [
      'GET',
      /^\/api\/v1\/models$/,
      () => [
        {
          id: 'm1',
          code: 'cxr-multilabel',
          version: '0.1.0-xrv',
          name: 'Chest X-ray multilabel',
          task: 'CLASSIFICATION_2D',
          labels: ['Cardiomegaly', 'Effusion'],
        },
      ],
    ],
    [
      'GET',
      new RegExp(`^/api/v1/patients/${PATIENT_ID}$`),
      () => ({
        id: PATIENT_ID,
        code: 'CASE-E2E',
        birthYear: 1970,
        sex: 'M',
        note: null,
        studyCount: 1,
        createdAt: '2026-11-25T08:00:00Z',
        sample: null,
      }),
    ],
    ['GET', new RegExp(`^/api/v1/studies/${STUDY_ID}/findings$`), () => findings],
    [
      'PATCH',
      /^\/api\/v1\/findings\/([^/]+)\/review$/,
      (m, body) => {
        rec.reviews.push({ id: m[1] ?? '', body });
        const f = findings.find((x) => x.id === m[1]);
        if (!f) return undefined;
        Object.assign(f, {
          reviewStatus: body.status,
          review: {
            status: body.status,
            label: body.label ?? null,
            note: body.note ?? null,
            reviewedBy: userRef,
            reviewedAt: now(),
          },
          version: Number(f.version) + 1,
        });
        return f;
      },
    ],
    ['GET', new RegExp(`^/api/v1/studies/${STUDY_ID}/annotations$`), () => annotations],
    [
      'POST',
      new RegExp(`^/api/v1/studies/${STUDY_ID}/annotations$`),
      (_m, body) => {
        rec.annotations.push(body);
        const created = {
          id: `ann-${annotations.length + 1}`,
          studyId: STUDY_ID,
          author: userRef,
          label: null,
          note: null,
          measurement: null,
          ...body,
          createdAt: now(),
          updatedAt: now(),
          version: 0,
        };
        annotations.push(created);
        return created;
      },
    ],
    ['GET', new RegExp(`^/api/v1/studies/${STUDY_ID}/reports$`), () => reports],
    [
      'POST',
      new RegExp(`^/api/v1/studies/${STUDY_ID}/reports$`),
      (_m, body) => {
        const created = {
          id: 'rep-1',
          studyId: STUDY_ID,
          version: 1,
          status: 'DRAFT',
          template: body.template ?? 'CXR',
          language: body.language,
          clinicalInfo: '',
          technique: `DX chest, ${SIZE}×${SIZE}, pixel spacing ${SPACING} mm.`,
          findingsText: '- Cardiomegaly (AI, 87%), accepted.',
          impression: '',
          author: userRef,
          signedBy: null,
          signedAt: null,
          amendsReportId: null,
          keyImages: [] as Json[],
          createdAt: now(),
          updatedAt: now(),
          rowVersion: 0,
        };
        reports.unshift(created);
        return created;
      },
    ],
    ['GET', /^\/api\/v1\/reports\/([^/]+)$/, (m) => reports.find((r) => r.id === m[1])],
    [
      'PUT',
      /^\/api\/v1\/reports\/([^/]+)$/,
      (m, body) => {
        rec.reportPuts.push(body);
        const r = reports.find((x) => x.id === m[1]);
        if (!r) return undefined;
        const { rowVersion, keyImages: _order, ...sections } = body;
        Object.assign(r, sections, { rowVersion: Number(rowVersion) + 1, updatedAt: now() });
        return r;
      },
    ],
    [
      'POST',
      /^\/api\/v1\/reports\/([^/]+)\/key-images\/init$/,
      (m, body) => {
        const r = reports.find((x) => x.id === m[1]);
        const images = (r?.keyImages ?? []) as Json[];
        const id = `k${images.length + 1}`;
        images.push({
          id,
          caption: body.caption ?? null,
          position: images.length,
          uploaded: false,
          url: null,
        });
        return {
          imageId: id,
          putUrl: `/medimg/reports/${String(m[1])}/key-images/${id}.png?${SIGNED}`,
          expiresAt: now(),
        };
      },
    ],
    [
      'POST',
      /^\/api\/v1\/reports\/([^/]+)\/key-images\/([^/]+)\/complete$/,
      (m) => {
        const r = reports.find((x) => x.id === m[1]);
        const image = ((r?.keyImages ?? []) as Json[]).find((k) => k.id === m[2]);
        if (!image) return undefined;
        Object.assign(image, {
          uploaded: true,
          url: `/medimg/reports/${String(m[1])}/key-images/${String(m[2])}.png?${SIGNED}`,
        });
        return {};
      },
    ],
    [
      'POST',
      /^\/api\/v1\/reports\/([^/]+)\/refill$/,
      (m, body) => {
        rec.refills.push(body);
        const r = reports.find((x) => x.id === m[1]);
        if (!r) return undefined;
        const accepted = findings.filter((f) => f.reviewStatus === 'ACCEPTED');
        Object.assign(r, {
          technique: `Chest radiograph, modality DX; image ${SIZE} × ${SIZE} px.`,
          findingsText: accepted
            .map(
              (f) =>
                `- ${String(f.label)} (AI, confidence ${Math.round(Number(f.confidence) * 100)}%)`,
            )
            .join('\n'),
          rowVersion: Number(r.rowVersion) + 1,
          updatedAt: now(),
        });
        return r;
      },
    ],
    [
      'POST',
      /^\/api\/v1\/reports\/([^/]+)\/finalize$/,
      (m, body) => {
        rec.finalized.push(body);
        const r = reports.find((x) => x.id === m[1]);
        if (!r) return undefined;
        Object.assign(r, {
          status: 'FINAL',
          signedBy: userRef,
          signedAt: now(),
          rowVersion: Number(r.rowVersion) + 1,
        });
        return r;
      },
    ],
  ];

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (method !== request.method() || !match) continue;
        const body = (request.postDataJSON() ?? {}) as Json;
        const result = handler(match, body);
        if (result === undefined) return route.fulfill({ status: 404, json: { status: 404 } });
        return route.fulfill({ status: method === 'POST' ? 201 : 200, json: result });
      }
      return route.fulfill({ status: 404, json: { status: 404, detail: url.pathname } });
    }
    if (url.pathname.startsWith('/medimg/')) {
      if (url.searchParams.get('X-Amz-Signature') !== 'e2e') return route.fulfill({ status: 403 });
      if (request.method() === 'PUT') {
        const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
        files.set(url.pathname, bytes);
        rec.keyImages.push(bytes);
        return route.fulfill({ status: 200, body: '' });
      }
      const file = files.get(url.pathname);
      if (!file) return route.fulfill({ status: 404 });
      return route.fulfill({ body: file, contentType: 'image/png' });
    }
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
  return rec;
}

/** Drags with the left button between two points given as fractions of the annotation layer. */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = await page.getByTestId('annotation-layer').boundingBox();
  if (!box) throw new Error('annotation layer not laid out');
  const at = ([fx, fy]: [number, number]) =>
    [box.x + box.width * fx, box.y + box.height * fy] as const;
  const [x0, y0] = at(from);
  const [x1, y1] = at(to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
}

/** Pixels of a PNG close to the colour of one's own annotations (#ffd54f), decoded in the page. */
async function annotationPixels(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (data) => {
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
    let count = 0;
    for (let p = 0; p < px.length; p += 4) {
      const r = px[p] ?? 0;
      const g = px[p + 1] ?? 0;
      const b = px[p + 2] ?? 0;
      if (r > 220 && g > 170 && g < 240 && b < 140) count += 1;
    }
    return count;
  }, png.toString('base64'));
}

test('annotate a DICOM X-ray, review a finding, report it with a key image and sign', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('Warning: [antd:')) return;
    if (msg.type() === 'error' || /Content Security Policy|Refused to/i.test(text)) {
      problems.push(`console.${msg.type()}: ${text}`);
    }
  });

  const rec = await mockBackend(page);
  await page.goto(`/studies/${STUDY_ID}`);
  await expect(page.getByText(`${SIZE}×${SIZE}`, { exact: false })).toBeVisible();
  await expect(page.getByTestId('pixel-spacing')).toHaveText('0.300 × 0.300 mm');

  // ---- 2D annotations: a rectangle and a calibrated length ----
  await page.getByRole('button', { name: 'Draw a rectangle' }).click();
  await drag(page, [0.56, 0.3], [0.7, 0.5]);
  await expect(page.locator('[data-kind="RECTANGLE"]')).toHaveCount(1);
  await expect.poll(() => rec.annotations.length).toBe(1);
  expect(rec.annotations[0]).toMatchObject({ seriesId: SERIES_ID, kind: 'RECTANGLE' });
  expect(rec.annotations[0]?.measurement).toEqual({
    areaMm2: expect.any(Number),
  });

  await page.getByRole('button', { name: 'Measure a length' }).click();
  await drag(page, [0.36, 0.55], [0.45, 0.75]);
  await expect.poll(() => rec.annotations.length).toBe(2);
  expect(rec.annotations[1]).toMatchObject({ kind: 'LENGTH' });
  const lengthMm = (rec.annotations[1]?.measurement as { lengthMm: number }).lengthMm;
  const geometry = rec.annotations[1]?.geometry as { from: number[]; to: number[] };
  const pixels = Math.hypot(
    (geometry.to[0] ?? 0) - (geometry.from[0] ?? 0),
    (geometry.to[1] ?? 0) - (geometry.from[1] ?? 0),
  );
  expect(lengthMm).toBeCloseTo(pixels * SPACING, 1);
  await expect(page.getByTestId('annotation-layer').getByText(/ mm$/)).toBeVisible();
  await page.getByRole('button', { name: 'Measure a length' }).click(); // back to panning

  // ---- review: accept the AI finding ----
  await page.getByRole('tab', { name: 'AI analysis' }).click();
  await page.getByRole('button', { name: 'Accept Cardiomegaly' }).click();
  await expect(page.getByTestId('review-status-f1')).toHaveText('Accepted');
  await expect
    .poll(() => rec.reviews)
    .toEqual([{ id: 'f1', body: { status: 'ACCEPTED', version: 0 } }]);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'review-annotations-2d.png') });

  // ---- key image: the view with its annotations, into a new draft ----
  await page.getByRole('button', { name: /Add to report/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a key image to the report' });
  // Suggested caption: the study, then the selected annotation (the length just drawn).
  await expect(dialog.getByLabel('Caption')).toHaveValue('DX CHEST – Length 2');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Key image added.')).toBeVisible();
  expect(rec.keyImages).toHaveLength(1);
  const keyImage = rec.keyImages[0] ?? Buffer.alloc(0);
  expect(keyImage.subarray(0, 4).toString('hex')).toBe('89504e47');
  expect(await annotationPixels(page, keyImage)).toBeGreaterThan(200);

  // ---- report: write the impression, sign ----
  await page.getByRole('button', { name: 'Open report' }).click();
  await expect(page).toHaveURL(new RegExp(`/studies/${STUDY_ID}/report$`));
  await expect(page.getByText('Draft, version 1')).toBeVisible();
  await expect(page.getByLabel('Findings')).toHaveValue('- Cardiomegaly (AI, 87%), accepted.');
  const keyImg = page.getByRole('img', { name: 'DX CHEST – Length 2' });
  await expect
    .poll(() => keyImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await page.getByLabel('Impression').fill('Cardiomegaly. Rounded opacity, right upper zone.');
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
  expect(rec.reportPuts.at(-1)).toMatchObject({
    impression: 'Cardiomegaly. Rounded opacity, right upper zone.',
  });

  // ---- refill: Technique and Findings written again from the reviewed findings ----
  await page.getByRole('button', { name: /Refill from reviewed findings/ }).click();
  await page
    .getByRole('dialog', { name: 'Replace Technique and Findings?' })
    .getByRole('button', { name: 'Refill' })
    .click();
  await expect(page.getByRole('textbox', { name: 'Findings' })).toHaveValue(
    '- Cardiomegaly (AI, confidence 87%)',
  );
  await expect(page.getByRole('textbox', { name: 'Technique' })).toHaveValue(
    `Chest radiograph, modality DX; image ${SIZE} × ${SIZE} px.`,
  );
  await expect(page.getByRole('textbox', { name: 'Impression' })).toHaveValue(
    'Cardiomegaly. Rounded opacity, right upper zone.',
  );
  expect(rec.refills).toHaveLength(1);

  await page.getByRole('button', { name: /Sign and finalize/ }).click();
  await page
    .getByRole('dialog', { name: 'Sign and finalize this report?' })
    .getByRole('button', { name: 'Sign' })
    .click();
  await expect(page.getByText('Signed report, version 1')).toBeVisible();
  expect(rec.finalized).toHaveLength(1);
  await expect(page.getByRole('button', { name: /Download PDF/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Create amendment/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'Case CASE-E2E' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENSHOTS, 'report-signed.png') });

  expect(problems).toEqual([]);
});
