import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse, delay } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CreateFindingRequest,
  FindingDto,
  PredictionDto,
  ReviewFindingRequest,
} from '@/api/types';
import { AiPanel } from '@/features/ai/AiPanel';
import { useAuthStore } from '@/features/auth/authStore';
import {
  aiFinding,
  donePrediction,
  doctor,
  JOB_ID,
  model,
  researcher,
  study,
  technician,
  tokens,
} from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import type { SelectedAnnotation } from './ManualFindings';

const SERIES_ID = study.series[0]?.id ?? '';

function serve(prediction: PredictionDto = donePrediction, studyFindings: FindingDto[] = []) {
  const calls = { prediction: 0 };
  server.use(
    mock.get(`${API}/models`, () => HttpResponse.json([model])),
    mock.get(`${API}/studies/${study.id}/predictions`, () => HttpResponse.json([prediction])),
    mock.get(`${API}/predictions/${JOB_ID}`, () => {
      calls.prediction += 1;
      return HttpResponse.json(prediction);
    }),
    mock.get(`${API}/studies/${study.id}/findings`, () => HttpResponse.json(studyFindings)),
  );
  return calls;
}

function renderPanel(selectedAnnotation: SelectedAnnotation | null = null) {
  return renderWithProviders(
    <AiPanel
      studyId={study.id}
      inputType="IMAGE_2D"
      seriesId={SERIES_ID}
      jobId={JOB_ID}
      onSelectJob={() => undefined}
      selectedAnnotation={selectedAnnotation}
    />,
  );
}

const status = (id: string) => screen.getByTestId(`review-status-${id}`);

