/**
 * Regression test for #3062 finding 17: a `long`-tier bounded-helper
 * timeout must not be silently lost by EvalHarness's default command
 * runner. Before the fix, the catch block only captured `err.stdout` /
 * `err.stderr` — never `err.message`, which is the only place the bounded
 * helper's enriched explanation (naming the tier, the bound, and the
 * AIWG_SYNC_LONG_TIMEOUT_MS override) lives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EvalHarness } from '../../../tools/ralph-external/eval-harness.mjs';
import { AIWG_SYNC_LONG_TIMEOUT_MS_ENV } from '../../../src/process/bounded-child-process.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ignoreSigtermScript = join(here, '../../fixtures/process/ignore-sigterm.mjs');

describe('EvalHarness default runner — long-tier timeout diagnostics (#3062 finding 17)', () => {
  const originalEnv = process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
  let iterationDir;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
    else process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = originalEnv;
    if (iterationDir) rmSync(iterationDir, { recursive: true, force: true });
    iterationDir = undefined;
  });

  it('surfaces the enriched timeout message in the private diagnostics instead of dropping it', () => {
    // Lower the (otherwise fixed 10-minute) long-tier bound so the lint
    // instrument — a child that ignores SIGTERM — times out quickly.
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '300';
    iterationDir = mkdtempSync(join(tmpdir(), 'aiwg-eval-harness-timeout-'));

    const harness = new EvalHarness({
      lint: { command: `node ${JSON.stringify(ignoreSigtermScript)}`, void_on_violation: false },
    });
    harness.run({ iterationDir });

    const privateDiagnostics = JSON.parse(readFileSync(join(iterationDir, 'eval-harness-private.json'), 'utf8'));
    const lintText = privateDiagnostics.instruments.lint?.raw_text ?? '';

    expect(lintText).toContain("'long' tier bound of 300ms");
    expect(lintText).toContain(AIWG_SYNC_LONG_TIMEOUT_MS_ENV);
  });
});
