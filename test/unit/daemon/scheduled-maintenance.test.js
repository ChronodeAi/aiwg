import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { TaskStore } from '../../../tools/daemon/task-store.mjs';
import { CronScheduler, nextCronRun } from '../../../tools/daemon/cron-scheduler.mjs';
import { ScheduledTaskRunner, retryDelay, runManualSchedule } from '../../../tools/daemon/scheduled-task-runner.mjs';
import { EventRouter } from '../../../tools/daemon/event-router.mjs';
import { invokeOwner } from '../../../tools/daemon/maintenance-owner.mjs';
import { LineMaintenanceOwner } from '../../../src/memory/line-maintenance.js';
import { sha256 } from '../../../src/memory/context-pack.js';
import * as maintenance from '../../../src/memory/maintenance.js';
import { auditMemory } from '../../../src/memory/audit.js';
import { recommendMemory } from '../../../src/memory/recommend.js';

let root, store, now, executeOwner, runner;
const job = { id: 'index', kind: 'index.verify', cron: '30 2 * * *', timezone: 'America/New_York', missedRunPolicy: 'run-once' };
const iso = value => new Date(value).toISOString();
const next = (cron, after) => nextCronRun(cron, after, 'America/New_York').toISOString();

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-maintenance-'));
  now = Date.parse('2026-03-07T12:00:00Z');
  store = new TaskStore(path.join(root, 'tasks.json'), { now: () => now });
  await store.initialize();
  executeOwner = vi.fn(async () => ({ exitStatus: 0, summary: 'Verified index', detail: { checked: 4 } }));
  runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, rng: () => 0.5, executeOwner });
});
afterEach(() => { runner.stop(); fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('migrates v1 agent tasks and defaults old schedule fields without losing them', async () => {
  fs.writeFileSync(store.storePath, JSON.stringify({ version: 1, tasks: [{ id: 'task-0020', prompt: 'existing' }],
    schedules: [{ job: { id: 'old', kind: 'cache.retention' } }] }));
  await store.initialize();
  expect(store.getTask('task-0020').prompt).toBe('existing');
  expect(store.getSchedule('old')).toMatchObject({ timezone: 'UTC', nextRun: null, lastRun: null,
    missedRunPolicy: 'skip', attemptCount: 0, lastReceipt: null, state: 'idle' });
  store.ensureSchedule(job);
  const reloaded = new TaskStore(store.storePath);
  await reloaded.initialize();
  expect(reloaded.getTask('task-0020').prompt).toBe('existing');
  expect(reloaded.taskIdCounter).toBe(21);
  expect(JSON.parse(fs.readFileSync(store.storePath)).version).toBe(2);
});

it.each(['skip', 'run-once'])('coalesces years of missed slots with %s, preserving intent through reload', async policy => {
  const config = { ...job, cron: '* * * * *', missedRunPolicy: policy };
  store.ensureSchedule(config, iso('2020-01-01T00:00:00Z'));
  const scheduler = new CronScheduler({ enabled: true, jobs: [config] }, { taskStore: store, now: () => now });
  const events = [];
  scheduler.on('event', event => events.push(event));
  scheduler.tick(config);
  scheduler.tick(config);
  // Pending deliveries can repeat until acknowledged; there is only one fire identity.
  expect(new Set(events.map(event => event.payload.fireTime)).size).toBe(policy === 'skip' ? 0 : 1);
  if (policy === 'run-once') {
    const recovered = new TaskStore(store.storePath, { now: () => now });
    await recovered.initialize();
    const recoveredRunner = new ScheduledTaskRunner({ taskStore: recovered, executeOwner, now: () => now });
    const receipt = await recoveredRunner.runOnce(config);
    expect(receipt.state).toBe('ok');
    await recoveredRunner.runOnce(config, { fireTime: receipt.fireTime });
    expect(executeOwner).toHaveBeenCalledOnce();
  } else expect(store.getSchedule(config.id).lastReceipt.reason).toBe('missed-run');
  const disk = JSON.parse(fs.readFileSync(store.storePath));
  expect(Date.parse(disk.schedules[0].nextRun)).toBeGreaterThan(now);
});

it('shifts the spring-forward gap by one hour without skipping the daily run', () => {
  expect(next('30 2 * * *', '2026-03-07T07:30:00Z')).toBe(iso('2026-03-08T07:30:00Z'));
  expect(next('30 2 * * *', '2026-03-08T07:30:00Z')).toBe(iso('2026-03-09T06:30:00Z'));
});

it('uses the first fall-back occurrence only, including a restart inside the fold', () => {
  expect(next('30 1 * * *', '2026-10-31T05:30:00Z')).toBe(iso('2026-11-01T05:30:00Z'));
  expect(next('30 1 * * *', '2026-11-01T05:30:00Z')).toBe(iso('2026-11-02T06:30:00Z'));
  expect(next('30 1 * * *', '2026-11-01T06:00:00Z')).toBe(iso('2026-11-02T06:30:00Z'));
});

it('persists bounded deterministic backoff and retries once after downtime', async () => {
  const config = { ...job, backoff: { baseMs: 1000, maxMs: 1500 }, retries: 2 };
  executeOwner.mockResolvedValue({ exitStatus: 1, summary: 'Owner failed' });
  const first = await runner.runOnce(config);
  expect(first).toMatchObject({ state: 'failed', exitStatus: 1, attemptCount: 1, terminal: false });
  expect(Date.parse(store.getSchedule(job.id).retryAt) - now).toBe(750);
  expect((await runner.runOnce(config)).reason).toBe('backoff');
  now += 86_400_000;
  const scheduler = new CronScheduler({ jobs: [config] }, { taskStore: store, now: () => now });
  const events = [];
  scheduler.on('event', event => events.push(event));
  scheduler.tick(config);
  await runner.runOnce(config, { fireTime: events[0].payload.fireTime });
  expect(executeOwner).toHaveBeenCalledTimes(2);
  expect(Date.parse(store.getSchedule(job.id).retryAt) - now).toBe(1125);
  now += 1125;
  const last = await runner.runOnce(config);
  expect(last).toMatchObject({ state: 'failed', attemptCount: 3, terminal: true });
  expect(store.getSchedule(job.id).state).toBe('idle');
  expect(store.getSchedule(job.id).receipts).toHaveLength(3);
  expect(retryDelay(30, config.backoff, () => 0)).toBe(750);
  expect(retryDelay(30, config.backoff, () => 1)).toBe(1500);
});

it('records success timestamps and owner details and rejects duplicate delivery across store instances', async () => {
  const receipt = await runner.runOnce(job);
  expect(receipt).toMatchObject({ state: 'ok', exitStatus: 0, summary: 'Verified index', detail: { checked: 4 },
    startedAt: iso(now), finishedAt: iso(now), durationMs: 0, attemptCount: 1 });
  const otherStore = new TaskStore(store.storePath);
  await otherStore.initialize();
  const otherRunner = new ScheduledTaskRunner({ taskStore: otherStore, now: () => now, executeOwner });
  expect((await otherRunner.runOnce(job, { fireTime: receipt.fireTime })).reason).toBe('already-settled');
  expect(executeOwner).toHaveBeenCalledOnce();
  expect(otherStore.getSchedule(job.id).receipts).toHaveLength(1);
});

it('serializes overlapping daemon/manual execution before invoking an owner', async () => {
  let finish;
  executeOwner.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const running = runner.runOnce(job);
  const overlap = await runner.runOnce(job);
  expect(overlap.reason).toBe('lock-held');
  expect(executeOwner).toHaveBeenCalledOnce();
  finish({ exitStatus: 0, summary: 'Done' });
  await running;
});

it('quarantines an interrupted in-flight run, retains its identity, and requires explicit owner inspection', async () => {
  store.ensureSchedule(job);
  store.changeSchedule(job.id, record => ({ ...record, state: 'running', ownerPid: 2147483647,
    pendingFireTime: iso(now), lastRun: iso(now), attemptCount: 1 }));
  const reloaded = new TaskStore(store.storePath);
  await reloaded.initialize();
  const restarted = new ScheduledTaskRunner({ taskStore: reloaded, now: () => now, executeOwner });
  expect((await restarted.runOnce(job)).reason).toBe('recovery-required');
  expect(executeOwner).not.toHaveBeenCalled();
  expect(reloaded.getSchedule(job.id)).toMatchObject({ state: 'blocked', pendingFireTime: iso(now) });
  expect(() => reloaded.resolveSchedule(job.id, '')).toThrow('inspection summary');
  reloaded.resolveSchedule(job.id, 'Owner completed; verified manifest on disk');
  expect((await restarted.runOnce(job, { fireTime: iso(now) })).reason).toBe('already-settled');
  expect(executeOwner).not.toHaveBeenCalled();
});

it('preserves a stale store lock and diagnoses recovery rather than stealing it', async () => {
  fs.writeFileSync(`${store.storePath}.lock`, JSON.stringify({ pid: 2147483647 }));
  await expect(runner.runOnce(job)).rejects.toThrow('lock-held/recovery-required');
  expect(executeOwner).not.toHaveBeenCalled();
  expect(fs.existsSync(`${store.storePath}.lock`)).toBe(true);
});

it('fails closed on corrupt state and blocks execution after an atomic write failure', async () => {
  fs.writeFileSync(store.storePath, '{corrupt');
  await expect(store.initialize()).rejects.toThrow('recovery required');
  expect(fs.readFileSync(store.storePath, 'utf8')).toBe('{corrupt');
  await expect(runner.runOnce(job)).rejects.toThrow('recovery required');
  expect(executeOwner).not.toHaveBeenCalled();
});

it('retains a timeout/unknown owner outcome without automatically retrying it', async () => {
  executeOwner.mockResolvedValue({ exitStatus: null, uncertain: true, summary: 'Owner timeout' });
  const receipt = await runner.runOnce(job);
  expect(receipt).toMatchObject({ state: 'deferred', reason: 'recovery-required', terminal: false });
  now += 86_400_000;
  await runner.runOnce(job);
  expect(executeOwner).toHaveBeenCalledOnce();
  expect(store.getSchedule(job.id).state).toBe('blocked');
});

it('records unknown task types and prevents model/install authority from reaching an owner', async () => {
  expect((await runner.runOnce({ ...job, id: 'unknown', kind: 'bad' })).exitStatus).toBe(2);
  expect((await runner.runOnce({ ...job, id: 'install', kind: 'update.check', args: { install: true } })).exitStatus).toBe(2);
  expect(executeOwner).not.toHaveBeenCalled();
});

it('routes typed router failures into the persisted recovery record instead of transient DLQ retries', () => {
  const router = new EventRouter();
  const attached = new ScheduledTaskRunner({ eventRouter: router, taskStore: store, now: () => now, executeOwner });
  attached.start();
  router.handleFailedEvent({ source: 'schedule', type: 'cron.fired', payload: { ...job, job_id: job.id } }, new Error('Delivery failed'));
  expect(store.getSchedule(job.id).lastReceipt.reason).toBe('recovery-required');
  expect(router.deadLetterQueue).toEqual([]);
  expect(executeOwner).not.toHaveBeenCalled();
  attached.stop();
});

it('forwards watcher recovery without inventing a scheduled job or retry authority', async () => {
  const router = new EventRouter();
  const attached = new ScheduledTaskRunner({ eventRouter: router, taskStore: store, now: () => now, executeOwner });
  const recovery = vi.fn();
  attached.on('recovery-required', recovery);
  attached.start();
  const event = { source: 'watch', type: 'file.modify', payload: { path: '/synthetic/source.md' } };
  const error = new Error('Interrupted watcher delivery');
  router.on('event', async () => { throw error; });
  try {
    await expect(router.deliver(event)).rejects.toThrow(error);
    expect(recovery).toHaveBeenCalledWith({ event, error });
    expect(store.getSchedules()).toEqual([]);
    expect(executeOwner).not.toHaveBeenCalled();
    expect(router.getDeadLetterQueue()).toEqual([]);
  } finally { attached.stop(); }
});

it('runs manually with schedule disabled and prints a single receipt, with injected cheap owner execution', async () => {
  const config = path.join(root, 'daemon.json');
  fs.writeFileSync(config, JSON.stringify({ daemon: {}, resources: { maxTimeoutMs: 5000 }, schedule: { enabled: false, jobs: [job] } }));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exit = await runManualSchedule({ config, 'store-path': store.storePath, job: job.id, json: true }, { now: () => now, executeOwner });
  expect(exit).toBe(0);
  expect(JSON.parse(output.mock.calls[0][0]).state).toBe('ok');
  expect(executeOwner).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }), expect.any(Object));
  expect(fs.existsSync(path.join(root, 'daemon.pid'))).toBe(false);
});

