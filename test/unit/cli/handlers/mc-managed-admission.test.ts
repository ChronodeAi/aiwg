import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  bindManagedAdmissionPolicy, FileAdmissionStore, managedProjectAdmissionPolicy,
  projectAdmissionAuthority, SharedHostScheduler,
} from '../../../../src/serve/shared-host-scheduler.js';
import { resolveParallelism, workerActivationDigests, workerConfigDigest, type AiwgConfig } from '../../../../src/config/aiwg-config.js';
import { createMcAdmissionScheduler, mcHandler } from '../../../../src/cli/handlers/mc.js';

const mocks = vi.hoisted(() => ({ readConfig: vi.fn(), readCandidate: vi.fn(), launch: vi.fn(), cancel: vi.fn() }));
vi.mock('../../../../src/config/aiwg-config.js', async original => ({
  ...await original<typeof import('../../../../src/config/aiwg-config.js')>(),
  readAiwgConfig: mocks.readConfig, readAiwgConfigCandidate: mocks.readCandidate,
}));
vi.mock('../../../../src/cli/handlers/ralph-launcher.js', () => ({ launchExternalRalph: mocks.launch, cancelManagedRalph: mocks.cancel }));

let root: string;
let cfg: AiwgConfig;
let files: Map<string, string>;
const sessionPath = '.aiwg/ralph-external/mc/sessions/mc-synthetic/session.json';
const submittedAt = '2026-10-22T12:00:00.000Z';

