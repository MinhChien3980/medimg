import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FindingDto, Uuid } from '@/api/types';
import {
  FindingReviewActions,
  ReviewDetails,
  ReviewStatusTag,
  UnreviewedFilter,
} from '@/features/review/FindingReview';
import { displayLabel, isUnreviewed } from '@/features/review/reviewModel';
import { formatPercent } from '@/shared/lib/format';
import { sortFindings } from './findings';

interface FindingsTableProps {
  studyId: Uuid;
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

/**
 * Findings of a classification run, most likely first: heatmap toggle, confidence against the
 * run's threshold, and the doctor's review (status, Accept / Edit / Reject, note).
 */
export function FindingsTable({
  studyId,
  findings,
  threshold,
  heatmaps,
  visibleHeatmaps,
  onToggleHeatmap,
}: FindingsTableProps) {
  const { t } = useTranslation();
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const rows = sortFindings(findings).filter((f) => !unreviewedOnly || isUnreviewed(f));

  const columns: ColumnsType<FindingDto> = [
    {
      title: t('ai.label'),
      dataIndex: 'label',
      render: (label: string, f) => {
        const hasHeatmap = !!heatmaps[label];
        const strong = (f.confidence ?? 0) >= threshold;
        const shown = displayLabel(f);
        if (!hasHeatmap) {
          return (
            <Tooltip title={t('ai.noHeatmap')}>
              <Typography.Text
                strong={strong}
                type={strong ? undefined : 'secondary'}
                delete={f.reviewStatus === 'REJECTED'}
              >
                {shown}
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
              <span
                style={{
                  fontWeight: strong ? 600 : 400,
                  textDecoration: f.reviewStatus === 'REJECTED' ? 'line-through' : undefined,
                }}
              >
                {shown}
              </span>
            </Button>
          </Tooltip>
        );
      },
    },
    {
      title: t('ai.confidence'),
      dataIndex: 'confidence',
      width: '38%',
      render: (v: number | null) => <ConfidenceBar value={v ?? 0} threshold={threshold} />,
    },
    {
      title: t('review.column'),
      key: 'review',
      render: (_, f) => (
        <div className="review-cell">
          <ReviewStatusTag finding={f} />
          <FindingReviewActions studyId={studyId} finding={f} />
          <ReviewDetails finding={f} />
        </div>
      ),
    },
  ];

  return (
    <div className="findings">
      <Typography.Text type="secondary" className="findings__legend">
        <span className="findings__legend-line" aria-hidden />
        {t('ai.thresholdLegend', { value: Math.round(threshold * 100) })}
      </Typography.Text>
      <UnreviewedFilter findings={findings} checked={unreviewedOnly} onChange={setUnreviewedOnly} />
      <Table<FindingDto>
        size="small"
        rowKey={(f) => f.id || f.label}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: t(unreviewedOnly ? 'review.allReviewed' : 'ai.noFindings') }}
        rowClassName={(f) => ((f.confidence ?? 0) >= threshold ? 'finding-row--above' : '')}
      />
    </div>
  );
}
