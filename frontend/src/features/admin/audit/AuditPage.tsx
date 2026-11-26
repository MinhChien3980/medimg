import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Select,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { auditApi } from '@/api/endpoints';
import { errorMessage } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type { AuditEntryDto, AuditOutcome, AuditQuery } from '@/api/types';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { checkRange, parseDay, toDay } from '@/shared/lib/dateRange';
import { downloadBlob, formatDateTime } from '@/shared/lib/format';
import {
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_ENTITY_TYPES,
  AUDIT_MAX_DAYS,
  AUDIT_OUTCOMES,
  AUDIT_PAGE_SIZES,
  auditStateFromParams,
  prettyDetail,
} from './auditFilters';

interface FilterForm {
  period: [Dayjs | null, Dayjs | null] | null;
  username?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  outcome?: AuditOutcome;
}

function formValues(filters: AuditQuery): FilterForm {
  return {
    period: [parseDay(filters.from), parseDay(filters.to)],
    username: filters.username,
    action: filters.action,
    entityType: filters.entityType,
    entityId: filters.entityId,
    outcome: filters.outcome,
  };
}

function EntryDetail({ entry }: { entry: AuditEntryDto }) {
  const { t } = useTranslation();
  const detail = prettyDetail(entry.detail);
  return (
    <Descriptions size="small" column={1} bordered>
      <Descriptions.Item label={t('admin.audit.detail.userId')}>
        {entry.userId ?? t('common.none')}
      </Descriptions.Item>
      <Descriptions.Item label={t('admin.audit.detail.userAgent')}>
        {entry.userAgent ?? t('common.none')}
      </Descriptions.Item>
      <Descriptions.Item label={t('admin.audit.detail.detail')}>
        {detail ? (
          <pre className="audit-detail" data-testid="audit-detail">
            {detail}
          </pre>
        ) : (
          <Typography.Text type="secondary">{t('admin.audit.detail.none')}</Typography.Text>
        )}
      </Descriptions.Item>
    </Descriptions>
  );
}

/**
 * `/admin/audit` (ADMIN): the audit log over a period of at most 93 days (default: the last 7),
 * filtered by user, action, entity and outcome, with a JSON detail per row and a CSV export of the
 * same filters. Filters are applied with the button and kept in the address.
 */
