// Let real worker groups empty before delivering launcher settlement events.
import { spawn } from 'node:child_process';
import { setImmediate as yieldToKernel } from 'node:timers/promises';

export async function waitForEmptyWorkerGroup(pgid, { kill = process.kill,
  now = Date.now, pause = yieldToKernel, timeoutMs = 10000 } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try { kill(-pgid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    if (now() >= deadline) throw new Error(`Worker group ${pgid} did not empty`);
    await pause();
  }
}

export function reapedWorkerSpawn({ command, args, cwd, env, stdin }) {
  const child = spawn(command, args, { cwd, env,
    stdio: [stdin === 'closed' ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
  const emit = child.emit.bind(child);
  let emptyGroup;
  // #3709/#3712: preserve real wait status and stdio, but hold both settlement
  // paths until a real signal-0 probe observes ESRCH. Holding exit as well as
  // close prevents the exit handler's grace timer from outrunning the barrier.
  child.emit = (event, ...values) => {
    if (event !== 'exit' && event !== 'close' || child.pid === undefined) return emit(event, ...values);
    emptyGroup ??= waitForEmptyWorkerGroup(child.pid);
    emptyGroup.then(() => emit(event, ...values), error => emit('error', error));
    return true;
  };
  return { mode: 'degraded', child };
}
