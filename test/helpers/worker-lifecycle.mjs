// Synchronize fake launcher clocks with real child settlement and kernel state.
import { once } from 'node:events';
import { setTimeout as realWait } from 'node:timers/promises';
import { waitForEmptyWorkerGroup } from './reaped-worker-spawn.mjs';

export async function waitForCondition(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not observed');
    await realWait(1);
  }
}

export function observeChildClose(child) {
  // Register before a kill or any await: close is a one-shot event.
  return once(child, 'close');
}

export async function stopAndReap(child, closed, { ownedGroup = false } = {}) {
  child.stdout?.resume(); child.stderr?.resume();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closed;
  if (ownedGroup) await waitForEmptyWorkerGroup(child.pid);
}

export async function advanceUntilSettled(promise, { advance, afterStep = async () => {},
  stepMs = 5, maxMs = 3000, pause = () => realWait(1), realGraceMs = 20000, now = () => Date.now() }) {
  let settled = false, result, failure;
  promise.then(value => { result = value; settled = true; }, error => { failure = error; settled = true; });
  for (let elapsed = 0; !settled && elapsed < maxMs; elapsed += stepMs) {
    await advance(Math.min(stepMs, maxMs - elapsed));
    await afterStep();
    await pause();
  }
  // The virtual budget drives the launcher's timers; real child I/O (close events, reaping) may
  // still be in flight on a slow or instrumented host. Wait for it in real time without advancing
  // the fake clock further, so the result never depends on machine speed (main CI, 2026-10-29).
  const realDeadline = now() + realGraceMs;
  while (!settled && now() < realDeadline) {
    await afterStep();
    // Always yield to the real event loop here: an injected no-op pause would starve real I/O.
    await realWait(1);
  }
  if (!settled) throw new Error(`Worker did not settle within ${maxMs} virtual ms plus ${realGraceMs} real ms`);
  if (failure) throw failure;
  return result;
}
