// Reap only this launch's retained unit after its raw exit state is recorded.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildSystemdClientEnv, resolveSystemdClient } from './systemd-client.mjs';

const owners = new WeakMap();
const recordedStops = new WeakMap();

export function createWorkerUnitOwner(unit, kind) {
  const description = `AIWG worker ${randomUUID()}`;
  return {
    properties: kind === 'unit' ? [`Description=${description}`] : [],
    track(outcome) {
      if (kind === 'unit') owners.set(outcome.child ?? outcome, { unit, description });
      return outcome;
    },
  };
}

export function resetRecordedWorkerUnit(outcome, native, { spawn = spawnSync, log = console.warn } = {}) {
  const owner = owners.get(outcome?.child ?? outcome);
  if (!owner || native?.active !== false || typeof native.result !== 'string'
    || !Number.isInteger(native.execMainStatus)) return;
  // One cleanup attempt per launch; polling and caller-supplied unit names never authorize reset.
  owners.delete(outcome?.child ?? outcome);
  try {
    const client = resolveSystemdClient('systemctl');
    const options = { encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL', env: buildSystemdClientEnv({ envNames: [] }) };
    const shown = spawn(client, ['--user', 'show', '-p', 'Description', '--value', '--', owner.unit], options);
    if (shown.error || shown.status !== 0) throw new Error(shown.error?.message ?? (String(shown.stderr ?? '').trim() || 'ownership query failed'));
    // A failed submission may have collided with somebody else's existing unit.
    if (String(shown.stdout ?? '').trim() !== owner.description) throw new Error('unit ownership does not match this launch');
    const reset = spawn(client, ['--user', 'reset-failed', '--', owner.unit], options);
    if (reset.error || reset.status !== 0) throw new Error(reset.error?.message ?? (String(reset.stderr ?? '').trim() || 'reset-failed failed'));
    return true;
  } catch (error) {
    try { log(`Worker unit cleanup failed for ${owner.unit}: ${error.message}`); } catch { /* diagnostics cannot replace the result */ }
  }
}

function recordRawStatus(outcome, native, result) {
  if (native && owners.has(outcome?.child ?? outcome)) {
    result.nativeResult = native.result;
    result.nativeExecMainStatus = native.execMainStatus ?? null;
  }
}

export function recordWorkerUnitStop(outcome, native, result, options) {
  recordRawStatus(outcome, native, result);
  if (resetRecordedWorkerUnit(outcome, native, options) === true) {
    recordedStops.set(outcome?.child ?? outcome, Object.freeze({ ...result }));
  }
  return result;
}

// A repeated teardown must not lose positive stop evidence when reset unloads the unit.
export function readRecordedWorkerUnitStop(outcome) {
  const result = recordedStops.get(outcome?.child ?? outcome);
  return result ? { ...result } : null;
}

export async function publishWorkerUnitExit(publish, outcome, native, result, options) {
  recordRawStatus(outcome, native, result);
  await publish('exit.json', result);
  resetRecordedWorkerUnit(outcome, native, options);
}
