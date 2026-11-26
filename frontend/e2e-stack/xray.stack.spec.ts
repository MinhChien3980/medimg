import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { syntheticChestXray } from '../e2e/fixtures/png';
import { createCase, signInToDashboard, uniqueCode, upload, watchForErrors } from './support';

test('a doctor takes a chest X-ray from upload to a signed PDF report', async ({ page }) => {
  const problems = watchForErrors(page);
  await signInToDashboard(page, 'doctor');

  const code = uniqueCode('E2E-CXR');
  const caseId = await createCase(page, code, 'end-to-end chest X-ray');
  await upload(
    page,
    caseId,
    { name: 'chest.png', mimeType: 'image/png', buffer: syntheticChestXray(512) },
    'Image is ready',
  );

  // The real model (TorchXRayVision) runs in the AI worker; the viewer follows the job live.
  await page.getByRole('button', { name: 'Run AI' }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]{36}\?job=/);
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
  const accept = page.getByRole('button', { name: /^Accept / }).first();
  await expect(accept).toBeEnabled();
  const label = (await accept.getAttribute('aria-label'))?.replace(/^Accept /, '') ?? '';
  expect(label).not.toBe('');
  await accept.click();
  await expect(page.getByText('Accepted', { exact: true }).first()).toBeVisible();

  // The draft is filled from the accepted finding; signing makes the PDF.
  await page.getByRole('button', { name: 'Open report' }).click();
  await expect(page).toHaveURL(/\/report$/);
  await page.getByRole('button', { name: 'Create report' }).click();
  await expect(page.getByText('Draft, version 1')).toBeVisible();
  await expect(page.getByLabel('Findings')).toHaveValue(new RegExp(label));
  await page.getByLabel('Impression').fill('End-to-end test impression.');
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 15_000 });
  await page.getByRole('button', { name: /Sign and finalize/ }).click();
  await page
    .getByRole('dialog', { name: 'Sign and finalize this report?' })
    .getByRole('button', { name: 'Sign' })
    .click();
  await expect(page.getByText('Signed report, version 1')).toBeVisible({ timeout: 60_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Download PDF/ }).click(),
  ]);
  const pdf = readFileSync(await download.path());
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(5_000);

  // The case page lists the study and its AI run.
  await page.goto(`/cases/${caseId}`);
  await expect(page.getByText(code).first()).toBeVisible();
  await expect(page.getByText('cxr-multilabel').first()).toBeVisible();
  expect(problems).toEqual([]);
});
