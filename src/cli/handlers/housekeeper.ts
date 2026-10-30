/**
 * Housekeeper command handler (epic #3353 slice B5).
 *
 * `aiwg housekeeper start|stop|status|run-once`,
 * `aiwg housekeeper job list|register|disable`,
 * `aiwg housekeeper watch list|register|disable`,
 * `aiwg housekeeper install|uninstall`.
 *
 * Conventions followed: strict flag parsing via `src/cli/flag-parsing.ts`
 * (a present-but-valueless flag is exit 2 before any spawn or write),
 * `isInteractive` for every prompt decision, `handlerResultFromError`
 * in the top-level catch, and ChildProcess signalling via `signalChild`.
 * The daemon itself is reused from `tools/daemon/` (decision D1) through
 * the script runner and spawned processes — `src/` never imports `tools/`.
 *
 * @tests @test/unit/cli/handlers/housekeeper.test.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { signalChild } from '../../process/signal-child.mjs';
import { EXIT_CODES, handlerResultFromError } from '../errors.js';
import { MissingFlagValueError, requireFlagValue } from '../flag-parsing.js';
import { isInteractive } from '../env.js';
import { askString, askYesNo, createPromptInterface, listSelect } from '../prompt-utils.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { createScriptRunner } from './script-runner.js';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  HOUSEKEEPER_PROFILE,
  MAINTENANCE_KINDS,
  validateMemoryJobArgs,
  getDaemonProfile,
  getScheduleJobs,
  getWatchPaths,
  loadDaemonConfig,
  saveDaemonConfig,
  seedHousekeeperConfig,
  setDaemonProfile,
  setScheduleJobs,
  setWatchPaths,
  type DaemonJobConfig,
} from '../../housekeeper/daemon-config.js';
import {
  daemonPaths,
  describeRunning,
  pollUntil,
  removeLifecycleFiles,
  stopDaemon,
  type DaemonPaths,
} from '../../housekeeper/lifecycle.js';
import { requestDaemon } from '../../housekeeper/ipc.js';
import {
  buildHousekeeperStatus,
  normalizeJobState,
  toFreshnessEntry,
  type HousekeeperFreshnessEntry,
  type HousekeeperInstallOutcome,
  type HousekeeperJobStatus,
} from '../../housekeeper/status.js';
import {
  installBackends,
  normalizePlatform,
  runSupported,
  runUnsupportedMessage,
} from '../../housekeeper/platform.js';
import {
  HOUSEKEEPER_LAUNCHD_LABEL,
  HOUSEKEEPER_SERVICE_NAME,
  HOUSEKEEPER_TIMER_NAME,
  defaultAiwgBin,
  launchdAgentDir,
  renderLaunchdPlist,
  renderSystemdService,
  renderSystemdTimer,
  systemdUserDir,
} from '../../housekeeper/units.js';

const VALUE_FLAGS = [
  '--job', '--id', '--kind', '--schedule', '--cron', '--timezone',
  '--timeout-ms', '--retries', '--path', '--events', '--extensions',
  '--fire-time', '--calendar', '--state-dir',
  '--scope', '--provider', '--evidence', '--usage', '--plan', '--confirmed-digest',
] as const;

const SWITCH_FLAGS = new Set([
  '--foreground', '--force', '--json', '--dry-run', '--non-interactive',
  '--systemd-user', '--launchd', '--with-timer', '--yes', '-y',
]);

function flagValue(args: readonly string[], ...names: string[]): string | undefined {
  return requireFlagValue(args, {}, ...names);
}

function hasSwitch(args: readonly string[], ...names: string[]): boolean {
  return names.some((name) => args.includes(name));
}

function usageError(message: string, hint?: string): HandlerResult {
  return {
    exitCode: EXIT_CODES.USAGE,
    message: hint ? `${message} — hint: ${hint}` : message,
  };
}

function checkUnknownFlags(args: readonly string[], command: string): HandlerResult | null {
  for (const token of args) {
    if (token === '--') break;
    if (!token.startsWith('--')) continue;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if ((VALUE_FLAGS as readonly string[]).includes(name)) continue;
    if (SWITCH_FLAGS.has(name)) continue;
    return usageError(
      `aiwg housekeeper ${command}: unknown flag '${name}'.`,
      'Run `aiwg housekeeper --help` for usage.',
    );
  }
  return null;
}

export function housekeeperHelpText(): string {
  return [
    'AIWG housekeeper — deterministic maintenance daemon (epic #3353).',
    '',
    'Usage:',
    '  aiwg housekeeper start [--foreground] [--force] [--non-interactive]',
    '  aiwg housekeeper stop [--non-interactive]',
    '  aiwg housekeeper status [--json] [--non-interactive]',
    '  aiwg housekeeper run-once --job <id> [--json] [--dry-run] [--fire-time <iso>] [--non-interactive]',
    '  aiwg housekeeper job list [--json]',
    '  aiwg housekeeper job register --id <id> --kind <kind> --schedule <cron> [--timezone <tz>] [--timeout-ms <n>] [--retries 0|1|2] [--non-interactive]',
    '  aiwg housekeeper job disable --id <id> [--non-interactive]',
    '  aiwg housekeeper watch list [--json]',
    '  aiwg housekeeper watch register --path <dir> [--events <a,b>] [--extensions <.ts>] [--non-interactive]',
    '  aiwg housekeeper watch disable --path <dir> [--non-interactive]',
    '  aiwg housekeeper install --systemd-user [--with-timer] [--dry-run] [--non-interactive]',
    '  aiwg housekeeper install --launchd [--dry-run] [--non-interactive]',
    '  aiwg housekeeper uninstall [--dry-run] [--non-interactive]',
    '',
    'Lifecycle:',
    '  start         Run the housekeeper-profile daemon (scheduler, watcher, minimal IPC)',
    '  stop          Graceful shutdown (SIGTERM, then SIGKILL) and pid/lock release',
    '  status        Daemon, job and per-index freshness state; --json is machine-readable',
    '  run-once      Run one due job without a daemon; prints its receipt and exits',
    '  job           List, register or disable scheduled maintenance jobs',
    '  watch         List, register or disable watched roots (change hints only)',
    '  install       Write autostart units (explicit opt-in; never enabled implicitly)',
    '  uninstall     Remove autostart units written by install',
    '',
    `Maintenance kinds: ${MAINTENANCE_KINDS.join(', ')}`,
    'Update checks are check-only by default; installs need an explicit opt-in.',
    'Memory audit/recommend: [--scope project|global|provider] [--provider <id>].',
    'Memory recommend also accepts [--evidence <file>] [--usage <file>]; never creates plans.',
    'Memory apply requires --plan <reviewed-file> --confirmed-digest <recorded-digest>.',
    'It executes only the named reviewed plan; omitting --schedule registers a one-shot run-once job.',
    '',
    'Platforms: Linux + systemd (documented) · Linux w/o systemd and macOS',
    '(foreground start, cron/launchd calling run-once; launchd plist best-effort).',
    'Windows is not supported — use WSL2 and follow the Linux rows.',
    '',
    'Every value above can be passed as a flag; without one the command asks',
    'only on an interactive terminal, otherwise it fails naming the flag.',
  ].join('\n');
}

interface Ctx {
  ctx: HandlerContext;
  args: string[];
  cwd: string;
  frameworkRoot: string;
  nonInteractive: boolean;
  interactive: boolean;
}

async function runOnceSupportedOrThrow(platform: string): Promise<void> {
  if (!runSupported(platform)) {
    const error = new Error(runUnsupportedMessage());
    (error as NodeJS.ErrnoException).code = 'UNSUPPORTED_PLATFORM';
    throw error;
  }
}

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${flag} must be a positive integer (got '${raw}')`);
  }
  return n;
}

function parseCronExpression(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^\S+(\s+\S+){4}$/.test(raw.trim())) {
    throw new Error(`--schedule must be a five-field cron expression (got '${raw}')`);
  }
  return raw.trim();
}

async function promptMissing(c: Ctx, question: string, fallback = ''): Promise<string | null> {
  if (!c.interactive) return null;
  const rl = createPromptInterface();
  try {
    return await askString(rl, question, fallback, c.ctx.signal);
  } finally {
    rl.close();
  }
}

async function requireValueOrPrompt(
  c: Ctx, flag: string, current: string | undefined, question: string,
): Promise<string | { error: HandlerResult }> {
  if (current !== undefined && current !== '') return current;
  const answered = await promptMissing(c, question);
  if (answered !== null && answered !== '') return answered;
  return {
    error: usageError(
      `aiwg housekeeper: ${flag} requires a value.`,
      `Pass ${flag} <value> or run on an interactive terminal.`,
    ),
  };
}

// ── start ─────────────────────────────────────────────────────────

async function ensureHousekeeperConfig(c: Ctx, force: boolean): Promise<{ path: string } | { error: HandlerResult }> {
  const loaded = loadDaemonConfig(c.cwd);
  if (!loaded.existed) {
    saveDaemonConfig(loaded.path, seedHousekeeperConfig());
    return { path: loaded.path };
  }
  const profile = getDaemonProfile(loaded.config);
  if (profile === HOUSEKEEPER_PROFILE) return { path: loaded.path };
  const label = profile === undefined ? 'no daemon.profile' : `daemon.profile '${profile}'`;
  if (!force) {
    if (c.interactive) {
      const rl = createPromptInterface();
      try {
        const ok = await askYesNo(
          rl,
          `  Daemon config has ${label}; switch it to '${HOUSEKEEPER_PROFILE}'? [y/N]: `,
          false,
          c.ctx.signal,
        );
        if (!ok) {
          return { error: { exitCode: EXIT_CODES.GENERAL, message: 'aiwg housekeeper: start aborted; daemon config left unchanged.' } };
        }
      } finally {
        rl.close();
      }
    } else {
      return {
        error: usageError(
          `aiwg housekeeper: refusing to change daemon config (${label}); pass --force to switch it to '${HOUSEKEEPER_PROFILE}'.`,
          `Pass --force or run on an interactive terminal to confirm.`,
        ),
      };
    }
  }
  setDaemonProfile(loaded.config, HOUSEKEEPER_PROFILE);
  saveDaemonConfig(loaded.path, loaded.config);
  return { path: loaded.path };
}

function spawnForegroundDaemon(c: Ctx, paths: DaemonPaths): Promise<number> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(process.execPath, [paths.daemonScript], {
      stdio: 'inherit',
      cwd: c.cwd,
      env: process.env,
    });
    const forward = (signal: NodeJS.Signals): void => {
      signalChild(child, signal);
    };
    const onSigterm = (): void => { forward('SIGTERM'); };
    const onSigint = (): void => { forward('SIGINT'); };
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    const abort = (): void => { forward('SIGTERM'); };
    c.ctx.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => {
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
      c.ctx.signal?.removeEventListener('abort', abort);
      resolve(1);
    });
    child.once('exit', (code) => {
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
      c.ctx.signal?.removeEventListener('abort', abort);
      resolve(code ?? 0);
    });
  });
}

async function executeStart(c: Ctx): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(c.args, 'start');
  if (unknown) return unknown;
  const foreground = hasSwitch(c.args, '--foreground');
  const force = hasSwitch(c.args, '--force', '--yes', '-y');
  try {
    await runOnceSupportedOrThrow(process.platform);
  } catch (error) {
    return handlerResultFromError(error);
  }
  const paths = daemonPaths(c.cwd, c.frameworkRoot);
  const state = describeRunning(paths.pidFile);
  if (state.running) {
    return {
      exitCode: EXIT_CODES.GENERAL,
      message: `aiwg housekeeper: daemon is already running (PID ${state.pid}). Stop it first with 'aiwg housekeeper stop'.`,
    };
  }
  const ensured = await ensureHousekeeperConfig(c, force);
  if ('error' in ensured) return ensured.error;
  if (state.stale) removeLifecycleFiles(paths);

  if (foreground) {
    const code = await spawnForegroundDaemon(c, paths);
    return { exitCode: code };
  }

  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  let logFd: number;
  try {
    logFd = fs.openSync(paths.logFile, 'a');
  } catch (error) {
    return handlerResultFromError(error);
  }
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [paths.daemonScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: c.cwd,
      env: process.env,
    });
  } catch (error) {
    fs.closeSync(logFd);
    return handlerResultFromError(error);
  }
  child.unref();
  fs.closeSync(logFd);
  const appeared = await pollUntil(() => describeRunning(paths.pidFile).running, { timeoutMs: 15_000 });
  if (!appeared) {
    return {
      exitCode: EXIT_CODES.GENERAL,
      message: `aiwg housekeeper: daemon failed to start. See ${paths.logFile} for details.`,
    };
  }
  const pid = describeRunning(paths.pidFile).pid;
  return { exitCode: EXIT_CODES.OK, message: `Housekeeper daemon started (PID ${pid}). Logs: ${paths.logFile}` };
}

// ── stop ──────────────────────────────────────────────────────────

async function executeStop(c: Ctx): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(c.args, 'stop');
  if (unknown) return unknown;
  const paths = daemonPaths(c.cwd, c.frameworkRoot);
  const outcome = await stopDaemon({ paths });
  if (outcome.outcome === 'not-running') {
    return { exitCode: EXIT_CODES.OK, message: 'Housekeeper daemon is not running' };
  }
  if (outcome.outcome === 'stale-cleaned') {
    return { exitCode: EXIT_CODES.OK, message: `Removed stale housekeeper pid/lock files (dead PID ${outcome.pid})` };
  }
  return {
    exitCode: EXIT_CODES.OK,
    message: outcome.forced
      ? `Housekeeper daemon (PID ${outcome.pid}) did not stop gracefully; sent SIGKILL`
      : `Housekeeper daemon (PID ${outcome.pid}) stopped gracefully`,
  };
}

// ── status ────────────────────────────────────────────────────────

/** Offline jobs: config entries joined with persisted receipts (fail-soft). */
export function readLocalJobs(cwd: string, config: Record<string, unknown>): HousekeeperJobStatus[] {
  const jobs = getScheduleJobs(config);
  let schedules: Array<{
    job?: { id?: string };
    lastReceipt?: { state?: unknown; finishedAt?: string };
    lastRun?: string | null;
    nextRun?: string | null;
  }> = [];
  try {
    const raw = fs.readFileSync(path.join(cwd, '.aiwg', 'daemon', 'tasks.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { schedules?: unknown }).schedules)) {
      schedules = (parsed as { schedules: typeof schedules }).schedules;
    }
  } catch {
    schedules = [];
  }
  const byId = new Map(schedules.filter((s) => s?.job?.id).map((s) => [s.job!.id as string, s]));
  return jobs.map((job) => {
    const record = byId.get(job.id);
    return {
      id: job.id,
      kind: job.kind ?? null,
      lastState: normalizeJobState(record?.lastReceipt?.state),
      lastRun: record?.lastRun ?? null,
      nextFire: record?.nextRun ?? null,
    };
  });
}

export function readLocalLastCheck(cwd: string, config: Record<string, unknown>): string | null {
  void config;
  try {
    const raw = fs.readFileSync(path.join(cwd, '.aiwg', 'daemon', 'tasks.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      schedules?: Array<{ job?: { kind?: string }; lastReceipt?: { finishedAt?: string } }>;
    };
    const checks = (parsed.schedules ?? [])
      .filter((s) => s?.job?.kind === 'update.check')
      .map((s) => s.lastReceipt?.finishedAt)
      .filter((v): v is string => typeof v === 'string');
    return checks.length ? checks.sort().pop()! : null;
  } catch {
    return null;
  }
}

/** Offline install outcome: the latest update.install receipt, if any. */
export function readLocalLastInstall(cwd: string): HousekeeperInstallOutcome | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.aiwg', 'daemon', 'tasks.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      schedules?: Array<{
        job?: { kind?: string };
        lastReceipt?: {
          state?: unknown; reason?: unknown; finishedAt?: unknown; summary?: unknown;
          detail?: { oldVersion?: unknown; newVersion?: unknown };
        };
      }>;
    };
    const installs = (parsed.schedules ?? [])
      .filter((s) => s?.job?.kind === 'update.install' && typeof s.lastReceipt?.finishedAt === 'string')
      .sort((a, b) => ((a.lastReceipt!.finishedAt as string) < (b.lastReceipt!.finishedAt as string) ? -1 : 1));
    const last = installs.pop()?.lastReceipt;
    if (!last) return null;
    return {
      state: typeof last.state === 'string' ? last.state : 'unknown',
      reason: typeof last.reason === 'string' ? last.reason : null,
      finishedAt: typeof last.finishedAt === 'string' ? last.finishedAt : null,
      summary: typeof last.summary === 'string' ? last.summary : null,
      oldVersion: typeof last.detail?.oldVersion === 'string' ? last.detail.oldVersion : null,
      newVersion: typeof last.detail?.newVersion === 'string' ? last.detail.newVersion : null,
    };
  } catch {
    return null;
  }
}

