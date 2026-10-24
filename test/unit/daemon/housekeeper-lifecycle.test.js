/**
 * Housekeeper lifecycle tests (epic #3353 slice B5).
 *
 * Exercises a real housekeeper-profile daemon confined to a temp dir:
 * boot, duplicate-start rejection via the pid/lock files, the minimal
 * IPC subset over the socket, graceful SIGTERM shutdown releasing
 * pid/lock, and manual maintenance (run-once) staying usable after stop.
 * Never touches the real workspace, real systemd dirs, or the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DAEMON_MAIN = path.join(REPO_ROOT, 'tools', 'daemon', 'daemon-main.mjs');

const { createClient } = await import('../../../tools/daemon/ipc-client.mjs');
const { runManualSchedule } = await import('../../../tools/daemon/scheduled-task-runner.mjs');

let root;
const children = new Set();

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Poll until predicate holds; throws with a label on deadline. */
async function poll(label, predicate, { timeoutMs = 15000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(pollMs);
  }
}

function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_MAIN], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function waitExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for daemon exit'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const pidFile = () => path.join(root, '.aiwg', 'daemon.pid');
const lockFile = () => path.join(root, '.aiwg', 'daemon', '.lock');
const socketPath = () => path.join(root, '.aiwg', 'daemon', 'daemon.sock');

function readPid() {
  try {
    return Number.parseInt(fs.readFileSync(pidFile(), 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-lifecycle-'));
  fs.mkdirSync(path.join(root, '.aiwg'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aiwg', 'daemon.json'), JSON.stringify({
    daemon: { profile: 'housekeeper', heartbeat_interval_seconds: 30 },
    watch: { enabled: false, paths: [] },
    schedule: { enabled: false, jobs: [] },
  }));
});

afterEach(async () => {
  for (const child of [...children]) {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  children.clear();
  vi.restoreAllMocks();
  await sleep(100);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('housekeeper daemon lifecycle', () => {
  it('boots, blocks a second start, answers minimal IPC, and shuts down gracefully', { timeout: 90000 }, async () => {
    const child = spawnDaemon();
    await poll('pid file from housekeeper daemon', () => {
      const pid = readPid();
      return pid !== null && pidAlive(pid);
    });
    const pid = readPid();
    expect(pid).toBe(child.pid);

    // A second start fails clearly while the lock is held.
    const second = spawnDaemon();
    expect(await waitExit(second)).toBe(1);

    // Minimal IPC subset answers over the socket.
    const client = await createClient(socketPath());
    try {
      expect(await client.request('ping')).toMatchObject({ pong: true });
      const status = await client.request('housekeeper.status');
      expect(status.profile).toBe('housekeeper');
      expect(status.pid).toBe(pid);
      expect(Array.isArray(status.jobs)).toBe(true);
      expect(status.update).toMatchObject({ checkOnly: true });
      const daemonStatus = await client.request('daemon.status');
      expect(daemonStatus.profile).toBe('housekeeper');
      expect(daemonStatus.subsystems.supervisor).toEqual({ enabled: false });
      expect(await client.request('task.stats')).toMatchObject({ total: 0 });
      await expect(client.request('chat.send', { message: 'hi' })).rejects.toThrow(/Method not found/);
    } finally {
      client.disconnect();
    }

    // Graceful shutdown releases pid and lock.
    process.kill(pid, 'SIGTERM');
    expect(await waitExit(child)).toBe(0);
    await poll('pid/lock release after shutdown', () => !fs.existsSync(pidFile()) && !fs.existsSync(lockFile()));
  });

  it('leaves manual maintenance (run-once) usable after stop', async () => {
    const storePath = path.join(root, '.aiwg', 'daemon', 'tasks.json');
    const configPath = path.join(root, '.aiwg', 'daemon.json');
    fs.writeFileSync(configPath, JSON.stringify({
      daemon: { profile: 'housekeeper' },
      watch: { enabled: false },
      schedule: { enabled: true, jobs: [{ id: 'probe', kind: 'cache.prune', cron: '0 0 * * *' }] },
    }));
    const executeOwner = vi.fn(async () => ({ exitStatus: 0, summary: 'pruned', detail: { removed: [] } }));
    const code = await runManualSchedule(
      { job: 'probe', json: true, config: configPath, 'store-path': storePath },
      { executeOwner },
    );
    expect(code).toBe(0);
    expect(executeOwner).toHaveBeenCalledOnce();
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const record = store.schedules.find((entry) => entry.job.id === 'probe');
    expect(record.lastReceipt.state).toBe('ok');
  });
});
