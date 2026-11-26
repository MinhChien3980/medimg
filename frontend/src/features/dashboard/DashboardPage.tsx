import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Card,
  DatePicker,
  Empty,
  Segmented,
  Skeleton,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { dashboardApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import type {
  DashboardDto,
  DashboardModelProcessing,
  DashboardRecentJob,
  InputType,
  PredictionStatus,
} from '@/api/types';
import { PredictionStatusTag } from '@/features/ai/PredictionStatusTag';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { parseDay, toDay } from '@/shared/lib/dateRange';
import {
  formatDateTime,
  formatDay,
  formatDurationMs,
  formatNumber,
  formatRate,
} from '@/shared/lib/format';
import {
  DASHBOARD_MAX_DAYS,
  DASHBOARD_PRESETS,
  isEmptyDashboard,
  periodFromParams,
  type DashboardPreset,
} from './dashboardRange';

// Recharts is only fetched with the first chart (one chunk for both).
const DailyChart = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.DailyChart })));
const LabelChart = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.LabelChart })));

type PresetChoice = `${DashboardPreset}` | 'custom';

function ChartFallback() {
  const { t } = useTranslation();
  return (
    <div
      className="dashboard-chart__loading"
      role="status"
      aria-label={t('dashboard.chartsLoading')}
    >
      <Spin />
    </div>
  );
}

/** A figure already formatted for the locale (Statistic would re-format "1.234" as a decimal). */
function Stat({ title, display }: { title: string; display: string }) {
  return <Statistic title={title} value={display} formatter={() => display} />;
}

function Panel({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card title={title} extra={extra} size="small" className="dashboard-panel">
      {children}
    </Card>
  );
}

/**
 * `/dashboard`: the landing page of every role. Aggregates over a period (`?days=7|30|90` or a
 * custom `?from=&to=`, at most 366 days), never anything that identifies a patient.
 */