function mission() {
  return { id: 'm-synthetic', objective: 'synthetic', completion: 'synthetic complete',
    status: 'queued', mode: 'direct', priority: 'normal', maxIterations: 1, loop: 0 };
}
function session() {
  return { id: 'mc-synthetic', name: 'synthetic', state: 'active', maxMissions: 4,
    createdAt: submittedAt, updatedAt: submittedAt, missions: [mission()] };
}
function activate() {
  const parallelism = resolveParallelism(cfg.parallelism, 'codex');
  const policy = managedProjectAdmissionPolicy(root, parallelism, workerConfigDigest(parallelism.activation), parallelism.max_parallel_subagents);
  const store = new FileAdmissionStore(projectAdmissionAuthority(root).path);
  bindManagedAdmissionPolicy(store, policy);
  return { store, scheduler: new SharedHostScheduler(store, policy) };
}
function run(command = 'run') {
  const args = [command, 'mc-synthetic', '--accept-cost'];
  return mcHandler.execute({ args, rawArgs: ['mc', ...args], cwd: root, frameworkRoot: root });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(submittedAt));
  root = mkdtempSync(join(tmpdir(), 'mc-managed-'));
  cfg = {
    version: '1', providers: ['codex'], installed: {}, scripts: {},
    parallelism: { worker_dispatch: true, worker_mode: 'managed', max_parallel_subagents: 1,
      groups: { coding: { members: [{ id: 'spark', cli: 'first', model: 'model', roles: ['coding'] }] } },
      clis: { first: { adapter: 'providers:codex', accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } },
      admission: { maxQueued: 2, queueTimeoutSeconds: 1 },
    },
  } as AiwgConfig;
  cfg.parallelism!.activation = {
    revision: 1, ...workerActivationDigests(cfg), snapshotRef: 'synthetic:activation',
  };
  mocks.readConfig.mockResolvedValue(cfg);
  mocks.readCandidate.mockResolvedValue(cfg);
  mocks.launch.mockResolvedValue({ loopId: 'loop-synthetic', pid: 12345, execution: { pid: 12345, startedAt: 'synthetic-boot:123:1000' } });
  mocks.cancel.mockResolvedValue({ state: 'uncertain', signalled: true });
  files = new Map([[sessionPath, JSON.stringify(session())]]);
  const actualRead = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation(async (file: any, options: any) => {
    const data = files.get(String(file));
    if (data !== undefined) return data as any;
    if (!isAbsolute(String(file))) throw Object.assign(new Error('missing synthetic state'), { code: 'ENOENT' });
    return actualRead(file, options);
  });
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (file: any, data: any) => { files.set(String(file), String(data)); });
  vi.spyOn(fs, 'rename').mockImplementation(async (from: any, to: any) => {
    files.set(String(to), files.get(String(from))!);
    files.delete(String(from));
  });
  vi.spyOn(fs, 'appendFile').mockResolvedValue(undefined);
  vi.spyOn(fs, 'open').mockResolvedValue({ close: async () => undefined } as any);
  vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('T-OG-05/08 MC project admission binding', () => {
  it('requires the authority owner to bind activation before a managed caller can submit', async () => {
    await expect(createMcAdmissionScheduler(root, cfg)).rejects.toThrow(/binding mismatch/);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(new FileAdmissionStore(projectAdmissionAuthority(root).path).read().policyBinding).toBeUndefined();
  });

  it('shares native and managed worker capacity across MC caller instances', async () => {
    const { store } = activate();
    const first = await createMcAdmissionScheduler(root, cfg);
    const second = await createMcAdmissionScheduler(root, cfg);
    first.submit({ requestId: 'native', orchestratorId: 'native-owner', environment: 'default',
      provider: 'codex', runtimeKind: 'host', priority: 10, submittedAt, queueTimeoutMs: 60_000, managed: { kind: 'native' } });
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(second.snapshot().records['mc-synthetic.m-synthetic']!.state).toBe('queued');
    expect(Object.keys(store.read().records)).toHaveLength(2);
    expect(JSON.parse(files.get(sessionPath)!).missions[0].admissionState).toBe('queued');
  });

  it.each(['cancelled', 'expired'])('never launches a previously %s queued MC reservation', async outcome => {
    const { scheduler, store } = activate();
    scheduler.submit({ requestId: 'native', orchestratorId: 'native-owner', environment: 'default',
      provider: 'codex', runtimeKind: 'host', priority: 10, submittedAt, queueTimeoutMs: 60_000, managed: { kind: 'native' } });
    await run();
    if (outcome === 'cancelled') scheduler.cancel('mc-synthetic.m-synthetic', 1);
    else {
      vi.setSystemTime(new Date(Date.parse(submittedAt) + 1001));
      scheduler.reconcileNow();
    }
    // Demonstrate the terminal queue entry stays terminal even with free capacity.
    store.transact(snapshot => { delete snapshot.records.native; });
    expect((await run()).exitCode).toBe(0);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe(outcome === 'cancelled' ? 'cancelled' : 'timed-out');
  });

  it.each(['missing', 'stale-config', 'different-digest'])('rejects %s activation before launch', async failure => {
    activate();
    if (failure === 'missing') delete cfg.parallelism!.activation;
    if (failure === 'stale-config') cfg.parallelism!.admission!.maxQueued = 3;
    if (failure === 'different-digest') cfg.parallelism!.activation!.revision += 1;
    expect((await run()).exitCode).toBe(1);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('does not fall back to legacy dispatch when managed config validation fails', async () => {
    mocks.readConfig.mockRejectedValue(new Error('synthetic invalid managed policy'));
    expect((await run()).exitCode).toBe(1);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('reserves the native loop envelope and launches within intersected project ceilings', async () => {
    cfg.parallelism!.budgets = { perTask: { tokens: 100, costUsd: 2, wallSeconds: 30 } };
    cfg.parallelism!.retry = { maxAttempts: 2 };
    cfg.parallelism!.activation = { revision: 1, ...workerActivationDigests(cfg), snapshotRef: 'synthetic:activation' };
    const record = session(); Object.assign(record.missions[0]!, {
      maxIterations: 5, maxTotalTokens: 200, maxTotalCost: 4, maxWallClockMinutes: 1,
    });
    files.set(sessionPath, JSON.stringify(record));
    const { store } = activate();
    expect((await run()).exitCode).toBe(0);
    expect(mocks.launch).toHaveBeenCalledWith(root, root, expect.objectContaining({
      maxIterations: 2, maxTotalTokens: 100, maxTotalCost: 2, maxWallClockMinutes: 0.5,
    }));
    expect(store.read().records['mc-synthetic.m-synthetic']!.accounting).toMatchObject({
      attemptNumber: 1, attemptCount: 2, reservation: { tokens: 100, costUsd: 2 }, usage: null,
    });
  });

  it('never drops an elapsed wall deadline while persisting the admitted mission', async () => {
    cfg.parallelism!.budgets = { perTask: { wallSeconds: 1, costUsd: 1 } };
    cfg.parallelism!.activation = { revision: 1, ...workerActivationDigests(cfg), snapshotRef: 'synthetic:activation' };
    const { store } = activate();
    vi.mocked(fs.writeFile).mockImplementation(async (file: any, data: any) => {
      files.set(String(file), String(data));
      vi.setSystemTime(new Date(Date.parse(submittedAt) + 1000));
    });
    expect((await run()).exitCode).toBe(1);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('uncertain');
  });

  it('keeps a managed launch failure uncertain rather than releasing capacity', async () => {
    const { store } = activate();
    mocks.launch.mockRejectedValue(new Error('synthetic launch failure'));
    expect((await run()).exitCode).toBe(1);
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('uncertain');
    expect(JSON.parse(files.get(sessionPath)!).missions[0].admissionState).toBe('uncertain');
  });

  it.each(['completed', 'failed', 'crashed', 'aborted', 'paused'])('keeps capacity on a Ralph %s status without termination proof', async status => {
    const { store } = activate();
    expect((await run()).exitCode).toBe(0);
    files.set(join(root, '.aiwg/ralph-external/loops/loop-synthetic/session-state.json'), JSON.stringify({ status }));
    expect((await run('status')).exitCode).toBe(0);
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('uncertain');
    expect(JSON.parse(files.get(sessionPath)!).missions[0].admissionState).toBe('uncertain');
  });
});


function syntheticHealth(overrides = {}) {
  return { version: 1, state: 'active', coverage: 'full', handshake: 'semantic',
    lastObservedAt: submittedAt, lastActivityAt: submittedAt, lastProgressAt: submittedAt,
    reasonCode: 'PROGRESS', termination: 'running', transitionCount: 1, restartCount: 0,
    unavailableSignals: [], transitionRefs: [], observerGeneration: 1,
    startupDeadlineAt: null, hardDeadlineAt: null, maxCheckGapSeconds: 15,
    confidence: 'observed', handshakeAt: submittedAt, stalledAt: null, ...overrides };
}
const ralphStatePath = () => join(root, '.aiwg/ralph-external/loops/loop-synthetic/session-state.json');

async function control(command: string, ...args: string[]) {
  return mcHandler.execute({ args: [command, 'mc-synthetic', ...args], rawArgs: ['mc', command, 'mc-synthetic', ...args], cwd: root, frameworkRoot: root });
}

describe('T-OG-06/24 MC fenced checkpoint reconciliation', () => {
  it('checkpoints generation and the durable launch claim before spawning and binds its birth identity', async () => {
    const { store } = activate();
    mocks.launch.mockImplementation(async () => {
      const checkpoint = JSON.parse(files.get(sessionPath)!).missions[0];
      expect(checkpoint).toMatchObject({ admissionGeneration: 1, admissionLaunchClaimed: true });
      expect(store.read().records['mc-synthetic.m-synthetic']!.launchClaimedAt).toBe(submittedAt);
      return { loopId: 'loop-synthetic', pid: 12345, execution: { pid: 12345, startedAt: 'synthetic-boot:123:1000' } };
    });
    expect((await run()).exitCode).toBe(0);
    expect(store.read().records['mc-synthetic.m-synthetic']!.execution).toEqual({ pid: 12345, startedAt: 'synthetic-boot:123:1000' });
    expect(mocks.launch).toHaveBeenCalledWith(root, root, expect.objectContaining({ managedAdmission: { requestId: 'mc-synthetic.m-synthetic', generation: 1 } }));
  });

  it('never replays a launch claimed before a crash or its artifacts', async () => {
    const { store } = activate();
    await run();
    const checkpoint = JSON.parse(files.get(sessionPath)!);
    checkpoint.missions[0].status = 'queued';
    delete checkpoint.missions[0].ralphLoopId;
    files.set(sessionPath, JSON.stringify(checkpoint));
    files.set('synthetic-artifact', 'retained');
    mocks.launch.mockClear();
    expect((await run()).exitCode).toBe(1);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('uncertain');
    expect(files.get('synthetic-artifact')).toBe('retained');
  });

  it('retains capacity when the launcher cannot supply process birth identity', async () => {
    const { store } = activate();
    mocks.launch.mockResolvedValue({ loopId: 'loop-synthetic', pid: 12345 });
    expect((await run()).exitCode).toBe(1);
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('uncertain');
  });

  it('signals a launch cancelled before its execution identity was checkpointed', async () => {
    const { store, scheduler } = activate();
    mocks.launch.mockImplementation(async () => {
      scheduler.stop('mc-synthetic.m-synthetic', 1, 'cancel');
      return { loopId: 'loop-synthetic', pid: 12345, execution: { pid: 12345, startedAt: 'synthetic-boot:123:1000' } };
    });
    expect((await run()).exitCode).toBe(1);
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('uncertain');
    expect(mocks.cancel).toHaveBeenCalledWith(root, root, 'loop-synthetic', expect.objectContaining({ generation: 1 }));
  });

  it('renews ownership without updating semantic progress', async () => {
    const { store } = activate();
    await run();
    const prior = store.read().records['mc-synthetic.m-synthetic']!;
    files.set(ralphStatePath(), JSON.stringify({ status: 'running' }));
    vi.setSystemTime(new Date(Date.parse(submittedAt) + 1000));
    await run('status');
    const current = store.read().records['mc-synthetic.m-synthetic']!;
    expect(Date.parse(current.leaseExpiresAt!)).toBeGreaterThan(Date.parse(prior.leaseExpiresAt!));
    expect(current.lastProgressAt).toBeUndefined();
    expect(current.health).toBeUndefined();
  });

  it('projects worker health progress through the existing scheduler mapping', async () => {
    const { store } = activate();
    await run();
    files.set(ralphStatePath(), JSON.stringify({ status: 'running', health: syntheticHealth() }));
    await run('status');
    expect(store.read().records['mc-synthetic.m-synthetic']!.lastProgressAt).toBe(submittedAt);
  });

  it('marks missing supervision uncertain without releasing capacity or changing task status', async () => {
    const { store } = activate();
    await run();
    await run('status');
    expect(store.read().records['mc-synthetic.m-synthetic']!).toMatchObject({ state: 'uncertain', reservedSlots: 1 });
    expect(JSON.parse(files.get(sessionPath)!).missions[0]).toMatchObject({ status: 'running', admissionState: 'uncertain' });
  });

  it('rejects stale checkpoint ownership before accepting terminal status', async () => {
    const { store } = activate();
    await run();
    const checkpoint = JSON.parse(files.get(sessionPath)!);
    checkpoint.missions[0].admissionGeneration = 2;
    files.set(sessionPath, JSON.stringify(checkpoint));
    files.set(ralphStatePath(), JSON.stringify({ status: 'completed', health: syntheticHealth({ state: 'completed', termination: 'confirmed' }) }));
    await run('status');
    expect(JSON.parse(files.get(sessionPath)!).missions[0].status).toBe('running');
    expect(store.read().records['mc-synthetic.m-synthetic']!.finalEvidence).toBeUndefined();
  });

  it('retains late confirmed final as evidence after disconnect without settling native Ralph', async () => {
    const { store } = activate();
    await run();
    await run('status');
    files.set(ralphStatePath(), JSON.stringify({ status: 'completed', health: syntheticHealth({ state: 'completed', termination: 'confirmed' }) }));
    await run('status');
    expect(store.read().records['mc-synthetic.m-synthetic']!).toMatchObject({ state: 'uncertain', reservedSlots: 1,
      finalEvidence: { health: { state: 'completed' } } });
  });

  it.each(['abort', 'pause', 'stop'])('makes managed %s uncertain and signals only its bound generation', async command => {
    const { store } = activate();
    await run();
    expect((await control(command, ...(command === 'abort' ? ['m-synthetic'] : []))).exitCode).toBe(0);
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('uncertain');
    expect(mocks.cancel).toHaveBeenCalledWith(root, root, 'loop-synthetic', {
      requestId: 'mc-synthetic.m-synthetic', generation: 1, execution: { pid: 12345, startedAt: 'synthetic-boot:123:1000' },
    });
  });

  it.each(['abort', 'pause', 'stop'])('rejects stale %s ownership before changing task state or signalling', async command => {
    const { store } = activate();
    await run();
    const checkpoint = JSON.parse(files.get(sessionPath)!);
    checkpoint.missions[0].admissionGeneration = 2;
    files.set(sessionPath, JSON.stringify(checkpoint));
    const before = files.get(sessionPath);
    expect((await control(command, ...(command === 'abort' ? ['m-synthetic'] : []))).exitCode).toBe(1);
    expect(files.get(sessionPath)).toBe(before);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(store.read().records['mc-synthetic.m-synthetic']!.state).toBe('admitted');
  });

  it('retains observer-loss health across reopened caller reconciliation', async () => {
    const { store } = activate();
    await run();
    files.set(ralphStatePath(), JSON.stringify({ status: 'running', health: syntheticHealth({
      coverage: 'degraded', termination: 'uncertain', reasonCode: 'DISCONNECTED', unavailableSignals: ['observer-continuity'],
    }) }));
    await run('status');
    await run('status');
    expect(store.read().records['mc-synthetic.m-synthetic']!).toMatchObject({ state: 'uncertain', reservedSlots: 1 });
    expect(store.read().records['mc-synthetic.m-synthetic']!.health).toMatchObject({ reasonCode: 'DISCONNECTED', termination: 'uncertain' });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it('rejects resume under revoked policy and preserves paused artifacts', async () => {
    activate();
    await run();
    await control('pause');
    const before = files.get(sessionPath);
    cfg.parallelism!.activation!.revision += 1;
    expect((await control('resume')).exitCode).toBe(1);
    expect(files.get(sessionPath)).toBe(before);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it('does not resume or automatically replay uncertain work with current policy', async () => {
    activate();
    await run();
    await control('pause');
    const before = files.get(sessionPath);
    expect((await control('resume')).exitCode).toBe(1);
    expect(files.get(sessionPath)).toBe(before);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
});
