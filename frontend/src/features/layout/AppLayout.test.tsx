import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import { researcher, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import AppLayout from './AppLayout';

describe('AppLayout', () => {
  it('shows every section to a doctor', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    renderWithProviders(<AppLayout />, { route: '/cases' });

    expect(screen.getByRole('menuitem', { name: /Cases/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Upload/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Sample cases/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'MedImg' })).toHaveAttribute('href', '/cases');
  });

  it('hides upload from a read-only researcher but keeps the sample cases', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    renderWithProviders(<AppLayout />, { route: '/cases' });

    expect(screen.getByRole('menuitem', { name: /Cases/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Upload/ })).not.toBeInTheDocument();
    // Sample cases are for every role.
    expect(screen.getByRole('menuitem', { name: /Sample cases/ })).toBeInTheDocument();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
  });
});
