import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  classifyBump,
  defaultWorkerRunDirs,
  detectActiveWork,
  inMaintenanceWindow,
  readActiveMissions,
  readActiveWorkers,
  readStoreWork,
  runUpdateInstall,
  validateUpdatePolicy,
  versionAllowed,
} from '../../../tools/daemon/update-policy.mjs';
import { TaskStore } from '../../../tools/daemon/task-store.mjs';
import { ScheduledTaskRunner } from '../../../tools/daemon/scheduled-task-runner.mjs';
import { invokeOwner } from '../../../tools/daemon/maintenance-owner.mjs';

const NOON = Date.parse('2026-03-07T12:00:00Z');

function seams(overrides = {}) {
  return {
    now: () => NOON,
    checkUpdateStatus: vi.fn(async () => ({ status: 'ok', channel: 'stable',
      current: '2026.10.1', latest: '2026.10.2', available: true, checkOnly: true })),
    detectInstallMode: vi.fn(async () => ({ mode: 'npm' })),
    dryRunInstall: vi.fn(async () => ({ status: 'dry-run', mode: 'npm', channel: 'stable' })),
    performInstall: vi.fn(async () => ({ status: 'updated', changed: true, mode: 'npm',
      channel: 'stable', version: '2026.10.2', command: 'npm install --global aiwg@latest' })),
    detectActiveWork: vi.fn(async () => ({ active: false, reasons: [] })),
    ...overrides,
  };
}

const enabledJob = () => ({ id: 'nightly-update', kind: 'update.install',
  args: { install: true, versionPolicy: 'patch' } });

describe('update-install policy validation', () => {
  it('accepts the documented policy shape', () => {
    expect(validateUpdatePolicy({ install: true, channel: 'stable', versionPolicy: 'patch',
      allowMajor: false, windows: [{ start: '02:00', end: '04:00', days: [0, 6], timezone: 'UTC' }] })).toEqual([]);
  });
  it.each([
    [{ channel: 'beta' }, /channel/],
    [{ versionPolicy: 'all' }, /versionPolicy/],
    [{ allowMajor: 'yes' }, /allowMajor/],
    [{ install: 1 }, /install/],
    [{ windows: [] }, /windows/],
    [{ windows: [{ start: '25:00', end: '03:00' }] }, /start/],
    [{ windows: [{ start: '02:00', end: '03:00', days: [7] }] }, /days/],
    [{ windows: [{ start: '02:00', end: '03:00', timezone: 'Mars/Olympus' }] }, /timezone/],
  ])('rejects %j', (args, pattern) => {
    expect(validateUpdatePolicy(args).join(';')).toMatch(pattern);
  });
});

describe('version gates', () => {
  it.each([
    ['2026.10.1', '2026.10.2', 'patch'],
    ['2026.10.1', '2026.11.0', 'minor'],
    ['2026.10.1', '2027.0.0', 'major'],
    ['2026.10.1', '2026.10.1', 'none'],
    ['nope', '2026.10.2', 'unknown'],
  ])('classifies %s → %s as %s', (current, latest, bump) => {
    expect(classifyBump(current, latest)).toBe(bump);
  });
  it('holds patch/minor ceilings and never majors without explicit allowMajor', () => {
    expect(versionAllowed('2026.10.1', '2026.10.2', { versionPolicy: 'patch' }).allowed).toBe(true);
    expect(versionAllowed('2026.10.1', '2026.11.0', { versionPolicy: 'patch' }).reason).toBe('version-policy');
    expect(versionAllowed('2026.10.1', '2026.11.0', { versionPolicy: 'minor' }).allowed).toBe(true);
    expect(versionAllowed('2026.10.1', '2027.0.0', { versionPolicy: 'any' }).reason).toBe('major-not-allowed');
    expect(versionAllowed('2026.10.1', '2027.0.0', { versionPolicy: 'any', allowMajor: true }).allowed).toBe(true);
  });
});

