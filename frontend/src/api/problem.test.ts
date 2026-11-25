import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import { errorMessage, toAppError } from './problem';

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
