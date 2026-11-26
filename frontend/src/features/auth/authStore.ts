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
 * - `sessionExpired` and `passwordChangedSignIn` (memory only) tell the login page why the user
 *   was sent back to it.
 */
export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: UserDto | null;
  sessionExpired: boolean;
  passwordChangedSignIn: boolean;
  setSession: (tokens: TokenResponse) => void;
  /** Explicit logout. */
  clear: () => void;
  /** The server rejected the refresh token. */
  expire: () => void;
  /** An API answered 403 `password-change-required`: every route leads to the password page. */
  requirePasswordChange: () => void;
  /** `POST /me/password` succeeded. */
  passwordChanged: () => void;
  /** The password was changed but the session could not be renewed: sign in again. */
  signOutAfterPasswordChange: () => void;
}

export const AUTH_STORAGE_KEY = 'medimg.auth';

const SIGNED_OUT = { accessToken: null, refreshToken: null, user: null } as const;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      sessionExpired: false,
      passwordChangedSignIn: false,
      setSession: (tokens) =>
        set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user: tokens.user,
          sessionExpired: false,
          passwordChangedSignIn: false,
        }),
      clear: () => set({ ...SIGNED_OUT, sessionExpired: false, passwordChangedSignIn: false }),
      expire: () => set({ ...SIGNED_OUT, sessionExpired: true, passwordChangedSignIn: false }),
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
        set({ ...SIGNED_OUT, sessionExpired: false, passwordChangedSignIn: true }),
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