it('executes the actual manual CLI and cache owner without a daemon, network, or scratch residue', () => {
  const config = path.join(root, 'daemon.json');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch);
  const cacheRoot = path.join(root, 'cache');
  fs.writeFileSync(config, JSON.stringify({ daemon: {}, schedule: { enabled: false, jobs: [
    { id: 'cache', kind: 'cache.retention', args: { cacheRoot, dryRun: true } },
  ] } }));
  const cli = path.resolve('tools/daemon/index.mjs');
  const stdout = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'schedule', '--run-once', '--job', 'cache', '--config', config,
    '--store-path', store.storePath, '--json'], { cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: root, AIWG_CONFIG: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      AIWG_RESOURCE_CACHE_ROOT: cacheRoot, TMPDIR: scratch, NO_UPDATE_NOTIFIER: '1' } });
  expect(JSON.parse(stdout)).toMatchObject({ jobId: 'cache', state: 'ok', exitStatus: 0 });
  expect(fs.readdirSync(scratch)).toEqual([]);
  expect(fs.existsSync(path.join(root, '.aiwg/daemon.pid'))).toBe(false);
});

it('does not grant execution authority when the intent cannot be atomically persisted', async () => {
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk-full'); });
  await expect(runner.runOnce(job)).rejects.toThrow('Failed to persist');
  expect(executeOwner).not.toHaveBeenCalled();
  await expect(runner.runOnce(job)).rejects.toThrow('recovery required');
  expect(fs.readdirSync(root)).toEqual([]);
});

