import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { annotationsApi } from '@/api/endpoints';
import { errorMessage, toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type {
  AnnotationDto,
  AnnotationGeometry,
  CreateAnnotationRequest,
  Measurement,
  Uuid,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { newUuid } from '@/shared/lib/format';

/** Ids of annotations still being created start with this prefix (optimistic entries). */
export const PENDING_ID_PREFIX = 'pending-';

export function isPendingAnnotation(id: string): boolean {
  return id.startsWith(PENDING_ID_PREFIX);
}

export function newPendingId(): string {
  return `${PENDING_ID_PREFIX}${newUuid()}`;
}

export function useStudyAnnotations(studyId: Uuid) {
  return useQuery({
    queryKey: queryKeys.studies.annotations(studyId),
    queryFn: () => annotationsApi.list(studyId),
    enabled: !!studyId,
  });
}

export interface AnnotationChange {
  geometry?: AnnotationGeometry;
  label?: string | null;
  note?: string | null;
  measurement?: Measurement | null;
}

/**
 * All annotation writes share one mutation scope, so they reach the server one after another: an
 * update always carries the version returned by the write before it (no self-inflicted 409 when a
 * shape is moved twice quickly, or edited while still being created).
 */
const SCOPE = { id: 'annotations' };

type Snapshot = AnnotationDto[] | undefined;

function patchList(
  queryClient: QueryClient,
  studyId: Uuid,
  update: (list: AnnotationDto[]) => AnnotationDto[],
): Snapshot {
  const key = queryKeys.studies.annotations(studyId);
  const previous = queryClient.getQueryData<AnnotationDto[]>(key);
  queryClient.setQueryData<AnnotationDto[]>(key, (old) => update(old ?? []));
  return previous;
}

function current(queryClient: QueryClient, studyId: Uuid, id: Uuid): AnnotationDto | undefined {
  return queryClient
    .getQueryData<AnnotationDto[]>(queryKeys.studies.annotations(studyId))
    ?.find((a) => a.id === id);
}

/**
 * Create / update / delete with optimistic cache updates. A failed write restores the list; a 409
 * (someone else changed or deleted the annotation) also reloads it and says so.
 */
export function useAnnotationMutations(studyId: Uuid) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const key = queryKeys.studies.annotations(studyId);
  const inFlight = useRef(new Map<string, number>());

  const fail = (error: unknown, previous: Snapshot) => {
    queryClient.setQueryData(key, previous);
    if (toAppError(error).status === 409 || toAppError(error).status === 404) {
      void message.warning(t('annotations.conflict'));
      void queryClient.invalidateQueries({ queryKey: key });
    } else {
      void message.error(errorMessage(error));
    }
  };

  const create = useMutation({
    scope: SCOPE,
    mutationFn: ({ body }: { body: CreateAnnotationRequest; pendingId: string }) =>
      annotationsApi.create(studyId, body),
    onMutate: ({ body, pendingId }) => {
      const user = useAuthStore.getState().user;
      const now = new Date().toISOString();
      const pending: AnnotationDto = {
        id: pendingId,
        studyId,
        seriesId: body.seriesId,
        author: { id: user?.id ?? '', fullName: user?.fullName ?? '' },
        kind: body.kind,
        geometry: body.geometry,
        label: body.label ?? null,
        note: body.note ?? null,
        measurement: body.measurement ?? null,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      return { previous: patchList(queryClient, studyId, (list) => [...list, pending]) };
    },
    onSuccess: (created, { pendingId }) => {
      queryClient.setQueryData<AnnotationDto[]>(key, (old) =>
        (old ?? []).map((a) => (a.id === pendingId ? created : a)),
      );
    },
    onError: (error, _vars, context) => fail(error, context?.previous),
  });

  const update = useMutation({
    scope: SCOPE,
    mutationFn: ({ id, change }: { id: Uuid; change: AnnotationChange }) => {
      // Read at execution time: an earlier write in the scope may have bumped the version.
      const base = current(queryClient, studyId, id);
      if (!base) return Promise.reject(new Error(t('annotations.conflict')));
      return annotationsApi.update(id, {
        geometry: change.geometry ?? base.geometry,
        label: change.label !== undefined ? change.label : base.label,
        note: change.note !== undefined ? change.note : base.note,
        measurement: change.measurement !== undefined ? change.measurement : base.measurement,
        version: base.version,
      });
    },
    onMutate: ({ id, change }) => {
      inFlight.current.set(id, (inFlight.current.get(id) ?? 0) + 1);
      return {
        previous: patchList(queryClient, studyId, (list) =>
          list.map((a) => (a.id === id ? { ...a, ...change } : a)),
        ),
      };
    },
    onSuccess: (saved) => {
      // Another update of the same annotation is queued: keep its optimistic values on screen and
      // only take the new version (its own answer follows).
      const queued = (inFlight.current.get(saved.id) ?? 0) > 1;
      queryClient.setQueryData<AnnotationDto[]>(key, (old) =>
        (old ?? []).map((a) =>
          a.id !== saved.id ? a : queued ? { ...a, version: saved.version } : saved,
        ),
      );
    },
    onError: (error, _vars, context) => fail(error, context?.previous),
    onSettled: (_data, _error, { id }) => {
      const left = (inFlight.current.get(id) ?? 1) - 1;
      if (left > 0) inFlight.current.set(id, left);
      else inFlight.current.delete(id);
    },
  });

  const remove = useMutation({
    scope: SCOPE,
    mutationFn: (id: Uuid) => annotationsApi.remove(id),
    onMutate: (id) => ({
      previous: patchList(queryClient, studyId, (list) => list.filter((a) => a.id !== id)),
    }),
    onError: (error, _id, context) => fail(error, context?.previous),
  });

  // Failures are reported above (and the list restored): callers only learn whether it worked.
  return {
    /**
     * The saved annotation, or null when it could not be created. Until then it is listed under
     * `pendingId` (see `newPendingId`).
     */
    create: (
      body: CreateAnnotationRequest,
      pendingId = newPendingId(),
    ): Promise<AnnotationDto | null> => create.mutateAsync({ body, pendingId }).catch(() => null),
    update: (id: Uuid, change: AnnotationChange): Promise<AnnotationDto | null> =>
      update.mutateAsync({ id, change }).catch(() => null),
    remove: (id: Uuid): Promise<boolean> =>
      remove.mutateAsync(id).then(
        () => true,
        () => false,
      ),
  };
}