/** Offline update availability from the latest update.check receipt detail. */
export function readLocalUpdateAvailable(cwd: string): boolean | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.aiwg', 'daemon', 'tasks.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      schedules?: Array<{ job?: { kind?: string }; lastReceipt?: { detail?: { available?: unknown } } }>;
    };
    for (const s of parsed.schedules ?? []) {
      if (s?.job?.kind !== 'update.check') continue;
      const available = s.lastReceipt?.detail?.available;
      if (typeof available === 'boolean') return available;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeInstallOutcome(value: unknown): HousekeeperInstallOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  if (str(record['finishedAt']) === null && str(record['summary']) === null) return null;
  return {
    state: str(record['state']) ?? 'unknown',
    reason: str(record['reason']),
    finishedAt: str(record['finishedAt']),
    summary: str(record['summary']),
    oldVersion: str(record['oldVersion']),
    newVersion: str(record['newVersion']),
  };
}

async function collectFreshness(cwd: string): Promise<HousekeeperFreshnessEntry[]> {
  try {
    const { probeIndexStatus } = await import('../../artifacts/index-status.js');
    const report = await probeIndexStatus(cwd);
    return (report.indices ?? []).map(toFreshnessEntry);
  } catch {
    return [];
  }
}

function normalizeIpcJobs(value: unknown): HousekeeperJobStatus[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      id: typeof record['id'] === 'string' ? (record['id'] as string) : '?',
      kind: typeof record['kind'] === 'string' ? (record['kind'] as string) : null,
      lastState: normalizeJobState(record['lastState']),
      lastRun: typeof record['lastRun'] === 'string' ? (record['lastRun'] as string) : null,
      nextFire: typeof record['nextFire'] === 'string' ? (record['nextFire'] as string) : null,
    };
  });
}

