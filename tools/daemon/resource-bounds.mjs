/**
 * Validated resource bounds for the housekeeper profile (epic #3353 slice B6).
 *
 * Single source of truth for safe defaults; the runner (concurrency, queue,
 * timeout clamp, child niceness) and the file watcher (watch-handle cap)
 * enforce the normalized values, and `tools/daemon/config.mjs` validates the
 * `resources` config block against the same ranges.
 */

import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { importImpl } from '../_resolve-impl.mjs';

const { helperEnvironment } = await importImpl(import.meta.url, 'process/cli-command.mjs');

export const RESOURCE_DEFAULTS = Object.freeze({
  /** Max owner executions in flight at once; further runs wait in the queue. */
  maxConcurrentJobs: 2,
  /** Max runs waiting for a slot; beyond it the run overflows (deferred). */
  maxQueueDepth: 16,
  /** Global ceiling clamped over every per-job timeoutMs. */
  maxTimeoutMs: 600000,
  /** CPU niceness applied to job children (higher = lower priority). */
  jobNiceness: 10,
  /** Max native watch handles; beyond it roots fall back to polling. */
  maxWatchHandles: 64,
});

const RANGES = {
  maxConcurrentJobs: [1, 8],
  maxQueueDepth: [0, 1024],
  maxTimeoutMs: [1000, 3600000],
  jobNiceness: [-20, 19],
  maxWatchHandles: [1, 512],
};

/** Validate a raw `resources` block. Returns `{ config, errors }`. */
export function normalizeResources(raw) {
  const errors = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw) || raw === null)) {
    return { config: { ...RESOURCE_DEFAULTS }, errors: ['resources must be an object'] };
  }
  const config = { ...RESOURCE_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (source[key] === undefined) continue;
    const value = source[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`resources.${key} must be an integer between ${min} and ${max}`);
      continue;
    }
    config[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(RANGES, key)) errors.push(`resources.${key} is not a known resource bound`);
  }
  return { config, errors };
}

/**
 * Lower a job child's scheduling priority best-effort. CPU niceness via
 * `os.setPriority`; on Linux additionally request the idle IO class. Never
 * throws: a child that keeps default priority still runs under the timeout
 * and concurrency bounds.
 */
export function applyChildNiceness(pid, { niceness = RESOURCE_DEFAULTS.jobNiceness } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { applied: false, reason: 'invalid-pid' };
  if (!Number.isInteger(niceness) || niceness < -20 || niceness > 19) {
    return { applied: false, reason: 'invalid-niceness' };
  }
  try {
    os.setPriority(pid, niceness);
  } catch {
    return { applied: false, reason: 'setpriority-unavailable' };
  }
  if (process.platform === 'linux') {
    try {
      const probe = spawnSync('ionice', ['-c', '3', '-p', String(pid)], {
        timeout: 5000, killSignal: 'SIGKILL', env: helperEnvironment(),
      });
      if (probe.error || probe.status !== 0) return { applied: true, ioIdle: false };
      return { applied: true, ioIdle: true };
    } catch {
      return { applied: true, ioIdle: false };
    }
  }
  return { applied: true, ioIdle: false };
}
