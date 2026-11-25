import { describe, expect, it } from 'vitest';
import { aiFinding, doctor, finalReport, report } from '@/test/fixtures';
import {
  canAmend,
  canFinalize,
  currentDraft,
  defaultLanguage,
  defaultTemplate,
  keyImageItems,
  keyImageSlotsLeft,
  latestReport,
  moveKeyImage,
  orderedKeyImages,
  pendingKeyImages,
  reviewedSince,
  sameSections,
  sectionsOf,
  updateRequest,
  visibleReports,
  withKeyImages,
} from './reportModel';

const v1 = finalReport({ id: 'r1', version: 1 });
const v2 = report({ id: 'r2', version: 2, amendsReportId: 'r1' });

describe('templates', () => {
  it('defaults by input type: 2D → chest X-ray, volumes → CT', () => {
    expect(defaultTemplate('IMAGE_2D')).toBe('CXR');
    expect(defaultTemplate('DICOM_2D')).toBe('CXR');
    expect(defaultTemplate('NIFTI')).toBe('CT');
    expect(defaultTemplate('DICOM_SERIES')).toBe('CT');
    expect(defaultTemplate('IMAGE_STACK')).toBe('CT');
  });

  it('defaults the language to the UI language', () => {
    expect(defaultLanguage('en')).toBe('en');
    expect(defaultLanguage('vi')).toBe('vi');
    expect(defaultLanguage('fr')).toBe('vi');
  });
});

describe('versions', () => {
  it('hides drafts from researchers and lists newest first', () => {
    expect(visibleReports([v1, v2], true).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(visibleReports([v2, v1], false).map((r) => r.id)).toEqual(['r1']);
  });

  it('finds the draft and the latest version', () => {
    expect(currentDraft([v1, v2])?.id).toBe('r2');
    expect(currentDraft([v1])).toBeNull();
    expect(latestReport([v1, v2])?.id).toBe('r2');
    expect(latestReport([])).toBeNull();
  });

  it('amends only the latest signed version, and only without an open draft', () => {
    expect(canAmend(v1, [v1])).toBe(true);
    expect(canAmend(v1, [v1, v2])).toBe(false);
    expect(canAmend(v2, [v1, v2])).toBe(false);
    const v3 = finalReport({ id: 'r3', version: 3 });
    expect(canAmend(v1, [v1, v3])).toBe(false);
  });
});

describe('sections', () => {
  it('reads null sections as empty text and compares them', () => {
    const sections = sectionsOf(report({ technique: null }));
    expect(sections.technique).toBe('');
    expect(sameSections(sections, { ...sections })).toBe(true);
    expect(sameSections(sections, { ...sections, impression: 'x' })).toBe(false);
    expect(updateRequest(sections, 7)).toEqual({ ...sections, rowVersion: 7 });
    expect(updateRequest(sections, 7, [{ id: 'k', caption: null }])).toEqual({
      ...sections,
      keyImages: [{ id: 'k', caption: null }],
      rowVersion: 7,
    });
  });

  it('needs an impression to sign', () => {
    expect(canFinalize({ impression: '  ' })).toBe(false);
    expect(canFinalize({ impression: 'Normal.' })).toBe(true);
  });
});

describe('refill hint', () => {
  const reviewed = (id: string, reviewedAt: string) =>
    aiFinding({
      id,
      reviewStatus: 'ACCEPTED',
      review: {
        status: 'ACCEPTED',
        label: null,
        note: null,
        reviewedBy: { id: doctor.id, fullName: doctor.fullName },
        reviewedAt,
      },
    });

  it('counts the findings reviewed after the draft was last saved', () => {
    const findings = [
      aiFinding({ id: 'pending' }),
      reviewed('before', '2026-11-25T09:00:00Z'),
      reviewed('same time', '2026-11-25T09:30:00Z'),
      reviewed('after', '2026-11-25T09:31:00.5Z'),
      reviewed('later', '2026-11-25T10:00:00Z'),
    ];
    expect(reviewedSince(findings, '2026-11-25T09:30:00Z')).toBe(2);
    expect(reviewedSince(findings, '2026-11-25T11:00:00Z')).toBe(0);
    expect(reviewedSince([], '2026-11-25T09:30:00Z')).toBe(0);
  });
});

describe('key images', () => {
  it('counts the free slots (6 at most)', () => {
    const image = { id: 'k', caption: '', position: 0, uploaded: true, url: '/k.png' };
    expect(keyImageSlotsLeft(report())).toBe(6);
    expect(keyImageSlotsLeft(report({ keyImages: Array(6).fill(image) }))).toBe(0);
  });

  it('lists every image once for PUT, changing one caption, null keeping the others', () => {
    expect(keyImageItems(['a', 'b'])).toEqual([
      { id: 'a', caption: null },
      { id: 'b', caption: null },
    ]);
    expect(keyImageItems(['a', 'b'], { id: 'b', caption: '' })).toEqual([
      { id: 'a', caption: null },
      { id: 'b', caption: '' },
    ]);
  });

  it('shows a new order and caption before the server answers', () => {
    const r = report({
      keyImages: [
        { id: 'a', caption: 'A', position: 0, uploaded: true, url: '/a' },
        { id: 'b', caption: 'B', position: 1, uploaded: false, url: null },
      ],
    });
    const next = withKeyImages(r, [
      { id: 'b', caption: null },
      { id: 'a', caption: 'A2' },
    ]);
    expect(orderedKeyImages(next).map((k) => [k.id, k.caption, k.position])).toEqual([
      ['b', 'B', 0],
      ['a', 'A2', 1],
    ]);
    expect(pendingKeyImages(r)).toBe(1);
  });

  it('moves one image up or down, clamped at the ends', () => {
    expect(moveKeyImage(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveKeyImage(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveKeyImage(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveKeyImage(['a', 'b', 'c'], 2, 5)).toEqual(['a', 'b', 'c']);
  });
});
