import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import { errorMessage, isPasswordChangeRequired, parseBlobBody, toAppError } from './problem';

function axiosErrorWith(status: number, data: unknown): AxiosError {
  const response = {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  } as AxiosResponse;
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, response);
}

describe('toAppError', () => {
  it('reads an RFC 7807 ProblemDetail', () => {
    const e = toAppError(
      axiosErrorWith(400, {
        title: 'Bad Request',
        status: 400,
        detail: 'Validation failed',
        errors: { birthYear: 'must be ≥ 1900' },
      }),
    );
    expect(e).toEqual({
      status: 400,
      title: 'Bad Request',
      detail: 'Validation failed',
      fieldErrors: [{ field: 'birthYear', message: 'must be ≥ 1900' }],
    });
  });

  it('accepts array-shaped field errors', () => {
    const e = toAppError(
      axiosErrorWith(400, { detail: 'x', errors: [{ field: 'sex', message: 'invalid' }] }),
    );
    expect(e.fieldErrors).toEqual([{ field: 'sex', message: 'invalid' }]);
    expect(errorMessage(axiosErrorWith(400, { detail: 'x', errors: { a: 'b' } }))).toBe('x (a: b)');
  });

  it('falls back for non-problem bodies and plain errors', () => {
    expect(toAppError(axiosErrorWith(502, '<html>')).detail).toBe('Request failed');
    expect(toAppError(new Error('boom')).detail).toBe('boom');
    expect(toAppError('weird', 'fallback').detail).toBe('fallback');
  });
});

describe('isPasswordChangeRequired', () => {
  it('matches a 403 whose problem type ends with password-change-required', () => {
    expect(
      isPasswordChangeRequired(403, {
        type: 'https://medimg.dev/problems/password-change-required',
      }),
    ).toBe(true);
    expect(isPasswordChangeRequired(403, { type: '/problems/password-change-required' })).toBe(
      true,
    );
    expect(isPasswordChangeRequired(403, { type: 'password-change-required' })).toBe(true);
  });

  it('ignores other statuses, other types and bodies without a type', () => {
    expect(isPasswordChangeRequired(401, { type: '/problems/password-change-required' })).toBe(
      false,
    );
    expect(
      isPasswordChangeRequired(403, { type: '/problems/not-password-change-required-x' }),
    ).toBe(false);
    expect(isPasswordChangeRequired(403, { title: 'Forbidden' })).toBe(false);
    expect(isPasswordChangeRequired(403, 'password-change-required')).toBe(false);
    expect(isPasswordChangeRequired(undefined, null)).toBe(false);
  });
});

describe('parseBlobBody', () => {
  it('parses a JSON blob and leaves anything else alone', async () => {
    const json = new Blob([JSON.stringify({ detail: 'x' })], { type: 'application/problem+json' });
    await expect(parseBlobBody(json)).resolves.toEqual({ detail: 'x' });
    const csv = new Blob(['a,b'], { type: 'text/csv' });
    await expect(parseBlobBody(csv)).resolves.toBe(csv);
    const broken = new Blob(['{nope'], { type: 'application/json' });
    await expect(parseBlobBody(broken)).resolves.toBe(broken);
    await expect(parseBlobBody({ a: 1 })).resolves.toEqual({ a: 1 });
  });
});
