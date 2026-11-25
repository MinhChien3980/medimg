import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateReportRequest,
  FinalizeReportRequest,
  KeyImageOrderItem,
  RefillReportRequest,
  ReportDto,
  UpdateReportRequest,
  UserDto,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import {
  aiFinding,
  doctor,
  finalReport,
  patient,
  report,
  researcher,
  study,
  technician,
  tokens,
} from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import ReportPage from './ReportPage';

interface Calls {
  created: CreateReportRequest[];
  updated: UpdateReportRequest[];
  finalized: FinalizeReportRequest[];
  refilled: RefillReportRequest[];
  amended: string[];
  details: number;
  previews: Array<string | null>;
}

/** What the server writes into Technique and Findings on a refill. */
const REFILLED = {
  technique: 'Chest radiograph, modality CR; image 300 × 300 px.',
  findingsText: '- Cardiomegaly (AI, confidence 87%)\n- Effusion (AI, confidence 31%)',
};

/** In-memory report API: `reports` is the study's list, newest first. */
function serve(initial: ReportDto[], { conflictOnSave = false, conflictOnRefill = false } = {}) {
  let reports = initial;
  const calls: Calls = {
    created: [],
    updated: [],
    finalized: [],
    refilled: [],
    amended: [],
    details: 0,
    previews: [],
  };
  const put = (r: ReportDto) => {
    reports = reports.some((x) => x.id === r.id)
      ? reports.map((x) => (x.id === r.id ? r : x))
      : [r, ...reports];
    return r;
  };
  const find = (id: unknown) => reports.find((r) => r.id === id) ?? report();
  server.use(
    mock.get(`${API}/studies/${study.id}`, () => HttpResponse.json(study)),
    mock.get(`${API}/patients/${patient.id}`, () => HttpResponse.json(patient)),
    // The list carries summaries only: the page must read the selected version in full.
    mock.get(`${API}/studies/${study.id}/reports`, () =>
      HttpResponse.json(
        reports.map(({ id, version, status, signedBy, signedAt, updatedAt }) => ({
          id,
          version,
          status,
          signedBy,
          signedAt,
          updatedAt,
        })),
      ),
    ),
    mock.get(`${API}/reports/:id`, ({ params }) => {
      calls.details += 1;
      return HttpResponse.json(find(params.id));
    }),
    mock.post(`${API}/studies/${study.id}/reports`, async ({ request }) => {
      const body = (await request.json()) as CreateReportRequest;
      calls.created.push(body);
      return HttpResponse.json(put(report({ language: body.language })), { status: 201 });
    }),
    mock.put(`${API}/reports/:id`, async ({ params, request }) => {
      const body = (await request.json()) as UpdateReportRequest;
      calls.updated.push(body);
      const current = find(params.id);
      if (conflictOnSave || body.rowVersion !== current.rowVersion) {
        return HttpResponse.json({ status: 409, detail: 'Stale row version' }, { status: 409 });
      }
      const { rowVersion, keyImages: items, ...sections } = body;
      const keyImages = items
        ? items.map((item: KeyImageOrderItem, position) => {
            const image = current.keyImages.find((k) => k.id === item.id);
            if (!image) throw new Error(`unknown key image ${item.id}`);
            return { ...image, position, caption: item.caption ?? image.caption };
          })
        : current.keyImages;
      return HttpResponse.json(
        put({ ...current, ...sections, keyImages, rowVersion: rowVersion + 1 }),
      );
    }),
    mock.post(`${API}/reports/:id/finalize`, async ({ params, request }) => {
      const body = (await request.json()) as FinalizeReportRequest;
      calls.finalized.push(body);
      const current = find(params.id);
      return HttpResponse.json(
        put({
          ...current,
          status: 'FINAL',
          signedBy: { id: doctor.id, fullName: doctor.fullName },
          signedAt: '2026-11-25T11:00:00Z',
          rowVersion: current.rowVersion + 1,
        }),
      );
    }),
    mock.post(`${API}/reports/:id/refill`, async ({ params, request }) => {
      const body = (await request.json()) as RefillReportRequest;
      calls.refilled.push(body);
      const current = find(params.id);
      if (conflictOnRefill || body.rowVersion !== current.rowVersion) {
        return HttpResponse.json({ status: 409, detail: 'Stale row version' }, { status: 409 });
      }
      return HttpResponse.json(
        put({
          ...current,
          ...REFILLED,
          updatedAt: '2026-11-25T12:00:00Z',
          rowVersion: current.rowVersion + 1,
        }),
      );
    }),
    mock.post(`${API}/reports/:id/amend`, ({ params }) => {
      calls.amended.push(String(params.id));
      const current = find(params.id);
      return HttpResponse.json(
        put({
          ...current,
          id: 'rep-2',
          version: current.version + 1,
          status: 'DRAFT',
          signedBy: null,
          signedAt: null,
          amendsReportId: current.id,
          rowVersion: 0,
        }),
        { status: 201 },
      );
    }),
    mock.get(`${API}/reports/:id/preview.pdf`, ({ request }) => {
      calls.previews.push(request.headers.get('Authorization'));
      return new HttpResponse(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), {
        headers: { 'Content-Type': 'application/pdf' },
      });
    }),
    mock.get(`${API}/reports/:id/pdf`, () =>
      HttpResponse.json({ url: '/medimg/reports/rep-1/report.pdf?sig=1', expiresAt: 'x' }),
    ),
  );
  return calls;
}

