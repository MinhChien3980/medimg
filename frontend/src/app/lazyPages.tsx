import { Spin } from 'antd';
import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

// Heavy / later-slice screens are code-split. The viewer will grow (Cornerstone3D, three.js).
const UploadWizardPage = lazy(() => import('@/features/upload/UploadWizardPage'));
const ViewerPage = lazy(() => import('@/features/viewer/ViewerPage'));
const ReportPage = lazy(() => import('@/features/reports/ReportPage'));

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
