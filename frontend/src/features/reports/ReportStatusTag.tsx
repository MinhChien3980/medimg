import { CheckCircleOutlined, EditOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ReportDto } from '@/api/types';

/** "Draft v2" / "Signed v1". */
export function ReportStatusTag({ report }: { report: Pick<ReportDto, 'status' | 'version'> }) {
  const { t } = useTranslation();
  const final = report.status === 'FINAL';
  return (
    <Tag
      color={final ? 'success' : 'warning'}
      icon={final ? <CheckCircleOutlined /> : <EditOutlined />}
      data-testid="report-status"
    >
      {t(final ? 'reports.status.FINAL' : 'reports.status.DRAFT', { version: report.version })}
    </Tag>
  );
}
