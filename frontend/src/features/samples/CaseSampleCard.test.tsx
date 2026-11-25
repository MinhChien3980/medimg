import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { MarkSampleRequest, PatientDto, UserDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import CaseDetailPage from '@/features/cases/CaseDetailPage';
import { admin, doctor, patient, researcher, samplePatient, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import { SAMPLE_DESCRIPTION_MAX, SAMPLE_SOURCE_MAX, SAMPLE_TITLE_MAX } from './CaseSampleCard';

const SOURCE = 'TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0, Wasserthal et al. 2023';

function renderCase(user: UserDto, p: PatientDto) {
  useAuthStore.getState().setSession(tokens('acc', 'ref', user));
  server.use(
    mock.get(`${API}/patients/${p.id}`, () => HttpResponse.json(p)),
    mock.get(`${API}/patients/${p.id}/studies`, () => HttpResponse.json([])),
  );
  renderWithProviders(<CaseDetailPage />, { route: `/cases/${p.id}`, path: '/cases/:caseId' });
}

async function section() {
  const title = await screen.findByText('Sample case', { selector: '.ant-card-head-title *' });
  const cardElement = title.closest('.ant-card');
  if (!(cardElement instanceof HTMLElement)) throw new Error('no sample card');
  return within(cardElement);
}

describe('Sample case section of the case page', () => {
  it('is hidden from non-admins on an ordinary case', async () => {
    renderCase(doctor, patient);
    expect(await screen.findByRole('heading', { name: patient.code })).toBeInTheDocument();
    expect(screen.queryByText('Sample case')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark as sample/ })).not.toBeInTheDocument();
  });

  it('shows a sample case read-only to non-admins', async () => {
    renderCase(researcher, samplePatient);
    const card = await section();
    expect(card.getByText('Abdominal CT, 2 mm')).toBeInTheDocument();
    expect(card.getByText(SOURCE)).toBeInTheDocument();
    expect(card.queryByRole('button')).not.toBeInTheDocument();
    // The case title carries the sample tag too.
    expect(screen.getByRole('heading', { name: /CASE-SAMPLE1/ })).toHaveTextContent('Sample case');
  });

  it('lets an admin mark a case as a sample: title and source required, values trimmed', async () => {
    const user = userEvent.setup();
    let body: MarkSampleRequest | null = null;
    server.use(
      mock.put(`${API}/patients/${patient.id}/sample`, async ({ request }) => {
        body = (await request.json()) as MarkSampleRequest;
        return HttpResponse.json<PatientDto>({
          ...patient,
          sample: { title: body.title, description: body.description ?? null, source: body.source },
        });
      }),
    );
    renderCase(admin, patient);
    const card = await section();
    expect(card.getByText('This case is not in the sample gallery.')).toBeInTheDocument();

    await user.click(card.getByRole('button', { name: /Mark as sample/ }));
    const dialog = within(await screen.findByRole('dialog'));
    const title = dialog.getByRole('textbox', { name: 'Title' });
    const description = dialog.getByRole('textbox', { name: 'Description' });
    const source = dialog.getByRole('textbox', { name: 'Source / licence' });
    expect(title).toHaveAttribute('maxlength', String(SAMPLE_TITLE_MAX));
    expect(description).toHaveAttribute('maxlength', String(SAMPLE_DESCRIPTION_MAX));
    expect(source).toHaveAttribute('maxlength', String(SAMPLE_SOURCE_MAX));

    // Blank (whitespace only) required fields are refused.
    await user.type(title, '   ');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dialog.getAllByText('Required')).toHaveLength(2));
    expect(body).toBeNull();

    await user.clear(title);
    await user.type(title, '  Abdominal CT  ');
    await user.type(source, ` ${SOURCE} `);
    await user.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(body).toEqual({ title: 'Abdominal CT', source: SOURCE }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await card.findByText('Abdominal CT')).toBeInTheDocument();
    expect(screen.getByText('Case marked as a sample')).toBeInTheDocument();
  });

  it('maps server field errors onto the form', async () => {
    const user = userEvent.setup();
    server.use(
      mock.put(`${API}/patients/${patient.id}/sample`, () =>
        HttpResponse.json(
          {
            title: 'Bad Request',
            status: 400,
            detail: 'Validation failed',
            errors: [{ field: 'source', message: 'size must be between 1 and 300' }],
          },
          { status: 400 },
        ),
      ),
    );
    renderCase(admin, patient);
    await user.click((await section()).getByRole('button', { name: /Mark as sample/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: 'Title' }), 'CT');
    await user.type(dialog.getByRole('textbox', { name: 'Source / licence' }), 'x');
    await user.click(dialog.getByRole('button', { name: 'Save' }));

    expect((await dialog.findAllByText('size must be between 1 and 300')).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('lets an admin edit (prefilled) and remove a sample', async () => {
    const user = userEvent.setup();
    let deleted = 0;
    server.use(
      mock.delete(`${API}/patients/${samplePatient.id}/sample`, () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderCase(admin, samplePatient);
    const card = await section();

    await user.click(card.getByRole('button', { name: /Edit sample details/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('Abdominal CT, 2 mm');
    expect(dialog.getByRole('textbox', { name: 'Source / licence' })).toHaveValue(SOURCE);
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(card.getByRole('button', { name: /Remove from samples/ }));
    const confirm = await screen.findByRole('tooltip');
    expect(
      within(confirm).getByText('Remove this case from the sample gallery?'),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(deleted).toBe(1));
    expect(await card.findByText('This case is not in the sample gallery.')).toBeInTheDocument();
  });
});
