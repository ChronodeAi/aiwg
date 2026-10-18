/**
 * CLI startup-performance gate.
 *
 * Asserts the CLI cold-start budget so a regression that adds a heavy
 * top-level import or reintroduces the tsx fork fails CI instead of quietly
 * shipping a 500ms `aiwg --version`.
 *
 * Strategy: discard one cache-cold run, then sandwich every CLI measurement
 * between Node startup baselines, and measure each one's own CPU time (user
 * + system, reported by the child itself via `cpu-usage-preload.cjs`) rather
 * than parent-observed wall-clock time. Take the p50 of those paired CPU
 * overheads so shared-runner drift is calibrated at measurement time.
 *
 * Why CPU time, not wall time (#3047): this gate used to measure wall-clock
 * overhead, and under host scheduling contention (load average far above
 * core count) a process waiting for a CPU timeslice looks identical to a
 * process doing more work -- both take longer wall-clock time. That made a
 * `--version` cold start measure 220ms against the 150ms budget on a loaded
 * host that measured 31-36ms moments later on the same commit. CPU time
 * does not have this problem: a process that is merely waiting for the
 * scheduler does not accumulate CPU time, so the same fixed amount of real
 * work reports (approximately) the same CPU-time overhead whether the host
 * is idle or heavily loaded. `spawnSync` does not expose a child's rusage,
 * so each measured process (both the command and its bare-`node` baseline)
 * reports its own `process.cpuUsage()` on fd 3 at exit; see
 * test/helpers/cpu-usage-preload.cjs and test/helpers/cli-perf-measure.ts.
 *
 * A statistic that reports the *minimum* paired overhead instead of the
 * median would be fooled by a single sample whose baseline alone (not the
 * command) happened to be measured slow -- that cancels out of
 * `max(0, command - baseline)` and reports 0ms for a sample that actually
 * paid the full cost. `summarizePairedTimings`'s median is not fooled by
 * that; test/unit/cli/perf-policy.test.ts pins the property directly, and
 * this file's "flags an injected CPU-burn regression" test below proves the
 * full spawn+preload+measure pipeline still catches a real regression.
 *
 * Also run with `--trace-exit` and assert no "active handles at exit" warnings
 * — catches the handle-leak class of bug (#918).
 *
 * Budgets (from epic #924 and #923 targets):
 *   `aiwg --version` overhead ≤ 150ms (tight budget, no room for tsx forks)
 *   `aiwg help`     overhead ≤ 750ms under suite load (500ms isolated target)
 *
 * Overridable via env for slow CI machines:
 *   AIWG_PERF_BUDGET_VERSION_MS (default 150)
 *   AIWG_PERF_BUDGET_HELP_MS    (default 750)
 *   AIWG_PERF_SAMPLE_COUNT      (default 7; odd integer >= 3)
 *
 * Phase 5 of the CLI Stabilization Epic (#922).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { parsePositiveInt } from '../helpers/cli-perf-policy.js';
import { measurePairedCpu } from '../helpers/cli-perf-measure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_PATH = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'router.js');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'aiwg.mjs');
const SYNTHETIC_DELAY_FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'cli-perf', 'synthetic-delay.mjs');

const missingBuild = !existsSync(ROUTER_PATH);

// #1302: `aiwg --version` now has a package-metadata fast path and is back
// under the original tight budget. `help` still pays router startup cost under
// parallel load, and the default Fortemi index integration adds more packaged
// command/search surface to load, so keep its realistic full-suite budget until
// a separate help-path optimization lands.
const VERSION_BUDGET_MS = parseIntEnv('AIWG_PERF_BUDGET_VERSION_MS', 150);
const HELP_BUDGET_MS = parseIntEnv('AIWG_PERF_BUDGET_HELP_MS', 750);
const SAMPLE_COUNT = parsePositiveInt(process.env.AIWG_PERF_SAMPLE_COUNT, 7, {
  minimum: 3,
  odd: true,
});

const PERF_ENV = {
  ...process.env,
  AIWG_LOG_DISABLE: '1',
  NO_UPDATE_NOTIFIER: '1',
  AIWG_NO_UPDATE_CHECK: '1',
};

function parseIntEnv(name: string, def: number): number {
  return parsePositiveInt(process.env[name], def);
}

function measurePaired(args: string[]) {
  return measurePairedCpu(process.execPath, [BIN_PATH, ...args], PERF_ENV, SAMPLE_COUNT);
}

function logMeasurement(command: string, summary: ReturnType<typeof measurePaired>, budget: number) {
  // eslint-disable-next-line no-console
  console.log(
    `${command}: command CPU p50=${summary.commandMedianMs.toFixed(1)}ms; `
    + `paired node CPU p50=${summary.baselineMedianMs.toFixed(1)}ms; `
    + `CPU overhead p50=${summary.overheadMedianMs.toFixed(1)}ms `
    + `(range ${summary.overheadMinMs.toFixed(1)}-${summary.overheadMaxMs.toFixed(1)}ms, `
    + `n=${SAMPLE_COUNT}, budget ${budget}ms)`,
  );
}

describe.skipIf(missingBuild)('CLI performance gate', () => {
  it(`aiwg --version cold start p50 under ${VERSION_BUDGET_MS}ms`, () => {
    const summary = measurePaired(['--version']);
    logMeasurement('aiwg --version', summary, VERSION_BUDGET_MS);
    expect(summary.overheadMedianMs).toBeLessThan(VERSION_BUDGET_MS);
  }, 20_000);

  it(`aiwg help cold start p50 under ${HELP_BUDGET_MS}ms`, () => {
    const summary = measurePaired(['help']);
    logMeasurement('aiwg help', summary, HELP_BUDGET_MS);
    expect(summary.overheadMedianMs).toBeLessThan(HELP_BUDGET_MS);
  }, 20_000);

  /**
   * --trace-exit prints "There are still active handles at exit" when the
   * event loop has pending work at process exit. A failure here catches
   * the class of bug from #918 where unawaited promises held the event
   * loop open for minutes.
   */
  it('aiwg --version exits cleanly (no active handles warning)', () => {
    const result = spawnSync(process.execPath, ['--trace-exit', BIN_PATH, '--version'], {
      timeout: 5_000,
      stdio: 'pipe',
      encoding: 'utf-8',
      env: {
        ...process.env,
        AIWG_LOG_DISABLE: '1',
        NO_UPDATE_NOTIFIER: '1',
        AIWG_NO_UPDATE_CHECK: '1',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/active handles/i);
    expect(result.stderr).not.toMatch(/timer/i);
  });
});

