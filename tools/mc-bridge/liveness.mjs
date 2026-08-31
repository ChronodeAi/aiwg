// MC bridge liveness — ADR-005 reconciled-on-read projection support.
//
// The projection seam (mc list / status / watch) previously trusted
// session.json as written by the dispatch side. Loop death never crossed
// that seam because the liveness record (heartbeats written by
// tools/ralph-external/process-monitor.mjs every 30s) was never read here.
// This module is the consumer side of that seam: a two-signal liveness
// predicate (heartbeat age AND PID existence) plus the reconcile step that
// writes terminal truth back through status-writer.mjs.
//
// Write discipline (non-negotiable, ADR-005): every reconcile write goes
// through status-writer.mjs's per-session mutex and the atomic
// tmp+rename write from queue-tailer.mjs. transitionFrom is always set on
// reconcile updates so a reconcile racing a live dispatch event loses
// cleanly ('stale') instead of clobbering. Reconcile never resurrects a
// dead session and never overwrites fresher writes.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readSession } from './queue-tailer.mjs';
import { applyStatusUpdatesBatched, markSessionState } from './status-writer.mjs';

/** Heartbeat cadence owned by process-monitor.mjs:42. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * N in the ADR's "N x 30s" threshold spec. N=2 gives 60 000 ms — deliberately
 * equal to the monitor's own staleThresholdMs (process-monitor.mjs:43), so MC
 * never declares death earlier than the component that owns the data would.
 */
export const DEFAULT_STALE_MULTIPLIER = 2;

export const DEFAULT_HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * DEFAULT_STALE_MULTIPLIER;

/**
 * Mission statuses reconcile is allowed to judge dead (ADR-005:
 * running / active / dispatched). queued/paused missions have no live loop
 * expectation and are never touched.
 */
const RECONCILABLE_STATUSES = new Set(['running', 'active', 'dispatched']);

/**
 * Terminal mission statuses for session terminalization. This codebase's
 * vocabulary is done/failed/aborted (src/cli/handlers/mc.ts MissionStatus);
 * completed/cancelled are tolerated for wire-shape compatibility with the
 * ADR wording.
 */
const TERMINAL_MISSION_STATUSES = new Set(['done', 'failed', 'aborted', 'completed', 'cancelled']);

/** Terminal session states — 'stopped' is the only one in SessionState today. */
const TERMINAL_SESSION_STATES = new Set(['stopped']);

/**
 * Heartbeat file for a loop, per the writer's convention
 * (process-monitor.mjs:264 writes `<loopId>.json` under heartbeatDir).
 *
 * @param {string} projectRoot
 * @param {string} loopId
 * @returns {string}
 */
export function heartbeatPath(projectRoot, loopId) {
  return join(projectRoot, '.aiwg', 'ralph', 'heartbeats', `${loopId}.json`);
}

/**
 * Read a loop's heartbeat record.
 * Missing record or unreadable file → null (treated as dead; fail toward truth).
 *
 * @param {string} projectRoot
 * @param {string} loopId
 * @returns {Promise<{timestamp?: number, iteration?: number, status?: string, pid?: number} | null>}
 */
