import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { Outlet, createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppProviders } from '@/app/AppProviders';
import { useAuthStore } from '@/features/auth/authStore';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { doctor, tokens } from '@/test/fixtures';
import { createTestQueryClient, LocationProbe } from '@/test/render';
import { API, server } from '@/test/server';
import ChangePasswordPage from './ChangePasswordPage';

const NEW_PASSWORD = 'Sunrise2026x';

/** The real guard around the page, as in the router: every other path shows its location. */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <div>login page</div> },
      {
        path: '/',
        element: (
          <RequireAuth>
            <Outlet />
          </RequireAuth>
        ),
        children: [
          { path: 'account/password', element: <ChangePasswordPage /> },
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

/** `POST /me/password` answering `status` (204 by default), recording the bodies. */
function passwordEndpoint(
  answer: () => Response | Promise<Response> = () => new HttpResponse(null, { status: 204 }),
) {
  const bodies: unknown[] = [];
  server.use(
    mock.post(`${API}/me/password`, async ({ request }) => {
      bodies.push(await request.json());
      return answer();
    }),
  );
  return bodies;
}

function refreshEndpoint(user = doctor) {
  const calls: unknown[] = [];
  server.use(
    mock.post(`${API}/auth/refresh`, async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json(
        tokens('acc-2', 'ref-2', { ...user, passwordChangeRequired: false }),
      );
    }),
  );
  return calls;
}

async function fill(current: string, next: string, confirm = next) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Current password'), current);
  await user.type(screen.getByLabelText('New password'), next);
  await user.type(screen.getByLabelText('Repeat the new password'), confirm);
  return user;
}

function signIn(passwordChangeRequired: boolean) {
  useAuthStore.getState().setSession(tokens('acc', 'ref', { ...doctor, passwordChangeRequired }));
}

