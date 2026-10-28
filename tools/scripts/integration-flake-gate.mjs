#!/usr/bin/env node
// 50-run flake gate for the tier-3 integration suite (#1174 cycle 3).
//
// Runs `vitest run --config config/vitest.integration.config.js` N times in
// sequence (default from the ci-flake gate pack) and fails fast on the first
// non-zero exit. Used to confirm the suite is stable before any change to
// the harness or fake sandbox lands.
//
// Policy lives in agentic/code/extensions/dev/gate-packs/ci-flake.gatepack.yaml:
// `requiredRuns` (default 50) sets the default run count and the
// `flake-failures` count-max gate (threshold `maxFailedRuns`, default 0,
// onFail ROLLBACK) decides each run. Per-run outcomes combine through the
// shared gates lattice (`src/gates/lattice.ts`): a passed run promotes, a
// failed run takes the pack's onFail, and the strictest outcome wins, so the
// first failed run already decides ROLLBACK and fail-fast stops a decided
// gate rather than skipping unevaluated work.
//
// Usage:
//   node tools/scripts/integration-flake-gate.mjs        # pack-default runs
//   N=10 node tools/scripts/integration-flake-gate.mjs   # 10 runs
//   node tools/scripts/integration-flake-gate.mjs --runs 25
//
// Each run is reported on its own line; failures dump the full vitest output
// for debugging.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { importImpl } from '../_resolve-impl.mjs';
const { ceilingDecision, maxOutcome } = await importImpl(import.meta.url, 'gates/lattice.js');

const HERE = dirname(fileURLToPath(import.meta.url));

export const FLAKE_GATE_PACK_PATH = resolve(
  HERE,
  '../../agentic/code/extensions/dev/gate-packs/ci-flake.gatepack.yaml',
);

