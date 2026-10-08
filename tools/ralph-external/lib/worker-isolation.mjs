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
import { openSync, closeSync } from 'node:fs';
import { checkWorkerDispatch } from '../../scripts/resource-preflight.mjs';

const UNIT_SAFE = /[^A-Za-z0-9:_.@-]/g;

// Never unset these from a unit's environment even when the manager reports
// them and they are not allowlisted; see buildWorkerIsolationArgs' doc
// comment for why XDG_RUNTIME_DIR specifically must survive.
const UNAVOIDABLE_UNIT_ENV_NAMES = ['XDG_RUNTIME_DIR'];

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
 * `PATH`/`HOME`); only the allowlisted `envNames` are forwarded, and their
 * values are never written into argv. Each is requested with bare
 * `--setenv=NAME` (no `=value`), which (systemd >= 230; confirmed on this
 * host's systemd 259) imports the value from systemd-run's *own* invoking
 * process environment rather than rendering it into the unit's argv — so a
 * secret value never appears in `/proc/<systemd-run-pid>/cmdline`. That
 * import is additive to whatever the user manager already injects into every
 * unit (`systemctl --user show-environment`: LANG, XDG_*, SSH_AUTH_SOCK,
 * etc. on an interactive manager), so `managerEnvNames` — the caller's own
 * live snapshot of that list — drives a single `-p UnsetEnvironment=...`
 * removing every manager-injected name that is not on the allowlist, except
 * `XDG_RUNTIME_DIR` (`UNAVOIDABLE_UNIT_ENV_NAMES`): unsetting it is harmless
 * to secrecy (it is just `/run/user/<uid>`, not a secret) but was verified
 * empirically to make the launched unit's own `/proc/<pid>/environ`
 * unreadable (EACCES) even to the same-UID conductor that just started
 * it — on this host with `kernel.yama.ptrace_scope=1`, removing it strips
 * the unit of whatever ties it to the login session that would otherwise
 * grant that read. Carrying it through is the "systemd's minimal unit
 * variables if unavoidable" carve-out. The result is a unit environment
 * containing exactly the allowlisted names, `XDG_RUNTIME_DIR`, and whatever
 * few variables systemd itself always injects into a unit (`INVOCATION_ID`,
 * `MANAGERPID`, `MEMORY_PRESSURE_WATCH`, ...) — never a secret, never an
 * unrelated inherited variable. `kind: 'scope'` is exempt:
 * `--scope` execs directly as a child of the `systemd-run` client itself
 * (confirmed empirically — it inherits that process's environment wholesale,
 * ignoring `UnsetEnvironment`), so this guarantee applies only to `kind:
 * 'unit'`, the default and the only kind any production caller uses.
 *
 * `stdinPath`, when given, feeds the worker's stdin from that file
 * (`StandardInputFile=`) instead of the default `StandardInput=null` — this
 * is how a resolved #2887 invocation's brief reaches the worker. `stdoutPath`
 * / `stderrPath`, when given, route stdout/stderr to distinct files; either
 * falls back to the combined `logFile` when omitted, so existing combined-log
 * callers are unaffected. Both use systemd's `truncate:` output mode
 * (systemd >= 248) rather than `file:` (which appends with O_APPEND), so a
 * pre-existing file at that path is replaced, not appended to.
 */
export function buildWorkerIsolationArgs({
  unit,
  memoryMaxGb,
  command,
  args = [],
  cwd,
  logFile,
  stdinPath,
  stdoutPath,
  stderrPath,
  env = process.env,
  envNames = ['PATH', 'HOME'],
  managerEnvNames = [],
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
  if (stdinPath !== undefined) assertAbsolute('stdin brief', stdinPath);
  if (stdoutPath !== undefined) assertAbsolute('stdout path', stdoutPath);
  if (stderrPath !== undefined) assertAbsolute('stderr path', stderrPath);

  const argv = ['systemd-run', '--user', '--expand-environment=no'];
  if (kind === 'unit') argv.push(`--unit=${unit}`);
  else argv.push('--scope');
  const requestedNames = [];
  for (const name of envNames) {
    const value = env?.[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Worker isolation environment value for ${name} is not a NUL-free string`);
    requestedNames.push(name);
    argv.push(`--setenv=${name}`);
  }
  if (kind === 'unit') {
    const toUnset = managerEnvNames.filter(name => !requestedNames.includes(name) && !UNAVOIDABLE_UNIT_ENV_NAMES.includes(name));
    if (toUnset.length > 0) argv.push('-p', `UnsetEnvironment=${toUnset.join(' ')}`);
  }
  argv.push('-p', stdinPath !== undefined ? `StandardInputFile=${stdinPath}` : 'StandardInput=null');
  argv.push('-p', `MemoryMax=${memoryMaxGb}G`);
  argv.push('-p', 'MemorySwapMax=0');
  const outPath = stdoutPath ?? logFile;
  const errPath = stderrPath ?? logFile;
  if (outPath !== undefined) argv.push('-p', `StandardOutput=truncate:${outPath}`);
  if (errPath !== undefined) argv.push('-p', `StandardError=truncate:${errPath}`);
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
  stdinPath,
  stdoutPath,
  stderrPath,
  env = process.env,
  envNames = ['PATH', 'HOME'],
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
    if (stdinPath !== undefined) assertAbsolute('stdin brief', stdinPath);
    if (stdoutPath !== undefined) assertAbsolute('stdout path', stdoutPath);
    if (stderrPath !== undefined) assertAbsolute('stderr path', stderrPath);
    if (!Array.isArray(args) || args.some(token => typeof token !== 'string' || token.includes('\0'))) {
      throw new Error('Worker isolation argv must be NUL-free strings');
    }
    // Degraded mode has no systemd unit to confine the environment, so this
    // module builds the allowlisted environment itself and passes it as the
    // child's *entire* environment (the `env` option replaces, never merges
    // with, the current process environment) — the functional equivalent of
    // `env -i NAME=value ...`. The conductor's own environment (secrets,
    // NODE_OPTIONS, etc.) is therefore never inherited, allowlisted or not.
    const allowedEnv = {};
    for (const key of envNames) {
      const value = env?.[key];
      if (value !== undefined) allowedEnv[key] = value;
    }
    // Opening the brief/output files ourselves (rather than letting the
    // worker inherit a stream) is what lets a degraded launch still honor a
    // resolved #2887 invocation's stdin source and separate stdout/stderr
    // destinations; `openSync` throws rather than silently falling back.
    // 'w' truncates a pre-existing file at open time (matching the #2887
    // shell renderer's `>`/`2>` contract); the previous 'a' silently kept
    // appending onto a stale file across repeated degraded launches.
    const stdin = stdinPath !== undefined ? openSync(stdinPath, 'r') : 'ignore';
    const stdout = stdoutPath !== undefined ? openSync(stdoutPath, 'w') : 'pipe';
    const stderr = stderrPath !== undefined ? openSync(stderrPath, 'w') : 'pipe';
    const child = spawnAsync(command, args, { cwd, env: allowedEnv, stdio: [stdin, stdout, stderr] });
    // Node dup()s a numeric stdio fd into the child and never closes the
    // parent's own copy; the child's duplicated fd keeps working after this
    // call returns (verified empirically), so closing here is what the
    // previous code was missing — every launch otherwise leaked up to three
    // fds in the long-running conductor process.
    for (const fd of [stdin, stdout, stderr]) if (typeof fd === 'number') closeSync(fd);
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
  // The unit path's security contract (see buildWorkerIsolationArgs' doc
  // comment) depends on knowing exactly which names the user manager would
  // otherwise inject, so it can unset every one of them that is not
  // allowlisted. Without a trustworthy answer to that query, launching would
  // either omit `UnsetEnvironment` (silently falling back to the padded,
  // non-exact environment this fix exists to remove) or guess — both are
  // refused in favor of an explicit failure.
  let managerEnvNames;
  try {
    const shown = spawn('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 10000 });
    if (shown.error || shown.status !== 0) throw new Error(shown.error?.message ?? (String(shown.stderr ?? '').trim() || `exit ${shown.status}`));
    managerEnvNames = String(shown.stdout ?? '').split('\n').map(line => line.slice(0, line.indexOf('='))).filter(Boolean);
  } catch (error) {
    return {
      launched: false,
      mode: 'systemd-unit',
      diagnostic: `unable to determine the user manager's inherited environment (required to isolate the worker's environment exactly): ${error.message}`,
      gate: resolvedGate,
    };
  }
  const unit = proposeUnit(name);
  const argv = buildWorkerIsolationArgs({ unit, memoryMaxGb, command, args, cwd, logFile, stdinPath, stdoutPath, stderrPath, env, envNames, managerEnvNames, kind });
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
