import { useCallback } from 'react';
import type { Role, UserDto } from '@/api/types';
import { useAuthStore } from './authStore';

/**
 * UI actions gated by role. Mirrors the access policy of core-service:
 *
 * - `manageSamples` (mark / unmark a case as a sample case): admins only.
 * - `review`: review AI findings and add manual findings (doctors).
 * - `annotate`: draw annotations (doctors and technicians; each edits / deletes only their own,
 *   see `canEditAnnotation`).
 * - `report`: create and edit draft reports, add key images, sign, amend (doctors).
 * - `viewDraftReport`: see a report before it is signed (everyone but researchers, who only see
 *   FINAL reports).
 *
 * Admins keep their slice 1 write rights but get no clinical ones (no review, annotation or report
 * content).
 */
export type Permission =
  | 'createCase'
  | 'upload'
  | 'runAi'
  | 'manageJob'
  | 'manageSamples'
  | 'review'
  | 'annotate'
  | 'report'
  | 'viewDraftReport';

const WRITE: readonly Permission[] = ['createCase', 'upload', 'runAi', 'manageJob'];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: [...WRITE, 'manageSamples', 'viewDraftReport'],
  DOCTOR: [...WRITE, 'review', 'annotate', 'report', 'viewDraftReport'],
  TECHNICIAN: [...WRITE, 'annotate', 'viewDraftReport'],
  RESEARCHER: [],
};

export function can(user: UserDto | null, permission: Permission): boolean {
  if (!user) return false;
  return user.roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false);
}

/** Annotations are edited and deleted by their author only (who must still be allowed to annotate). */
export function canEditAnnotation(user: UserDto | null, authorId: string): boolean {
  return !!user && user.id === authorId && can(user, 'annotate');
}

/** `can` bound to the signed-in user. */
export function useCan(): (permission: Permission) => boolean {
  const user = useAuthStore((s) => s.user);
  return useCallback((permission: Permission) => can(user, permission), [user]);
}

/** Id of the signed-in user (null when signed out). */
export function useCurrentUserId(): string | null {
  return useAuthStore((s) => s.user?.id ?? null);
}