export default function AuditPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { message } = App.useApp();
  const [params, setParams] = useSearchParams();
  const state = auditStateFromParams(params);
  const { filters, page, size } = state;
  const [form] = Form.useForm<FilterForm>();

  // The form follows the address (back / forward, reset).
  const paramsKey = params.toString();
  useEffect(() => {
    form.setFieldsValue(formValues(auditStateFromParams(new URLSearchParams(paramsKey)).filters));
  }, [form, paramsKey]);

  // Actions recorded in the period being edited, for the dropdown.
  const draftPeriod = Form.useWatch('period', form);
  const draftFrom = draftPeriod?.[0] ? toDay(draftPeriod[0]) : filters.from;
  const draftTo = draftPeriod?.[1] ? toDay(draftPeriod[1]) : filters.to;
  const draftValid = checkRange({ from: draftFrom, to: draftTo }, AUDIT_MAX_DAYS) === null;
  const actions = useQuery({
    queryKey: queryKeys.admin.audit.actions(draftFrom, draftTo),
    queryFn: () => auditApi.actions(draftFrom, draftTo),
    enabled: draftValid,
    placeholderData: keepPreviousData,
  });

  const listQuery = { ...filters, page: page - 1, size };
  const list = useQuery({
    queryKey: queryKeys.admin.audit.list(listQuery),
    queryFn: () => auditApi.list(listQuery),
    placeholderData: keepPreviousData,
  });

  const exportCsv = useMutation({
    mutationFn: () => auditApi.exportCsv(filters),
    onSuccess: ({ blob, fileName }) => {
      const name = fileName ?? `audit-${filters.from}-${filters.to}.csv`;
      downloadBlob(blob, name);
      void message.success(t('admin.audit.exported', { name }));
    },
    onError: (error) =>
      void message.error(
        `${t('admin.audit.exportFailed')}: ${errorMessage(error, t('common.unexpectedError'))}`,
      ),
  });

  const apply = (values: FilterForm) => {
    const [from, to] = values.period ?? [null, null];
    const next = new URLSearchParams();
    const set = (key: string, value: string | undefined) => {
      const v = value?.trim();
      if (v) next.set(key, v);
    };
    set('from', from ? toDay(from) : undefined);
    set('to', to ? toDay(to) : undefined);
    set('username', values.username);
    set('action', values.action);
    set('entityType', values.entityType);
    set('entityId', values.entityId);
    set('outcome', values.outcome);
    if (size !== AUDIT_DEFAULT_PAGE_SIZE) next.set('size', String(size));
    setParams(next);
  };

  const today = dayjs().endOf('day');

  const columns: ColumnsType<AuditEntryDto> = [
    {
      title: t('admin.audit.columns.time'),
      dataIndex: 'occurredAt',
      width: 170,
      render: (v: string) => formatDateTime(v, lang),
    },
    {
      title: t('admin.audit.columns.user'),
      dataIndex: 'username',
      render: (v: string | null) => v ?? t('common.none'),
    },
    {
      title: t('admin.audit.columns.action'),
      dataIndex: 'action',
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: t('admin.audit.columns.entity'),
      key: 'entity',
      render: (_: unknown, e) =>
        e.entityType ? (
          <span>
            {e.entityType}
            {e.entityId && (
              <>
                {' '}
                <Typography.Text code copyable={{ text: e.entityId }}>
                  {e.entityId.length > 13 ? `${e.entityId.slice(0, 8)}…` : e.entityId}
                </Typography.Text>
              </>
            )}
          </span>
        ) : (
          t('common.none')
        ),
    },
    {
      title: t('admin.audit.columns.outcome'),
      dataIndex: 'outcome',
      render: (v: AuditOutcome | null) =>
        v ? (
          <Tag color={v === 'SUCCESS' ? 'green' : 'red'}>{t(`admin.audit.outcomes.${v}`)}</Tag>
        ) : (
          t('common.none')
        ),
    },
    {
      title: t('admin.audit.columns.ip'),
      dataIndex: 'clientIp',
      render: (v: string | null) => v ?? t('common.none'),
    },
  ];

  return (
    <div className="page">
      <div className="page__header">
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('admin.audit.title')}
        </Typography.Title>
        <Button
          icon={<DownloadOutlined aria-hidden />}
          loading={exportCsv.isPending}
          onClick={() => exportCsv.mutate()}
        >
          {t('admin.audit.export')}
        </Button>
      </div>

      {state.invalidRange && (
        <Alert
          type="warning"
          showIcon
          title={t('admin.audit.rangeInvalid')}
          style={{ marginBottom: 16 }}
        />
      )}

      <Form<FilterForm>
        form={form}
        layout="inline"
        className="admin-filters"
        role="search"
        onFinish={apply}
        initialValues={formValues(filters)}
      >
        <Form.Item
          name="period"
          label={t('admin.audit.period')}
          rules={[
            {
              validator: (_rule, value: FilterForm['period']) => {
                const [from, to] = value ?? [null, null];
                if (!from || !to) return Promise.reject(new Error(t('admin.audit.rangeRequired')));
                const problem = checkRange({ from: toDay(from), to: toDay(to) }, AUDIT_MAX_DAYS);
                return problem === 'tooLong'
                  ? Promise.reject(
                      new Error(t('admin.audit.rangeTooLong', { max: AUDIT_MAX_DAYS })),
                    )
                  : problem
                    ? Promise.reject(new Error(t('admin.audit.rangeRequired')))
                    : Promise.resolve();
              },
            },
          ]}
        >
          <DatePicker.RangePicker
            allowClear={false}
            format="DD/MM/YYYY"
            disabledDate={(current, info) => {
              if (current.isAfter(today)) return true;
              const from = info.from;
              return !!from && Math.abs(current.diff(from, 'day')) >= AUDIT_MAX_DAYS;
            }}
          />
        </Form.Item>
        <Form.Item name="username" label={t('admin.audit.username')}>
          <Input allowClear style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="action" label={t('admin.audit.action')}>
          <Select
            allowClear
            showSearch
            placeholder={t('admin.audit.allActions')}
            loading={actions.isFetching}
            style={{ width: 220 }}
            options={(actions.data ?? []).map((a) => ({ value: a, label: a }))}
          />
        </Form.Item>
        <Form.Item name="entityType" label={t('admin.audit.entityType')}>
          <AutoComplete
            allowClear
            style={{ width: 160 }}
            options={AUDIT_ENTITY_TYPES.map((v) => ({ value: v }))}
            showSearch={{
              filterOption: (input, option) =>
                String(option?.value ?? '')
                  .toUpperCase()
                  .includes(input.toUpperCase()),
            }}
          />
        </Form.Item>
        <Form.Item name="entityId" label={t('admin.audit.entityId')}>
          <Input allowClear style={{ width: 200 }} />
        </Form.Item>
        <Form.Item name="outcome" label={t('admin.audit.outcome')}>
          <Select
            allowClear
            placeholder={t('admin.audit.allOutcomes')}
            style={{ width: 150 }}
            options={AUDIT_OUTCOMES.map((o) => ({
              value: o,
              label: t(`admin.audit.outcomes.${o}`),
            }))}
          />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" icon={<SearchOutlined aria-hidden />}>
            {t('admin.audit.apply')}
          </Button>
        </Form.Item>
        <Form.Item>
          <Button onClick={() => setParams(new URLSearchParams())}>{t('admin.audit.reset')}</Button>
        </Form.Item>
      </Form>

      {list.isError && (
        <ProblemAlert
          error={list.error}
          onRetry={() => void list.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      <Table<AuditEntryDto>
        rowKey={(e) => String(e.id)}
        size="small"
        columns={columns}
        dataSource={list.data?.content ?? []}
        loading={list.isFetching}
        scroll={{ x: 900 }}
        locale={{ emptyText: t('admin.audit.empty') }}
        expandable={{ expandedRowRender: (entry) => <EntryDetail entry={entry} /> }}
        pagination={{
          current: page,
          pageSize: size,
          total: list.data?.totalElements ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [...AUDIT_PAGE_SIZES],
          showTotal: (total) => t('admin.audit.total', { count: total }),
          onChange: (nextPage, nextSize) => {
            const next = new URLSearchParams(params);
            if (nextSize !== size || nextPage === 1) next.delete('page');
            else next.set('page', String(nextPage));
            if (nextSize === AUDIT_DEFAULT_PAGE_SIZE) next.delete('size');
            else next.set('size', String(nextSize));
            setParams(next);
          },
        }}
      />
    </div>
  );
}
