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

const mocks = vi.hoisted(() => ({ readConfig: vi.fn(), readCandidate: vi.fn(), launch: vi.fn() }));
vi.mock('../../../../src/config/aiwg-config.js', async original => ({
  ...await original<typeof import('../../../../src/config/aiwg-config.js')>(),
  readAiwgConfig: mocks.readConfig, readAiwgConfigCandidate: mocks.readCandidate,
}));
vi.mock('../../../../src/cli/handlers/ralph-launcher.js', () => ({ launchExternalRalph: mocks.launch }));

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
  mocks.launch.mockResolvedValue({ loopId: 'loop-synthetic', pid: 12345 });
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
    if (outcome === 'cancelled') scheduler.cancel('mc-synthetic.m-synthetic');
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
