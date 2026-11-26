import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import { lastDays } from '@/shared/lib/dateRange';
import { admin, auditEntry, page, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import AuditPage from './AuditPage';

const entries = [
  auditEntry(),
  auditEntry({
    id: 2,
    occurredAt: '2026-11-26T06:00:00Z',
    username: 'doctor',
    action: 'LOGIN_FAILED',
    entityType: null,
    entityId: null,
    outcome: 'FAILURE',
    detail: { reason: 'locked' },
  }),
];

function auditBackend() {
  const lists: URLSearchParams[] = [];
  const actions: URLSearchParams[] = [];
  server.use(
    mock.get(`${API}/admin/audit`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      lists.push(params);
      return HttpResponse.json(
        page(entries, { totalElements: 120, size: Number(params.get('size')) }),
      );
    }),
    mock.get(`${API}/admin/audit/actions`, ({ request }) => {
      actions.push(new URL(request.url).searchParams);
      return HttpResponse.json(['LOGIN', 'LOGIN_FAILED', 'USER_LOCKED']);
    }),
  );
  return { lists, actions };
}

function renderAudit(route = '/admin/audit') {
  useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
  return renderWithProviders(<AuditPage />, { route, path: '/admin/audit' });
}

async function rowOf(action: string): Promise<HTMLElement> {
  const tag = await screen.findByText(action, { selector: '.ant-tag' });
  return tag.closest('tr') as HTMLElement;
}

