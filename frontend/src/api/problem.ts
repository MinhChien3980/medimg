import { isAxiosError } from 'axios';
import type { ProblemDetail } from './types';

/** Normalised error shown to the user. */
export interface AppError {
  status: number | null;
  title: string | null;
  detail: string;
  fieldErrors: Array<{ field: string | null; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asProblem(data: unknown): ProblemDetail | null {
  if (!isRecord(data)) return null;
  if (!('detail' in data) && !('title' in data) && !('status' in data)) return null;
  return data;
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
        title: problem.title ?? null,
        detail: problem.detail ?? problem.title ?? fallback,
        fieldErrors: fieldErrorsOf(problem),
      };
    }
    return { status, title: null, detail: error.message || fallback, fieldErrors: [] };
  }
  if (error instanceof Error) {
    return { status: null, title: null, detail: error.message || fallback, fieldErrors: [] };
  }
  return { status: null, title: null, detail: fallback, fieldErrors: [] };
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
 * True for the 403 every API (but `/me`, `/me/password`, `/auth/*`) answers while the user must
 * change a temporary password. Matched on the end of `type` (`…/password-change-required`), so
 * the base URI of the problem types may change.
 */
export function isPasswordChangeRequired(status: number | undefined, data: unknown): boolean {
  if (status !== 403) return false;
  const type = problemTypeOf(data);
  return (
    type !== null &&
    (type === PASSWORD_CHANGE_REQUIRED || type.endsWith(`/${PASSWORD_CHANGE_REQUIRED}`))
  );
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
