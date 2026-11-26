import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { selectIsAuthenticated, selectPasswordChangeRequired, useAuthStore } from './authStore';
import { CHANGE_PASSWORD_PATH } from './redirects';

/**
 * Redirects to /login (remembering the target) when there is no session, and to the password
 * page while the user must replace a temporary password (flag from the login response, or set by
 * any API's 403 `password-change-required`), remembering the target too.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const mustChangePassword = useAuthStore(selectPasswordChangeRequired);
  const location = useLocation();
  const from = location.pathname + location.search;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from }} />;
  }
  if (mustChangePassword && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace state={{ from }} />;
  }
  return children;
}
