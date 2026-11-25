import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import type { FindingDto, MeshArtifact } from '@/api/types';
import { formatVolumeMl } from '@/shared/lib/format';
import { useStructureName } from './structureNames';

interface StructuresTableProps {
  findings: readonly FindingDto[];
  meshes: readonly MeshArtifact[];
}

interface Row {
  label: string;
  volumeMl: number | null;
  color: string | null;
}

/** Read-only list of segmented structures with their volume, largest first. */
export function StructuresTable({ findings, meshes }: StructuresTableProps) {
  const { t, i18n } = useTranslation();
  const name = useStructureName();
  const colors = new Map(meshes.map((m) => [m.label, m.color]));
  const rows: Row[] = findings
    .map((f) => ({ label: f.label, volumeMl: f.volumeMl, color: colors.get(f.label) ?? null }))
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
  ];

  return (
    <Table<Row>
      size="small"
      rowKey="label"
      columns={columns}
      dataSource={rows}
      pagination={false}
      locale={{ emptyText: t('ai.noStructures') }}
    />
  );
}
