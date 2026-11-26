import { describe, expect, it } from 'vitest';
import { passwordViolations } from './passwordPolicy';

describe('passwordViolations (mirrors the core-service policy)', () => {
  it('accepts 10+ characters with letters and digits', () => {
    expect(passwordViolations('abcdefgh12')).toEqual([]);
  });

  it('needs at least 10 characters (9 is too short, 10 is enough)', () => {
    expect(passwordViolations('abcdefg12')).toEqual(['length']);
    expect(passwordViolations('abcdefgh12')).toEqual([]);
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
