import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  bindManagedAdmissionPolicy, FileAdmissionStore, InMemoryAdmissionStore, SharedHostScheduler,
  type AdmissionRequest, type AdmissionStore, type SharedHostPolicy,
} from '../../../src/serve/shared-host-scheduler.js';
import type { WorkerHealthSummary, WorkerUsage } from '../../../src/mission-protocol/types.js';
import { observeChildClose, stopAndReap } from '../../helpers/worker-lifecycle.mjs';

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

describe('T-OG-06 NFR-OG-003 two-process crash admission', () => {
  it('T-OG-06 NFR-OG-003 P01 100 managed requests across two processes survive SIGKILL with zero premature releases and no cap overshoot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-crash-admission-')); directories.push(dir);
    const storePath = join(dir, 'admission.json');
    const projectId = 'c'.repeat(64);
    const crashPolicy: SharedHostPolicy = {
      maxConcurrent: 4, leaseTtlMs: 600_000, agingIntervalMs: 1000, allowPreemption: false,
      managed: { authorityRef: 'project', projectId, policyDigest: `sha256:${'d'.repeat(64)}`,
        maxQueued: 200, dimensionCaps: {
          [`project/${projectId}/group/coding/member/alpha`]: 2,
          [`project/${projectId}/group/coding/member/beta`]: 2,
        },
        installations: { first: { accountScope: 'crash-account', quotaScope: 'pool/crash' } },
        members: { 'coding/alpha': { cli: 'first' }, 'coding/beta': { cli: 'first' } } },
    };
    bindManagedAdmissionPolicy(new FileAdmissionStore(storePath), crashPolicy);
    const submittedAt = new Date().toISOString();
    const assignments = Array.from({ length: 100 }, (_, index) => {
      const requestId = `crash-${String(index).padStart(3, '0')}`;
      const member = index % 2 === 0 ? 'alpha' : 'beta';
      return { requestId, request: { requestId, orchestratorId: 'crash-run', environment: 'test',
        provider: 'synthetic', runtimeKind: 'container', priority: 10, submittedAt, queueTimeoutMs: 600_000,
        managed: { kind: 'native', group: 'coding', member, cli: 'first', quotaScope: 'pool/crash' },
        allowance: { runId: 'crash-run', taskId: requestId, reservation: { tokens: 10, costUsd: 1 } } } };
    });
    const children: ChildProcess[] = [];
    const closed: Promise<unknown>[] = [];
    const seen = new Set<string>();
    const states = new Set<string>();
    let maxAdmitted = 0; const maxMembers: Record<string, number> = {};
    let crashed = false;
    let crashSignal: NodeJS.Signals | null = null;
    let restarted = false;
    let stopping = false;
    let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
    const completed = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveDone = resolvePromise; rejectDone = rejectPromise;
    });
    const spawn = (tag: string, ids: typeof assignments) => {
      const child = fork(resolve('test/fixtures/crash-admission-worker.mts'),
        [storePath, JSON.stringify(crashPolicy), JSON.stringify(ids), tag,
          tag === 'bravo' ? '15' : '0'],
        { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      closed.push(observeChildClose(child));
      let reported = 0;
      child.on('message', (message: any) => {
        if (message?.pid !== child.pid) {
          rejectDone(new Error('admission writer must be the directly owned child')); return;
        }
        if (message?.done) return;
        seen.add(message.requestId); states.add(message.state);
        maxAdmitted = Math.max(maxAdmitted, message.admitted);
        for (const [member, count] of Object.entries(message.members ?? {})) {
          maxMembers[member] = Math.max(maxMembers[member] ?? 0, count as number);
        }
        if (seen.size === 100) resolveDone();
        if (tag === 'bravo' && !crashed && (reported += 1) === 15) {
          crashed = true;
          if (!child.kill('SIGKILL')) rejectDone(new Error('crash worker refused SIGKILL'));
        }
      });
      child.on('close', (code, signal) => {
        if (stopping) return;
        if (tag === 'bravo' && crashed && signal === 'SIGKILL') {
          crashSignal = signal;
          // The IPC gate is between commits, so this writer holds no lock.
          // The surviving writer may own the lock; leave it untouched.
          spawn('bravo-restart', ids);
          restarted = true;
        } else if (code !== 0) rejectDone(new Error(`crash worker ${tag} exited with ${code ?? signal}`));
      });
      child.on('error', rejectDone);
    };
    const timer = setTimeout(() => {
      stopping = true;
      for (const child of children) child.kill('SIGKILL');
      rejectDone(new Error('crash admission did not complete within 40 seconds'));
    }, 40_000);
    try {
      spawn('alpha', assignments.slice(0, 50));
      spawn('bravo', assignments.slice(50));
      await completed;
    } finally {
      stopping = true;
      clearTimeout(timer);
      await Promise.all(children.map((child, index) => stopAndReap(child, closed[index])));
    }
    expect(crashed).toBe(true);
    expect(crashSignal).toBe('SIGKILL');
    expect(restarted).toBe(true);
    expect(seen.size).toBe(100);
    for (const state of states) expect(['admitted', 'queued']).toContain(state);
    expect(maxAdmitted).toBeLessThanOrEqual(4);
    expect(maxMembers.alpha).toBeLessThanOrEqual(2);
    expect(maxMembers.beta).toBeLessThanOrEqual(2);
    const records = new FileAdmissionStore(storePath).read().records;
    expect(Object.keys(records)).toHaveLength(100);
    let admitted = 0; const perMember: Record<string, number> = {};
    for (const record of Object.values(records)) {
      expect(['admitted', 'queued']).toContain(record.state);
      expect(record.finishedAt).toBeUndefined();
      if (record.state !== 'admitted') continue;
      admitted += 1;
      perMember[record.managed!.member!] = (perMember[record.managed!.member!] ?? 0) + 1;
      expect(record.reservedSlots).toBe(1);
      expect(Date.parse(record.leaseExpiresAt!) > Date.now()).toBe(true);
    }
    expect(admitted).toBe(4);
    expect(perMember).toEqual({ alpha: 2, beta: 2 });
  }, 45_000);
});