function normalizeIpcFreshness(value: unknown): HousekeeperFreshnessEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const index = typeof record['index'] === 'string' ? (record['index'] as string) : '?';
    return toFreshnessEntry({
      name: index,
      status: typeof record['state'] === 'string' ? (record['state'] as string) : 'unsupported',
      policy: typeof record['targetMs'] === 'number' ? { targetStaleAfterMs: record['targetMs'] as number } : {},
      convergence: typeof record['converged'] === 'boolean' ? { converged: record['converged'] as boolean } : {},
    });
  });
}

async function executeStatus(c: Ctx): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(c.args, 'status');
  if (unknown) return unknown;
  const json = hasSwitch(c.args, '--json');
  const paths = daemonPaths(c.cwd, c.frameworkRoot);
  const loaded = loadDaemonConfig(c.cwd);
  const live = describeRunning(paths.pidFile).running;

  let mode: 'daemon' | 'offline' = 'offline';
  let pid: number | null = null;
  let uptimeSeconds = 0;
  let jobs: HousekeeperJobStatus[] | null = null;
  let freshness: HousekeeperFreshnessEntry[] | null = null;
  let lastCheck: string | null = null;
  let available: boolean | null = null;
  let lastInstall: HousekeeperInstallOutcome | null = null;

  if (live) {
    mode = 'daemon';
    pid = describeRunning(paths.pidFile).pid;
    try {
      const result = (await requestDaemon(paths.socketPath, 'housekeeper.status')) as Record<string, unknown>;
      jobs = normalizeIpcJobs(result['jobs']) ?? readLocalJobs(c.cwd, loaded.config);
      freshness = normalizeIpcFreshness(result['freshness']);
      uptimeSeconds = typeof result['uptimeSeconds'] === 'number' ? result['uptimeSeconds'] as number : 0;
      const update = result['update'] as Record<string, unknown> | undefined;
      lastCheck = typeof update?.['lastCheck'] === 'string' ? (update['lastCheck'] as string) : null;
      available = typeof update?.['available'] === 'boolean' ? (update['available'] as boolean) : null;
      lastInstall = normalizeInstallOutcome(update?.['lastInstall']) ?? readLocalLastInstall(c.cwd);
    } catch {
      try {
        const result = (await requestDaemon(paths.socketPath, 'daemon.status')) as Record<string, unknown>;
        uptimeSeconds = typeof result['uptime_seconds'] === 'number' ? result['uptime_seconds'] as number : 0;
      } catch { /* IPC unavailable; report what the pid file proves */ }
      jobs = readLocalJobs(c.cwd, loaded.config);
      lastCheck = readLocalLastCheck(c.cwd, loaded.config);
      available = readLocalUpdateAvailable(c.cwd);
      lastInstall = readLocalLastInstall(c.cwd);
    }
  } else {
    jobs = readLocalJobs(c.cwd, loaded.config);
    lastCheck = readLocalLastCheck(c.cwd, loaded.config);
    available = readLocalUpdateAvailable(c.cwd);
    lastInstall = readLocalLastInstall(c.cwd);
  }
  freshness ??= await collectFreshness(c.cwd);

  const envelope = buildHousekeeperStatus({ mode, pid, uptimeSeconds, jobs, freshness, lastCheck, available, lastInstall });
  if (json) {
    return { exitCode: EXIT_CODES.OK, message: JSON.stringify(envelope, null, 2), rawOutput: true };
  }
  const lines = [
    `Housekeeper: ${mode === 'daemon' ? `running (PID ${pid})` : 'stopped'}`,
    `Jobs: ${envelope.totals.jobs} (ok ${envelope.totals.ok}, failed ${envelope.totals.failed}, ` +
      `skipped ${envelope.totals.skipped}, deferred ${envelope.totals.deferred}, never ${envelope.totals.never})`,
  ];
  for (const job of envelope.jobs) {
    lines.push(`  ${job.id} [${job.kind ?? '?'}]: ${job.lastState}${job.lastRun ? ` last ${job.lastRun}` : ''}${job.nextFire ? ` next ${job.nextFire}` : ''}`);
  }
  lines.push(`Freshness: ${envelope.freshness.length} indice(s)`);
  for (const entry of envelope.freshness) {
    lines.push(`  ${entry.index}: ${entry.state}`);
  }
  if (lastInstall) {
    const versions = lastInstall.oldVersion && lastInstall.newVersion
      ? ` ${lastInstall.oldVersion} → ${lastInstall.newVersion}` : '';
    lines.push(`Last install: ${lastInstall.state}${versions}${lastInstall.finishedAt ? ` at ${lastInstall.finishedAt}` : ''}`);
    if (lastInstall.summary) lines.push(`  ${lastInstall.summary}`);
  }
  return { exitCode: EXIT_CODES.OK, message: lines.join('\n') };
}

