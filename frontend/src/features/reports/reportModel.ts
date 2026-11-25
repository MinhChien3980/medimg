/** Report state helpers (pure, unit tested). */
import {
  isVolumeInput,
  KEY_IMAGE_MAX_COUNT,
  type FindingDto,
  type InputType,
  type KeyImageOrderItem,
  type ReportDto,
  type ReportKeyImageDto,
  type ReportLanguage,
  type ReportSummaryDto,
  type ReportTemplate,
  type UpdateReportRequest,
} from '@/api/types';

/**
 * Findings reviewed after `since` (the draft's last save): the pre-filled Findings section may not
 * state them until the draft is refilled. Server times on both sides.
 */
export function reviewedSince(findings: readonly FindingDto[], since: string): number {
  const after = Date.parse(since);
  return findings.filter((f) => f.review && Date.parse(f.review.reviewedAt) > after).length;
}

/** The two fixed templates: a chest X-ray for 2D studies, a CT for volumes. */
export function defaultTemplate(inputType: InputType): ReportTemplate {
  return isVolumeInput(inputType) ? 'CT' : 'CXR';
}

export function defaultLanguage(uiLanguage: string): ReportLanguage {
  return uiLanguage === 'en' ? 'en' : 'vi';
}

/** Editable text of a draft (the language and template are chosen at creation). */
export interface ReportSections {
  clinicalInfo: string;
  technique: string;
  findingsText: string;
  impression: string;
}

export const SECTION_FIELDS = ['clinicalInfo', 'technique', 'findingsText', 'impression'] as const;
export type SectionField = (typeof SECTION_FIELDS)[number];

export function sectionsOf(report: ReportDto): ReportSections {
  return {
    clinicalInfo: report.clinicalInfo ?? '',
    technique: report.technique ?? '',
    findingsText: report.findingsText ?? '',
    impression: report.impression ?? '',
  };
}

export function sameSections(a: ReportSections, b: ReportSections): boolean {
  return SECTION_FIELDS.every((f) => a[f] === b[f]);
}

/** `PUT /reports/{id}` body; `keyImages` only when their order or captions change. */
export function updateRequest(
  sections: ReportSections,
  rowVersion: number,
  keyImages?: readonly KeyImageOrderItem[],
): UpdateReportRequest {
  return { ...sections, ...(keyImages ? { keyImages: [...keyImages] } : {}), rowVersion };
}

export function orderedKeyImages(report: Pick<ReportDto, 'keyImages'>): ReportKeyImageDto[] {
  return [...report.keyImages].sort((a, b) => a.position - b.position);
}

/**
 * Every key image once, in order, for `PUT`: `caption` null keeps the stored caption, except for
 * the one image whose caption is being changed.
 */
export function keyImageItems(
  ids: readonly string[],
  change?: { id: string; caption: string },
): KeyImageOrderItem[] {
  return ids.map((id) => ({ id, caption: change && change.id === id ? change.caption : null }));
}

/** The report as it looks after a key image change, shown before the server answers. */
export function withKeyImages(report: ReportDto, items: readonly KeyImageOrderItem[]): ReportDto {
  const byId = new Map(report.keyImages.map((k) => [k.id, k]));
  const keyImages = items.flatMap((item, position) => {
    const image = byId.get(item.id);
    return image
      ? [{ ...image, position, caption: item.caption !== null ? item.caption : image.caption }]
      : [];
  });
  return { ...report, keyImages };
}

/** Versions the user may see, newest first: researchers only see signed (FINAL) reports. */
export function visibleReports<T extends ReportSummaryDto>(
  reports: readonly T[],
  canViewDraft: boolean,
): T[] {
  return [...reports]
    .filter((r) => canViewDraft || r.status === 'FINAL')
    .sort((a, b) => b.version - a.version);
}

/** The study's draft, if any (at most one at a time). */
export function currentDraft<T extends ReportSummaryDto>(reports: readonly T[]): T | null {
  return reports.find((r) => r.status === 'DRAFT') ?? null;
}

/** Latest version, the one a study's report status refers to. */
export function latestReport<T extends ReportSummaryDto>(reports: readonly T[]): T | null {
  return reports.reduce<T | null>(
    (latest, r) => (!latest || r.version > latest.version ? r : latest),
    null,
  );
}

/** A FINAL report can be amended when no draft is open already. */
export function canAmend(
  report: Pick<ReportSummaryDto, 'id' | 'status'>,
  reports: readonly ReportSummaryDto[],
): boolean {
  return (
    report.status === 'FINAL' && !currentDraft(reports) && latestReport(reports)?.id === report.id
  );
}

export function keyImageSlotsLeft(report: Pick<ReportDto, 'keyImages'>): number {
  return Math.max(0, KEY_IMAGE_MAX_COUNT - report.keyImages.length);
}

/** Key images not uploaded yet (or whose upload failed) block the signature. */
export function pendingKeyImages(report: Pick<ReportDto, 'keyImages'>): number {
  return report.keyImages.filter((k) => !k.uploaded).length;
}

/** Key image ids with the one at `index` moved by `delta` places (clamped). */
export function moveKeyImage(ids: readonly string[], index: number, delta: number): string[] {
  const target = Math.min(ids.length - 1, Math.max(0, index + delta));
  if (target === index || index < 0 || index >= ids.length) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/** Signing needs a conclusion (the server checks it too). */
export function canFinalize(sections: Pick<ReportSections, 'impression'>): boolean {
  return sections.impression.trim().length > 0;
}
