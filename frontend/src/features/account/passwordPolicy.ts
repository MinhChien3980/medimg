/**
 * Password policy of core-service (`POST /me/password`), checked before sending so the user sees
 * every rule at once: at least 10 characters, at most 72 bytes in UTF-8 (BCrypt ignores anything
 * beyond), at least one letter and one digit (any script, as Java's `Character.isLetter` /
 * `isDigit`), different from the current password, and not containing the username (ignoring
 * case). The server checks the same rules again and answers a 422 `…/password-policy` whose
 * `violations` are read by `violationsFromServer`.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

export type PasswordViolation = 'length' | 'tooLong' | 'letter' | 'digit' | 'same' | 'username';

export interface PasswordContext {
  currentPassword?: string;
  username?: string;
}

const utf8 = new TextEncoder();

export function passwordViolations(
  password: string,
  ctx: PasswordContext = {},
): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  // Characters are code points, as the server counts them (an emoji is one, not two).
  if ([...password].length < PASSWORD_MIN_LENGTH) violations.push('length');
  if (utf8.encode(password).length > PASSWORD_MAX_BYTES) violations.push('tooLong');
  if (!/\p{L}/u.test(password)) violations.push('letter');
  if (!/\p{Nd}/u.test(password)) violations.push('digit');
  if (ctx.currentPassword && password === ctx.currentPassword) violations.push('same');
  const username = ctx.username?.trim().toLowerCase();
  if (username && password.toLowerCase().includes(username)) violations.push('username');
  return violations;
}

/** The server's violation codes (`PasswordPolicy.Violation`) and the rule each one breaks. */
const SERVER_CODES: ReadonlyMap<string, PasswordViolation> = new Map([
  ['TOO_SHORT', 'length'],
  ['TOO_LONG', 'tooLong'],
  ['NO_LETTER', 'letter'],
  ['NO_DIGIT', 'digit'],
  ['CONTAINS_USERNAME', 'username'],
  ['SAME_AS_CURRENT', 'same'],
]);

/**
 * The rules named by the `violations` of a 422 `…/password-policy`, in the server's order; codes
 * this client does not know are left out (the caller then shows the server's own message).
 */
export function violationsFromServer(codes: unknown): PasswordViolation[] {
  if (!Array.isArray(codes)) return [];
  const known = codes
    .map((code) => (typeof code === 'string' ? SERVER_CODES.get(code) : undefined))
    .filter((v): v is PasswordViolation => v !== undefined);
  return [...new Set(known)];
}
