/**
 * Unit tests for the src/housekeeper support modules (epic #3353 B5).
 *
 * Pure-function coverage for the status envelope, unit renderers,
 * platform matrix, lifecycle helpers, and daemon-config access.
 * Handler-level behavior lives in test/unit/cli/handlers/housekeeper.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  buildHousekeeperStatus,
  countJobTotals,
  normalizeJobState,
  toFreshnessEntry,
  HOUSEKEEPER_STATUS_CONTRACT_VERSION,
} from '../../../src/housekeeper/status.js';
import {
  HOUSEKEEPER_SERVICE_NAME,
  HOUSEKEEPER_TIMER_NAME,
  backendForPlatform,
  renderLaunchdPlist,
  renderSystemdService,
  renderSystemdTimer,
} from '../../../src/housekeeper/units.js';
import {
  installBackends,
  normalizePlatform,
  runSupported,
  runUnsupportedMessage,
} from '../../../src/housekeeper/platform.js';
import {
  daemonPaths,
  describeRunning,
  pollUntil,
  readPidFile,
  removeLifecycleFiles,
  stopDaemon,
} from '../../../src/housekeeper/lifecycle.js';
import {
  getDaemonProfile,
  getScheduleJobs,
  getWatchPaths,
  loadDaemonConfig,
  saveDaemonConfig,
  seedHousekeeperConfig,
  setDaemonProfile,
  setScheduleJobs,
  setWatchPaths,
} from '../../../src/housekeeper/daemon-config.js';

describe('status envelope', () => {
  it('counts totals across receipt states', () => {
    const jobs = [
      { id: 'a', kind: 'cache.prune', lastState: 'ok', lastRun: null, nextFire: null },
      { id: 'b', kind: 'cache.prune', lastState: 'failed', lastRun: null, nextFire: null },
      { id: 'c', kind: 'cache.prune', lastState: 'never', lastRun: null, nextFire: null },
    ] as const;
    expect(countJobTotals([...jobs])).toMatchObject({ jobs: 3, ok: 1, failed: 1, never: 1 });
  });

  it('builds the full contract shape with defaults', () => {
    const envelope = buildHousekeeperStatus({ mode: 'offline' });
    expect(envelope.contractVersion).toBe(HOUSEKEEPER_STATUS_CONTRACT_VERSION);
    expect(envelope.command).toBe('housekeeper.status');
    expect(envelope.status).toBe('ok');
    expect(envelope.pid).toBeNull();
    expect(envelope.totals.jobs).toBe(0);
    expect(envelope.update).toMatchObject({ channel: 'stable', checkOnly: true });
  });

  it('normalizes unknown states to never', () => {
    expect(normalizeJobState('ok')).toBe('ok');
    expect(normalizeJobState('bogus')).toBe('never');
    expect(normalizeJobState(undefined)).toBe('never');
  });

  it('maps unavailable freshness to unsupported', () => {
    expect(toFreshnessEntry({ name: 'models', status: 'unavailable' }).state).toBe('unsupported');
    expect(toFreshnessEntry({ name: 'x', status: 'stale', policy: { targetStaleAfterMs: 5 } }))
      .toMatchObject({ index: 'x', state: 'stale', targetMs: 5, converged: null });
  });
});

describe('unit renderers', () => {
  const ctx = { aiwgBin: '/repo/bin/aiwg.mjs', cwd: '/work/project' };

  it('renders a service calling run-once and a timer referencing it', () => {
    const service = renderSystemdService(ctx);
    expect(service).toContain('housekeeper run-once');
    expect(service).toContain('Type=oneshot');
    const timer = renderSystemdTimer({});
    expect(timer).toContain(`Unit=${HOUSEKEEPER_SERVICE_NAME}`);
    expect(timer).toContain('OnCalendar=hourly');
  });

  it('renders a best-effort launchd plist calling run-once', () => {
    const plist = renderLaunchdPlist(ctx);
    expect(plist).toContain('housekeeper');
    expect(plist).toContain('run-once');
    expect(plist).toContain('StartInterval');
  });

  it('selects backends per platform row', () => {
    expect(backendForPlatform('linux')).toBe('systemd-user');
    expect(backendForPlatform('darwin')).toBe('launchd');
    expect(backendForPlatform('win32')).toBe('unsupported');
  });
});

describe('platform matrix', () => {
  it('supports runs everywhere except Windows', () => {
    expect(runSupported('linux')).toBe(true);
    expect(runSupported('darwin')).toBe(true);
    expect(runSupported('win32')).toBe(false);
    expect(runUnsupportedMessage()).toContain('WSL2');
  });

  it('offers no install backend on Windows', () => {
    expect(installBackends('win32')).toEqual([]);
    expect(normalizePlatform('freebsd')).toBe('other');
  });
});

describe('lifecycle helpers', () => {
  let root: string;
  let paths: ReturnType<typeof daemonPaths>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-lifecycle-'));
    paths = daemonPaths(root, '/mock/framework/root');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads pid files strictly and reports running state', () => {
    expect(readPidFile(paths.pidFile)).toBeNull();
    expect(describeRunning(paths.pidFile)).toMatchObject({ running: false, pid: null });
    fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true });
    fs.writeFileSync(paths.pidFile, 'not-a-pid');
    expect(readPidFile(paths.pidFile)).toBeNull();
    fs.writeFileSync(paths.pidFile, String(process.pid));
    expect(describeRunning(paths.pidFile)).toMatchObject({ running: true, pid: process.pid, stale: false });
    fs.writeFileSync(paths.pidFile, '2147483647');
    expect(describeRunning(paths.pidFile)).toMatchObject({ running: false, stale: true });
  });

  it('stopDaemon handles not-running, stale, and live processes', async () => {
    expect(await stopDaemon({ paths })).toMatchObject({ outcome: 'not-running' });

    fs.mkdirSync(path.dirname(paths.lockFile), { recursive: true });
    fs.writeFileSync(paths.pidFile, '2147483647');
    fs.writeFileSync(paths.lockFile, 'stale');
    expect(await stopDaemon({ paths })).toMatchObject({ outcome: 'stale-cleaned' });
    expect(fs.existsSync(paths.pidFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);

    fs.writeFileSync(paths.pidFile, String(process.pid));
    const kill = vi.fn();
    const outcome = await stopDaemon({ paths, kill, timeoutMs: 50, pollMs: 5 });
    // Our own pid stays alive; the helper escalates and still releases files.
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(outcome.outcome).toBe('stopped');
    expect(fs.existsSync(paths.pidFile)).toBe(false);
  });

  it('removeLifecycleFiles tolerates absence', () => {
    expect(() => removeLifecycleFiles(paths)).not.toThrow();
  });

  it('pollUntil resolves on predicate success and deadline', async () => {
    let calls = 0;
    await expect(pollUntil(() => ++calls >= 3, { pollMs: 1, sleep: async () => {} })).resolves.toBe(true);
    await expect(pollUntil(() => false, { timeoutMs: 0, pollMs: 1, sleep: async () => {} })).resolves.toBe(false);
  });
});

describe('daemon-config access', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-config-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('seeds, saves, and reloads a housekeeper config round-trip', () => {
    const first = loadDaemonConfig(root);
    expect(first.existed).toBe(false);
    const seed = seedHousekeeperConfig();
    setScheduleJobs(seed, [{ id: 'a', kind: 'cache.prune', cron: '0 2 * * *' }]);
    setWatchPaths(seed, [{ path: 'src/' }]);
    saveDaemonConfig(first.path, seed);
    const second = loadDaemonConfig(root);
    expect(second.existed).toBe(true);
    expect(getDaemonProfile(second.config)).toBe('housekeeper');
    expect(getScheduleJobs(second.config)).toHaveLength(1);
    expect(getWatchPaths(second.config)).toHaveLength(1);
    setDaemonProfile(second.config, 'default');
    expect(getDaemonProfile(second.config)).toBe('default');
  });

  it('prefers yaml over json with the tools precedence', () => {
    fs.mkdirSync(path.join(root, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aiwg', 'daemon.json'), JSON.stringify({ daemon: { profile: 'default' } }));
    fs.writeFileSync(path.join(root, '.aiwg', 'daemon.yaml'), 'daemon:\n  profile: housekeeper\n');
    expect(getDaemonProfile(loadDaemonConfig(root).config)).toBe('housekeeper');
  });
});
