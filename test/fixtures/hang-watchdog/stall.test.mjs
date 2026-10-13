/**
 * Fixture for test/unit/tools/hang-watchdog-reporter.test.mjs — not part of any
 * lane (no parent config's `include` matches `test/fixtures/**`).
 *
 * The block is synchronous on purpose: it mirrors the wedge shape in #2521,
 * where the worker thread cannot run its own testTimeout timer, so the main
 * process's watchdog is the only thing that can report anything.
 */

import { it } from 'vitest';

it('goes quiet long enough to trip the watchdog', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
}, 30_000);
