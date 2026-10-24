/**
 * Daemon config access for `aiwg housekeeper` (epic #3353 slice B5).
 *
 * Mirrors the file precedence of `tools/daemon/config.mjs` (YAML, then YML,
 * then JSON) without importing `tools/` — `src/` must never import `tools/`
 * (tools import compiled src via `importImpl`). Only the `schedule.jobs`
 * and `watch.paths` sections plus `daemon.profile` are read or written;
 * every other key is preserved byte-for-byte through a YAML round-trip.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const HOUSEKEEPER_PROFILE = 'housekeeper';

/**
 * Deterministic maintenance kinds. Mirrors `MAINTENANCE_KINDS` in
 * `tools/daemon/scheduled-task-runner.mjs` — that module owns execution;
 * this list only validates `job register` input on the CLI side.
 */
export const MAINTENANCE_KINDS: readonly string[] = Object.freeze([
  'index.verify',
  'index.reconcile',
  'cache.retention',
  'update.check',
  'update.install',
  'index.freshness',
  'index.refresh',
  'cache.prune',
]);

export interface DaemonJobConfig {
  id: string;
  kind: string;
  cron?: string;
  schedule?: string;
  timezone?: string;
  missedRunPolicy?: string;
  // Update-install policies carry booleans, arrays and windows alongside the
  // string args of the other kinds (see tools/daemon/update-policy.mjs).
  args?: Record<string, unknown>;
  timeoutMs?: number;
  retries?: number;
}

export interface WatchPathConfig {
  path: string;
  events?: string[];
  extensions?: string[];
  ignore?: string[];
  polling?: boolean;
}

export interface DaemonConfigResult {
  /** Absolute path of the file that was (or would be) used. */
  path: string;
  /** True when the file already existed on disk. */
  existed: boolean;
  /** Parsed config document (mutable draft; call saveDaemonConfig to persist). */
  config: Record<string, unknown>;
}

/** Resolve the daemon config file with the same precedence as Config.load. */
export function resolveDaemonConfigPath(cwd: string): { path: string; existed: boolean } {
  const candidates = [
    path.join(cwd, '.aiwg', 'daemon.yaml'),
    path.join(cwd, '.aiwg', 'daemon.yml'),
    path.join(cwd, '.aiwg', 'daemon.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { path: candidate, existed: true };
  }
  return { path: candidates[0]!, existed: false };
}

function parseConfigFile(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Daemon config ${file} must contain a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }
  const parsed: unknown = YAML.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Daemon config ${file} must contain a mapping`);
  }
  return parsed as Record<string, unknown>;
}

export function loadDaemonConfig(cwd: string): DaemonConfigResult {
  const { path: file, existed } = resolveDaemonConfigPath(cwd);
  if (!existed) return { path: file, existed, config: {} };
  return { path: file, existed, config: parseConfigFile(file) };
}

export function saveDaemonConfig(file: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = file.endsWith('.json')
    ? `${JSON.stringify(config, null, 2)}\n`
    : YAML.stringify(config);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export function getDaemonProfile(config: Record<string, unknown>): string | undefined {
  const daemon = config['daemon'];
  if (!daemon || typeof daemon !== 'object' || Array.isArray(daemon)) return undefined;
  const profile = (daemon as Record<string, unknown>)['profile'];
  return typeof profile === 'string' ? profile : undefined;
}

export function setDaemonProfile(config: Record<string, unknown>, profile: string): void {
  const daemon = (config['daemon'] ??= {}) as Record<string, unknown>;
  daemon['profile'] = profile;
}

export function getScheduleJobs(config: Record<string, unknown>): DaemonJobConfig[] {
  const schedule = config['schedule'];
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return [];
  const jobs = (schedule as Record<string, unknown>)['jobs'];
  return Array.isArray(jobs) ? (jobs as DaemonJobConfig[]) : [];
}

export function setScheduleJobs(config: Record<string, unknown>, jobs: DaemonJobConfig[]): void {
  const schedule = (config['schedule'] ??= {}) as Record<string, unknown>;
  schedule['jobs'] = jobs;
}

export function scheduleEnabled(config: Record<string, unknown>): boolean {
  const schedule = config['schedule'];
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return false;
  return (schedule as Record<string, unknown>)['enabled'] !== false;
}

export function getWatchPaths(config: Record<string, unknown>): WatchPathConfig[] {
  const watch = config['watch'];
  if (!watch || typeof watch !== 'object' || Array.isArray(watch)) return [];
  const paths = (watch as Record<string, unknown>)['paths'];
  return Array.isArray(paths) ? (paths as WatchPathConfig[]) : [];
}

export function setWatchPaths(config: Record<string, unknown>, entries: WatchPathConfig[]): void {
  const watch = (config['watch'] ??= {}) as Record<string, unknown>;
  watch['paths'] = entries;
}

/** Minimal housekeeper seed written when no daemon config exists yet. */
export function seedHousekeeperConfig(): Record<string, unknown> {
  return {
    daemon: { profile: HOUSEKEEPER_PROFILE, heartbeat_interval_seconds: 30 },
    watch: { enabled: false, paths: [] },
    schedule: { enabled: true, jobs: [] },
  };
}
