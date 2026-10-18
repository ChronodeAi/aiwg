import { SessionContractError } from './contracts.js';

export type LimitOrigin = 'flag' | 'env' | 'config' | 'default';
export interface ImportByteLimits {
  maxRecordBytes: number;
  /** Zero means no per-source cap. */
  maxTotalBytes: number;
  limitOrigins?: Partial<Record<'maxRecordBytes' | 'maxTotalBytes', LimitOrigin>>;
}

export const DEFAULT_IMPORT_BYTE_LIMITS = Object.freeze({
  maxRecordBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});

export function resolveImportLimits(
  config?: { max_record_bytes?: number; max_source_bytes?: number },
  flags?: { maxRecordBytes?: string | number; maxSourceBytes?: string | number },
  env: NodeJS.ProcessEnv = process.env,
): ImportByteLimits {
  const resolve = (setting: 'max_record_bytes' | 'max_source_bytes', flag: string | number | undefined,
    fallback: number): { value: number; origin: LimitOrigin } => {
    const environmentValue = env[`AIWG_SESSIONS_IMPORT_${setting.toUpperCase()}`];
    const origin = flag !== undefined ? 'flag' : environmentValue !== undefined ? 'env'
      : config?.[setting] !== undefined ? 'config' : 'default';
    const input = flag ?? environmentValue ?? config?.[setting] ?? fallback;
    const value = typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : input;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < (setting === 'max_source_bytes' ? 0 : 1)) {
      throw new SessionContractError('INVALID_ARGUMENT',
        `sessions.import.${setting} (${origin}) must be ${setting === 'max_source_bytes' ? 'a non-negative' : 'a positive'} safe integer in bytes`);
    }
    return { value, origin };
  };
  const record = resolve('max_record_bytes', flags?.maxRecordBytes, DEFAULT_IMPORT_BYTE_LIMITS.maxRecordBytes);
  const source = resolve('max_source_bytes', flags?.maxSourceBytes, DEFAULT_IMPORT_BYTE_LIMITS.maxTotalBytes);
  return {
    maxRecordBytes: record.value,
    maxTotalBytes: source.value,
    limitOrigins: { maxRecordBytes: record.origin, maxTotalBytes: source.origin },
  };
}

export function assertImportByteLimit(
  limit: 'maxRecordBytes' | 'maxTotalBytes',
  limits: ImportByteLimits,
  observed: number,
): void {
  const configured = limits[limit];
  if (limit === 'maxTotalBytes' && configured === 0) return;
  if (observed > configured) {
    const setting = limit === 'maxRecordBytes' ? 'sessions.import.max_record_bytes' : 'sessions.import.max_source_bytes';
    const origin = limits.limitOrigins?.[limit] ?? 'default';
    throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED',
      `${setting} exceeded (configured=${configured}, observed=${observed}, origin=${origin})`,
      { limit, setting, configured, observed, origin });
  }
}