// ── run-once ──────────────────────────────────────────────────────

async function selectConfiguredJob(c: Ctx, jobs: DaemonJobConfig[]): Promise<string | { error: HandlerResult }> {
  if (jobs.length === 0) {
    return { error: usageError('aiwg housekeeper: no jobs configured.', 'Register one with `aiwg housekeeper job register`.') };
  }
  if (!c.interactive) {
    return {
      error: usageError(
        'aiwg housekeeper: --job requires a value.',
        `Pass --job <id>; known jobs: ${jobs.map((job) => job.id).join(', ')}.`,
      ),
    };
  }
  const rl = createPromptInterface();
  try {
    const picked = await listSelect(
      rl,
      '  Job: ',
      jobs.map((job) => ({ label: `${job.id} [${job.kind}]`, value: job.id })),
      jobs[0]!.id,
      c.ctx.signal,
    );
    return picked;
  } finally {
    rl.close();
  }
}

async function executeRunOnce(c: Ctx): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(c.args, 'run-once');
  if (unknown) return unknown;
  let jobId: string | undefined;
  try {
    jobId = flagValue(c.args, '--job');
  } catch (error) {
    if (error instanceof MissingFlagValueError) {
      return usageError(`aiwg housekeeper: ${error.message}.`, 'Pass --job <id>.');
    }
    throw error;
  }
  const json = hasSwitch(c.args, '--json');
  const dryRun = hasSwitch(c.args, '--dry-run');
  let fireTime: string | undefined;
  try {
    fireTime = flagValue(c.args, '--fire-time');
  } catch (error) {
    if (error instanceof MissingFlagValueError) {
      return usageError(`aiwg housekeeper: ${error.message}.`, 'Pass --fire-time <iso-timestamp>.');
    }
    throw error;
  }
  try {
    await runOnceSupportedOrThrow(process.platform);
  } catch (error) {
    return handlerResultFromError(error);
  }
  const loaded = loadDaemonConfig(c.cwd);
  const jobs = getScheduleJobs(loaded.config);
  if (jobId === undefined) {
    const picked = await selectConfiguredJob(c, jobs);
    if (typeof picked !== 'string') return picked.error;
    jobId = picked;
  }
  const job = jobs.find((entry) => entry.id === jobId);
  if (!job) {
    return usageError(
      `aiwg housekeeper: unknown job '${jobId}'.`,
      jobs.length ? `Known jobs: ${jobs.map((entry) => entry.id).join(', ')}.` : 'Register one with `aiwg housekeeper job register`.',
    );
  }
  if (dryRun) {
    return {
      exitCode: EXIT_CODES.OK,
      message: `Would run job '${job.id}' (kind ${job.kind}, schedule ${job.cron ?? job.schedule ?? 'manual'}). No daemon, no writes.`,
    };
  }
  // Reuse the B2 manual path: no watcher, no scheduler, no IPC server.
  const runner = createScriptRunner(c.frameworkRoot);
  const scriptArgs = ['schedule', '--run-once', '--job', job.id];
  if (json) scriptArgs.push('--json');
  if (fireTime !== undefined) scriptArgs.push('--fire-time', fireTime);
  return runner.run('tools/daemon/index.mjs', scriptArgs);
}

