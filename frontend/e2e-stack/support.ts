/** Steps shared by the end-to-end tests on the real stack: sign-in, cases and uploads. */
import { gzipSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? 'Demo@12345';

/** Fails the test on any page error or console error, as a user would see a broken page. */
export function watchForErrors(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(m.text());
  });
  return problems;
}

export async function signIn(page: Page, username: string, password = DEMO_PASSWORD) {
  await page.addInitScript(() => localStorage.setItem('medimg.lang', 'en'));
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in and waits for the dashboard, where every role lands. */
export async function signInToDashboard(page: Page, username: string, password = DEMO_PASSWORD) {
  await signIn(page, username, password);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 30_000 });
}

export async function signOut(page: Page) {
  await page.evaluate(() => localStorage.removeItem('medimg.auth'));
  await page.goto('/login');
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
}

/** A unique code, so that the tests can run again on the same database. */
export function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`.toUpperCase();
}

/** Creates a case from the case list and returns its id (from the case page address). */
export async function createCase(page: Page, code: string, note: string): Promise<string> {
  await page.goto('/cases');
  await page.getByRole('button', { name: 'New case' }).click();
  const dialog = page.getByRole('dialog', { name: 'New case' });
  await dialog.getByLabel('Case code').fill(code);
  await dialog.getByLabel('Note').fill(note);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/cases\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  return page.url().split('/').at(-1) ?? '';
}

/** Uploads one file to the case through the wizard and waits until the server has processed it. */
export async function upload(
  page: Page,
  caseId: string,
  file: { name: string; mimeType: string; buffer: Buffer },
  ready: string,
) {
  await page.goto(`/upload?caseId=${caseId}`);
  // Step 1 shows the case chosen from the address; step 2 takes the file.
  await expect(page.getByText(/^Selected case: /)).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByTestId('picked-file')).toContainText(file.name);
  // The accessible name includes the icon's ("cloud-upload Upload").
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText(ready, { exact: true })).toBeVisible({ timeout: 240_000 });
}

/**
 * A small synthetic CT (int16 HU, 110 × 90 × 70 voxels of 3 mm): air around an elliptic body
 * with two lungs, a liver and a spine column, as a canonical NIfTI. The same phantom the AI
 * worker's real-model test segments; no patient data.
 */
export function syntheticTorsoNifti(): Buffer {
  const [nx, ny, nz] = [110, 90, 70];
  const spacing = 3;
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  header.write('r', 38, 'latin1');
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((d, n) => header.writeInt16LE(d, 40 + n * 2));
  header.writeInt16LE(4, 70); // int16
  header.writeInt16LE(16, 72);
  [1, spacing, spacing, spacing, 0, 0, 0, 0].forEach((p, n) => header.writeFloatLE(p, 76 + n * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeUInt8(2, 123); // mm
  header.writeInt16LE(1, 254); // sform: scanner anatomical
  const origin = [nx, ny, nz].map((n) => (-n * spacing) / 2);
  [0, 1, 2].forEach((r) => {
    const row = [0, 0, 0, origin[r] ?? 0];
    row[r] = spacing;
    row.forEach((v, c) => header.writeFloatLE(v, 280 + r * 16 + c * 4));
  });
  header.write('n+1\0', 344, 'latin1');

  const data = Buffer.alloc(nx * ny * nz * 2);
  const [cx, cy] = [nx / 2, ny / 2];
  const inEllipse = (x: number, y: number, ox: number, oy: number, rx: number, ry: number) =>
    ((x - ox) / rx) ** 2 + ((y - oy) / ry) ** 2 < 1;
  let n = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        let hu = -1000;
        if (inEllipse(x, y, cx, cy, 48, 36)) {
          hu = 40;
          const upper = z > 35;
          if (
            upper &&
            (inEllipse(x, y, cx - 22, cy + 3, 15, 22) || inEllipse(x, y, cx + 22, cy + 3, 15, 22))
          )
            hu = -850;
          if (!upper && inEllipse(x, y, cx - 15, cy + 5, 20, 18)) hu = 60;
        }
        if (inEllipse(x, y, cx, cy - 25, 5, 5)) hu = 700;
        data.writeInt16LE(hu, n * 2);
        n += 1;
      }
    }
  }
  return gzipSync(Buffer.concat([header, data]));
}