describe('AuditPage', () => {
  it('shows the last 7 days by default, newest first as served, 50 per page', async () => {
    const { lists } = auditBackend();
    renderAudit();

    const locked = await rowOf('USER_LOCKED');
    expect(within(locked).getByText('admin')).toBeInTheDocument();
    expect(within(locked).getByText('Success')).toBeInTheDocument();
    expect(within(locked).getByText('203.0.113.7')).toBeInTheDocument();
    const failed = await rowOf('LOGIN_FAILED');
    expect(within(failed).getByText('Failure')).toBeInTheDocument();

    const first = lists[0];
    expect(first?.get('from')).toBe(lastDays(7).from);
    expect(first?.get('to')).toBe(lastDays(7).to);
    expect(first?.get('page')).toBe('0');
    expect(first?.get('size')).toBe('50');
    expect(first?.has('action')).toBe(false);
    expect(screen.getByText('120 entries')).toBeInTheDocument();
  });

  it('expands a row to show its JSON detail and user agent', async () => {
    const user = userEvent.setup();
    auditBackend();
    renderAudit();
    const row = await rowOf('USER_LOCKED');

    await user.click(within(row).getByRole('button', { name: /expand row/i }));
    const detail = await screen.findByTestId('audit-detail');
    expect(detail.textContent).toBe(
      JSON.stringify({ reason: 'left the team', roles: ['DOCTOR'] }, null, 2),
    );
    expect(screen.getByText('Mozilla/5.0 (test)')).toBeInTheDocument();
  });

  it('fills the action dropdown with the actions of the period and filters by it', async () => {
    const user = userEvent.setup();
    const { lists, actions } = auditBackend();
    const { router } = renderAudit();
    await rowOf('USER_LOCKED');
    await waitFor(() => expect(actions.length).toBeGreaterThan(0));
    expect(actions[0]?.get('from')).toBe(lastDays(7).from);

    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByTitle('LOGIN_FAILED'));
    await user.type(screen.getByLabelText('Username'), ' doctor ');
    await user.click(screen.getByRole('combobox', { name: 'Outcome' }));
    await user.click(await screen.findByTitle('Failure'));
    await user.type(screen.getByRole('combobox', { name: 'Entity type' }), 'USER');
    await user.type(screen.getByLabelText('Entity id'), '42');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(lists.at(-1)?.get('action')).toBe('LOGIN_FAILED'));
    const last = lists.at(-1);
    expect(last?.get('username')).toBe('doctor');
    expect(last?.get('outcome')).toBe('FAILURE');
    expect(last?.get('entityType')).toBe('USER');
    expect(last?.get('entityId')).toBe('42');
    expect(router.state.location.search).toContain('action=LOGIN_FAILED');
  });

  it('pages through the server and keeps the page in the address', async () => {
    const user = userEvent.setup();
    const { lists } = auditBackend();
    const { router } = renderAudit();
    await rowOf('USER_LOCKED');

    await user.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(lists.at(-1)?.get('page')).toBe('1'));
    expect(router.state.location.search).toBe('?page=2');
  });

  it('reads a custom period of up to 93 days from the address', async () => {
    const { lists } = auditBackend();
    renderAudit('/admin/audit?from=2026-08-26&to=2026-11-26');
    await rowOf('USER_LOCKED');
    expect(lists[0]?.get('from')).toBe('2026-08-26');
    expect(screen.queryByText(/is not valid/)).not.toBeInTheDocument();
  });

  it('refuses a period over 93 days from the address and shows the last 7 days', async () => {
    const { lists } = auditBackend();
    renderAudit('/admin/audit?from=2026-08-25&to=2026-11-26');

    expect(
      await screen.findByText('The period in the address is not valid; the last 7 days are shown.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(lists[0]?.get('from')).toBe(lastDays(7).from));
  });

  it('resets every filter', async () => {
    const user = userEvent.setup();
    auditBackend();
    const { router } = renderAudit('/admin/audit?action=LOGIN&outcome=FAILURE');
    await rowOf('USER_LOCKED');

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('exports the applied filters as CSV through the authenticated client', async () => {
    const user = userEvent.setup();
    auditBackend();
    let exported = null as URLSearchParams | null;
    let auth = null as string | null;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      mock.get(`${API}/admin/audit/export.csv`, async ({ request }) => {
        exported = new URL(request.url).searchParams;
        auth = request.headers.get('Authorization');
        await gate;
        return new HttpResponse('﻿id,action\n1,USER_LOCKED\n', {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="audit.csv"',
          },
        });
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAudit('/admin/audit?action=USER_LOCKED');
    await rowOf('USER_LOCKED');

    const button = screen.getByRole('button', { name: 'Export CSV' });
    await user.click(button);
    await waitFor(() => expect(exported).not.toBeNull());
    expect(button.className).toContain('ant-btn-loading');
    release();

    expect(await screen.findByText('CSV saved as audit.csv')).toBeInTheDocument();
    expect(exported?.get('action')).toBe('USER_LOCKED');
    expect(exported?.get('from')).toBe(lastDays(7).from);
    expect(auth).toBe('Bearer acc');
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('audit.csv');
    expect(anchor.href).toMatch(/^blob:/);
  });

  it('names the file after the period when the server sends no name, and reports failures', async () => {
    const user = userEvent.setup();
    auditBackend();
    let fail = false;
    server.use(
      mock.get(`${API}/admin/audit/export.csv`, () =>
        fail
          ? HttpResponse.json({ status: 422, detail: 'More than 100000 rows' }, { status: 422 })
          : new HttpResponse('id\n', { headers: { 'Content-Type': 'text/csv' } }),
      ),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAudit();
    await rowOf('USER_LOCKED');

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    const { from, to } = lastDays(7);
    expect(await screen.findByText(`CSV saved as audit-${from}-${to}.csv`)).toBeInTheDocument();
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(`audit-${from}-${to}.csv`);

    fail = true;
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Export failed: More than 100000 rows')).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('shows a load error', async () => {
    auditBackend();
    server.use(
      mock.get(`${API}/admin/audit`, () =>
        HttpResponse.json({ status: 400, detail: 'Range longer than 93 days' }, { status: 400 }),
      ),
    );
    renderAudit();
    expect(await screen.findByText('Range longer than 93 days')).toBeInTheDocument();
  });
});