describe('maintenance windows', () => {
  it('allows any time when no windows are configured', () => {
    expect(inMaintenanceWindow(NOON, undefined, 'UTC')).toMatchObject({ inside: true });
  });
  it('matches named-zone ranges and wraps past midnight', () => {
    const night = [{ start: '22:00', end: '02:00', timezone: 'UTC' }];
    expect(inMaintenanceWindow(Date.parse('2026-03-07T23:00:00Z'), night, 'UTC').inside).toBe(true);
    expect(inMaintenanceWindow(Date.parse('2026-03-08T01:00:00Z'), night, 'UTC').inside).toBe(true);
    expect(inMaintenanceWindow(NOON, night, 'UTC')).toMatchObject({ inside: false, reason: 'outside-maintenance-window' });
  });
  it('filters by weekday in the window zone', () => {
    // 2026-03-07 is a Saturday.
    const weekends = [{ start: '00:00', end: '23:59', days: [0, 6], timezone: 'UTC' }];
    expect(inMaintenanceWindow(NOON, weekends, 'UTC').inside).toBe(true);
    expect(inMaintenanceWindow(Date.parse('2026-03-09T12:00:00Z'), weekends, 'UTC').inside).toBe(false);
  });
  it('shifts with the zone, not UTC', () => {
    const window = [{ start: '07:00', end: '08:00', timezone: 'America/New_York' }];
    // Noon UTC is 08:00 EDT (2026-03-07isto still EST: 07:00) — inside either way.
    expect(inMaintenanceWindow(NOON, window, 'UTC').inside).toBe(true);
    expect(inMaintenanceWindow(Date.parse('2026-03-07T15:00:00Z'), window, 'UTC').inside).toBe(false);
  });
});

describe('update.install gates', () => {
  it('refuses by default without the explicit per-job opt-in', async () => {
    const deps = seams();
    const receipt = await runUpdateInstall({ id: 'u', kind: 'update.install', args: {} }, deps);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'install-not-enabled', exitStatus: 2 });
    expect(deps.checkUpdateStatus).not.toHaveBeenCalled();
    expect(deps.performInstall).not.toHaveBeenCalled();
  });
  it('refuses outside the maintenance window', async () => {
    const deps = seams();
    const receipt = await runUpdateInstall({ id: 'u', kind: 'update.install',
      args: { install: true, windows: [{ start: '02:00', end: '03:00', timezone: 'UTC' }] } }, deps);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'outside-maintenance-window' });
    expect(deps.performInstall).not.toHaveBeenCalled();
  });
  it('refuses on failed preflight without installing', async () => {
    const deps = seams({ dryRunInstall: vi.fn(async () => { throw new Error('no manager executable'); }) });
    const receipt = await runUpdateInstall(enabledJob(), deps);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'preflight-failed' });
    expect(deps.performInstall).not.toHaveBeenCalled();
  });
  it('defers source checkouts to the manual route', async () => {
    const deps = seams({ dryRunInstall: vi.fn(async () => ({ status: 'manual', mode: 'source', message: 'use git pull' })) });
    const receipt = await runUpdateInstall(enabledJob(), deps);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'install-manual-required' });
    expect(deps.performInstall).not.toHaveBeenCalled();
  });
  it('defers when active work is detected, naming it', async () => {
    const deps = seams({ detectActiveWork: vi.fn(async () => ({ active: true, reasons: ['ralph-loop:abc'] })) });
    const receipt = await runUpdateInstall(enabledJob(), deps);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'active-work' });
    expect(receipt.summary).toMatch(/ralph-loop:abc/);
    expect(deps.performInstall).not.toHaveBeenCalled();
  });
  it('refuses a major upgrade unless explicitly allowed', async () => {
    const major = seams({ checkUpdateStatus: vi.fn(async () => ({ status: 'ok', channel: 'stable',
      current: '2026.10.1', latest: '2027.0.0', available: true, checkOnly: true })) });
    expect((await runUpdateInstall(enabledJob(), major)).reason).toBe('major-not-allowed');
    expect(major.performInstall).not.toHaveBeenCalled();
    const allowed = seams({ checkUpdateStatus: major.checkUpdateStatus,
      dryRunInstall: major.dryRunInstall });
    const receipt = await runUpdateInstall({ id: 'u', kind: 'update.install',
      args: { install: true, versionPolicy: 'any', allowMajor: true } }, allowed);
    expect(receipt).toMatchObject({ exitStatus: 0 });
    expect(allowed.performInstall).toHaveBeenCalledOnce();
  });
  it('defers channels without a read-only probe', async () => {
    const deps = seams({ checkUpdateStatus: vi.fn(async () => ({ status: 'unsupported', channel: 'edge', checkOnly: true })) });
    const receipt = await runUpdateInstall({ id: 'u', kind: 'update.install',
      args: { install: true, channel: 'edge' } }, deps);
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'unsupported-channel' });
    expect(deps.performInstall).not.toHaveBeenCalled();
  });
  it('reports an already-current install without touching the installer', async () => {
    const deps = seams({ checkUpdateStatus: vi.fn(async () => ({ status: 'ok', channel: 'stable',
      current: '2026.10.2', latest: '2026.10.2', available: false, checkOnly: true })) });
    expect(await runUpdateInstall(enabledJob(), deps)).toMatchObject({ exitStatus: 0 });
    expect(deps.performInstall).not.toHaveBeenCalled();
  });
  it('records old/new versions, rollback, and no-redeploy on success', async () => {
    const deps = seams();
    const receipt = await runUpdateInstall(enabledJob(), deps);
    expect(receipt).toMatchObject({ exitStatus: 0 });
    expect(receipt.detail.oldVersion).toBe('2026.10.1');
    expect(receipt.detail.newVersion).toBe('2026.10.2');
    expect(receipt.detail.redeploy).toBe('not-performed');
    expect(receipt.detail.rollback.command).toMatch(/2026\.10\.1/);
    expect(deps.dryRunInstall).toHaveBeenCalledWith({ channel: 'stable' });
  });
  it('routes an uncertain installer outcome to recovery, never a retry', async () => {
    const deps = seams({ performInstall: vi.fn(async () => { throw new Error('killed mid-write'); }) });
    const receipt = await runUpdateInstall(enabledJob(), deps);
    expect(receipt).toMatchObject({ exitStatus: null, uncertain: true });
  });
});

