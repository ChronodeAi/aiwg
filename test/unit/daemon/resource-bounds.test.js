import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyChildNiceness, normalizeResources, RESOURCE_DEFAULTS } from '../../../tools/daemon/resource-bounds.mjs';
import { Config } from '../../../tools/daemon/config.mjs';
import { FileWatcher } from '../../../tools/daemon/file-watcher.mjs';
import { TaskStore } from '../../../tools/daemon/task-store.mjs';
import { ScheduledTaskRunner } from '../../../tools/daemon/scheduled-task-runner.mjs';

describe('resource-bounds normalization', () => {
  it('fills safe defaults when nothing is configured', () => {
    expect(normalizeResources(undefined)).toEqual({ config: { ...RESOURCE_DEFAULTS }, errors: [] });
  });
  it.each([
    [{ maxConcurrentJobs: 0 }, /maxConcurrentJobs/],
    [{ maxConcurrentJobs: 9 }, /maxConcurrentJobs/],
    [{ maxQueueDepth: -1 }, /maxQueueDepth/],
    [{ maxTimeoutMs: 999 }, /maxTimeoutMs/],
    [{ jobNiceness: 20 }, /jobNiceness/],
    [{ maxWatchHandles: 0 }, /maxWatchHandles/],
    [{ bogus: 1 }, /not a known resource bound/],
    ['array', /must be an object/],
  ])('rejects %j', (raw, pattern) => {
    expect(normalizeResources(raw).errors.join(';')).toMatch(pattern);
  });
  it('accepts boundary values', () => {
    const { config, errors } = normalizeResources({ maxConcurrentJobs: 1, maxQueueDepth: 0,
      maxTimeoutMs: 1000, jobNiceness: -20, maxWatchHandles: 1 });
    expect(errors).toEqual([]);
    expect(config).toMatchObject({ maxConcurrentJobs: 1, maxQueueDepth: 0, jobNiceness: -20 });
  });
});

describe('applyChildNiceness', () => {
  it('refuses nonsense without throwing', () => {
    expect(applyChildNiceness(-1)).toMatchObject({ applied: false });
    expect(applyChildNiceness(process.pid, { niceness: 99 })).toMatchObject({ applied: false });
  });
});

describe('daemon config resources', () => {
  it('accepts a valid block and rejects an out-of-range one', () => {
    const config = new Config('.aiwg/daemon.json');
    config.config = { daemon: {}, resources: { maxConcurrentJobs: 2, maxWatchHandles: 8 } };
    expect(config.validate()).toEqual([]);
    config.config = { daemon: {}, resources: { maxWatchHandles: 0 } };
    expect(config.validate().join(';')).toMatch(/resources\.maxWatchHandles/);
  });
});

describe('runner resource bounds', () => {
  let root, store, now;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-bounds-'));
    now = Date.parse('2026-03-07T12:00:00Z');
    store = new TaskStore(path.join(root, 'tasks.json'), { now: () => now });
    await store.initialize();
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const job = id => ({ id, kind: 'cache.prune', cron: '* * * * *', args: { dryRun: true } });

  it('rejects invalid resources at construction', () => {
    expect(() => new ScheduledTaskRunner({ taskStore: store, resources: { maxConcurrentJobs: 99 } }))
      .toThrow(/Invalid runner resources/);
  });
  it('reports queue overflow explicitly instead of stacking work', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const executeOwner = vi.fn(() => gate.then(() => ({ exitStatus: 0, summary: 'done' })));
    const runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, executeOwner,
      resources: { maxConcurrentJobs: 1, maxQueueDepth: 0 } });
    const overflowed = [];
    runner.on('job:overflow', receipt => overflowed.push(receipt));
    const first = runner.runOnce(job('a'));
    const second = await runner.runOnce(job('b'));
    expect(second).toMatchObject({ state: 'deferred', reason: 'queue-overflow', terminal: true });
    expect(overflowed).toHaveLength(1);
    expect(runner.getStatus().overflowed).toBe(1);
    expect(store.getSchedule('b').lastReceipt.reason).toBe('queue-overflow');
    release();
    expect((await first).state).toBe('ok');
    expect(executeOwner).toHaveBeenCalledOnce();
    runner.stop();
  });
  it('caps concurrency so owners never overlap past the bound', async () => {
    const seen = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const executeOwner = vi.fn(async job => {
      seen.push(`start:${job.id}`);
      if (job.id === 'a') await firstGate;
      seen.push(`end:${job.id}`);
      return { exitStatus: 0, summary: 'done' };
    });
    const runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, executeOwner,
      resources: { maxConcurrentJobs: 1, maxQueueDepth: 4 } });
    const first = runner.runOnce(job('a'));
    await vi.waitFor(() => expect(seen).toEqual(['start:a']));
    const second = runner.runOnce(job('b'));
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).toEqual(['start:a']);
    releaseFirst();
    expect((await first).state).toBe('ok');
    expect((await second).state).toBe('ok');
    expect(seen).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    runner.stop();
  });
  it('clamps per-job timeouts to the global ceiling', async () => {
    const seen = [];
    const executeOwner = vi.fn(async job => {
      seen.push(job.timeoutMs);
      return { exitStatus: 0, summary: 'done' };
    });
    const runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, executeOwner,
      resources: { maxTimeoutMs: 5000 } });
    await runner.runOnce({ ...job('a'), timeoutMs: 3600000 });
    await runner.runOnce(job('b'));
    expect(seen).toEqual([5000, 5000]);
    runner.stop();
  });
});

describe('watcher handle cap', () => {
  let root, watcher;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cap-'));
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
  });
  afterEach(() => {
    watcher?.stop();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('parks roots beyond the cap on polling instead of failing', () => {
    let attached = 0;
    const watch = () => { attached++; return { close() {}, on() {} }; };
    const unavailable = [];
    watcher = new FileWatcher({ enabled: true,
      paths: [{ path: path.join(root, 'a') }, { path: path.join(root, 'b') }],
      reconcile_interval_ms: 0, poll_interval_ms: 60000 }, 10, { watch, maxHandles: 1 });
    watcher.on('watch-unavailable', event => unavailable.push(event));
    watcher.start();
    expect(attached).toBe(1);
    expect(watcher.getStats().watch_handles).toBe(1);
    expect(watcher.getStats().polling_roots).toHaveLength(1);
    expect(unavailable.map(e => e.error.code)).toEqual(['WATCH_CAP']);
  });
});
