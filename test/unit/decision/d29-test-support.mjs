/**
 * Shared support for the heavy D29 test files.
 *
 * Decision entry admission (admitEntry, artifactDigest) enforces a hardcoded
 * 1 s wall-clock budget via performance.now(); under CI load a corpus-sized
 * admission can trip 'time-budget' before the behaviour a test asserts. Like
 * #2848 (ensemble-study-collector.test.ts), these files freeze only
 * `performance` for the whole file, so that budget never measures runner load
 * while size, depth and count limits stay enforced and real setTimeout keeps
 * working. A test that installs its own fake timers adds ADMISSION_CLOCK to its
 * toFake list.
 */
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';

export const ADMISSION_CLOCK = Object.freeze(['performance']);

/** Registers the file-wide admission clock; call before any other hook so prepare hooks run under it. */
export function freezeAdmissionClock() {
  beforeAll(() => { vi.useFakeTimers({ toFake: [...ADMISSION_CLOCK] }); });
  beforeEach(() => { vi.useFakeTimers({ toFake: [...ADMISSION_CLOCK] }); });
  afterAll(() => { vi.useRealTimers(); });
}

const prepared = new Map();
/**
 * One preparation per key per test file (process-local module cache); each
 * caller receives its own deep copy, so a test that mutates its corpus never
 * affects another.
 */
export async function preparedOnce(key, make) {
  if (!prepared.has(key)) prepared.set(key, make());
  return structuredClone(await prepared.get(key));
}

/** Timeouts sized from CI under load (a v7 prepare hook took over 30 s, V8-06 over 120 s). */
export const PREPARE_HOOK_TIMEOUT = 300_000;
export const MULTI_AUDIT_TIMEOUT = 180_000;