function asNonNegativeInteger(value, what) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ci-flake pack ${what} must be a non-negative integer (received ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Read the flake-gate policy from its gate pack: the default run count from
 * the `requiredRuns` parameter default and the per-run failure outcome from
 * the pack's count-max gate onFail (ROLLBACK: any failed run rolls back).
 */
export function loadFlakeGatePolicy(packPath = FLAKE_GATE_PACK_PATH) {
  let document;
  try {
    document = parseYaml(readFileSync(packPath, 'utf8'));
  } catch (error) {
    throw new Error(`ci-flake gate pack unreadable: ${packPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parameters = document?.spec?.parameters ?? {};
  const requiredRuns = asNonNegativeInteger(parameters.requiredRuns?.default, 'requiredRuns default');
  if (requiredRuns < 1) {
    throw new Error(`ci-flake gate pack requiredRuns default must be at least 1 (received ${requiredRuns})`);
  }
  const maxFailedRuns = asNonNegativeInteger(parameters.maxFailedRuns?.default, 'maxFailedRuns default');
  const gates = document?.spec?.gates ?? [];
  const failuresGate = gates.find((gate) => gate?.kind === 'count-max');
  if (failuresGate === undefined) {
    throw new Error(`ci-flake gate pack ${packPath} has no count-max failures gate`);
  }
  if (failuresGate.onFail !== 'HOLD' && failuresGate.onFail !== 'ROLLBACK') {
    throw new Error(`ci-flake gate pack failures gate onFail must be HOLD or ROLLBACK (received ${JSON.stringify(failuresGate.onFail)})`);
  }
  return {
    requiredRuns,
    maxFailedRuns,
    failuresGateId: failuresGate.id,
    /** Shared-lattice outcome of one failed run: the pack's onFail. */
    failureOutcome: failuresGate.onFail,
  };
}

const FLAKE_GATE_POLICY = loadFlakeGatePolicy();

export const DEFAULT_RUNS = FLAKE_GATE_POLICY.requiredRuns;
/** Pack revision this script was wired against; surfaced for diagnostics. */
export const FLAKE_GATE_POLICY_DEFAULTS = Object.freeze({
  requiredRuns: FLAKE_GATE_POLICY.requiredRuns,
  maxFailedRuns: FLAKE_GATE_POLICY.maxFailedRuns,
  failuresGateId: FLAKE_GATE_POLICY.failuresGateId,
  failureOutcome: FLAKE_GATE_POLICY.failureOutcome,
});
const POSITIVE_INTEGER = /^[1-9]\d*$/;

function parsePositiveInteger(value, source) {
  const text = String(value);
  if (!POSITIVE_INTEGER.test(text)) {
    throw new Error(`${source} must be a positive integer (received ${JSON.stringify(text)})`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${source} must be a safe positive integer (received ${JSON.stringify(text)})`);
  }
  return parsed;
}

export function parseRunCount(argv = [], env = {}) {
  const indices = argv.flatMap((arg, index) => (arg === '--runs' ? [index] : []));
  if (indices.length > 1) throw new Error('--runs may be provided only once');
  if (indices.length === 1) {
    const value = argv[indices[0] + 1];
    if (value === undefined) throw new Error('--runs requires a positive integer value');
    return parsePositiveInteger(value, '--runs');
  }
  if (env.N !== undefined) return parsePositiveInteger(env.N, 'N');
  return DEFAULT_RUNS;
}

function writeLine(stream, value = '') {
  stream.write(`${value}\n`);
}

export function runFlakeGate({
  totalRuns,
  spawn = spawnSync,
  now = Date.now,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!Number.isSafeInteger(totalRuns) || totalRuns <= 0) {
    throw new Error(`totalRuns must be a safe positive integer (received ${JSON.stringify(totalRuns)})`);
  }

  writeLine(stdout, `Tier-3 integration flake gate — ${totalRuns} consecutive runs`);
  writeLine(stdout, '='.repeat(60));

  const startWall = now();
  const durations = [];
  const outcomes = [];

  for (let index = 1; index <= totalRuns; index += 1) {
    const runStart = now();
    let result;
    try {
      result = spawn(
        'npx',
        ['vitest', 'run', '--config', 'config/vitest.integration.config.js', '--reporter=dot'],
        { encoding: 'utf-8' },
      );
    } catch (error) {
      result = { status: null, stdout: '', stderr: '', error };
    }
    const durationMs = now() - runStart;
    durations.push(durationMs);

    if (result.status !== 0) {
      // One failed run takes the pack failures gate's onFail through the
      // shared lattice; the pack allows zero failures, so the gate is
      // already decided and fail-fast stops a decided gate.
      outcomes.push(FLAKE_GATE_POLICY.failureOutcome);
      const decision = maxOutcome(...outcomes);
      writeLine(stderr);
      writeLine(stderr, `✗ Run ${index}/${totalRuns} FAILED after ${durationMs}ms`);
      if (result.error) writeLine(stderr, `─── process error ───\n${result.error.message}`);
      writeLine(stderr, '─── vitest stdout ───');
      writeLine(stderr, result.stdout ?? '');
      writeLine(stderr, '─── vitest stderr ───');
      writeLine(stderr, result.stderr ?? '');
      return {
        ok: false,
        status: 1,
        decision,
        totalRuns,
        completedRuns: index - 1,
        failedRun: index,
        durations,
      };
    }

    outcomes.push('PROMOTE');
    writeLine(stdout, `[${index}/${totalRuns}] ok in ${durationMs}ms`);
  }

  const elapsedMs = now() - startWall;
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const statistics = {
    min: sortedDurations[0],
    median: sortedDurations[Math.floor(sortedDurations.length / 2)],
    average: Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length),
    max: sortedDurations.at(-1),
  };

  // Every run promoted: the gate decision is the lattice ceiling over the
  // per-run outcomes, never an upgrade of a component.
  const decision = ceilingDecision('PROMOTE', ...outcomes);
  writeLine(stdout, '='.repeat(60));
  writeLine(stdout, `✓ ${totalRuns}/${totalRuns} runs passed in ${(elapsedMs / 1000).toFixed(1)}s`);
  writeLine(stdout, `  per-run: min=${statistics.min}ms  median=${statistics.median}ms  avg=${statistics.average}ms  max=${statistics.max}ms`);
  return { ok: true, status: 0, decision, totalRuns, completedRuns: totalRuns, durations, elapsedMs, statistics };
}

export function main({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
  now = Date.now,
  stdout = process.stdout,
  stderr = process.stderr,
  setExitCode = (status) => { process.exitCode = status; },
} = {}) {
  try {
    const result = runFlakeGate({ totalRuns: parseRunCount(argv, env), spawn, now, stdout, stderr });
    if (!result.ok) setExitCode(result.status);
    return result;
  } catch (error) {
    writeLine(stderr, `integration-flake-gate: ${error.message}`);
    setExitCode(1);
    return { ok: false, status: 1, error: error.message };
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