export async function readHeartbeat(projectRoot, loopId) {
  try {
    const raw = await readFile(heartbeatPath(projectRoot, loopId), 'utf-8');
    const hb = JSON.parse(raw);
    return {
      timestamp: typeof hb?.timestamp === 'number' ? hb.timestamp : undefined,
      iteration: typeof hb?.iteration === 'number' ? hb.iteration : undefined,
      status: typeof hb?.status === 'string' ? hb.status : undefined,
      pid: typeof hb?.pid === 'number' ? hb.pid : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * PID existence check: kill(pid, 0) signals nothing but tests existence.
 * ESRCH → dead; EPERM → alive (process exists, owned by another user).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Resolve a mission's loop identity as recorded at dispatch time
 * (ralphLoopId/ralphPid in this codebase; executorId/loopId/pid tolerated).
 *
 * @param {object} mission
 * @returns {{loopId?: string, pid?: number}}
 */
function loopIdentityOf(mission) {
  const loopId =
    (typeof mission.ralphLoopId === 'string' && mission.ralphLoopId) ||
    (typeof mission.executorId === 'string' && mission.executorId) ||
    (typeof mission.loopId === 'string' && mission.loopId) ||
    undefined;
  const pid =
    typeof mission.ralphPid === 'number' ? mission.ralphPid :
    typeof mission.pid === 'number' ? mission.pid :
    undefined;
  return { loopId, pid };
}

/**
 * The liveness predicate (ADR-005). Live iff BOTH:
 *   1. Heartbeat age ≤ stale threshold (default N×30s = 60 000ms; falls back
 *      to the heartbeat file's mtime when the record's timestamp is absent).
 *   2. PID check passes when a PID is known. No PID → the predicate rests on
 *      heartbeat age alone.
 * Missing heartbeat record → not live (fail toward truth).
 *
 * @param {{loopId?: string, pid?: number}} loop Loop identity.
 * @param {{projectRoot?: string, now?: number, staleMultiplier?: number, heartbeatStaleMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function isLoopLive(loop, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const staleMs =
    typeof opts.heartbeatStaleMs === 'number'
      ? opts.heartbeatStaleMs
      : (typeof opts.staleMultiplier === 'number' ? opts.staleMultiplier : DEFAULT_STALE_MULTIPLIER) * HEARTBEAT_INTERVAL_MS;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  const loopId = loop?.loopId;
  const pid = typeof loop?.pid === 'number' ? loop.pid : undefined;
  if (!loopId && typeof pid !== 'number') return false; // no liveness evidence at all
  if (!loopId) return false; // heartbeat age is the required signal; no record to age-check

  const hb = await readHeartbeat(projectRoot, loopId);
  if (hb === null) {
    // Missing record or unreadable file → dead (fail toward truth). No mtime rescue.
    return false;
  }
  let ts = hb.timestamp;
  if (typeof ts !== 'number') {
    // Fall back to the heartbeat file's mtime when the record's timestamp is absent.
    try {
      ts = (await stat(heartbeatPath(projectRoot, loopId))).mtimeMs;
    } catch {
      return false;
    }
  }
  if (typeof ts !== 'number' || now - ts > staleMs) return false;

  if (typeof pid === 'number' && !pidAlive(pid)) return false; // ESRCH → dead
  return true;
}

/**
 * Reconcile a session's non-terminal missions against loop liveness and
 * terminalize the session when every mission is terminal (ADR-005).
 *
 * Dead missions are applied through applyStatusUpdatesBatched — one lock
 * acquisition, one atomic write — each with transitionFrom set to the
 * mission's current status so a racing dispatch event wins cleanly.
 *
 * @param {string} sessionJsonPath
 * @param {{projectRoot?: string, dryRun?: boolean, now?: number, heartbeatStaleMs?: number}} [opts]
 * @returns {Promise<{
 *   outcome: 'reconciled'|'unchanged'|'missing-session',
 *   reconciled: string[],
 *   transitions: Array<{missionId: string, from: string, to: string, failureReason: string}>,
 *   terminal: boolean,
 *   terminalized: boolean,
 *   dryRun: boolean,
 * }>}
 */
export async function reconcileSessionLiveness(sessionJsonPath, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const dryRun = Boolean(opts.dryRun);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const heartbeatStaleMs =
    typeof opts.heartbeatStaleMs === 'number' ? opts.heartbeatStaleMs : DEFAULT_HEARTBEAT_STALE_MS;
  const iso = new Date(now).toISOString();

  const session = await readSession(sessionJsonPath);
  if (!session) {
    return { outcome: 'missing-session', reconciled: [], transitions: [], terminal: false, terminalized: false, dryRun };
  }

  const missions = Array.isArray(session.missions) ? session.missions : [];

  // 1. Judge each non-terminal mission's loop.
  const updates = [];
  const transitions = [];
  for (const mission of missions) {
    if (!mission || typeof mission.id !== 'string') continue;
    if (!RECONCILABLE_STATUSES.has(mission.status)) continue;
    const identity = loopIdentityOf(mission);
    if (await isLoopLive(identity, { projectRoot, now, heartbeatStaleMs })) continue;
    const failureReason = `loop died ${iso}`;
    transitions.push({ missionId: mission.id, from: mission.status, to: 'failed', failureReason });
    updates.push({
      missionId: mission.id,
      status: 'failed',
      transitionFrom: mission.status, // lose cleanly ('stale') if a live handler moved it first
      patch: { failureReason, reconciledAt: iso },
    });
  }

  // 2. Write back through the writer: one lock acquisition, one atomic write.
  let applied = [];
  if (!dryRun && updates.length > 0) {
    const batch = await applyStatusUpdatesBatched(sessionJsonPath, updates);
    if (batch.outcome === 'missing-session') {
      return { outcome: 'missing-session', reconciled: [], transitions, terminal: false, terminalized: false, dryRun };
    }
    applied = batch.applied || [];
  }
  const reconciled = dryRun ? updates.map(u => u.missionId) : applied;

  // 3. Session terminalization — the write-back stuck missions never got.
  //    Re-read post-write state; the writer owns the file after reconcile.
  let current = session;
  if (!dryRun && applied.length > 0) {
    current = (await readSession(sessionJsonPath)) || session;
  }
  const currentMissions = Array.isArray(current.missions) ? current.missions : [];
  const terminal =
    currentMissions.length > 0 &&
    currentMissions.every(m => m && TERMINAL_MISSION_STATUSES.has(m.status));
  const alreadyTerminal = TERMINAL_SESSION_STATES.has(current.state);

  let terminalized = false;
  if (!dryRun && terminal && !alreadyTerminal) {
    const res = await markSessionState(sessionJsonPath, { state: 'stopped' });
    terminalized = res.outcome === 'updated';
  }

  return {
    outcome: reconciled.length > 0 || terminalized ? 'reconciled' : 'unchanged',
    reconciled,
    transitions,
    terminal,
    terminalized,
    dryRun,
  };
}
