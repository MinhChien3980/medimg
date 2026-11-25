import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import type { FindingDto } from '@/api/types';
import { formatPercent } from '@/shared/lib/format';
import { sortFindings } from './findings';

interface FindingsTableProps {
  findings: FindingDto[];
  /** 0..1 */
  threshold: number;
  heatmaps: Record<string, string>;
  visibleHeatmaps: readonly string[];
  onToggleHeatmap: (label: string) => void;
}

export function ConfidenceBar({ value, threshold }: { value: number; threshold: number }) {
  const above = value >= threshold;
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="confidence">
      <div
        className="confidence__track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className={`confidence__fill${above ? ' confidence__fill--above' : ''}`}
          style={{ width: `${pct}%` }}
        />
        <div
          className="confidence__threshold"
          style={{ left: `${threshold * 100}%` }}
          data-testid="threshold-line"
        />
      </div>
      <span className={`confidence__value${above ? ' confidence__value--above' : ''}`}>
        {formatPercent(value)}
      </span>
    </div>
  );
}

export function FindingsTable({
  findings,
  threshold,
  heatmaps,
  visibleHeatmaps,
  onToggleHeatmap,
}: FindingsTableProps) {
  const { t } = useTranslation();
  const rows = sortFindings(findings);

  const columns: ColumnsType<FindingDto> = [
    {
      title: t('ai.label'),
      dataIndex: 'label',
      render: (label: string, f) => {
        const hasHeatmap = !!heatmaps[label];
        const strong = f.confidence >= threshold;
        if (!hasHeatmap) {
          return (
            <Tooltip title={t('ai.noHeatmap')}>
              <Typography.Text strong={strong} type={strong ? undefined : 'secondary'}>
                {label}
              </Typography.Text>
            </Tooltip>
          );
        }
        const visible = visibleHeatmaps.includes(label);
        return (
          <Tooltip title={t('ai.toggleHeatmap')}>
            <Button
              type="link"
              size="small"
              className="finding-toggle"
              aria-pressed={visible}
              icon={visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
              onClick={() => onToggleHeatmap(label)}
            >
              <span style={{ fontWeight: strong ? 600 : 400 }}>{label}</span>
            </Button>
          </Tooltip>
        );
      },
    },
    {
      title: t('ai.confidence'),
      dataIndex: 'confidence',
      width: '55%',
      render: (v: number) => <ConfidenceBar value={v} threshold={threshold} />,
    },
  ];

  return (
    <div className="findings">
      <Typography.Text type="secondary" className="findings__legend">
        <span className="findings__legend-line" aria-hidden />
        {t('ai.thresholdLegend', { value: Math.round(threshold * 100) })}
      </Typography.Text>
      <Table<FindingDto>
        size="small"
        rowKey={(f) => f.id || f.label}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: t('ai.noFindings') }}
        rowClassName={(f) => (f.confidence >= threshold ? 'finding-row--above' : '')}
      />
    </div>
  );
}