// ── job ───────────────────────────────────────────────────────────

function formatJobsHuman(jobs: DaemonJobConfig[]): string {
  if (jobs.length === 0) return 'No housekeeper jobs configured';
  const lines = [`Jobs: ${jobs.length}`];
  for (const job of jobs) {
    lines.push(`  ${job.id} [${job.kind}] ${job.cron ?? job.schedule ?? 'manual'}${job.timezone ? ` (${job.timezone})` : ''}`);
  }
  return lines.join('\n');
}

async function executeJobRegister(c: Ctx, rest: string[]): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(rest, 'job register');
  if (unknown) return unknown;
  let id: string | undefined;
  let kind: string | undefined;
  let schedule: string | undefined;
  let timezone: string | undefined;
  let timeoutMsRaw: string | undefined;
  let retriesRaw: string | undefined;
  try {
    id = flagValue(rest, '--id');
    kind = flagValue(rest, '--kind');
    schedule = flagValue(rest, '--schedule', '--cron');
    timezone = flagValue(rest, '--timezone');
    timeoutMsRaw = flagValue(rest, '--timeout-ms');
    retriesRaw = flagValue(rest, '--retries');
  } catch (error) {
    if (error instanceof MissingFlagValueError) {
      return usageError(`aiwg housekeeper: ${error.message}.`, 'Run `aiwg housekeeper --help` for usage.');
    }
    throw error;
  }
  const resolvedId = await requireValueOrPrompt(c, '--id', id, '  Job id: ');
  if (typeof resolvedId !== 'string') return resolvedId.error;
  const resolvedKind = await requireValueOrPrompt(c, '--kind', kind, `  Kind (${MAINTENANCE_KINDS.join('|')}): `);
  if (typeof resolvedKind !== 'string') return resolvedKind.error;
  const resolvedSchedule = resolvedKind === 'memory.apply' && schedule === undefined ? ''
    : await requireValueOrPrompt(c, '--schedule', schedule, '  Cron schedule (five fields, e.g. "0 * * * *"): ');
  if (typeof resolvedSchedule !== 'string') return resolvedSchedule.error;

  if (!MAINTENANCE_KINDS.includes(resolvedKind)) {
    return usageError(
      `aiwg housekeeper: unknown kind '${resolvedKind}'.`,
      `Known kinds: ${MAINTENANCE_KINDS.join(', ')}.`,
    );
  }
  let cron: string | undefined;
  try {
    cron = resolvedSchedule ? parseCronExpression(resolvedSchedule)! : undefined;
  } catch (error) {
    return usageError(`aiwg housekeeper: ${(error as Error).message}.`, 'Example: --schedule "0 * * * *".');
  }
  let timeoutMs: number | undefined;
  let retries: number | undefined;
  try {
    timeoutMs = timeoutMsRaw === undefined ? undefined : parsePositiveInt(timeoutMsRaw, '--timeout-ms');
    if (retriesRaw !== undefined) {
      const n = Number.parseInt(retriesRaw, 10);
      if (![0, 1, 2].includes(n) || String(n) !== retriesRaw.trim()) {
        throw new Error(`--retries must be 0, 1, or 2 (got '${retriesRaw}')`);
      }
      retries = n;
    }
  } catch (error) {
    return usageError(`aiwg housekeeper: ${(error as Error).message}.`, 'Run `aiwg housekeeper --help` for usage.');
  }

  const loaded = loadDaemonConfig(c.cwd);
  const jobs = getScheduleJobs(loaded.config);
  const entry: DaemonJobConfig = { id: resolvedId, kind: resolvedKind, cron };
  if (resolvedKind.startsWith('memory.')) {
    const args: Record<string, string> = {};
    try {
      for (const [key, flag] of [['scope', '--scope'], ['provider', '--provider'], ['evidence', '--evidence'],
        ['usage', '--usage'], ['plan', '--plan'], ['confirmedDigest', '--confirmed-digest']]) {
        const value = flagValue(rest, flag);
        if (value !== undefined) args[key] = value;
      }
      validateMemoryJobArgs(resolvedKind, args);
    } catch (error) {
      return usageError(`aiwg housekeeper: ${(error as Error).message}.`);
    }
    entry.args = args;
  }
  if (timezone !== undefined) entry.timezone = timezone;
  if (timeoutMs !== undefined) entry.timeoutMs = timeoutMs;
  if (retries !== undefined) entry.retries = retries as 0 | 1 | 2;
  const existing = jobs.findIndex((job) => job.id === resolvedId);
  // Registration has no window-edit flag: retain an existing apply restriction.
  if (resolvedKind === 'memory.apply' && existing >= 0 && jobs[existing].kind === 'memory.apply'
    && jobs[existing].args?.windows !== undefined) entry.args!.windows = jobs[existing].args.windows;
  if (existing >= 0) jobs[existing] = { ...jobs[existing], ...entry, ...(resolvedKind.startsWith('memory.') ? { schedule: undefined } : {}) };
  else jobs.push(entry);
  setScheduleJobs(loaded.config, jobs);
  saveDaemonConfig(loaded.path, loaded.config);
  return {
    exitCode: EXIT_CODES.OK,
    message: `${existing >= 0 ? 'Updated' : 'Registered'} job '${resolvedId}' (kind ${resolvedKind}, schedule ${cron ?? 'manual one-shot'}) in ${loaded.path}`
      + (resolvedKind === 'memory.apply' ? `\nExecutes only the named reviewed plan '${entry.args!.plan}' with recorded digest ${entry.args!.confirmedDigest}; scheduling grants no additional mutation authority.` : ''),
  };
}

