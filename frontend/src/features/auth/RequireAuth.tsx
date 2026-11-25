import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { selectIsAuthenticated, useAuthStore } from './authStore';

/** Redirects to /login (remembering the target) when there is no session. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}
