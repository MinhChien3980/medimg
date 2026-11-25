import { describe, expect, it } from 'vitest';
import { aiFinding, doctor } from '@/test/fixtures';
import {
  applyReview,
  displayLabel,
  isReviewable,
  isUnreviewed,
  manualAuthor,
  replaceFinding,
  reviewedCount,
  reviewRequest,
} from './reviewModel';

const reviewer = { id: doctor.id, fullName: doctor.fullName };

describe('reviewRequest', () => {
  it('sends the version, the label only for EDITED and a trimmed note', () => {
    const f = aiFinding({ version: 3 });
    expect(reviewRequest(f, 'ACCEPTED', { label: 'ignored', note: '  ok  ' })).toEqual({
      status: 'ACCEPTED',
      note: 'ok',
      version: 3,
    });
    expect(reviewRequest(f, 'EDITED', { label: ' Pleural effusion ', note: '' })).toEqual({
      status: 'EDITED',
      label: 'Pleural effusion',
      version: 3,
    });
    expect(reviewRequest(f, 'REJECTED')).toEqual({ status: 'REJECTED', version: 3 });
  });
});

describe('applyReview', () => {
  it('shows the decision before the server answers', () => {
    const f = aiFinding({ label: 'Effusion' });
    const edited = applyReview(
      f,
      reviewRequest(f, 'EDITED', { label: 'Pleural effusion', note: 'small' }),
      reviewer,
      '2026-11-25T10:00:00Z',
    );
    expect(edited.reviewStatus).toBe('EDITED');
    expect(edited.review).toEqual({
      status: 'EDITED',
      label: 'Pleural effusion',
      note: 'small',
      reviewedBy: reviewer,
      reviewedAt: '2026-11-25T10:00:00Z',
    });
    expect(displayLabel(edited)).toBe('Pleural effusion');
    expect(edited.label).toBe('Effusion'); // the AI label is kept

    const rejected = applyReview(f, reviewRequest(f, 'REJECTED'), reviewer, 'now');
    expect(rejected.review?.label).toBeNull();
    expect(displayLabel(rejected)).toBe('Effusion');
  });
});

describe('status helpers', () => {
  it('counts reviewed findings and spots unreviewed ones', () => {
    const list = [
      aiFinding({ id: 'a' }),
      aiFinding({ id: 'b', reviewStatus: 'ACCEPTED' }),
      aiFinding({ id: 'c', reviewStatus: 'REJECTED' }),
    ];
    expect(reviewedCount(list)).toBe(2);
    expect(list.filter(isUnreviewed).map((f) => f.id)).toEqual(['a']);
  });

  it('only reviews AI findings', () => {
    expect(isReviewable(aiFinding())).toBe(true);
    expect(isReviewable(aiFinding({ source: 'MANUAL' }))).toBe(false);
  });

  it('replaces by id keeping the order', () => {
    const list = [aiFinding({ id: 'a' }), aiFinding({ id: 'b' })];
    const next = replaceFinding(list, aiFinding({ id: 'a', label: 'X' }));
    expect(next.map((f) => [f.id, f.label])).toEqual([
      ['a', 'X'],
      ['b', 'Finding'],
    ]);
  });
});

describe('manualAuthor', () => {
  const by = { id: doctor.id, fullName: doctor.fullName };
  const review = {
    status: 'ACCEPTED' as const,
    label: null,
    note: null,
    reviewedBy: by,
    reviewedAt: '2026-11-25T09:00:00Z',
  };

  it('is the reviewer of a MANUAL finding, which is accepted by whoever adds it', () => {
    expect(manualAuthor(aiFinding({ source: 'MANUAL', review }))).toEqual(by);
  });

  it('is null for an AI finding, even when it was reviewed', () => {
    expect(manualAuthor(aiFinding({ source: 'AI', review }))).toBeNull();
  });
});
