import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindManagedAdmissionPolicy, FileAdmissionStore, InMemoryAdmissionStore, SharedHostScheduler,
  type AdmissionRequest, type AdmissionStore, type SharedHostPolicy,
} from '../../../src/serve/shared-host-scheduler.js';
import type { WorkerHealthSummary, WorkerUsage } from '../../../src/mission-protocol/types.js';

const epoch = Date.parse('2026-10-22T12:00:00Z');
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const policy: SharedHostPolicy = {
  maxConcurrent: 1, leaseTtlMs: 10_000, agingIntervalMs: 1000, allowPreemption: true,
  managed: { authorityRef: 'project', projectId: 'a'.repeat(64), policyDigest: `sha256:${'b'.repeat(64)}`,
    maxQueued: 10, dimensionCaps: {}, installations: {}, members: {} },
};
const usage: WorkerUsage = {
  quality: 'unknown', inputTokens: null, outputTokens: null, cacheTokens: null,
  reasoningTokens: null, costUsd: null, reservedTokens: 0, reservedUsd: null,
};
function request(requestId: string): AdmissionRequest {
  return { requestId, orchestratorId: 'run', environment: 'test', provider: 'synthetic', runtimeKind: 'container',
    priority: 10, submittedAt: new Date(epoch).toISOString(), queueTimeoutMs: 120_000, managed: { kind: 'native' },
    allowance: { runId: 'run', taskId: requestId, reservation: { tokens: 10, costUsd: 1 } } };
}
function health(overrides: Partial<WorkerHealthSummary> = {}): WorkerHealthSummary {
  return { version: 1, state: 'active', termination: 'running', coverage: 'full', handshake: 'semantic',
    lastObservedAt: new Date(epoch).toISOString(), lastActivityAt: new Date(epoch).toISOString(),
    lastProgressAt: new Date(epoch).toISOString(), reasonCode: 'PROGRESS', transitionCount: 1,
    restartCount: 0, unavailableSignals: [], transitionRefs: [], observerGeneration: 1,
    startupDeadlineAt: null, hardDeadlineAt: null, maxCheckGapSeconds: 1, confidence: 'observed',
    handshakeAt: new Date(epoch).toISOString(), stalledAt: null, ...overrides };
}
const confirmed = () => health({ state: 'completed', termination: 'confirmed', reasonCode: 'OK' });
function setup(durable = false) {
  let store: AdmissionStore = new InMemoryAdmissionStore();
  if (durable) {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-fencing-')); directories.push(dir);
    store = new FileAdmissionStore(join(dir, 'admission.json'));
  }
  bindManagedAdmissionPolicy(store, policy);
  let now = epoch;
  const create = () => new SharedHostScheduler(store, policy, () => now);
  let scheduler = create();
  scheduler.submit(request('running')); scheduler.submit(request('waiting'));
  return { get scheduler() { return scheduler; }, store, advance(ms: number) { now += ms; },
    reopen() { scheduler = create(); },
    retained() {
      expect(scheduler.snapshot().records.running).toMatchObject({ state: 'uncertain', reservedSlots: 1 });
      expect(scheduler.snapshot().records.running!.finishedAt).toBeUndefined();
      expect(scheduler.snapshot().records.waiting!.state).toBe('queued');
    } };
}

