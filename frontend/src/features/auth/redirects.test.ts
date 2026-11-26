import { describe, expect, it } from 'vitest';
import { returnTarget } from './redirects';

describe('returnTarget', () => {
  it('goes back to the remembered in-app page', () => {
    expect(returnTarget({ from: '/cases?q=x' })).toBe('/cases?q=x');
    expect(returnTarget({ from: '/admin/users' })).toBe('/admin/users');
  });

  it('lands on the dashboard otherwise', () => {
    expect(returnTarget(null)).toBe('/dashboard');
    expect(returnTarget({})).toBe('/dashboard');
    expect(returnTarget({ from: '/' })).toBe('/dashboard');
    expect(returnTarget({ from: 42 })).toBe('/dashboard');
  });

  it('never returns to the login or password page, nor off-site', () => {
    expect(returnTarget({ from: '/login' })).toBe('/dashboard');
    expect(returnTarget({ from: '/account/password' })).toBe('/dashboard');
    expect(returnTarget({ from: '//evil.example/x' })).toBe('/dashboard');
    expect(returnTarget({ from: 'https://evil.example/' })).toBe('/dashboard');
  });
});
