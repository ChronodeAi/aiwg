#!/usr/bin/env node
/**
 * Housekeeper profile benchmark (epic #3353 slice B6).
 *
 * Measures, against synthetic temp data that is always removed afterwards:
 *   1. idle CPU/RSS of the real housekeeper-profile daemon process,
 *   2. burst handling (N file changes through watch reconcile + delivery),
 *   3. reconcile time over a large root (default 50k synthetic files).
 *
 * Run: node tools/benchmarks/housekeeper.mjs [--files N] [--burst N] [--idle-seconds S]
 * Prints one JSON document plus a Markdown table. All temp data lives under a
 * single mkdtemp root that is removed in a finally block, daemon included.
 *
 * Numbers are point-in-time results for the host below, not promises.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signalChild } from '../../src/process/signal-child.mjs';
import { FileWatcher } from '../daemon/file-watcher.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonScript = path.join(here, '..', 'daemon', 'daemon-main.mjs');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const FILE_COUNT = flag('--files', 50000);
const BURST_COUNT = flag('--burst', 200);
const IDLE_SECONDS = flag('--idle-seconds', 5);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function readRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const line = status.split('\n').find(l => l.startsWith('VmRSS:'));
    return Number(line.split(/\s+/)[1]);
  } catch {
    return null;
  }
}

function readCpuJiffies(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[11]) + Number(fields[12]);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-bench-'));
  const daemon = { child: null };
  try {
    // ── Phase 1: idle daemon ──────────────────────────────────────────
    const watchDir = path.join(root, 'watched');
    fs.mkdirSync(path.join(root, '.aiwg'), { recursive: true });
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.aiwg', 'daemon.yaml'), [
      'daemon:',
      '  profile: housekeeper',
      '  heartbeat_interval_seconds: 30',
      'watch:',
      '  enabled: true',
      '  paths:',
      `    - { path: ${JSON.stringify(watchDir)}, events: [create, modify, delete] }`,
      '  debounce_ms: 50',
      '  reconcile_interval_ms: 60000',
      '  polling: false',
      '  poll_interval_ms: 5000',
      'schedule:',
      '  enabled: true',
      '  jobs: []',
      '',
    ].join('\n'));
    daemon.child = spawn(process.execPath, [daemonScript], { cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' } });
    const pidFile = path.join(root, '.aiwg', 'daemon.pid');
    await waitFor(() => fs.existsSync(pidFile), { label: 'daemon pid file' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const jiffiesPerSecond = 100; // USER_HZ on Linux
    const rssSamples = [];
    const cpuStart = readCpuJiffies(pid);
    await sleep(IDLE_SECONDS * 1000);
    const cpuEnd = readCpuJiffies(pid);
    rssSamples.push(readRssKb(pid));
    const idleCpuPercent = ((cpuEnd - cpuStart) / jiffiesPerSecond / IDLE_SECONDS) * 100;
    const idle = { pid, rssKiB: rssSamples[0],
      cpuPercent: Math.round(idleCpuPercent * 100) / 100, windowSeconds: IDLE_SECONDS };

    // ── Phase 2: burst handling ───────────────────────────────────────
    const burstDir = path.join(root, 'burst');
    fs.mkdirSync(burstDir, { recursive: true });
    let delivered = 0;
    const watcher = new FileWatcher({ enabled: true, paths: [{ path: burstDir }],
      reconcile_interval_ms: 0, poll_interval_ms: 60000 }, 10,
    { deliver: async () => { delivered++; } });
    watcher.start();
    const burstStart = performance.now();
    for (let i = 0; i < BURST_COUNT; i++) {
      fs.writeFileSync(path.join(burstDir, `change-${i}.txt`), `v1-${i}`);
    }
    watcher.reconcile();
    await waitFor(() => delivered >= BURST_COUNT, { timeoutMs: 60000, label: 'burst delivery' });
    const burstMs = performance.now() - burstStart;
    watcher.stop();

    // ── Phase 3: large-root reconcile ─────────────────────────────────
    const bigDir = path.join(root, 'bigroot');
    fs.mkdirSync(bigDir, { recursive: true });
    const createStart = performance.now();
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(path.join(bigDir, `file-${String(i).padStart(6, '0')}.txt`), 'x');
    }
    const createMs = performance.now() - createStart;
    const big = new FileWatcher({ enabled: true, paths: [{ path: bigDir }],
      reconcile_interval_ms: 0, poll_interval_ms: 60000 }, 10, { deliver: async () => {} });
    big.start();
    const reconcileStart = performance.now();
    big.reconcile();
    const reconcileMs = performance.now() - reconcileStart;
    const stats = big.getStats();
    big.stop();

    const result = {
      observedAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version,
        cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model || null,
        totalMemMiB: Math.round(os.totalmem() / 1048576) },
      idleDaemon: idle,
      burst: { changes: BURST_COUNT, delivered, wallMs: Math.round(burstMs),
        perChangeMs: Math.round((burstMs / BURST_COUNT) * 100) / 100 },
      largeRoot: { files: FILE_COUNT, createWallMs: Math.round(createMs),
        reconcileWallMs: Math.round(reconcileMs),
        watchHandles: stats.watch_handles, pollingRoots: stats.polling_roots.length },
    };
    console.log(JSON.stringify(result, null, 2));
    console.log('');
    console.log('| Measurement | Result |');
    console.log('|---|---|');
    console.log(`| Idle RSS (housekeeper daemon) | ${result.idleDaemon.rssKiB} KiB |`);
    console.log(`| Idle CPU (housekeeper daemon, ${IDLE_SECONDS}s) | ${result.idleDaemon.cpuPercent}% |`);
    console.log(`| Burst: ${BURST_COUNT} changes delivered | ${result.burst.wallMs} ms (${result.burst.perChangeMs} ms/change) |`);
    console.log(`| Reconcile: ${FILE_COUNT} files | ${result.largeRoot.reconcileWallMs} ms |`);
    return result;
  } finally {
    if (daemon.child) {
      signalChild(daemon.child, 'SIGTERM');
      await Promise.race([new Promise(resolve => daemon.child.once('exit', resolve)), sleep(10000)]);
      signalChild(daemon.child, 'SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