export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [params, setParams] = useSearchParams();
  const period = periodFromParams(params);
  const { range } = period;
  // "Custom" stays selected while the user picks the dates, before the address changes.
  const [customOpen, setCustomOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const choice: PresetChoice =
    period.preset === null || customOpen ? 'custom' : (`${period.preset}` as PresetChoice);

  const query = useQuery({
    queryKey: queryKeys.dashboard(range.from, range.to),
    queryFn: () => dashboardApi.get(range.from, range.to),
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  const choosePreset = (value: PresetChoice) => {
    setPickerError(null);
    if (value === 'custom') {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setParams(new URLSearchParams({ days: value }));
  };

  const chooseCustom = (dates: [Dayjs | null, Dayjs | null] | null) => {
    const [from, to] = dates ?? [null, null];
    if (!from || !to) return;
    if (to.diff(from, 'day') + 1 > DASHBOARD_MAX_DAYS) {
      setPickerError(t('dashboard.range.tooLong', { max: DASHBOARD_MAX_DAYS }));
      return;
    }
    setPickerError(null);
    setCustomOpen(false);
    setParams(new URLSearchParams({ from: toDay(from), to: toDay(to) }));
  };

  const today = dayjs().endOf('day');

  return (
    <div className="page dashboard">
      <div className="page__header">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('dashboard.title')}
          </Typography.Title>
          <Typography.Text type="secondary">{t('dashboard.subtitle')}</Typography.Text>
        </div>
        <div
          className="page__actions dashboard__range"
          role="group"
          aria-label={t('dashboard.range.label')}
        >
          <Segmented<PresetChoice>
            value={choice}
            onChange={choosePreset}
            options={[
              ...DASHBOARD_PRESETS.map((d) => ({
                value: `${d}` as PresetChoice,
                label: t(`dashboard.range.days${d}`),
              })),
              { value: 'custom', label: t('dashboard.range.custom') },
            ]}
          />
          {choice === 'custom' && (
            <DatePicker.RangePicker
              aria-label={t('dashboard.range.picker')}
              allowClear={false}
              value={[parseDay(range.from), parseDay(range.to)]}
              format="DD/MM/YYYY"
              disabledDate={(current, info) => {
                if (current.isAfter(today)) return true;
                const from = info.from;
                return !!from && Math.abs(current.diff(from, 'day')) >= DASHBOARD_MAX_DAYS;
              }}
              onChange={(dates) => chooseCustom(dates)}
            />
          )}
          <Typography.Text type="secondary" className="dashboard__range-summary">
            {formatDay(range.from, lang, 'medium')} – {formatDay(range.to, lang, 'medium')}
          </Typography.Text>
        </div>
      </div>

      {period.invalid && (
        <Alert
          type="warning"
          showIcon
          title={t('dashboard.range.invalid')}
          style={{ marginBottom: 16 }}
        />
      )}
      {pickerError && (
        <Alert
          type="error"
          showIcon
          title={pickerError}
          role="alert"
          style={{ marginBottom: 16 }}
        />
      )}
      {query.isError && (
        <ProblemAlert
          error={query.error}
          onRetry={() => void query.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      {query.isPending && (
        <div role="status" aria-label={t('common.loading')}>
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      )}

      {data && (
        <Spin spinning={query.isFetching && query.isPlaceholderData}>
          <DashboardContent data={data} />
        </Spin>
      )}
    </div>
  );
}

function DashboardContent({ data }: { data: DashboardDto }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const n = (value: number) => formatNumber(value, lang);
  const { totals, review } = data;
  const empty = isEmptyDashboard(data);

  return (
    <>
      <section className="dashboard-cards" aria-label={t('dashboard.title')}>
        <Card size="small">
          <Stat title={t('dashboard.cards.cases')} display={n(totals.cases)} />
        </Card>
        <Card size="small">
          <Stat title={t('dashboard.cards.studies')} display={n(totals.studies)} />
        </Card>
        <Card size="small">
          <Stat title={t('dashboard.cards.jobs')} display={n(totals.jobs)} />
          <Typography.Text type={totals.jobsByStatus.FAILED ? 'danger' : 'secondary'}>
            {t('dashboard.cards.failed', { count: totals.jobsByStatus.FAILED ?? 0 })}
          </Typography.Text>
        </Card>
        <Card size="small">
          <Stat title={t('dashboard.cards.reports')} display={n(totals.reports.final)} />
          <Typography.Text type="secondary">
            {t('dashboard.cards.drafts', { count: totals.reports.draft })}
          </Typography.Text>
        </Card>
        <Card size="small">
          <Stat
            title={t('dashboard.cards.acceptance')}
            display={formatRate(review.acceptanceRate, lang)}
          />
          <Typography.Text type="secondary">
            {review.reviewed > 0
              ? t('dashboard.cards.reviewed', { count: review.reviewed })
              : t('dashboard.cards.noReviews')}
          </Typography.Text>
        </Card>
      </section>

      {empty ? (
        <Card className="dashboard-empty">
          <Empty description={t('dashboard.empty')}>
            <Typography.Text type="secondary">{t('dashboard.emptyHint')}</Typography.Text>
          </Empty>
        </Card>
      ) : (
        <>
          <div className="dashboard-grid dashboard-grid--charts">
            <Panel title={t('dashboard.daily.title')}>
              <Suspense fallback={<ChartFallback />}>
                <DailyChart daily={data.daily} />
              </Suspense>
            </Panel>
            <Panel title={t('dashboard.labels.title')}>
              {data.labels.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('dashboard.labels.empty')}
                />
              ) : (
                <Suspense fallback={<ChartFallback />}>
                  <LabelChart labels={data.labels} />
                </Suspense>
              )}
            </Panel>
          </div>

          <div className="dashboard-grid dashboard-grid--three">
            <ReviewPanel review={review} />
            <Panel title={t('dashboard.breakdown.studies')}>
              <CountList
                entries={Object.entries(totals.studiesByInputType) as Array<[InputType, number]>}
                render={(type) => t(`caseDetail.inputTypes.${type}`)}
              />
            </Panel>
            <Panel title={t('dashboard.breakdown.jobs')}>
              <CountList
                entries={Object.entries(totals.jobsByStatus) as Array<[PredictionStatus, number]>}
                render={(status) => <PredictionStatusTag status={status} />}
              />
            </Panel>
          </div>

          <div className="dashboard-section">
            <ProcessingPanel rows={data.processing.perModel} />
          </div>
        </>
      )}

      <div className="dashboard-section">
        <RecentJobsPanel jobs={data.recentJobs} />
      </div>
    </>
  );
}

function CountList<K extends string>({
  entries,
  render,
}: {
  entries: Array<[K, number]>;
  render: (key: K) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const shown = entries.filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  if (shown.length === 0)
    return <Typography.Text type="secondary">{t('dashboard.breakdown.none')}</Typography.Text>;
  return (
    <ul className="count-list">
      {shown.map(([key, count]) => (
        <li key={key}>
          <span>{render(key)}</span>
          <strong>{formatNumber(count, i18n.language)}</strong>
        </li>
      ))}
    </ul>
  );
}

function ReviewPanel({ review }: { review: DashboardDto['review'] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (review.reviewed === 0) {
    return (
      <Panel title={t('dashboard.review.title')}>
        <Typography.Text type="secondary">{t('dashboard.review.empty')}</Typography.Text>
      </Panel>
    );
  }
  const parts = [
    { key: 'accepted', color: 'success', value: review.accepted },
    { key: 'edited', color: 'processing', value: review.edited },
    { key: 'rejected', color: 'error', value: review.rejected },
  ] as const;
  return (
    <Panel
      title={t('dashboard.review.title')}
      extra={<strong>{formatRate(review.acceptanceRate, lang)}</strong>}
    >
      <ul className="count-list">
        {parts.map((p) => (
          <li key={p.key}>
            <Tag color={p.color}>{t(`dashboard.review.${p.key}`)}</Tag>
            <span>
              <strong>{formatNumber(p.value, lang)}</strong>{' '}
              <Typography.Text type="secondary">
                ({formatRate(p.value / review.reviewed, lang)})
              </Typography.Text>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ProcessingPanel({ rows }: { rows: DashboardModelProcessing[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const ms = (v: number | null) => formatDurationMs(v, lang);
  const columns: ColumnsType<DashboardModelProcessing> = [
    {
      title: t('dashboard.processing.model'),
      dataIndex: 'modelCode',
      render: (v: string) => <code>{v}</code>,
    },
    {
      title: t('dashboard.processing.jobs'),
      dataIndex: 'jobs',
      align: 'right',
      render: (v: number) => formatNumber(v, lang),
    },
    { title: t('dashboard.processing.avg'), dataIndex: 'avgMs', align: 'right', render: ms },
    { title: t('dashboard.processing.p50'), dataIndex: 'p50Ms', align: 'right', render: ms },
    { title: t('dashboard.processing.p95'), dataIndex: 'p95Ms', align: 'right', render: ms },
  ];
  return (
    <Panel title={t('dashboard.processing.title')}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {t('dashboard.processing.hint')}
      </Typography.Paragraph>
      <Table<DashboardModelProcessing>
        rowKey="modelCode"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: t('dashboard.processing.empty') }}
      />
    </Panel>
  );
}

function RecentJobsPanel({ jobs }: { jobs: DashboardRecentJob[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const columns: ColumnsType<DashboardRecentJob> = [
    {
      title: t('dashboard.recent.model'),
      dataIndex: 'modelCode',
      render: (v: string) => <code>{v}</code>,
    },
    {
      title: t('dashboard.recent.status'),
      dataIndex: 'status',
      render: (s: PredictionStatus) => <PredictionStatusTag status={s} />,
    },
    {
      title: t('dashboard.recent.queued'),
      dataIndex: 'queuedAt',
      render: (v: string) => formatDateTime(v, lang),
    },
    {
      title: t('dashboard.recent.finished'),
      dataIndex: 'finishedAt',
      render: (v: string | null) => formatDateTime(v, lang),
    },
    {
      title: <span className="sr-only">{t('dashboard.recent.open')}</span>,
      key: 'open',
      align: 'right',
      render: (_: unknown, job) => (
        <Link to={`/studies/${job.studyId}?job=${job.jobId}`}>{t('dashboard.recent.open')}</Link>
      ),
    },
  ];
  return (
    <Panel title={t('dashboard.recent.title')}>
      <Table<DashboardRecentJob>
        rowKey="jobId"
        size="small"
        columns={columns}
        dataSource={jobs}
        pagination={false}
        locale={{ emptyText: t('dashboard.recent.empty') }}
      />
    </Panel>
  );
}
