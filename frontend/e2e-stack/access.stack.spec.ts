import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, signInToDashboard, watchForErrors } from './support';

test('a researcher reads cases but cannot change them or open administration', async ({ page }) => {
  const problems = watchForErrors(page);
  const adminCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/admin/')) adminCalls.push(r.url());
  });

  await signInToDashboard(page, 'researcher');
  await page.goto('/cases');
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New case' })).toHaveCount(0);
  await expect(page.getByText('Administration')).toHaveCount(0);

  await page.goto('/admin/audit');
  await expect(page.getByText(/administrators only/)).toBeVisible();
  expect(adminCalls).toEqual([]);

  // The API refuses as well, whatever the page shows.
  const login = await page.request.post('/api/v1/auth/login', {
    data: { username: 'researcher', password: DEMO_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const auth = { Authorization: `Bearer ${accessToken}` };
  expect((await page.request.get('/api/v1/admin/audit', { headers: auth })).status()).toBe(403);
  const create = await page.request.post('/api/v1/patients', {
    headers: auth,
    data: { note: 'should be refused' },
  });
  expect(create.status()).toBe(403);
  expect(problems).toEqual([]);
});
