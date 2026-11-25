import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { RequirePermission } from '@/features/auth/RequirePermission';
import LoginPage from '@/features/auth/LoginPage';
import CaseDetailPage from '@/features/cases/CaseDetailPage';
import CasesListPage from '@/features/cases/CasesListPage';
import AppLayout from '@/features/layout/AppLayout';
import NotFoundPage from '@/shared/components/NotFoundPage';
import RouteErrorPage from '@/shared/components/RouteErrorPage';
import { UploadWizardRoute, ViewerRoute } from './lazyPages';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage />, errorElement: <RouteErrorPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/cases" replace /> },
      { path: 'cases', element: <CasesListPage /> },
      { path: 'cases/:caseId', element: <CaseDetailPage /> },
      {
        path: 'upload',
        element: (
          <RequirePermission permission="upload">
            <UploadWizardRoute />
          </RequirePermission>
        ),
      },
      // Lazy: keeps the canvas viewer (and later Cornerstone3D / three.js) out of the main chunk.
      { path: 'studies/:studyId', element: <ViewerRoute /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