async function executeJobDisable(c: Ctx, rest: string[]): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(rest, 'job disable');
  if (unknown) return unknown;
  let id: string | undefined;
  try {
    id = flagValue(rest, '--id');
  } catch (error) {
    if (error instanceof MissingFlagValueError) {
      return usageError(`aiwg housekeeper: ${error.message}.`, 'Pass --id <job-id>.');
    }
    throw error;
  }
  const loaded = loadDaemonConfig(c.cwd);
  const jobs = getScheduleJobs(loaded.config);
  if (id === undefined) {
    if (jobs.length === 0) {
      return usageError('aiwg housekeeper: no jobs configured.', 'Nothing to disable.');
    }
    if (!c.interactive) {
      return usageError(
        'aiwg housekeeper: --id requires a value.',
        `Pass --id <job-id>; known jobs: ${jobs.map((job) => job.id).join(', ')}.`,
      );
    }
    const rl = createPromptInterface();
    try {
      id = await listSelect(
        rl, '  Disable job: ',
        jobs.map((job) => ({ label: `${job.id} [${job.kind}]`, value: job.id })),
        jobs[0]!.id, c.ctx.signal,
      );
    } finally {
      rl.close();
    }
  }
  const remaining = jobs.filter((job) => job.id !== id);
  if (remaining.length === jobs.length) {
    return usageError(
      `aiwg housekeeper: unknown job '${id}'.`,
      `Known jobs: ${jobs.map((job) => job.id).join(', ') || '(none)'}.`,
    );
  }
  setScheduleJobs(loaded.config, remaining);
  saveDaemonConfig(loaded.path, loaded.config);
  return { exitCode: EXIT_CODES.OK, message: `Disabled job '${id}' (removed from ${loaded.path})` };
}

async function executeJob(c: Ctx, rest: string[]): Promise<HandlerResult> {
  const [verb = 'list', ...verbArgs] = rest;
  if (verb === 'list') {
    const unknown = checkUnknownFlags(verbArgs, 'job list');
    if (unknown) return unknown;
    const loaded = loadDaemonConfig(c.cwd);
    const jobs = getScheduleJobs(loaded.config);
    if (hasSwitch(verbArgs, '--json')) {
      return { exitCode: EXIT_CODES.OK, message: JSON.stringify({ jobs }, null, 2), rawOutput: true };
    }
    return { exitCode: EXIT_CODES.OK, message: formatJobsHuman(jobs) };
  }
  if (verb === 'register') return executeJobRegister(c, verbArgs);
  if (verb === 'disable') return executeJobDisable(c, verbArgs);
  return usageError(
    `aiwg housekeeper: unknown job subcommand '${verb}'.`,
    'Use `job list|register|disable`.',
  );
}

// ── watch ─────────────────────────────────────────────────────────

function formatWatchHuman(entries: Array<{ path: string; events?: string[] }>): string {
  if (entries.length === 0) return 'No watch roots configured';
  const lines = [`Watch roots: ${entries.length}`];
  for (const entry of entries) {
    lines.push(`  ${entry.path}${entry.events?.length ? ` (${entry.events.join(',')})` : ''}`);
  }
  return lines.join('\n');
}

function parseCsvFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) throw new Error('Expected a comma-separated list with at least one entry');
  return values;
}

async function executeWatchRegister(c: Ctx, rest: string[]): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(rest, 'watch register');
  if (unknown) return unknown;
  let dir: string | undefined;
  let eventsRaw: string | undefined;
  let extensionsRaw: string | undefined;
  try {
    dir = flagValue(rest, '--path');
    eventsRaw = flagValue(rest, '--events');
    extensionsRaw = flagValue(rest, '--extensions');
  } catch (error) {
    if (error instanceof MissingFlagValueError) {
      return usageError(`aiwg housekeeper: ${error.message}.`, 'Run `aiwg housekeeper --help` for usage.');
    }
    throw error;
  }
  const resolved = await requireValueOrPrompt(c, '--path', dir, '  Watch path: ');
  if (typeof resolved !== 'string') return resolved.error;
  let events: string[] | undefined;
  let extensions: string[] | undefined;
  try {
    events = parseCsvFlag(eventsRaw);
    extensions = parseCsvFlag(extensionsRaw);
  } catch (error) {
    return usageError(`aiwg housekeeper: ${(error as Error).message}.`, 'Example: --events create,modify,delete.');
  }
  const loaded = loadDaemonConfig(c.cwd);
  const entries = getWatchPaths(loaded.config);
  const entry: { path: string; events?: string[]; extensions?: string[] } = { path: resolved };
  if (events !== undefined) entry.events = events;
  if (extensions !== undefined) entry.extensions = extensions;
  const existing = entries.findIndex((candidate) => candidate.path === resolved);
  if (existing >= 0) entries[existing] = { ...entries[existing], ...entry };
  else entries.push(entry);
  setWatchPaths(loaded.config, entries);
  saveDaemonConfig(loaded.path, loaded.config);
  return {
    exitCode: EXIT_CODES.OK,
    message: `${existing >= 0 ? 'Updated' : 'Registered'} watch root '${resolved}' in ${loaded.path}. Watch events are reconciliation hints; cron remains the scheduling authority.`,
  };
}

