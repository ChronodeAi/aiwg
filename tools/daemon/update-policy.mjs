/**
 * Opt-in update-install policy for the `update.install` maintenance job
 * (epic #3353 slice B6; decision D3: installs are check-only by default).
 *
 * `update.check` stays check-only. `update.install` proceeds only when every
 * gate passes, in order: explicit per-job opt-in (`args.install === true`),
 * valid policy, maintenance window, available update, version policy (never a
 * major unless explicitly allowed), no active AIWG work, and installer
 * preflight (the installer's own dry-run checks). Any failed gate returns a
 * `deferred` receipt with a machine-readable reason and never installs.
 *
 * Package install and provider redeployment are separate explicit steps: this
 * module only performs the package step (`updateInstallation`) and never
 * redeploys providers. An uncertain outcome (installer threw, receipt
 * malformed) is reported with `uncertain: true` so the runner routes it to
 * the existing `schedule-recovery-required` path instead of retrying it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importImpl } from '../_resolve-impl.mjs';

export const UPDATE_CHANNELS = Object.freeze(['stable', 'edge']);
export const VERSION_POLICIES = Object.freeze(['patch', 'minor', 'any']);

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map();

function civilParts(ms, timezone) {
  if (!formatters.has(timezone)) {
    // Same named-zone civil-time approach as cron-scheduler.mjs: the Intl
    // wall clock is the source of truth, so DST folds/gaps behave the same.
    formatters.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  const parts = Object.fromEntries(formatters.get(timezone).formatToParts(ms).map(p => [p.type, p.value]));
  return { weekday: WEEKDAYS.indexOf(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * Validate the per-job update policy (`job.args` for `update.install`).
 * Returns an array of human-readable errors; empty means valid.
 */
export function validateUpdatePolicy(args = {}) {
  const errors = [];
  if (args.channel !== undefined && !UPDATE_CHANNELS.includes(args.channel)) {
    errors.push(`channel must be one of: ${UPDATE_CHANNELS.join(', ')}`);
  }
  if (args.versionPolicy !== undefined && !VERSION_POLICIES.includes(args.versionPolicy)) {
    errors.push(`versionPolicy must be one of: ${VERSION_POLICIES.join(', ')}`);
  }
  if (args.allowMajor !== undefined && typeof args.allowMajor !== 'boolean') {
    errors.push('allowMajor must be a boolean');
  }
  if (args.install !== undefined && typeof args.install !== 'boolean') {
    errors.push('install must be a boolean');
  }
  if (args.windows !== undefined) {
    if (!Array.isArray(args.windows) || args.windows.length === 0) {
      errors.push('windows must be a non-empty array of { start, end, days?, timezone? }');
    } else {
      args.windows.forEach((window, index) => {
        const label = `windows[${index}]`;
        if (!window || typeof window !== 'object') { errors.push(`${label} must be an object`); return; }
        for (const key of ['start', 'end']) {
          if (typeof window[key] !== 'string' || !TIME_RE.test(window[key])) {
            errors.push(`${label}.${key} must be HH:MM (24h)`);
          }
        }
        if (window.days !== undefined) {
          if (!Array.isArray(window.days) || window.days.length === 0 ||
            window.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
            errors.push(`${label}.days must be a non-empty array of 0 (Sun) through 6 (Sat)`);
          }
        }
        if (window.timezone !== undefined) {
          try { new Intl.DateTimeFormat('en', { timeZone: window.timezone }); }
          catch { errors.push(`${label}.timezone is not a known IANA zone`); }
        }
      });
    }
  }
  return errors;
}

function parseTriple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Classify the bump from current to latest: none|patch|minor|major|unknown. */
export function classifyBump(current, latest) {
  const from = parseTriple(current);
  const to = parseTriple(latest);
  if (!from || !to) return 'unknown';
  if (to[0] !== from[0]) return 'major';
  if (to[1] !== from[1]) return 'minor';
  if (to[2] !== from[2]) return 'patch';
  return 'none';
}

