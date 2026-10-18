/**
 * Vitest reporter that names the test files a stalled run is stuck on.
 *
 * Motivation (#2521): run 59128 printed its last `✓` and then went silent for
 * three hours. The two diagnostics added in 5adf4782f cover the cases either
 * side of this one — vitest's `hanging-process` reporter names an open handle
 * once the run *completes*, and tools/ci/run-with-hang-report.mjs names a
 * blocking child process at the wall-clock bound. Neither can say which test
 * file the run was still waiting on, and that was the one datum run 59128
 * needed: a wedged worker is invisible to the default reporter, which only
 * prints a file once that file has finished.
 *
 * So this reporter tracks the module lifecycle and, when nothing has made
 * progress for `stallMs`, writes the in-flight set to stderr with each module's
 * furthest phase. The phase matters for attribution:
 *
 *   - `loading` (queued, never collected) — wedged while importing/evaluating
 *     the test module. Collection has no vitest timeout at all, so this is the
 *     only phase where a synchronous block is completely unbounded.
 *   - `running` (collected or started, never ended) — wedged inside a test or
 *     hook; the last case and hook seen are reported with it. testTimeout and
 *     hookTimeout are timers on the worker's own thread, so they cannot fire
 *     while that thread is blocked in a synchronous call either.
 *
 * Module phase is the datum that survives a synchronous wedge. The last test
 * case and hook are reported too, but vitest batches task updates inside the
 * worker, so a thread blocked synchronously never flushes them — expect those
 * lines on an async stall (a promise that never settles) and not on a wedge.
 *
 * The watchdog timer is `.unref()`'d: it can never hold the process open, and
 * it still fires during a wedge because the live worker threads keep the main
 * loop alive. Reporting is best-effort by design — a diagnostic that throws is
 * worse than a partial one.
 */

import path from 'node:path';
import { renameSync, writeFileSync } from 'node:fs';

const DEFAULT_STALL_MS = 120_000;
/** Cap the poll interval so a long stall threshold still reports promptly. */
const MAX_POLL_MS = 30_000;

