import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchImportExclusion, resolveImportExclusions } from '../../../src/sessions/import-exclusions.js';

afterEach(() => vi.unstubAllEnvs());

const source = { provider: 'codex' as const, locatorClass: 'codex-rollout-jsonl',
  locator: '/sessions/2026/10/rollout-2026-10-18T10-02-00-12345678-1234-1234-1234-123456789abc.jsonl' };

describe('session import exclusions', () => {
  it('adds config, comma-separated env and repeated flag entries', () => {
    vi.stubEnv('AIWG_SESSIONS_IMPORT_EXCLUDE', 'env-id, /env/**,config-id');
    expect(resolveImportExclusions({ exclude: ['config-id'] }, ['flag-id', '/flag/?*.jsonl']))
      .toEqual(['config-id', 'env-id', '/env/**', 'flag-id', '/flag/?*.jsonl']);
  });

  it('matches native metadata and Codex rollout filename IDs exactly', () => {
    const entry = '12345678-1234-1234-1234-123456789abc';
    expect(matchImportExclusion(source, [entry])).toEqual({ entry, kind: 'session-id' });
    expect(matchImportExclusion({ ...source, nativeSessionId: 'metadata-id' }, ['metadata-id']))
      .toEqual({ entry: 'metadata-id', kind: 'session-id' });
    expect(matchImportExclusion(source, ['12345678', entry.toUpperCase()])).toBeUndefined();
  });

  it.each([
    ['/sessions/**/*.jsonl', true], ['/sessions/**/rollout-*.jsonl', true],
    ['/sessions/*/*.jsonl', false], ['/sessions/2026/10/rollout-?026-*.jsonl', true],
    ['/sessions/2026/10/rollout-?26-*.jsonl', false], ['/sessions/2026/10/*.json', false],
  ])('matches path glob %s with result %s', (entry, matches) => {
    expect(matchImportExclusion(source, [entry])).toEqual(matches ? { entry, kind: 'path-glob' } : undefined);
  });

  it('supports zero directories for **/ and expands ~ using home', () => {
    expect(matchImportExclusion({ ...source, locator: '/sessions/one.jsonl' }, ['/sessions/**/*.jsonl']))
      .toMatchObject({ kind: 'path-glob' });
    vi.stubEnv('HOME', '/tmp/exclusion-home');
    expect(matchImportExclusion({ ...source, locator: `${homedir()}/.codex/sessions/one.jsonl` }, ['~/.codex/**/*.jsonl']))
      .toEqual({ entry: '~/.codex/**/*.jsonl', kind: 'path-glob' });
  });

  it.each([null, 'id', [null], [4], [''], ['  '], ['relative/*.jsonl'], ['*.jsonl'], ['~other/*.jsonl']])(
    'rejects invalid config exclusions %j', exclude => {
      expect(() => resolveImportExclusions({ exclude: exclude as string[] }, [], {})).toThrow('sessions.import.exclude');
    },
  );

  it('rejects invalid env and flag exclusions', () => {
    expect(() => resolveImportExclusions(undefined, [], { AIWG_SESSIONS_IMPORT_EXCLUDE: 'id,,other' })).toThrow('sessions.import.exclude');
    expect(() => resolveImportExclusions(undefined, ['relative/*'], {})).toThrow('absolute');
  });
});
