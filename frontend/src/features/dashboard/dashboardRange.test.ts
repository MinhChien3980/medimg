import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { dashboard, emptyDashboard } from '@/test/fixtures';
import { isEmptyDashboard, periodFromParams } from './dashboardRange';

const NOW = dayjs('2026-11-26T10:00:00');
const at = (query: string) => periodFromParams(new URLSearchParams(query), NOW);

describe('periodFromParams', () => {
  it('defaults to the last 30 days', () => {
    expect(at('')).toEqual({
      range: { from: '2026-10-28', to: '2026-11-26' },
      preset: 30,
      invalid: false,
    });
  });

  it.each([
    ['days=7', '2026-11-20'],
    ['days=30', '2026-10-28'],
    ['days=90', '2026-08-29'],
  ])('%s → from %s to today', (query, from) => {
    const period = at(query);
    expect(period.range).toEqual({ from, to: '2026-11-26' });
    expect(period.invalid).toBe(false);
  });

  it('reads a custom period', () => {
    expect(at('from=2026-01-01&to=2026-03-31')).toEqual({
      range: { from: '2026-01-01', to: '2026-03-31' },
      preset: null,
      invalid: false,
    });
  });

  it('accepts 366 days, not 367', () => {
    expect(at('from=2025-11-26&to=2026-11-26').invalid).toBe(false);
    expect(at('from=2025-11-25&to=2026-11-26').invalid).toBe(true);
  });

  it.each([
    'days=14',
    'days=abc',
    'from=2026-11-26&to=2026-11-01',
    'from=2026-11-01',
    'from=2026-11-01&to=2026-12-01',
    'from=2026-13-01&to=2026-11-26',
  ])('falls back to 30 days and flags %s', (query) => {
    const period = at(query);
    expect(period).toEqual({
      range: { from: '2026-10-28', to: '2026-11-26' },
      preset: 30,
      invalid: true,
    });
  });
});

describe('isEmptyDashboard', () => {
  it('is empty only when nothing at all happened in the period', () => {
    expect(isEmptyDashboard(emptyDashboard)).toBe(true);
    expect(isEmptyDashboard(dashboard())).toBe(false);
    expect(
      isEmptyDashboard({
        ...emptyDashboard,
        totals: { ...emptyDashboard.totals, reports: { draft: 1, final: 0 } },
      }),
    ).toBe(false);
  });
});
