/**
 * Recharts views of the dashboard. This module is only imported lazily (see `DashboardPage`), so
 * Recharts stays out of the initial bundle. Each chart has a visually hidden table with the same
 * numbers for screen readers.
 */
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardDay } from '@/api/types';
import { formatDay, formatNumber } from '@/shared/lib/format';

/** Categorical slots 1 and 2 of the chart palette, and a dark critical red for failures. */
const SERIES_COLORS = {
  cases: '#2a78d6',
  jobs: '#eb6834',
  failedJobs: '#a8071a',
} as const;

const AXIS = { stroke: '#8a99a6', fontSize: 12 } as const;
const GRID = '#e6ebef';
/** Size used before the container is measured (and in jsdom, which never measures). */
const INITIAL = { width: 640, height: 280 } as const;

interface DailyChartProps {
  daily: DashboardDay[];
}

export function DailyChart({ daily }: DailyChartProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const title = t('dashboard.daily.title');
  const series = (['cases', 'jobs', 'failedJobs'] as const).map((key) => ({
    key,
    name: t(`dashboard.daily.${key}`),
  }));
  return (
    <figure className="dashboard-chart" aria-label={title}>
      <div aria-hidden data-testid="daily-chart">
        <ResponsiveContainer width="100%" height={INITIAL.height} initialDimension={INITIAL}>
          <LineChart data={daily} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => formatDay(d, lang)}
              minTickGap={16}
              {...AXIS}
            />
            <YAxis allowDecimals={false} width={40} {...AXIS} />
            <Tooltip
              labelFormatter={(d) => (typeof d === 'string' ? formatDay(d, lang, 'medium') : d)}
              formatter={(value) => formatNumber(Number(value), lang)}
            />
            <Legend />
            {series.map(({ key, name }) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={name}
                stroke={SERIES_COLORS[key]}
                strokeWidth={2}
                strokeDasharray={key === 'failedJobs' ? '5 4' : undefined}
                dot={daily.length <= 31 ? { r: 3 } : false}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{t('dashboard.tableCaption', { title })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.daily.date')}</th>
            {series.map((s) => (
              <th scope="col" key={s.key}>
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <th scope="row">{formatDay(d.date, lang, 'medium')}</th>
              <td>{formatNumber(d.cases, lang)}</td>
              <td>{formatNumber(d.jobs, lang)}</td>
              <td>{formatNumber(d.failedJobs, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

interface LabelChartProps {
  labels: Array<{ label: string; accepted: number }>;
}

export function LabelChart({ labels }: LabelChartProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const title = t('dashboard.labels.title');
  const height = Math.max(120, labels.length * 32 + 24);
  return (
    <figure className="dashboard-chart" aria-label={title}>
      <div aria-hidden data-testid="label-chart">
        <ResponsiveContainer
          width="100%"
          height={height}
          initialDimension={{ width: INITIAL.width, height }}
        >
          <BarChart
            data={labels}
            layout="vertical"
            margin={{ top: 0, right: 40, bottom: 0, left: 0 }}
          >
            <XAxis type="number" hide allowDecimals={false} />
            <YAxis type="category" dataKey="label" width={130} tickLine={false} {...AXIS} />
            <Tooltip formatter={(value) => formatNumber(Number(value), lang)} />
            <Bar
              dataKey="accepted"
              name={t('dashboard.labels.accepted')}
              fill={SERIES_COLORS.cases}
              radius={[0, 4, 4, 0]}
              barSize={18}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="accepted"
                position="right"
                fill="#33424f"
                fontSize={12}
                formatter={(value) => formatNumber(Number(value), lang)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{t('dashboard.tableCaption', { title })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.labels.label')}</th>
            <th scope="col">{t('dashboard.labels.accepted')}</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((l) => (
            <tr key={l.label}>
              <th scope="row">{l.label}</th>
              <td>{formatNumber(l.accepted, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
