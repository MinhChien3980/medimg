import { FileTextOutlined } from '@ant-design/icons';
import { Skeleton, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Uuid } from '@/api/types';
import { useCan } from '@/features/auth/permissions';
import { formatDateTime } from '@/shared/lib/format';
import { useStudyReports } from './hooks';
import { visibleReports } from './reportModel';
import { ReportStatusTag } from './ReportStatusTag';

/** Report status of one study on the case page: latest visible version, with a link to it. */
export function StudyReportStatus({ studyId }: { studyId: Uuid }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const reports = useStudyReports(studyId);

  if (reports.isPending) return <Skeleton.Input active size="small" />;
  if (reports.isError)
    return <Typography.Text type="danger">{t('reports.loadError')}</Typography.Text>;

  const latest = visibleReports(reports.data, can('viewDraftReport'))[0];
  const path = `/studies/${studyId}/report`;
  return (
    <span className="study-report" data-testid={`study-report-${studyId}`}>
      <span className="study-report__label">{t('reports.short')}:</span>
      {latest ? (
        <>
          <ReportStatusTag report={latest} />
          {latest.signedAt && (
            <Typography.Text type="secondary" className="study-report__time">
              {formatDateTime(latest.signedAt, i18n.language)}
            </Typography.Text>
          )}
          <Link to={path}>
            <FileTextOutlined /> {t('reports.open')}
          </Link>
        </>
      ) : (
        <>
          <Tag>{t('reports.status.none')}</Tag>
          {can('report') && (
            <Link to={path}>
              <FileTextOutlined /> {t('reports.write')}
            </Link>
          )}
        </>
      )}
    </span>
  );
}
