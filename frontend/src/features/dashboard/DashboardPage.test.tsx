import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import i18n from '@/i18n';
import { lastDays } from '@/shared/lib/dateRange';
import { dashboard, emptyDashboard, JOB_ID, researcher, study, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import DashboardPage from './DashboardPage';

/** Answers `GET /dashboard` with `body` (or the default fixture) and records the periods asked. */
function dashboardEndpoint(
  body: (from: string, to: string) => DashboardDto | Response = () => dashboard(),
) {
  const asked: Array<{ from: string | null; to: string | null }> = [];
  server.use(
    mock.get(`${API}/dashboard`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const period = { from: params.get('from'), to: params.get('to') };
      asked.push(period);
      const result = body(period.from ?? '', period.to ?? '');
      return result instanceof Response ? result : HttpResponse.json(result);
    }),
  );
  return asked;
}

function renderDashboard(route = '/dashboard') {
  useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
  return renderWithProviders(<DashboardPage />, { route, path: '/dashboard' });
}

/** The value shown on the stat card titled `title`. */
function card(title: string): HTMLElement {
  const heading = screen.getByText(title, { selector: '.ant-statistic-title' });
  const statistic = heading.closest<HTMLElement>('.ant-card');
  if (!statistic) throw new Error(`no card ${title}`);
  return statistic;
}