async function executeWatchDisable(c: Ctx, rest: string[]): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(rest, 'watch disable');
  if (unknown) return unknown;
  let dir: string | undefined;
  try {
    dir = flagValue(rest, '--path');
  } catch (error) {
    if (error instanceof MissingFlagValueError) {
      return usageError(`aiwg housekeeper: ${error.message}.`, 'Pass --path <dir>.');
    }
    throw error;
  }
  const loaded = loadDaemonConfig(c.cwd);
  const entries = getWatchPaths(loaded.config);
  if (dir === undefined) {
    if (entries.length === 0) {
      return usageError('aiwg housekeeper: no watch roots configured.', 'Nothing to disable.');
    }
    if (!c.interactive) {
      return usageError(
        'aiwg housekeeper: --path requires a value.',
        `Pass --path <dir>; known roots: ${entries.map((entry) => entry.path).join(', ')}.`,
      );
    }
    const rl = createPromptInterface();
    try {
      dir = await listSelect(
        rl, '  Disable watch root: ',
        entries.map((entry) => ({ label: entry.path, value: entry.path })),
        entries[0]!.path, c.ctx.signal,
      );
    } finally {
      rl.close();
    }
  }
  const remaining = entries.filter((entry) => entry.path !== dir);
  if (remaining.length === entries.length) {
    return usageError(
      `aiwg housekeeper: unknown watch root '${dir}'.`,
      `Known roots: ${entries.map((entry) => entry.path).join(', ') || '(none)'}.`,
    );
  }
  setWatchPaths(loaded.config, remaining);
  saveDaemonConfig(loaded.path, loaded.config);
  return { exitCode: EXIT_CODES.OK, message: `Disabled watch root '${dir}' (removed from ${loaded.path})` };
}

async function executeWatch(c: Ctx, rest: string[]): Promise<HandlerResult> {
  const [verb = 'list', ...verbArgs] = rest;
  if (verb === 'list') {
    const unknown = checkUnknownFlags(verbArgs, 'watch list');
    if (unknown) return unknown;
    const loaded = loadDaemonConfig(c.cwd);
    const entries = getWatchPaths(loaded.config);
    if (hasSwitch(verbArgs, '--json')) {
      return { exitCode: EXIT_CODES.OK, message: JSON.stringify({ paths: entries }, null, 2), rawOutput: true };
    }
    return { exitCode: EXIT_CODES.OK, message: formatWatchHuman(entries) };
  }
  if (verb === 'register') return executeWatchRegister(c, verbArgs);
  if (verb === 'disable') return executeWatchDisable(c, verbArgs);
  return usageError(
    `aiwg housekeeper: unknown watch subcommand '${verb}'.`,
    'Use `watch list|register|disable`.',
  );
}

// ── install / uninstall ───────────────────────────────────────────

export interface InstallPlan {
  backend: 'systemd-user' | 'launchd';
  dir: string;
  files: Array<{ name: string; content: string }>;
  enableHint: string;
}

export function planInstall(options: {
  backend: 'systemd-user' | 'launchd';
  aiwgBin: string;
  cwd: string;
  withTimer?: boolean;
  calendar?: string;
  systemdDir?: string;
  launchdDir?: string;
}): InstallPlan {
  const ctx = { aiwgBin: options.aiwgBin, cwd: options.cwd };
  if (options.backend === 'launchd') {
    return {
      backend: 'launchd',
      dir: options.launchdDir ?? launchdAgentDir(),
      files: [{ name: `${HOUSEKEEPER_LAUNCHD_LABEL}.plist`, content: renderLaunchdPlist(ctx) }],
      enableHint: `launchctl load ~/Library/LaunchAgents/${HOUSEKEEPER_LAUNCHD_LABEL}.plist (best-effort macOS support; not CI-tested)`,
    };
  }
  const files = [{ name: HOUSEKEEPER_SERVICE_NAME, content: renderSystemdService(ctx) }];
  if (options.withTimer) {
    files.push({ name: HOUSEKEEPER_TIMER_NAME, content: renderSystemdTimer({ calendar: options.calendar }) });
  }
  const timerHint = options.withTimer
    ? `systemctl --user daemon-reload && systemctl --user enable --now ${HOUSEKEEPER_TIMER_NAME}`
    : `systemctl --user daemon-reload (add --with-timer to also install ${HOUSEKEEPER_TIMER_NAME} calling run-once)`;
  return {
    backend: 'systemd-user',
    dir: options.systemdDir ?? systemdUserDir(),
    files,
    enableHint: timerHint,
  };
}

export function unitTargetDir(
  backend: 'systemd-user' | 'launchd',
  overrides: { systemdDir?: string; launchdDir?: string } = {},
): string {
  if (backend === 'launchd') {
    return overrides.launchdDir
      ?? process.env['AIWG_HOUSEKEEPER_LAUNCHD_DIR']
      ?? launchdAgentDir();
  }
  return overrides.systemdDir
    ?? process.env['AIWG_HOUSEKEEPER_SYSTEMD_DIR']
    ?? systemdUserDir();
}

async function selectBackend(c: Ctx, platform: string): Promise<'systemd-user' | 'launchd' | { error: HandlerResult }> {
  const offered = installBackends(platform);
  if (offered.length === 0) {
    return { error: { exitCode: EXIT_CODES.GENERAL, message: runUnsupportedMessage() } };
  }
  if (!c.interactive) {
    return {
      error: usageError(
        'aiwg housekeeper: install requires an explicit backend flag.',
        `Pass ${offered.includes('systemd-user') ? '--systemd-user' : '--launchd'}.`,
      ),
    };
  }
  const rl = createPromptInterface();
  try {
    return await listSelect(
      rl,
      '  Install backend: ',
      offered.map((backend) => ({
        label: backend === 'systemd-user' ? 'systemd user units (Linux)' : 'launchd plist (macOS, best-effort)',
        value: backend,
      })),
      offered[0]!,
      c.ctx.signal,
    );
  } finally {
    rl.close();
  }
}

