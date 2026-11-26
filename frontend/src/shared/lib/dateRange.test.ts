import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { checkRange, inclusiveDays, lastDays, parseDay } from './dateRange';

const NOW = dayjs('2026-11-26T15:30:00');

describe('date ranges', () => {
  it('parses only real YYYY-MM-DD days', () => {
    expect(parseDay('2026-11-26')?.format('YYYY-MM-DD')).toBe('2026-11-26');
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('26/11/2026')).toBeNull();
    expect(parseDay('2026-11-26T00:00')).toBeNull();
    expect(parseDay('')).toBeNull();
    expect(parseDay(null)).toBeNull();
  });

  it('the last n days include today', () => {
    expect(lastDays(7, NOW)).toEqual({ from: '2026-11-20', to: '2026-11-26' });
    expect(lastDays(1, NOW)).toEqual({ from: '2026-11-26', to: '2026-11-26' });
    expect(inclusiveDays(lastDays(30, NOW))).toBe(30);
  });

  it('counts both ends of a range', () => {
    expect(inclusiveDays({ from: '2026-11-26', to: '2026-11-26' })).toBe(1);
    expect(inclusiveDays({ from: '2026-02-27', to: '2026-03-01' })).toBe(3);
  });

  it('rejects malformed, reversed, future and too long ranges', () => {
    expect(checkRange({ from: '2026-11-01', to: '2026-11-26' }, 93, NOW)).toBeNull();
    expect(checkRange({ from: 'x', to: '2026-11-26' }, 93, NOW)).toBe('invalid');
    expect(checkRange({ from: '2026-11-20' }, 93, NOW)).toBe('invalid');
    expect(checkRange({ from: '2026-11-26', to: '2026-11-20' }, 93, NOW)).toBe('reversed');
    expect(checkRange({ from: '2026-11-20', to: '2026-11-27' }, 93, NOW)).toBe('future');
  });

  it('allows exactly the maximum number of days, not one more', () => {
    // 2026-08-26 .. 2026-11-26 is 93 days counting both ends.
    expect(checkRange({ from: '2026-08-26', to: '2026-11-26' }, 93, NOW)).toBeNull();
    expect(checkRange({ from: '2026-08-25', to: '2026-11-26' }, 93, NOW)).toBe('tooLong');
  });
});
