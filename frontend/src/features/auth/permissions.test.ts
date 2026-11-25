import { describe, expect, it } from 'vitest';
import type { Role, UserDto } from '@/api/types';
import { doctor } from '@/test/fixtures';
import { can, canEditAnnotation, type Permission } from './permissions';

const WRITE: Permission[] = ['createCase', 'upload', 'runAi', 'manageJob'];
const CLINICAL: Permission[] = ['review', 'annotate', 'report'];
const ALL: Permission[] = [...WRITE, ...CLINICAL, 'manageSamples', 'viewDraftReport'];

function withRoles(...roles: Role[]): UserDto {
  return { ...doctor, roles };
}

describe('can', () => {
  it.each<Role>(['ADMIN', 'DOCTOR', 'TECHNICIAN'])('%s may perform every write action', (role) => {
    for (const permission of WRITE) expect(can(withRoles(role), permission)).toBe(true);
  });

  it('only ADMIN manages sample cases', () => {
    expect(can(withRoles('ADMIN'), 'manageSamples')).toBe(true);
    for (const role of ['DOCTOR', 'TECHNICIAN', 'RESEARCHER'] as const) {
      expect(can(withRoles(role), 'manageSamples')).toBe(false);
    }
  });

  it('RESEARCHER is read-only and sees no draft report', () => {
    for (const permission of ALL) expect(can(withRoles('RESEARCHER'), permission)).toBe(false);
  });

  it.each<[Role, Permission[], Permission[]]>([
    ['DOCTOR', ['review', 'annotate', 'report', 'viewDraftReport'], []],
    ['TECHNICIAN', ['annotate', 'viewDraftReport'], ['review', 'report']],
    ['ADMIN', ['viewDraftReport'], ['review', 'annotate', 'report']],
  ])('%s: clinical permissions follow the access table', (role, granted, denied) => {
    for (const permission of granted) expect(can(withRoles(role), permission)).toBe(true);
    for (const permission of denied) expect(can(withRoles(role), permission)).toBe(false);
  });

  it('grants a permission when any of the roles has it', () => {
    expect(can(withRoles('RESEARCHER', 'TECHNICIAN'), 'upload')).toBe(true);
  });

  it('denies everything without a user or with unknown roles', () => {
    expect(can(null, 'createCase')).toBe(false);
    expect(can({ ...doctor, roles: ['UNKNOWN' as Role] }, 'runAi')).toBe(false);
  });
});

describe('canEditAnnotation', () => {
  it('lets only the author edit, and only while allowed to annotate', () => {
    expect(canEditAnnotation(doctor, doctor.id)).toBe(true);
    expect(canEditAnnotation(doctor, 'someone-else')).toBe(false);
    expect(canEditAnnotation(withRoles('TECHNICIAN'), doctor.id)).toBe(true);
    expect(canEditAnnotation(withRoles('ADMIN'), doctor.id)).toBe(false);
    expect(canEditAnnotation(null, doctor.id)).toBe(false);
  });
});
