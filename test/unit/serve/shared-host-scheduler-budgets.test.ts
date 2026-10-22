import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindManagedAdmissionPolicy, FileAdmissionStore, InMemoryAdmissionStore, managedAllowanceFromOwner,
  SharedHostScheduler, type AdmissionRequest, type SharedHostPolicy,
} from '../../../src/serve/shared-host-scheduler.js';
import type { WorkerHealthSummary, WorkerUsage } from '../../../src/mission-protocol/types.js';

const epoch = Date.parse('2026-10-22T12:00:00Z');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function policy(): SharedHostPolicy {
  return { maxConcurrent: 4, leaseTtlMs: 60_000, agingIntervalMs: 1000, allowPreemption: false, defaultHostQuota: 4,
    managed: { authorityRef: 'project', projectId: 'a'.repeat(64), policyDigest: `sha256:${'b'.repeat(64)}`,
      maxQueued: 10, dimensionCaps: {},
      budgets: { perRun: { tokens: 100, costUsd: 10 }, perTask: { tokens: 80, costUsd: 8 } },
      retry: { maxAttempts: 3, baseDelaySeconds: 2, maxDelaySeconds: 8 },
      installations: { muse: { accountScope: 'one', quotaScope: 'shared' },
        codex: { accountScope: 'one', quotaScope: 'shared' }, local: { accountScope: 'two', quotaScope: 'other' } },
      members: { 'coding/muse': { cli: 'muse' }, 'coding/codex': { cli: 'codex' }, 'coding/local': { cli: 'local' } },
    } };
}
function request(id: string, overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return { requestId: id, orchestratorId: 'run', environment: 'test', provider: 'synthetic', runtimeKind: 'host',
    priority: 1, submittedAt: new Date(epoch).toISOString(), queueTimeoutMs: 120_000,
    managed: { kind: 'external', group: 'coding', member: 'muse', cli: 'muse', model: 'synthetic/model', quotaScope: 'shared' },
    allowance: { runId: 'run', taskId: 'task', reservation: { tokens: 20, costUsd: 2 } }, ...overrides };
}
function health(overrides: Partial<WorkerHealthSummary> = {}): WorkerHealthSummary {
  return { version: 1, state: 'completed', termination: 'confirmed', coverage: 'full', handshake: 'semantic',
    lastObservedAt: new Date(epoch).toISOString(), lastActivityAt: null, lastProgressAt: null,
    reasonCode: 'FINAL', transitionCount: 1, restartCount: 0, unavailableSignals: [], transitionRefs: [],
    observerGeneration: 1, startupDeadlineAt: null, hardDeadlineAt: null, maxCheckGapSeconds: 1,
    confidence: 'observed', handshakeAt: null, stalledAt: null, ...overrides };
}
function usage(quality: WorkerUsage['quality'] = 'unknown', tokens = 10, costUsd = 1): WorkerUsage {
  return { quality, inputTokens: quality === 'unknown' ? null : tokens, outputTokens: quality === 'unknown' ? null : 0,
    cacheTokens: quality === 'unknown' ? null : 0, reasoningTokens: quality === 'unknown' ? null : 0,
    costUsd: quality === 'unknown' ? null : costUsd, reservedTokens: 20, reservedUsd: 2 };
}
function setup(value = policy(), store = new InMemoryAdmissionStore()) {
  let now = epoch;
  bindManagedAdmissionPolicy(store, value);
  return { store, scheduler: new SharedHostScheduler(store, value, () => now), advance: (ms: number) => { now += ms; } };
}
function next(id: string, previousRequestId: string, purpose: NonNullable<AdmissionRequest['allowance']>['purpose'] = 'quality') {
  return request(id, { allowance: { ...request(id).allowance!, previousRequestId, purpose } });
}

