import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnnotationDto, SeriesDto, Uuid } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { canEditAnnotation } from '@/features/auth/permissions';
import type { Viewport } from '../viewer/lib/viewport';
import type { LayerItem } from './AnnotationLayer2D';
import { formatMeasurement } from './format';
import {
  measureShape,
  parseShape2D,
  roundShape,
  type PixelSpacing,
  type Shape2D,
} from './geometry2d';
import {
  isPendingAnnotation,
  useAnnotationMutations,
  useStudyAnnotations,
  type AnnotationChange,
} from './hooks';
import { ANNOTATION_COLORS, paintAnnotations } from './scene2d';
import { useAnnotationName } from './useAnnotationLabels';

/** A 2D annotation of the series on screen, with its parsed shape. */
export interface ImageAnnotation {
  dto: AnnotationDto;
  shape: Shape2D;
  name: string;
}

/**
 * State of the 2D annotations of one series: list (from the API), selection, drawing, and the
 * writes (create with the measurement, move / reshape, label / note, delete), plus what to paint
 * into captures.
 */
export function useImageAnnotations(studyId: Uuid, series: SeriesDto | undefined) {
  const { t, i18n } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const query = useStudyAnnotations(studyId);
  const mutations = useAnnotationMutations(studyId);
  const nameOf = useAnnotationName();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const pixelSpacing: PixelSpacing = series?.pixelSpacing ?? null;
  const seriesId = series?.id ?? null;

  const annotations = useMemo<ImageAnnotation[]>(() => {
    const list: ImageAnnotation[] = [];
    for (const dto of query.data ?? []) {
      if (dto.seriesId !== seriesId) continue;
      const shape = parseShape2D(dto.kind, dto.geometry);
      if (shape) list.push({ dto, shape, name: nameOf(dto, list.length) });
    }
    return list;
  }, [query.data, seriesId, nameOf]);

  const labels = { mean: t('annotations.mean'), sd: t('annotations.sd') };
  const textOf = (a: ImageAnnotation): string => {
    const measured = formatMeasurement(measureShape(a.shape, pixelSpacing), i18n.language, labels);
    const words = a.shape.kind === 'ARROW' ? a.shape.geometry.text : '';
    return [a.dto.label, words, measured].filter(Boolean).join(' · ');
  };

  const canEdit = useCallback(
    (dto: AnnotationDto) => canEditAnnotation(user, dto.author.id) && !isPendingAnnotation(dto.id),
    [user],
  );

  const items: LayerItem[] = visible
    ? annotations.map((a) => ({
        id: a.dto.id,
        shape: a.shape,
        text: textOf(a),
        editable: canEdit(a.dto),
      }))
    : [];

  const create = async (shape: Shape2D) => {
    if (!seriesId) return;
    const rounded = roundShape(shape);
    const saved = await mutations.create({
      seriesId,
      kind: rounded.kind,
      geometry: rounded.geometry,
      measurement: measureShape(rounded, pixelSpacing),
    });
    if (saved) setSelectedId(saved.id);
  };

  const reshape = (id: string, shape: Shape2D) => {
    const rounded = roundShape(shape);
    void mutations.update(id, {
      geometry: rounded.geometry,
      measurement: measureShape(rounded, pixelSpacing),
    });
  };

  const update = (id: string, change: AnnotationChange) => void mutations.update(id, change);

  const remove = (id: string) => {
    if (selectedId === id) setSelectedId(null);
    void mutations.remove(id);
  };

  /** Bakes the visible annotations into captures (same drawing as on screen). */
  const paint = (ctx: CanvasRenderingContext2D, viewport: Viewport) =>
    paintAnnotations(
      ctx,
      items.map((item) => ({
        shape: item.shape,
        text: item.text,
        color: item.editable ? ANNOTATION_COLORS.own : ANNOTATION_COLORS.other,
      })),
      viewport,
    );

  const selected = annotations.find((a) => a.dto.id === selectedId) ?? null;

  return {
    query,
    annotations,
    items,
    visible,
    setVisible,
    selectedId: selected ? selectedId : null,
    select: setSelectedId,
    selected,
    canEdit,
    create,
    reshape,
    update,
    remove,
    paint,
  };
}
