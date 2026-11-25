import { useCallback } from 'react';
import type { Role, UserDto } from '@/api/types';
import { useAuthStore } from './authStore';

/**
 * UI actions gated by role. Mirrors the `@PreAuthorize` rules of core-service. `manageSamples`
 * (mark / unmark a case as a sample case) is for admins only.
 */
export type Permission = 'createCase' | 'upload' | 'runAi' | 'manageJob' | 'manageSamples';

const WRITE: readonly Permission[] = ['createCase', 'upload', 'runAi', 'manageJob'];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: [...WRITE, 'manageSamples'],
  DOCTOR: WRITE,
  TECHNICIAN: WRITE,
  RESEARCHER: [],
};

export function can(user: UserDto | null, permission: Permission): boolean {
  if (!user) return false;
  return user.roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false);
}

/** `can` bound to the signed-in user. */
export function useCan(): (permission: Permission) => boolean {
  const user = useAuthStore((s) => s.user);
  return useCallback((permission: Permission) => can(user, permission), [user]);
}
