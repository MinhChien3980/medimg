import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { tokens } from '@/test/fixtures';
import { LocationProbe, renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import { useAuthStore } from './authStore';
import { useLogout } from './session';

function LogoutButton() {
  const logout = useLogout();
  return (
    <button type="button" onClick={() => void logout()}>
      logout
    </button>
  );
}

function renderLogout() {
  return renderWithProviders(<LogoutButton />, {
    route: '/cases',
    extraRoutes: [{ path: '/login', element: <LocationProbe /> }],
  });
}

describe('useLogout', () => {
  it('revokes the refresh token, clears the session and goes to /login', async () => {
    const user = userEvent.setup();
    useAuthStore.getState().setSession(tokens('acc', 'r1'));
    let body: unknown = null;
    server.use(
      mock.post(`${API}/auth/logout`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderLogout();
    await user.click(screen.getByRole('button', { name: 'logout' }));

    expect(await screen.findByTestId('location')).toHaveTextContent('/login');
    expect(body).toEqual({ refreshToken: 'r1' });
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });

  it('still clears the local session when the server call fails', async () => {
    const user = userEvent.setup();
    useAuthStore.getState().setSession(tokens('acc', 'r1'));
    server.use(
      mock.post(`${API}/auth/logout`, () =>
        HttpResponse.json({ title: 'Server error', status: 500 }, { status: 500 }),
      ),
    );

    renderLogout();
    await user.click(screen.getByRole('button', { name: 'logout' }));

    expect(await screen.findByTestId('location')).toHaveTextContent('/login');
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });
});
