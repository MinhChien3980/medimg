import { isRouteErrorResponse, useRouteError } from 'react-router';
import NotFoundPage from './NotFoundPage';
import { ErrorFallback } from './ErrorBoundary';

/** `errorElement` for router-level errors (render errors inside routes, failed lazy chunks). */
export default function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorFallback message={message} onReload={() => window.location.reload()} />;
}