function open(user: UserDto = doctor) {
  useAuthStore.getState().setSession(tokens('acc', 'ref', user));
  return renderWithProviders(<ReportPage />, {
    route: `/studies/${study.id}/report`,
    path: '/studies/:studyId/report',
  });
}

const SAVE_WAIT = { timeout: 4000 };

describe('ReportPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('as a doctor', () => {
    beforeEach(() => {
      useAuthStore.getState().setSession(tokens('acc', 'ref', doctor));
    });

    it('creates a draft from the template matching the study, in the chosen language', async () => {
      const user = userEvent.setup();
      const calls = serve([]);
      open();

      expect(await screen.findByText('New report')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Template' })).toBeInTheDocument();
      expect(screen.getByText('Chest X-ray')).toBeInTheDocument();
      await user.click(screen.getByText('Vietnamese'));
      await user.click(screen.getByRole('button', { name: /Create report/ }));

      await waitFor(() => expect(calls.created).toEqual([{ template: 'CXR', language: 'vi' }]));
      expect(await screen.findByText('Draft, version 1')).toBeInTheDocument();
      expect(screen.getByLabelText('Findings')).toHaveValue('- Cardiomegaly (AI, 87%), accepted.');
      expect(screen.getByRole('link', { name: 'Case CASE-000001' })).toHaveAttribute(
        'href',
        `/cases/${patient.id}`,
      );
    });

    it('saves edits after a pause, with the row version of the last save', async () => {
      const user = userEvent.setup();
      const calls = serve([report()]);
      open();

      const impression = await screen.findByLabelText('Impression');
      expect(screen.getByTestId('save-state')).toHaveTextContent('All changes saved');
      await user.type(impression, 'Cardiomegaly.');
      expect(screen.getByTestId('save-state')).toHaveTextContent('Unsaved changes…');
      await waitFor(() => expect(calls.updated).toHaveLength(1), SAVE_WAIT);
      expect(calls.updated[0]).toEqual({
        clinicalInfo: 'Cough for two weeks.',
        technique: 'Chest X-ray, PA view.',
        findingsText: '- Cardiomegaly (AI, 87%), accepted.',
        impression: 'Cardiomegaly.',
        rowVersion: 0,
      });
      await waitFor(() =>
        expect(screen.getByTestId('save-state')).toHaveTextContent('All changes saved'),
      );

      await user.type(screen.getByLabelText('Technique'), ' Erect.');
      await waitFor(() => expect(calls.updated).toHaveLength(2), SAVE_WAIT);
      expect(calls.updated[1]?.rowVersion).toBe(1);
      expect(calls.updated[1]?.technique).toBe('Chest X-ray, PA view. Erect.');
    });

    it('stops saving on a conflict and reloads the server version on request', async () => {
      const user = userEvent.setup();
      const calls = serve([report()], { conflictOnSave: true });
      open();

      await user.type(await screen.findByLabelText('Impression'), 'Mine');
      expect(
        await screen.findByText('This draft was changed elsewhere', undefined, SAVE_WAIT),
      ).toBeInTheDocument();
      expect(screen.getByTestId('save-state')).toHaveTextContent('Not saved: changed elsewhere');
      expect(screen.getByRole('button', { name: /Sign and finalize/ })).toBeDisabled();

      // No more saves while in conflict.
      await user.type(screen.getByLabelText('Impression'), ' more');
      await new Promise((r) => setTimeout(r, 1300));
      expect(calls.updated).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: /Reload the draft/ }));
      await waitFor(() => expect(screen.getByLabelText('Impression')).toHaveValue(''));
      expect(screen.getByTestId('save-state')).toHaveTextContent('All changes saved');
      expect(screen.queryByText('This draft was changed elsewhere')).not.toBeInTheDocument();
    });

    it('signs after saving and confirming, then shows the signed report read-only', async () => {
      const user = userEvent.setup();
      const calls = serve([report()]);
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      open();

      const sign = await screen.findByRole('button', { name: /Sign and finalize/ });
      expect(sign).toBeDisabled(); // no impression yet
      await user.type(screen.getByLabelText('Impression'), 'Cardiomegaly.');
      await user.click(sign);

      const dialog = await screen.findByRole('dialog', { name: 'Sign and finalize this report?' });
      expect(calls.updated).toHaveLength(1); // saved before asking
      await user.click(within(dialog).getByRole('button', { name: 'Sign' }));
      await waitFor(() => expect(calls.finalized).toEqual([{ rowVersion: 1 }]));

      expect(await screen.findByText('Signed report, version 1')).toBeInTheDocument();
      expect(screen.queryByLabelText('Impression')).not.toBeInTheDocument();
      expect(screen.getByText('Cardiomegaly.')).toBeInTheDocument();
      expect(screen.getAllByTestId('report-status')[0]).toHaveTextContent('Signed v1');

      await user.click(screen.getByRole('button', { name: /Download PDF/ }));
      await waitFor(() => expect(click).toHaveBeenCalled());
      const anchor = click.mock.contexts[0] as HTMLAnchorElement;
      expect(anchor.getAttribute('href')).toBe('/medimg/reports/rep-1/report.pdf?sig=1');
      expect(anchor.download).toBe(`report-${study.id.slice(0, 8)}-v1.pdf`);
    });

    it('refills Technique and Findings after saving and confirming, keeping the other sections', async () => {
      const user = userEvent.setup();
      const calls = serve([report()]);
      open();

      await user.type(await screen.findByLabelText('Impression'), 'Cardiomegaly.');
      await user.click(screen.getByRole('button', { name: /Refill from reviewed findings/ }));

      const dialog = await screen.findByRole('dialog', {
        name: 'Replace Technique and Findings?',
      });
      expect(calls.updated).toHaveLength(1); // saved before asking
      expect(dialog).toHaveTextContent(
        'The Findings and Technique sections will be replaced with text written from the accepted and edited findings and the annotations as they are now',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Refill' }));

      await waitFor(() => expect(calls.refilled).toEqual([{ rowVersion: 1 }]));
      await waitFor(() =>
        expect(screen.getByLabelText('Findings')).toHaveValue(REFILLED.findingsText),
      );
      expect(screen.getByLabelText('Technique')).toHaveValue(REFILLED.technique);
      expect(screen.getByLabelText('Impression')).toHaveValue('Cardiomegaly.');
      expect(screen.getByLabelText('Clinical information')).toHaveValue('Cough for two weeks.');
      expect(await screen.findByText('Technique and Findings refilled')).toBeInTheDocument();
      expect(screen.getByTestId('save-state')).toHaveTextContent('All changes saved');

      // Later edits are saved on the row version returned by the refill.
      await user.type(screen.getByLabelText('Impression'), ' Small.');
      await waitFor(() => expect(calls.updated).toHaveLength(2), SAVE_WAIT);
      expect(calls.updated[1]).toMatchObject({ ...REFILLED, rowVersion: 2 });
    });

    it('leaves the draft as it is when the refill is cancelled', async () => {
      const user = userEvent.setup();
      const calls = serve([report()]);
      open();

      await user.click(
        await screen.findByRole('button', { name: /Refill from reviewed findings/ }),
      );
      const dialog = await screen.findByRole('dialog', {
        name: 'Replace Technique and Findings?',
      });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await new Promise((r) => setTimeout(r, 300));
      expect(calls.refilled).toEqual([]);
      expect(screen.getByLabelText('Findings')).toHaveValue('- Cardiomegaly (AI, 87%), accepted.');
    });

    it('reloads the draft when it was changed elsewhere before the refill', async () => {
      const user = userEvent.setup();
      const calls = serve([report()], { conflictOnRefill: true });
      open();

      await user.click(
        await screen.findByRole('button', { name: /Refill from reviewed findings/ }),
      );
      const dialog = await screen.findByRole('dialog', {
        name: 'Replace Technique and Findings?',
      });
      const readsBefore = calls.details;
      await user.click(within(dialog).getByRole('button', { name: 'Refill' }));

      expect(
        await screen.findByText(
          'This draft was changed elsewhere, so it was reloaded. Refill it again if needed.',
        ),
      ).toBeInTheDocument();
      await waitFor(() => expect(calls.details).toBeGreaterThan(readsBefore));
      expect(screen.getByLabelText('Findings')).toHaveValue('- Cardiomegaly (AI, 87%), accepted.');
      expect(screen.getByTestId('save-state')).toHaveTextContent('All changes saved');
    });

    it('hints at a refill when findings were reviewed after the draft was last saved', async () => {
      const user = userEvent.setup();
      serve([report({ updatedAt: '2026-11-25T09:30:00Z' })]);
      server.use(
        mock.get(`${API}/studies/${study.id}/findings`, () =>
          HttpResponse.json([
            aiFinding({
              id: 'f2',
              label: 'Effusion',
              reviewStatus: 'ACCEPTED',
              review: {
                status: 'ACCEPTED',
                label: null,
                note: null,
                reviewedBy: { id: doctor.id, fullName: doctor.fullName },
                reviewedAt: '2026-11-25T10:00:00Z',
              },
            }),
          ]),
        ),
      );
      open();

      expect(
        await screen.findByText('Findings were reviewed after this draft was last saved'),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Refill from reviewed findings/ }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Replace Technique and Findings?',
      });
      await user.click(within(dialog).getByRole('button', { name: 'Refill' }));

      await waitFor(() =>
        expect(
          screen.queryByText('Findings were reviewed after this draft was last saved'),
        ).not.toBeInTheDocument(),
      );
    });

    it('creates an amendment of a signed report', async () => {
      const user = userEvent.setup();
      const calls = serve([finalReport()]);
      open();

      await user.click(await screen.findByRole('button', { name: /Create amendment/ }));
      await waitFor(() => expect(calls.amended).toEqual(['rep-1']));
      expect(await screen.findByText('Draft, version 2')).toBeInTheDocument();
      expect(screen.getByText('Amendment to the signed report v1.')).toBeInTheDocument();
      expect(screen.getByLabelText('Impression')).toHaveValue('Cardiomegaly.');

      const versions = screen.getByRole('list', { name: 'Versions' });
      expect(
        within(versions)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([expect.stringContaining('Draft v2'), expect.stringContaining('Signed v1')]);
      // The signed version stays readable.
      await user.click(within(versions).getByRole('button', { name: /Signed v1/ }));
      expect(await screen.findByText('Signed report, version 1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Create amendment/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Refill/ })).not.toBeInTheDocument();
    });

    it('opens the draft PDF preview, fetched with the access token, in a new tab', async () => {
      const user = userEvent.setup();
      const calls = serve([report()]);
      const openTab = vi.spyOn(window, 'open').mockReturnValue({} as Window);
      open();

      await user.click(await screen.findByRole('button', { name: /Preview PDF/ }));
      await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
      expect(openTab.mock.calls[0]?.[0]).toMatch(/^blob:/);
      expect(calls.previews).toEqual(['Bearer acc']);
    });

    it('reorders key images and saves captions', async () => {
      const user = userEvent.setup();
      const calls = serve([
        report({
          keyImages: [
            { id: 'k1', caption: 'PA view', position: 0, uploaded: true, url: '/medimg/k1.png' },
            { id: 'k2', caption: 'Heatmap', position: 1, uploaded: true, url: '/medimg/k2.png' },
          ],
        }),
      ]);
      open();

      expect(await screen.findByText('2 / 6')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Move key image 1 up' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Move key image 1 down' }));
      await waitFor(() => expect(calls.updated).toHaveLength(1));
      expect(calls.updated[0]?.keyImages).toEqual([
        { id: 'k2', caption: null },
        { id: 'k1', caption: null },
      ]);
      expect(calls.updated[0]?.rowVersion).toBe(0);
      await waitFor(() =>
        expect(screen.getByLabelText('Caption of key image 1')).toHaveValue('Heatmap'),
      );

      const caption = screen.getByLabelText('Caption of key image 2');
      await user.clear(caption);
      await user.type(caption, 'PA view, cardiomegaly{Enter}');
      await waitFor(() => expect(calls.updated).toHaveLength(2));
      expect(calls.updated[1]).toMatchObject({
        keyImages: [
          { id: 'k2', caption: null },
          { id: 'k1', caption: 'PA view, cardiomegaly' },
        ],
        rowVersion: 1,
      });
    });
  });

  it('shows a researcher only signed versions, read-only', async () => {
    serve([report({ id: 'rep-2', version: 2 }), finalReport()]);
    open(researcher);

    expect(await screen.findByText('Signed report, version 1')).toBeInTheDocument();
    const versions = screen.getByRole('list', { name: 'Versions' });
    expect(within(versions).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/Draft/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create amendment/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeInTheDocument();
  });

  it('tells a researcher when nothing is signed yet, without offering to write one', async () => {
    serve([report()]);
    open(researcher);
    expect(await screen.findByText('This study has no signed report yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create report/ })).not.toBeInTheDocument();
  });

  it('shows a technician the draft read-only, with its preview', async () => {
    serve([report()]);
    open(technician);
    expect(await screen.findByText('Draft: not signed yet, may still change.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Impression')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign and finalize/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refill/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview PDF/ })).toBeInTheDocument();
  });
});
