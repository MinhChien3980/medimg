import { useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http as mock, HttpResponse } from 'msw';
import { Outlet, createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppProviders } from '@/app/AppProviders';
import { patientsApi } from '@/api/endpoints';
import { doctor, tokens } from '@/test/fixtures';
import { createTestQueryClient, LocationProbe } from '@/test/render';
import { API, server } from '@/test/server';
import { useAuthStore } from './authStore';
import { RequireAuth } from './RequireAuth';

function CasesProbe() {
  const cases = useQuery({
    queryKey: ['probe'],
    queryFn: () => patientsApi.list({ q: '', page: 0, size: 10 }),
  });
  return <div>{cases.isError ? 'cases failed' : 'cases page'}</div>;
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LocationProbe /> },
      {
        path: '/',
        element: (
          <RequireAuth>
            <Outlet />
          </RequireAuth>
        ),
        children: [
          { path: 'cases', element: <CasesProbe /> },
          { path: '*', element: <LocationProbe /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <AppProviders queryClient={createTestQueryClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return router;
}

const passwordChangeRequired = {
  type: 'https://medimg.example/problems/password-change-required',
  title: 'Password change required',
  status: 403,
  detail: 'Change your temporary password first',
};

describe('RequireAuth', () => {
  it('sends a signed-out user to /login, remembering the page', () => {
    const router = renderAt('/admin/users?status=LOCKED');
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.state).toEqual({ from: '/admin/users?status=LOCKED' });
  });

  it.each(['/dashboard', '/cases', '/admin/users', '/studies/x/report'])(
    'keeps a user who must change their password on the password page (%s)',
    (path) => {
      useAuthStore
        .getState()
        .setSession(tokens('acc', 'ref', { ...doctor, passwordChangeRequired: true }));
      const router = renderAt(path);
      expect(router.state.location.pathname).toBe('/account/password');
      expect(router.state.location.state).toEqual({ from: path });
    },
  );

  it('lets a user whose password is fine through', () => {
    useAuthStore
      .getState()
      .setSession(tokens('acc', 'ref', { ...doctor, passwordChangeRequired: false }));
    const router = renderAt('/samples');
    expect(router.state.location.pathname).toBe('/samples');
  });

  it('treats sessions stored before the flag existed as not requiring a change', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', doctor));
    expect(renderAt('/samples').state.location.pathname).toBe('/samples');
  });

  it('moves to the password page when any API answers 403 password-change-required', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    server.use(
      mock.get(`${API}/patients`, () => HttpResponse.json(passwordChangeRequired, { status: 403 })),
    );
    const router = renderAt('/cases');

    expect(await screen.findByTestId('location')).toHaveTextContent('/account/password');
    expect(router.state.location.state).toEqual({ from: '/cases' });
    expect(useAuthStore.getState().user?.passwordChangeRequired).toBe(true);
  });

  it('does not treat an ordinary 403 as a password change', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    server.use(
      mock.get(`${API}/patients`, () =>
        HttpResponse.json(
          { title: 'Forbidden', status: 403, detail: 'No permission' },
          { status: 403 },
        ),
      ),
    );
    const router = renderAt('/cases');

    expect(await screen.findByText('cases failed')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/cases');
    expect(useAuthStore.getState().user?.passwordChangeRequired).toBeUndefined();
  });
});
