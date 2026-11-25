import { PlusOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { App, Button, Input, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { patientsApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import type { PatientDto } from '@/api/types';
import { useCan } from '@/features/auth/permissions';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { formatDateTime } from '@/shared/lib/format';
import { NewCaseModal } from './NewCaseModal';

const DEFAULT_PAGE_SIZE = 10;

function positiveInt(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export default function CasesListPage() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);

  // URL is the source of truth so back/forward and reload keep the search + page.
  const q = params.get('q') ?? '';
  const page = positiveInt(params.get('page'), 1);
  const size = positiveInt(params.get('size'), DEFAULT_PAGE_SIZE);
  const query = { q, page: page - 1, size };

  const list = useQuery({
    queryKey: queryKeys.patients.list(query),
    queryFn: () => patientsApi.list(query),
    placeholderData: keepPreviousData,
  });

  const update = (next: Record<string, string | number | undefined>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '') merged.delete(k);
      else merged.set(k, String(v));
    }
    setParams(merged);
  };

  const columns: ColumnsType<PatientDto> = [
    {
      title: t('cases.columns.code'),
      dataIndex: 'code',
      render: (code: string, record) => (
        <Link to={`/cases/${record.id}`} onClick={(e) => e.stopPropagation()}>
          <Typography.Text strong>{code}</Typography.Text>
        </Link>
      ),
    },
    {
      title: t('cases.columns.birthYear'),
      dataIndex: 'birthYear',
      width: 110,
      render: (v: number | null) => v ?? t('common.none'),
    },
    {
      title: t('cases.columns.sex'),
      dataIndex: 'sex',
      width: 100,
      render: (v: PatientDto['sex']) => (v ? t(`cases.sex.${v}`) : t('common.none')),
    },
    {
      title: t('cases.columns.studies'),
      dataIndex: 'studyCount',
      width: 110,
      align: 'right',
    },
    {
      title: t('cases.columns.createdAt'),
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => formatDateTime(v, i18n.language),
    },
    {
      title: t('cases.columns.note'),
      dataIndex: 'note',
      ellipsis: true,
      render: (v: string | null) => v ?? '',
    },
  ];

  return (
    <div className="page">
      <div className="page__header">
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('cases.title')}
        </Typography.Title>
        <div className="page__actions">
          <Input.Search
            allowClear
            defaultValue={q}
            placeholder={t('cases.searchPlaceholder')}
            onSearch={(value) => update({ q: value.trim(), page: undefined })}
            style={{ width: 300 }}
            aria-label={t('cases.searchPlaceholder')}
          />
          {can('createCase') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              {t('cases.newCase')}
            </Button>
          )}
        </div>
      </div>

      {list.isError && (
        <ProblemAlert
          error={list.error}
          onRetry={() => void list.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      <Table<PatientDto>
        rowKey="id"
        columns={columns}
        dataSource={list.data?.content ?? []}
        loading={list.isFetching}
        locale={{ emptyText: t('cases.empty') }}
        onRow={(record) => ({
          onClick: () => void navigate(`/cases/${record.id}`),
          style: { cursor: 'pointer' },
        })}
        pagination={{
          current: page,
          pageSize: size,
          total: list.data?.totalElements ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50],
          showTotal: (total) => t('cases.total', { count: total }),
          onChange: (nextPage, nextSize) =>
            update({
              page: nextSize !== size ? undefined : nextPage,
              size: nextSize === DEFAULT_PAGE_SIZE ? undefined : nextSize,
            }),
        }}
      />

      <NewCaseModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(patient) => {
          setCreating(false);
          void message.success(t('cases.created', { code: patient.code }));
          void navigate(`/cases/${patient.id}`);
        }}
      />
    </div>
  );
}
