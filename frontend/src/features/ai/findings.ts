import type { FindingDto, PredictionDto } from '@/api/types';

/** Decision threshold used when a run was started without one (the worker default). */
export const DEFAULT_THRESHOLD = 0.5;

/** Sorts by confidence, highest first (the server already does, but do not rely on it). */
export function sortFindings(findings: readonly FindingDto[]): FindingDto[] {
  return [...findings].sort((a, b) => b.confidence - a.confidence);
}

/** Threshold the run was started with. */
export function runThreshold(prediction: Pick<PredictionDto, 'params'>): number {
  return prediction.params.threshold ?? DEFAULT_THRESHOLD;
}
