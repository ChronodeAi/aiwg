import { describe, expect, it } from 'vitest';
import { assertImportByteLimit, resolveImportLimits } from '../../../src/sessions/import-limits.js';
import { DEFAULT_IMPORT_LIMITS } from '../../../src/sessions/importer.js';
import { DEFAULT_READER_LIMITS } from '../../../src/sessions/readers.js';

describe('session import byte limits', () => {
  it('defaults to 64 MiB records and unlimited sources in importer and readers', () => {
    const defaults = { maxRecordBytes: 64 * 1024 * 1024, maxTotalBytes: 0 };
    expect(resolveImportLimits()).toMatchObject({ ...defaults,
      limitOrigins: { maxRecordBytes: 'default', maxTotalBytes: 'default' } });
    expect(DEFAULT_IMPORT_LIMITS).toMatchObject(defaults);
    expect(DEFAULT_READER_LIMITS).toMatchObject(defaults);
    expect(DEFAULT_READER_LIMITS).toMatchObject({ maxRecords: 1_000_000, maxNestingDepth: 64 });
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

  it.each(['flag', 'config', 'default'] as const)('names the setting, configured and observed bytes and %s origin', (origin) => {
    const limits = resolveImportLimits(
      origin === 'config' ? { max_record_bytes: 1 } : undefined,
      origin === 'flag' ? { maxRecordBytes: '1' } : undefined,
    );
    expect(() => assertImportByteLimit('maxRecordBytes', limits, limits.maxRecordBytes + 1))
      .toThrow(expect.objectContaining({ detail: { limit: 'maxRecordBytes',
        setting: 'sessions.import.max_record_bytes', configured: limits.maxRecordBytes,
        observed: limits.maxRecordBytes + 1, origin } }));
  });
});
