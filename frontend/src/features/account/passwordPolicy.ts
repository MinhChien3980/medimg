/**
 * Password policy of core-service (`POST /me/password`), checked before sending so the user sees
 * every rule at once: at least 10 characters, at least one letter and one digit (any script, as
 * Java's `Character.isLetter` / `isDigit`), different from the current password, and not
 * containing the username (ignoring case). The server checks the same rules again.
 */
export const PASSWORD_MIN_LENGTH = 10;

export type PasswordViolation = 'length' | 'letter' | 'digit' | 'same' | 'username';

export interface PasswordContext {
  currentPassword?: string;
  username?: string;
}

export function passwordViolations(
  password: string,
  ctx: PasswordContext = {},
): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  // UTF-16 length, like Java's String.length() on the server.
  if (password.length < PASSWORD_MIN_LENGTH) violations.push('length');
  if (!/\p{L}/u.test(password)) violations.push('letter');
  if (!/\p{Nd}/u.test(password)) violations.push('digit');
  if (ctx.currentPassword && password === ctx.currentPassword) violations.push('same');
  const username = ctx.username?.trim().toLowerCase();
  if (username && password.toLowerCase().includes(username)) violations.push('username');
  return violations;
}