/** Version-policy gate: patch < minor < any; major always needs allowMajor. */
export function versionAllowed(current, latest, { versionPolicy = 'patch', allowMajor = false } = {}) {
  const bump = classifyBump(current, latest);
  if (bump === 'none' || bump === 'unknown') return { allowed: false, bump, reason: `no-${bump}-upgrade` };
  if (bump === 'major' && !allowMajor) return { allowed: false, bump, reason: 'major-not-allowed' };
  if (bump === 'major') return { allowed: true, bump, reason: 'major-explicitly-allowed' };
  const rank = { patch: 0, minor: 1, any: 2 };
  const ceiling = rank[versionPolicy] ?? 0;
  if (rank[bump] <= ceiling) return { allowed: true, bump, reason: `within-${versionPolicy}-policy` };
  return { allowed: false, bump, reason: 'version-policy' };
}

/**
 * Maintenance-window gate. `windows` entries are
 * `{ start: 'HH:MM', end: 'HH:MM', days?: [0-6 Sun-Sat], timezone? }`; ranges
 * wrap past midnight. No windows configured means installs are allowed at any
 * time (the `install: true` opt-in remains the safety gate).
 */
export function inMaintenanceWindow(nowMs, windows, fallbackTimezone = 'UTC') {
  if (!windows || windows.length === 0) return { inside: true, reason: 'no-window-configured' };
  for (const window of windows) {
    const timezone = window.timezone || fallbackTimezone;
    let parts;
    try { parts = civilParts(nowMs, timezone); }
    catch { continue; }
    if (parts.weekday < 0) continue;
    if (window.days && !window.days.includes(parts.weekday)) continue;
    const [sh, sm] = window.start.split(':').map(Number);
    const [eh, em] = window.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const inside = start <= end
      ? parts.minutes >= start && parts.minutes < end
      : parts.minutes >= start || parts.minutes < end;
    if (inside) return { inside: true, reason: `in-window:${window.start}-${window.end}@${timezone}` };
  }
  return { inside: false, reason: 'outside-maintenance-window' };
}

/**
 * Read-only view of the daemon task store for active-work detection.
 * Fail-closed: only a missing file (ENOENT) means "no daemon work". Any
 * other read or parse error yields `unavailable`, which `detectActiveWork`
 * turns into an active `work-detection-unavailable:<reason>` entry.
 */
