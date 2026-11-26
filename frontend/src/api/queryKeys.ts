import type { AdminUserQuery, AuditQuery, InputType, IsoDate, PatientQuery, Uuid } from './types';

/** Central TanStack Query keys so invalidation stays consistent across features. */
export const queryKeys = {
  patients: {
    all: ['patients'] as const,
    list: (q: PatientQuery) => ['patients', 'list', q] as const,
    detail: (id: Uuid) => ['patients', 'detail', id] as const,
    studies: (id: Uuid) => ['patients', 'studies', id] as const,
  },
  samples: {
    all: ['samples'] as const,
  },
  uploads: {
    detail: (id: Uuid) => ['uploads', id] as const,
  },
  studies: {
    detail: (id: Uuid) => ['studies', 'detail', id] as const,
    predictions: (id: Uuid) => ['studies', 'predictions', id] as const,
    findings: (id: Uuid) => ['studies', 'findings', id] as const,
    annotations: (id: Uuid) => ['studies', 'annotations', id] as const,
    reports: (id: Uuid) => ['studies', 'reports', id] as const,
  },
  reports: {
    detail: (id: Uuid) => ['reports', id] as const,
  },
  models: {
    list: (inputType: InputType) => ['models', inputType] as const,
  },
  predictions: {
    detail: (jobId: Uuid) => ['predictions', jobId] as const,
  },
  dashboard: (from: IsoDate, to: IsoDate) => ['dashboard', from, to] as const,
  admin: {
    users: {
      all: ['admin', 'users'] as const,
      list: (q: AdminUserQuery) => ['admin', 'users', 'list', q] as const,
      /** Active admins (count only), for the last-admin rules. */
      activeAdmins: ['admin', 'users', 'activeAdmins'] as const,
    },
    models: ['admin', 'models'] as const,
    audit: {
      list: (q: AuditQuery & { page: number; size: number }) =>
        ['admin', 'audit', 'list', q] as const,
      actions: (from: IsoDate, to: IsoDate) => ['admin', 'audit', 'actions', from, to] as const,
    },
  },
};
