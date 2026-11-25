import type { InputType, PatientQuery, Uuid } from './types';

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
  },
  models: {
    list: (inputType: InputType) => ['models', inputType] as const,
  },
  predictions: {
    detail: (jobId: Uuid) => ['predictions', jobId] as const,
  },
};
