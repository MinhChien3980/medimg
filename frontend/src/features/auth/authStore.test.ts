import { describe, expect, it } from 'vitest';
import { tokens, doctor } from '@/test/fixtures';
import { AUTH_STORAGE_KEY, primaryRole, selectIsAuthenticated, useAuthStore } from './authStore';

describe('authStore', () => {
  it('starts logged out', () => {
    const s = useAuthStore.getState();
    expect(s.accessToken).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(selectIsAuthenticated(s)).toBe(false);
  });

  it('setSession stores tokens and user', () => {
    useAuthStore.getState().setSession(tokens('acc-1', 'ref-1'));
    const s = useAuthStore.getState();
    expect(s.accessToken).toBe('acc-1');
    expect(s.refreshToken).toBe('ref-1');
    expect(s.user).toEqual(doctor);
    expect(selectIsAuthenticated(s)).toBe(true);
  });

  it('persists refresh token and user but never the access token', () => {
    useAuthStore.getState().setSession(tokens('acc-secret', 'ref-1'));
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw ?? '{}') as { state: Record<string, unknown> };
    expect(persisted.state.refreshToken).toBe('ref-1');
    expect(persisted.state.user).toEqual(doctor);
    expect(persisted.state).not.toHaveProperty('accessToken');
    expect(raw).not.toContain('acc-secret');
  });

  it('clear() logs out', () => {
    useAuthStore.getState().setSession(tokens('a', 'r'));
    useAuthStore.getState().clear();
    const s = useAuthStore.getState();
    expect(s.accessToken).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.user).toBeNull();
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      state: { refreshToken: null, user: null },
    });
  });

  it('expire() logs out and flags the session as expired until the next sign-in', () => {
    useAuthStore.getState().setSession(tokens('a', 'r'));
    useAuthStore.getState().expire();
    let s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.sessionExpired).toBe(true);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toContain('sessionExpired');

    useAuthStore.getState().setSession(tokens('b', 'r2'));
    s = useAuthStore.getState();
    expect(s.sessionExpired).toBe(false);
  });

  it('primaryRole picks the highest-privilege role', () => {
    expect(primaryRole(null)).toBeNull();
    expect(primaryRole({ ...doctor, roles: ['RESEARCHER', 'ADMIN'] })).toBe('ADMIN');
    expect(primaryRole({ ...doctor, roles: ['TECHNICIAN'] })).toBe('TECHNICIAN');
  });

  it('requirePasswordChange / passwordChanged toggle the flag of the signed-in user only', () => {
    useAuthStore.getState().requirePasswordChange();
    expect(useAuthStore.getState().user).toBeNull();

    useAuthStore.getState().setSession(tokens('a', 'r'));
    useAuthStore.getState().requirePasswordChange();
    expect(useAuthStore.getState().user?.passwordChangeRequired).toBe(true);
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      state: { user: { passwordChangeRequired: true } },
    });

    useAuthStore.getState().passwordChanged();
    expect(useAuthStore.getState().user?.passwordChangeRequired).toBe(false);
    expect(useAuthStore.getState().accessToken).toBe('a');
  });

  it('signOutAfterPasswordChange ends the session and tells the login page why', () => {
    useAuthStore.getState().setSession(tokens('a', 'r'));
    useAuthStore.getState().expire();
    useAuthStore.getState().signOutAfterPasswordChange();
    let s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.passwordChangedSignIn).toBe(true);
    expect(s.sessionExpired).toBe(false);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toContain('passwordChangedSignIn');

    useAuthStore.getState().setSession(tokens('b', 'r2'));
    s = useAuthStore.getState();
    expect(s.passwordChangedSignIn).toBe(false);
  });

  it('revoke() ends a session the server ended, and tells the login page why', () => {
    useAuthStore.getState().setSession(tokens('a', 'r'));
    useAuthStore.getState().revoke();
    let s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.accessToken).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.sessionRevoked).toBe(true);
    expect(s.sessionExpired).toBe(false);
    expect(s.passwordChangedSignIn).toBe(false);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toContain('sessionRevoked');

    useAuthStore.getState().setSession(tokens('b', 'r2'));
    s = useAuthStore.getState();
    expect(s.sessionRevoked).toBe(false);

    useAuthStore.getState().revoke();
    useAuthStore.getState().expire();
    expect(useAuthStore.getState().sessionRevoked).toBe(false);
  });
});
