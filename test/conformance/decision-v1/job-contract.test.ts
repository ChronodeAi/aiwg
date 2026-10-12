import { describe, expect, it, vi } from 'vitest';
import { assertJobTransition, DecisionJobContractError, ITEM_STATES, validateDecisionJob, type DecisionJob, type ItemState } from '../../../src/decision/job-contract.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
function fixture(state: ItemState = 'queued'): DecisionJob {
  return { schemaVersion: 'decision-job/v1', id: 'jobA', scope: { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' },
    fingerprint: digest, state: 'queued', items: [{ id: 'itemA', fingerprint: digest, subjectDigest: digest,
      definitionDigest: digest, bindingDigest: digest, state, attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(name => [name, name === state ? 1 : 0])) as DecisionJob['summary'],
    createdAtEpochMs: 100, expiresAtEpochMs: 1000,
    budget: { maxAttempts: 3, maxTokens: 1000, maxCostMicros: 10000, maxConcurrency: 1 } };
}
describe('JOB offline contract (dispatch disabled)', () => {
  it('JOB-001 validates versioned identity, isolated scope, budgets and exact counts', () => {
    const job = fixture(); expect(() => validateDecisionJob(job)).not.toThrow();
    job.summary.queued = 0;
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
  });
  it('JOB-002 rejects duplicate item IDs and unexplained success', () => {
    const job = fixture(); job.items.push({ ...job.items[0]! }); job.summary.queued = 2;
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
    for (const state of ['succeeded', 'abstained', 'review'] as const) {
      const result = fixture(state);
      expect(() => validateDecisionJob(result)).toThrow(DecisionJobContractError);
    }
  });
  it('JOB-003 forbids state skipping and pin, fingerprint, scope and attempt-history mutation', () => {
    const before = fixture(); const after = fixture(); after.state = 'running'; after.items[0]!.state = 'running';
    after.summary.queued = 0; after.summary.running = 1;
    expect(() => assertJobTransition(before, after)).not.toThrow();
    after.items[0]!.definitionDigest = `sha256:${'b'.repeat(64)}`;
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
    after.items[0]!.definitionDigest = digest; after.scope.projectId = 'other';
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
    after.scope.projectId = 'p'; after.state = 'completed';
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
  });
  it('JOB-004 keeps terminal attempt history immutable', () => {
    const before = fixture('execution-unknown'); before.state = 'failed';
    before.items[0]!.attempts = [{ id: 'attemptA', requestDigest: digest, outcome: 'execution-unknown' }];
    const after = structuredClone(before); after.state = 'failed';
    after.items[0]!.attempts.push({ id: 'attemptB', requestDigest: digest, outcome: 'dispatched' });
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
  });
  it('JOB-004 does not report in-flight uncertainty as clean cancellation', () => {
    const job = fixture('execution-unknown'); job.state = 'canceled';
    job.items[0]!.attempts = [{ id: 'attemptA', requestDigest: digest, outcome: 'execution-unknown' }];
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
  });
  it('JOB-007 reconciles a mixed outcome without hiding terminal evidence', () => {
    const job = fixture(); job.state = 'failed';
    job.items = ITEM_STATES.filter(state => !['queued', 'running', 'retryable-failed'].includes(state)).map((state, index) => ({
      ...structuredClone(job.items[0]!), id: `item${index}`, state,
      attempts: state === 'execution-unknown' ? [{ id: 'ambiguous', requestDigest: digest, outcome: 'execution-unknown' }] :
        ['succeeded', 'abstained', 'review'].includes(state) ? [{ id: `attempt${index}`, requestDigest: digest, receiptDigest: digest, outcome: 'succeeded' as const }] : [],
      ...(['succeeded', 'abstained', 'review'].includes(state) ? { resultDigest: digest } : {}),
    }));
    job.summary = Object.fromEntries(ITEM_STATES.map(state => [state, job.items.filter(item => item.state === state).length])) as DecisionJob['summary'];
    expect(() => validateDecisionJob(job)).not.toThrow();
    job.summary['execution-unknown'] = 0;
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
  });
  it('JOB-006 prevents an unstarted item from fabricating dispatch attempts', () => {
    const before = fixture(); const after = fixture(); after.state = 'running'; after.items[0]!.state = 'running';
    after.summary.queued = 0; after.summary.running = 1;
    after.items[0]!.attempts.push({ id: 'first', requestDigest: digest, outcome: 'dispatched' },
      { id: 'forged', requestDigest: digest, outcome: 'dispatched' });
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
  });
  it('JOB-005 rejects unbounded, unexpected and model-authored fields', () => {
    const job = fixture(); job.budget.maxConcurrency = 0;
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
    const injected = { ...fixture(), providerAsyncEndpoint: 'execute-action' };
    expect(() => validateDecisionJob(injected)).toThrow(DecisionJobContractError);
  });

  // #3047: a valid job must not be denied admission because the host was
  // busy. `validateDecisionJob` calls `admitEntry`, whose internal time
  // budget (entry.ts) measures CPU time, not wall-clock elapsed time -- a
  // wall-clock budget would be tripped by scheduling contention (a busy
  // neighbor preempts this thread between visits) and surface here as the
  // generic 'job admission denied' (job-crash-boundaries.test.ts observed
  // this exact error on a fully valid restart-time job read, under load).
  // Simulating a wall clock that leaps far past the 1s budget on every read
  // reproduces that host-contention shape without needing real host load.
  it('JOB-008 does not deny admission to a valid job when the wall clock alone has leapt (host-load tolerant)', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    let fakeNow = 0;
    nowSpy.mockImplementation(() => { fakeNow += 10_000; return fakeNow; });
    try {
      const job = fixture();
      expect(() => validateDecisionJob(job)).not.toThrow();
      const before = fixture(); const after = fixture();
      after.state = 'running'; after.items[0]!.state = 'running';
      after.summary.queued = 0; after.summary.running = 1;
      expect(() => assertJobTransition(before, after)).not.toThrow();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
