import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateReportRequest, InitKeyImageRequest, ReportDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { doctor, finalReport, report, researcher, study, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import { AddToReportButton } from './AddToReport';
import { StudyReportStatus } from './StudyReportStatus';

const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
const capture = () => Promise.resolve(PNG);

function serve(reports: ReportDto[]) {
  const calls = {
    created: [] as CreateReportRequest[],
    inits: [] as Array<{ reportId: string; body: InitKeyImageRequest }>,
    puts: [] as Array<{ type: string | null; auth: string | null; size: number }>,
    completed: [] as string[],
  };
  server.use(
    mock.get(`${API}/studies/${study.id}/reports`, () => HttpResponse.json(reports)),
    mock.post(`${API}/studies/${study.id}/reports`, async ({ request }) => {
      calls.created.push((await request.json()) as CreateReportRequest);
      return HttpResponse.json(report(), { status: 201 });
    }),
    mock.post(`${API}/reports/:id/key-images/init`, async ({ params, request }) => {
      calls.inits.push({
        reportId: String(params.id),
        body: (await request.json()) as InitKeyImageRequest,
      });
      return HttpResponse.json({
        imageId: 'k9',
        putUrl: '/medimg/reports/rep-1/key-images/k9.png?X-Amz-Signature=abc',
        expiresAt: '2026-11-25T12:00:00Z',
      });
    }),
    mock.put('*/medimg/reports/rep-1/key-images/k9.png', async ({ request }) => {
      calls.puts.push({
        type: request.headers.get('Content-Type'),
        auth: request.headers.get('Authorization'),
        size: (await request.arrayBuffer()).byteLength,
      });
      return new HttpResponse(null, { status: 200 });
    }),
    mock.get(`${API}/reports/:id`, ({ params }) =>
      HttpResponse.json(reports.find((r) => r.id === params.id) ?? report()),
    ),
    mock.post(`${API}/reports/:id/key-images/:imageId/complete`, ({ params }) => {
      calls.completed.push(String(params.imageId));
      return HttpResponse.json(
        report({
          keyImages: [
            { id: 'k9', caption: 'CR CHEST', position: 0, uploaded: true, url: '/k9.png' },
          ],
        }),
      );
    }),
  );
  return calls;
}

function renderButton() {
  return renderWithProviders(
    <AddToReportButton studyId={study.id} capture={capture} defaultCaption="CR CHEST" />,
  );
}

describe('AddToReportButton', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', doctor));
  });

  it('creates the draft when the study has none, then uploads the capture as a key image', async () => {
    const user = userEvent.setup();
    const calls = serve([]);
    renderButton();

    await user.click(screen.getByRole('button', { name: /Add to report/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a key image to the report' });
    expect(within(dialog).getByRole('img', { name: 'Captured view' })).toBeInTheDocument();
    const caption = within(dialog).getByLabelText('Caption');
    expect(caption).toHaveValue('CR CHEST');
    await user.type(caption, ' – cardiomegaly');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(calls.completed).toEqual(['k9']));
    expect(calls.created).toEqual([{ language: 'en' }]);
    expect(calls.inits).toEqual([
      {
        reportId: 'rep-1',
        body: { contentType: 'image/png', size: 4, caption: 'CR CHEST – cardiomegaly' },
      },
    ]);
    // Straight to storage: PNG content type, no Authorization header.
    expect(calls.puts).toEqual([{ type: 'image/png', auth: null, size: 4 }]);
    expect(await screen.findByText('Key image added.')).toBeInTheDocument();
  });

  it('adds to the existing draft', async () => {
    const user = userEvent.setup();
    const calls = serve([report({ id: 'rep-1' }), finalReport({ id: 'rep-0', version: 0 })]);
    renderButton();
    await user.click(screen.getByRole('button', { name: /Add to report/ }));
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.completed).toEqual(['k9']));
    expect(calls.created).toEqual([]);
  });

  it('never changes a signed report', async () => {
    const user = userEvent.setup();
    const calls = serve([finalReport()]);
    renderButton();
    await user.click(screen.getByRole('button', { name: /Add to report/ }));
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText(
        'The report of this study is signed. Create an amendment on the report page to add images.',
      ),
    ).toBeInTheDocument();
    expect(calls.inits).toEqual([]);
  });

  it('refuses a seventh key image', async () => {
    const user = userEvent.setup();
    const image = { id: 'k', caption: '', position: 0, uploaded: true, url: '/k.png' };
    const calls = serve([report({ keyImages: Array.from({ length: 6 }, () => image) })]);
    renderButton();
    await user.click(screen.getByRole('button', { name: /Add to report/ }));
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    expect(await screen.findByText('The report already has 6 key images')).toBeInTheDocument();
    expect(calls.inits).toEqual([]);
  });

  it('is not offered to a researcher', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    renderButton();
    expect(screen.queryByRole('button', { name: /Add to report/ })).not.toBeInTheDocument();
  });
});

describe('StudyReportStatus (case page)', () => {
  it.each([
    [doctor, [report({ version: 2 }), finalReport()], 'Draft v2'],
    [researcher, [report({ version: 2 }), finalReport()], 'Signed v1'],
  ])('shows the latest version the user may see', async (user, reports, label) => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', user));
    serve(reports);
    renderWithProviders(<StudyReportStatus studyId={study.id} />);
    expect(await screen.findByTestId('report-status')).toHaveTextContent(label);
    expect(screen.getByRole('link', { name: /Open report/ })).toHaveAttribute(
      'href',
      `/studies/${study.id}/report`,
    );
  });

  it('offers to write the first report to a doctor only', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', doctor));
    serve([]);
    const { unmount } = renderWithProviders(<StudyReportStatus studyId={study.id} />);
    expect(await screen.findByText('No report')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Write report/ })).toBeInTheDocument();
    unmount();

    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    renderWithProviders(<StudyReportStatus studyId={study.id} />);
    expect(await screen.findByText('No report')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Write report/ })).not.toBeInTheDocument();
  });
});
