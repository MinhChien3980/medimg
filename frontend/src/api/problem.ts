import { isAxiosError } from 'axios';
import type { ProblemDetail } from './types';

/** Normalised error shown to the user. */
export interface AppError {
  status: number | null;
  /** The ProblemDetail `type` (`…/problems/<slug>`), null when the server sent none. */
  type: string | null;
  title: string | null;
  detail: string;
  fieldErrors: Array<{ field: string | null; message: string }>;
  /**
   * The extension members of the ProblemDetail, as sent (e.g. `violations` of a password policy
   * failure): everything but `type`, `title`, `status`, `detail` and `instance`.
   */
  properties: Readonly<Record<string, unknown>>;
}

const STANDARD_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asProblem(data: unknown): ProblemDetail | null {
  if (!isRecord(data)) return null;
  if (!('detail' in data) && !('title' in data) && !('status' in data)) return null;
  return data;
}

function extensionsOf(problem: ProblemDetail): AppError['properties'] {
  return Object.fromEntries(Object.entries(problem).filter(([key]) => !STANDARD_MEMBERS.has(key)));
}

function fieldErrorsOf(problem: ProblemDetail): AppError['fieldErrors'] {
  const errors = problem.errors;
  if (!errors) return [];
  if (Array.isArray(errors)) {
    const list = errors as ReadonlyArray<{ field?: string; message?: string }>;
    return list
      .filter((e) => typeof e.message === 'string')
      .map((e) => ({ field: e.field ?? null, message: e.message ?? '' }));
  }
  return Object.entries(errors as Record<string, string>).map(([field, message]) => ({
    field,
    message: String(message),
  }));
}

/**
 * Converts anything thrown by the API layer into an `AppError`.
 * `fallback` is used when the server sent no `detail`/`title` (e.g. network failure).
 */
export function toAppError(error: unknown, fallback = 'Unexpected error'): AppError {
  if (isAxiosError(error)) {
    const status = error.response?.status ?? null;
    const problem = asProblem(error.response?.data);
    if (problem) {
      return {
        status: problem.status ?? status,
        type: problemTypeOf(problem),
        title: problem.title ?? null,
        detail: problem.detail ?? problem.title ?? fallback,
        fieldErrors: fieldErrorsOf(problem),
        properties: extensionsOf(problem),
      };
    }
    return withoutProblem(status, error.message || fallback);
  }
  if (error instanceof Error) return withoutProblem(null, error.message || fallback);
  return withoutProblem(null, fallback);
}

function withoutProblem(status: number | null, detail: string): AppError {
  return { status, type: null, title: null, detail, fieldErrors: [], properties: {} };
}

/** One-line human message for toasts. */
export function errorMessage(error: unknown, fallback?: string): string {
  const e = toAppError(error, fallback);
  const fields = e.fieldErrors.map((f) => (f.field ? `${f.field}: ${f.message}` : f.message));
  return fields.length > 0 ? `${e.detail} (${fields.join('; ')})` : e.detail;
}

/** Last path segment of the ProblemDetail `type` the server uses when a password change is due. */
export const PASSWORD_CHANGE_REQUIRED = 'password-change-required';

/** The ProblemDetail `type` of a response body, if any. */
export function problemTypeOf(data: unknown): string | null {
  return isRecord(data) && typeof data.type === 'string' ? data.type : null;
}

/**
 * True when the problem `type` names `slug`. Matched on the last path segment
 * (`…/problems/<slug>`), so the base URI of the problem types may change.
 */
function typeIs(type: string | null, slug: string): boolean {
  return type !== null && (type === slug || type.endsWith(`/${slug}`));
}

/** True when anything thrown by the API layer is a ProblemDetail of type `…/<slug>`. */
export function hasProblemType(error: unknown, slug: string): boolean {
  return typeIs(toAppError(error).type, slug);
}

/**
 * True for the 403 every API (but `/me`, `/me/password`, `/auth/*`) answers while the user must
 * change a temporary password (`…/password-change-required`).
 */
export function isPasswordChangeRequired(status: number | undefined, data: unknown): boolean {
  return status === 403 && typeIs(problemTypeOf(data), PASSWORD_CHANGE_REQUIRED);
}

/** Last path segment of the ProblemDetail `type` of a 401 for a session the server ended. */
export const SESSION_REVOKED = 'session-revoked';

/**
 * True for the 401 core-service answers once the account behind a still valid access token was
 * locked (or removed): its refresh token is refused too, so the session is over.
 */
export function isSessionRevoked(status: number | undefined, data: unknown): boolean {
  return status === 401 && typeIs(problemTypeOf(data), SESSION_REVOKED);
}

/**
 * Error bodies of `responseType: 'blob'` requests (CSV export, PDF preview) arrive as a Blob.
 * Returns the parsed ProblemDetail when the blob holds JSON, the blob itself otherwise.
 */
export async function parseBlobBody(data: unknown): Promise<unknown> {
  if (typeof Blob === 'undefined' || !(data instanceof Blob)) return data;
  if (!/json/i.test(data.type)) return data;
  try {
    return JSON.parse(await data.text()) as unknown;
  } catch {
    return data;
  }
}