describe('ChangePasswordPage', () => {
  it('changes the password, renews the session and stays on the page', async () => {
    signIn(false);
    const bodies = passwordEndpoint();
    const refreshes = refreshEndpoint();
    const router = renderAt('/account/password');

    expect(screen.getByRole('heading', { name: /Change password/ })).toBeInTheDocument();
    const user = await fill('Demo@12345', NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(bodies).toEqual([{ currentPassword: 'Demo@12345', newPassword: NEW_PASSWORD }]);
    expect(refreshes).toEqual([{ refreshToken: 'ref' }]);
    expect(useAuthStore.getState().accessToken).toBe('acc-2');
    expect(router.state.location.pathname).toBe('/account/password');
    // The form is emptied: nothing stays in the fields.
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it('checks the policy before sending: length, letters and digits, username, current password, repeat', async () => {
    signIn(false);
    const bodies = passwordEndpoint();
    renderAt('/account/password');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Current password'), 'Demo@12345');
    const next = screen.getByLabelText('New password');
    await user.type(next, 'short1');
    expect(await screen.findByText('Use at least 10 characters')).toBeInTheDocument();

    await user.clear(next);
    await user.type(next, 'onlyletters');
    expect(await screen.findByText('Add at least one digit')).toBeInTheDocument();

    await user.clear(next);
    await user.type(next, '1234567890');
    expect(await screen.findByText('Add at least one letter')).toBeInTheDocument();

    await user.clear(next);
    await user.type(next, 'myDOCTOR2026');
    expect(await screen.findByText('Must not contain your username')).toBeInTheDocument();

    await user.clear(next);
    await user.type(next, 'Demo@12345');
    expect(await screen.findByText('Must differ from the current password')).toBeInTheDocument();

    await user.clear(next);
    await user.type(next, NEW_PASSWORD);
    await user.type(screen.getByLabelText('Repeat the new password'), `${NEW_PASSWORD}!`);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The two passwords differ')).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('re-checks "differs from current" when the current password is edited afterwards', async () => {
    signIn(false);
    passwordEndpoint();
    renderAt('/account/password');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('New password'), NEW_PASSWORD);
    await user.type(screen.getByLabelText('Current password'), NEW_PASSWORD);
    expect(await screen.findByText('Must differ from the current password')).toBeInTheDocument();
  });

  it('shows a wrong current password (422) on its field and keeps the session', async () => {
    signIn(false);
    passwordEndpoint(() =>
      HttpResponse.json(
        { status: 422, title: 'Unprocessable', detail: 'Current password is wrong' },
        { status: 422 },
      ),
    );
    renderAt('/account/password');
    const user = await fill('wrong-password', NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('The current password is not correct')).toBeInTheDocument();
    expect(useAuthStore.getState().accessToken).toBe('acc');
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('puts server field errors on their field', async () => {
    signIn(false);
    passwordEndpoint(() =>
      HttpResponse.json(
        {
          status: 400,
          detail: 'Validation failed',
          errors: [{ field: 'newPassword', message: 'must not be a common password' }],
        },
        { status: 400 },
      ),
    );
    renderAt('/account/password');
    const user = await fill('Demo@12345', NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('must not be a common password')).toBeInTheDocument();
  });

  it('shows other failures above the form', async () => {
    signIn(false);
    passwordEndpoint(() =>
      HttpResponse.json(
        { status: 500, title: 'Internal error', detail: 'Database down' },
        { status: 500 },
      ),
    );
    renderAt('/account/password');
    const user = await fill('Demo@12345', NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Database down')).toBeInTheDocument();
  });

  it('disables the form while the change is in flight (no double submit)', async () => {
    signIn(false);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bodies = passwordEndpoint(async () => {
      await gate;
      return new HttpResponse(null, { status: 204 });
    });
    refreshEndpoint();
    renderAt('/account/password');
    const user = await fill('Demo@12345', NEW_PASSWORD);
    const submit = screen.getByRole('button', { name: 'Change password' });
    await user.click(submit);

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(screen.getByLabelText('New password')).toBeDisabled();
    await user.click(submit);
    release();
    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
  });

  describe('forced change (temporary password)', () => {
    it('keeps every route on the password page, then returns to the requested page', async () => {
      signIn(true);
      passwordEndpoint();
      refreshEndpoint();
      const router = renderAt('/cases?q=x');

      expect(
        await screen.findByRole('heading', { name: /Choose a new password/ }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/account/password');
      expect(screen.getByText(/You signed in with a temporary password/)).toBeInTheDocument();

      const user = await fill('Temp-Pass-123', NEW_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Change password' }));

      expect(await screen.findByTestId('location')).toHaveTextContent('/cases?q=x');
      expect(useAuthStore.getState().user?.passwordChangeRequired).toBe(false);
    });

    it('lands on the dashboard when no page was requested', async () => {
      signIn(true);
      passwordEndpoint();
      refreshEndpoint();
      renderAt('/account/password');

      const user = await fill('Temp-Pass-123', NEW_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Change password' }));
      expect(await screen.findByTestId('location')).toHaveTextContent('/dashboard');
    });

    it('stays forced when the change fails', async () => {
      signIn(true);
      passwordEndpoint(() => HttpResponse.json({ status: 422, detail: 'wrong' }, { status: 422 }));
      const router = renderAt('/dashboard');
      const user = await fill('bad', NEW_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Change password' }));

      expect(await screen.findByText('The current password is not correct')).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/account/password');
      expect(useAuthStore.getState().user?.passwordChangeRequired).toBe(true);
    });

    it('asks to sign in again when the server ended the session with the change', async () => {
      signIn(true);
      passwordEndpoint();
      server.use(
        mock.post(`${API}/auth/refresh`, () =>
          HttpResponse.json({ status: 401, detail: 'Refresh token revoked' }, { status: 401 }),
        ),
      );
      renderAt('/account/password');
      const user = await fill('Temp-Pass-123', NEW_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Change password' }));

      expect(await screen.findByText('login page')).toBeInTheDocument();
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.passwordChangedSignIn).toBe(true);
      expect(state.sessionExpired).toBe(false);
    });
  });

  it('lists the policy for assistive technology next to the new password field', () => {
    signIn(false);
    renderAt('/account/password');
    const policy = document.getElementById('password-policy');
    expect(policy).not.toBeNull();
    expect(within(policy as HTMLElement).getByText(/at least 10 characters/)).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute(
      'aria-describedby',
      'password-policy',
    );
  });
});
