/** Stop authority and bounded termination proof for MCP stdout overflow. */
import { importImpl } from '../../_resolve-impl.mjs';
import { getWorkerIsolationStatus, killWorkerUnit, stopWorkerUnit } from './worker-isolation.mjs';
import { signalOwnedWorker } from '../session-launcher.mjs';
import { sampleWorkerChildren, sampleWorkerIdentity, sameWorkerIdentity } from '../process-monitor.mjs';
const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');

// Only identities sampled beneath a verified live supervisor enter this cache.
const ownedWorkers = new WeakMap();
function hasBirthIdentity(worker) {
  return Number.isSafeInteger(worker?.pid) && worker.pid > 1 && worker.pid !== process.pid
    && Number.isSafeInteger(worker.pgid) && worker.pgid > 1
    && Number.isSafeInteger(worker.uid) && worker.uid === process.getuid?.()
    && Number.isSafeInteger(worker.sessionId) && worker.sessionId > 0
    && typeof worker.startTicks === 'string' && /^\d+$/.test(worker.startTicks)
    && ['bootId', 'host', 'executable'].every(key => typeof worker[key] === 'string' && worker[key].length > 0);
}

export async function stopOverflowWorker(launch, {
  deadlineMs = 2000, pollIntervalMs = 25,
  // Kill and stop are one unit-stop authority: a caller that substitutes the stop
  // also controls the kill, so the real systemctl never bypasses it.
  stopUnit = stopWorkerUnit, killUnit = stopUnit === stopWorkerUnit ? killWorkerUnit : () => ({ ok: false }),
  unitStatus = getWorkerIsolationStatus,
  sample = sampleWorkerIdentity, children = sampleWorkerChildren, platform = process.platform,
  signal = signalOwnedWorker, killPid = (pid, sig) => process.kill(pid, sig),
  clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let delivered = false;
  const uncertain = diagnostic => ({ termination: 'uncertain', diagnostic, delivered });
  const deadline = clock() + deadlineMs;
  let diagnostic;
  // Subprocess timeouts cannot bound stalled kernel or /proc reads.
  const remaining = () => Math.max(1, deadline - clock());
  if (launch.mode === 'systemd-unit' && launch.unit) {
    // SIGKILL the unit's whole cgroup first. A plain stop sends SIGTERM and then
    // waits out the unit's stop timeout, which a worker ignoring SIGTERM outlasts
    // (#3691). The stop that follows only cleans up the dead unit.
    let killed = false;
    try { killed = !!killUnit(launch.unit, { timeoutMs: remaining() }).ok; } catch { killed = false; }
    try { delivered = !!stopUnit(launch.unit, { timeoutMs: remaining() }).ok || killed; } catch { delivered = killed; }
    if (!delivered) diagnostic = 'OG_WORKER_MCP_STOP_FAILED';
  } else {
    const child = launch.child;
    // The direct-child handle cannot prove descendant termination.
    if (platform !== 'linux') {
      try { if (!(delivered = !!signalChild(child, 'SIGKILL'))) return uncertain('OG_WORKER_MCP_STOP_FAILED'); }
      catch { return uncertain('OG_WORKER_MCP_STOP_FAILED'); }
      return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
    }
    let worker = launch.transportSupervisor ? ownedWorkers.get(launch) : null;
    if (!worker) {
      const supervisor = sample(child?.pid);
      if (!supervisor || supervisor.parentPid !== process.pid || supervisor.uid !== process.getuid?.()
        || child.exitCode !== null || child.signalCode !== null) return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
      const candidates = launch.transportSupervisor ? children(supervisor.pid) : [supervisor];
      worker = candidates?.length === 1 ? candidates[0] : null;
      if (!worker || launch.transportSupervisor && (worker.parentPid !== supervisor.pid || !hasBirthIdentity(worker))
        || !sameWorkerIdentity(supervisor, sample(supervisor.pid))) return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
      if (launch.transportSupervisor) ownedWorkers.set(launch, worker = Object.freeze({ ...worker }));
    }
    // Reuse the launcher's birth/session/UID checks; never signal a bare PID.
    if (!(delivered = !!signal(worker, 'SIGKILL'))) {
      // #3691: reparenting changes ownership topology, not process birth.
      // The cache pins birth/UID/session while the parent link is intact;
      // compare every identity field except parentPid on a fresh kernel sample.
      // This also works on retained-control retries after client.close() has
      // killed the supervisor. Never refresh the pin from an orphan or disk.
      const fresh = launch.transportSupervisor ? sample(worker.pid) : null;
      if (fresh && sameWorkerIdentity(worker, { ...fresh, parentPid: worker.parentPid })) {
        try { killPid(worker.pid, 'SIGKILL'); delivered = true; } catch { delivered = false; }
      }
      if (!delivered) return uncertain('OG_WORKER_MCP_STOP_FAILED');
    }
    // Descendants can escape the group, so its termination stays uncertain.
    return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
  }
  for (;;) {
    try { if (!unitStatus(launch.unit, { timeoutMs: remaining() }).active) return { termination: 'confirmed', delivered, ...(diagnostic ? { diagnostic } : {}) }; }
    catch { /* Retry unavailable/transient unit state until the deadline. */ }
    if (clock() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, deadline - clock()));
  }
  return uncertain(diagnostic ?? 'OG_WORKER_MCP_STOP_UNCONFIRMED');
}
