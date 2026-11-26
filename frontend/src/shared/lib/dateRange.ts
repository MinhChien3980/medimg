import dayjs, { type Dayjs } from 'dayjs';

/** Inclusive range of calendar days, both `YYYY-MM-DD`. */
export interface DayRange {
  from: string;
  to: string;
}

export type DayRangeProblem = 'invalid' | 'reversed' | 'future' | 'tooLong';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const DAY_FORMAT = 'YYYY-MM-DD';

/** Strict `YYYY-MM-DD` that is a real date (no 2026-02-30). */
export function parseDay(value: string | null | undefined): Dayjs | null {
  if (!value || !ISO_DAY.test(value)) return null;
  const day = dayjs(value);
  return day.isValid() && day.format(DAY_FORMAT) === value ? day : null;
}

export function toDay(day: Dayjs): string {
  return day.format(DAY_FORMAT);
}

/** The last `days` days, today included. */
export function lastDays(days: number, now: Dayjs = dayjs()): DayRange {
  const to = now.startOf('day');
  return { from: toDay(to.subtract(days - 1, 'day')), to: toDay(to) };
}

/** Number of days in the range, both ends included (one day when from = to). */
export function inclusiveDays(range: DayRange): number {
  const from = parseDay(range.from);
  const to = parseDay(range.to);
  if (!from || !to) return Number.NaN;
  return to.diff(from, 'day') + 1;
}

/**
 * Why a range cannot be sent (null when it can): malformed dates, `from` after `to`, a day after
 * today, or more than `maxDays` days counting both ends.
 */
export function checkRange(
  range: Partial<DayRange>,
  maxDays: number,
  now: Dayjs = dayjs(),
): DayRangeProblem | null {
  const from = parseDay(range.from);
  const to = parseDay(range.to);
  if (!from || !to) return 'invalid';
  if (from.isAfter(to)) return 'reversed';
  if (to.isAfter(now.startOf('day'))) return 'future';
  if (to.diff(from, 'day') + 1 > maxDays) return 'tooLong';
  return null;
}
