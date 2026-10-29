// Build and probe the systemd worker launch contract without starting workers.
import { spawnSync } from 'node:child_process';
import { buildSystemdClientEnv, resolveSystemdClient, resolveSystemdRun, CONNECTION_NAMES, unitEnvironmentNames } from './systemd-client.mjs';

const UNIT_SAFE = /[^A-Za-z0-9:_.@-]/g;
const transportBootstrapVariables = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT'];

/** Derive a unit-safe `aiwg-worker-<name>-<epoch>` unit name. */
export function proposeWorkerUnitName(name, nowSeconds = Math.floor(Date.now() / 1000)) {
  const stem = String(name ?? 'worker').replace(UNIT_SAFE, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'worker';
  return `aiwg-worker-${stem}-${nowSeconds}`;
}

export function assertAbsolute(label, value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new Error(`Worker isolation requires an absolute NUL-free ${label}`);
  }
}

/**
 * Detect the worker isolation mode without launching anything.
 * `{ spawn }` is injectable so tests never touch the real user manager.
 * Returns `{ mode: 'systemd-unit' | 'degraded', reason, detail? }`.
 */
export function detectWorkerIsolation({ spawn = spawnSync } = {}) {
  if (process.platform !== 'linux') {
    return { mode: 'degraded', reason: `systemd user isolation requires Linux (this host: ${process.platform})` };
  }
  let runner;
  try {
    runner = spawn(resolveSystemdRun(), ['--version'], { encoding: 'utf8', timeout: 10000, env: buildSystemdClientEnv({ envNames: [] }) });
  } catch (error) {
    return { mode: 'degraded', reason: `systemd-run is unavailable: ${error.message}` };
  }
  if (runner.error || runner.status !== 0) {
    return { mode: 'degraded', reason: 'systemd-run is unavailable (no --version response)' };
  }
  let manager;
  try {
    manager = spawn(resolveSystemdClient('systemctl'), ['--user', 'show', '-p', 'Version', '--value'], { encoding: 'utf8', timeout: 10000, env: buildSystemdClientEnv({ envNames: [] }) });
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
 * removing every manager-injected name that is not on the allowlist, plus
 * all client-only connection names. Bootstrap controls are refused.
 * Scopes ignore UnsetEnvironment, so launchIsolatedWorker strips connection
 * names with the private wrapper used for attached units.
 *
 * `attached: true` (#2892 B2 / #2895) is `kind: 'unit'` plus `--wait --pipe
 * --quiet`: systemd-run itself stays attached for the lifetime of the unit,
 * connecting the unit's stdin/stdout/stderr directly to systemd-run's own
 * (i.e. to whatever stdio the *caller* gave the systemd-run child process),
 * and systemd-run's own exit mirrors the unit's exit status. This is how an
 * MCP stdio worker can be launched resource-confined while still giving the
 * conductor a live, bidirectional stdio stream to speak JSON-RPC over — the
 * same resource ceiling (`MemoryMax`/`MemorySwapMax`) and environment-
 * allowlist contract as the fire-and-forget `'unit'` path, just attached
 * instead of detached, plus the transport-bootstrap hardening
 * (`KillMode=control-group`/`ExitType=cgroup`/`UMask=0077`, refusal of
 * `NODE_OPTIONS`/`LD_PRELOAD`/etc. in the allowlist) `launchIsolatedWorker`
 * layers on top. Attached is therefore incompatible with `stdinPath`/
 * `stdoutPath`/`stderrPath`/`logFile` (those redirect to files; `--pipe`
 * redirects to the systemd-run client's own stdio) — passing any of them
 * with `attached: true` is refused rather than silently ignored.
 *
 * `pipe`/`wait` are separate boolean flags (independent of `attached`) for a
 * synchronous verification caller that wants `--pipe`/`--wait` (and, when
 * both are set, the mandatory `--quiet` below) without the attached/async
 * child contract — see `verification-isolation.mjs`.
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
  extraProperties = [],
  pipe = false,
  wait = false,
  memoryMax,
  attached = false,
} = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  const hasMemoryMaxGb = memoryMaxGb !== undefined;
  if (hasMemoryMaxGb && (!Number.isFinite(memoryMaxGb) || memoryMaxGb <= 0)) {
    throw new Error('Worker isolation requires a positive memoryMaxGb ceiling');
  }
  if (!hasMemoryMaxGb && memoryMax === undefined) {
    throw new Error('Worker isolation requires a positive memoryMaxGb ceiling');
  }
  assertAbsolute('worker binary', command);
  for (const token of args) {
    if (typeof token !== 'string' || token.includes('\0')) throw new Error('Worker isolation argv must be NUL-free strings');
  }
  if (kind !== 'unit' && kind !== 'scope') throw new Error("Worker isolation kind must be 'unit' or 'scope'");
  if (attached && (stdinPath !== undefined || stdoutPath !== undefined || stderrPath !== undefined || logFile !== undefined)) {
    throw new Error('Worker isolation attached mode connects stdio directly through systemd-run and cannot also redirect stdinPath/stdoutPath/stderrPath/logFile');
  }
  if (cwd !== undefined) assertAbsolute('working directory', cwd);
  if (logFile !== undefined) assertAbsolute('log file', logFile);
  if (stdinPath !== undefined) assertAbsolute('stdin brief', stdinPath);
  if (stdoutPath !== undefined) assertAbsolute('stdout path', stdoutPath);
  if (stderrPath !== undefined) assertAbsolute('stderr path', stderrPath);
  if (!Array.isArray(extraProperties) || extraProperties.some(entry => typeof entry !== 'string' || entry.includes('\0'))) {
    throw new Error('Worker isolation extraProperties must be an array of NUL-free "Name=value" strings');
  }

  const argv = ['systemd-run', '--user', '--expand-environment=no'];
  if (attached) {
    if (kind !== 'unit' || logFile !== undefined) throw new Error('Attached worker requires a unit with separate pipe captures');
    argv.push('--wait', '--pipe', '--quiet');
    argv.push('-p', 'KillMode=control-group', '-p', 'ExitType=cgroup', '-p', 'UMask=0077',
      '-p', `UnsetEnvironment=${transportBootstrapVariables.join(' ')}`);
  }
  if (kind === 'unit') argv.push(`--unit=${unit}`);
  else argv.push('--scope');
  // Attached launches already pass --wait --pipe --quiet above.
  if (pipe && !attached) argv.push('--pipe');
  if (wait && !attached) argv.push('--wait');
  // --pipe connects the unit's stdio directly to systemd-run's own, but
  // systemd-run still writes its *own* "Running as unit:.../Finished with
  // result:..." status lines to that same stderr unless --quiet is given —
  // verified empirically on this host. A synchronous verification caller
  // needs the check's actual stderr, not systemd-run's narration mixed into
  // it, so --quiet is mandatory whenever both --pipe and --wait are used.
  if (pipe && wait && !attached) argv.push('--quiet');
  const requestedNames = [];
  for (const name of unitEnvironmentNames(envNames)) {
    const value = env?.[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Worker isolation environment value for ${name} is not a NUL-free string`);
    requestedNames.push(name);
    argv.push(`--setenv=${name}`);
  }
  if (kind === 'unit') {
    const toUnset = [...new Set([...managerEnvNames, ...CONNECTION_NAMES])].filter(name => !requestedNames.includes(name));
    if (toUnset.length > 0) argv.push('-p', `UnsetEnvironment=${toUnset.join(' ')}`);
  }
  // stdin is /dev/null unless a brief file is given; attached (supervised)
  // launches rely on systemd-run --pipe to carry stdin, so leave it unset.
  if (stdinPath !== undefined) argv.push('-p', `StandardInputFile=${stdinPath}`);
  else if (!attached) argv.push('-p', 'StandardInput=null');
  if (hasMemoryMaxGb) argv.push('-p', `MemoryMax=${memoryMaxGb}G`);
  else if (memoryMax !== undefined) argv.push('-p', `MemoryMax=${memoryMax}`);
  argv.push('-p', 'MemorySwapMax=0');
  const outPath = stdoutPath ?? logFile;
  const errPath = stderrPath ?? logFile;
  if (!pipe && outPath !== undefined) argv.push('-p', `StandardOutput=truncate:${outPath}`);
  if (!pipe && errPath !== undefined) argv.push('-p', `StandardError=truncate:${errPath}`);
  // Additional conductor-supplied confinement properties (ReadOnlyPaths,
  // ReadWritePaths, NoNewPrivileges, PrivateUsers, PrivateNetwork, ...),
  // appended verbatim as repeated `-p Name=value` pairs. Callers are
  // responsible for probing which of these this host's systemd/AppArmor
  // policy actually enforces (see verification-isolation.mjs) — some
  // properties silently no-op or fall back without a non-zero exit on
  // kernels/policies that deny the namespace privilege they need.
  for (const property of extraProperties) argv.push('-p', property);
  if (cwd !== undefined) argv.push(`--working-directory=${cwd}`);
  argv.push('--', command, ...args);
  return argv;
}

/**
 * Query the user manager's own inherited-environment variable names
 * (`systemctl --user show-environment`), required so a `kind: 'unit'`
 * launch can `UnsetEnvironment=` every manager-injected name that is not on
 * the caller's allowlist (see `buildWorkerIsolationArgs`' doc comment).
 * Extracted from `launchIsolatedWorker` so verification callers can reuse
 * the exact same security-relevant query instead of re-deriving it.
 */
export function resolveManagerEnvNames({ spawn = spawnSync } = {}) {
  const shown = spawn(resolveSystemdClient('systemctl'), ['--user', 'show-environment'], { encoding: 'utf8', timeout: 10000, env: buildSystemdClientEnv({ envNames: [] }) });
  if (shown.error || shown.status !== 0) throw new Error(shown.error?.message ?? (String(shown.stderr ?? '').trim() || `exit ${shown.status}`));
  return String(shown.stdout ?? '').split('\n').map(line => line.slice(0, line.indexOf('='))).filter(Boolean);
}
