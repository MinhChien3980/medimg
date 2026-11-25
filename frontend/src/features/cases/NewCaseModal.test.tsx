import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { CreatePatientRequest } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { patient, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import { CASE_CODE_MAX, NOTE_MAX, NewCaseModal } from './NewCaseModal';

function renderModal() {
  const onCreated = vi.fn();
  renderWithProviders(<NewCaseModal open onClose={() => undefined} onCreated={onCreated} />);
  return { onCreated };
}

describe('NewCaseModal', () => {
  it('mirrors the server limits on the inputs', () => {
    renderModal();
    expect(screen.getByLabelText('Case code')).toHaveAttribute('maxlength', String(CASE_CODE_MAX));
    expect(screen.getByLabelText('Note')).toHaveAttribute('maxlength', String(NOTE_MAX));
    expect(CASE_CODE_MAX).toBe(32);
    expect(NOTE_MAX).toBe(500);
  });

  it('rejects a case code with characters the server does not accept', async () => {
    const user = userEvent.setup();
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    let posts = 0;
    server.use(
      mock.post(`${API}/patients`, () => {
        posts += 1;
        return HttpResponse.json(patient, { status: 201 });
      }),
    );

    renderModal();
    await user.type(screen.getByLabelText('Case code'), 'CASE 01!');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Use letters, digits, - and _ only')).toBeInTheDocument();
    expect(posts).toBe(0);
  });

  it('sends only the filled-in, trimmed fields', async () => {
    const user = userEvent.setup();
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    let body: CreatePatientRequest | null = null;
    server.use(
      mock.post(`${API}/patients`, async ({ request }) => {
        body = (await request.json()) as CreatePatientRequest;
        return HttpResponse.json(patient, { status: 201 });
      }),
    );

    const { onCreated } = renderModal();
    await user.type(screen.getByLabelText('Case code'), ' CASE-42 ');
    await user.type(screen.getByLabelText('Birth year'), '1970');
    await user.type(screen.getByLabelText('Note'), '  follow-up ');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(patient));
    expect(body).toEqual({ code: 'CASE-42', birthYear: 1970, note: 'follow-up' });
  });
});
