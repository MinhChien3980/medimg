import dayjs, { type Dayjs } from 'dayjs';
import type { AuditOutcome, AuditQuery } from '@/api/types';
import { checkRange, lastDays } from '@/shared/lib/dateRange';

/** core-service refuses longer periods (fewer monthly partitions to scan). */
export const AUDIT_MAX_DAYS = 93;
export const AUDIT_DEFAULT_DAYS = 7;
export const AUDIT_PAGE_SIZES = [20, 50, 100, 200] as const;
export const AUDIT_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['SUCCESS', 'FAILURE'];
/** Suggestions for the entity type filter (any value can be typed). */
export const AUDIT_ENTITY_TYPES = [
  'USER',
  'PATIENT',
  'STUDY',
  'UPLOAD',
  'PREDICTION',
  'FINDING',
  'ANNOTATION',
  'REPORT',
  'MODEL',
  'AUDIT',
] as const;

export interface AuditState {
  filters: AuditQuery;
  /** 1-based. */
  page: number;
  size: number;
  /** The address had a period that cannot be used; the default one is shown. */
  invalidRange: boolean;
}

function text(params: URLSearchParams, key: string): string | undefined {
  const v = params.get(key)?.trim();
  return v ? v : undefined;
}

/**
 * Filters of the audit page from its address. The period (`from`, `to`, inclusive days) is
 * required by the API: missing → the last 7 days; malformed, reversed, in the future or longer
 * than 93 days → the last 7 days, flagged.
 */
export function auditStateFromParams(params: URLSearchParams, now: Dayjs = dayjs()): AuditState {
  const from = params.get('from');
  const to = params.get('to');
  const asked = from !== null || to !== null;
  const ok = asked && checkRange({ from: from ?? '', to: to ?? '' }, AUDIT_MAX_DAYS, now) === null;
  const range = ok ? { from: from ?? '', to: to ?? '' } : lastDays(AUDIT_DEFAULT_DAYS, now);
  const outcome = AUDIT_OUTCOMES.find((o) => o === params.get('outcome'));
  const page = Number(params.get('page'));
  const size = Number(params.get('size'));
  return {
    filters: {
      ...range,
      username: text(params, 'username'),
      action: text(params, 'action'),
      entityType: text(params, 'entityType'),
      entityId: text(params, 'entityId'),
      outcome,
    },
    page: Number.isInteger(page) && page > 0 ? page : 1,
    size: (AUDIT_PAGE_SIZES as readonly number[]).includes(size) ? size : AUDIT_DEFAULT_PAGE_SIZE,
    invalidRange: asked && !ok,
  };
}

/** The `detail` column as indented JSON (a JSON string is parsed first). */
export function prettyDetail(detail: unknown): string | null {
  if (detail === null || detail === undefined || detail === '') return null;
  let value: unknown = detail;
  if (typeof detail === 'string') {
    try {
      value = JSON.parse(detail) as unknown;
    } catch {
      return detail;
    }
  }
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return null;
  return JSON.stringify(value, null, 2);
}
