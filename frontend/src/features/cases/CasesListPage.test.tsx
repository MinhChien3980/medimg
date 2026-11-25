import { screen } from '@testing-library/react';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import { researcher, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import CasesListPage from './CasesListPage';

const emptyPage = { content: [], page: 0, size: 10, totalElements: 0, totalPages: 0 };

describe('CasesListPage when empty', () => {
  it('points to the sample cases when there are no cases at all', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    server.use(mock.get(`${API}/patients`, () => HttpResponse.json(emptyPage)));
    renderWithProviders(<CasesListPage />, { route: '/cases' });

    expect(await screen.findByText('No cases yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Try a sample case/ })).toHaveAttribute(
      'href',
      '/samples',
    );
  });

  it('only says nothing matched when a search finds nothing', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    server.use(mock.get(`${API}/patients`, () => HttpResponse.json(emptyPage)));
    renderWithProviders(<CasesListPage />, { route: '/cases?q=zzz', path: '/cases' });

    expect(await screen.findByText('No cases match the search')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Try a sample case/ })).not.toBeInTheDocument();
  });
});
