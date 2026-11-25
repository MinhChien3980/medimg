import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AnnotationDto,
  Measurement,
  SeriesDto,
  Uuid,
  VolumeAnnotationKind,
  VolumeGeometry,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { canEditAnnotation } from '@/features/auth/permissions';
import {
  annotationCenter,
  parseVolumeGeometry,
  type MprAnnotationInput,
} from '../viewer/volume/mpr/annotationConverters';
import type { MprAnnotationChange } from '../viewer/volume/mpr/MprEngine';
import {
  isPendingAnnotation,
  newPendingId,
  useAnnotationMutations,
  useStudyAnnotations,
  type AnnotationChange,
} from './hooks';
import { useAnnotationName } from './useAnnotationLabels';

const VOLUME_KINDS: readonly VolumeAnnotationKind[] = ['RECTANGLE_ROI', 'ELLIPSE_ROI', 'LENGTH'];

export interface VolumeAnnotation {
  dto: AnnotationDto;
  kind: VolumeAnnotationKind;
  geometry: VolumeGeometry;
  name: string;
}

/** Mean / SD are only meaningful in Hounsfield units (a CT); other volumes keep length and area. */
export function volumeMeasurement(
  measurement: Measurement | null,
  hounsfield: boolean,
): Measurement | null {
  if (!measurement || hounsfield) return measurement;
  const { meanHu: _mean, stdHu: _std, ...rest } = measurement;
  return Object.keys(rest).length > 0 ? rest : null;
}

/**
 * Keeps the MPR measurements (Cornerstone3D tools) and the API in sync:
 *
 * - loaded annotations of the series are given to the engine (`inputs`), locked when the user may
 *   not edit them;
 * - an annotation the user draws is created (`POST`) when the engine reports it, a reshaped one is
 *   updated (`PUT`, with its version), one the engine drops is deleted;
 * - label / note edits and deletions from the panel go to the API, and the engine follows the
 *   cache.
 *
 * The engine knows an annotation it drew by its own uid; loaded ones use the API id as uid. The
 * map below ties the two for annotations drawn in this session.
 */
export function useVolumeAnnotations(
  studyId: Uuid,
  series: SeriesDto | undefined,
  hounsfield: boolean,
) {
  const user = useAuthStore((s) => s.user);
  const query = useStudyAnnotations(studyId);
  const mutations = useAnnotationMutations(studyId);
  const nameOf = useAnnotationName();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Annotation id (pending or saved) → engine uid, for annotations drawn in this session. State
   * for rendering, mirrored in a ref for the engine's callbacks (which may come in a burst).
   */
  const [uids, setUids] = useState<ReadonlyMap<string, string>>(() => new Map());
  const uidsRef = useRef(uids);
  /** Changes reported while the annotation was still being created: applied once it is. */
  const queued = useRef(new Map<string, MprAnnotationChange>());
  const seriesId = series?.id ?? null;

  const canEdit = useCallback(
    (dto: AnnotationDto) => canEditAnnotation(user, dto.author.id) && !isPendingAnnotation(dto.id),
    [user],
  );

  const annotations = useMemo<VolumeAnnotation[]>(() => {
    const list: VolumeAnnotation[] = [];
    for (const dto of query.data ?? []) {
      if (dto.seriesId !== seriesId) continue;
      const kind = VOLUME_KINDS.find((k) => k === dto.kind);
      const geometry = kind ? parseVolumeGeometry(kind, dto.geometry) : null;
      if (kind && geometry) list.push({ dto, kind, geometry, name: nameOf(dto, list.length) });
    }
    return list;
  }, [query.data, seriesId, nameOf]);

  const bind = (id: string, uid: string | null) => {
    const next = new Map(uidsRef.current);
    if (uid) next.set(id, uid);
    else next.delete(id);
    uidsRef.current = next;
    setUids(next);
  };
  const uidOf = useCallback((id: string) => uids.get(id) ?? id, [uids]);
  /** Annotation id of an engine uid (reads the ref: called from engine callbacks). */
  const idOf = (uid: string) => {
    for (const [id, u] of uidsRef.current) if (u === uid) return id;
    return uid;
  };

  const inputs = useMemo<MprAnnotationInput[]>(
    () =>
      annotations.map((a) => ({
        uid: uidOf(a.dto.id),
        kind: a.kind,
        geometry: a.geometry,
        label: a.dto.label,
        locked: !canEdit(a.dto) && !isPendingAnnotation(a.dto.id),
      })),
    [annotations, uidOf, canEdit],
  );

  const known = (id: string) => (query.data ?? []).some((a) => a.id === id);

  /** The engine reports a drawn or edited measurement. */
  const onEngineChange = (change: MprAnnotationChange) => {
    if (!seriesId) return;
    const measurement = volumeMeasurement(change.measurement, hounsfield);
    const id = idOf(change.uid);
    if (isPendingAnnotation(id)) {
      queued.current.set(id, change);
      return;
    }
    if (known(id)) {
      void mutations.update(id, { geometry: change.geometry, measurement });
      return;
    }
    const pendingId = newPendingId();
    bind(pendingId, change.uid);
    void mutations
      .create({ seriesId, kind: change.kind, geometry: change.geometry, measurement }, pendingId)
      .then((saved) => {
        bind(pendingId, null);
        const later = queued.current.get(pendingId);
        queued.current.delete(pendingId);
        if (!saved) return;
        bind(saved.id, change.uid);
        setSelectedId(saved.id);
        if (later) {
          void mutations.update(saved.id, {
            geometry: later.geometry,
            measurement: volumeMeasurement(later.measurement, hounsfield),
          });
        }
      });
  };

  /** The engine dropped a measurement it had shown. */
  const onEngineRemove = (uid: string) => {
    const id = idOf(uid);
    if (known(id) && !isPendingAnnotation(id)) void mutations.remove(id);
  };

  const remove = (id: string) => {
    if (selectedId === id) setSelectedId(null);
    void mutations.remove(id);
  };

  const update = (id: string, change: AnnotationChange) => void mutations.update(id, change);

  const selected = annotations.find((a) => a.dto.id === selectedId) ?? null;

  return {
    query,
    annotations,
    inputs,
    selected,
    selectedId: selected ? selectedId : null,
    selectedUid: selected ? uidOf(selected.dto.id) : null,
    select: setSelectedId,
    selectUid: (uid: string | null) => {
      let id: string | null = null;
      if (uid) for (const [key, u] of uids) if (u === uid) id = key;
      setSelectedId(uid ? (id ?? uid) : null);
    },
    canEdit,
    onEngineChange,
    onEngineRemove,
    update,
    remove,
    /** Where to move the crosshair to show an annotation. */
    centerOf: (a: VolumeAnnotation) => annotationCenter(a.geometry),
  };
}
