import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** Translated name of a segmentation label (`kidney_left` → "Left kidney"); unknown labels pass through. */
export function useStructureName(): (label: string) => string {
  const { t } = useTranslation();
  return useCallback(
    (label: string) => {
      const names: Readonly<Record<string, string>> = t('structures', { returnObjects: true });
      return names[label] ?? label.replaceAll('_', ' ');
    },
    [t],
  );
}
