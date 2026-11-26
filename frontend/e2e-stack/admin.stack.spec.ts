import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signIn, signInToDashboard, signOut, watchForErrors } from './support';

const NEW_PASSWORD = 'Sunrise-2026-e2e';

test('an admin creates a user, the user changes the temporary password, the admin locks them', async ({
  page,
}) => {
  const problems = watchForErrors(page);
  const username = `e2e${Date.now().toString(36)}`;

  await signInToDashboard(page, 'admin');
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'New user' }).click();
  const form = page.getByRole('dialog', { name: 'New user' });
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Full name').fill('End To End');
  await form.getByRole('checkbox', { name: 'Technician' }).check();
  await form.getByRole('button', { name: 'Create user' }).click();
  const shown = page.getByRole('dialog', { name: 'Temporary password' });
  const temporary = await shown.getByLabel('Temporary password').inputValue();
  expect(temporary.length).toBeGreaterThanOrEqual(12);
  await shown.getByRole('button', { name: 'I have noted it' }).click();
  await expect(page.getByText(temporary)).toHaveCount(0);
  await signOut(page);

  // Every route leads to the password page until the temporary password is replaced.
  await signIn(page, username, temporary);
  await expect(page.getByRole('heading', { name: /Choose a new password/ })).toBeVisible();
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/account\/password/);
  await page.getByLabel('Current password').fill(temporary);
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Repeat the new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/cases/);
  await expect(page.getByText('Administration')).toHaveCount(0);
  await signOut(page);

  await signInToDashboard(page, 'admin');
  await page.goto('/admin/users');
  const row = page.getByRole('row', { name: new RegExp(username) });
  await row.getByRole('button', { name: 'Lock' }).click();
  await page
    .getByRole('dialog', { name: `Lock ${username}?` })
    .getByRole('button', { name: 'Lock' })
    .click();
  await expect(row.getByText('Locked')).toBeVisible();
  await signOut(page);

  await signIn(page, username, NEW_PASSWORD);
  await expect(page.getByText('Sign-in failed')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  expect(problems).toEqual([]);
});

test('an admin disables and enables a model, and finds both in the exported audit log', async ({
  page,
}) => {
  const problems = watchForErrors(page);
  await signInToDashboard(page, 'admin');

  await page.goto('/admin/models');
  const row = page.getByRole('row', { name: /cxr-multilabel/ });
  await row.getByRole('button', { name: 'Disable' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Disable/ })
    .last()
    .click();
  await expect(row.getByRole('button', { name: 'Enable' })).toBeVisible();
  await row.getByRole('button', { name: 'Enable' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Enable/ })
    .last()
    .click();
  await expect(row.getByRole('button', { name: 'Disable' })).toBeVisible();

  await page.goto('/admin/audit');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Export CSV/ }).click(),
  ]);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM, so that Excel reads UTF-8
  expect(csv).toContain('MODEL_DISABLED');
  expect(csv).toContain('MODEL_ENABLED');
  expect(problems).toEqual([]);
});
