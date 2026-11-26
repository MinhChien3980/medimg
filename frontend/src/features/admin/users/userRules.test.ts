import { describe, expect, it } from 'vitest';
import { admin, adminUser, listedDoctor, secondAdmin } from '@/test/fixtures';
import { demoteBlock, lockBlock, resetBlock } from './userRules';

const me = admin;
const myRow = adminUser();

describe('lockBlock', () => {
  it('an admin cannot lock their own account', () => {
    expect(lockBlock(myRow, me, 2)).toBe('selfLock');
    expect(lockBlock(myRow, me, null)).toBe('selfLock');
  });

  it('the last active admin cannot be locked', () => {
    expect(lockBlock(secondAdmin, me, 1)).toBe('lastAdminLock');
    expect(lockBlock(secondAdmin, me, 2)).toBeNull();
  });

  it('without a known admin count only the self rule applies (the server decides)', () => {
    expect(lockBlock(secondAdmin, me, null)).toBeNull();
  });

  it('other users can be locked; locked users are not blocked (they get Unlock)', () => {
    expect(lockBlock(listedDoctor, me, 1)).toBeNull();
    expect(lockBlock({ ...secondAdmin, status: 'LOCKED' }, me, 1)).toBeNull();
  });
});

describe('demoteBlock', () => {
  it('an admin cannot remove their own Admin role', () => {
    expect(demoteBlock(myRow, me, 5)).toBe('selfDemote');
  });

  it('the last active admin keeps the Admin role', () => {
    expect(demoteBlock(secondAdmin, me, 1)).toBe('lastAdminDemote');
    expect(demoteBlock(secondAdmin, me, 2)).toBeNull();
  });

  it('a locked admin does not count as the last active one', () => {
    expect(demoteBlock({ ...secondAdmin, status: 'LOCKED' }, me, 1)).toBeNull();
  });

  it('users without the Admin role are never blocked', () => {
    expect(demoteBlock(listedDoctor, me, 1)).toBeNull();
  });
});

describe('resetBlock', () => {
  it('an admin changes their own password on the account page, not by a reset', () => {
    expect(resetBlock(myRow, me)).toBe('selfReset');
    expect(resetBlock(listedDoctor, me)).toBeNull();
  });
});
