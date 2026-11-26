import { render, screen, waitFor } from '@testing-library/react';
import { http as mock, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import {
  admin,
  adminUser,
  dashboard,
  doctor,
  page,
  researcher,
  technician,
  tokens,
} from '@/test/fixtures';
import { createTestQueryClient } from '@/test/render';
import { API, server } from '@/test/server';
import { AppProviders } from './AppProviders';
import { routes } from './router';

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <AppProviders queryClient={createTestQueryClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return router;
}

describe('app routes', () => {
  it('lands every role on the dashboard', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    server.use(mock.get(`${API}/dashboard`, () => HttpResponse.json(dashboard())));
    const router = renderApp('/');

    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it.each([
    [doctor, '/admin/users'],
    [technician, '/admin/models'],
    [researcher, '/admin/audit'],
  ])('refuses %s on %s without asking the API', async (user, path) => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', user));
    let adminCalls = 0;
    server.use(
      mock.all(`${API}/admin/*`, () => {
        adminCalls += 1;
        return HttpResponse.json({ status: 403 }, { status: 403 });
      }),
    );
    renderApp(path);

    expect(await screen.findByText('This section is for administrators only.')).toBeInTheDocument();
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(adminCalls).toBe(0);
  });

  it('opens the users page for an admin, from /admin too', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    server.use(mock.get(`${API}/admin/users`, () => HttpResponse.json(page([adminUser()]))));
    const router = renderApp('/admin');

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users'));
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
  });

  it('opens the password page from its route', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    renderApp('/account/password');
    expect(await screen.findByRole('heading', { name: /Change password/ })).toBeInTheDocument();
  });
});
