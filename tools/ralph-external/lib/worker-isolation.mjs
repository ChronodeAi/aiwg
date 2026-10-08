/**
 * Worker process isolation for Tier 0 direct dispatch (FR-OG-108, #2954).
 *
 * Direct workers must never share the conductor's cgroup: on the titan host
 * an oomd kill of one shared cgroup took the conductor session with it.
 * This module builds `systemd-run --user` launch arguments (own unit or
 * scope with `MemoryMax` and `MemorySwapMax=0`, PATH/HOME passthrough,
 * stdin `/dev/null`) and, where no systemd user manager exists, returns an
 * explicit DEGRADED diagnostic instead of silently launching unconfined.
 *
 * Pure argument construction is fully unit-tested with synthetic inputs. The
 * single integration test executes a real `systemd-run --user` only when a
 * user manager is reachable and skips otherwise. No worker is ever launched
 * by importing this module.
 *
 * Callers (conductors, bridges, future #2888 templates) use this flow:
 *
 * ```js
 * import { checkWorkerDispatch } from '../../../scripts/resource-preflight.mjs';
 * import { detectWorkerIsolation, launchIsolatedWorker } from './worker-isolation.mjs';
 *
 * const gate = checkWorkerDispatch({ config });
 * // Over threshold -> queue, pick another qualified host, or reject. Never launch.
 * const outcome = launchIsolatedWorker({ name, memoryMaxGb, command, args, cwd, logFile, gate });
 * ```
 *
 * `prepareWorkerInvocation` (provider-adapter.mjs) deliberately stays
 * launch-free: it prepares and validates the descriptor, while the conductor
 * owns the gate-then-launch sequence above. No mandatory enforcement is
 * wired into #2887/#2888 internals by this change.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { checkWorkerDispatch } from '../../scripts/resource-preflight.mjs';

const UNIT_SAFE = /[^A-Za-z0-9:_.@-]/g;

/** Derive a unit-safe `aiwg-worker-<name>-<epoch>` unit name. */
export function proposeWorkerUnitName(name, nowSeconds = Math.floor(Date.now() / 1000)) {
  const stem = String(name ?? 'worker').replace(UNIT_SAFE, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'worker';
  return `aiwg-worker-${stem}-${nowSeconds}`;
}

function assertAbsolute(label, value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new Error(`Worker isolation requires an absolute NUL-free ${label}`);
  }
}

/**
 * Detect the worker isolation mode without launching anything.
 * `{ spawn }` is injectable so tests never touch the real user manager.
 * Returns `{ mode: 'systemd-unit' | 'degraded', reason, detail? }`.
 */
export function detectWorkerIsolation({ spawn = spawnSync, env = process.env } = {}) {
  if (process.platform !== 'linux') {
    return { mode: 'degraded', reason: `systemd user isolation requires Linux (this host: ${process.platform})` };
  }
  let runner;
  try {
    runner = spawn('systemd-run', ['--version'], { encoding: 'utf8', timeout: 10000 });
  } catch (error) {
    return { mode: 'degraded', reason: `systemd-run is unavailable: ${error.message}` };
  }
  if (runner.error || runner.status !== 0) {
    return { mode: 'degraded', reason: 'systemd-run is unavailable (no --version response)' };
  }
  let manager;
  try {
    manager = spawn('systemctl', ['--user', 'show', '-p', 'Version', '--value'], { encoding: 'utf8', timeout: 10000, env });
  } catch (error) {
    return { mode: 'degraded', reason: `systemd user manager is unreachable: ${error.message}` };
  }
  if (manager.error || manager.status !== 0) {
    return { mode: 'degraded', reason: 'systemd user manager is unreachable (systemctl --user failed)' };
  }
  return { mode: 'systemd-unit', reason: 'systemd user manager is reachable', detail: String(manager.stdout ?? '').trim() };
}

/**
 * Build the `systemd-run --user` argv for one isolated worker. Pure and
 * fully unit-tested. `kind` is `'unit'` (default, matches the field
 * prototype: own unit retained for post-exit status inspection) or `'scope'`.
 * Failed units require explicit `systemctl --user reset-failed <unit>` cleanup
 * after Result/ExecMainStatus have been recorded; --collect would erase them.
 * `env` supplies passthrough values (defaults to the conductor's current
 * `PATH`/`HOME`); only the allowlisted `envNames` are forwarded and their
 * values are passed via `--setenv`, never rendered into shell syntax.
 */
