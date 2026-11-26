import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Role, TokenResponse, UserDto } from '@/api/types';

/**
 * Session state.
 *
 * Storage policy:
 * - `accessToken` (15 min) lives in memory only, so it is never written to disk and
 *   disappears on reload. After a reload the HTTP client obtains a new one from the
 *   refresh token before the first API call (see `api/http.ts`).
 * - `refreshToken` (7 days, rotated on every refresh) and `user` are persisted to
 *   localStorage so the session survives reloads and new tabs.
 * - `sessionExpired`, `sessionRevoked` and `passwordChangedSignIn` (memory only) tell the login
 *   page why the user was sent back to it.
 */
export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: UserDto | null;
  sessionExpired: boolean;
  sessionRevoked: boolean;
  passwordChangedSignIn: boolean;
  setSession: (tokens: TokenResponse) => void;
  /** Explicit logout. */
  clear: () => void;
  /** The server rejected the refresh token. */
  expire: () => void;
  /** The server ended the session (401 `session-revoked`: the account was locked). */
  revoke: () => void;
  /** An API answered 403 `password-change-required`: every route leads to the password page. */
  requirePasswordChange: () => void;
  /** `POST /me/password` succeeded. */
  passwordChanged: () => void;
  /** The password was changed but the session could not be renewed: sign in again. */
  signOutAfterPasswordChange: () => void;
}

export const AUTH_STORAGE_KEY = 'medimg.auth';

const SIGNED_OUT = { accessToken: null, refreshToken: null, user: null } as const;
const NO_SIGN_OUT_REASON = {
  sessionExpired: false,
  sessionRevoked: false,
  passwordChangedSignIn: false,
} as const;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      sessionExpired: false,
      sessionRevoked: false,
      passwordChangedSignIn: false,
      setSession: (tokens) =>
        set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user: tokens.user,
          ...NO_SIGN_OUT_REASON,
        }),
      clear: () => set({ ...SIGNED_OUT, ...NO_SIGN_OUT_REASON }),
      expire: () => set({ ...SIGNED_OUT, ...NO_SIGN_OUT_REASON, sessionExpired: true }),
      revoke: () => set({ ...SIGNED_OUT, ...NO_SIGN_OUT_REASON, sessionRevoked: true }),
      requirePasswordChange: () =>
        set((s) =>
          s.user && !s.user.passwordChangeRequired
            ? { user: { ...s.user, passwordChangeRequired: true } }
            : {},
        ),
      passwordChanged: () =>
        set((s) =>
          s.user?.passwordChangeRequired
            ? { user: { ...s.user, passwordChangeRequired: false } }
            : {},
        ),
      signOutAfterPasswordChange: () =>
        set({ ...SIGNED_OUT, ...NO_SIGN_OUT_REASON, passwordChangedSignIn: true }),
    }),
    {
      name: AUTH_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ refreshToken: state.refreshToken, user: state.user }),
    },
  ),
);

export const selectIsAuthenticated = (s: AuthState): boolean =>
  s.user !== null && s.refreshToken !== null;

/** The user must replace a temporary password before using anything else. */
export const selectPasswordChangeRequired = (s: AuthState): boolean =>
  s.user?.passwordChangeRequired === true;

/** Highest-privilege role, used for the header badge. */
export function primaryRole(user: UserDto | null): Role | null {
  if (!user || user.roles.length === 0) return null;
  const order: Role[] = ['ADMIN', 'DOCTOR', 'TECHNICIAN', 'RESEARCHER'];
  return order.find((r) => user.roles.includes(r)) ?? user.roles[0] ?? null;
}