describe('T-OG-05/08/09 cumulative managed allowances', () => {
  it.each(['mission', 'ralph', 'flow'] as const)('binds existing %s ceilings to the shared reservation', kind => {
    const owner = kind === 'mission' ? { kind, budgets: { maxAttempts: 2, maxTokens: 40, maxCostUsd: 4, timeoutSeconds: 30 } }
      : kind === 'ralph' ? { kind, maxIterations: 2, maxTotalTokens: 40, maxTotalCost: 4, maxWallClockMinutes: 0.5 }
        : { kind, ceilings: { activations: 2, tokens: 40, costUsd: 4, timeMs: 30_000 } };
    const { scheduler } = setup();
    const bound = managedAllowanceFromOwner('run', 'task', owner);
    const result = scheduler.submit(request('a', { allowance: bound, ...(kind === 'ralph' ? { managed: { kind: 'native' as const } } : {}) }));
    expect(result.accounting).toMatchObject({ reservation: { tokens: 40, costUsd: 4 }, attemptNumber: 1, usage: null });
    expect(Object.values(scheduler.snapshot().allowances!).find(scope => scope.limits.maxAttempts === 2)).toMatchObject({
      limits: { maxAttempts: 2, maxTokens: 40, maxCostUsd: 4, timeoutSeconds: 30 },
      deadlineAt: new Date(epoch + 30_000).toISOString(),
    });
  });

  it.each(['mission', 'flow'] as const)('shares %s run ceilings across child tasks and reviews', kind => {
    const { scheduler } = setup();
    const owner = kind === 'mission' ? { kind, budgets: { maxAttempts: 2, maxTokens: 40 } }
      : { kind, ceilings: { activations: 2, tokens: 40 } };
    for (const [id, taskId] of [['a', 'writer'], ['b', 'review'], ['c', 'quality']]) {
      const allowance = managedAllowanceFromOwner('run', taskId!, owner);
      allowance.reservation = { tokens: 10, costUsd: 1 };
      const result = scheduler.submit(request(id!, { allowance }));
      expect(result.state).toBe(id === 'c' ? 'denied' : 'admitted');
      if (id !== 'c') scheduler.settle(id!, 1, health(), usage('reported', 0, 0));
    }
  });

  it('reserves run and task dimensions atomically across tasks and keeps queued attempts uncharged', () => {
    const value = policy(); value.maxConcurrent = 1; value.managed!.budgets!.perRun = { tokens: 30, costUsd: 3 };
    const { scheduler } = setup(value);
    scheduler.submit(request('a'));
    const queued = request('b', { allowance: { ...request('b').allowance!, taskId: 'second', reservation: { tokens: 10, costUsd: 1 } } });
    expect(scheduler.submit(queued)).toMatchObject({ state: 'queued', accounting: { usage: null } });
    expect(scheduler.snapshot().records.b!.accounting!.attemptNumber).toBeUndefined();
    expect(scheduler.submit(request('over', { allowance: { ...request('over').allowance!, taskId: 'third' } })).state).toBe('denied');
    scheduler.settle('a', 1, health(), usage());
    expect(scheduler.snapshot().records.b!).toMatchObject({ state: 'admitted', accounting: { attemptNumber: 1 } });
    expect(scheduler.snapshot().records.a!.accounting!.usage!.inputTokens).toBeNull();
  });

  it.each(['quality', 'effort', 'fallback', 'review', 'retry'] as const)('%s consumes the same task attempt allowance', purpose => {
    const value = policy(); value.managed!.retry!.maxAttempts = 2;
    const { scheduler, advance } = setup(value);
    scheduler.submit(request('a')); scheduler.settle('a', 1, health(), usage(), { class: 'unavailable', retryable: true }); advance(2000);
    expect(scheduler.submit(next('b', 'a', purpose)).accounting!.attemptNumber).toBe(2);
    scheduler.settle('b', 1, health(), usage(), { class: 'unavailable', retryable: true }); advance(4000);
    expect(scheduler.submit(next('c', 'b', purpose))).toMatchObject({ state: 'denied', reason: 'cumulative attempt allowance exhausted' });
  });

  it.each(['reported', 'estimated', 'unknown'] as const)('keeps %s usage distinct and retains conservative charges', quality => {
    const value = policy(); value.managed!.budgets!.perTask = { tokens: 30, costUsd: 3 };
    const { scheduler } = setup(value);
    scheduler.submit(request('a')); scheduler.settle('a', 1, health(), usage(quality));
    expect(scheduler.snapshot().records.a!.accounting).toMatchObject({ reservation: { tokens: 20, costUsd: 2 }, usage: { quality } });
    expect(scheduler.submit(next('b', 'a')).state).toBe(quality === 'reported' ? 'admitted' : 'denied');
  });

  it.each(['cacheTokens', 'reasoningTokens'] as const)('retains reservations for an unreported %s dimension', dimension => {
    const value = policy(); value.managed!.budgets!.perTask = { tokens: 30 };
    const { scheduler } = setup(value); scheduler.submit(request('a'));
    scheduler.settle('a', 1, health(), { ...usage('reported'), [dimension]: null });
    expect(scheduler.submit(next('b', 'a')).state).toBe('denied');
  });

  it('accepts explicit reported zero but rejects unknown usage disguised as zero', () => {
    const { scheduler } = setup(); scheduler.submit(request('a'));
    expect(() => scheduler.settle('a', 1, health(), { ...usage(), inputTokens: 0 })).toThrow();
    expect(scheduler.settle('a', 1, health(), usage('reported', 0, 0)).accounting!.usage!.costUsd).toBe(0);
    expect(scheduler.submit(next('b', 'a')).state).toBe('admitted');
  });

  it('blocks finite allowances after unknown unreserved usage rather than treating it as zero', () => {
    const value = policy(); value.managed!.budgets = {};
    const { scheduler } = setup(value);
    scheduler.submit(request('a', { allowance: { runId: 'run', taskId: 'task', reservation: { tokens: null, costUsd: null } } }));
    scheduler.settle('a', 1, health(), usage());
    const retry = next('b', 'a'); retry.allowance!.taskBudgets = { maxTokens: 100 };
    expect(scheduler.submit(retry)).toMatchObject({ state: 'denied', reason: 'unknown tokens charge has no finite reservation' });
  });

  it('intersects tighter ceilings and keeps the original deadline across retries and callers', () => {
    const { scheduler, store, advance } = setup();
    const a = request('a'); a.allowance!.taskBudgets = { maxTokens: 40, timeoutSeconds: 5, maxAttempts: 2 };
    scheduler.submit(a); scheduler.settle('a', 1, health(), usage()); advance(5000);
    const other = new SharedHostScheduler(store, policy(), () => epoch + 5000);
    const b = next('b', 'a'); b.allowance!.taskBudgets = { maxTokens: 1000, timeoutSeconds: 1000, maxAttempts: 100 };
    expect(other.submit(b)).toMatchObject({ state: 'denied', reason: 'cumulative allowance deadline elapsed' });
    expect(Object.values(store.read().allowances!).find(scope => scope.limits.maxAttempts === 2)!.limits.maxTokens).toBe(40);
  });

  it('requires latest-task reconciliation and fences settlement proof independently of caller generation', () => {
    const { scheduler } = setup(); scheduler.submit(request('a')); scheduler.cancel('a', 1);
    expect(scheduler.submit(next('blocked', 'a')).state).toBe('denied');
    expect(() => scheduler.settle('a', 0, health(), usage())).toThrow(/stale/);
    expect(scheduler.settle('a', 1, health({ observerGeneration: 0 }), usage()).state).toBe('uncertain');
    expect(scheduler.settle('a', 1, health({ termination: 'uncertain' }), usage()).state).toBe('uncertain');
    expect(scheduler.settle('a', 1, health(), usage()).state).toBe('settled');
    expect(scheduler.settle('a', 1, health(), usage()).state).toBe('settled');
    expect(scheduler.submit(next('b', 'a')).accounting!.attemptNumber).toBe(2);
    scheduler.settle('b', 1, health(), usage());
    expect(scheduler.submit(next('stale-parent', 'a')).state).toBe('denied');
    expect(() => scheduler.settle('a', 1, health(), usage('reported'))).toThrow(/conflicting/);
  });

  it('refines unknown observations to reported usage only when current proof settles execution', () => {
    const { scheduler } = setup(); scheduler.submit(request('a'));
    scheduler.settle('a', 1, null, usage());
    expect(scheduler.snapshot().records.a!.state).toBe('uncertain');
    expect(scheduler.settle('a', 1, health(), usage('reported')).state).toBe('settled');
    expect(scheduler.snapshot().records.a!.accounting!.usage!.quality).toBe('reported');
  });

  it('reserves bounded native iterations against the common attempts before launching', () => {
    const { scheduler } = setup();
    const allowance = managedAllowanceFromOwner('run', 'task', { kind: 'ralph', maxIterations: 10 });
    const a = scheduler.submit(request('a', { managed: { kind: 'native' }, allowance }));
    expect(a.accounting).toMatchObject({ attemptNumber: 1, attemptCount: 3 });
    scheduler.settle('a', 1, health(), usage());
    expect(scheduler.submit(next('review', 'a', 'review'))).toMatchObject({ state: 'denied', reason: 'cumulative attempt allowance exhausted' });
  });

  it.each([{}, { tokens: 20 }, { costUsd: 2 }, { tokens: 20, costUsd: 2, extra: 1 }])('rejects incomplete runtime reservation %j without writes', reservation => {
    const { scheduler, store } = setup(); const before = store.read();
    const bad = request('bad'); bad.allowance!.reservation = reservation as any;
    expect(() => scheduler.submit(bad)).toThrow(/reservation/);
    expect(store.read()).toEqual(before);
  });

  it('blocks pre-allowance managed snapshots with an actionable migration diagnostic', () => {
    const { scheduler, store } = setup(); scheduler.submit(request('old'));
    store.transact(snapshot => { delete snapshot.records.old!.accounting; });
    const before = store.read();
    expect(() => scheduler.reconcileNow()).toThrow(/migration required/);
    expect(store.read()).toEqual(before);
    expect(store.read().records.old!.state).toBe('admitted');
  });

  it('rejects unenforceable hard budgets, invalid ceilings, missing reservations and unstable run identities', () => {
    const hard = policy(); hard.managed!.budgets!.enforcement = 'hard';
    expect(() => setup(hard)).toThrow(/OG_BUDGET_UNMEASURABLE/);
    const { scheduler } = setup();
    expect(() => scheduler.submit(request('bad', { allowance: { runId: 'other', taskId: 'task' } }))).toThrow(/identity/);
    expect(() => scheduler.submit(request('bad', { allowance: { runId: 'run', taskId: 'task', taskBudgets: { maxAttempts: 0 } } }))).toThrow(/ceiling/);
    expect(() => scheduler.submit(request('bad', { allowance: { runId: 'run', taskId: 'task', reservation: { tokens: 0, costUsd: 0 } } }))).toThrow(/reservation/);
    expect(scheduler.submit(request('null', { allowance: { runId: 'run', taskId: 'task', reservation: { tokens: null, costUsd: null } } })).state).toBe('denied');
  });
});

