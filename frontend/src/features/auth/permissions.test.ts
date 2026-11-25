import { describe, expect, it } from 'vitest';
import type { Role, UserDto } from '@/api/types';
import { doctor } from '@/test/fixtures';
import { can, type Permission } from './permissions';

const ALL: Permission[] = ['createCase', 'upload', 'runAi', 'manageJob'];

function withRoles(...roles: Role[]): UserDto {
  return { ...doctor, roles };
}

describe('can', () => {
  it.each<Role>(['ADMIN', 'DOCTOR', 'TECHNICIAN'])('%s may perform every write action', (role) => {
    for (const permission of ALL) expect(can(withRoles(role), permission)).toBe(true);
  });

  it('RESEARCHER is read-only', () => {
    for (const permission of ALL) expect(can(withRoles('RESEARCHER'), permission)).toBe(false);
  });

  it('grants a permission when any of the roles has it', () => {
    expect(can(withRoles('RESEARCHER', 'TECHNICIAN'), 'upload')).toBe(true);
  });

  it('denies everything without a user or with unknown roles', () => {
    expect(can(null, 'createCase')).toBe(false);
    expect(can({ ...doctor, roles: ['UNKNOWN' as Role] }, 'runAi')).toBe(false);
  });
});
