import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertImportByteLimit, resolveImportLimits } from '../../../src/sessions/import-limits.js';
import { DEFAULT_IMPORT_LIMITS } from '../../../src/sessions/importer.js';
import { DEFAULT_READER_LIMITS } from '../../../src/sessions/readers.js';

beforeEach(() => {
  vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', undefined);
  vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('session import byte limits', () => {
  it('defaults to 64 MiB records and 1 GiB sources in importer and readers', () => {
    const defaults = { maxRecordBytes: 64 * 1024 * 1024, maxTotalBytes: 1073741824 };
    expect(resolveImportLimits()).toMatchObject({ ...defaults,
      limitOrigins: { maxRecordBytes: 'default', maxTotalBytes: 'default' } });
    expect(DEFAULT_IMPORT_LIMITS).toMatchObject(defaults);
    expect(DEFAULT_READER_LIMITS).toMatchObject(defaults);
    expect(DEFAULT_READER_LIMITS).toMatchObject({ maxRecords: 1_000_000, maxNestingDepth: 64 });
  });

  it('resolves flags ahead of env, config and defaults independently', () => {
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', '300');
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', '400');
    const config = { max_record_bytes: 100, max_source_bytes: 200 };
    expect(resolveImportLimits(config)).toEqual({ maxRecordBytes: 300, maxTotalBytes: 400,
      limitOrigins: { maxRecordBytes: 'env', maxTotalBytes: 'env' } });
    expect(resolveImportLimits(config, { maxRecordBytes: '500' })).toEqual({
      maxRecordBytes: 500, maxTotalBytes: 400,
      limitOrigins: { maxRecordBytes: 'flag', maxTotalBytes: 'env' } });
    expect(resolveImportLimits(config, { maxSourceBytes: '0' })).toEqual({
      maxRecordBytes: 300, maxTotalBytes: 0,
      limitOrigins: { maxRecordBytes: 'env', maxTotalBytes: 'flag' } });
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', undefined);
    expect(resolveImportLimits(config)).toMatchObject({ maxTotalBytes: 200,
      limitOrigins: { maxTotalBytes: 'config' } });
    expect(resolveImportLimits()).toMatchObject({ maxTotalBytes: 1073741824,
      limitOrigins: { maxTotalBytes: 'default' } });
  });

  it.each(['', '1.5', '-1', 'Infinity', '1e3', '0x10', '9007199254740992', ' 5', '5 '])('rejects invalid env byte counts %j unless overridden by a flag', (input) => {
    for (const setting of ['RECORD', 'SOURCE']) {
      vi.stubEnv(`AIWG_SESSIONS_IMPORT_MAX_${setting}_BYTES`, input);
      expect(() => resolveImportLimits()).toThrow(/sessions.import.*env.*integer in bytes/);
      expect(() => resolveImportLimits(undefined, { maxRecordBytes: '1024', maxSourceBytes: '0' })).not.toThrow();
      vi.stubEnv(`AIWG_SESSIONS_IMPORT_MAX_${setting}_BYTES`, undefined);
    }
  });

  it('rejects zero env record bytes and allows unlimited source bytes for zero env source bytes', () => {
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', '0');
    expect(() => resolveImportLimits()).toThrow(/max_record_bytes.*env.*positive/);
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', undefined);
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', '0');
    const limits = resolveImportLimits({ max_source_bytes: 1 });
    expect(limits).toMatchObject({ maxTotalBytes: 0, limitOrigins: { maxTotalBytes: 'env' } });
    expect(() => assertImportByteLimit('maxTotalBytes', limits, 2 ** 40)).not.toThrow();
  });

  it('enforces the 1 GiB default source cap at its byte boundary', () => {
    const limits = resolveImportLimits();
    expect(() => assertImportByteLimit('maxTotalBytes', limits, 1073741824)).not.toThrow();
    expect(() => assertImportByteLimit('maxTotalBytes', limits, 1073741825))
      .toThrow(expect.objectContaining({ detail: { limit: 'maxTotalBytes',
        setting: 'sessions.import.max_source_bytes', configured: 1073741824,
        observed: 1073741825, origin: 'default' } }));
  });

  it('resolves each flag independently ahead of config and default', () => {
    expect(resolveImportLimits({ max_record_bytes: 100, max_source_bytes: 200 }, { maxRecordBytes: '300' }))
      .toEqual({ maxRecordBytes: 300, maxTotalBytes: 200,
        limitOrigins: { maxRecordBytes: 'flag', maxTotalBytes: 'config' } });
    expect(resolveImportLimits({ max_source_bytes: 200 }, { maxSourceBytes: '0' }))
      .toMatchObject({ maxRecordBytes: 64 * 1024 * 1024, maxTotalBytes: 0,
        limitOrigins: { maxRecordBytes: 'default', maxTotalBytes: 'flag' } });
  });

  it.each(['', '1.5', '-1', 'Infinity', '1e3', '0x10', '9007199254740992', ' 5'])('rejects invalid CLI byte counts %j', (input) => {
    for (const flags of [{ maxRecordBytes: input }, { maxSourceBytes: input }]) {
      expect(() => resolveImportLimits(undefined, flags)).toThrow(/sessions.import.*flag.*integer in bytes/);
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid configured record bytes %j', (input) => {
    expect(() => resolveImportLimits({ max_record_bytes: input })).toThrow(/max_record_bytes.*config/);
  });

  it('allows zero only for the source cap', () => {
    expect(() => resolveImportLimits(undefined, { maxRecordBytes: '0' })).toThrow(/positive/);
    const unlimited = resolveImportLimits({ max_source_bytes: 0 });
    expect(() => assertImportByteLimit('maxTotalBytes', unlimited, 2 ** 40)).not.toThrow();
  });

  it.each(['flag', 'env', 'config', 'default'] as const)('names the setting, configured and observed bytes and %s origin', (origin) => {
    const limits = resolveImportLimits(
      origin === 'config' ? { max_record_bytes: 1 } : undefined,
      origin === 'flag' ? { maxRecordBytes: '1' } : undefined,
      origin === 'env' ? { AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES: '1' } : {},
    );
    expect(() => assertImportByteLimit('maxRecordBytes', limits, limits.maxRecordBytes + 1))
      .toThrow(expect.objectContaining({ detail: { limit: 'maxRecordBytes',
        setting: 'sessions.import.max_record_bytes', configured: limits.maxRecordBytes,
        observed: limits.maxRecordBytes + 1, origin } }));
  });
});
