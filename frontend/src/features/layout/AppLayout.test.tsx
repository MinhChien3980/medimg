import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import { admin, doctor, researcher, technician, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import AppLayout from './AppLayout';

describe('AppLayout', () => {
  it('shows every section to a doctor, with the dashboard first', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    renderWithProviders(<AppLayout />, { route: '/cases' });

    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Dashboard', 'Cases', 'Sample cases', 'Upload']);
    expect(screen.getByRole('link', { name: 'MedImg' })).toHaveAttribute('href', '/dashboard');
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

  it('shows the Administration group to admins only', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    renderWithProviders(<AppLayout />, { route: '/admin/audit' });

    expect(screen.getByText('Administration')).toBeInTheDocument();
    for (const name of [/Users/, /AI models/, /Audit log/]) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    // The current section is selected.
    expect(screen.getByRole('menuitem', { name: /Audit log/ }).className).toContain('selected');
  });

  it.each([doctor, technician, researcher])('hides Administration from $username', (user) => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', user));
    renderWithProviders(<AppLayout />, { route: '/dashboard' });

    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Users/ })).not.toBeInTheDocument();
  });

  it('offers no navigation while a temporary password must be changed', () => {
    useAuthStore
      .getState()
      .setSession(tokens('acc', 'ref', { ...admin, passwordChangeRequired: true }));
    renderWithProviders(<AppLayout />, { route: '/account/password' });

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    // Logging out stays possible.
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  it('opens the password page from the account menu', async () => {
    const user = userEvent.setup();
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    renderWithProviders(<AppLayout />, { route: '/cases' });

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByText('Change password'));
    expect(await screen.findByTestId('location')).toHaveTextContent('/account/password');
  });
});
