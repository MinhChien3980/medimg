import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { AdminUserDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { admin, adminUser, listedDoctor, page, secondAdmin, tokens } from '@/test/fixtures';
import { findModal } from '@/test/modal';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import UsersPage from './UsersPage';

type Json = Record<string, unknown>;

interface Backend {
  users: AdminUserDto[];
  listUrls: URL[];
  bodies: Array<{ method: string; path: string; body: Json | null }>;
  /** Number of active admins reported (default: counted from `users`). */
  activeAdmins?: number;
}

/** A stateful `/admin/users` API over `users`. */
function usersBackend(users: AdminUserDto[]): Backend {
  const b: Backend = { users: users.map((u) => ({ ...u })), listUrls: [], bodies: [] };
  const record = async (request: Request, path: string) => {
    const text = await request.text();
    b.bodies.push({ method: request.method, path, body: text ? (JSON.parse(text) as Json) : null });
  };
  const find = (id: unknown) => b.users.find((u) => u.id === id);
  server.use(
    mock.get(`${API}/admin/users`, ({ request }) => {
      const url = new URL(request.url);
      const p = url.searchParams;
      if (p.get('role') === 'ADMIN' && p.get('status') === 'ACTIVE' && p.get('size') === '1') {
        const count =
          b.activeAdmins ??
          b.users.filter((u) => u.status === 'ACTIVE' && u.roles.includes('ADMIN')).length;
        return HttpResponse.json(page([], { totalElements: count }));
      }
      b.listUrls.push(url);
      return HttpResponse.json(page(b.users));
    }),
    mock.post(`${API}/admin/users`, async ({ request }) => {
      await record(request, '/admin/users');
      const body = b.bodies.at(-1)?.body ?? {};
      const created = adminUser({
        id: 'new-user',
        username: String(body.username),
        fullName: String(body.fullName),
        email: (body.email as string | undefined) ?? null,
        roles: body.roles as AdminUserDto['roles'],
        passwordChangeRequired: true,
        lastLoginAt: null,
      });
      b.users.push(created);
      return HttpResponse.json(
        { user: created, temporaryPassword: 'Tmp-7Qx9-Lm2p' },
        { status: 201 },
      );
    }),
    mock.put(`${API}/admin/users/:id`, async ({ request, params }) => {
      await record(request, `/admin/users/${String(params.id)}`);
      const body = b.bodies.at(-1)?.body ?? {};
      const user = find(params.id);
      if (!user) return HttpResponse.json({ status: 404 }, { status: 404 });
      if (body.version !== user.version) {
        return HttpResponse.json(
          { status: 409, title: 'Conflict', detail: 'The user was changed by another request' },
          { status: 409 },
        );
      }
      Object.assign(user, {
        fullName: body.fullName,
        email: body.email ?? null,
        roles: body.roles,
        version: user.version + 1,
      });
      return HttpResponse.json(user);
    }),
    mock.post(`${API}/admin/users/:id/:action`, async ({ request, params }) => {
      await record(request, `/admin/users/${String(params.id)}/${String(params.action)}`);
      const user = find(params.id);
      if (!user) return HttpResponse.json({ status: 404 }, { status: 404 });
      if (params.action === 'lock') user.status = 'LOCKED';
      if (params.action === 'unlock') user.status = 'ACTIVE';
      if (params.action === 'reset-password') {
        user.passwordChangeRequired = true;
        return HttpResponse.json({ temporaryPassword: 'Reset-4Kd8-Pw3z' });
      }
      return HttpResponse.json(user);
    }),
  );
  return b;
}

function renderUsers(route = '/admin/users') {
  useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
  return renderWithProviders(<UsersPage />, { route, path: '/admin/users' });
}

async function rowOf(username: string): Promise<HTMLElement> {
  const cell = await screen.findByText(username, { selector: 'strong' });
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${username}`);
  return row;
}

describe('UsersPage list', () => {
  it('lists users with roles, status, password state and last sign-in', async () => {
    usersBackend([
      adminUser(),
      listedDoctor,
      adminUser({
        id: 'locked',
        username: 'tech',
        fullName: 'Locked Tech',
        roles: ['TECHNICIAN'],
        status: 'LOCKED',
        passwordChangeRequired: true,
        lastLoginAt: null,
      }),
    ]);
    renderUsers();

    const me = await rowOf('admin');
    expect(within(me).getByText('you')).toBeInTheDocument();
    const doctorRow = await rowOf('doctor');
    expect(within(doctorRow).getByText('doctor@example.org')).toBeInTheDocument();
    expect(within(doctorRow).getByText('Doctor')).toBeInTheDocument();
    expect(within(doctorRow).getByText('Active')).toBeInTheDocument();
    const tech = await rowOf('tech');
    expect(within(tech).getByText('Locked')).toBeInTheDocument();
    expect(within(tech).getByText('Must change password')).toBeInTheDocument();
    expect(within(tech).getByText('Never')).toBeInTheDocument();
    expect(within(tech).getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    expect(within(tech).queryByRole('button', { name: 'Lock' })).not.toBeInTheDocument();
  });

  it('searches and filters through the address, back to page 1', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), listedDoctor]);
    const { router } = renderUsers('/admin/users?page=3');
    await rowOf('doctor');
    expect(b.listUrls[0]?.searchParams.get('page')).toBe('2');

    await user.type(screen.getByLabelText('Search by username, name or e-mail'), ' doc {Enter}');
    await waitFor(() => expect(router.state.location.search).toBe('?q=doc'));
    await waitFor(() => expect(b.listUrls.at(-1)?.searchParams.get('q')).toBe('doc'));
    expect(b.listUrls.at(-1)?.searchParams.get('page')).toBe('0');

    await user.click(screen.getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByTitle('Doctor'));
    await waitFor(() => expect(b.listUrls.at(-1)?.searchParams.get('role')).toBe('DOCTOR'));

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByTitle('Locked'));
    await waitFor(() => expect(b.listUrls.at(-1)?.searchParams.get('status')).toBe('LOCKED'));
    expect(router.state.location.search).toBe('?q=doc&role=DOCTOR&status=LOCKED');
  });

  it('ignores unknown role / status values in the address', async () => {
    const b = usersBackend([adminUser()]);
    renderUsers('/admin/users?role=ROOT&status=GONE');
    await rowOf('admin');
    expect(b.listUrls[0]?.searchParams.has('role')).toBe(false);
    expect(b.listUrls[0]?.searchParams.has('status')).toBe(false);
  });

  it('shows a load error', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    server.use(
      mock.get(`${API}/admin/users`, () =>
        HttpResponse.json({ status: 500, detail: 'Database down' }, { status: 500 }),
      ),
    );
    renderWithProviders(<UsersPage />, { route: '/admin/users' });
    expect(await screen.findByText('Database down')).toBeInTheDocument();
  });
});

describe('UsersPage create', () => {
  it('validates, creates the user and shows the temporary password once', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const b = usersBackend([adminUser()]);
    renderUsers();
    await rowOf('admin');

    await user.click(screen.getByRole('button', { name: 'New user' }));
    const dialog = await findModal('New user');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findByText('Enter a username')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter the full name')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose at least one role')).toBeInTheDocument();

    const username = within(dialog).getByLabelText('Username');
    await user.type(username, 'a b');
    expect(await within(dialog).findByText(/Use 3–50 lowercase letters/)).toBeInTheDocument();
    await user.clear(username);
    // Typed in capitals, kept in lowercase as the server requires.
    await user.type(username, 'New.Tech');
    expect(username).toHaveValue('new.tech');
    await user.type(within(dialog).getByLabelText('Full name'), '  New Technician ');
    await user.type(within(dialog).getByLabelText('E-mail (optional)'), 'not-an-email');
    expect(await within(dialog).findByText('Enter a valid e-mail address')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('E-mail (optional)'));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Technician' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    const temp = await findModal('Temporary password');
    expect(b.bodies.at(-1)).toEqual({
      method: 'POST',
      path: '/admin/users',
      body: { username: 'new.tech', fullName: 'New Technician', roles: ['TECHNICIAN'] },
    });
    expect(within(temp).getByText(/Account new.tech has been created/)).toBeInTheDocument();
    expect(within(temp).getByLabelText('Temporary password')).toHaveValue('Tmp-7Qx9-Lm2p');
    expect(within(temp).getByText(/It is shown only this once/)).toBeInTheDocument();
    // Only the button closes it: no close icon.
    expect(within(temp).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    await user.click(within(temp).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Tmp-7Qx9-Lm2p');
    expect(await screen.findByText('Copied to the clipboard')).toBeInTheDocument();

    await user.click(within(temp).getByRole('button', { name: 'I have noted it' }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('Tmp-7Qx9-Lm2p')).not.toBeInTheDocument(),
    );
    // The list is read again and shows the new account.
    const row = await rowOf('new.tech');
    expect(within(row).getByText('Must change password')).toBeInTheDocument();
  });

  it('selects the password for a manual copy when the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    usersBackend([adminUser()]);
    renderUsers();
    await rowOf('admin');

    await user.click(screen.getByRole('button', { name: 'New user' }));
    const dialog = await findModal('New user');
    await user.type(within(dialog).getByLabelText('Username'), 'nurse');
    await user.type(within(dialog).getByLabelText('Full name'), 'Nurse');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Researcher' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    const temp = await findModal('Temporary password');
    await user.click(within(temp).getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText('Copying failed: select the password and copy it by hand.'),
    ).toBeInTheDocument();
    const input = within(temp).getByLabelText<HTMLInputElement>('Temporary password');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Tmp-7Qx9-Lm2p'.length);
  });

  it('says when the username is taken (409, any case)', async () => {
    const user = userEvent.setup();
    usersBackend([adminUser()]);
    server.use(
      mock.post(`${API}/admin/users`, () =>
        HttpResponse.json({ status: 409, detail: 'Username already exists' }, { status: 409 }),
      ),
    );
    renderUsers();
    await rowOf('admin');

    await user.click(screen.getByRole('button', { name: 'New user' }));
    const dialog = await findModal('New user');
    await user.type(within(dialog).getByLabelText('Username'), 'doctor');
    await user.type(within(dialog).getByLabelText('Full name'), 'Dup');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Doctor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    expect(await within(dialog).findByText('This username is already taken')).toBeInTheDocument();
    expect(
      screen.queryByText('Temporary password', { selector: '.ant-modal-title' }),
    ).not.toBeInTheDocument();
  });

  it('maps server field errors onto the form', async () => {
    const user = userEvent.setup();
    usersBackend([adminUser()]);
    server.use(
      mock.post(`${API}/admin/users`, () =>
        HttpResponse.json(
          { status: 400, detail: 'Validation failed', errors: { email: 'is not deliverable' } },
          { status: 400 },
        ),
      ),
    );
    renderUsers();
    await rowOf('admin');

    await user.click(screen.getByRole('button', { name: 'New user' }));
    const dialog = await findModal('New user');
    await user.type(within(dialog).getByLabelText('Username'), 'nurse');
    await user.type(within(dialog).getByLabelText('Full name'), 'Nurse');
    await user.type(within(dialog).getByLabelText('E-mail (optional)'), 'nurse@example.org');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Doctor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    expect(await within(dialog).findByText('is not deliverable')).toBeInTheDocument();
  });
});

describe('UsersPage edit', () => {
  it('saves name, e-mail and roles with the version it read', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), listedDoctor]);
    renderUsers();
    const row = await rowOf('doctor');

    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await findModal('Edit doctor');
    const name = within(dialog).getByLabelText('Full name');
    expect(name).toHaveValue('Dr. Demo');
    await user.clear(name);
    await user.type(name, 'Dr. Renamed');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Researcher' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('User doctor saved')).toBeInTheDocument();
    expect(b.bodies.at(-1)).toEqual({
      method: 'PUT',
      path: `/admin/users/${listedDoctor.id}`,
      body: {
        fullName: 'Dr. Renamed',
        email: 'doctor@example.org',
        roles: ['DOCTOR', 'RESEARCHER'],
        version: 3,
      },
    });
  });

  it('on a stale version (409) reloads the user and saves with the new version', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), listedDoctor]);
    renderUsers();
    const row = await rowOf('doctor');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await findModal('Edit doctor');

    // Another admin saves meanwhile.
    const stored = b.users.find((u) => u.id === listedDoctor.id) as AdminUserDto;
    Object.assign(stored, { fullName: 'Changed Elsewhere', version: 4 });

    await user.click(within(dialog).getByRole('checkbox', { name: 'Technician' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('The user was changed by another request'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Full name')).toHaveValue('Changed Elsewhere'),
    );
    expect(within(dialog).getByRole('checkbox', { name: 'Technician' })).not.toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('User doctor saved')).toBeInTheDocument();
    expect(b.bodies.at(-1)?.body).toMatchObject({ fullName: 'Changed Elsewhere', version: 4 });
  });

  it('says so when the reloaded user is gone', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), listedDoctor]);
    renderUsers();
    const row = await rowOf('doctor');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await findModal('Edit doctor');
    b.users = b.users.filter((u) => u.id !== listedDoctor.id);
    (b.users[0] as AdminUserDto).version = 0;
    server.use(
      mock.put(`${API}/admin/users/:id`, () =>
        HttpResponse.json({ status: 409, detail: 'Changed' }, { status: 409 }),
      ),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Reload' }));
    expect(
      await within(dialog).findByText(
        'This user is no longer in the list; close the dialog and search again.',
      ),
    ).toBeInTheDocument();
  });

  it('does not let an admin remove their own Admin role, and says why', async () => {
    const user = userEvent.setup();
    usersBackend([adminUser(), secondAdmin]);
    renderUsers();
    const row = await rowOf('admin');

    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await findModal('Edit admin');
    expect(within(dialog).getByRole('checkbox', { name: 'Admin' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Admin' })).toBeDisabled();
    expect(within(dialog).getByText('You cannot remove your own Admin role.')).toBeInTheDocument();
    // Other roles stay editable.
    expect(within(dialog).getByRole('checkbox', { name: 'Doctor' })).toBeEnabled();
  });

  it('keeps the Admin role of the last active admin', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), secondAdmin]);
    // E.g. the signed-in admin is the only other one and was just locked elsewhere.
    b.activeAdmins = 1;
    renderUsers();
    const row = await rowOf('admin2');

    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await findModal('Edit admin2');
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: 'Admin' })).toBeDisabled(),
    );
    expect(
      within(dialog).getByText('The last active admin must keep the Admin role.'),
    ).toBeInTheDocument();
  });

  it('shows the server refusal of a self-demotion (422) if it still happens', async () => {
    const user = userEvent.setup();
    usersBackend([adminUser(), secondAdmin]);
    server.use(
      mock.put(`${API}/admin/users/:id`, () =>
        HttpResponse.json(
          {
            status: 422,
            title: 'Unprocessable',
            detail: 'An admin cannot remove their own ADMIN role',
          },
          { status: 422 },
        ),
      ),
    );
    renderUsers();
    const row = await rowOf('admin2');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await findModal('Edit admin2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('An admin cannot remove their own ADMIN role'),
    ).toBeInTheDocument();
  });
});

describe('UsersPage lock, unlock, reset', () => {
  it('locks another user after a confirmation', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), listedDoctor]);
    renderUsers();
    const row = await rowOf('doctor');

    await user.click(within(row).getByRole('button', { name: 'Lock' }));
    const confirm = await findModal('Lock doctor?');
    expect(within(confirm).getByText(/within 15 minutes/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Lock' }));

    expect(await screen.findByText('doctor is locked')).toBeInTheDocument();
    expect(b.bodies.at(-1)).toMatchObject({
      method: 'POST',
      path: `/admin/users/${listedDoctor.id}/lock`,
    });
    const updated = await rowOf('doctor');
    expect(await within(updated).findByText('Locked')).toBeInTheDocument();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), listedDoctor]);
    renderUsers();
    const row = await rowOf('doctor');

    await user.click(within(row).getByRole('button', { name: 'Lock' }));
    const confirm = await findModal('Lock doctor?');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(b.bodies).toEqual([]);
  });

  it('shows the lock as pending until the server answers', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    usersBackend([adminUser(), listedDoctor]);
    server.use(
      mock.post(`${API}/admin/users/:id/lock`, async () => {
        await gate;
        return HttpResponse.json({ ...listedDoctor, status: 'LOCKED' });
      }),
    );
    renderUsers();
    const row = await rowOf('doctor');
    await user.click(within(row).getByRole('button', { name: 'Lock' }));
    const confirm = await findModal('Lock doctor?');
    const ok = within(confirm).getByRole('button', { name: 'Lock' });
    await user.click(ok);

    await waitFor(() => expect(ok.className).toContain('ant-btn-loading'));
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    release();
    expect(await screen.findByText('doctor is locked')).toBeInTheDocument();
  });

  it('disables locking oneself, with the reason as the button description', async () => {
    usersBackend([adminUser(), secondAdmin]);
    renderUsers();
    const row = await rowOf('admin');

    const lock = within(row).getByRole('button', { name: 'Lock' });
    expect(lock).toBeDisabled();
    expect(lock).toHaveAccessibleDescription('You cannot lock your own account.');
  });

  it('disables locking the last active admin', async () => {
    const b = usersBackend([adminUser(), secondAdmin]);
    b.activeAdmins = 1;
    renderUsers();
    const row = await rowOf('admin2');

    const lock = within(row).getByRole('button', { name: 'Lock' });
    await waitFor(() => expect(lock).toBeDisabled());
    expect(lock).toHaveAccessibleDescription('The last active admin cannot be locked.');
  });

  it('lets an admin lock another admin while another one stays active', async () => {
    usersBackend([adminUser(), secondAdmin]);
    renderUsers();
    const row = await rowOf('admin2');
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Lock' })).toBeEnabled());
  });

  it('shows the server refusal (409) and reads the list again', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), secondAdmin]);
    server.use(
      mock.post(`${API}/admin/users/:id/lock`, () =>
        HttpResponse.json(
          { status: 409, title: 'Conflict', detail: 'At least one active admin must remain' },
          { status: 409 },
        ),
      ),
    );
    renderUsers();
    const row = await rowOf('admin2');
    const before = b.listUrls.length;
    await user.click(within(row).getByRole('button', { name: 'Lock' }));
    await user.click(within(await findModal('Lock admin2?')).getByRole('button', { name: 'Lock' }));

    expect(await screen.findByText('At least one active admin must remain')).toBeInTheDocument();
    await waitFor(() => expect(b.listUrls.length).toBeGreaterThan(before));
  });

  it('unlocks a locked user after a confirmation', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), { ...listedDoctor, status: 'LOCKED' }]);
    renderUsers();
    const row = await rowOf('doctor');

    await user.click(within(row).getByRole('button', { name: 'Unlock' }));
    const confirm = await findModal('Unlock doctor?');
    await user.click(within(confirm).getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('doctor is unlocked')).toBeInTheDocument();
    expect(b.bodies.at(-1)).toMatchObject({ path: `/admin/users/${listedDoctor.id}/unlock` });
  });

  it('resets a password after a confirmation and shows the temporary one once', async () => {
    const user = userEvent.setup();
    const b = usersBackend([adminUser(), listedDoctor]);
    renderUsers();
    const row = await rowOf('doctor');

    await user.click(within(row).getByRole('button', { name: 'Reset password' }));
    const confirm = await findModal('Reset the password of doctor?');
    expect(within(confirm).getByText(/must change it at their next sign-in/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Reset password' }));

    const temp = await findModal('Temporary password');
    expect(within(temp).getByText('New temporary password of doctor:')).toBeInTheDocument();
    expect(within(temp).getByLabelText('Temporary password')).toHaveValue('Reset-4Kd8-Pw3z');
    expect(b.bodies.at(-1)).toMatchObject({
      path: `/admin/users/${listedDoctor.id}/reset-password`,
    });
    await user.click(within(temp).getByRole('button', { name: 'I have noted it' }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('Reset-4Kd8-Pw3z')).not.toBeInTheDocument(),
    );
  });

  it('points an admin to the account page instead of resetting their own password', async () => {
    usersBackend([adminUser(), secondAdmin]);
    renderUsers();
    const row = await rowOf('admin');
    const reset = within(row).getByRole('button', { name: 'Reset password' });
    expect(reset).toBeDisabled();
    expect(reset).toHaveAccessibleDescription(
      'Change your own password from the account menu instead.',
    );
  });
});
