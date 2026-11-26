import { expect, test } from '@playwright/test';
import {
  createCase,
  signInToDashboard,
  syntheticTorsoNifti,
  uniqueCode,
  upload,
  watchForErrors,
} from './support';

test('a technician uploads a CT, views it in MPR and runs the organ segmentation', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const problems = watchForErrors(page);
  await signInToDashboard(page, 'tech');

  const caseId = await createCase(page, uniqueCode('E2E-CT'), 'end-to-end CT');
  // The ingest worker unpacks the NIfTI, normalises orientation and HU, and makes a thumbnail.
  await upload(
    page,
    caseId,
    { name: 'torso.nii.gz', mimeType: 'application/gzip', buffer: syntheticTorsoNifti() },
    'CT volume is ready',
  );

  // TotalSegmentator (--fast, CPU) in the AI worker; the viewer shows MPR meanwhile.
  await page.getByRole('button', { name: 'Run AI' }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]{36}\?job=/);
  await expect(page.getByText('Loading CT volume…')).toBeHidden({ timeout: 60_000 });
  for (const view of ['axial', 'coronal', 'sagittal']) {
    await expect(page.getByTestId(`mpr-${view}`)).toBeVisible();
  }
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 480_000 });

  // A phantom has no real anatomy: the model may find a few structures or none, but it must finish
  // and the viewer must show its result either way.
  await expect(page.getByText(/^Structures: \d+$|^No structures found$/).first()).toBeVisible();
  if (await page.getByText(/^Structures: [1-9]\d*$/).count()) {
    await page.getByRole('tab', { name: '3D' }).click();
    await expect(page.getByTestId('mesh-canvas')).toBeVisible({ timeout: 30_000 });
  }
  expect(problems).toEqual([]);
});
