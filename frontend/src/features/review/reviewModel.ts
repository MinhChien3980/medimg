/** Finding review state (pure helpers, unit tested). */
import type {
  FindingDto,
  ReviewDecision,
  ReviewFindingRequest,
  ReviewStatus,
  UserRef,
} from '@/api/types';

/** The label to show and report: the doctor's correction for an EDITED finding. */
export function displayLabel(finding: Pick<FindingDto, 'label' | 'review'>): string {
  return finding.review?.status === 'EDITED' && finding.review.label
    ? finding.review.label
    : finding.label;
}

export function isUnreviewed(finding: Pick<FindingDto, 'reviewStatus'>): boolean {
  return finding.reviewStatus === 'PENDING';
}

/**
 * Who added a MANUAL finding. It is accepted when added, so its reviewer is its author.
 */
export function manualAuthor(finding: Pick<FindingDto, 'source' | 'review'>): UserRef | null {
  return finding.source === 'MANUAL' ? (finding.review?.reviewedBy ?? null) : null;
}

/** Only AI findings are reviewed; a doctor's own (MANUAL) finding is accepted when added. */
export function isReviewable(finding: Pick<FindingDto, 'source'>): boolean {
  return finding.source === 'AI';
}

export function reviewedCount(findings: readonly Pick<FindingDto, 'reviewStatus'>[]): number {
  return findings.filter((f) => !isUnreviewed(f)).length;
}

/** Body of `PATCH /findings/{id}/review`; the label is only sent (and required) for EDITED. */
export function reviewRequest(
  finding: Pick<FindingDto, 'version'>,
  decision: ReviewDecision,
  options: { label?: string; note?: string } = {},
): ReviewFindingRequest {
  const label = options.label?.trim();
  const note = options.note?.trim();
  return {
    status: decision,
    ...(decision === 'EDITED' && label ? { label } : {}),
    ...(note ? { note } : {}),
    version: finding.version,
  };
}

/** What the finding looks like once the server accepts the review (shown before it answers). */
export function applyReview(
  finding: FindingDto,
  request: ReviewFindingRequest,
  reviewer: UserRef,
  now: string,
): FindingDto {
  return {
    ...finding,
    reviewStatus: request.status,
    review: {
      status: request.status,
      label: request.status === 'EDITED' ? (request.label ?? null) : null,
      note: request.note ?? null,
      reviewedBy: reviewer,
      reviewedAt: now,
    },
  };
}

/** Replaces the finding with the same id, keeping the order. */
export function replaceFinding<T extends { id: string }>(list: readonly T[], next: T): T[] {
  return list.map((f) => (f.id === next.id ? next : f));
}

export const REVIEW_STATUS_COLORS: Record<ReviewStatus, string> = {
  PENDING: 'default',
  ACCEPTED: 'success',
  EDITED: 'processing',
  REJECTED: 'error',
};