it('blocks a crash after the owner finishes but before its receipt is persisted', async () => {
  executeOwner.mockImplementationOnce(async () => {
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('receipt-write-failed'); });
    return { exitStatus: 0, summary: 'Owner finished' };
  });
  await expect(runner.runOnce(job)).rejects.toThrow('receipt-write-failed');
  const reloaded = new TaskStore(store.storePath, { now: () => now });
  await reloaded.initialize();
  expect(reloaded.getSchedule(job.id).state).toBe('running');
  // Simulate the recorded runner process being dead after restart.
  reloaded.changeSchedule(job.id, record => ({ ...record, ownerPid: 2147483647 }));
  const restarted = new ScheduledTaskRunner({ taskStore: reloaded, now: () => now, executeOwner });
  expect((await restarted.runOnce(job)).reason).toBe('recovery-required');
  expect(executeOwner).toHaveBeenCalledOnce();
  expect(reloaded.getSchedule(job.id).pendingFireTime).toBe(iso(now));
});

it('stops and restarts event subscriptions without duplicating agent or maintenance dispatch', async () => {
  const router = new EventRouter();
  const attached = new ScheduledTaskRunner({ eventRouter: router, taskStore: store, now: () => now, executeOwner });
  attached.start();
  attached.stop();
  attached.start();
  expect(router.listenerCount('event')).toBe(1);
  router.route({ source: 'schedule', type: 'cron.fired', payload: { ...job, job_id: job.id } });
  await vi.waitFor(() => expect(store.getSchedule(job.id).lastReceipt.state).toBe('ok'));
  expect(executeOwner).toHaveBeenCalledOnce();
  attached.stop();
});

