import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { auditStateFromParams, prettyDetail } from './auditFilters';

const NOW = dayjs('2026-11-26T10:00:00');
const at = (query: string) => auditStateFromParams(new URLSearchParams(query), NOW);

describe('auditStateFromParams', () => {
  it('defaults to the last 7 days, page 1 of 50', () => {
    expect(at('')).toEqual({
      filters: {
        from: '2026-11-20',
        to: '2026-11-26',
        username: undefined,
        action: undefined,
        entityType: undefined,
        entityId: undefined,
        outcome: undefined,
      },
      page: 1,
      size: 50,
      invalidRange: false,
    });
  });

  it('reads every filter, trimmed', () => {
    const s = at(
      'from=2026-11-01&to=2026-11-26&username=%20admin%20&action=USER_LOCKED&entityType=USER&entityId=42&outcome=FAILURE&page=3&size=200',
    );
    expect(s.filters).toEqual({
      from: '2026-11-01',
      to: '2026-11-26',
      username: 'admin',
      action: 'USER_LOCKED',
      entityType: 'USER',
      entityId: '42',
      outcome: 'FAILURE',
    });
    expect(s.page).toBe(3);
    expect(s.size).toBe(200);
  });

  it('accepts 93 days, not 94', () => {
    expect(at('from=2026-08-26&to=2026-11-26').invalidRange).toBe(false);
    const tooLong = at('from=2026-08-25&to=2026-11-26');
    expect(tooLong.invalidRange).toBe(true);
    expect(tooLong.filters.from).toBe('2026-11-20');
  });

  it('flags reversed, future or malformed periods', () => {
    expect(at('from=2026-11-26&to=2026-11-01').invalidRange).toBe(true);
    expect(at('from=2026-11-20&to=2026-11-30').invalidRange).toBe(true);
    expect(at('from=yesterday&to=2026-11-26').invalidRange).toBe(true);
  });

  it('ignores an unknown outcome and page sizes above 200', () => {
    const s = at('outcome=MAYBE&size=500&page=-2');
    expect(s.filters.outcome).toBeUndefined();
    expect(s.size).toBe(50);
    expect(s.page).toBe(1);
  });
});

describe('prettyDetail', () => {
  it('indents JSON objects and parses JSON strings', () => {
    expect(prettyDetail({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyDetail('{"rows":3}')).toBe('{\n  "rows": 3\n}');
  });

  it('keeps a non-JSON string and drops empty details', () => {
    expect(prettyDetail('plain text')).toBe('plain text');
    expect(prettyDetail(null)).toBeNull();
    expect(prettyDetail({})).toBeNull();
    expect(prettyDetail('')).toBeNull();
  });
});