export function buildWorkerIsolationArgs({
  unit,
  memoryMaxGb,
  command,
  args = [],
  cwd,
  logFile,
  env = process.env,
  envNames = ['PATH', 'HOME'],
  kind = 'unit',
} = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  if (!Number.isFinite(memoryMaxGb) || memoryMaxGb <= 0) {
    throw new Error('Worker isolation requires a positive memoryMaxGb ceiling');
  }
  assertAbsolute('worker binary', command);
  for (const token of args) {
    if (typeof token !== 'string' || token.includes('\0')) throw new Error('Worker isolation argv must be NUL-free strings');
  }
  if (kind !== 'unit' && kind !== 'scope') throw new Error("Worker isolation kind must be 'unit' or 'scope'");
  if (cwd !== undefined) assertAbsolute('working directory', cwd);
  if (logFile !== undefined) assertAbsolute('log file', logFile);

  const argv = ['systemd-run', '--user', '--expand-environment=no'];
  if (kind === 'unit') argv.push(`--unit=${unit}`);
  else argv.push('--scope');
  for (const name of envNames) {
    const value = env?.[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Worker isolation environment value for ${name} is not a NUL-free string`);
    argv.push(`--setenv=${name}=${value}`);
  }
  argv.push('-p', 'StandardInput=null');
  argv.push('-p', `MemoryMax=${memoryMaxGb}G`);
  argv.push('-p', 'MemorySwapMax=0');
  if (logFile !== undefined) {
    argv.push('-p', `StandardOutput=file:${logFile}`);
    argv.push('-p', `StandardError=file:${logFile}`);
  }
  if (cwd !== undefined) argv.push(`--working-directory=${cwd}`);
  argv.push('--', command, ...args);
  return argv;
}

/**
 * Gate, then launch one worker in its own resource scope (FR-OG-107/108).
 *
 * - `gate` must be a `checkWorkerDispatch()` result. Missing results refuse
 *   launch. Explicit `gate: 'disabled'` requires worker_dispatch off in config.
 *   A failing gate returns
 *   `{ launched: false, blocked: true, failures }` and nothing launches.
 * - Without a reachable systemd user manager the result is an explicit
 *   `{ launched: false, mode: 'degraded', diagnostic }` unless the caller
 *   passes `allowDegraded: true`, which launches the command directly with
 *   stdin `/dev/null` and records the degraded mode for the qualification
 *   record. Degraded launches never claim isolation.
 * - Degraded launches return an async child/pid handle without a deadline.
 *   `spawn` (manager queries), `spawnAsync`, and `proposeUnit` are injectable.
 */
export function launchIsolatedWorker({
  name = 'worker',
  memoryMaxGb,
  command,
  args = [],
  cwd,
  logFile,
  gate,
  config,
  allowDegraded = false,
  isolation,
  kind = 'unit',
  spawn = spawnSync,
  spawnAsync = nodeSpawn,
  proposeUnit = proposeWorkerUnitName,
} = {}) {
  const resolvedGate = gate === 'disabled' && !config?.parallelism?.worker_dispatch
    ? checkWorkerDispatch({ config })
    : gate && typeof gate.ok === 'boolean' && typeof gate.enabled === 'boolean' ? gate : undefined;
  if (!resolvedGate || (config?.parallelism?.worker_dispatch && resolvedGate.enabled === false)) {
    return { launched: false, blocked: true, failures: [{ signal: 'gate', reason: 'worker launch requires a dispatch gate result; disabled is allowed only with worker_dispatch off' }] };
  }
  if (!resolvedGate.ok) {
    return { launched: false, blocked: true, failures: resolvedGate.failures ?? [], gate: resolvedGate };
  }
  const detected = isolation ?? detectWorkerIsolation({ spawn });
  if (detected.mode === 'degraded' && !allowDegraded) {
    return {
      launched: false,
      mode: 'degraded',
      diagnostic: `worker isolation unavailable: ${detected.reason}; pass allowDegraded:true to launch unconfined with stdin /dev/null (recorded as degraded)`,
      gate: resolvedGate,
    };
  }
  if (detected.mode === 'degraded') {
    assertAbsolute('worker binary', command);
    if (cwd !== undefined) assertAbsolute('working directory', cwd);
    if (!Array.isArray(args) || args.some(token => typeof token !== 'string' || token.includes('\0'))) {
      throw new Error('Worker isolation argv must be NUL-free strings');
    }
    const child = spawnAsync(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const outcome = {
      launched: Number.isInteger(child.pid) && child.pid > 0,
      mode: 'degraded', child, pid: child.pid,
      diagnostic: `launched without resource confinement: ${detected.reason}`,
      gate: resolvedGate,
    };
    // Keep launch failures observable even if the caller attaches listeners later.
    child.once('error', error => { outcome.launched = false; outcome.error = error.message; });
    return outcome;
  }
  const unit = proposeUnit(name);
  const argv = buildWorkerIsolationArgs({ unit, memoryMaxGb, command, args, cwd, logFile, kind });
  const child = spawn(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 });
  if (child.error || child.status !== 0) {
    const stderr = String(child.stderr ?? '').trim();
    return {
      launched: false,
      mode: 'systemd-unit',
      unit,
      diagnostic: `systemd-run launch failed: ${child.error?.message ?? stderr ?? `exit ${child.status}`}`,
      gate: resolvedGate,
    };
  }
  let pid;
  try {
    const shown = spawn('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8', timeout: 10000 });
    const parsed = Number(String(shown.stdout ?? '').trim());
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    pid = undefined;
  }
  return { launched: true, mode: 'systemd-unit', unit, pid, gate: resolvedGate };
}

/**
 * Read retained service state after launch/exit without reaping or mutation.
 * `memoryMax` is bytes. Query failures throw rather than reporting success.
 */
export function getWorkerIsolationStatus(unit, { spawn = spawnSync } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  const shown = spawn('systemctl', ['--user', 'show', unit, '-p', 'ActiveState',
    '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'MemoryMax'], { encoding: 'utf8', timeout: 10000 });
  if (shown.error || shown.status !== 0) {
    throw new Error(`worker status unavailable: ${shown.error?.message ?? String(shown.stderr ?? '').trim()}`);
  }
  const fields = Object.fromEntries(String(shown.stdout ?? '').trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!fields.ActiveState || !fields.Result || !fields.ExecMainStatus || !fields.MemoryMax) {
    throw new Error('worker status unavailable: missing systemd properties');
  }
  return {
    active: ['active', 'activating', 'deactivating', 'reloading'].includes(fields.ActiveState),
    result: fields.Result,
    execMainStatus: Number(fields.ExecMainStatus),
    memoryMax: fields.MemoryMax === 'infinity' ? Infinity : Number(fields.MemoryMax),
  };
}

export { checkWorkerDispatch };
