import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { researcher, tokens } from '@/test/fixtures';
import { LocationProbe, renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import { useAuthStore } from './authStore';
import LoginPage from './LoginPage';

describe('LoginPage', () => {
  it('fills a demo account and signs in', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      mock.post(`${API}/auth/login`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(tokens('acc', 'ref'));
      }),
    );

    renderWithProviders(<LoginPage />, {
      route: '/login',
      extraRoutes: [{ path: '/dashboard', element: <LocationProbe /> }],
    });

    expect(screen.getByText('Research demo only – not for diagnostic use')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /doctor/ }));
    expect(screen.getByLabelText('Username')).toHaveValue('doctor');
    expect(screen.getByLabelText('Password')).toHaveValue('Demo@12345');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('location')).toHaveTextContent('/dashboard');
    expect(body).toEqual({ username: 'doctor', password: 'Demo@12345' });
    expect(useAuthStore.getState().accessToken).toBe('acc');
  });

  it('offers the read-only researcher demo account', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      mock.post(`${API}/auth/login`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(tokens('acc', 'ref', researcher));
      }),
    );

    renderWithProviders(<LoginPage />, {
      route: '/login',
      extraRoutes: [{ path: '/dashboard', element: <LocationProbe /> }],
    });

    const account = screen.getByRole('button', { name: /researcher/ });
    expect(account).toHaveTextContent('Researcher');
    await user.click(account);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('location')).toHaveTextContent('/dashboard');
    expect(body).toEqual({ username: 'researcher', password: 'Demo@12345' });
  });

  it('explains why the user is back on the login page after the session expired', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    useAuthStore.getState().expire();

    renderWithProviders(<LoginPage />, { route: '/login' });
    expect(screen.getByText('Your session has expired, please sign in again.')).toBeInTheDocument();
  });

  it('says the session was ended when the server revoked it (account locked)', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    useAuthStore.getState().revoke();

    renderWithProviders(<LoginPage />, { route: '/login' });
    expect(
      screen.getByText(
        'Your session was ended. Sign in again; if that fails, contact an administrator.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Your session has expired, please sign in again.'),
    ).not.toBeInTheDocument();
  });

  it('shows the ProblemDetail `detail` on failure', async () => {
    const user = userEvent.setup();
    server.use(
      mock.post(`${API}/auth/login`, () =>
        HttpResponse.json(
          { title: 'Unauthorized', status: 401, detail: 'Invalid username or password' },
          { status: 401 },
        ),
      ),
    );

    renderWithProviders(<LoginPage />, { route: '/login' });
    await user.type(screen.getByLabelText('Username'), 'doctor');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid username or password')).toBeInTheDocument();
    expect(screen.getByText('Sign-in failed')).toBeInTheDocument();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('says the password was changed when the session ended with the change', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    useAuthStore.getState().expire();
    useAuthStore.getState().signOutAfterPasswordChange();

    renderWithProviders(<LoginPage />, { route: '/login' });
    expect(
      screen.getByText('Your password was changed. Sign in with the new password.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Your session has expired, please sign in again.'),
    ).not.toBeInTheDocument();
  });

  it('signs in with a temporary password: the session carries the change-required flag', async () => {
    const user = userEvent.setup();
    server.use(
      mock.post(`${API}/auth/login`, () =>
        HttpResponse.json(tokens('acc', 'ref', { ...researcher, passwordChangeRequired: true })),
      ),
    );
    renderWithProviders(<LoginPage />, {
      route: '/login',
      extraRoutes: [{ path: '/dashboard', element: <LocationProbe /> }],
    });
    await user.type(screen.getByLabelText('Username'), 'researcher');
    await user.type(screen.getByLabelText('Password'), 'Temp-Pass-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The route guard (tested with RequireAuth) then keeps the user on the password page.
    expect(await screen.findByTestId('location')).toHaveTextContent('/dashboard');
    expect(useAuthStore.getState().user?.passwordChangeRequired).toBe(true);
  });
});
