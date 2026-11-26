import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import ChangePasswordPage from '@/features/account/ChangePasswordPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { RequirePermission } from '@/features/auth/RequirePermission';
import LoginPage from '@/features/auth/LoginPage';
import CaseDetailPage from '@/features/cases/CaseDetailPage';
import CasesListPage from '@/features/cases/CasesListPage';
import AppLayout from '@/features/layout/AppLayout';
import SamplesPage from '@/features/samples/SamplesPage';
import NotFoundPage from '@/shared/components/NotFoundPage';
import RouteErrorPage from '@/shared/components/RouteErrorPage';
import {
  AdminAuditRoute,
  AdminModelsRoute,
  AdminUsersRoute,
  DashboardRoute,
  ReportRoute,
  UploadWizardRoute,
  ViewerRoute,
} from './lazyPages';

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
      // The dashboard is the landing page of every role.
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardRoute /> },
      { path: 'account/password', element: <ChangePasswordPage /> },
      { path: 'cases', element: <CasesListPage /> },
      { path: 'cases/:caseId', element: <CaseDetailPage /> },
      { path: 'samples', element: <SamplesPage /> },
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
      { path: 'studies/:studyId/report', element: <ReportRoute /> },
      { path: 'admin', element: <Navigate to="/admin/users" replace /> },
      { path: 'admin/users', element: <AdminUsersRoute /> },
      { path: 'admin/models', element: <AdminModelsRoute /> },
      { path: 'admin/audit', element: <AdminAuditRoute /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
