import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  type PairedTimingSample,
  type PairedTimingSummary,
  summarizePairedTimings,
} from './cli-perf-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Preloaded (via `node --require`) into every process this measures, so the
 * child reports its own CPU usage on fd 3. See cpu-usage-preload.cjs for why
 * CPU time, not wall time, fixes the CLI perf gate's host-load sensitivity
 * (#3047).
 */
export const CPU_USAGE_PRELOAD_PATH = path.join(__dirname, 'cpu-usage-preload.cjs');

/**
 * Runs `node --require cpu-usage-preload.cjs <args>` and returns the CPU
 * time (user+system, in ms) the child reported on fd 3.
 *
 * Throws -- never returns 0 -- if the child exited non-zero or never
 * reported a usable fd-3 report: a silent 0ms would make the perf gate pass
 * by measuring nothing, which is the one outcome this replacement must not
 * be able to produce.
 */
export function runNodeCpuMs(
  execPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): number {
  const result = spawnSync(execPath, ['--require', CPU_USAGE_PRELOAD_PATH, ...args], {
    timeout: 5_000,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `process exited with status ${result.status} during CPU-time perf measurement `
      + `(${execPath} ${args.join(' ')})`,
    );
  }
  const reported = result.output?.[3];
  if (!reported) {
    throw new Error(
      `cpu-usage-preload.cjs did not report CPU usage on fd 3 for ${execPath} ${args.join(' ')} -- `
      + 'the perf gate cannot fall back to measuring nothing',
    );
  }
  let usage: { userUs?: number; systemUs?: number };
  try {
    usage = JSON.parse(reported);
  } catch (error) {
    throw new Error(
      `cpu-usage-preload.cjs reported unparseable CPU usage (${JSON.stringify(reported)}): `
      + `${(error as Error).message}`,
    );
  }
  if (typeof usage.userUs !== 'number' || typeof usage.systemUs !== 'number') {
    throw new Error(`cpu-usage-preload.cjs reported an incomplete CPU usage record: ${reported}`);
  }
  return (usage.userUs + usage.systemUs) / 1_000;
}

/**
 * Pairs `sampleCount` CPU-time measurements of `commandArgs` against a bare
 * `node -e ''` baseline run immediately before and after each one -- same
 * paired-sandwich strategy as the wall-clock version this replaces, so
 * shared-runner Node startup drift (page cache, JIT warm state) still
 * cancels out of `summarizePairedTimings`'s median. What changes is the
 * measured unit: CPU time instead of wall time, which host *scheduling*
 * contention cannot inflate (a process waiting for a timeslice does not
 * accumulate CPU time), fixing #3047's false positives under load.
 */
export function measurePairedCpu(
  execPath: string,
  commandArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  sampleCount: number,
): PairedTimingSummary {
  // Discard one cache-cold run before measuring, same as the original gate.
  runNodeCpuMs(execPath, commandArgs, env);
  runNodeCpuMs(execPath, ['-e', ''], env);
  const samples: PairedTimingSample[] = Array.from({ length: sampleCount }, () => ({
    baselineBeforeMs: runNodeCpuMs(execPath, ['-e', ''], env),
    commandMs: runNodeCpuMs(execPath, commandArgs, env),
    baselineAfterMs: runNodeCpuMs(execPath, ['-e', ''], env),
  }));
  return summarizePairedTimings(samples);
}