describe('T-OG-06/24 managed fencing and checkpoint recovery', () => {
  it.each(['renew', 'cancel', 'stop', 'disconnect', 'observeHealth', 'acceptFinal', 'settle', 'claimLaunch', 'bindExecution'] as const)(
    'rejects stale %s without any persisted mutation', operation => {
      const c = setup(true); c.reopen(); const before = c.store.read();
      const calls = {
        renew: () => c.scheduler.renew('running', 0), cancel: () => c.scheduler.cancel('running', 0),
        stop: () => c.scheduler.stop('running', 0), disconnect: () => c.scheduler.disconnect('running', 0),
        observeHealth: () => c.scheduler.observeHealth('running', 0, health()),
        acceptFinal: () => c.scheduler.acceptFinal('running', 0, confirmed()),
        settle: () => c.scheduler.settle('running', 0, confirmed(), usage),
        claimLaunch: () => c.scheduler.claimLaunch('running', 0),
        bindExecution: () => c.scheduler.bindExecution('running', 0, { pid: 4242, startedAt: 'boot:1' }),
      };
      expect(calls[operation]).toThrow(/stale/); expect(c.store.read()).toEqual(before);
    });

  it('requires explicit generations on managed renew and cancel', () => {
    const c = setup(); const before = c.store.read();
    expect(() => c.scheduler.renew('running')).toThrow(/stale/);
    expect(() => c.scheduler.cancel('running')).toThrow(/stale/);
    expect(c.store.read()).toEqual(before);
  });

  it('renew extends only the lease and cannot resurrect an expired lease', () => {
    const c = setup(); c.scheduler.observeHealth('running', 1, health());
    const before = c.scheduler.snapshot().records.running!;
    c.advance(1000);
    expect(c.scheduler.renew('running', 1)).toEqual({ ...before,
      leaseExpiresAt: new Date(epoch + 11_000).toISOString(), revision: before.revision + 1, reason: 'lease renewed' });
    c.advance(10_000);
    expect(c.scheduler.renew('running', 1).leaseExpiresAt).toBe(new Date(epoch + 11_000).toISOString());
    c.retained();
  });

  it('persists nondecreasing semantic progress independently of heartbeat renewals', () => {
    const c = setup(true);
    const later = new Date(epoch + 1000).toISOString();
    for (const progress of [new Date(epoch).toISOString(), later, new Date(epoch).toISOString(), later]) {
      c.scheduler.observeHealth('running', 1, health({ lastProgressAt: progress })); c.reopen();
    }
    c.scheduler.observeHealth('running', 1, health({ lastObservedAt: new Date(epoch + 2000).toISOString(), lastProgressAt: null }));
    c.scheduler.renew('running', 1);
    expect(c.scheduler.snapshot().records.running!.lastProgressAt).toBe(later);
  });

  it.each(['cancel', 'disconnect', 'preempt', 'observer-loss'] as const)('retains capacity after %s and a late confirmed final across restart', reason => {
    const c = setup(true);
    c.scheduler.stop('running', 1, reason); c.reopen(); c.retained();
    c.scheduler.acceptFinal('running', 1, confirmed(), usage); c.reopen(); c.retained();
    expect(c.scheduler.snapshot().records.running!.accounting!.stopEvidence).toBeUndefined();
    c.scheduler.settle('running', 1, null, usage); c.retained();
    const settled = c.scheduler.settle('running', 1, confirmed(), usage);
    expect(settled.state).toBe('settled'); expect(c.scheduler.snapshot().records.waiting!.state).toBe('admitted');
    c.reopen(); expect(c.scheduler.settle('running', 1, confirmed(), usage)).toEqual(settled);
  });

  it('maps observer loss and contradictory confirmed health into uncertainty without completion credit', () => {
    const c = setup();
    c.scheduler.observeHealth('running', 1, health({ termination: 'uncertain', reasonCode: 'OBSERVER_LOST' }));
    c.retained();
    c.scheduler.observeHealth('running', 1, health({ termination: 'confirmed' })); c.retained();
    expect(c.scheduler.settle('running', 1, health({ termination: 'confirmed' }), usage).state).toBe('uncertain');
  });

  it('rejects stale final and health evidence without poisoning current stop proof', () => {
    const c = setup(); c.scheduler.disconnect('running', 1); const before = c.store.read();
    expect(() => c.scheduler.acceptFinal('running', 1, health({ ...confirmed(), observerGeneration: 0 }))).toThrow(/stale/);
    expect(() => c.scheduler.observeHealth('running', 1, health({ observerGeneration: 0 }))).toThrow(/stale/);
    expect(c.store.read()).toEqual(before);
    expect(c.scheduler.settle('running', 1, health({ ...confirmed(), observerGeneration: 0 }), usage).state).toBe('uncertain');
    expect(c.scheduler.snapshot().records.running!.accounting!.stopEvidence).toBeUndefined();
    expect(c.scheduler.settle('running', 1, confirmed(), usage).state).toBe('settled');
  });

  it('retains uncertain and terminal-unconfirmed proofs regardless of current caller generation', () => {
    const c = setup();
    for (const state of ['active', 'completed', 'crashed'] as const) {
      c.scheduler.settle('running', 1, health({ state, termination: 'uncertain' }), usage); c.retained();
    }
  });

  it('claims dispatch durably before launch and refuses replay after either crash boundary', () => {
    const c = setup(true);
    c.scheduler.claimLaunch('running', 1); c.reopen();
    expect(() => c.scheduler.claimLaunch('running', 1)).toThrow(/already claimed/);
    const execution = { pid: 4242, startedAt: 'synthetic-boot:123:1000' };
    c.scheduler.bindExecution('running', 1, execution); c.reopen();
    expect(() => c.scheduler.claimLaunch('running', 1)).toThrow(/already claimed/);
    expect(c.scheduler.bindExecution('running', 1, execution).execution).toEqual(execution);
    expect(c.scheduler.submit(request('running')).launchClaimedAt).toBe(new Date(epoch).toISOString());
    c.scheduler.stop('running', 1, 'observer-loss'); c.retained();
    expect(c.scheduler.submit(request('running')).state).toBe('uncertain');
    expect(() => c.scheduler.submit({ ...request('running'), metadata: { payload: 'changed' } })).toThrow(/conflicts/);
  });

  it('rejects PID reuse at binding and stop-proof ingestion and releases only the bound execution', () => {
    const c = setup(true); c.scheduler.claimLaunch('running', 1);
    const original = { pid: 4242, startedAt: 'synthetic-boot:123:1000' };
    const reused = { pid: 4242, startedAt: 'synthetic-boot:456:1000' };
    c.scheduler.bindExecution('running', 1, original); c.reopen();
    const before = c.store.read();
    expect(() => c.scheduler.bindExecution('running', 1, reused)).toThrow(/PID reuse/);
    expect(() => c.scheduler.settle('running', 1, confirmed(), usage, undefined, reused)).toThrow(/PID reuse/);
    expect(() => c.scheduler.settle('running', 1, confirmed(), usage)).toThrow(/identity/);
    expect(c.store.read()).toEqual(before);
    expect(c.scheduler.settle('running', 1, confirmed(), usage, undefined, original).state).toBe('settled');
  });

  it('retains a confirmed proof after crash between launch claim and process identity checkpoint', () => {
    const c = setup(true); c.scheduler.claimLaunch('running', 1); c.reopen();
    c.scheduler.settle('running', 1, confirmed(), usage); c.retained();
    expect(c.scheduler.snapshot().records.running!.accounting!.stopEvidence).toBeUndefined();
    const execution = { pid: 4242, startedAt: 'synthetic-boot:123:1000' };
    c.scheduler.bindExecution('running', 1, execution);
    expect(c.scheduler.settle('running', 1, confirmed(), usage, undefined, execution).state).toBe('settled');
  });

  it('rechecks the original run and task deadlines before claiming a delayed launch', () => {
    for (const scope of ['runBudgets', 'taskBudgets'] as const) {
      const c = setup();
      c.scheduler.settle('running', 1, confirmed(), usage);
      c.scheduler.settle('waiting', 1, confirmed(), usage);
      c.scheduler.submit({ ...request('delayed'), allowance: { ...request('delayed').allowance!, [scope]: { timeoutSeconds: 1 } } });
      c.advance(1001);
      expect(() => c.scheduler.claimLaunch('delayed', 1)).toThrow(/allowance deadline/);
      expect(c.scheduler.snapshot().records.delayed!.launchClaimedAt).toBeUndefined();
    }
  });

  it('records final evidence idempotently and rejects changed finals without changing settlement', () => {
    const c = setup(); const final = c.scheduler.acceptFinal('running', 1, confirmed(), usage);
    expect(c.scheduler.acceptFinal('running', 1, confirmed(), usage)).toEqual(final);
    expect(final.state).toBe('admitted');
    const before = c.store.read();
    expect(() => c.scheduler.acceptFinal('running', 1, confirmed())).toThrow(/conflicting/);
    expect(c.store.read()).toEqual(before);
  });

  it('rejects an expired or unadmitted launch claim and unclaimed execution binding', () => {
    const c = setup();
    expect(() => c.scheduler.claimLaunch('waiting', 1)).toThrow(/admitted/);
    expect(() => c.scheduler.bindExecution('running', 1, { pid: 1, startedAt: 'boot:1' })).toThrow(/claimed/);
    expect(() => c.scheduler.bindExecution('running', 1, { pid: 1, startedAt: '' })).toThrow(/birth/);
    c.advance(10_000); expect(() => c.scheduler.claimLaunch('running', 1)).toThrow(/current/);
    c.scheduler.reconcileNow(); c.retained();
  });
});
