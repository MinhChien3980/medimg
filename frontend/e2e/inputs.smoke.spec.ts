/**
 * Real-browser smoke test of slice 2b's viewing side, on the production build under the production
 * Content-Security-Policy: the sample gallery renders and opens a sample, and an image stack (not
 * Hounsfield units, spacing assumed) is drawn by Cornerstone3D with a window over its data range.
 * REST API and object storage are answered from in-memory fixtures, as in `viewer.smoke.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIMS, generateImageStackVolume, STACK_MAX } from './fixtures/synthetic';

const SCREENSHOTS = path.resolve(import.meta.dirname, '../test-results/screenshots');

const PATIENT_ID = '21212121-2121-4212-8212-212121212121';
const STUDY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SERIES_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SIGNED = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=e2e';

/** 1×1 grey PNG for the thumbnail. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==',
  'base64',
);

const user = {
  id: 'u1',
  username: 'researcher',
  fullName: 'Demo Researcher',
  roles: ['RESEARCHER'],
};

function productionCsp(): string {
  const conf = readFileSync(path.resolve(import.meta.dirname, '../nginx.conf'), 'utf8');
  const match = /add_header Content-Security-Policy "([^"]+)"/.exec(conf);
  if (!match?.[1]) throw new Error('CSP not found in nginx.conf');
  return match[1];
}

const thumbPath = `/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/thumb.png`;
const volumePath = `/medimg/studies/${STUDY_ID}/series/${SERIES_ID}/volume.nii.gz`;

async function mockBackend(page: Page) {
  const csp = productionCsp();
  const files = new Map<string, Buffer>([
    [thumbPath, TINY_PNG],
    [volumePath, generateImageStackVolume()],
  ]);
  const api: Record<string, unknown> = {
    'POST /api/v1/auth/refresh': {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
      user,
    },
    'GET /api/v1/me': user,
    'GET /api/v1/samples': [
      {
        patientId: PATIENT_ID,
        code: 'CASE-STACK1',
        title: 'Synthetic image stack',
        description: 'Forty-ish 8-bit slices, uploaded without slice spacing.',
        source: 'Generated for this test, public domain',
        studies: [
          {
            studyId: STUDY_ID,
            inputType: 'IMAGE_STACK',
            modality: 'OT',
            thumbnailUrl: `${thumbPath}?${SIGNED}`,
            latestPrediction: null,
          },
        ],
      },
    ],
    [`GET /api/v1/studies/${STUDY_ID}`]: {
      id: STUDY_ID,
      patientId: PATIENT_ID,
      inputType: 'IMAGE_STACK',
      modality: 'OT',
      bodyPart: 'OTHER',
      createdAt: '2026-11-25T08:00:00Z',
      series: [
        {
          id: SERIES_ID,
          modality: 'OT',
          rows: DIMS[1],
          cols: DIMS[0],
          numImages: DIMS[2],
          imageUrl: null,
          thumbnailUrl: `${thumbPath}?${SIGNED}`,
          volumeUrl: `${volumePath}?${SIGNED}`,
          dims: DIMS,
          spacing: [1, 1, 1],
          spacingAssumed: true,
        },
      ],
    },
    [`GET /api/v1/studies/${STUDY_ID}/predictions`]: [],
    // Slice 3: annotations and manual findings of the study (none here).
    [`GET /api/v1/studies/${STUDY_ID}/annotations`]: [],
    [`GET /api/v1/studies/${STUDY_ID}/findings`]: [],
    'GET /api/v1/models': [],
  };

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      const body = api[`${request.method()} ${url.pathname}`];
      if (body === undefined) return route.fulfill({ status: 404, json: { status: 404 } });
      return route.fulfill({ json: body });
    }
    if (url.pathname.startsWith('/medimg/')) {
      if (url.searchParams.get('X-Amz-Signature') !== 'e2e') return route.fulfill({ status: 403 });
      const file = files.get(url.pathname);
      if (!file) return route.fulfill({ status: 404 });
      const type = url.pathname.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      return route.fulfill({ body: file, contentType: type });
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
}

/** Pixels of an element screenshot that are not (near) black, decoded in the page. */
async function litPixels(page: Page, target: Locator): Promise<number> {
  const data = (await target.screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let p = 0; p < px.length; p += 4) {
      if ((px[p] ?? 0) + (px[p + 1] ?? 0) + (px[p + 2] ?? 0) > 45) lit += 1;
    }
    return lit;
  }, data);
}

test('sample gallery opens an image stack, drawn over its data range with the spacing flagged', async ({
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

  await mockBackend(page);
  await page.goto('/samples');

  // ---- Gallery: every role, card with thumbnail, modality, source ----
  await expect(page.getByRole('menuitem', { name: /Sample cases/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic image stack' })).toBeVisible();
  const thumbnail = page.getByRole('img', { name: 'Thumbnail of Synthetic image stack' });
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(1);
  await expect(page.getByText('OT · Image stack')).toBeVisible();
  await expect(page.getByText('Source: Generated for this test, public domain')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOTS, 'samples-gallery.png') });

  await page.getByRole('button', { name: 'Open Synthetic image stack (OT) in the viewer' }).click();
  await expect(page).toHaveURL(new RegExp(`/studies/${STUDY_ID}$`));

  // ---- Image stack in MPR: no CT presets, window = data range, no 3D tab, spacing flagged ----
  await expect(page.getByText('Loading volume…')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('mpr-window')).toHaveText(
    `W ${STACK_MAX + 1} / L ${Math.round((STACK_MAX + 1) / 2)}`,
  );
  await expect(page.getByText('Soft tissue', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '3D' })).toHaveCount(0);
  await expect(
    page.getByText('Slice spacing assumed to be 1 mm – measurements are not accurate.'),
  ).toBeVisible();
  for (const orientation of ['axial', 'coronal', 'sagittal']) {
    const view = page.getByTestId(`mpr-${orientation}`);
    await expect(view.locator('canvas').first()).toBeVisible();
    await expect.poll(() => litPixels(page, view), { timeout: 30_000 }).toBeGreaterThan(500);
  }
  await page.screenshot({ path: path.join(SCREENSHOTS, 'image-stack-mpr.png') });

  expect(problems).toEqual([]);
});