it('retains buffered agent output while schedule transactions reload the shared store', async () => {
  const agent = store.createTask({ prompt: 'Opt-in agent' });
  store.appendOutput(agent.id, 'pending output');
  store.ensureSchedule(job);
  expect(store.getTask(agent.id).output).toBe('pending output');
  store.appendOutput(agent.id, ' continued');
  store.changeSchedule(job.id, record => ({ ...record, lastRun: iso(now) }));
  const reloaded = new TaskStore(store.storePath);
  await reloaded.initialize();
  expect(reloaded.getTask(agent.id).output).toBe('pending output continued');
});

it('resets the attempt budget for each new manual fire identity', async () => {
  expect((await runner.runOnce(job)).attemptCount).toBe(1);
  now += 60_000;
  executeOwner.mockResolvedValueOnce({ exitStatus: 1, summary: 'New run failed' });
  const receipt = await runner.runOnce(job);
  expect(receipt).toMatchObject({ attemptCount: 1, reason: 'retry-pending', terminal: false });
});

describe('scheduled memory owner contracts', () => {
  const memoryFile = '.aiwg/memory/line-memory.txt';
  const metadataFile = '.aiwg/memory/line-memory.meta.json';
  const handle = 'lm_11111111-1111-4111-a111-111111111111';
  let artifacts;
  beforeEach(() => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-memory-reports-'));
    fs.writeFileSync(path.join(root, '.aiwg-location'), artifacts);
    fs.mkdirSync(path.join(root, '.aiwg/memory'), { recursive: true });
    fs.writeFileSync(path.join(root, memoryFile), 'Keep this verified source\n');
    fs.writeFileSync(path.join(root, 'source.md'), 'Original source fact and provenance');
    fs.writeFileSync(path.join(root, metadataFile), JSON.stringify({ version: 1, entries: {
      [handle]: { id: handle, value: 'Keep this verified source', digest: sha256('Keep this verified source'), status: 'active',
        sources: [{ ref: 'source.md', reviewer: 'operator' }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        maintenance: { authority: { owner: 'line-memory', source: 'operator', protection: 'unprotected' } } },
    } }));
    runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, cwd: root,
      executeOwner: job => invokeOwner(job, { cwd: root, now: () => now }) });
  });
  afterEach(() => { fs.rmSync(artifacts, { recursive: true, force: true }); });

  function tree(dir) {
    return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(dir, file), fs.readFileSync(file).toString('base64')];
      }));
  }
  function sources() {
    return [memoryFile, metadataFile, 'source.md'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  }
  async function reviewed({ pinned = false, op = 'recategorize', retirementBasis = 'review' } = {}) {
    if (pinned) {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, metadataFile), 'utf8'));
      metadata.entries[handle].maintenance.authority.protection = 'pinned';
      fs.writeFileSync(path.join(root, metadataFile), JSON.stringify(metadata));
    }
    const owner = new LineMaintenanceOwner(root);
    const record = (await owner.records())[0];
    const plan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [{
      op, target: { id: record.id, digest: record.digest, version: record.version },
      precondition: { digest: record.digest, version: record.version },
      from: { placement: record.placement, lifecycle: record.lifecycle },
      to: { placement: record.placement, lifecycle: op === 'retire' ? 'retired' : record.lifecycle },
      scope: 'project', rationale: 'Reviewed exact transition', uncertainty: 'Static review', impactedLinks: ['source.md'],
      sessionEffect: 'next-session', category: 'reviewed',
      owner: { name: owner.name, handle, snapshot: await owner.snapshot() }, review: { reviewer: 'operator', retirementBasis },
    }] };
    fs.writeFileSync(path.join(root, 'reviewed.json'), JSON.stringify(plan));
    return { id: 'reviewed', kind: 'memory.apply', args: { plan: 'reviewed.json', confirmedDigest: maintenance.maintenancePlanDigest(plan) } };
  }

  it.each(['memory.audit', 'memory.recommend'])('%s writes only its routed versioned report and uses the read-only owners', async kind => {
    fs.writeFileSync(path.join(root, 'evidence.json'), '{}');
    fs.writeFileSync(path.join(root, 'usage.json'), '{}');
    const args = { scope: 'project', provider: 'claude', ...(kind === 'memory.recommend' ? { evidence: 'evidence.json', usage: 'usage.json' } : {}) };
    const before = tree(root);
    const result = await invokeOwner({ kind, args }, { cwd: root, now: () => now });
    expect(tree(root)).toEqual(before);
    expect(result.detail.reportPath.startsWith(artifacts + path.sep)).toBe(true);
    const report = JSON.parse(fs.readFileSync(result.detail.reportPath, 'utf8'));
    const audit = await auditMemory({ workspace: root, scope: 'project', provider: 'claude', at: new Date(now).toISOString() });
    expect(report).toEqual(kind === 'memory.audit' ? audit : recommendMemory(audit, {}, { usage: {} }));
    expect(result.detail).toMatchObject({ schemaVersion: kind === 'memory.audit' ? 'aiwg.memory-audit.v1' : 'aiwg.memory-recommendations.v1',
      counts: { items: audit.items.length, findings: audit.findings.length }, findingsStatus: expect.any(String) });
    expect(fs.readdirSync(artifacts, { recursive: true }).filter(file => file.endsWith('.json'))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, '.aiwg/memory/maintenance'))).toBe(false);
    expect(report.operations).toBeUndefined();
  });

  it.each(['memory.audit', 'memory.recommend'])('%s refuses an unavailable external destination without local fallback', async kind => {
    fs.rmSync(artifacts, { recursive: true });
    const before = tree(root);
    await expect(invokeOwner({ kind, args: { scope: 'project' } }, { cwd: root })).rejects.toThrow(/external.*unavailable/);
    expect(tree(root)).toEqual(before);
  });

  it.each(['memory.audit', 'memory.recommend'])('%s persists counts and report status in the normal schedule receipt', async kind => {
    const before = sources();
    const receipt = await runner.runOnce({ id: kind, kind, args: { scope: 'project' }, retries: 0 });
    expect(receipt.detail.counts.items).toBeGreaterThan(0);
    expect(receipt.detail.findingsStatus).toMatch(/clear|findings/);
    expect(store.getSchedule(kind).lastReceipt).toEqual(receipt);
    expect(sources()).toEqual(before);
  });

  it.each(['memory.audit', 'memory.recommend'])('%s with findings settles ok without scheduling a retry', async kind => {
    fs.mkdirSync(path.join(root, '.claude/rules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/rules/one.md'), 'Synthetic duplicate constraint');
    fs.writeFileSync(path.join(root, '.claude/rules/two.md'), 'Synthetic duplicate constraint');
    const receipt = await runner.runOnce({ id: `${kind}-findings`, kind, args: { scope: 'project', provider: 'claude' }, retries: 2 });
    expect(receipt.detail.findingsStatus).toBe('findings');
    expect(receipt).toMatchObject({ state: 'ok', exitStatus: 0, terminal: true });
    expect(receipt.reason).toBeUndefined();
    expect(store.getSchedule(`${kind}-findings`).state).toBe('idle');
  });

  it('executes all memory kinds in the compiled isolated worker with JSON receipts and no scratch residue', async () => {
    const apply = await reviewed();
    const config = path.join(root, 'daemon.json');
    const scratch = path.join(root, 'scratch'); fs.mkdirSync(scratch);
    const cli = path.resolve('tools/daemon/index.mjs');
    const jobs = [{ id: 'audit', kind: 'memory.audit', args: { scope: 'project' }, retries: 0 },
      { id: 'recommend', kind: 'memory.recommend', args: { scope: 'project' }, retries: 0 }, apply];
    fs.writeFileSync(config, JSON.stringify({ daemon: {}, schedule: { enabled: false, jobs } }));
    for (const job of jobs) {
      const before = sources();
      const result = spawnSync(process.execPath, [cli, 'schedule', '--run-once', '--job', job.id, '--config', config,
        '--store-path', store.storePath, '--json'], { cwd: root, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, AIWG_RESOLVE_IMPL_FROM: 'dist', HOME: root, AIWG_CONFIG: path.join(root, 'config'),
          XDG_DATA_HOME: path.join(root, 'data'), TMPDIR: scratch, NO_UPDATE_NOTIFIER: '1' } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(job.kind === 'memory.apply' ? 0 : JSON.parse(result.stdout).exitStatus);
      const receipt = JSON.parse(result.stdout);
      expect(receipt.jobId).toBe(job.id);
      if (job.kind === 'memory.apply') expect(receipt.detail.verification.findings).toEqual([]);
      else {
        expect(receipt.detail.reportPath.startsWith(artifacts + path.sep)).toBe(true);
        expect(sources()).toEqual(before);
      }
    }
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(fs.existsSync(path.join(root, '.aiwg/daemon.pid'))).toBe(false);
  });

  it('refuses a digest mismatch and blocks all further fires without mutating sources', async () => {
    const job = await reviewed(); job.args.confirmedDigest = sha256('different reviewed plan');
    const before = sources();
    const receipt = await runner.runOnce(job);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'recovery-required', terminal: false, attemptCount: 1 });
    expect(receipt.summary).toMatch(/digest mismatch/);
    expect(store.getSchedule(job.id)).toMatchObject({ state: 'blocked', retryAt: null });
    now += 60000;
    expect((await runner.runOnce(job)).reason).toBe('recovery-required');
    expect(sources()).toEqual(before);
    expect(fs.existsSync(path.join(root, '.aiwg/memory/maintenance'))).toBe(false);
  });

  it.each(['digest', 'version', 'snapshot', 'pin/rare-obligation', 'missing-review'])('preserves owner refusal for %s with recovery and no source mutation', async refusal => {
    const job = await reviewed(refusal === 'pin/rare-obligation' ? { pinned: true, op: 'retire', retirementBasis: 'age' } : {});
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'reviewed.json'), 'utf8'));
    if (refusal === 'digest') plan.operations[0].target.digest = plan.operations[0].precondition.digest = sha256('stale');
    if (refusal === 'version') plan.operations[0].target.version = ++plan.operations[0].precondition.version;
    if (refusal === 'snapshot') plan.operations[0].owner.snapshot = sha256('old owner snapshot');
    if (refusal === 'missing-review') delete plan.operations[0].review;
    fs.writeFileSync(path.join(root, 'reviewed.json'), JSON.stringify(plan));
    job.args.confirmedDigest = maintenance.maintenancePlanDigest(plan);
    const before = sources();
    const receipt = await runner.runOnce(job);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'recovery-required', terminal: false });
    expect(receipt.summary).toMatch(refusal === 'pin/rare-obligation' ? /Pinned rare obligations/ : /Stale|reviewer/);
    expect(store.getSchedule(job.id)).toMatchObject({ state: 'blocked', retryAt: null });
    expect(sources()).toEqual(before);
    expect(fs.existsSync(path.join(root, '.aiwg/memory/maintenance'))).toBe(false);
  });

  it('applies through the owner, verifies, retains source facts and reruns read-only across different fire times', async () => {
    const job = await reviewed();
    const receipt = await runner.runOnce(job);
    expect(receipt).toMatchObject({ state: 'ok', detail: { alreadyApplied: false, verification: { findings: [] } } });
    expect(receipt.detail.applied.ownerReceipts[0].owner).toBe('line-memory');
    expect((await new LineMaintenanceOwner(root).records())[0]).toMatchObject({ version: 2 });
    expect(fs.readFileSync(path.join(root, 'source.md'), 'utf8')).toBe('Original source fact and provenance');
    now += 60000;
    const before = tree(path.join(root, '.aiwg'));
    const again = await runner.runOnce(job);
    expect(again).toMatchObject({ state: 'ok', detail: { alreadyApplied: true, verification: { findings: [] } } });
    expect(tree(path.join(root, '.aiwg'))).toEqual(before);
  });

  it('routes verification findings to recovery without auto-retry or replay', async () => {
    const job = await reviewed();
    const verify = vi.spyOn(maintenance, 'verifyMaintenancePlan').mockResolvedValue({ findings: ['history drift'], operations: [] });
    const receipt = await runner.runOnce(job);
    expect(verify).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'recovery-required', detail: { verification: { findings: ['history drift'] } } });
    expect(store.getSchedule(job.id)).toMatchObject({ state: 'blocked', retryAt: null });
    const before = sources(); now += 60000;
    await runner.runOnce(job);
    expect(verify).toHaveBeenCalledOnce();
    expect(sources()).toEqual(before);
  });

  it('retains a partial owner receipt and blocks recovery without replay', async () => {
    const job = await reviewed();
    const apply = vi.spyOn(maintenance, 'applyMaintenancePlan').mockRejectedValue(new maintenance.MaintenanceApplyError('Interrupted', {
      schemaVersion: 'aiwg.maintenance-receipt.v1', planDigest: job.args.confirmedDigest, ownerReceipts: [],
      partial: { completed: [], pending: ['unresolved-operation'] },
    }));
    const before = sources();
    const result = await runner.runOnce(job);
    expect(result).toMatchObject({ state: 'deferred', reason: 'recovery-required',
      detail: { applied: { partial: { pending: ['unresolved-operation'] } } } });
    now += 60000; await runner.runOnce(job);
    expect(apply).toHaveBeenCalledOnce();
    expect(sources()).toEqual(before);
    expect(store.getSchedule(job.id).retryAt).toBeNull();
  });

  it('defers outside a maintenance window before any owner mutation', async () => {
    const job = await reviewed();
    job.args.windows = [{ start: '01:00', end: '02:00', timezone: 'UTC' }];
    const before = sources();
    expect(await runner.runOnce(job)).toMatchObject({ state: 'deferred', reason: 'outside-maintenance-window', terminal: true });
    expect(store.getSchedule(job.id).state).toBe('idle');
    expect(sources()).toEqual(before);
    expect(fs.existsSync(path.join(root, '.aiwg/memory/maintenance'))).toBe(false);
  });

  it.each([
    ['owner-refused', 'recovery-required', 'blocked'],
    ['gate-denied', 'gate-denied', 'idle'],
  ])('distinguishes %s from a refusal that requires recovery', async (reason, expected, state) => {
    const job = await reviewed();
    runner = new ScheduledTaskRunner({ taskStore: store, now: () => now,
      executeOwner: async () => ({ exitStatus: 2, state: 'deferred', reason }) });
    expect((await runner.runOnce(job)).reason).toBe(expected);
    expect(store.getSchedule(job.id).state).toBe(state);
  });

  it('drops a memory apply at the resource queue bound without invoking its owner', async () => {
    const job = await reviewed();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const execute = vi.fn(() => gate.then(() => ({ exitStatus: 0 })));
    runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, executeOwner: execute,
      resources: { maxConcurrentJobs: 1, maxQueueDepth: 0 } });
    const first = runner.runOnce({ id: 'busy', kind: 'memory.audit' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const before = sources();
    expect(await runner.runOnce(job)).toMatchObject({ state: 'deferred', reason: 'queue-overflow' });
    expect(execute).toHaveBeenCalledOnce();
    expect(sources()).toEqual(before);
    release(); await first;
  });

  it('requires both exact-plan registration arguments before persisting an intent', async () => {
    for (const args of [{}, { plan: 'reviewed.json' }, { confirmedDigest: sha256('reviewed') }]) {
      await expect(runner.runOnce({ id: 'invalid', kind: 'memory.apply', args })).rejects.toThrow(/requires args.plan and args.confirmedDigest/);
    }
    expect(store.getSchedule('invalid')).toBeNull();
  });

  it('never registers a cron timer for a manual one-shot apply', () => {
    const scheduler = new CronScheduler({ enabled: true, jobs: [{ id: 'one-shot', kind: 'memory.apply' }] }, { taskStore: store });
    scheduler.start();
    expect(scheduler.intervals.size).toBe(0);
    scheduler.stop();
  });
});
