import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_BYTES, passwordViolations, violationsFromServer } from './passwordPolicy';

describe('passwordViolations (mirrors the core-service policy)', () => {
  it('accepts 10+ characters with letters and digits', () => {
    expect(passwordViolations('abcdefgh12')).toEqual([]);
  });

  it('needs at least 10 characters (9 is too short, 10 is enough)', () => {
    expect(passwordViolations('abcdefg12')).toEqual(['length']);
    expect(passwordViolations('abcdefgh12')).toEqual([]);
  });

  it('counts characters, not UTF-16 units, like the server (code points)', () => {
    // 'a1' and 7 emoji: 16 UTF-16 units, but only 9 characters.
    expect(passwordViolations(`a1${'😀'.repeat(7)}`)).toEqual(['length']);
    expect(passwordViolations(`a1${'😀'.repeat(8)}`)).toEqual([]);
  });

  it(`allows at most ${PASSWORD_MAX_BYTES} bytes in UTF-8 (BCrypt ignores the rest)`, () => {
    expect(passwordViolations(`a1${'x'.repeat(70)}`)).toEqual([]);
    expect(passwordViolations(`a1${'x'.repeat(71)}`)).toEqual(['tooLong']);
  });

  it('counts the UTF-8 bytes of multi-byte characters, not the characters', () => {
    // 'ậ' is 3 bytes: 23 of them and 'a1' are 71 bytes, 24 and '1' are 73 bytes in 25 characters.
    expect(passwordViolations(`${'ậ'.repeat(23)}a1`)).toEqual([]);
    expect(passwordViolations(`${'ậ'.repeat(24)}1`)).toEqual(['tooLong']);
    // An emoji is 4 bytes: 17 of them and 'a1' are 70 bytes, 18 and 'a1' are 74.
    expect(passwordViolations(`${'😀'.repeat(17)}a1`)).toEqual([]);
    expect(passwordViolations(`${'😀'.repeat(18)}a1`)).toEqual(['tooLong']);
  });

  it('needs a letter and a digit', () => {
    expect(passwordViolations('1234567890')).toEqual(['letter']);
    expect(passwordViolations('abcdefghij')).toEqual(['digit']);
    expect(passwordViolations('!!!!!!!!!!')).toEqual(['letter', 'digit']);
  });

  it('counts letters of any script, like Java Character.isLetter', () => {
    expect(passwordViolations('mậtkhẩuđẹp9')).toEqual([]);
  });

  it('must differ from the current password', () => {
    expect(passwordViolations('abcdefgh12', { currentPassword: 'abcdefgh12' })).toEqual(['same']);
    expect(passwordViolations('abcdefgh12', { currentPassword: 'other' })).toEqual([]);
  });

  it('must not contain the username, ignoring case', () => {
    expect(passwordViolations('xxDoctor2026', { username: 'doctor' })).toEqual(['username']);
    expect(passwordViolations('xxDOCTOR2026', { username: 'Doctor' })).toEqual(['username']);
    expect(passwordViolations('xxdoc2026tor', { username: 'doctor' })).toEqual([]);
  });

  it('reports every violation at once', () => {
    expect(passwordViolations('doctor', { username: 'doctor', currentPassword: 'doctor' })).toEqual(
      ['length', 'digit', 'same', 'username'],
    );
  });
});

describe('violationsFromServer (codes of a 422 /problems/password-policy)', () => {
  it('maps every server code onto the rule shown next to the field', () => {
    expect(
      violationsFromServer([
        'TOO_SHORT',
        'TOO_LONG',
        'NO_LETTER',
        'NO_DIGIT',
        'CONTAINS_USERNAME',
        'SAME_AS_CURRENT',
      ]),
    ).toEqual(['length', 'tooLong', 'letter', 'digit', 'username', 'same']);
  });

  it('ignores unknown codes, duplicates and anything that is not a list of strings', () => {
    expect(
      violationsFromServer(['NO_DIGIT', 'COMMON_PASSWORD', 'constructor', 'NO_DIGIT', 7]),
    ).toEqual(['digit']);
    expect(violationsFromServer('NO_DIGIT')).toEqual([]);
    expect(violationsFromServer(undefined)).toEqual([]);
  });
});