/** Parse a positive-integer millisecond override, ignoring junk. */
export function parseStallMs(raw, fallback = DEFAULT_STALL_MS) {
  const value = Number(String(raw ?? '').trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/**
 * Render the stall report for the modules that have not finished.
 *
 * Pure so the interesting behaviour is testable without running vitest:
 * returns `null` when there is nothing worth saying.
 */
export function formatStallReport(modules, { now, stallMs, lastProgressAt, root }) {
  const inFlight = [...modules.values()].filter((module) => module.phase !== 'ended');
  if (inFlight.length === 0) return null;

  const silentFor = Math.round((now - lastProgressAt) / 1000);
  const lines = [
    `\n[hang-watchdog] no test module has made progress for ${silentFor}s ` +
      `(threshold ${Math.round(stallMs / 1000)}s) — ${inFlight.length} module(s) still in flight (#2521):`,
  ];

  for (const module of inFlight.sort((a, b) => a.since - b.since)) {
    const relative = root ? path.relative(root, module.moduleId) : module.moduleId;
    lines.push(`  ${relative} — ${module.phase} for ${Math.round((now - module.since) / 1000)}s`);
    if (module.phase === 'loading') {
      lines.push('    collection has no vitest timeout; a synchronous call here is unbounded');
    }
    if (module.lastCase) lines.push(`    last test: ${module.lastCase}`);
    if (module.lastHook) lines.push(`    last hook: ${module.lastHook}`);
  }

  const resources = process.getActiveResourcesInfo?.() ?? [];
  const counts = {};
  for (const resource of resources) counts[resource] = (counts[resource] ?? 0) + 1;
  lines.push(`  main-process active resources: ${JSON.stringify(counts)}`);
  return lines.join('\n');
}

export default class HangWatchdogReporter {
  modules = new Map();
  stallMs = DEFAULT_STALL_MS;
  lastProgressAt = Date.now();
  root = process.cwd();
  timer = null;

  onInit(vitest) {
    this.stallMs = parseStallMs(process.env['AIWG_HANG_WATCHDOG_STALL_MS']);
    this.root = vitest?.config?.root ?? this.root;
  }

  onTestRunStart() {
    this.modules.clear();
    this.persistInFlight();
    this.lastProgressAt = Date.now();
    this.arm();
  }

  onTestRunEnd() {
    this.disarm();
  }

  onTestModuleQueued(module) {
    this.transition(module, 'loading');
  }

  onTestModuleCollected(module) {
    this.transition(module, 'running');
  }

  onTestModuleStart(module) {
    this.transition(module, 'running');
  }

  onTestModuleEnd(module) {
    this.transition(module, 'ended');
  }

  onTestCaseReady(testCase) {
    this.note(testCase?.module?.moduleId, { lastCase: `${nameOf(testCase)} (started)` });
  }

  onTestCaseResult(testCase) {
    this.note(testCase?.module?.moduleId, { lastCase: `${nameOf(testCase)} (finished)` });
  }

  onHookStart(hook) {
    this.note(moduleIdOf(hook?.entity), { lastHook: `${hook?.name} (started)` });
  }

  onHookEnd(hook) {
    this.note(moduleIdOf(hook?.entity), { lastHook: `${hook?.name} (finished)` });
  }

  /** Record a module phase change. Phases only ever move forward. */
  transition(module, phase) {
    const moduleId = module?.moduleId;
    if (!moduleId) return;
    this.lastProgressAt = Date.now();
    const existing = this.modules.get(moduleId);
    if (existing?.phase === phase) return;
    this.modules.set(moduleId, {
      ...existing,
      moduleId,
      phase,
      since: Date.now(),
    });
    this.persistInFlight();
  }

  /** Leave a crash-readable snapshot for the wrapper, even through npm. */
  persistInFlight() {
    const stateFile = process.env['AIWG_HANG_REPORT_STATE_FILE'];
    if (!stateFile) return;
    try {
      const snapshot = [...this.modules.values()]
        .filter((module) => module.phase !== 'ended')
        .map((module) => `  ${path.relative(this.root, module.moduleId)} — ${module.phase}`)
        .join('\n');
      // Rename prevents a crash during a write from destroying the last state.
      writeFileSync(`${stateFile}.next`, snapshot);
      renameSync(`${stateFile}.next`, stateFile);
    } catch {
      // Diagnostics must never fail a test run.
    }
  }

  /** Attach the last-seen case/hook to a module without changing its phase. */
  note(moduleId, fields) {
    if (!moduleId) return;
    this.lastProgressAt = Date.now();
    const existing = this.modules.get(moduleId);
    if (!existing) return;
    this.modules.set(moduleId, { ...existing, ...fields });
  }

  arm() {
    this.disarm();
    this.timer = setInterval(() => this.tick(), Math.min(this.stallMs, MAX_POLL_MS));
    // Never hold the process open; a wedge keeps the loop alive by itself.
    this.timer.unref?.();
  }

  disarm() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()) {
    if (now - this.lastProgressAt < this.stallMs) return;
    try {
      const report = formatStallReport(this.modules, {
        now,
        stallMs: this.stallMs,
        lastProgressAt: this.lastProgressAt,
        root: this.root,
      });
      if (report) process.stderr.write(`${report}\n`);
    } catch (error) {
      process.stderr.write(`[hang-watchdog] report failed: ${error?.message ?? error}\n`);
    }
    // Re-arm from here so a persistent stall reports once per threshold rather
    // than once per poll.
    this.lastProgressAt = now;
  }
}

function nameOf(entity) {
  try {
    return entity?.fullName ?? entity?.name ?? '(unnamed)';
  } catch {
    return entity?.name ?? '(unnamed)';
  }
}

function moduleIdOf(entity) {
  if (!entity) return undefined;
  return entity.type === 'module' ? entity.moduleId : entity.module?.moduleId;
}
