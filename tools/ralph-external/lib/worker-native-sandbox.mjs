/** Probe each CLI's native sandbox mechanism through the worker's transient unit. */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWorkerIsolationArgs, proposeWorkerUnitName, resolveManagerEnvNames } from './worker-isolation.mjs';
import { buildSystemdClientEnv, resolveSystemdRun, unitEnvironmentNames } from './systemd-client.mjs';

const nativeSandboxProbes = new Map();
let sequence = 0;
export const NATIVE_SANDBOX_UNAVAILABLE = 'OG_NATIVE_SANDBOX_UNAVAILABLE';

/** Prefer the system bwrap allowed by Ubuntu's executable-specific AppArmor policy. */
export function resolveWorkerBwrap({ env = process.env, executable = candidate => {
  try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
} } = {}) {
  for (const candidate of ['/usr/bin/bwrap', ...(env.PATH ?? '').split(path.delimiter)
    .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, 'bwrap'))]) {
    if (executable(candidate)) return candidate;
  }
  throw new Error('bwrap is unavailable at /usr/bin/bwrap or on the worker PATH');
}

const bwrapProbe = options => ({ mechanism: 'bwrap', command: resolveWorkerBwrap(options),
  args: ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', '--', '/usr/bin/true'] });

// Hooks are owned by launcher code, never loaded from project configuration.
export const workerNativeSandboxProbeHooks = { codex: bwrapProbe, muse: bwrapProbe };

// CLIs without their own hook keep a generic user/network namespace probe: bwrap when the host
// has it (allowed by Ubuntu's bwrap profile), else the previous unshare probe.
const genericProbe = options => {
  try { return bwrapProbe(options); }
  catch { return { mechanism: 'unshare', command: '/usr/bin/unshare', args: ['--user', '--map-root-user', '--net', '/usr/bin/true'] }; }
};

export function workerNeedsNativeNamespaces(adapter, permissions = {}, platform = process.platform) {
  return platform === 'linux' && Object.hasOwn(workerNativeSandboxProbeHooks, adapter?.provider ?? '')
    && (permissions.transport ?? 'shell') === 'shell'
    && ['read-only', 'workspace-write'].includes(permissions.sandbox ?? 'workspace-write');
}

export function nativeSandboxFailure(text) {
  return /loopback: Failed RTM_NEWADDR: Operation not permitted|uid_map[^\n]*Operation not permitted/i.test(text);
}

const bounded = detail => String(detail).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512);

export function nativeSandboxProbeMessage(result) {
  return `${NATIVE_SANDBOX_UNAVAILABLE}: Native sandbox unavailable: ${bounded(result.mechanism ?? 'CLI sandbox')} probe failed inside a systemd user unit. Probe: ${bounded(result.detail ?? 'failed')}. Verify that the named sandbox executable is installed and can create its sandbox in the worker unit environment.`;
}

/** Hooks return { mechanism, command, args }; the unit and environment path stay shared. */
export function probeWorkerNativeSandbox({ adapter = { provider: 'codex' }, probeHooks = workerNativeSandboxProbeHooks,
  spawn = spawnSync, env = process.env, envNames = ['PATH', 'HOME'], cwd,
  cache = spawn === spawnSync ? nativeSandboxProbes : undefined } = {}) {
  let mechanism = ['codex', 'muse'].includes(adapter.provider) ? 'bwrap' : `${adapter.provider} sandbox`;
  let key;
  let result;
  try {
    const hook = Object.hasOwn(probeHooks, adapter.provider) ? probeHooks[adapter.provider] : genericProbe;
    const probe = hook({ env, cwd, adapter });
    mechanism = probe.mechanism;
    key = JSON.stringify([adapter.provider, probe, cwd, [...envNames].sort().map(name => [name, env[name]])]);
    if (cache?.has(key)) return cache.get(key);
    const managerEnvNames = resolveManagerEnvNames({ spawn });
    const command = process.execPath;
    const args = [fileURLToPath(new URL('./worker-isolation.mjs', import.meta.url)), '--worker-environment',
      JSON.stringify(unitEnvironmentNames(envNames)), '--', probe.command, ...probe.args];
    const argv = buildWorkerIsolationArgs({ unit: proposeWorkerUnitName(`sandbox-probe-${process.pid}-${++sequence}`),
      command, args, cwd, env, envNames, managerEnvNames, memoryMaxGb: 0.25, attached: true,
      extraProperties: ['RuntimeMaxSec=5s', 'TimeoutStopSec=1s'] });
    const observed = spawn(resolveSystemdRun(), ['--collect', ...argv.slice(1)], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 4096, env: buildSystemdClientEnv({ env, envNames }) });
    result = observed.status === 0 && !observed.error ? { ok: true, mode: 'systemd-unit', mechanism }
      : { ok: false, mode: 'systemd-unit', mechanism, code: NATIVE_SANDBOX_UNAVAILABLE,
        detail: bounded(observed.error?.message ?? (String(observed.stderr ?? '').trim() || `exit ${observed.status}`)) };
  } catch (error) {
    result = { ok: false, mode: 'systemd-unit', mechanism, code: NATIVE_SANDBOX_UNAVAILABLE, detail: bounded(error.message) };
  }
  if (key) cache?.set(key, result);
  return result;
}
