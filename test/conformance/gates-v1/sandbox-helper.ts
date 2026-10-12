import { describe, it } from 'vitest';
import * as loader from '../../../src/gates/providers/loader.js';

/**
 * Bundle providers run only inside the bubblewrap sandbox and refuse
 * (fail closed) where it is unavailable. Cases that execute a provider skip
 * VISIBLY there: the skip names the refusal reason. On hosts with a working
 * bwrap (this repository's development hosts) they always run.
 */
const status = typeof (loader as { isolationSandboxStatus?: unknown }).isolationSandboxStatus === 'function'
  ? (loader as unknown as { isolationSandboxStatus: () => { ok: boolean; reason: string } }).isolationSandboxStatus()
  : { ok: true, reason: 'ok' };

export const SANDBOX_READY = status.ok;
export const SANDBOX_SKIP_SUFFIX = status.ok ? '' : ` [SKIPPED: provider sandbox unavailable: ${status.reason}]`;

export const itSandboxed = (name: string, fn: () => unknown, timeout?: number): void => {
  if (SANDBOX_READY) it(name, fn, timeout);
  else it.skip(`${name}${SANDBOX_SKIP_SUFFIX}`, fn);
};

export const describeSandboxed = (name: string, fn: () => void): void => {
  if (SANDBOX_READY) describe(name, fn);
  else describe.skip(`${name}${SANDBOX_SKIP_SUFFIX}`, fn);
};
