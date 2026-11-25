import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import type { FindingDto, MeshArtifact, Uuid } from '@/api/types';
import {
  FindingReviewActions,
  ReviewDetails,
  ReviewStatusTag,
  UnreviewedFilter,
} from '@/features/review/FindingReview';
import { isUnreviewed } from '@/features/review/reviewModel';
import { formatVolumeMl } from '@/shared/lib/format';
import { useStructureName } from './structureNames';

interface StructuresTableProps {
  studyId: Uuid;
  findings: readonly FindingDto[];
  meshes: readonly MeshArtifact[];
}

interface Row {
  label: string;
  volumeMl: number | null;
  color: string | null;
  finding: FindingDto;
}

/** Segmented structures with their volume, largest first, and the doctor's review of each. */
export function StructuresTable({ studyId, findings, meshes }: StructuresTableProps) {
  const { t, i18n } = useTranslation();
  const name = useStructureName();
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const colors = new Map(meshes.map((m) => [m.label, m.color]));
  const rows: Row[] = findings
    .filter((f) => !unreviewedOnly || isUnreviewed(f))
    .map((f) => ({
      label: f.label,
      volumeMl: f.volumeMl,
      color: colors.get(f.label) ?? null,
      finding: f,
    }))
    .sort((a, b) => (b.volumeMl ?? 0) - (a.volumeMl ?? 0));

  const columns: ColumnsType<Row> = [
    {
      title: t('ai.structure'),
      dataIndex: 'label',
      render: (label: string, row) => (
        <span className="structure-name">
          {row.color && (
            <span className="structure-swatch" style={{ background: row.color }} aria-hidden />
          )}
          {name(label)}
        </span>
      ),
    },
    {
      title: t('ai.volume'),
      dataIndex: 'volumeMl',
      align: 'right',
      render: (ml: number | null) =>
        ml == null ? t('common.none') : formatVolumeMl(ml, i18n.language),
    },
    {
      title: t('review.column'),
      key: 'review',
      render: (_, row) => (
        <div className="review-cell">
          <ReviewStatusTag finding={row.finding} />
          <FindingReviewActions studyId={studyId} finding={row.finding} name={name(row.label)} />
          <ReviewDetails finding={row.finding} />
        </div>
      ),
    },
  ];

  return (
    <>
      <UnreviewedFilter findings={findings} checked={unreviewedOnly} onChange={setUnreviewedOnly} />
      <Table<Row>
        size="small"
        rowKey="label"
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: t(unreviewedOnly ? 'review.allReviewed' : 'ai.noStructures') }}
      />
    </>
  );
}