describe('DashboardPage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('loads the last 30 days by default and shows the totals', async () => {
    const asked = dashboardEndpoint();
    renderDashboard();

    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(await screen.findByText('New cases')).toBeInTheDocument();
    expect(asked[0]).toEqual(lastDays(30));
    expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked();

    expect(within(card('New cases')).getByText('12')).toBeInTheDocument();
    expect(within(card('Studies')).getByText('15')).toBeInTheDocument();
    expect(within(card('AI jobs')).getByText('1,234')).toBeInTheDocument();
    expect(within(card('AI jobs')).getByText('4 failed')).toBeInTheDocument();
    expect(within(card('Signed reports')).getByText('7')).toBeInTheDocument();
    expect(within(card('Signed reports')).getByText('2 drafts')).toBeInTheDocument();
    expect(within(card('AI findings accepted')).getByText('75%')).toBeInTheDocument();
    expect(within(card('AI findings accepted')).getByText('of 40 reviewed')).toBeInTheDocument();
  });

  it('formats numbers for the Vietnamese locale', async () => {
    await i18n.changeLanguage('vi');
    dashboardEndpoint();
    renderDashboard();

    expect(
      await screen.findByText('Lượt chạy AI', { selector: '.ant-statistic-title' }),
    ).toBeInTheDocument();
    expect(within(card('Lượt chạy AI')).getByText('1.234')).toBeInTheDocument();
  });

  it('switches to a preset period and keeps it in the address', async () => {
    const user = userEvent.setup();
    const asked = dashboardEndpoint();
    const { router } = renderDashboard();
    await screen.findByText('New cases');

    await user.click(screen.getByText('7 days'));
    await waitFor(() => expect(asked.at(-1)).toEqual(lastDays(7)));
    expect(router.state.location.search).toBe('?days=7');

    await user.click(screen.getByText('90 days'));
    await waitFor(() => expect(asked.at(-1)).toEqual(lastDays(90)));
  });

  it('keeps the previous numbers on screen while a new period loads', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      mock.get(`${API}/dashboard`, async ({ request }) => {
        const from = new URL(request.url).searchParams.get('from');
        if (from === lastDays(7).from) {
          await gate;
          return HttpResponse.json(dashboard({ totals: { ...dashboard().totals, cases: 99 } }));
        }
        return HttpResponse.json(dashboard());
      }),
    );
    renderDashboard();
    await screen.findByText('New cases');

    await user.click(screen.getByText('7 days'));
    // Still the 30-day figure while the 7-day one is pending.
    expect(within(card('New cases')).getByText('12')).toBeInTheDocument();
    release();
    expect(await within(card('New cases')).findByText('99')).toBeInTheDocument();
  });

  it('reads a custom period from the address', async () => {
    const asked = dashboardEndpoint();
    renderDashboard('/dashboard?from=2026-01-01&to=2026-03-31');

    await screen.findByText('New cases');
    expect(asked[0]).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked();
    expect(screen.getByText('01/01/2026 – 31/03/2026')).toBeInTheDocument();
  });

  it('falls back to 30 days, and says so, for a period it cannot show', async () => {
    const asked = dashboardEndpoint();
    renderDashboard('/dashboard?from=2024-01-01&to=2026-01-01');

    expect(
      await screen.findByText(
        'The period in the address is not valid; the last 30 days are shown.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(asked[0]).toEqual(lastDays(30)));
  });

  it('offers no future day in the custom period picker', async () => {
    const user = userEvent.setup();
    dashboardEndpoint();
    renderDashboard('/dashboard?days=7');
    await screen.findByText('New cases');

    await user.click(screen.getByText('Custom'));
    const [picker] = screen.getAllByRole('textbox', { name: 'Custom period' });
    await user.click(picker as HTMLElement);
    const today = lastDays(1).to;
    const cell = await waitFor(() => {
      const td = document.querySelector<HTMLElement>(`td[title="${today}"]`);
      if (!td) throw new Error('calendar not open');
      return td;
    });
    expect(cell.className).not.toContain('ant-picker-cell-disabled');
    const tomorrow = document.querySelector<HTMLElement>(
      `td[title="${new Date(Date.parse(`${today}T12:00:00`) + 86_400_000).toISOString().slice(0, 10)}"]`,
    );
    // Tomorrow may sit in the next month's panel; when shown, it is disabled.
    if (tomorrow) expect(tomorrow.className).toContain('ant-picker-cell-disabled');
  });

  it('draws the daily chart and the label chart lazily, with tables for screen readers', async () => {
    dashboardEndpoint();
    renderDashboard();

    expect(await screen.findByTestId('daily-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('label-chart')).toBeInTheDocument();
    const daily = screen.getByRole('table', { name: 'Activity per day (table)' });
    const rows = within(daily).getAllByRole('row');
    // Header + one row per day, empty days included.
    expect(rows).toHaveLength(4);
    expect(
      within(rows[3] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['3', '8', '1']);
    const labels = screen.getByRole('table', { name: 'Accepted AI findings by label (table)' });
    expect(within(labels).getByRole('rowheader', { name: 'Cardiomegaly' })).toBeInTheDocument();
    expect(within(labels).getByText('14')).toBeInTheDocument();
  });

  it('shows processing times per model, the review split and the breakdowns', async () => {
    dashboardEndpoint();
    renderDashboard();

    const processing = (await screen.findByText('Processing time per model')).closest(
      '.ant-card',
    ) as HTMLElement;
    const cxr = within(processing).getByText('cxr-multilabel', { selector: 'code' }).closest('tr');
    expect(cxr).not.toBeNull();
    expect(
      within(cxr as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['cxr-multilabel', '1,100', '2.2 s', '1.8 s', '5.4 s']);
    const ct = within(processing)
      .getByText('ct-totalseg', { selector: 'code' })
      .closest('tr') as HTMLElement;
    expect(within(ct).getByText('1 min 35 s')).toBeInTheDocument();

    const review = screen.getByText('Review of AI findings').closest('.ant-card') as HTMLElement;
    expect(within(review).getByText('25')).toBeInTheDocument();
    expect(within(review).getByText('(62.5%)')).toBeInTheDocument();
    expect(within(review).getByText('Rejected')).toBeInTheDocument();

    const studies = screen.getByText('Studies by input type').closest('.ant-card') as HTMLElement;
    expect(within(studies).getByText('2D image')).toBeInTheDocument();
    expect(within(studies).getByText('NIfTI')).toBeInTheDocument();
  });

  it('links each recent job to the viewer on that run', async () => {
    dashboardEndpoint();
    renderDashboard();

    const link = await screen.findByRole('link', { name: 'Open in viewer' });
    expect(link).toHaveAttribute('href', `/studies/${study.id}?job=${JOB_ID}`);
  });

  it('says when nothing happened in the period, without empty charts', async () => {
    dashboardEndpoint(() => emptyDashboard);
    renderDashboard();

    expect(await screen.findByText('No activity in this period')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-chart')).not.toBeInTheDocument();
    expect(within(card('AI findings accepted')).getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Nothing reviewed yet')).toBeInTheDocument();
    expect(screen.getByText('No AI job yet')).toBeInTheDocument();
  });

  it('says when no AI finding was accepted, still drawing the daily chart', async () => {
    dashboardEndpoint(() => dashboard({ labels: [] }));
    renderDashboard();

    expect(
      await screen.findByText('No AI finding was accepted in this period'),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('daily-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('label-chart')).not.toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      mock.get(`${API}/dashboard`, () =>
        fail
          ? HttpResponse.json(
              { status: 500, title: 'Internal error', detail: 'Database down' },
              { status: 500 },
            )
          : HttpResponse.json(dashboard()),
      ),
    );
    renderDashboard();

    expect(await screen.findByText('Database down')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('New cases')).toBeInTheDocument();
    expect(screen.queryByText('Database down')).not.toBeInTheDocument();
  });

  it('shows the server reason when it refuses the period (400)', async () => {
    dashboardEndpoint(() =>
      HttpResponse.json(
        { status: 400, title: 'Bad Request', detail: 'from must not be after to' },
        { status: 400 },
      ),
    );
    renderDashboard();
    expect(await screen.findByText('from must not be after to')).toBeInTheDocument();
  });
});
