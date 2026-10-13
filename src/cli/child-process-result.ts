/**
 * Shared `spawnSync`/`boundedSpawnSync` result-to-exit-code mapping (#3062
 * review item 7).
 *
 * `SpawnSyncReturns.status` is `null` on spawn failure, timeout, or signal
 * termination — not `0`. Several call sites derived a CLI exit code with
 * `result.status ?? 0`, which reports *success* for exactly those failure
 * cases. This helper never does that: a `status` of `null` defaults to a
 * non-zero exit, and when the bounded helper's `error`/`signal` fields are
 * present, their message (already enriched with the tier/bound/override
 * guidance for a timeout) is surfaced instead of being silently dropped.
 *
 * Deliberately lives under `src/cli/` rather than `src/process/` so it
 * composes with, but does not modify, the bounded helper itself.
 *
 * @module src/cli/child-process-result
 */

/** The subset of `SpawnSyncReturns` this helper needs — works for both the
 * native and `boundedSpawnSync`/`launchWithProfile` return shapes. */
export interface SpawnResultLike {
  status?: number | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
}

export interface SpawnExitOutcome {
  /** Never derived from a `null`/missing status as success. */
  exitCode: number;
  /** Present when `error`/`signal` explain why `exitCode` is non-zero. */
  message?: string;
}

/**
 * Map one spawn result to `{ exitCode, message? }`.
 *
 * - `result.error` set (spawn failure, or a bounded-helper timeout with its
 *   enriched message) → non-zero, `message` is `error.message` (optionally
 *   prefixed with `context`).
 * - No `error`, but `result.signal` set (child killed by a signal, with no
 *   separate error object) → non-zero, `message` names the signal.
 * - Otherwise → `result.status ?? 1` (a `null`/`undefined` status with
 *   neither `error` nor `signal` set is still treated as a failure, never
 *   as success).
 */
export function exitCodeForSpawnResult(result: SpawnResultLike, context?: string): SpawnExitOutcome {
  const prefix = context ? `${context}: ` : '';
  if (result.error) {
    return { exitCode: 1, message: `${prefix}${result.error.message}` };
  }
  if (result.signal) {
    return { exitCode: 1, message: `${prefix}terminated by signal ${result.signal}` };
  }
  return { exitCode: result.status ?? 1 };
}
