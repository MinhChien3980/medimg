import type { FindingDto, ModelDto, PredictionDto } from '@/api/types';
import { formatPercent, formatVolumeMl } from '@/shared/lib/format';

/** Decision threshold used when a run was started without one (the worker default). */
export const DEFAULT_THRESHOLD = 0.5;

/**
 * Sorts by confidence, then by volume, highest first (the server already sorts, but do not rely
 * on it). Findings without a value sort last.
 */
export function sortFindings(findings: readonly FindingDto[]): FindingDto[] {
  const score = (f: FindingDto) => f.confidence ?? f.volumeMl ?? Number.NEGATIVE_INFINITY;
  return [...findings].sort((a, b) => score(b) - score(a));
}

/** Threshold the run was started with. */
export function runThreshold(prediction: Pick<PredictionDto, 'params'>): number {
  return prediction.params.threshold ?? DEFAULT_THRESHOLD;
}

/** A segmentation run reports structures with a volume instead of a probability. */
export function isSegmentationResult(prediction: Pick<PredictionDto, 'findings' | 'artifacts'>) {
  return (
    (prediction.artifacts?.meshes.length ?? 0) > 0 ||
    prediction.artifacts?.segmentation != null ||
    prediction.findings.some((f) => f.volumeMl != null)
  );
}

export function isSegmentationModel(model: Pick<ModelDto, 'task'> | null | undefined): boolean {
  return model?.task === 'SEGMENTATION_3D';
}

/** "87.0%" for a probability, "1,520 ml" for a segmented structure, "" when neither is known. */
export function findingValue(finding: FindingDto, language: string): string {
  if (finding.confidence != null) return formatPercent(finding.confidence);
  if (finding.volumeMl != null) return formatVolumeMl(finding.volumeMl, language);
  return '';
}
