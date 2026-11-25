import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnnotationDto } from '@/api/types';
import { formatMeasurement } from './format';

/** "Rectangle 2" when an annotation has no label: its kind and its place in the list. */
export function useAnnotationName() {
  const { t } = useTranslation();
  return useCallback(
    (annotation: Pick<AnnotationDto, 'kind' | 'label'>, index: number) =>
      annotation.label || `${t(`annotations.kinds.${annotation.kind}`)} ${index + 1}`,
    [t],
  );
}

/** Kind ("Ellipse ROI") and measurement ("mean 42 HU, SD 11") of an annotation, translated. */
export function useAnnotationText() {
  const { t, i18n } = useTranslation();
  const labels = { mean: t('annotations.mean'), sd: t('annotations.sd') };
  return {
    kind: (a: Pick<AnnotationDto, 'kind'>) => t(`annotations.kinds.${a.kind}`),
    measurement: (a: Pick<AnnotationDto, 'measurement'>) =>
      formatMeasurement(a.measurement, i18n.language, labels),
  };
}
