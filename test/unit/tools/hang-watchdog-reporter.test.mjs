/**
 * Stalled-suite watchdog reporter.
 *
 * The default reporter prints a test file only once that file has finished, so
 * a wedged worker is invisible: run 59128 went silent for three hours without
 * naming anything. This reporter names the modules still in flight and the
 * phase each one reached.
 *
 * @issue #2521
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import HangWatchdogReporter, {
  parseStallMs,
  formatStallReport,
} from '../../../tools/ci/hang-watchdog-reporter.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Build the module-state map the reporter keeps, without running vitest. */
function moduleState(entries) {
  return new Map(entries.map((entry) => [entry.moduleId, entry]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseStallMs', () => {
  it('defaults when the override is absent or unusable', () => {
    // A misread threshold would either spam a healthy run or stay silent on a
    // wedged one, so junk falls back rather than propagating.
    for (const bad of [undefined, '', 'soon', '0', '-5', 'NaN']) {
      expect(parseStallMs(bad), String(bad)).toBe(120_000);
    }
  });

  it('accepts an explicit millisecond override', () => {
    expect(parseStallMs('1500')).toBe(1_500);
    expect(parseStallMs(' 90000 ')).toBe(90_000);
    expect(parseStallMs('250', 5_000)).toBe(250);
  });
});

describe('formatStallReport', () => {
  const options = { now: 100_000, stallMs: 10_000, lastProgressAt: 80_000, root: '/repo' };

  it('says nothing when every module has finished', () => {
    const report = formatStallReport(
      moduleState([{ moduleId: '/repo/test/a.test.ts', phase: 'ended', since: 0 }]),
      options,
    );
    expect(report).toBeNull();
  });

  it('names a module wedged while loading and flags the unguarded phase', () => {
    // Collection runs before any vitest timeout exists, so this phase is the
    // one where a synchronous block is completely unbounded.
    const report = formatStallReport(
      moduleState([{ moduleId: '/repo/test/integration/slow.test.ts', phase: 'loading', since: 40_000 }]),
      options,
    );
    expect(report).toContain('1 module(s) still in flight');
    expect(report).toContain('test/integration/slow.test.ts — loading for 60s');
    expect(report).toContain('collection has no vitest timeout');
  });

  it('names the last test and hook seen for a module wedged while running', () => {
    const report = formatStallReport(
      moduleState([{
        moduleId: '/repo/test/integration/use-all.test.ts',
        phase: 'running',
        since: 70_000,
        lastCase: 'deploys everything (started)',
        lastHook: 'beforeEach (finished)',
      }]),
      options,
    );
    expect(report).toContain('test/integration/use-all.test.ts — running for 30s');
    expect(report).toContain('last test: deploys everything (started)');
    expect(report).toContain('last hook: beforeEach (finished)');
    expect(report).not.toContain('collection has no vitest timeout');
  });

  it('reports how long the run has been silent and lists the oldest module first', () => {
    const report = formatStallReport(
      moduleState([
        { moduleId: '/repo/test/b.test.ts', phase: 'running', since: 90_000 },
        { moduleId: '/repo/test/a.test.ts', phase: 'loading', since: 10_000 },
        { moduleId: '/repo/test/done.test.ts', phase: 'ended', since: 0 },
      ]),
      options,
    );
    expect(report).toContain('no test module has made progress for 20s (threshold 10s)');
    expect(report).toContain('2 module(s) still in flight');
    expect(report.indexOf('test/a.test.ts')).toBeLessThan(report.indexOf('test/b.test.ts'));
  });
});

describe('reporter lifecycle', () => {
  /** Drive the lifecycle hooks vitest calls, with no vitest involved. */
  function reporterWith(moduleId) {
    const reporter = new HangWatchdogReporter();
    reporter.stallMs = 10_000;
    reporter.root = '/repo';
    reporter.onTestModuleQueued({ moduleId });
    return reporter;
  }

  it('stays silent until the stall threshold is crossed', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const reporter = reporterWith('/repo/test/a.test.ts');

    reporter.tick(reporter.lastProgressAt + 9_999);
    expect(write).not.toHaveBeenCalled();

    reporter.tick(reporter.lastProgressAt + 10_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain('test/a.test.ts — loading');
  });

  it('reports once per threshold rather than once per poll', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const reporter = reporterWith('/repo/test/a.test.ts');
    const start = reporter.lastProgressAt;

    reporter.tick(start + 10_000);
    reporter.tick(start + 15_000);
    expect(write).toHaveBeenCalledTimes(1);
    reporter.tick(start + 20_000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('treats module and test-case events as progress', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const reporter = reporterWith('/repo/test/a.test.ts');

    reporter.onTestCaseReady({ name: 'slow case', module: { moduleId: '/repo/test/a.test.ts' } });
    reporter.tick(reporter.lastProgressAt + 9_000);
    expect(write).not.toHaveBeenCalled();

    reporter.tick(reporter.lastProgressAt + 10_000);
    expect(write.mock.calls[0][0]).toContain('last test: slow case (started)');
  });

  it('falls silent once the module ends', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const reporter = reporterWith('/repo/test/a.test.ts');
    reporter.onTestModuleEnd({ moduleId: '/repo/test/a.test.ts' });

    reporter.tick(reporter.lastProgressAt + 60_000);
    expect(write).not.toHaveBeenCalled();
  });

  it('ignores events carrying no module id instead of throwing', () => {
    const reporter = new HangWatchdogReporter();
    expect(() => {
      reporter.onTestModuleQueued(undefined);
      reporter.onHookStart({ name: 'beforeAll', entity: undefined });
      reporter.onTestCaseResult({ name: 'x' });
    }).not.toThrow();
    expect(reporter.modules.size).toBe(0);
  });

  it('arms an unref()d timer so it can never hold the process open', () => {
    const reporter = new HangWatchdogReporter();
    reporter.onTestRunStart();
    expect(reporter.timer).not.toBeNull();
    expect(reporter.timer.hasRef()).toBe(false);
    reporter.onTestRunEnd();
    expect(reporter.timer).toBeNull();
  });
});

describe('end to end', () => {
  it('names the stalled module in a real vitest run', () => {
    // The real failure mode for this instrumentation is a reporter path vitest
    // cannot load, which no unit test would catch. Runs the fixture in its own
    // vitest with the default config so the parent lane is untouched.
    const run = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run',
        '--root', REPO_ROOT,
        '--dir', 'test/fixtures/hang-watchdog',
        '--pool', 'threads',
        '--reporter', 'default',
        '--reporter', './tools/ci/hang-watchdog-reporter.mjs',
      ],
      {
        encoding: 'utf8',
        timeout: 120_000,
        cwd: REPO_ROOT,
        env: { ...process.env, CI: '', AIWG_HANG_WATCHDOG_STALL_MS: '1000' },
      },
    );

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stderr).toMatch(/\[hang-watchdog] no test module has made progress/);
    // The module and its phase are what a wedged run needs; per-case detail is
    // not asserted here because vitest batches task updates inside the worker,
    // so a synchronously blocked thread never flushes them (see the reporter).
    expect(run.stderr).toContain('test/fixtures/hang-watchdog/stall.test.mjs — running');
  }, 130_000);
});
