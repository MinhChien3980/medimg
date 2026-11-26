import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import { admin, tokens } from '@/test/fixtures';
import { API, server } from '@/test/server';
import { adminUsersApi, auditApi, dashboardApi, fileNameFromDisposition } from './endpoints';
import { toAppError } from './problem';

describe('slice 4a API client', () => {
  it('leaves empty filters out of the query string', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    let url = '';
    server.use(
      mock.get(`${API}/admin/users`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          content: [],
          page: 0,
          size: 20,
          totalElements: 0,
          totalPages: 0,
        });
      }),
    );
    await adminUsersApi.list({ q: '', role: undefined, status: 'LOCKED', page: 0, size: 20 });
    const params = new URL(url).searchParams;
    expect(params.has('q')).toBe(false);
    expect(params.has('role')).toBe(false);
    expect(params.get('status')).toBe('LOCKED');
    expect(params.get('page')).toBe('0');
  });

  it('asks the dashboard for an explicit period', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    let url = '';
    server.use(
      mock.get(`${API}/dashboard`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({});
      }),
    );
    await dashboardApi.get('2026-11-20', '2026-11-26');
    expect(new URL(url).search).toBe('?from=2026-11-20&to=2026-11-26');
  });

  it('downloads the CSV with the access token and the server file name', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    let auth: string | null = null;
    let url = '';
    server.use(
      mock.get(`${API}/admin/audit/export.csv`, ({ request }) => {
        auth = request.headers.get('Authorization');
        url = request.url;
        return new HttpResponse('﻿id,action\n1,LOGIN\n', {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="audit-2026-11-20_2026-11-26.csv"',
          },
        });
      }),
    );
    const { blob, fileName } = await auditApi.exportCsv({
      from: '2026-11-20',
      to: '2026-11-26',
      action: 'LOGIN',
      username: '',
    });
    expect(auth).toBe('Bearer acc');
    expect(new URL(url).searchParams.get('action')).toBe('LOGIN');
    expect(new URL(url).searchParams.has('username')).toBe(false);
    expect(fileName).toBe('audit-2026-11-20_2026-11-26.csv');
    expect(blob).toBeInstanceOf(Blob);
  });

  it('reads the ProblemDetail of a failed blob request', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    server.use(
      mock.get(`${API}/admin/audit/export.csv`, () =>
        HttpResponse.json(
          { title: 'Bad Request', status: 400, detail: 'The period is longer than 93 days' },
          { status: 400 },
        ),
      ),
    );
    const error = await auditApi
      .exportCsv({ from: '2026-01-01', to: '2026-11-26' })
      .catch((e: unknown) => e);
    expect(toAppError(error).detail).toBe('The period is longer than 93 days');
  });

  it('marks the session when a blob request answers 403 password-change-required', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    server.use(
      mock.get(`${API}/admin/audit/export.csv`, () =>
        HttpResponse.json(
          { type: '/problems/password-change-required', status: 403, detail: 'Change it' },
          { status: 403 },
        ),
      ),
    );
    await auditApi.exportCsv({ from: '2026-11-20', to: '2026-11-26' }).catch(() => undefined);
    expect(useAuthStore.getState().user?.passwordChangeRequired).toBe(true);
  });
});

describe('fileNameFromDisposition', () => {
  it('reads plain, quoted and RFC 5987 file names', () => {
    expect(fileNameFromDisposition('attachment; filename="audit.csv"')).toBe('audit.csv');
    expect(fileNameFromDisposition('attachment; filename=audit.csv')).toBe('audit.csv');
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''nh%E1%BA%ADt-k%C3%BD.csv")).toBe(
      'nhật-ký.csv',
    );
  });

  it('returns null without a usable header', () => {
    expect(fileNameFromDisposition(undefined)).toBeNull();
    expect(fileNameFromDisposition('inline')).toBeNull();
  });
});
