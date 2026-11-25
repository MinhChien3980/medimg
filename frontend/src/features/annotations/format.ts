import type { Measurement } from '@/api/types';

function number(value: number, language: string, digits: number): string {
  return new Intl.NumberFormat(language === 'vi' ? 'vi-VN' : 'en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export interface MeasurementLabels {
  /** e.g. "mean" */
  mean: string;
  /** e.g. "SD" */
  sd: string;
}

/**
 * "12.3 mm", "84.0 px", "156 mm²", "4,021 px²", "mean 42 HU, SD 11": the unit always says whether
 * a 2D value is calibrated (mm) or not (px). Empty string when nothing was measured.
 */
export function formatMeasurement(
  m: Measurement | null | undefined,
  language: string,
  labels: MeasurementLabels,
): string {
  if (!m) return '';
  const parts: string[] = [];
  if (m.lengthMm != null) parts.push(`${number(m.lengthMm, language, 1)} mm`);
  if (m.lengthPx != null) parts.push(`${number(m.lengthPx, language, 1)} px`);
  if (m.areaMm2 != null) parts.push(`${number(m.areaMm2, language, m.areaMm2 < 100 ? 1 : 0)} mm²`);
  if (m.areaPx2 != null) parts.push(`${number(m.areaPx2, language, 0)} px²`);
  if (m.meanHu != null) {
    const sd = m.stdHu != null ? `, ${labels.sd} ${number(m.stdHu, language, 0)}` : '';
    parts.push(`${labels.mean} ${number(m.meanHu, language, 0)} HU${sd}`);
  }
  return parts.join(' · ');
}