describe('T-OG-06 S3 synthetic multi-CLI quota recovery', () => {
  it.each(['valid', 'missing', 'malformed'] as const)('honors %s reset plus backoff across installations and a second caller', reset => {
    const { scheduler, store, advance } = setup();
    scheduler.submit(request('a'));
    const failure = reset === 'valid' ? { resetAt: new Date(epoch + 10_000).toISOString() } : reset === 'malformed' ? { resetAt: 'invalid' } : {};
    scheduler.settle('a', 1, health(), usage(), { class: 'rate-limit', retryable: true, ...failure });
    const retry = next('b', 'a'); retry.managed = { ...retry.managed!, cli: 'codex', member: 'codex' };
    expect(scheduler.submit(retry).state).toBe('queued');
    const second = new SharedHostScheduler(store, policy(), () => epoch + 1000);
    expect(second.submit(request('other-caller', { orchestratorId: 'other', allowance: { runId: 'other', taskId: 'task', reservation: { tokens: 20, costUsd: 2 } } })).state).toBe('queued');
    const before = scheduler.snapshot().cooldowns;
    advance(1000); scheduler.recordRateLimit('a', 1, failure);
    expect(scheduler.snapshot().cooldowns).toEqual(before);
    advance(reset === 'valid' ? 9000 : 1000);
    scheduler.reconcileNow();
    expect(scheduler.snapshot().records.b!.state).toBe('admitted');
    expect(scheduler.snapshot().records.b!.accounting!.attemptNumber).toBe(2);
    expect(scheduler.snapshot().records['other-caller']!.state).toBe('admitted');
  });

  it('bounds repeated fallback by exponential backoff and total attempts without resetting balances', () => {
    const { scheduler, advance } = setup(); scheduler.submit(request('a'));
    scheduler.settle('a', 1, health(), usage(), { class: 'rate-limit', retryable: true });
    const b = next('b', 'a'); b.managed = { ...b.managed!, cli: 'local', member: 'local', quotaScope: 'other' };
    expect(scheduler.submit(b).state).toBe('queued'); advance(2000); scheduler.reconcileNow();
    scheduler.settle('b', 1, health(), usage(), { class: 'rate-limit', retryable: true });
    expect(scheduler.submit(next('c', 'b')).state).toBe('queued'); advance(2000); scheduler.reconcileNow();
    expect(scheduler.snapshot().records.c!.accounting!.attemptNumber).toBe(3);
    scheduler.settle('c', 1, health(), usage(), { class: 'rate-limit', retryable: true });
    expect(scheduler.snapshot().cooldowns!['quota/shared']!.until).toBe(new Date(epoch + 8000).toISOString());
    expect(scheduler.submit(next('d', 'c')).state).toBe('denied');
    expect(Object.values(scheduler.snapshot().records).filter(row => row.accounting!.attemptNumber)).toHaveLength(3);
  });

  it('denies a reset beyond the original deadline and disabled rate-limit retries', () => {
    const value = policy(); value.managed!.retry!.on = [];
    const { scheduler } = setup(value); scheduler.submit(request('a'));
    scheduler.settle('a', 1, health(), usage(), { class: 'rate-limit', retryable: true });
    expect(scheduler.submit(next('b', 'a'))).toMatchObject({ state: 'denied', reason: 'rate-limit retries are disabled' });
    const other = setup(); const a = request('a'); a.allowance!.taskBudgets = { timeoutSeconds: 1 };
    other.scheduler.submit(a); other.scheduler.settle('a', 1, health(), usage(), { class: 'rate-limit', retryable: true, resetAt: new Date(epoch + 60_000).toISOString() });
    expect(other.scheduler.submit(next('b', 'a')).state).toBe('queued'); other.advance(1000);
    expect(other.scheduler.reconcileNow().records.b!).toMatchObject({ state: 'denied', reason: 'cumulative allowance deadline elapsed' });
  });

  it.each(['unavailable', 'timeout'] as const)('applies %s retry policy and bounded backoff', failureClass => {
    const { scheduler, advance } = setup(); scheduler.submit(request('a'));
    scheduler.settle('a', 1, health(), usage(), { class: failureClass, retryable: true });
    expect(scheduler.submit(next('b', 'a', 'retry')).state).toBe('queued');
    advance(1999); expect(scheduler.reconcileNow().records.b!.state).toBe('queued');
    advance(1); expect(scheduler.reconcileNow().records.b!.state).toBe('admitted');
    const value = policy(); value.managed!.retry!.on = [];
    const disabled = setup(value); disabled.scheduler.submit(request('a'));
    disabled.scheduler.settle('a', 1, health(), usage(), { class: failureClass, retryable: true });
    expect(disabled.scheduler.submit(next('b', 'a', 'fallback')).state).toBe('denied');
  });

  it.each(['auth', 'invalid-request', 'policy'] as const)('rejects automatic fallback for %s failures', failureClass => {
    const { scheduler } = setup(); scheduler.submit(request('a'));
    scheduler.settle('a', 1, health(), usage(), { class: failureClass, retryable: true });
    expect(scheduler.submit(next('b', 'a', 'fallback'))).toMatchObject({ state: 'denied', reason: 'previous failure does not permit automatic retry' });
  });

  it('retains cooldown and unknown accounting across durable store reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-budget-')); roots.push(root);
    const path = join(root, 'admission.json'); const value = policy();
    const store = new FileAdmissionStore(path); bindManagedAdmissionPolicy(store, value);
    const scheduler = new SharedHostScheduler(store, value, () => epoch);
    scheduler.submit(request('a')); scheduler.settle('a', 1, health(), usage(), { class: 'rate-limit', retryable: true });
    const reopened = new SharedHostScheduler(new FileAdmissionStore(path), value, () => epoch + 1000);
    expect(reopened.submit(next('b', 'a')).state).toBe('queued');
    expect(reopened.snapshot().records.a!.accounting!.usage!.quality).toBe('unknown');
    expect(reopened.snapshot().records.a!.accounting!.stopEvidence!.observerGeneration).toBe(1);
  });
});
