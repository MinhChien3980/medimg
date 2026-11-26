import { describe, expect, it } from 'vitest';
import { formatDay, formatDurationMs, formatNumber, formatRate } from './format';

describe('locale formatting', () => {
  it('groups thousands per language', () => {
    expect(formatNumber(1234567, 'en')).toBe('1,234,567');
    expect(formatNumber(1234567, 'vi')).toBe('1.234.567');
  });

  it('formats rates as percentages, "—" when there is none', () => {
    expect(formatRate(0.75, 'en')).toBe('75%');
    expect(formatRate(0.8735, 'en')).toBe('87.4%');
    expect(formatRate(0.8735, 'vi')).toMatch(/^87,4\s?%$/);
    expect(formatRate(null, 'en')).toBe('—');
    expect(formatRate(0, 'en')).toBe('0%');
  });

  it('formats durations in ms, s, then min', () => {
    expect(formatDurationMs(812, 'en')).toBe('812 ms');
    expect(formatDurationMs(2150, 'en')).toBe('2.2 s');
    expect(formatDurationMs(2150, 'vi')).toBe('2,2 s');
    expect(formatDurationMs(95_000, 'en')).toBe('1 min 35 s');
    expect(formatDurationMs(120_000, 'en')).toBe('2 min');
    expect(formatDurationMs(null, 'en')).toBe('—');
  });

  it('shows a calendar day without shifting it by the time zone', () => {
    expect(formatDay('2026-11-01', 'en')).toBe('01/11');
    expect(formatDay('2026-11-01', 'en', 'medium')).toBe('01/11/2026');
    expect(formatDay('2026-11-01', 'vi', 'medium')).toBe('01/11/2026');
    expect(formatDay('not-a-day', 'en')).toBe('not-a-day');
  });
});
