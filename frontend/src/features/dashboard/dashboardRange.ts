import dayjs, { type Dayjs } from 'dayjs';
import type { DashboardDto } from '@/api/types';
import { checkRange, lastDays, type DayRange } from '@/shared/lib/dateRange';

/** Presets of the period selector, in days (today included). */
export const DASHBOARD_PRESETS = [7, 30, 90] as const;
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];
export const DEFAULT_PRESET: DashboardPreset = 30;
/** core-service refuses longer periods. */
export const DASHBOARD_MAX_DAYS = 366;

export interface DashboardPeriod {
  range: DayRange;
  /** null for a custom period. */
  preset: DashboardPreset | null;
  /** The address asked for a period that cannot be shown; the default one is used instead. */
  invalid: boolean;
}

function isPreset(value: number): value is DashboardPreset {
  return (DASHBOARD_PRESETS as readonly number[]).includes(value);
}

/**
 * Period of the dashboard from its address: `?days=7|30|90`, or a custom `?from=&to=`
 * (`YYYY-MM-DD`, inclusive, not after today, at most 366 days). Nothing → the last 30 days; an
 * unusable value → the last 30 days, flagged so the page can say so.
 */
export function periodFromParams(params: URLSearchParams, now: Dayjs = dayjs()): DashboardPeriod {
  const fallback = (invalid: boolean): DashboardPeriod => ({
    range: lastDays(DEFAULT_PRESET, now),
    preset: DEFAULT_PRESET,
    invalid,
  });
  const from = params.get('from');
  const to = params.get('to');
  if (from !== null || to !== null) {
    const range = { from: from ?? '', to: to ?? '' };
    return checkRange(range, DASHBOARD_MAX_DAYS, now) === null
      ? { range, preset: null, invalid: false }
      : fallback(true);
  }
  const days = params.get('days');
  if (days === null) return fallback(false);
  const n = Number(days);
  return isPreset(n) ? { range: lastDays(n, now), preset: n, invalid: false } : fallback(true);
}

/** Nothing at all happened in the period (the recent jobs, not tied to the period, aside). */
export function isEmptyDashboard(d: DashboardDto): boolean {
  return (
    d.totals.cases === 0 &&
    d.totals.studies === 0 &&
    d.totals.jobs === 0 &&
    d.totals.reports.draft === 0 &&
    d.totals.reports.final === 0 &&
    d.review.reviewed === 0
  );
}
