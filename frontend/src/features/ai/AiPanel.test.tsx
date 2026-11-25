import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  streamPrediction,
  StreamUnavailableError,
  type PredictionStreamHandlers,
} from '@/api/predictionStream';
import type { CreatePredictionRequest, PredictionDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { renderWithProviders } from '@/test/render';
import {
  ctStudy,
  donePrediction,
  SEG_JOB_ID,
  segModel,
  segPrediction,
  JOB_ID,
  model,
  prediction,
  researcher,
  study,
  tokens,
} from '@/test/fixtures';
import { API, server } from '@/test/server';
import { AiPanel } from './AiPanel';
import { PREDICTION_POLL_MS } from './usePredictionLive';

vi.mock('@/api/predictionStream', () => ({
  streamPrediction: vi.fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
}));

const streamMock = vi.mocked(streamPrediction);
const SERIES_ID = study.series[0]?.id ?? '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function CtHarness({ initialJobId = null }: { initialJobId?: string | null }) {
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  return (
    <AiPanel
      studyId={ctStudy.id}
      inputType="NIFTI"
      seriesId={ctStudy.series[0]?.id ?? null}
      jobId={jobId}
      onSelectJob={setJobId}
    />
  );
}

function Harness({ initialJobId = null }: { initialJobId?: string | null }) {
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [visible, setVisible] = useState<string[]>([]);
  return (
    <>
      <div data-testid="visible-heatmaps">{visible.join(',')}</div>
      <AiPanel
        studyId={study.id}
        inputType="IMAGE_2D"
        seriesId={SERIES_ID}
        jobId={jobId}
        onSelectJob={setJobId}
        visibleHeatmaps={visible}
        onToggleHeatmap={(label) =>
          setVisible((v) => (v.includes(label) ? v.filter((l) => l !== label) : [...v, label]))
        }
      />
    </>
  );
}

function rowLabels(): string[] {
  const table = screen.getByTestId('run-details').querySelector('tbody');
  if (!table) return [];
  return Array.from(table.querySelectorAll('tr')).map(
    (tr) => tr.querySelector('td')?.textContent?.trim() ?? '',
  );
}

