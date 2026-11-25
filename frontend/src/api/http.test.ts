import { delay, http as mock, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import { patient, tokens } from '@/test/fixtures';
import { API, server } from '@/test/server';
import { authApi, patientsApi } from './endpoints';
import { SessionExpiredError } from './http';

/** Protected endpoint that only accepts `Bearer <valid>`. */
function protectedPatient(valid: string, seen: string[] = []) {
  return mock.get(`${API}/patients/:id`, ({ request }) => {
    const auth = request.headers.get('Authorization') ?? '';
    seen.push(auth);
    if (auth !== `Bearer ${valid}`) {
      return HttpResponse.json(
        { title: 'Unauthorized', status: 401, detail: 'Token expired' },
        { status: 401 },
      );
    }
    return HttpResponse.json(patient);
  });
}

describe('http client auth', () => {
  it('attaches the access token as a Bearer header', async () => {
    useAuthStore.getState().setSession(tokens('good', 'r1'));
    const seen: string[] = [];
    server.use(protectedPatient('good', seen));

    await expect(patientsApi.get(patient.id)).resolves.toEqual(patient);
    expect(seen).toEqual(['Bearer good']);
  });

  it('refreshes once for concurrent 401s (single-flight) and replays every request', async () => {
    useAuthStore.getState().setSession(tokens('expired', 'r1'));
    let refreshCalls = 0;
    const refreshBodies: unknown[] = [];
    server.use(
      protectedPatient('fresh'),
      mock.post(`${API}/auth/refresh`, async ({ request }) => {
        refreshCalls += 1;
        refreshBodies.push(await request.json());
        await delay(50);
        return HttpResponse.json(tokens('fresh', 'r2'));
      }),
    );

    const results = await Promise.all([
      patientsApi.get(patient.id),
      patientsApi.get(patient.id),
      patientsApi.get(patient.id),
    ]);

    expect(results).toEqual([patient, patient, patient]);
    expect(refreshCalls).toBe(1);
    expect(refreshBodies).toEqual([{ refreshToken: 'r1' }]);
    expect(useAuthStore.getState().accessToken).toBe('fresh');
    expect(useAuthStore.getState().refreshToken).toBe('r2');
  });

  it('logs out when the refresh is rejected', async () => {
    useAuthStore.getState().setSession(tokens('expired', 'revoked'));
    server.use(
      protectedPatient('never'),
      mock.post(`${API}/auth/refresh`, () =>
        HttpResponse.json(
          { title: 'Unauthorized', status: 401, detail: 'Refresh token revoked' },
          { status: 401 },
        ),
      ),
    );

    const outcomes = await Promise.allSettled([
      patientsApi.get(patient.id),
      patientsApi.get(patient.id),
    ]);

    for (const o of outcomes) {
      expect(o.status).toBe('rejected');
      if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(SessionExpiredError);
    }
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.sessionExpired).toBe(true);
  });

  it('after a reload (refresh token only) renews before the first call, no 401 round-trip', async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: 'r1', user: tokens('x', 'r1').user });
    const seen: string[] = [];
    let refreshCalls = 0;
    server.use(
      protectedPatient('fresh', seen),
      mock.post(`${API}/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json(tokens('fresh', 'r2'));
      }),
    );

    await expect(patientsApi.get(patient.id)).resolves.toEqual(patient);
    expect(refreshCalls).toBe(1);
    expect(seen).toEqual(['Bearer fresh']);
  });

  it('sends login without a stale Authorization header', async () => {
    useAuthStore.setState({ accessToken: 'stale', refreshToken: null, user: null });
    let auth: string | null = 'unset';
    server.use(
      mock.post(`${API}/auth/login`, ({ request }) => {
        auth = request.headers.get('Authorization');
        return HttpResponse.json(tokens('a', 'b'));
      }),
    );

    await authApi.login({ username: 'doctor', password: 'x' });
    expect(auth).toBeNull();
  });

  it('logout needs no access token: no refresh, no Authorization header', async () => {
    useAuthStore.setState({
      accessToken: 'expired',
      refreshToken: 'r1',
      user: tokens('x', 'r1').user,
    });
    let refreshCalls = 0;
    let seen: { auth: string | null; body: unknown } | null = null;
    server.use(
      mock.post(`${API}/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json(tokens('fresh', 'r2'));
      }),
      mock.post(`${API}/auth/logout`, async ({ request }) => {
        seen = { auth: request.headers.get('Authorization'), body: await request.json() };
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await authApi.logout('r1');
    expect(seen).toEqual({ auth: null, body: { refreshToken: 'r1' } });
    expect(refreshCalls).toBe(0);
  });

  it('does not try to refresh when the login itself returns 401', async () => {
    let refreshCalls = 0;
    server.use(
      mock.post(`${API}/auth/login`, () =>
        HttpResponse.json(
          { title: 'Unauthorized', status: 401, detail: 'Bad credentials' },
          { status: 401 },
        ),
      ),
      mock.post(`${API}/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json(tokens('a', 'b'));
      }),
    );

    await expect(authApi.login({ username: 'doctor', password: 'nope' })).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshCalls).toBe(0);
  });
});
