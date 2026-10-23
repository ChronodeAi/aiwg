import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertManagedWorkerLaunch } from '../../../tools/ralph-external/session-launcher.mjs';
import { saveLauncherRegistry } from '../../../src/cli/handlers/ralph-launcher.js';
import { createMcAdmissionScheduler } from '../../../src/cli/handlers/mc.js';
import { bindManagedAdmissionPolicy, FileAdmissionStore, managedProjectAdmissionPolicy,
  projectAdmissionAuthority } from '../../../src/serve/shared-host-scheduler.js';
import { workerActivationDigests, workerConfigDigest, type AiwgConfig } from '../../../src/config/aiwg-config.js';

let root: string;
const now = '2026-10-22T12:00:00.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'managed-worker-'));
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'); vi.stubEnv('RALPH_LOOP_ID', 'synthetic-loop');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const config = { version: '1', providers: ['codex'], installed: {}, scripts: {}, parallelism: {
    worker_mode: 'managed', worker_dispatch: true, max_parallel_subagents: 1,
    groups: { coding: { members: [{ id: 'spark', cli: 'first', model: 'model', roles: ['coding'] }] } },
    clis: { first: { adapter: 'providers:codex', accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } },
  } } as AiwgConfig;
  config.parallelism!.activation = { revision: 1, ...workerActivationDigests(config), snapshotRef: 'synthetic:activation' };
  const policy = managedProjectAdmissionPolicy(root, config.parallelism!, workerConfigDigest(config.parallelism!.activation), 1);
  const store = new FileAdmissionStore(projectAdmissionAuthority(root).path);
  bindManagedAdmissionPolicy(store, policy);
  const scheduler = await createMcAdmissionScheduler(root, config);
  scheduler.submit({ requestId: 'request', orchestratorId: 'parent', provider: 'codex', environment: 'default',
    runtimeKind: 'host', priority: 1, submittedAt: now, queueTimeoutMs: 60_000,
    managed: { kind: 'external', group: 'coding', member: 'spark', cli: 'first', model: 'vendor/model', quotaScope: 'synthetic-quota' },
    allowance: { runId: 'parent', taskId: 'task', runBudgets: { timeoutSeconds: 30 },
      reservation: { tokens: 100, costUsd: null } }, metadata: { invocationId: 'synthetic-invocation' } });
  scheduler.claimLaunch('request', 1);
  const options = { invocationPath: join(root, 'plan.json'), runDir: join(root, 'capture'),
    managedAdmission: { requestId: 'request', generation: 1 } };
  saveLauncherRegistry(root, { version: '1', updatedAt: now, loops: { 'synthetic-loop': {
    loopId: 'synthetic-loop', pid: 0, objective: 'synthetic', completionCriteria: 'parent gate', status: 'running',
    startedAt: now, lastUpdate: now, iteration: 0, maxIterations: 1, outputFile: join(root, 'output'),
    managedAdmission: options.managedAdmission, managedWorker: { invocationPath: options.invocationPath, runDir: options.runDir },
  } } });
  const invocation = { mode: 'managed', selected: { group: 'coding', member: 'spark', cli: 'first', inferenceProvider: 'vendor', model: 'model' },
    limits: { tokens: 100, costUsd: null } };
  return { options, invocation, inputs: { snapshot: { config } }, scheduler, store };
}

describe('T-OG-08 managed one-shot admission guard', () => {
  it('accepts only the shared claimed external reservation without charging another allowance', async () => {
    const f = await fixture();
    const before = f.store.read();
    expect(await assertManagedWorkerLaunch(f.options, f.invocation, f.inputs, root)).toMatchObject({ requestId: 'request', state: 'admitted' });
    expect(f.store.read().allowances).toEqual(before.allowances);
    expect(Object.keys(f.store.read().records)).toEqual(['request']);
  });
  it('retains the original allowance deadline after queue and launch preparation delay', async () => {
    const f = await fixture();
    const first = await assertManagedWorkerLaunch(f.options, f.invocation, f.inputs, root);
    vi.setSystemTime(new Date(Date.parse(now) + 10_000));
    const delayed = await assertManagedWorkerLaunch(f.options, f.invocation, f.inputs, root);
    expect(first.deadlineAtMs).toBe(Date.parse(now) + 30_000);
    expect(delayed.deadlineAtMs).toBe(first.deadlineAtMs);
    expect(delayed.deadlineAtMs - Date.now()).toBe(20_000);
  });
  it.each(['generation', 'selection', 'path', 'cancel', 'expiry', 'deadline', 'tokens', 'unclaimed', 'supervisor', 'birth'])('refuses %s before worker spawn', async mismatch => {
    const f = await fixture();
    if (mismatch === 'generation') f.options.managedAdmission.generation += 1;
    if (mismatch === 'selection') f.invocation.selected.member = 'different';
    if (mismatch === 'path') f.options.runDir = join(root, 'other-capture');
    if (mismatch === 'cancel') f.scheduler.cancel('request', 1);
    if (mismatch === 'expiry') vi.setSystemTime(new Date(Date.parse(now) + 61_000));
    if (mismatch === 'deadline') vi.setSystemTime(new Date(Date.parse(now) + 31_000));
    if (mismatch === 'tokens') f.invocation.limits.tokens = 101;
    if (mismatch === 'unclaimed') f.store.transact(snapshot => { delete snapshot.records.request!.launchClaimedAt; });
    if (mismatch === 'supervisor') f.scheduler.bindExecution('request', 1, { pid: process.pid + 1, startedAt: 'different-birth' });
    if (mismatch === 'birth') f.scheduler.bindExecution('request', 1, { pid: process.pid, startedAt: 'different-birth' });
    await expect(assertManagedWorkerLaunch(f.options, f.invocation, f.inputs, root)).rejects.toThrow(/claimed admission|supervisor identity/);
    expect(f.store.read().records.request!.state).not.toBe('settled');
  });
});