export function readStoreWork(cwd) {
  const file = path.join(cwd, '.aiwg', 'daemon', 'tasks.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { busySchedules: [], busyTasks: [], unavailable: null };
    return { busySchedules: [], busyTasks: [], unavailable: `work-detection-unavailable:${error.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    const schedules = Array.isArray(parsed.schedules) ? parsed.schedules : [];
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    return {
      busySchedules: schedules
        .filter(s => ['running', 'blocked', 'retry', 'pending'].includes(s?.state))
        .map(s => s?.job?.id || '?'),
      busyTasks: tasks
        .filter(t => ['running', 'queued'].includes(t?.state))
        .map(t => t?.id || '?'),
      unavailable: null,
    };
  } catch (error) {
    return { busySchedules: [], busyTasks: [], unavailable: `work-detection-unavailable:${error.message}` };
  }
}

/**
 * Live ralph loops via the existing launcher registry reader
 * (`getLoopStatuses` in `src/cli/handlers/ralph-launcher.ts`), which already
 * folds process liveness into each entry. Falls back to reading the same
 * registry file directly when the compiled reader is unavailable.
 */
export async function readActiveLoops(cwd) {
  try {
    const { getLoopStatuses } = await importImpl(import.meta.url, 'cli/handlers/ralph-launcher.js');
    return getLoopStatuses(cwd)
      .filter(entry => entry?.status === 'running')
      .map(entry => entry?.loopId || '?');
  } catch {
    try {
      const raw = fs.readFileSync(path.join(cwd, '.aiwg', 'ralph-external', 'launcher-registry.json'), 'utf8');
      const loops = JSON.parse(raw).loops || {};
      return Object.entries(loops)
        .filter(([, entry]) => entry?.status === 'running' && isAlive(entry?.pid))
        .map(([loopId]) => loopId);
    } catch {
      return [];
    }
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * Direct-worker run directories known to AIWG launchers. There is no shared
 * default `--runs-root`: every launcher records a per-worker `--run-dir`
 * (Mission Control writes `<root>/.aiwg/ralph-external/mc/sessions/<session>/<mission>.run`;
 * loop launches record `managedWorker.runDir` in the launcher registry).
 * Missing roots mean "no workers"; any other discovery error throws so the
 * caller fails closed.
 */
export function defaultWorkerRunDirs(cwd) {
  const runDirs = [];
  const sessionsDir = path.join(cwd, '.aiwg', 'ralph-external', 'mc', 'sessions');
  let sessions;
  try {
    sessions = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (sessions) {
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      let children;
      try {
        children = fs.readdirSync(path.join(sessionsDir, session.name), { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const child of children) {
        if (child.isDirectory() && child.name.endsWith('.run')) {
          runDirs.push(path.join(sessionsDir, session.name, child.name));
        }
      }
    }
  }
  const registryFile = path.join(cwd, '.aiwg', 'ralph-external', 'launcher-registry.json');
  let registryRaw;
  try {
    registryRaw = fs.readFileSync(registryFile, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (registryRaw !== undefined) {
    const loops = JSON.parse(registryRaw).loops || {};
    for (const entry of Object.values(loops)) {
      if (typeof entry?.managedWorker?.runDir === 'string' && entry.managedWorker.runDir) {
        runDirs.push(path.resolve(cwd, entry.managedWorker.runDir));
      }
    }
  }
  return [...new Set(runDirs)];
}

/** Default `sampleWorkerStatus` entry point (same reader `aiwg ralph-external --status --workers` uses). */
async function defaultSampleWorker({ runDir }) {
  const { sampleWorkerStatus } = await import('../ralph-external/process-monitor.mjs');
  return sampleWorkerStatus({ runDir });
}

/**
 * Live direct workers via the existing `sampleWorkerStatus` reader. Any
 * worker row whose `terminal` flag is not true (launching/started/active/
 * quiet/stalled/hung, plus unreadable rows) counts as active work.
 * An incomplete sample or a sampler failure throws `work-detection-unavailable`
 * so the caller fails closed. `runDirs`/`sample` are injectable; production
 * passes absolute run dirs discovered by `defaultWorkerRunDirs`.
 */
export async function readActiveWorkers(cwd, { runDirs = null, sample = null } = {}) {
  const dirs = runDirs ?? defaultWorkerRunDirs(cwd);
  const sampler = sample ?? defaultSampleWorker;
  const active = [];
  for (const runDir of dirs) {
    let report;
    try {
      report = await sampler({ runDir });
    } catch (error) {
      throw new Error(`work-detection-unavailable:${error.message}`);
    }
    for (const row of report?.workers || []) {
      if (row?.terminal !== true) active.push(`direct-worker:${row?.invocationId || '?'}`);
    }
    if (!report || report.complete !== true) {
      const hint = report?.findings?.[0] || 'incomplete-sample';
      throw new Error(`work-detection-unavailable:${hint}`);
    }
  }
  return active;
}

/** Mission statuses that no longer block an install (`MissionStatus` in `src/cli/handlers/mc.ts`). */
const MISSION_TERMINAL_STATUSES = new Set(['done', 'failed', 'aborted']);

/**
 * Non-terminal Mission Control missions. There is no exported reusable
 * mission reader (`readSession`/`listSessions` are private to
 * `src/cli/handlers/mc.ts`, behind `aiwg mc status/list`), so this reads the
 * same store those commands read — `.aiwg/ralph-external/mc/sessions/*\/session.json`
 * — directly, mirroring the launcher-registry fallback in `readActiveLoops`.
 * Queued, running, and paused missions all block: a paused mission still
 * holds reservations and resumes. A missing sessions root means "no
 * missions"; any other read or parse error throws so the caller fails
 * closed.
 */
export function readActiveMissions(cwd) {
  const sessionsDir = path.join(cwd, '.aiwg', 'ralph-external', 'mc', 'sessions');
  let sessions;
  try {
    sessions = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`work-detection-unavailable:${error.message}`);
  }
  const active = [];
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const file = path.join(sessionsDir, session.name, 'session.json');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`work-detection-unavailable:${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`work-detection-unavailable:${error.message}`);
    }
    for (const mission of Array.isArray(parsed?.missions) ? parsed.missions : []) {
      if (!MISSION_TERMINAL_STATUSES.has(mission?.status)) active.push(`mission:${mission?.id || '?'}`);
    }
  }
  return active;
}

/**
 * Active-work gate. Reuses the existing detectors only: daemon task-store
 * schedules/agent tasks, ralph loop liveness, direct-worker status, and
 * Mission Control missions. Returns `{ active, reasons }`. Every reader
 * failure (other than "store/reader simply absent") reports
 * `active: true` with a `work-detection-unavailable:<reason>` entry.
 */
export async function detectActiveWork({ cwd = process.cwd(), taskStore = null, readLoops = readActiveLoops, readWorkers = readActiveWorkers, readMissions = readActiveMissions } = {}) {
  const reasons = [];
  const store = taskStore
    ? {
        busySchedules: (taskStore.getSchedules?.() || [])
          .filter(s => ['running', 'blocked', 'retry', 'pending'].includes(s?.state))
          .map(s => s?.job?.id || '?'),
        busyTasks: (taskStore.getTasks?.() || [])
          .filter(t => ['running', 'queued'].includes(t?.state))
          .map(t => t?.id || '?'),
        unavailable: null,
      }
    : readStoreWork(cwd);
  for (const id of store.busySchedules) reasons.push(`daemon-task:${id}`);
  for (const id of store.busyTasks) reasons.push(`agent-task:${id}`);
  if (store.unavailable) reasons.push(store.unavailable);
  for (const [reader, prefix] of [[readLoops, 'ralph-loop:'], [readWorkers, ''], [readMissions, '']]) {
    try {
      const ids = await reader(cwd);
      for (const id of ids || []) reasons.push(prefix ? `${prefix}${id}` : id);
    } catch (error) {
      const reason = String(error?.message || error);
      reasons.push(reason.startsWith('work-detection-unavailable:') ? reason : `work-detection-unavailable:${reason}`);
      return { active: true, reasons };
    }
  }
  return { active: reasons.length > 0, reasons };
}

// Injectable seams for tests. Production always uses the lazy defaults, which
// resolve the checker's check-only probe and the installer's own preflight and
// install entry points — never a copy of their logic.
const testSeams = {};
export function setUpdateInstallSeams(seams) { Object.assign(testSeams, seams); }
export function resetUpdateInstallSeams() { for (const key of Object.keys(testSeams)) delete testSeams[key]; }

/**
 * Resolve the owner entry points, loading the real checker/installer only for
 * keys the caller did not inject. Tests inject every seam, so they never
 * perform a probe or install and never need a built dist/.
 */
async function resolveDeps(overrides = {}) {
  const merged = { now: Date.now, detectActiveWork, ...testSeams, ...overrides };
  if (!merged.checkUpdateStatus || !merged.detectInstallMode || !merged.dryRunInstall || !merged.performInstall) {
    const [{ checkUpdateStatus }, service] = await Promise.all([
      importImpl(import.meta.url, 'update/checker.mjs'),
      importImpl(import.meta.url, 'update/service.mjs'),
    ]);
    merged.checkUpdateStatus ??= checkUpdateStatus;
    merged.detectInstallMode ??= service.detectInstallMode;
    merged.dryRunInstall ??= options => service.updateInstallation({ ...options, dryRun: true });
    merged.performInstall ??= options => service.updateInstallation(options);
  }
  return merged;
}

function deferred(reason, summary, detail) {
  return { exitStatus: 2, state: 'deferred', reason, summary, detail };
}

/**
 * Run one `update.install` job through every gate. Returns an owner receipt:
 * `{ exitStatus, state?, reason?, summary, detail?, uncertain? }`.
 */
export async function runUpdateInstall(job, overrides = {}) {
  const args = job?.args || {};
  const channel = args.channel || 'stable';

  // These gates need no owner entry points, so refusals never load them.
  if (args.install !== true) {
    return deferred('install-not-enabled',
      'Refusing update.install: installs are check-only by default (decision D3); enable per job with args.install: true',
      { channel, checkOnly: true });
  }
  const policyErrors = validateUpdatePolicy(args);
  if (policyErrors.length > 0) {
    return deferred('invalid-policy', `Refusing update.install: ${policyErrors.join('; ')}`, { channel });
  }
  const clock = overrides.now || testSeams.now || Date.now;
  const window = inMaintenanceWindow(clock(), args.windows, job.timezone || 'UTC');
  if (!window.inside) {
    return deferred('outside-maintenance-window',
      `Refusing update.install: ${window.reason}; no install is attempted outside a maintenance window`,
      { channel, window: window.reason });
  }
  const configured = await resolveDeps(overrides);

  let status;
  try {
    status = await configured.checkUpdateStatus({ channel });
  } catch (error) {
    return { exitStatus: null, uncertain: true, summary: `Update probe failed; inspect before recovery: ${error.message}` };
  }
  if (!status || status.status === 'unsupported') {
    return deferred('unsupported-channel',
      `Deferring update.install: channel '${channel}' has no read-only probe; edge installs stay manual`,
      { channel, checkOnly: true });
  }
  if (!status.available) {
    return { exitStatus: 0, summary: `Already current on ${channel} (${status.current})`,
      detail: { ...status, rollback: null, redeploy: 'not-performed' } };
  }
  const gate = versionAllowed(status.current, status.latest, args);
  if (!gate.allowed) {
    return deferred(gate.reason,
      `Refusing update.install ${status.current} → ${status.latest} (${gate.bump}): ${gate.reason}; adjust versionPolicy/allowMajor explicitly to proceed`,
      { ...status, bump: gate.bump });
  }

  const work = await configured.detectActiveWork({ cwd: overrides.cwd || process.cwd() });
  if (work.active) {
    return deferred('active-work',
      `Deferring update.install: active AIWG work detected (${work.reasons.join(', ')}); installs never run alongside live work`,
      { ...status, activeWork: work.reasons });
  }

  let preflight;
  try {
    preflight = await configured.dryRunInstall({ channel });
  } catch (error) {
    return deferred('preflight-failed',
      `Refusing update.install: installer preflight failed: ${error.message}`,
      { ...status });
  }
  if (preflight?.status === 'manual') {
    return deferred('install-manual-required',
      `Deferring update.install: ${preflight.message}`,
      { ...status, installMode: preflight.mode });
  }
  if (preflight?.status === 'unsupported-offline') {
    return deferred('preflight-failed',
      `Deferring update.install: installer is offline: ${preflight.message}`,
      { ...status });
  }

  let result;
  try {
    result = await configured.performInstall({ channel });
  } catch (error) {
    // The installer threw mid-flight: effects are unknown, so this goes to
    // the schedule-recovery-required path and is never auto-retried.
    return { exitStatus: null, uncertain: true,
      summary: `Update install outcome uncertain; inspect effects before recovery: ${error.message}`,
      detail: { ...status, attemptedInstall: true } };
  }
  if (!result || typeof result !== 'object' || (result.changed !== true && result.status !== 'updated')) {
    return { exitStatus: null, uncertain: true,
      summary: 'Update install returned an unrecognized receipt; inspect effects before recovery',
      detail: { ...status, installerResult: result || null } };
  }
  const rollback = rollbackGuidance(result, status);
  return { exitStatus: 0,
    summary: `Updated ${status.current} → ${result.version || status.latest} on ${channel}; provider redeploy NOT performed`,
    detail: { ...status, oldVersion: status.current, newVersion: result.version || status.latest,
      installMode: result.mode, rollback, redeploy: 'not-performed',
      redeployHint: 'Re-deploy providers separately when ready: aiwg update --skip-check' } };
}

function rollbackGuidance(result, status) {
  if (result.mode === 'npm' && result.command) {
    const manager = result.command.split(' ')[0];
    return { how: `Re-install the previous version: ${manager} install --global aiwg@${status.current}`,
      command: `${manager} install --global aiwg@${status.current}` };
  }
  if (result.mode === 'web') {
    return { how: 'Re-resolve the previous signed web resource release for this channel; verified cached resources remain available offline.' };
  }
  return { how: 'Manual installation: restore the previous checkout or package from your own backup before re-running.' };
}