describe('AiPanel', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    streamMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a model, follows SSE progress and renders sorted findings with heatmap toggles', async () => {
    const user = userEvent.setup();
    let handlers: PredictionStreamHandlers | null = null;
    streamMock.mockImplementation((_jobId, h) => {
      handlers = h;
      return new Promise<void>(() => undefined); // stays open until the test emits events
    });

    let created: { body: CreatePredictionRequest; key: string | null } | null = null;
    server.use(
      mock.get(`${API}/models`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('inputType')).toBe('IMAGE_2D');
        return HttpResponse.json([model]);
      }),
      mock.get(`${API}/studies/${study.id}/predictions`, () =>
        HttpResponse.json<PredictionDto[]>([]),
      ),
      mock.post(`${API}/predictions`, async ({ request }) => {
        created = {
          body: (await request.json()) as CreatePredictionRequest,
          key: request.headers.get('Idempotency-Key'),
        };
        return HttpResponse.json(
          { jobId: JOB_ID, status: 'QUEUED', queuePosition: 2 },
          { status: 202 },
        );
      }),
      mock.get(`${API}/predictions/${JOB_ID}`, () => HttpResponse.json(prediction())),
    );

    renderWithProviders(<Harness />);

    const run = await screen.findByRole('button', { name: /Run AI/ });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);

    // Queued, live over SSE.
    expect(await screen.findByText('Queue position: 2')).toBeInTheDocument();
    expect(screen.getByTestId('transport')).toHaveTextContent('Live (SSE)');
    expect(created).not.toBeNull();
    const sent = created as { body: CreatePredictionRequest; key: string | null } | null;
    expect(sent?.body).toEqual({
      studyId: study.id,
      seriesId: SERIES_ID,
      modelCode: model.code,
      params: { threshold: 0.5 },
    });
    expect(sent?.key).toMatch(UUID_RE);
    expect(streamMock).toHaveBeenCalledWith(JOB_ID, expect.any(Object), expect.any(Object));

    // progress event
    act(() => handlers?.onProgress({ jobId: JOB_ID, status: 'RUNNING', progress: 40 }));
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'AI analysis progress' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );

    // done event
    act(() => handlers?.onDone(donePrediction));
    expect(await screen.findByText('Findings')).toBeInTheDocument();
    expect(rowLabels()).toEqual(['Cardiomegaly', 'Effusion', 'Atelectasis']);
    expect(screen.getByText('Vertical line = 50% threshold')).toBeInTheDocument();
    expect(screen.getAllByTestId('threshold-line')[0]).toHaveStyle({ left: '50%' });
    expect(screen.getByText('87.0%')).toBeInTheDocument();
    expect(screen.queryByTestId('transport')).not.toBeInTheDocument();

    // Only labels with a heatmap are toggles.
    const toggle = screen.getByRole('button', { name: /Cardiomegaly/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /Effusion/ })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByTestId('visible-heatmaps')).toHaveTextContent('Cardiomegaly');
    expect(screen.getByRole('button', { name: /Cardiomegaly/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('falls back to polling GET /predictions/{id} when SSE is unavailable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    streamMock.mockRejectedValue(new StreamUnavailableError());

    let polls = 0;
    server.use(
      mock.get(`${API}/models`, () => HttpResponse.json([model])),
      mock.get(`${API}/studies/${study.id}/predictions`, () =>
        HttpResponse.json([prediction({ status: 'RUNNING', progress: 10 })]),
      ),
      mock.get(`${API}/predictions/${JOB_ID}`, () => {
        polls += 1;
        if (polls === 1) return HttpResponse.json(prediction({ status: 'RUNNING', progress: 10 }));
        if (polls === 2) return HttpResponse.json(prediction({ status: 'RUNNING', progress: 70 }));
        return HttpResponse.json(donePrediction);
      }),
    );

    renderWithProviders(<Harness initialJobId={JOB_ID} />);

    expect(await screen.findByTestId('transport')).toHaveTextContent('Fallback: polling every 2 s');
    expect(polls).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(PREDICTION_POLL_MS));
    await waitFor(() => expect(polls).toBe(2));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70');

    await act(() => vi.advanceTimersByTimeAsync(PREDICTION_POLL_MS));
    expect(await screen.findByText('Findings')).toBeInTheDocument();
    expect(rowLabels()[0]).toBe('Cardiomegaly');

    // Polling stops once the job is terminal.
    const settled = polls;
    await act(() => vi.advanceTimersByTimeAsync(PREDICTION_POLL_MS * 3));
    expect(polls).toBe(settled);
  });

  it('draws the threshold the run was started with and explains missing heatmaps', async () => {
    const user = userEvent.setup();
    streamMock.mockResolvedValue(undefined);
    server.use(
      mock.get(`${API}/models`, () => HttpResponse.json([model])),
      mock.get(`${API}/studies/${study.id}/predictions`, () => HttpResponse.json([])),
      mock.get(`${API}/predictions/${JOB_ID}`, () =>
        HttpResponse.json({ ...donePrediction, params: { threshold: 0.3 } }),
      ),
    );

    renderWithProviders(<Harness initialJobId={JOB_ID} />);

    expect(await screen.findByText('Vertical line = 30% threshold')).toBeInTheDocument();
    expect(screen.getAllByTestId('threshold-line')[0]).toHaveStyle({ left: '30%' });

    await user.hover(screen.getByText('Effusion'));
    expect(
      await screen.findByText('No heatmap (only generated for findings at or above the threshold)'),
    ).toBeInTheDocument();
  });

  it('falls back to the default threshold when the run has no params', async () => {
    streamMock.mockResolvedValue(undefined);
    server.use(
      mock.get(`${API}/models`, () => HttpResponse.json([model])),
      mock.get(`${API}/studies/${study.id}/predictions`, () => HttpResponse.json([])),
      mock.get(`${API}/predictions/${JOB_ID}`, () =>
        HttpResponse.json({ ...donePrediction, params: {} }),
      ),
    );

    renderWithProviders(<Harness initialJobId={JOB_ID} />);

    expect(await screen.findByText('Vertical line = 50% threshold')).toBeInTheDocument();
  });

  it('is read-only for a researcher: live progress but no run, cancel or retry', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    streamMock.mockImplementation(() => new Promise<void>(() => undefined));
    let modelCalls = 0;
    server.use(
      mock.get(`${API}/models`, () => {
        modelCalls += 1;
        return HttpResponse.json([model]);
      }),
      mock.get(`${API}/studies/${study.id}/predictions`, () =>
        HttpResponse.json([prediction({ status: 'RUNNING', progress: 30 })]),
      ),
      mock.get(`${API}/predictions/${JOB_ID}`, () =>
        HttpResponse.json(prediction({ status: 'RUNNING', progress: 30 })),
      ),
    );

    renderWithProviders(<Harness initialJobId={JOB_ID} />);

    const details = await screen.findByTestId('run-details');
    expect(await within(details).findByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    expect(within(details).getByTestId('transport')).toHaveTextContent('Live (SSE)');
    expect(screen.queryByRole('button', { name: /Run AI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel job/ })).not.toBeInTheDocument();
    expect(modelCalls).toBe(0);
  });

  it('shows the failure reason of a failed run', async () => {
    streamMock.mockResolvedValue(undefined);
    server.use(
      mock.get(`${API}/models`, () => HttpResponse.json([model])),
      mock.get(`${API}/studies/${study.id}/predictions`, () => HttpResponse.json([])),
      mock.get(`${API}/predictions/${JOB_ID}`, () =>
        HttpResponse.json(prediction({ status: 'FAILED', error: 'Worker crashed' })),
      ),
    );

    renderWithProviders(<Harness initialJobId={JOB_ID} />);

    const details = await screen.findByTestId('run-details');
    expect(await within(details).findByText('Worker crashed')).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: /Retry job/ })).toBeInTheDocument();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('hides retry of a failed run from a researcher', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    streamMock.mockResolvedValue(undefined);
    server.use(
      mock.get(`${API}/studies/${study.id}/predictions`, () => HttpResponse.json([])),
      mock.get(`${API}/predictions/${JOB_ID}`, () =>
        HttpResponse.json(prediction({ status: 'FAILED', error: 'Worker crashed' })),
      ),
    );

    renderWithProviders(<Harness initialJobId={JOB_ID} />);

    const details = await screen.findByTestId('run-details');
    expect(await within(details).findByText('Worker crashed')).toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: /Retry job/ })).not.toBeInTheDocument();
  });

  describe('CT volume study', () => {
    it('offers the models for the study input type and runs segmentation without a threshold', async () => {
      const user = userEvent.setup();
      streamMock.mockImplementation(() => new Promise<void>(() => undefined));
      let inputType: string | null = null;
      let created: CreatePredictionRequest | null = null;
      server.use(
        mock.get(`${API}/models`, ({ request }) => {
          inputType = new URL(request.url).searchParams.get('inputType');
          return HttpResponse.json([segModel]);
        }),
        mock.get(`${API}/studies/${ctStudy.id}/predictions`, () => HttpResponse.json([])),
        mock.post(`${API}/predictions`, async ({ request }) => {
          created = (await request.json()) as CreatePredictionRequest;
          return HttpResponse.json(
            { jobId: SEG_JOB_ID, status: 'QUEUED', queuePosition: 1 },
            { status: 202 },
          );
        }),
        mock.get(`${API}/predictions/${SEG_JOB_ID}`, () =>
          HttpResponse.json({ ...segPrediction, status: 'QUEUED', progress: 0, findings: [] }),
        ),
      );

      renderWithProviders(<CtHarness />);

      const run = await screen.findByRole('button', { name: /Run segmentation/ });
      await waitFor(() => expect(run).toBeEnabled());
      expect(inputType).toBe('NIFTI');
      expect(screen.queryByLabelText('Threshold')).not.toBeInTheDocument();
      await user.click(run);

      await waitFor(() =>
        expect(created).toEqual({
          studyId: ctStudy.id,
          seriesId: ctStudy.series[0]?.id,
          modelCode: 'ct-totalseg',
          params: {},
        }),
      );
      expect(await screen.findByTestId('transport')).toHaveTextContent('Live (SSE)');
    });

    it('lists segmented structures with their volume instead of probability bars', async () => {
      streamMock.mockResolvedValue(undefined);
      server.use(
        mock.get(`${API}/models`, () => HttpResponse.json([segModel])),
        mock.get(`${API}/studies/${ctStudy.id}/predictions`, () =>
          HttpResponse.json([segPrediction]),
        ),
        mock.get(`${API}/predictions/${SEG_JOB_ID}`, () => HttpResponse.json(segPrediction)),
      );

      renderWithProviders(<CtHarness initialJobId={SEG_JOB_ID} />);

      const details = await screen.findByTestId('run-details');
      expect(await within(details).findByText('Structures: 3')).toBeInTheDocument();
      expect(rowLabels()).toEqual(['Liver', 'Spleen', 'Left kidney']);
      expect(within(details).getByText('1,520 ml')).toBeInTheDocument();
      expect(within(details).queryByRole('meter')).not.toBeInTheDocument();
      expect(within(details).queryByTestId('threshold-line')).not.toBeInTheDocument();
      // History summary.
      expect(
        await screen.findByText(/ct-totalseg@2\.18\.0-fast · Structures: 3/),
      ).toBeInTheDocument();
    });

    it('does not let a researcher run segmentation', async () => {
      useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
      streamMock.mockResolvedValue(undefined);
      server.use(
        mock.get(`${API}/studies/${ctStudy.id}/predictions`, () =>
          HttpResponse.json([segPrediction]),
        ),
        mock.get(`${API}/predictions/${SEG_JOB_ID}`, () => HttpResponse.json(segPrediction)),
      );

      renderWithProviders(<CtHarness initialJobId={SEG_JOB_ID} />);

      expect(await screen.findByText('Structures: 3')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Run segmentation/ })).not.toBeInTheDocument();
    });
  });
});
