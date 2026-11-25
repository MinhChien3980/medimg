/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '@/i18n/locales/en';
import { vi as viMessages } from '@/i18n/locales/vi';

/** The report PDF names the structures with core-service's own message bundles. */
function reportBundle(language: 'vi' | 'en'): string {
  const path = `../../../../backend/core-service/src/main/resources/report/messages_${language}.properties`;
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** `structure.<label>=<name>` entries of a report message bundle. */
function reportStructureNames(properties: string): Record<string, string> {
  return Object.fromEntries(
    properties
      .split(/\r?\n/)
      .map((line) => /^structure\.(\w+)=(.*)$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m): [string, string] => [m[1] ?? '', m[2] ?? '']),
  );
}

describe('structure names', () => {
  it('are the same in the viewer and in the report PDF', () => {
    expect(Object.keys(viMessages.structures)).toHaveLength(21);
    expect(reportStructureNames(reportBundle('vi'))).toEqual(viMessages.structures);
    expect(reportStructureNames(reportBundle('en'))).toEqual(en.structures);
  });
});
