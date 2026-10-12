import { spawnSync } from 'node:child_process';

// npm pack runs the prepack build; healthy runs finish well inside this bound,
// while a wedged npm would otherwise hold the CI job until the runner timeout.
export const DEFAULT_NPM_PACK_TIMEOUT_MS = 5 * 60 * 1000;
export const NPM_PACK_TIMEOUT_ENV = 'AIWG_FORTEMI_PACK_TIMEOUT_MS';

export function resolveNpmPackTimeoutMs(env = process.env) {
  const raw = env[NPM_PACK_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_NPM_PACK_TIMEOUT_MS;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${NPM_PACK_TIMEOUT_ENV} must be a positive integer number of milliseconds (got ${JSON.stringify(raw)})`);
  }
  return Number(value);
}

// Returns { ok: true, result } or { ok: false, message, result } so the caller
// decides how to report and exit.
export function runNpmPack({
  cwd,
  destination,
  timeoutMs,
  command = 'npm',
  args = ['pack', '--json', '--pack-destination', destination],
  spawn = spawnSync,
}) {
  const result = spawn(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal)) {
    const reason = result.error?.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutMs}ms`
      : `was killed by ${result.signal} (timeout ${timeoutMs}ms)`;
    return {
      ok: false,
      timedOut: true,
      result,
      message: `npm pack --json ${reason}; set ${NPM_PACK_TIMEOUT_ENV} to adjust the bound`,
    };
  }
  if (result.error) {
    return { ok: false, timedOut: false, result, message: `npm pack --json failed to run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, timedOut: false, result, message: `npm pack --json exited with status ${result.status}` };
  }
  return { ok: true, timedOut: false, result };
}
