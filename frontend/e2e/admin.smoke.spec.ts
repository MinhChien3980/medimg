/**
 * Real-browser smoke test of slice 4a on the production build under the production
 * Content-Security-Policy: an admin creates a user, the new user signs in with the temporary
 * password, is held on the password page until it is changed and then lands on the dashboard
 * (charts drawn by the lazy Recharts chunk); the admin locks that user, who can no longer sign in.
 * The REST API is an in-memory fake answering through `page.route` (passwords, sessions, lock
 * state), so the requests the UI sends are checked too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SCREENSHOTS = path.resolve(import.meta.dirname, '../test-results/screenshots');
const PROBLEM_TYPE = 'https://medimg.example/problems/password-change-required';

function productionCsp(): string {
  const conf = readFileSync(path.resolve(import.meta.dirname, '../nginx.conf'), 'utf8');
  const match = /add_header Content-Security-Policy "([^"]+)"/.exec(conf);
  if (!match?.[1]) throw new Error('CSP not found in nginx.conf');
  return match[1];
}

type Json = Record<string, unknown>;

interface StoredUser {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  roles: string[];
  status: 'ACTIVE' | 'LOCKED';
  passwordChangeRequired: boolean;
  password: string;
  version: number;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Backend {
  users: StoredUser[];
  passwordChanges: Json[];
  logins: Array<{ username: string; status: number }>;
}

function dto(u: StoredUser): Json {
  const { password: _password, ...rest } = u;
  return rest;
}

function sessionUser(u: StoredUser): Json {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    roles: u.roles,
    passwordChangeRequired: u.passwordChangeRequired,
  };
}

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dashboard(): Json {
  const daily = Array.from({ length: 30 }, (_, i) => ({
    date: day(i - 29),
    cases: (i * 7) % 5,
    jobs: (i * 11) % 9,
    failedJobs: i % 10 === 0 ? 1 : 0,
  }));
  return {
    from: day(-29),
    to: day(0),
    zone: 'Asia/Ho_Chi_Minh',
    totals: {
      cases: 42,
      studies: 51,
      studiesByInputType: { IMAGE_2D: 30, DICOM_2D: 6, NIFTI: 15 },
      jobs: 1234,
      jobsByStatus: { DONE: 1180, FAILED: 3, RUNNING: 1, QUEUED: 50 },
      reports: { draft: 4, final: 17 },
    },
    processing: {
      perModel: [
        {
          modelCode: 'cxr-multilabel',
          jobs: 1100,
          avgMs: 2150,
          p50Ms: 1800,
          p95Ms: 5400,
          avgInferenceMs: 640,
        },
        {
          modelCode: 'ct-totalseg',
          jobs: 134,
          avgMs: 95_000,
          p50Ms: 90_000,
          p95Ms: 130_000,
          avgInferenceMs: 71_000,
        },
      ],
    },
    review: { reviewed: 40, accepted: 25, edited: 5, rejected: 10, acceptanceRate: 0.75 },
    labels: [
      { label: 'Cardiomegaly', accepted: 14 },
      { label: 'Effusion', accepted: 9 },
      // Raw model label codes, as core-service sends them.
      { label: 'kidney_left', accepted: 6 },
    ],
    daily,
    recentJobs: [
      {
        jobId: '61616161-6161-4616-8616-616161616161',
        studyId: '62626262-6262-4626-8626-626262626262',
        modelCode: 'cxr-multilabel',
        status: 'DONE',
        queuedAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 57_000).toISOString(),
      },
    ],
  };
}

async function mockBackend(page: Page): Promise<Backend> {
  const csp = productionCsp();
  const now = () => new Date().toISOString();
  const b: Backend = {
    users: [
      {
        id: 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0',
        username: 'admin',
        fullName: 'Demo Admin',
        email: null,
        roles: ['ADMIN'],
        status: 'ACTIVE',
        passwordChangeRequired: false,
        password: 'Demo@12345',
        version: 0,
        lastLoginAt: null,
        createdAt: '2026-11-01T08:00:00Z',
      },
      {
        id: 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0',
        username: 'doctor',
        fullName: 'Dr. Demo',
        email: null,
        roles: ['DOCTOR'],
        status: 'ACTIVE',
        passwordChangeRequired: false,
        password: 'Demo@12345',
        version: 0,
        lastLoginAt: null,
        createdAt: '2026-11-01T08:00:00Z',
      },
    ],
    passwordChanges: [],
    logins: [],
  };
  // access / refresh token → user id
  const sessions = new Map<string, string>();
  let seq = 0;
  const issue = (u: StoredUser) => {
    seq += 1;
    const access = `access-${seq}`;
    const refresh = `refresh-${seq}`;
    sessions.set(access, u.id);
    sessions.set(refresh, u.id);
    return { accessToken: access, refreshToken: refresh, expiresIn: 900, user: sessionUser(u) };
  };
  const json = (status: number, body: unknown) => ({ status, json: body });
  const problem = (status: number, detail: string, type?: string) =>
    json(status, { type, title: 'Error', status, detail });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
      if (request.resourceType() === 'document' && !process.env.E2E_BASE_URL) {
        const response = await route.fetch();
        return route.fulfill({
          response,
          headers: { ...response.headers(), 'content-security-policy': csp },
        });
      }
      return route.fallback();
    }
    const method = request.method();
    const body = (request.postDataJSON() ?? {}) as Json;
    const reply = (r: { status: number; json?: unknown }) =>
      r.status === 204 ? route.fulfill({ status: 204, body: '' }) : route.fulfill(r);

    // ---- /auth/* ----
    if (method === 'POST' && p === '/api/v1/auth/login') {
      const u = b.users.find((x) => x.username === body.username);
      // A locked account gets the same answer as a wrong password.
      const ok = u && u.password === body.password && u.status === 'ACTIVE';
      b.logins.push({ username: String(body.username), status: ok ? 200 : 401 });
      if (!u || !ok) return reply(problem(401, 'Invalid username or password'));
      u.lastLoginAt = now();
      return reply(json(200, issue(u)));
    }
    if (method === 'POST' && p === '/api/v1/auth/refresh') {
      const u = b.users.find((x) => x.id === sessions.get(String(body.refreshToken)));
      if (!u || u.status !== 'ACTIVE') return reply(problem(401, 'Refresh token revoked'));
      sessions.delete(String(body.refreshToken));
      return reply(json(200, issue(u)));
    }
    if (method === 'POST' && p === '/api/v1/auth/logout') return reply({ status: 204 });

    const token = (request.headers().authorization ?? '').replace(/^Bearer /, '');
    const me = b.users.find((x) => x.id === sessions.get(token));
    if (!me) return reply(problem(401, 'Unauthorized'));

    if (method === 'GET' && p === '/api/v1/me') return reply(json(200, sessionUser(me)));
    if (method === 'POST' && p === '/api/v1/me/password') {
      b.passwordChanges.push({ username: me.username, ...body });
      if (body.currentPassword !== me.password) {
        return reply(problem(422, 'The current password is wrong'));
      }
      me.password = String(body.newPassword);
      me.passwordChangeRequired = false;
      return reply({ status: 204 });
    }
    if (me.passwordChangeRequired) {
      return reply(problem(403, 'Change your temporary password first', PROBLEM_TYPE));
    }

    if (method === 'GET' && p === '/api/v1/dashboard') return reply(json(200, dashboard()));

    if (p.startsWith('/api/v1/admin/') && !me.roles.includes('ADMIN')) {
      return reply(problem(403, 'Forbidden'));
    }
    if (method === 'GET' && p === '/api/v1/admin/users') {
      const role = url.searchParams.get('role');
      const status = url.searchParams.get('status');
      const content = b.users
        .filter((u) => !role || u.roles.includes(role))
        .filter((u) => !status || u.status === status)
        .map(dto);
      return reply(
        json(200, {
          content,
          page: 0,
          size: Number(url.searchParams.get('size') ?? 20),
          totalElements: content.length,
          totalPages: 1,
        }),
      );
    }
    if (method === 'POST' && p === '/api/v1/admin/users') {
      const created: StoredUser = {
        id: `c0c0c0c0-c0c0-4c0c-8c0c-${String(b.users.length).padStart(12, '0')}`,
        username: String(body.username),
        fullName: String(body.fullName),
        email: (body.email as string | undefined) ?? null,
        roles: body.roles as string[],
        status: 'ACTIVE',
        passwordChangeRequired: true,
        password: 'Tmp-e2e-7Qx9Lm2p',
        version: 0,
        lastLoginAt: null,
        createdAt: now(),
      };
      b.users.push(created);
      return reply(json(201, { user: dto(created), temporaryPassword: created.password }));
    }
    const lock = /^\/api\/v1\/admin\/users\/([^/]+)\/(lock|unlock)$/.exec(p);
    if (method === 'POST' && lock) {
      const u = b.users.find((x) => x.id === lock[1]);
      if (!u) return reply(problem(404, 'Not found'));
      if (u.id === me.id) return reply(problem(409, 'You cannot lock your own account'));
      u.status = lock[2] === 'lock' ? 'LOCKED' : 'ACTIVE';
      u.version += 1;
      if (u.status === 'LOCKED') {
        // Locking revokes the refresh tokens of that user.
        for (const [t, id] of sessions)
          if (id === u.id && t.startsWith('refresh-')) sessions.delete(t);
      }
      return reply(json(200, dto(u)));
    }
    return reply(problem(404, `No fake for ${method} ${p}`));
  });

  await page.addInitScript(() => localStorage.setItem('medimg.lang', 'en'));
  return b;
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Problems that fail the test: page errors, console errors and CSP violations. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('Warning: [antd:')) return;
    // The refused sign-in of the locked user is expected (401).
    if (/Failed to load resource: the server responded with a status of 401/.test(text)) return;
    if (msg.type() === 'error' || /Content Security Policy|Refused to/i.test(text)) {
      problems.push(`console.${msg.type()}: ${text}`);
    }
  });
  return problems;
}

test('admin creates a user who must change the temporary password, then locks them', async ({
  page,
}) => {
  const problems = watchProblems(page);
  const backend = await mockBackend(page);

  // ---- the admin lands on the dashboard; Recharts draws under the production CSP ----
  await signIn(page, 'admin', 'Demo@12345');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(
    page.locator('.ant-card').filter({ hasText: 'AI jobs' }).getByText('1,234'),
  ).toBeVisible();
  await expect(page.getByTestId('daily-chart').locator('.recharts-line')).toHaveCount(3);
  await expect(page.getByTestId('label-chart').locator('.recharts-bar-rectangle')).toHaveCount(3);
  await expect(page.getByTestId('label-chart').getByText('Left kidney')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOTS, 'dashboard.png'), fullPage: true });

  // ---- create a user: the temporary password is shown once ----
  await page.getByRole('menuitem', { name: /Users/ }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.getByRole('button', { name: 'New user' }).click();
  const form = page.getByRole('dialog', { name: 'New user' });
  await form.getByLabel('Username').fill('Nurse.Lan');
  await expect(form.getByLabel('Username')).toHaveValue('nurse.lan');
  await form.getByLabel('Full name').fill('Lan Nguyen');
  await form.getByRole('checkbox', { name: 'Technician' }).check();
  await form.getByRole('button', { name: 'Create user' }).click();

  const temp = page.getByRole('dialog', { name: 'Temporary password' });
  await expect(temp.getByText(/shown only this once/)).toBeVisible();
  const temporaryPassword = await temp.getByLabel('Temporary password').inputValue();
  expect(temporaryPassword).toBe('Tmp-e2e-7Qx9Lm2p');
  await page.screenshot({ path: path.join(SCREENSHOTS, 'admin-temporary-password.png') });
  await temp.getByRole('button', { name: 'I have noted it' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(temporaryPassword)).toHaveCount(0);
  const newRow = page.getByRole('row', { name: /nurse\.lan/ });
  await expect(newRow.getByText('Must change password')).toBeVisible();
  // The signed-in admin cannot lock their own account.
  await expect(
    page.getByRole('row', { name: /^admin/ }).getByRole('button', { name: 'Lock' }),
  ).toBeDisabled();
  await page.screenshot({ path: path.join(SCREENSHOTS, 'admin-users.png') });
  await signOut(page);

  // ---- the new user is held on the password page until the password is changed ----
  await signIn(page, 'nurse.lan', temporaryPassword);
  await expect(page).toHaveURL(/\/account\/password$/);
  await expect(page.getByRole('heading', { name: /Choose a new password/ })).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  // Opening any page again (a reload) still leads back here.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/account\/password$/);
  await page.getByLabel('Current password').fill(temporaryPassword);
  await page.getByLabel('New password', { exact: true }).fill('nurse.lan2026');
  await expect(page.getByText('Must not contain your username')).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('Sunrise-2026');
  await page.getByLabel('Repeat the new password').fill('Sunrise-2026');
  await expect(page.getByText('Must not contain your username')).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'forced-password-change.png') });
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  expect(backend.passwordChanges).toEqual([
    { username: 'nurse.lan', currentPassword: temporaryPassword, newPassword: 'Sunrise-2026' },
  ]);
  // A technician has no Administration section.
  await expect(page.getByText('Administration')).toHaveCount(0);
  await signOut(page);

  // ---- the admin locks the user, who can no longer sign in ----
  await signIn(page, 'admin', 'Demo@12345');
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('menuitem', { name: /Users/ }).click();
  await page
    .getByRole('row', { name: /nurse\.lan/ })
    .getByRole('button', { name: 'Lock' })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Lock nurse.lan?' });
  await confirm.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByText('nurse.lan is locked')).toBeVisible();
  await expect(page.getByRole('row', { name: /nurse\.lan/ }).getByText('Locked')).toBeVisible();
  await signOut(page);

  await signIn(page, 'nurse.lan', 'Sunrise-2026');
  await expect(page.getByText('Sign-in failed')).toBeVisible();
  await expect(page.getByText('Invalid username or password')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'locked-user-sign-in.png') });
  expect(backend.logins.at(-1)).toEqual({ username: 'nurse.lan', status: 401 });

  expect(problems).toEqual([]);
});
