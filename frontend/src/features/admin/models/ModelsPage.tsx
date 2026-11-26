import { PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminModelsApi } from '@/api/endpoints';
import { errorMessage } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type { AdminModelDto, InputType, ModelStatus, ModelTask } from '@/api/types';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { formatDateTime, formatDurationMs, formatNumber } from '@/shared/lib/format';

type Pending = { model: AdminModelDto; enable: boolean };

const STATUS_COLORS: Record<ModelStatus, string> = {
  ACTIVE: 'green',
  DISABLED: 'default',
  STAGING: 'gold',
  RETIRED: 'default',
};

/** The DICOM modalities a model takes (`CR,DX`); none listed when it takes any. */
function modalitiesOf(m: AdminModelDto): string[] {
  return (m.modality ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** A muted dash for a model the server does not switch, with the reason for every user. */
function NoSwitch({ reason }: { reason: string }) {
  return (
    <Tooltip title={reason}>
      {/* Focusable, so the tooltip also opens from the keyboard. */}
      <span tabIndex={0}>
        <Typography.Text type="secondary" aria-hidden>
          —
        </Typography.Text>
        <span className="sr-only">{reason}</span>
      </span>
    </Tooltip>
  );
}

/**
 * `/admin/models` (ADMIN): every model with its job statistics; enable / disable after a
 * confirmation. A disabled model disappears from `GET /models`, hence from the AI panel. Models in
 * staging or retired are listed but cannot be switched here.
 */
export default function ModelsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);

  const list = useQuery({ queryKey: queryKeys.admin.models, queryFn: adminModelsApi.list });

  const toggle = useMutation({
    mutationFn: ({ model, enable }: Pending) =>
      enable ? adminModelsApi.enable(model.id) : adminModelsApi.disable(model.id),
    onSuccess: (model, { enable }) => {
      setPending(null);
      queryClient.setQueryData<AdminModelDto[]>(queryKeys.admin.models, (old) =>
        old?.map((m) => (m.id === model.id ? model : m)),
      );
      void message.success(
        t(enable ? 'admin.models.done.enabled' : 'admin.models.done.disabled', {
          name: model.name,
        }),
      );
    },
    onError: (error) => {
      setPending(null);
      void message.error(errorMessage(error, t('common.unexpectedError')));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.models });
      // The AI panel's model lists (`GET /models?inputType=…`) change with the status.
      void queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const n = (v: number) => formatNumber(v, lang);
  const columns: ColumnsType<AdminModelDto> = [
    {
      title: t('admin.models.columns.model'),
      dataIndex: 'name',
      render: (name: string, m) => (
        <div>
          <Typography.Text strong>{name}</Typography.Text>
          <div>
            <Typography.Text type="secondary" code>
              {m.code}@{m.version}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: t('admin.models.columns.task'),
      dataIndex: 'task',
      render: (task: ModelTask) => t(`admin.models.tasks.${task}`),
    },
    {
      title: t('admin.models.columns.inputs'),
      dataIndex: 'inputTypes',
      render: (types: InputType[], m) => (
        <Space size={[4, 4]} wrap>
          {modalitiesOf(m).map((modality) => (
            <Tag key={modality}>{modality}</Tag>
          ))}
          {types.map((type) => (
            <Tag key={type} color="geekblue">
              {t(`caseDetail.inputTypes.${type}`)}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('admin.models.columns.status'),
      dataIndex: 'status',
      render: (s: ModelStatus) => (
        <Tag color={STATUS_COLORS[s]}>{t(`admin.models.statuses.${s}`)}</Tag>
      ),
    },
    {
      title: t('admin.models.columns.jobs'),
      key: 'jobs',
      align: 'right',
      render: (_: unknown, m) => n(m.stats.jobs),
    },
    {
      title: t('admin.models.columns.done'),
      key: 'done',
      align: 'right',
      render: (_: unknown, m) => n(m.stats.done),
    },
    {
      title: t('admin.models.columns.failed'),
      key: 'failed',
      align: 'right',
      render: (_: unknown, m) =>
        m.stats.failed > 0 ? (
          <Typography.Text type="danger">{n(m.stats.failed)}</Typography.Text>
        ) : (
          n(0)
        ),
    },
    {
      title: t('admin.models.columns.avg'),
      key: 'avg',
      align: 'right',
      render: (_: unknown, m) => formatDurationMs(m.stats.avgInferenceMs, lang),
    },
    {
      title: t('admin.models.columns.p95'),
      key: 'p95',
      align: 'right',
      render: (_: unknown, m) => formatDurationMs(m.stats.p95InferenceMs, lang),
    },
    {
      title: t('admin.models.columns.lastUsed'),
      key: 'lastUsed',
      render: (_: unknown, m) => formatDateTime(m.stats.lastUsedAt, lang),
    },
    {
      title: t('admin.models.columns.actions'),
      key: 'actions',
      render: (_: unknown, m) => {
        if (m.status === 'STAGING') return <NoSwitch reason={t('admin.models.noSwitch.STAGING')} />;
        if (m.status === 'RETIRED') return <NoSwitch reason={t('admin.models.noSwitch.RETIRED')} />;
        return m.status === 'ACTIVE' ? (
          <Button
            size="small"
            danger
            icon={<PauseCircleOutlined aria-hidden />}
            onClick={() => setPending({ model: m, enable: false })}
          >
            {t('admin.models.disable')}
          </Button>
        ) : (
          <Button
            size="small"
            icon={<PlayCircleOutlined aria-hidden />}
            onClick={() => setPending({ model: m, enable: true })}
          >
            {t('admin.models.enable')}
          </Button>
        );
      },
    },
  ];

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('admin.models.title')}
          </Typography.Title>
          <Typography.Text type="secondary">{t('admin.models.subtitle')}</Typography.Text>
        </div>
      </div>

      {list.isError && (
        <ProblemAlert
          error={list.error}
          onRetry={() => void list.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      <Table<AdminModelDto>
        rowKey="id"
        columns={columns}
        dataSource={list.data ?? []}
        loading={list.isFetching}
        pagination={false}
        scroll={{ x: 1100 }}
        locale={{ emptyText: t('admin.models.empty') }}
      />

      <ConfirmDialog
        open={pending !== null}
        title={
          pending
            ? t(
                pending.enable
                  ? 'admin.models.confirm.enableTitle'
                  : 'admin.models.confirm.disableTitle',
                {
                  name: pending.model.name,
                },
              )
            : ''
        }
        okText={pending?.enable ? t('admin.models.enable') : t('admin.models.disable')}
        danger={pending?.enable === false}
        loading={toggle.isPending}
        onOk={() => pending && toggle.mutate(pending)}
        onCancel={() => setPending(null)}
      >
        {pending?.enable
          ? t('admin.models.confirm.enableBody')
          : t('admin.models.confirm.disableBody')}
      </ConfirmDialog>
    </div>
  );
}
