import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, useLocation, type RouteObject } from 'react-router';
import { AppProviders } from '@/app/AppProviders';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/** Renders the current location so tests can assert navigation. */
export function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

interface RenderOptions {
  /** Initial URL. */
  route?: string;
  /** Route pattern for `ui` (default: the pathname of `route`). */
  path?: string;
  extraRoutes?: RouteObject[];
  queryClient?: QueryClient;
}

export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}) {
  const route = options.route ?? '/';
  const path = options.path ?? route.split('?')[0] ?? '/';
  const queryClient = options.queryClient ?? createTestQueryClient();
  const router = createMemoryRouter(
    [
      { path, element: ui },
      ...(options.extraRoutes ?? []),
      { path: '*', element: <LocationProbe /> },
    ],
    { initialEntries: [route] },
  );
  const result = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, router, queryClient };
}
