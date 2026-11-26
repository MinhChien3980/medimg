import type { AdminUserDto, UserDto } from '@/api/types';

/**
 * Actions on a user that core-service refuses (409/422), checked up front from the data the page
 * has, so the button is disabled with the reason instead of failing. The server stays the
 * authority: another admin may act at the same time, so its 409/422 is still handled.
 *
 * `activeAdmins` is the number of ACTIVE users with the ADMIN role (null while unknown: then
 * only the self rules apply and the server decides the rest).
 */

export type LockBlock = 'selfLock' | 'lastAdminLock';
export type DemoteBlock = 'selfDemote' | 'lastAdminDemote';
export type ResetBlock = 'selfReset';

function isActiveAdmin(user: AdminUserDto): boolean {
  return user.status === 'ACTIVE' && user.roles.includes('ADMIN');
}

/** Why `target` cannot be locked (an admin never locks their own account or the last active admin). */
export function lockBlock(
  target: AdminUserDto,
  me: UserDto | null,
  activeAdmins: number | null,
): LockBlock | null {
  if (target.status !== 'ACTIVE') return null;
  if (me && target.id === me.id) return 'selfLock';
  if (isActiveAdmin(target) && activeAdmins !== null && activeAdmins <= 1) return 'lastAdminLock';
  return null;
}

/** Why the ADMIN role of `target` cannot be removed (own role, or the last active admin). */
export function demoteBlock(
  target: AdminUserDto,
  me: UserDto | null,
  activeAdmins: number | null,
): DemoteBlock | null {
  if (!target.roles.includes('ADMIN')) return null;
  if (me && target.id === me.id) return 'selfDemote';
  if (isActiveAdmin(target) && activeAdmins !== null && activeAdmins <= 1) return 'lastAdminDemote';
  return null;
}

/**
 * An admin changes their own password on the account page (which asks for the current one),
 * never through a reset that would end their own session.
 */
export function resetBlock(target: AdminUserDto, me: UserDto | null): ResetBlock | null {
  return me && target.id === me.id ? 'selfReset' : null;
}
