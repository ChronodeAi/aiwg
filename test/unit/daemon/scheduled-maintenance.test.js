import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../../../tools/daemon/task-store.mjs';
import { CronScheduler, nextCronRun } from '../../../tools/daemon/cron-scheduler.mjs';
import { ScheduledTaskRunner, retryDelay, runManualSchedule } from '../../../tools/daemon/scheduled-task-runner.mjs';
import { EventRouter } from '../../../tools/daemon/event-router.mjs';

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
afterEach(() => { runner.stop(); fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

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
  fs.writeFileSync(config, JSON.stringify({ daemon: {}, schedule: { enabled: false, jobs: [job] } }));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exit = await runManualSchedule({ config, 'store-path': store.storePath, job: job.id, json: true }, { now: () => now, executeOwner });
  expect(exit).toBe(0);
  expect(JSON.parse(output.mock.calls[0][0]).state).toBe('ok');
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
