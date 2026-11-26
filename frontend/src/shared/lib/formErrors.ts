import { toAppError } from '@/api/problem';

/**
 * Server-side field errors of a ProblemDetail for the fields a form knows, grouped per field, in
 * the shape of Ant Design's `form.setFields`.
 */
export function serverFieldErrors<T extends string>(
  error: unknown,
  known: readonly T[],
): Array<{ name: T; errors: string[] }> {
  const byField = new Map<T, string[]>();
  for (const { field, message } of toAppError(error).fieldErrors) {
    const name = known.find((k) => k === field);
    if (!name) continue;
    byField.set(name, [...(byField.get(name) ?? []), message]);
  }
  return [...byField].map(([name, errors]) => ({ name, errors }));
}
