import { Spin } from 'antd';
import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RequirePermission } from '@/features/auth/RequirePermission';

// Heavy / later-slice screens are code-split. The viewer will grow (Cornerstone3D, three.js).
const UploadWizardPage = lazy(() => import('@/features/upload/UploadWizardPage'));
const ViewerPage = lazy(() => import('@/features/viewer/ViewerPage'));
const ReportPage = lazy(() => import('@/features/reports/ReportPage'));
// Administration (admins only): its chunks are only fetched once the permission check passed.
const UsersPage = lazy(() => import('@/features/admin/users/UsersPage'));
const ModelsPage = lazy(() => import('@/features/admin/models/ModelsPage'));
const AuditPage = lazy(() => import('@/features/admin/audit/AuditPage'));

function Lazy({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <div className="route-loading" role="status" aria-label={t('common.loading')}>
          <Spin size="large" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export function UploadWizardRoute() {
  return (
    <Lazy>
      <UploadWizardPage />
    </Lazy>
  );
}

export function ReportRoute() {
  return (
    <Lazy>
      <ReportPage />
    </Lazy>
  );
}

export function ViewerRoute() {
  return (
    <Lazy>
      <ViewerPage />
    </Lazy>
  );
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <RequirePermission permission="administer" body={t('errors.adminOnlyBody')}>
      <Lazy>{children}</Lazy>
    </RequirePermission>
  );
}

export function AdminUsersRoute() {
  return (
    <RequireAdmin>
      <UsersPage />
    </RequireAdmin>
  );
}

export function AdminModelsRoute() {
  return (
    <RequireAdmin>
      <ModelsPage />
    </RequireAdmin>
  );
}

export function AdminAuditRoute() {
  return (
    <RequireAdmin>
      <AuditPage />
    </RequireAdmin>
  );
}
