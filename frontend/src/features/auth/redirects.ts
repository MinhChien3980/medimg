/** The page where the user changes their password (and is kept while a change is required). */
export const CHANGE_PASSWORD_PATH = '/account/password';

/** Landing page after sign-in, for every role. */
export const HOME_PATH = '/dashboard';

/**
 * Where to go after signing in or after a required password change: the remembered in-app path,
 * never the login or password page itself (nor `//host` URLs), otherwise the dashboard.
 */
export function returnTarget(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const from = state.from;
    if (
      typeof from === 'string' &&
      from.startsWith('/') &&
      !from.startsWith('//') &&
      from !== '/' &&
      !from.startsWith('/login') &&
      !from.startsWith(CHANGE_PASSWORD_PATH)
    ) {
      return from;
    }
  }
  return HOME_PATH;
}
