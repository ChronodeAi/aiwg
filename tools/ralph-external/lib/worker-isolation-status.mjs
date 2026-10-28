// Read retained unit exit state and its kernel-backed recursive task count.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSystemdClientEnv, resolveSystemdClient } from './systemd-client.mjs';

function emptyCgroup(fields, readCgroup) {
  if (fields.TasksCurrent === '0') return true;
  if (/^[1-9][0-9]*$/.test(fields.TasksCurrent ?? '')) return false;
  if (!['inactive', 'failed'].includes(fields.ActiveState)) return false;
  // A loaded inactive unit can have released its cgroup entirely.
  if (fields.LoadState === 'loaded' && fields.ControlGroup === '') return true;
  const group = fields.ControlGroup;
  if (!group?.startsWith('/') || group === '/' || group.split('/').includes('..')) return false;
  try { return /^populated 0$/m.test(readCgroup(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8')); }
  catch (error) { return error.code === 'ENOENT'; }
}

/**
 * Read retained service state after launch/exit without reaping or mutation.
 * `memoryMax` is bytes. Query failures throw rather than reporting success.
 */
export function getWorkerIsolationStatus(unit, { spawn = spawnSync, timeoutMs = 10000, readCgroup = readFileSync } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  const shown = spawn(resolveSystemdClient('systemctl'), ['--user', 'show', unit, '-p', 'ActiveState',
    '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainCode', '-p', 'MainPID', '-p', 'MemoryMax', '-p', 'TasksCurrent', '-p', 'ControlGroup', '-p', 'LoadState'], { encoding: 'utf8', timeout: timeoutMs, env: buildSystemdClientEnv({ envNames: [] }) });
  if (shown.error || shown.status !== 0) {
    throw new Error(`worker status unavailable: ${shown.error?.message ?? String(shown.stderr ?? '').trim()}`);
  }
  const fields = Object.fromEntries(String(shown.stdout ?? '').trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!fields.ActiveState || !fields.Result || !fields.MemoryMax) {
    throw new Error('worker status unavailable: missing systemd properties');
  }
  return {
    active: ['inactive', 'failed'].includes(fields.ActiveState) ? false
      : ['active', 'activating', 'deactivating', 'reloading'].includes(fields.ActiveState) ? true : null,
    ...(emptyCgroup(fields, readCgroup) ? { cgroupEmpty: true } : {}),
    result: fields.Result,
    ...(fields.ExecMainStatus ? { execMainStatus: Number(fields.ExecMainStatus) } : {}),
    memoryMax: fields.MemoryMax === 'infinity' ? Infinity : Number(fields.MemoryMax),
    ...(fields.MainPID ? { mainPid: Number(fields.MainPID) } : {}),
    ...(fields.ExecMainCode ? { execMainCode: Number(fields.ExecMainCode) } : {}),
  };
}