async function executeInstall(c: Ctx, rest: string[]): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(rest, 'install');
  if (unknown) return unknown;
  const platform = process.platform;
  if (normalizePlatform(platform) === 'windows') {
    return { exitCode: EXIT_CODES.GENERAL, message: runUnsupportedMessage() };
  }
  const wantSystemd = hasSwitch(rest, '--systemd-user');
  const wantLaunchd = hasSwitch(rest, '--launchd');
  if (wantSystemd && wantLaunchd) {
    return usageError('aiwg housekeeper: pass only one of --systemd-user or --launchd.', 'Run `aiwg housekeeper --help` for usage.');
  }
  let backend: 'systemd-user' | 'launchd';
  if (wantSystemd) backend = 'systemd-user';
  else if (wantLaunchd) backend = 'launchd';
  else {
    const picked = await selectBackend(c, platform);
    if (typeof picked !== 'string') return picked.error;
    backend = picked;
  }
  if (backend === 'systemd-user' && normalizePlatform(platform) !== 'linux') {
    return {
      exitCode: EXIT_CODES.USAGE,
      message: 'aiwg housekeeper: --systemd-user is only supported on Linux. On macOS use --launchd (best-effort).',
    };
  }
  const dryRun = hasSwitch(rest, '--dry-run');
  const withTimer = hasSwitch(rest, '--with-timer');
  let calendar: string | undefined;
  try {
    calendar = flagValue(rest, '--calendar');
  } catch (error) {
    if (error instanceof MissingFlagValueError) {
      return usageError(`aiwg housekeeper: ${error.message}.`, 'Example: --calendar hourly.');
    }
    throw error;
  }
  const aiwgBin = process.env['AIWG_HOUSEKEEPER_BIN'] ?? defaultAiwgBin(c.frameworkRoot);
  const plan = planInstall({
    backend, aiwgBin, cwd: c.cwd, withTimer, calendar,
    systemdDir: unitTargetDir('systemd-user'),
    launchdDir: unitTargetDir('launchd'),
  });
  if (dryRun) {
    const parts = [`# install --dry-run: ${plan.files.length} file(s) under ${plan.dir} (nothing written)`];
    for (const file of plan.files) {
      parts.push(`--- ${file.name} ---`, file.content.trimEnd());
    }
    parts.push(`Enable (explicit opt-in, never automatic): ${plan.enableHint}`);
    return { exitCode: EXIT_CODES.OK, message: parts.join('\n'), rawOutput: true };
  }
  fs.mkdirSync(plan.dir, { recursive: true });
  const written: string[] = [];
  for (const file of plan.files) {
    const target = path.join(plan.dir, file.name);
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, file.content);
    fs.renameSync(tmp, target);
    written.push(target);
  }
  return {
    exitCode: EXIT_CODES.OK,
    message: [
      `Wrote ${written.length} unit file(s):`,
      ...written.map((file) => `  ${file}`),
      'Autostart is NOT enabled. To enable it explicitly:',
      `  ${plan.enableHint}`,
    ].join('\n'),
  };
}

function knownUnitFiles(dir: string, names: string[]): string[] {
  return names.map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
}

async function executeUninstall(_c: Ctx, rest: string[]): Promise<HandlerResult> {
  const unknown = checkUnknownFlags(rest, 'uninstall');
  if (unknown) return unknown;
  const dryRun = hasSwitch(rest, '--dry-run');
  const candidates = [
    ...knownUnitFiles(unitTargetDir('systemd-user'), [HOUSEKEEPER_SERVICE_NAME, HOUSEKEEPER_TIMER_NAME]),
    ...knownUnitFiles(unitTargetDir('launchd'), [`${HOUSEKEEPER_LAUNCHD_LABEL}.plist`]),
  ];
  if (dryRun) {
    return {
      exitCode: EXIT_CODES.OK,
      message: candidates.length
        ? `uninstall --dry-run: would remove ${candidates.length} file(s) (nothing written):\n${candidates.map((file) => `  ${file}`).join('\n')}`
        : 'uninstall --dry-run: no housekeeper units installed (nothing to do)',
      rawOutput: true,
    };
  }
  const removed: string[] = [];
  for (const file of candidates) {
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return {
    exitCode: EXIT_CODES.OK,
    message: removed.length
      ? `Removed ${removed.length} unit file(s):\n${removed.map((file) => `  ${file}`).join('\n')}`
      : 'No housekeeper units installed (nothing to do)',
  };
}

// ── dispatch ──────────────────────────────────────────────────────

async function dispatch(c: Ctx): Promise<HandlerResult> {
  const [subcommand, ...rest] = c.args;
  switch (subcommand) {
    case 'start': return executeStart({ ...c, args: rest });
    case 'stop': return executeStop({ ...c, args: rest });
    case 'status': return executeStatus({ ...c, args: rest });
    case 'run-once': return executeRunOnce({ ...c, args: rest });
    case 'job': return executeJob(c, rest);
    case 'watch': return executeWatch(c, rest);
    case 'install': return executeInstall(c, rest);
    case 'uninstall': return executeUninstall(c, rest);
    case undefined:
      return usageError(
        'aiwg housekeeper: missing subcommand.',
        'Use one of: start|stop|status|run-once|job|watch|install|uninstall.',
      );
    default:
      return usageError(
        `aiwg housekeeper: unknown subcommand '${subcommand}'.`,
        'Use one of: start|stop|status|run-once|job|watch|install|uninstall.',
      );
  }
}

async function buildCtx(ctx: HandlerContext): Promise<Ctx> {
  const frameworkRoot = await getFrameworkRoot();
  const nonInteractive = hasSwitch(ctx.args, '--non-interactive');
  return {
    ctx,
    args: ctx.args,
    cwd: ctx.cwd || process.cwd(),
    frameworkRoot,
    nonInteractive,
    interactive: isInteractive(nonInteractive),
  };
}

export const housekeeperHandler: CommandHandler = {
  id: 'housekeeper',
  name: 'Housekeeper',
  description: 'Deterministic maintenance daemon: start/stop/status/run-once, jobs, watch roots, autostart units',
  category: 'daemon',
  aliases: [],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: housekeeperHelpText() };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      return await dispatch(await buildCtx(ctx));
    } catch (error) {
      if (error instanceof MissingFlagValueError) {
        return usageError(`aiwg housekeeper: ${error.message}.`, 'Run `aiwg housekeeper --help` for usage.');
      }
      return handlerResultFromError(error);
    }
  },
};

export const housekeeperHandlers: CommandHandler[] = [housekeeperHandler];

