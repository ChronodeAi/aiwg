import { AiwgError } from '../cli/errors.js';

/** Public maintenance command statuses; legacy storage commands retain their contract. */
export const MEMORY_EXIT_CODES = { success: 0, findings: 1, usage: 2, failed: 3 } as const;
export const MEMORY_EXIT_USAGE = 'Exit codes: 0 success/no findings/help; 1 findings; 2 usage or malformed input; 3 stale or failed operation.';

export function memoryUsage<T>(read: () => T): T {
  try { return read(); }
  catch (cause) {
    throw new AiwgError({ code: 'ERR_USAGE_MEMORY', exitCode: MEMORY_EXIT_CODES.usage,
      message: cause instanceof Error ? cause.message : String(cause), cause });
  }
}

export async function memoryInput<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (cause) { return memoryUsage(() => { throw cause; }); }
}