describe('finding review', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', doctor));
  });

  it('accepts a finding at once, before the server answers, and keeps the answer', async () => {
    const user = userEvent.setup();
    serve();
    let sent: ReviewFindingRequest | null = null;
    server.use(
      mock.patch(`${API}/findings/f1/review`, async ({ request }) => {
        await delay(300);
        sent = (await request.json()) as ReviewFindingRequest;
        return HttpResponse.json(
          aiFinding({
            id: 'f1',
            label: 'Cardiomegaly',
            confidence: 0.87,
            reviewStatus: 'ACCEPTED',
            version: 1,
            review: {
              status: 'ACCEPTED',
              label: null,
              note: null,
              reviewedBy: { id: doctor.id, fullName: doctor.fullName },
              reviewedAt: '2026-11-25T10:00:00Z',
            },
          }),
        );
      }),
    );
    renderPanel();

    expect(await screen.findByText('0 of 3 reviewed')).toBeInTheDocument();
    expect(status('f1')).toHaveTextContent('Unreviewed');
    await user.click(screen.getByRole('button', { name: 'Accept Cardiomegaly' }));

    // Optimistic: shown as accepted while the request is still in flight.
    await waitFor(() => expect(status('f1')).toHaveTextContent('Accepted'));
    expect(sent).toBeNull();
    expect(screen.getByRole('button', { name: 'Accept Cardiomegaly' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(sent).toEqual({ status: 'ACCEPTED', version: 0 }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Accept Cardiomegaly' })).toBeEnabled(),
    );
    expect(await screen.findByText('1 of 3 reviewed')).toBeInTheDocument();
  });

  it('rolls back and reloads when someone else reviewed the finding meanwhile (409)', async () => {
    const user = userEvent.setup();
    const calls = serve();
    server.use(
      mock.patch(`${API}/findings/f1/review`, async () => {
        await delay(300);
        return HttpResponse.json(
          { status: 409, title: 'Conflict', detail: 'Version mismatch' },
          { status: 409 },
        );
      }),
    );
    renderPanel();
    await screen.findByText('0 of 3 reviewed');
    const before = calls.prediction;

    await user.click(screen.getByRole('button', { name: 'Reject Cardiomegaly' }));
    await waitFor(() => expect(status('f1')).toHaveTextContent('Rejected'));

    expect(
      await screen.findByText(
        'This finding was changed by someone else; the latest version has been reloaded.',
      ),
    ).toBeInTheDocument();
    expect(status('f1')).toHaveTextContent('Unreviewed');
    await waitFor(() => expect(calls.prediction).toBeGreaterThan(before));
  });

  it('edits the label with a note through the dialog; the label is required', async () => {
    const user = userEvent.setup();
    serve();
    let sent: ReviewFindingRequest | null = null;
    server.use(
      mock.patch(`${API}/findings/f2/review`, async ({ request }) => {
        sent = (await request.json()) as ReviewFindingRequest;
        return HttpResponse.json(
          aiFinding({
            id: 'f2',
            label: 'Effusion',
            confidence: 0.31,
            reviewStatus: 'EDITED',
            version: 1,
            review: {
              status: 'EDITED',
              label: 'Small pleural effusion',
              note: 'Left side',
              reviewedBy: { id: doctor.id, fullName: doctor.fullName },
              reviewedAt: '2026-11-25T10:00:00Z',
            },
          }),
        );
      }),
    );
    renderPanel();
    await screen.findByText('0 of 3 reviewed');

    await user.click(screen.getByRole('button', { name: 'Edit Effusion' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review “Effusion”' });
    const label = within(dialog).getByLabelText('Corrected label');
    await user.clear(label);
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    expect(await within(dialog).findByText('Enter a label')).toBeInTheDocument();
    expect(sent).toBeNull();

    await user.type(label, 'Small pleural effusion');
    await user.type(within(dialog).getByLabelText('Note'), 'Left side');
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));

    await waitFor(() =>
      expect(sent).toEqual({
        status: 'EDITED',
        label: 'Small pleural effusion',
        note: 'Left side',
        version: 0,
      }),
    );
    expect(await screen.findByText('Small pleural effusion')).toBeInTheDocument();
    expect(screen.getByText('AI: Effusion')).toBeInTheDocument();
    expect(screen.getByText('Left side')).toBeInTheDocument();
    expect(status('f2')).toHaveTextContent('Edited');
  });

  it('filters the unreviewed findings', async () => {
    const user = userEvent.setup();
    const reviewed: PredictionDto = {
      ...donePrediction,
      findings: donePrediction.findings.map((f) =>
        f.id === 'f1'
          ? {
              ...f,
              reviewStatus: 'ACCEPTED' as const,
              review: {
                status: 'ACCEPTED' as const,
                label: null,
                note: null,
                reviewedBy: { id: doctor.id, fullName: doctor.fullName },
                reviewedAt: '2026-11-25T10:00:00Z',
              },
            }
          : f,
      ),
    };
    serve(reviewed);
    renderPanel();
    expect(await screen.findByText('1 of 3 reviewed')).toBeInTheDocument();
    expect(screen.getByTestId('review-status-f1')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Unreviewed only' }));
    expect(screen.queryByTestId('review-status-f1')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-status-f2')).toBeInTheDocument();
    expect(screen.getByTestId('review-status-f3')).toBeInTheDocument();
  });

  it.each([
    ['a researcher', researcher],
    ['a technician', technician],
  ])('shows the review state but no review buttons to %s', async (_who, user) => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', user));
    serve();
    renderPanel();
    expect(await screen.findByText('0 of 3 reviewed')).toBeInTheDocument();
    expect(status('f1')).toHaveTextContent('Unreviewed');
    expect(screen.queryByRole('button', { name: /^Accept / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add finding/ })).not.toBeInTheDocument();
  });
});

describe('manual findings', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', doctor));
  });

  it('adds a finding located by the selected annotation', async () => {
    const user = userEvent.setup();
    serve();
    let sent: CreateFindingRequest | null = null;
    server.use(
      mock.post(`${API}/studies/${study.id}/findings`, async ({ request }) => {
        sent = (await request.json()) as CreateFindingRequest;
        return HttpResponse.json(
          aiFinding({
            id: 'm1',
            label: 'Rib fracture',
            confidence: null,
            source: 'MANUAL',
            reviewStatus: 'ACCEPTED',
            annotationId: 'ann-1',
            review: {
              status: 'ACCEPTED',
              label: null,
              note: null,
              reviewedBy: { id: doctor.id, fullName: doctor.fullName },
              reviewedAt: '2026-11-25T09:00:00Z',
            },
          }),
          { status: 201 },
        );
      }),
    );
    renderPanel({ id: 'ann-1', name: 'Rectangle 1' });

    await user.click(await screen.findByRole('button', { name: /Add finding/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a finding' });
    await user.type(within(dialog).getByLabelText('Label'), '  Rib fracture ');
    expect(
      within(dialog).getByRole('checkbox', {
        name: 'Located by the selected annotation: Rectangle 1',
      }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(sent).toEqual({ seriesId: SERIES_ID, label: 'Rib fracture', annotationId: 'ann-1' }),
    );
    const section = screen.getByTestId('manual-findings');
    expect(await within(section).findByText('Rib fracture')).toBeInTheDocument();
    expect(within(section).getByText(doctor.fullName)).toBeInTheDocument();
  });

  it('deletes only its own manual findings', async () => {
    const user = userEvent.setup();
    const mine = aiFinding({
      id: 'm1',
      label: 'Mine',
      source: 'MANUAL',
      reviewStatus: 'ACCEPTED',
      review: {
        status: 'ACCEPTED',
        label: null,
        note: null,
        reviewedBy: { id: doctor.id, fullName: doctor.fullName },
        reviewedAt: '2026-11-25T09:00:00Z',
      },
    });
    const theirs = {
      ...mine,
      id: 'm2',
      label: 'Theirs',
      review: { ...mine.review!, reviewedBy: { id: 'x', fullName: 'Dr. Other' } },
    };
    serve(donePrediction, [mine, theirs]);
    let deleted = '';
    server.use(
      mock.delete(`${API}/findings/:id`, ({ params }) => {
        deleted = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();

    const section = await screen.findByTestId('manual-findings');
    await within(section).findByText('Theirs');
    expect(
      within(section).queryByRole('button', { name: 'Delete Theirs' }),
    ).not.toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Delete Mine' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toBe('m1'));
    await waitFor(() => expect(within(section).queryByText('Mine')).not.toBeInTheDocument());
  });
});