describe('active-work detection', () => {
  let root;
  const quiet = { readLoops: async () => [], readWorkers: async () => [], readMissions: async () => [] };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-active-work-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('treats a missing task store (ENOENT) as no daemon work', async () => {
    expect(readStoreWork(root)).toMatchObject({ busySchedules: [], busyTasks: [], unavailable: null });
    await expect(detectActiveWork({ cwd: root, ...quiet })).resolves.toEqual({ active: false, reasons: [] });
  });
  it('fails closed on a corrupt task store', async () => {
    fs.mkdirSync(path.join(root, '.aiwg', 'daemon'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aiwg', 'daemon', 'tasks.json'), '{not json');
    const store = readStoreWork(root);
    expect(store.unavailable).toMatch(/^work-detection-unavailable:/);
    const work = await detectActiveWork({ cwd: root, ...quiet });
    expect(work.active).toBe(true);
    expect(work.reasons.join(',')).toMatch(/work-detection-unavailable:/);
  });
  it('names non-terminal missions and ignores terminal ones', async () => {
    const dir = path.join(root, '.aiwg', 'ralph-external', 'mc', 'sessions', 's1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ missions: [
      { id: 'm-run', status: 'running' },
      { id: 'm-paused', status: 'paused' },
      { id: 'm-queued', status: 'queued' },
      { id: 'm-done', status: 'done' },
      { id: 'm-failed', status: 'failed' },
      { id: 'm-aborted', status: 'aborted' },
    ] }));
    expect(readActiveMissions(root)).toEqual(['mission:m-run', 'mission:m-paused', 'mission:m-queued']);
    const work = await detectActiveWork({ cwd: root, readLoops: async () => [],
      readWorkers: async () => [], readMissions: readActiveMissions });
    expect(work).toEqual({ active: true,
      reasons: ['mission:m-run', 'mission:m-paused', 'mission:m-queued'] });
  });
  it('treats a missing sessions root as no missions, a corrupt session as unavailable', async () => {
    expect(readActiveMissions(root)).toEqual([]);
    const dir = path.join(root, '.aiwg', 'ralph-external', 'mc', 'sessions', 's1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), '{not json');
    expect(() => readActiveMissions(root)).toThrow(/work-detection-unavailable:/);
    const work = await detectActiveWork({ cwd: root, ...quiet, readMissions: readActiveMissions });
    expect(work.active).toBe(true);
    expect(work.reasons.join(',')).toMatch(/work-detection-unavailable:/);
  });
  it('discovers session run dirs and registry run dirs, never sampling in this test', () => {
    expect(defaultWorkerRunDirs(root)).toEqual([]);
    const runDir = path.join(root, '.aiwg', 'ralph-external', 'mc', 'sessions', 's1', 'm1.run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.aiwg', 'ralph-external', 'mc', 'sessions', 's2'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aiwg', 'ralph-external', 'launcher-registry.json'),
      JSON.stringify({ loops: { l1: { managedWorker: { runDir } } } }));
    expect(defaultWorkerRunDirs(root)).toEqual([runDir]);
  });
  it('treats any non-terminal sampled worker as active, failing closed on bad samples', async () => {
    const live = async () => ({ complete: true, findings: [], workers: [
      { invocationId: 'inv-1', terminal: false, health: { state: 'quiet' } },
      { invocationId: 'inv-2', terminal: true, health: { state: 'completed' } },
    ] });
    await expect(readActiveWorkers(root, { runDirs: ['/x.run'], sample: live }))
      .resolves.toEqual(['direct-worker:inv-1']);
    const incomplete = async () => ({ complete: false, findings: ['SAMPLE_BUDGET'], workers: [] });
    await expect(readActiveWorkers(root, { runDirs: ['/x.run'], sample: incomplete }))
      .rejects.toThrow(/work-detection-unavailable:SAMPLE_BUDGET/);
    const failing = async () => { throw new Error('NOPE'); };
    await expect(readActiveWorkers(root, { runDirs: ['/x.run'], sample: failing }))
      .rejects.toThrow(/work-detection-unavailable:NOPE/);
    await expect(readActiveWorkers(root, { runDirs: [], sample: live })).resolves.toEqual([]);
  });
  it('folds worker and mission signals into detectActiveWork, failing closed on reader errors', async () => {
    const work = await detectActiveWork({ cwd: root, readLoops: async () => [],
      readWorkers: async () => ['direct-worker:inv-1'], readMissions: async () => ['mission:m-run'] });
    expect(work).toEqual({ active: true, reasons: ['direct-worker:inv-1', 'mission:m-run'] });
    const failed = await detectActiveWork({ cwd: root, readLoops: async () => [],
      readWorkers: async () => { throw new Error('boom'); }, readMissions: async () => [] });
    expect(failed.active).toBe(true);
    expect(failed.reasons.join(',')).toMatch(/work-detection-unavailable:boom/);
  });
});

describe('update.install owner routing', () => {
  it('refuses without the opt-in before loading any owner', async () => {
    await expect(invokeOwner({ kind: 'update.install', args: {} }))
      .resolves.toMatchObject({ state: 'deferred', reason: 'install-not-enabled' });
  });
});

describe('update.install runner receipts', () => {
  let root, store, now;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-install-runner-'));
    now = NOON;
    store = new TaskStore(path.join(root, 'tasks.json'), { now: () => now });
    await store.initialize();
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('persists gate refusals as terminal deferred receipts', async () => {
    const executeOwner = vi.fn(async () => ({ exitStatus: 2, state: 'deferred',
      reason: 'install-not-enabled', summary: 'Refusing' }));
    const runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, executeOwner });
    const receipt = await runner.runOnce({ id: 'u', kind: 'update.install', cron: '0 3 * * *' });
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'install-not-enabled', terminal: true });
    expect(store.getSchedule('u').state).toBe('idle');
    runner.stop();
  });
  it('routes uncertain install outcomes to recovery-required without retry', async () => {
    const executeOwner = vi.fn(async () => ({ exitStatus: null, uncertain: true, summary: 'killed mid-write' }));
    const runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, executeOwner });
    const receipt = await runner.runOnce({ id: 'u', kind: 'update.install', cron: '0 3 * * *' });
    expect(receipt).toMatchObject({ state: 'deferred', reason: 'recovery-required', terminal: false });
    expect(store.getSchedule('u').state).toBe('blocked');
    now += 86_400_000;
    await runner.runOnce({ id: 'u', kind: 'update.install', cron: '0 3 * * *' });
    expect(executeOwner).toHaveBeenCalledOnce();
    runner.stop();
  });
  it('keeps check-only install authority out of update.check', async () => {
    const executeOwner = vi.fn(async () => ({ exitStatus: 0, summary: 'ok' }));
    const runner = new ScheduledTaskRunner({ taskStore: store, now: () => now, executeOwner });
    const receipt = await runner.runOnce({ id: 'c', kind: 'update.check', args: { install: true } });
    expect(receipt.exitStatus).toBe(2);
    expect(executeOwner).not.toHaveBeenCalled();
    runner.stop();
  });
});