/**
 * Proves the CPU-time measurement pipeline (spawn + cpu-usage-preload.cjs +
 * summarizePairedTimings) actually catches a real regression end to end --
 * not only that its pure math does (test/unit/cli/perf-policy.test.ts) --
 * by injecting a genuine CPU-burning delay into the measured command via a
 * throwaway fixture script (test/fixtures/cli-perf/synthetic-delay.mjs) and
 * asserting the gate flags it. Independent of `dist/` (the fixture is not
 * the real CLI), so it runs even when `describe.skipIf(missingBuild)` above
 * skips the real gate.
 */
describe('CLI performance gate measurement correctness (#3047)', () => {
  // Tight on purpose: the fixture with no injected burn costs near-zero CPU
  // (reading one env var, no I/O), so any reasonable regression -- even far
  // below the real gate's 150ms budget -- must still clear this.
  const REGRESSION_TEST_BUDGET_MS = 20;
  const REGRESSION_SAMPLE_COUNT = 5;

  it('flags an injected CPU-burn regression in the measured command', () => {
    const env = { ...PERF_ENV, AIWG_PERF_TEST_CPU_BURN_MS: '60' };
    const summary = measurePairedCpu(
      process.execPath, [SYNTHETIC_DELAY_FIXTURE], env, REGRESSION_SAMPLE_COUNT,
    );
    expect(summary.overheadMedianMs).toBeGreaterThanOrEqual(REGRESSION_TEST_BUDGET_MS);
  }, 20_000);

  it('does not flag the same fixture with no injected delay', () => {
    const env = { ...PERF_ENV, AIWG_PERF_TEST_CPU_BURN_MS: '0' };
    const summary = measurePairedCpu(
      process.execPath, [SYNTHETIC_DELAY_FIXTURE], env, REGRESSION_SAMPLE_COUNT,
    );
    expect(summary.overheadMedianMs).toBeLessThan(REGRESSION_TEST_BUDGET_MS);
  }, 20_000);
});
