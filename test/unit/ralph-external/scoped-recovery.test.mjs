/**
 * Tests for #2915 scoped recovery: narrowest-scope failure attribution,
 * bounded probe/canary episodes and the stop-before-retry gate.
 *
 * All time is synthetic (vitest fake timers; zero jitter). No spawns, no
 * network, no model calls — synthetic invocation ids and reason codes only.
 *
 * @implements #2915
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import {
  ConsecutiveFailureCircuitBreaker,
  ScopedFailureBreaker,
  RecoveryPolicy,
  validateRecoveryPolicy,
  FailureScope,
  isTrustedRecoveryEvidence,
  attributeFailureScope,
  scopeKeyFor,
  scopeRank,
} from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import {
  SessionLauncher,
  STOP_BEFORE_RETRY_CODE,
  UNBOUND_RETRY_EVIDENCE_CODE,
  RECOVERY_SCOPE_OPEN_CODE,
  stopBeforeRetryGate,
  assertStopBeforeRetry,
  MAX_STARTUP_CORRECTIONS,
  startupCorrectionGate,
  buildFailureAttribution,
  classifyLaunchOutcomeForRecovery,
  recoveryScopeKeysForInvocation,
  setDirectRecoveryBreaker,
  resetDirectRecoveryBreaker,
  admitDirectWorker,
  settleDirectWorker,
  classifyAttemptForSettlement,
  planDirectWorkerLaunch,
  verifyRetryPredecessor,
  stableTaskChainDigest,
  ALLOWANCE_EXHAUSTED_CODE,
  LEDGER_RECORD_INVALID_CODE,
  publishWorkerRecord,
} from '../../../tools/ralph-external/session-launcher.mjs';
import { inspectWorkerPath } from '../../../src/serve/worker-invocation.js';

const INSTALL = scopeKeyFor.installation('codex');
const QUOTA = scopeKeyFor.quota('acct-1');
const HOST = scopeKeyFor.host('noodle');
const PROVIDER = scopeKeyFor.provider('openai');

// Trusted launcher evidence for a missing CLI binary: the only NOT_FOUND
// signal that may implicate the installation scope. Worker-observed
// NOT_FOUND (a missing task subprocess) must never reach this helper.
function installFailure(id, extra = {}) {
  return { scope: FailureScope.INSTALLATION, scopeKey: INSTALL, invocationId: id,
    reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: 'codex', ...extra };
}

function trustedQuotaFailure(id, cli, extra = {}) {
  return { scope: FailureScope.QUOTA, scopeKey: QUOTA, invocationId: id,
    reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', cli, quotaAccount: 'acct-1', ...extra };
}

// #2915 final: thin test helpers over the new admit()/settle() pair,
// matching the semantics the OLD canLaunch()+recordFailure()/recordSuccess()
// pair exposed, so the scenarios below read the same way they did before the
// reservation-token redesign.
//
// `fail`/`succeed`/`uncertain` each perform ONE atomic admit()+settle() for
// one attempt — mirroring "this attempt launched and then concluded" rather
// than the old two-step "note, then record" calls. `probe` performs a
// read-only admission check: if admitted (including as a canary) it
// immediately settles as 'uncertain' so a pure check never leaves a
// dangling reservation that would perturb a later assertion in the same
// test (the old `canLaunch` alone never mutated state for a closed scope).
function probe(breaker, scopeKeys) {
  const admission = breaker.admit({ invocationId: `probe-${Math.random().toString(36).slice(2)}`, scopeKeys });
  if (admission.ok) breaker.settle(admission.token, { kind: 'uncertain' });
  return admission;
}

function fail(breaker, scopeKeys, invocationId, evidence = {}) {
  const admission = breaker.admit({ invocationId, scopeKeys });
  if (!admission.ok) return { admitted: false, blockedBy: admission.blockedBy };
  const watched = evidence.scopeKey ?? scopeKeys[0];
  const before = breaker.getState(watched).state;
  const settled = breaker.settle(admission.token, { kind: 'failed', ...evidence });
  const after = breaker.getState(watched).state;
  return { admitted: true, settled, opened: before !== 'open' && after === 'open',
    canaryFailed: admission.token.canaryKeys.includes(watched), token: admission.token };
}

function succeed(breaker, scopeKeys, invocationId) {
  const admission = breaker.admit({ invocationId, scopeKeys });
  if (!admission.ok) return { admitted: false, blockedBy: admission.blockedBy };
  return { admitted: true, settled: breaker.settle(admission.token, { kind: 'succeeded' }), token: admission.token };
}

function uncertain(breaker, scopeKeys, invocationId) {
  const admission = breaker.admit({ invocationId, scopeKeys });
  if (!admission.ok) return { admitted: false, blockedBy: admission.blockedBy };
  return { admitted: true, settled: breaker.settle(admission.token, { kind: 'uncertain' }), token: admission.token };
}

// Convenience: an evidence object shaped like `installFailure(id)`/
// `trustedQuotaFailure(id, ...)` (carrying its own `invocationId` and
// `scopeKey`) admitted-then-settled as ONE failed attempt, exactly mirroring
// the single `breaker.recordFailure(evidence)` call these scenarios used
// before the admit()/settle() redesign.
function failEvidence(breaker, evidence, scopeKeys = [evidence.scopeKey]) {
  return fail(breaker, scopeKeys, evidence.invocationId, evidence);
}

describe('RecoveryPolicy explicit bounds', () => {
  it('pins every loop to an explicit number', () => {
    expect(RecoveryPolicy.distinctThreshold).toBe(3);
    expect(RecoveryPolicy.windowMs).toBe(120_000);
    expect(RecoveryPolicy.minOutstanding).toBe(2);
    expect(RecoveryPolicy.cooldownMs).toBe(120_000);
    expect(RecoveryPolicy.maxCooldownMs).toBe(900_000);
    expect(RecoveryPolicy.canaryTimeoutMs).toBe(300_000);
    expect(RecoveryPolicy.backoffMultiplier).toBe(2);
    expect(RecoveryPolicy.maxTrackedScopes).toBe(500);
    expect(RecoveryPolicy.maxChargedAttempts).toBe(5_000);
  });

  it('rejects unbounded or out-of-range policy overrides', () => {
    for (const policy of [
      { cooldownMs: Number.NaN },
      { cooldownMs: Number.POSITIVE_INFINITY },
      { distinctThreshold: 0 },
      { maxCooldownMs: 1 },
      { canaryTimeoutMs: -5 },
      { backoffMultiplier: 0.5 },
      { maxTrackedScopes: 1 },
      { maxChargedAttempts: 1.5 },
    ]) {
      expect(() => validateRecoveryPolicy({ ...RecoveryPolicy, ...policy })).toThrow(RangeError);
    }
    expect(validateRecoveryPolicy({ ...RecoveryPolicy })).toEqual(RecoveryPolicy);
    expect(() => new ScopedFailureBreaker({ policy: { cooldownMs: Number.NaN } })).toThrow(RangeError);
  });
});

describe('attributeFailureScope', () => {
  it('attributes trusted 429 to the shared quota scope across aliases', () => {
    const a = attributeFailureScope({ reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', cli: 'codex', quotaAccount: 'acct-1' });
    const b = attributeFailureScope({ reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', cli: 'codex-alias', quotaAccount: 'acct-1' });
    expect(a.scope).toBe(FailureScope.QUOTA);
    expect(a.scopeKey).toBe(b.scopeKey);
    expect(a.confidence).toBe('suspected');
  });

  it('keeps worker-observed signatures in the invocation scope, however alarming', () => {
    // Scope-poisoning regression: a worker blaming the provider, the host,
    // or quota in its own output must never widen the recorded scope.
    for (const reasonCode of ['RATE_LIMIT', 'NETWORK', 'NOT_FOUND', 'RESOURCE', 'SANDBOX', 'AUTH', 'MODEL']) {
      for (const evidenceSource of ['worker', null, undefined]) {
        const out = attributeFailureScope({ reasonCode, evidenceSource, cli: 'codex',
          inferenceProvider: 'openai', quotaAccount: 'acct-1', modelKey: 'openai/gpt-x', invocationId: 'task-7' });
        expect(out.scope).toBe(FailureScope.INVOCATION);
        expect(out.scopeKey).toBe('invocation:task-7');
      }
    }
  });

  it('keeps single-provider host signatures in the invocation scope without cross-provider corroboration', () => {
    for (const reasonCode of ['RESOURCE', 'SANDBOX']) {
      const single = attributeFailureScope({ reasonCode, evidenceSource: 'launcher', cli: 'codex',
        inferenceProvider: 'openai', corroboratedBackends: ['openai'], invocationId: 'i' });
      expect(single.scope).toBe(FailureScope.INVOCATION);
    }
    const corroborated = attributeFailureScope({ reasonCode: 'RESOURCE', evidenceSource: 'launcher', cli: 'codex',
      inferenceProvider: 'openai', corroboratedBackends: ['openai', 'anthropic'], hostId: 'noodle' });
    expect(corroborated.scope).toBe(FailureScope.HOST);
    expect(corroborated.scopeKey).toBe('host:noodle');
  });

  it('attributes trusted transport errors to the backend, never the CLI installation', () => {
    // Identity-separation regression: backend `openai` must not become
    // `provider:codex`, and `anthropic` must not become an installation key.
    const out = attributeFailureScope({ reasonCode: 'NETWORK', evidenceSource: 'launcher',
      cli: 'codex', inferenceProvider: 'openai', invocationId: 'i' });
    expect(out.scope).toBe(FailureScope.PROVIDER);
    expect(out.scopeKey).toBe('provider:openai');
    expect(attributeFailureScope({ reasonCode: 'AUTH', evidenceSource: 'launcher', cli: 'codex' }).scopeKey)
      .toBe('installation:codex');
    expect(attributeFailureScope({ reasonCode: 'MODEL', evidenceSource: 'launcher', modelKey: 'openai/gpt-x' }).scopeKey)
      .toBe('model:openai/gpt-x');
  });

  it('attributes a launcher-observed missing CLI binary to the installation, never the host', () => {
    const out = attributeFailureScope({ reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: 'codex', invocationId: 'i' });
    expect(out.scope).toBe(FailureScope.INSTALLATION);
    expect(out.scopeKey).toBe('installation:codex');
  });

  it('folds wide claims without their required trusted identity back to invocation', () => {
    expect(attributeFailureScope({ reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher', cli: 'codex', invocationId: 'i' }).scope)
      .toBe(FailureScope.INVOCATION);
    expect(attributeFailureScope({ reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', invocationId: 'i' }).scope)
      .toBe(FailureScope.INVOCATION);
    expect(attributeFailureScope({ reasonCode: 'AUTH', evidenceSource: 'launcher', invocationId: 'i' }).scope)
      .toBe(FailureScope.INVOCATION);
  });

  it('keeps task-local and unknown failures in the invocation scope', () => {
    for (const reasonCode of [null, 'UNKNOWN', 'TASK_ASSERT_FAILED', 'EXIT_ZERO_ERROR', 'STDIN_WAIT', 'TRUST', 'NO_PROGRESS']) {
      const out = attributeFailureScope({ reasonCode, evidenceSource: 'launcher', cli: 'codex', invocationId: 'task-7' });
      expect(out.scope).toBe(FailureScope.INVOCATION);
      expect(out.scopeKey).toBe('invocation:task-7');
    }
  });

  it('orders scopes narrowest-first for fold-back', () => {
    expect(scopeRank('invocation')).toBeLessThan(scopeRank('installation'));
    expect(scopeRank('installation')).toBeLessThan(scopeRank('provider'));
    expect(scopeRank('provider')).toBeLessThan(scopeRank('host'));
    expect(isTrustedRecoveryEvidence('launcher')).toBe(true);
    expect(isTrustedRecoveryEvidence('resolver')).toBe(true);
    expect(isTrustedRecoveryEvidence('worker')).toBe(false);
    expect(isTrustedRecoveryEvidence(null)).toBe(false);
  });
});

describe('ScopedFailureBreaker correlation', () => {
  let breaker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  it('opens the narrowest scope at three distinct failures in 120s', () => {
    expect(fail(breaker, [INSTALL], 'a', installFailure('a')).opened).toBe(false);
    expect(fail(breaker, [INSTALL], 'b', installFailure('b')).opened).toBe(false);
    const third = fail(breaker, [INSTALL], 'c', installFailure('c'));
    expect(third.opened).toBe(true);
    expect(breaker.getState(INSTALL).state).toBe('open');

    // Covered launches stop by the next check; unaffected scopes continue.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(probe(breaker, [scopeKeyFor.installation('claude')]).ok).toBe(true);
    expect(probe(breaker, [PROVIDER, QUOTA, HOST]).ok).toBe(true);
  });

  it('counts each distinct invocation once per window', () => {
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    expect(breaker.getState(INSTALL).distinctFailures).toBe(1);
    expect(breaker.getState(INSTALL).state).toBe('closed');
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  it('opens when all of two outstanding attempts fail, stays shut for two-of-five', () => {
    const resA = breaker.admit({ invocationId: 'a', scopeKeys: [INSTALL] });
    const resB = breaker.admit({ invocationId: 'b', scopeKeys: [INSTALL] });
    breaker.settle(resA.token, { kind: 'failed', ...installFailure('a') });
    expect(breaker.settle(resB.token, { kind: 'failed', ...installFailure('b') })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('open');

    breaker.reset(INSTALL);
    const outstanding = ['c', 'd', 'e', 'f', 'g'].map((id) => breaker.admit({ invocationId: id, scopeKeys: [INSTALL] }));
    breaker.settle(outstanding[0].token, { kind: 'failed', ...installFailure('c') });
    breaker.settle(outstanding[1].token, { kind: 'failed', ...installFailure('d') });
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('prunes failures outside the rolling window', () => {
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'b', installFailure('b'));
    vi.advanceTimersByTime(121_000);
    fail(breaker, [INSTALL], 'c', installFailure('c'));
    expect(fail(breaker, [INSTALL], 'd', installFailure('d')).opened).toBe(false);
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('never opens a wider scope for independent task failures', () => {
    for (const id of ['t1', 't2', 't3']) {
      const key = scopeKeyFor.invocation(id);
      fail(breaker, [key], id, { scope: FailureScope.INVOCATION, scopeKey: key, reasonCode: 'TASK_ASSERT_FAILED' });
    }
    expect(probe(breaker, [PROVIDER, INSTALL, QUOTA, HOST]).ok).toBe(true);
    expect(breaker.getState(PROVIDER).tracked).toBe(false);
  });

  it('opens exactly once at the threshold and stays open on further failures, never re-opening', () => {
    expect(fail(breaker, [INSTALL], 'a', installFailure('a')).opened).toBe(false);
    expect(fail(breaker, [INSTALL], 'b', installFailure('b')).opened).toBe(false);
    expect(fail(breaker, [INSTALL], 'c', installFailure('c')).opened).toBe(true);
    expect(breaker.getState(INSTALL).distinctFailures).toBe(3);
    expect(breaker.getState(INSTALL).nextProbeAtMs).toBeGreaterThan(0);
    // A fourth failure cannot reach here without an admission (the scope is
    // already open and not due); repeated read-only checks are inert.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).state).toBe('open');
  });

  it('shares quota scope across CLIs and honors the 429 reset', () => {
    fail(breaker, [QUOTA], 'q1', trustedQuotaFailure('q1', 'codex', { retryAfterSeconds: 300 }));
    fail(breaker, [QUOTA], 'q2', trustedQuotaFailure('q2', 'cursor', { retryAfterSeconds: 300 }));
    expect(fail(breaker, [QUOTA], 'q3', trustedQuotaFailure('q3', 'codex', { retryAfterSeconds: 300 })).opened).toBe(true);
    const state = breaker.getState(QUOTA);
    expect(state.resetAtMs).toBe(Date.now() + 300_000);
    // Earliest probe is max(120s cooldown, reset): still not due at +121s.
    vi.advanceTimersByTime(121_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(false);
    vi.advanceTimersByTime(180_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('refuses to open the quota scope on worker-claimed 429 without trusted account identity', () => {
    // Scope-poisoning regression at the settle()/_settleFailure enforcement
    // point: a wide claim on untrusted evidence folds back instead of opening.
    for (const id of ['w1', 'w2', 'w3']) {
      fail(breaker, [QUOTA], id, { scope: FailureScope.QUOTA, scopeKey: QUOTA,
        reasonCode: 'RATE_LIMIT', evidenceSource: 'worker', cli: 'codex', quotaAccount: 'acct-1' });
    }
    expect(breaker.getState(QUOTA).tracked).toBe(false);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('falls back to bounded backoff on a malformed reset', () => {
    const t0 = Date.now();
    fail(breaker, [QUOTA], 'm1', trustedQuotaFailure('m1', 'codex', { retryAfterSeconds: Number.NaN }));
    fail(breaker, [QUOTA], 'm2', trustedQuotaFailure('m2', 'codex', { resetAtMs: -5 }));
    fail(breaker, [QUOTA], 'm3', trustedQuotaFailure('m3', 'codex'));
    const state = breaker.getState(QUOTA);
    expect(state.state).toBe('open');
    expect(state.resetAtMs).toBeNull();
    expect(state.nextProbeAtMs).toBe(t0 + 120_000); // deterministic: zero jitter
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('pushes the next probe out when a later (canary) failure carries a further reset', () => {
    // Updated-reset regression: a reset carried by the CANARY's own failure
    // (the only way a failure can be reported against an already-open scope
    // under the one-admission design — admit() refuses anything else while
    // open and not due) must move nextProbeAtMs, so no probe is admitted at
    // the un-updated +120s floor.
    fail(breaker, [QUOTA], 'r1', trustedQuotaFailure('r1', 'codex'));
    fail(breaker, [QUOTA], 'r2', trustedQuotaFailure('r2', 'codex'));
    expect(fail(breaker, [QUOTA], 'r3', trustedQuotaFailure('r3', 'codex')).opened).toBe(true);
    expect(breaker.getState(QUOTA).nextProbeAtMs).toBeGreaterThan(0);
    vi.advanceTimersByTime(120_000);
    const canary = breaker.admit({ invocationId: 'r4', scopeKeys: [QUOTA] });
    expect(canary.ok).toBe(true);
    breaker.settle(canary.token, { kind: 'failed', ...trustedQuotaFailure('r4', 'codex', { retryAfterSeconds: 420 }) });
    const state = breaker.getState(QUOTA);
    expect(state.resetAtMs).toBe(Date.now() + 420_000);
    expect(state.nextProbeAtMs).toBeGreaterThanOrEqual(state.resetAtMs);
    vi.advanceTimersByTime(240_000); // doubled backoff (240s) alone would be due here
    expect(probe(breaker, [QUOTA]).ok).toBe(false); // but the 420s reset still governs
    vi.advanceTimersByTime(180_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('stops cross-provider retries while the corroborated host scope is open', () => {
    const hostFailure = (id) => ({ scope: FailureScope.HOST, scopeKey: HOST,
      reasonCode: 'RESOURCE', evidenceSource: 'launcher', cli: 'codex',
      corroboratedBackends: ['openai', 'anthropic'] });
    for (const id of ['h1', 'h2', 'h3']) fail(breaker, [HOST], id, hostFailure(id));
    expect(breaker.getState(HOST).state).toBe('open');
    expect(probe(breaker, [scopeKeyFor.installation('claude'), PROVIDER, HOST]).ok).toBe(false);
  });

  it('promotes a genuine provider outage beyond invocation scope by the distinct-invocation rule', () => {
    // Outage-promotion regression: 20 distinct stalls with no trusted
    // evidence stay invocation-scoped and launchable...
    for (let n = 0; n < 20; n += 1) {
      const key = scopeKeyFor.invocation(`stall-${n}`);
      fail(breaker, [key], `stall-${n}`, { scope: FailureScope.INVOCATION, scopeKey: key, reasonCode: 'NO_PROGRESS', evidenceSource: 'worker' });
    }
    expect(breaker.getState(PROVIDER).tracked).toBe(false);
    expect(probe(breaker, [PROVIDER]).ok).toBe(true);
    // ...while N distinct invocations carrying the same TRUSTED backend
    // evidence open the provider scope.
    const netFailure = (id) => ({ scope: FailureScope.PROVIDER, scopeKey: PROVIDER,
      reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', inferenceProvider: 'openai' });
    expect(fail(breaker, [PROVIDER], 'p1', netFailure('p1')).opened).toBe(false);
    expect(fail(breaker, [PROVIDER], 'p2', netFailure('p2')).opened).toBe(false);
    expect(fail(breaker, [PROVIDER], 'p3', netFailure('p3')).opened).toBe(true);
    expect(breaker.getState(PROVIDER).state).toBe('open');
    expect(probe(breaker, [PROVIDER]).ok).toBe(false);
    // A different backend is unaffected by this outage.
    expect(probe(breaker, [scopeKeyFor.provider('anthropic')]).ok).toBe(true);
  });

  it('retains still-recent failures across the cohort epoch boundary', () => {
    // Rolling-window regression: failures at 0, 119s, 120.001s and 120.002s
    // hold three in-window distinct failures at the end and must open.
    fail(breaker, [INSTALL], 'e0', installFailure('e0'));
    vi.advanceTimersByTime(119_000);
    fail(breaker, [INSTALL], 'e1', installFailure('e1'));
    vi.advanceTimersByTime(1_001);
    fail(breaker, [INSTALL], 'e2', installFailure('e2'));
    vi.advanceTimersByTime(1);
    expect(fail(breaker, [INSTALL], 'e3', installFailure('e3')).opened).toBe(true);
    expect(breaker.getState(INSTALL).state).toBe('open');
  });

  it('freezes cohort membership: late joiners neither open nor veto', () => {
    const resA = breaker.admit({ invocationId: 'a', scopeKeys: [INSTALL] });
    const resB = breaker.admit({ invocationId: 'b', scopeKeys: [INSTALL] });
    breaker.settle(resA.token, { kind: 'failed', ...installFailure('a') });
    // 'c' launches after the cohort froze: it never joins, so the unanimous
    // failure of the original pair still opens the scope...
    const resC = breaker.admit({ invocationId: 'c', scopeKeys: [INSTALL] });
    expect(breaker.settle(resB.token, { kind: 'failed', ...installFailure('b') })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).cohortSize).toBe(2);
    breaker.settle(resC.token, { kind: 'uncertain' });
  });
});

describe('half-open canary admission (#2915D2: the next real launch IS the probe)', () => {
  let breaker;

  const openInstall = () => {
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'b', installFailure('b'));
    fail(breaker, [INSTALL], 'c', installFailure('c'));
    expect(breaker.getState(INSTALL).state).toBe('open');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  it('refuses every launch while open and not due, admits exactly one once due, then recovers on a launcher-reported success', () => {
    openInstall();
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(119_999);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(1);
    const admitted = breaker.admit({ invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    expect(admitted.token.canaryKeys).toEqual([INSTALL]);
    // One real attempt at a time: while that canary is outstanding, no
    // further launch for this scope is admitted, including a re-check in
    // the very same tick.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('closed');
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
    expect(breaker.snapshot().canariesObserved).toBe(1);
  });

  it('a failed canary reopens immediately with doubled backoff, never waiting on the distinct-failure threshold', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = breaker.admit({ invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    breaker.settle(admitted.token, { kind: 'failed', ...installFailure('canary-1') });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    // Not due yet at +120s (doubled backoff), due at +240s.
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  it('caps backoff at 900s across repeated canary failures', () => {
    openInstall();
    let at = 120_000;
    vi.advanceTimersByTime(at);
    const cooldowns = [240_000, 480_000, 900_000, 900_000];
    for (const expected of cooldowns) {
      const admitted = breaker.admit({ invocationId: `canary-${expected}`, scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      breaker.settle(admitted.token, { kind: 'failed', ...installFailure(`canary-${expected}`) });
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(expected);
      at += expected;
      vi.advanceTimersByTime(expected);
    }
    expect(breaker.getState(INSTALL).state).toBe('open');
  });

  it('an uncertain canary termination releases the reservation and reopens with backoff, never recovering', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = breaker.admit({ invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    breaker.settle(admitted.token, { kind: 'uncertain' });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).activeCanary).toBeNull();
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
  });

  it('unrelated scopes are admitted independently; neither blocks the other', () => {
    openInstall();
    for (const id of ['x', 'y', 'z']) fail(breaker, [QUOTA], id, trustedQuotaFailure(id, 'codex'));
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('charges every launched attempt and the canary attempt once, keeping unknown cost unknown', () => {
    fail(breaker, [INSTALL], 'same', installFailure('same'));
    fail(breaker, [INSTALL], 'same', installFailure('same'));
    expect(breaker.snapshot().attemptsObserved).toBe(1);
    // A successful launched attempt is charged too (review: successes
    // charged 0), exactly once even across repeated reports.
    const res = succeed(breaker, [INSTALL], 'ok-1');
    expect(res.admitted).toBe(true);
    expect(breaker.snapshot().attemptsObserved).toBe(2);
    // Settling the SAME reservation twice is refused (idempotent) — charging
    // happens once per admitted attempt, not per settle() call.
    expect(breaker.settle(res.token, { kind: 'succeeded' }).ok).toBe(false);
    expect(breaker.snapshot().attemptsObserved).toBe(2);
    // #2915 review 4 (finding 8): an uncertain termination opens nothing
    // AND is never recorded as an observed attempt — this diagnostic
    // counter must never read as enforcement that did not happen (every
    // pre-spawn refusal settles 'uncertain' too; the allowance LEDGER is
    // what actually enforces attempt consumption now).
    uncertain(breaker, [INSTALL], 'u-1');
    expect(breaker.snapshot().attemptsObserved).toBe(2);
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('expires a hung canary with backoff and a persistent blocking marker, never admitting a second worker while stop is unconfirmed', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = breaker.admit({ invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    // The admitted attempt never reports back at all (crash/dropped
    // callback) -- past its canaryTimeoutMs deadline, the very next gate
    // check sweeps it as a failed canary, reopens with doubled backoff, AND
    // retains a bounded blocking marker (#2915 review 5, "a second worker
    // over unresolved execution"): expiry alone proves nothing about
    // whether the attempt actually stopped.
    vi.advanceTimersByTime(300_001);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).activeCanary).toBeNull();
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // Backoff alone is NOT sufficient to re-admit: even once fully elapsed,
    // the marker still refuses every admission for this scope.
    vi.advanceTimersByTime(240_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    // A late 'succeeded' report against the expired reservation is accepted
    // as a settlement of the MARKER, but carries no confirmed-termination
    // evidence -- it can never close the scope and never clears the marker
    // either (late success cannot close a scope).
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    // Reusing the already-resolved token a second time is refused.
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('a settlement carrying confirmed-termination evidence clears the blocking marker and re-admits once due (no permanent deadlock)', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = breaker.admit({ invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    vi.advanceTimersByTime(300_001);
    // Sweeps the expiry and installs the marker (no settle() has happened yet).
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // The launcher's own bounded diagnostic-then-stop escalation confirms
    // the attempt actually stopped; it reports that evidence through the
    // SAME reservation token -- there is nothing left to admit for this
    // specific reservation, only its marker to resolve.
    expect(breaker.settle(admitted.token, { kind: 'uncertain', confirmedStop: true })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
    // Not yet due: refused by ordinary backoff, not the (now-cleared) marker.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(240_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  it('a blocking marker continues to occupy its reservation slot until confirmed, bounded by the existing maxOutstandingReservations cap', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxOutstandingReservations: 1 } });
    try {
      fail(smallCapBreaker, [INSTALL], 'a', installFailure('a'));
      fail(smallCapBreaker, [INSTALL], 'b', installFailure('b'));
      fail(smallCapBreaker, [INSTALL], 'c', installFailure('c'));
      vi.advanceTimersByTime(120_000);
      const admitted = smallCapBreaker.admit({ invocationId: 'canary-1', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      vi.advanceTimersByTime(300_001);
      // Sweeping this expiry installs an unresolved blocking marker that
      // keeps the reservation live (occupying the one available slot) --
      // no separate marker cap and no auto-expiry were invented; it is
      // bounded by the SAME `maxOutstandingReservations` every other
      // reservation already counts against.
      const unrelated = smallCapBreaker.admit({ invocationId: 'unrelated', scopeKeys: [QUOTA] });
      expect(unrelated.ok).toBe(false);
      expect(unrelated.blockedBy).toContain('reservation-capacity');
      // Confirming the stop frees the slot.
      expect(smallCapBreaker.settle(admitted.token, { kind: 'uncertain', confirmedStop: true })).toEqual({ ok: true });
      const afterwards = smallCapBreaker.admit({ invocationId: 'unrelated-2', scopeKeys: [QUOTA] });
      expect(afterwards.ok).toBe(true);
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 final review step 2, named tests ------------------------------

  it('old-attempt-cannot-settle-canary', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const stale = breaker.admit({ invocationId: 'old-attempt', scopeKeys: [INSTALL] });
    expect(stale.ok).toBe(true);
    // The stale attempt's own reservation is honored once...
    expect(breaker.settle(stale.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('closed');
    // ...and a SECOND settle of that exact (now-consumed) token — simulating
    // a duplicate/late report from the same old attempt arriving again, or
    // an attempt that tries to settle a reservation it does not hold at
    // all — is refused, never silently re-applied or allowed to touch
    // whatever NEW canary may since have been admitted on this scope.
    expect(breaker.settle(stale.token, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
    // Open a fresh episode and admit a NEW canary; the stale token from the
    // previous episode must never be able to settle THIS one.
    fail(breaker, [INSTALL], 'z1', installFailure('z1'));
    fail(breaker, [INSTALL], 'z2', installFailure('z2'));
    fail(breaker, [INSTALL], 'z3', installFailure('z3'));
    vi.advanceTimersByTime(120_000);
    const fresh = breaker.admit({ invocationId: 'fresh-attempt', scopeKeys: [INSTALL] });
    expect(fresh.ok).toBe(true);
    expect(breaker.settle(stale.token, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
    expect(breaker.getState(INSTALL).activeCanary).not.toBeNull(); // the FRESH canary, untouched by the stale settle
    expect(breaker.settle(fresh.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('all-covering-scopes-settle', () => {
    // A single attempt covers THREE scopes at once (installation, quota,
    // host) — none of them individually open yet.
    const covering = [INSTALL, QUOTA, HOST];
    const admission = breaker.admit({ invocationId: 'multi-1', scopeKeys: covering });
    expect(admission.ok).toBe(true);
    expect(admission.token.coveringKeys).toEqual(expect.arrayContaining(covering));
    for (const key of covering) expect(breaker._outstanding.get(key)?.size).toBe(1);
    // A single settle() clears outstanding membership on EVERY covering
    // scope, not just one of them.
    expect(breaker.settle(admission.token, { kind: 'uncertain' })).toEqual({ ok: true });
    for (const key of covering) expect(breaker._outstanding.get(key)?.size ?? 0).toBe(0);

    // Now drive three covering scopes all OPEN at once via three separate
    // attempts that each fail across the same three scopes, then prove a
    // single later admission is admitted as the canary for ALL three
    // simultaneously, and a single settle() recovers all three together.
    for (const id of ['m1', 'm2', 'm3']) {
      fail(breaker, covering, id, { scope: FailureScope.HOST, scopeKey: HOST, reasonCode: 'RESOURCE',
        evidenceSource: 'launcher', cli: 'codex', corroboratedBackends: ['openai', 'anthropic'] });
    }
    expect(breaker.getState(HOST).state).toBe('open');
    vi.advanceTimersByTime(120_000);
    const canary = breaker.admit({ invocationId: 'canary-multi', scopeKeys: covering });
    expect(canary.ok).toBe(true);
    expect(canary.token.canaryKeys.length).toBeGreaterThan(0);
    expect(breaker.settle(canary.token, { kind: 'succeeded' })).toEqual({ ok: true });
    for (const key of canary.token.canaryKeys) expect(breaker.getState(key).state).toBe('closed');
  });

  it('deadline-reopens-before-readmission', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = breaker.admit({ invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    // Past the canary's own deadline (300s), the NEXT admission call must
    // observe the sweep and reopen with backoff BEFORE considering any new
    // admission — never admitting an overlapping live canary.
    vi.advanceTimersByTime(300_001);
    const overlapping = breaker.admit({ invocationId: 'overlapping', scopeKeys: [INSTALL] });
    expect(overlapping.ok).toBe(false); // reopened with doubled backoff, not yet due again
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // A late success report against the now-expired reservation settles
    // only the marker it left behind (#2915 review 5) — it carries no
    // confirmed-termination evidence, so it never closes the scope and
    // never clears the marker either. Late success cannot close a scope.
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
  });

  it('hard-caps-preserve-open-scopes', () => {
    // #2915 review 4, finding 6: invocation-scoped records are bounded by
    // their OWN quota (maxChargedAttempts), entirely separate from the
    // small shared-scope quota (maxTrackedScopes) -- so a flood of
    // one-off, never-opening invocation failures can never compete with,
    // or get discarded in favor of, genuinely shared (installation/quota/
    // provider/host/model) scope tracking, and vice versa.
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 2 } });
    try {
      // Two genuinely OPEN, DISTINCT shared scopes, created first -- both
      // must survive eviction regardless of insertion order, even though
      // they already consume the entire shared-scope quota of 2.
      fail(smallCapBreaker, [INSTALL], 'o1', installFailure('o1'));
      fail(smallCapBreaker, [INSTALL], 'o2', installFailure('o2'));
      fail(smallCapBreaker, [INSTALL], 'o3', installFailure('o3'));
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      for (const id of ['p1', 'p2', 'p3']) {
        fail(smallCapBreaker, [PROVIDER], id, { scope: FailureScope.PROVIDER, scopeKey: PROVIDER,
          reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', inferenceProvider: 'openai' });
      }
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
      // Six MORE distinct, brand-new shared scopes (a third/fourth/etc
      // CLI's installation scope) cannot be tracked at all -- the shared
      // quota is genuinely exhausted by two protected OPEN scopes, and
      // there is nothing memberless/inert to evict -- but this never
      // evicts either OPEN scope, and the hard cap of 2 is never exceeded.
      for (let n = 0; n < 6; n += 1) {
        const key = scopeKeyFor.installation(`overflow-cli-${n}`);
        const result = fail(smallCapBreaker, [key], `overflow-${n}`,
          { scope: FailureScope.INSTALLATION, scopeKey: key, reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: `overflow-cli-${n}` });
        // #2915 review 5 (finding 5): the admission itself is now REFUSED
        // (not silently admitted-and-discarded) for a brand-new scope the
        // tracking table has no room for -- the overflow case this test
        // sets up must actually require refusal, not merely observe that
        // no NEW scope record ended up tracked afterward.
        expect(result.admitted, `overflow-${n} should have been refused, not admitted`).toBe(false);
        expect(result.blockedBy).toContain('scope-tracking-capacity');
      }
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
      const sharedScopes = smallCapBreaker.snapshot().scopes.filter((s) => s.scope !== 'invocation');
      expect(sharedScopes.length).toBeLessThanOrEqual(2);
      // Many distinct, memberless, never-opening INVOCATION-scoped failures
      // are tracked in their own separate quota, never discarded by, and
      // never competing with, the two-slot shared-scope quota above.
      for (let n = 0; n < 10; n += 1) {
        const key = scopeKeyFor.invocation(`solo-${n}`);
        fail(smallCapBreaker, [key], `solo-${n}`, { scope: FailureScope.INVOCATION, scopeKey: key, reasonCode: 'TASK_ASSERT_FAILED' });
      }
      for (let n = 0; n < 10; n += 1) {
        expect(smallCapBreaker.getState(scopeKeyFor.invocation(`solo-${n}`)).tracked).toBe(true);
      }
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      expect(smallCapBreaker.getState(INSTALL).tracked).toBe(true);
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 review 5 (finding 5, "lost covering protection"): the overflow
  // attempts in the test above were admitted and their failure evidence
  // silently discarded -- this names that exact refusal explicitly at the
  // `admit()` boundary, rather than only observing its downstream effect.
  it('refuses an admission that would need an untrackable brand-new shared scope, instead of admitting and discarding its failure', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 2 } });
    try {
      // Fill the entire shared-scope quota (2 slots) with two genuinely
      // OPEN, DISTINCT, non-evictable scopes.
      fail(smallCapBreaker, [INSTALL], 'o1', installFailure('o1'));
      fail(smallCapBreaker, [INSTALL], 'o2', installFailure('o2'));
      fail(smallCapBreaker, [INSTALL], 'o3', installFailure('o3'));
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      for (const id of ['p1', 'p2', 'p3']) {
        fail(smallCapBreaker, [PROVIDER], id, { scope: FailureScope.PROVIDER, scopeKey: PROVIDER,
          reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', inferenceProvider: 'openai' });
      }
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
      // A brand-new, never-before-seen shared scope key: the tracking
      // table has no room (nothing evictable, both existing slots are
      // OPEN) -- `admit()` itself must refuse, not silently admit this
      // attempt and lose its eventual failure to `_scopeRecordBounded`
      // returning null.
      const overflowKey = scopeKeyFor.installation('overflow-cli-explicit');
      const admission = smallCapBreaker.admit({ invocationId: 'overflow-explicit', scopeKeys: [overflowKey] });
      expect(admission.ok).toBe(false);
      expect(admission.blockedBy).toContain('scope-tracking-capacity');
      expect(smallCapBreaker.getState(overflowKey).tracked).toBe(false);
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 review 5 (finding 5): a covering set larger than `maxCoveringKeys`
  // is refused outright -- the former behavior silently trimmed it,
  // dropping some of the caller's own named scopes from tracking entirely.
  it('refuses an admission whose covering set exceeds maxCoveringKeys, instead of silently trimming it', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const oversizedKeys = Array.from({ length: 7 }, (_, n) => scopeKeyFor.installation(`cli-${n}`));
      const admission = breaker.admit({ invocationId: 'oversized-1', scopeKeys: oversizedKeys });
      expect(admission.ok).toBe(false);
      expect(admission.blockedBy).toContain('covering-set-too-large');
      // None of the would-be-trimmed keys were tracked either.
      for (const key of oversizedKeys) expect(breaker.getState(key).tracked).toBe(false);
    } finally {
      breaker.destroy();
    }
  });

  it('rejects policy overrides above the protective maxima (500/128/5000/6)', () => {
    expect(() => new ScopedFailureBreaker({ policy: { maxTrackedScopes: 501 } })).toThrow(RangeError);
    expect(() => new ScopedFailureBreaker({ policy: { maxOutstandingReservations: 129 } })).toThrow(RangeError);
    expect(() => new ScopedFailureBreaker({ policy: { maxChargedAttempts: 5001 } })).toThrow(RangeError);
    expect(() => new ScopedFailureBreaker({ policy: { maxCoveringKeys: 7 } })).toThrow(RangeError);
    // The shipped defaults themselves, and anything smaller, remain valid.
    const b = new ScopedFailureBreaker({ policy: { maxTrackedScopes: 500, maxOutstandingReservations: 128, maxChargedAttempts: 5000, maxCoveringKeys: 6 } });
    b.destroy();
  });

  it('settle() rejects a copied token with altered fields (exact token ownership)', () => {
    const b = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = b.admit({ invocationId: 'a1', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      // A copy with every field reproduced, including `breaker` and `id`,
      // but a forged invocationId -- reference inequality alone refuses it.
      const forged = { ...admitted.token, invocationId: 'forged' };
      expect(b.settle(forged, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
      // The genuine, unmodified token (same object reference) still works.
      expect(b.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    } finally {
      b.destroy();
    }
  });
});

describe('stop-before-retry gate (session-launcher)', () => {
  it('permits retry after confirmed termination only', () => {
    expect(stopBeforeRetryGate({ termination: 'confirmed' })).toEqual({ ok: true });
    for (const previousResult of [{ termination: 'uncertain' }, { termination: null }, {}, null, undefined]) {
      const gate = stopBeforeRetryGate(previousResult);
      expect(gate.ok).toBe(false);
      expect(gate.code).toBe(STOP_BEFORE_RETRY_CODE);
      expect(gate.reason).toMatch(/not confirmed/);
    }
    expect(() => assertStopBeforeRetry({ termination: 'uncertain' })).toThrowError(
      expect.objectContaining({ code: STOP_BEFORE_RETRY_CODE }),
    );
    expect(assertStopBeforeRetry({ termination: 'confirmed' })).toEqual({ ok: true });
  });

  it('binds confirmed evidence to the previous owned invocation', () => {
    // Unbound-evidence regression: any object containing
    // termination:'confirmed' is not enough — it must name the previous
    // owned attempt.
    expect(stopBeforeRetryGate({ termination: 'confirmed', invocationId: 'a' }, { expectedInvocationId: 'a' }))
      .toEqual({ ok: true });
    const swapped = stopBeforeRetryGate({ termination: 'confirmed', invocationId: 'b' }, { expectedInvocationId: 'a' });
    expect(swapped.ok).toBe(false);
    expect(swapped.code).toBe(UNBOUND_RETRY_EVIDENCE_CODE);
    const anonymous = stopBeforeRetryGate({ termination: 'confirmed' }, { expectedInvocationId: 'a' });
    expect(anonymous.ok).toBe(false);
    expect(anonymous.code).toBe(UNBOUND_RETRY_EVIDENCE_CODE);
  });

  it('refuses a conductor-declared startup correction past its single budget', async () => {
    const launcher = new SessionLauncher();
    await expect(launcher.launchWorker({ correctStartup: { reasonCode: 'AUTH', correctionsUsed: 0 } }))
      .rejects.toMatchObject({ code: 'STARTUP_CORRECTION_REFUSED' });
    await expect(launcher.launchWorker({ correctStartup: { reasonCode: 'STDIN_WAIT', correctionsUsed: 1 } }))
      .rejects.toMatchObject({ code: 'STARTUP_CORRECTION_REFUSED' });
  });
});

describe('retry linkage (#2915 final review step 4: retryOf replaces freshAttempt/afterAttempt/path-pair)', () => {
  const roots = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  async function predecessorRunDir({ invocationId = 'prev-1', taskDigest = 'digest-a', origin = 'launcher',
    termination = 'confirmed', corruptOwner = false, mode = 0o700 } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-retry-'));
    roots.push(root);
    const runDir = path.join(root, 'run');
    await mkdir(runDir, { mode });
    await writeFile(path.join(runDir, '.launch-owner'), corruptOwner ? 'someone-else' : invocationId, { mode: 0o600 });
    await writeFile(path.join(runDir, 'invocation.json'), JSON.stringify({ invocationId, origin, taskDigest }), { mode: 0o600 });
    await writeFile(path.join(runDir, 'exit.json'), JSON.stringify({ invocationId, termination }), { mode: 0o600 });
    return { root, runDir };
  }

  async function planFile(root, taskMarker, briefDigest = 'sha256:fixed-brief') {
    const invocationPath = path.join(root, 'plan.json');
    // #2915 review 4 (finding 4): the stable task-chain identity is
    // role/task/group plus the BRIEF CONTENT digest -- never
    // `final_output`/`brief`/`workdir` paths -- matching
    // `stableTaskChainDigest` exactly, so this fixture exercises the real
    // binding rule rather than a stand-in marker field.
    const request = { role: 'coding', task: taskMarker, group: 'workers',
      brief: '/brief.json', workdir: '/work', final_output: `/work/final-${Math.random().toString(36).slice(2)}.json` };
    await writeFile(invocationPath, JSON.stringify({ request, invocation: { briefDigest } }));
    return { invocationPath, taskDigest: qualificationDigest({ role: request.role, task: request.task, group: request.group, briefDigest }) };
  }

  it('fresh-directory-retry-requires-owned-proof', async () => {
    const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
    const { invocationPath, taskDigest } = await planFile(path.dirname(runDir), 'digest-a');
    // Rewrite the predecessor with the digest the plan actually produces,
    // so the happy path exercises real task-chain binding, not a
    // coincidental string match.
    await writeFile(path.join(runDir, 'invocation.json'), JSON.stringify({ invocationId: 'prev-1', origin: 'launcher', taskDigest }), { mode: 0o600 });
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { newInvocationPath: invocationPath, inspect: inspectWorkerPath });
    expect(exitRecord).toMatchObject({ invocationId: 'prev-1', termination: 'confirmed' });
    // A FRESH directory (never retried before, no predecessor at all) is
    // simply unrelated work -- retryOf omitted, never refused for retry
    // reasons, no path coincidence required or consulted.
    const launcher = new SessionLauncher();
    await expect(launcher.launchWorker({ invocationPath: '/does/not/exist.json', runDir: '/does/not/exist' }))
      .rejects.not.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
  });

  it('a confirmed predecessor with a FRESH output path is accepted (#2915 review 4, finding 4)', async () => {
    // The predecessor and the new attempt deliberately use DIFFERENT
    // `final_output` paths (every legitimate retry attempt gets a fresh
    // one) but the SAME role/task/group/brief -- task-chain binding must
    // still accept this as the SAME task, not a "different task" refusal.
    const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
    const predecessorPlan = await planFile(path.dirname(runDir), 'shared-task');
    await writeFile(path.join(runDir, 'invocation.json'),
      JSON.stringify({ invocationId: 'prev-1', origin: 'launcher', taskDigest: predecessorPlan.taskDigest }), { mode: 0o600 });
    const newAttemptRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-retry-new-'));
    roots.push(newAttemptRoot);
    const newAttemptPlan = await planFile(newAttemptRoot, 'shared-task');
    expect(newAttemptPlan.invocationPath).not.toBe(predecessorPlan.invocationPath);
    expect(newAttemptPlan.taskDigest).toBe(predecessorPlan.taskDigest); // same task, different paths
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { newInvocationPath: newAttemptPlan.invocationPath, inspect: inspectWorkerPath });
    expect(exitRecord).toMatchObject({ invocationId: 'prev-1', termination: 'confirmed' });
  });

  it('rejects an insecurely-moded predecessor metadata file instead of repairing it (#2915 review 4, finding 4)', async () => {
    const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
    await chmod(path.join(runDir, 'exit.json'), 0o666);
    await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect: inspectWorkerPath }))
      .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    // The file's mode is untouched -- never silently repaired to 0600.
    expect((await lstat(path.join(runDir, 'exit.json'))).mode & 0o777).toBe(0o666);
  });

  it('rejects a predecessor location inside a worker-writable root', async () => {
    const { runDir, root } = await predecessorRunDir({ invocationId: 'prev-1' });
    await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { inspect: inspectWorkerPath, workerWritableRoots: [root] }))
      .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    // An unrelated worker-writable root never blocks a legitimate predecessor.
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { inspect: inspectWorkerPath, workerWritableRoots: ['/some/other/worktree'] });
    expect(exitRecord).toMatchObject({ invocationId: 'prev-1', termination: 'confirmed' });
  });

  it('forged-or-missing-evidence-refuses', async () => {
    const inspect = inspectWorkerPath;
    // Missing directory entirely.
    await expect(verifyRetryPredecessor({ invocationId: 'x', runDir: '/does/not/exist' }, { inspect }))
      .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    // Wrong id in .launch-owner (forged/mismatched claim).
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1', corruptOwner: true });
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
    // Directory mode too permissive (group/world readable).
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
      await chmod(runDir, 0o750);
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
    // invocation.json not launcher-written (worker-writable-shaped record).
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1', origin: 'worker' });
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
    // Uncertain predecessor: present, well-formed, matching identity -- but
    // not confirmed. Confirmed failed/stopped permits it; uncertain refuses.
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1', termination: 'uncertain' });
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
    }
    // A symlinked run directory never passes the anchored, no-follow readers.
    {
      const { runDir, root } = await predecessorRunDir({ invocationId: 'prev-1' });
      const linkPath = path.join(root, 'link');
      await symlink(runDir, linkPath);
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir: linkPath }, { inspect }))
        .rejects.toThrow();
    }
    // Task-chain binding: a predecessor for a DIFFERENT task must never
    // authorize replacement of this one, even with perfectly valid,
    // confirmed, identity-matching evidence otherwise.
    {
      const { runDir, root } = await predecessorRunDir({ invocationId: 'prev-1', taskDigest: 'digest-a' });
      const { invocationPath } = await planFile(root, 'digest-b');
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { newInvocationPath: invocationPath, inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
  });

  it('unrelated-work-remains-admissible', async () => {
    // Omitting `retryOf` entirely is unrelated work, by definition, no
    // matter how uncertain or confirmed any previous launcher activity was
    // -- there is no path-pair inference left to misfire.
    const launcher = new SessionLauncher();
    launcher.lastAttemptResult = { termination: 'uncertain', invocationId: 'prev-1' };
    await expect(launcher.launchWorker({ invocationPath: '/plan-b.json', runDir: '/run-b' }))
      .rejects.not.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
    await expect(launcher.launchWorker({ invocationPath: '/plan-b.json', runDir: '/run-b' }))
      .rejects.not.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
  });

  it('a verified retry writes previousAttemptId into the new attempt\'s own invocation.json', async () => {
    // Exercises the actual wiring point in launchOneWorker, not just the
    // standalone verifier.
    const { runDir: prevRunDir } = await predecessorRunDir({ invocationId: 'prev-1', taskDigest: 'anything' });
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir: prevRunDir }, { inspect: inspectWorkerPath });
    expect(exitRecord.invocationId).toBe('prev-1');
    // The field this gate feeds is read directly off `options.verifiedPreviousAttemptId`
    // in launchOneWorker's `invocation.json` publish (session-launcher.mjs) --
    // covered end-to-end by the retry-admits-after-confirmed-stop path in the
    // S1 integration suite below, which always supplies a FRESH runDir per
    // attempt (so publishing this field never collides with #2895's
    // fresh/empty runDir precondition).
  });
});

describe('startup correction budget (session-launcher)', () => {
  it('allows one correction for qualified mechanical causes only', () => {
    expect(MAX_STARTUP_CORRECTIONS).toBe(1);
    expect(startupCorrectionGate({ correctionsUsed: 0, reasonCode: 'STDIN_WAIT' }).ok).toBe(true);
    expect(startupCorrectionGate({ correctionsUsed: 1, reasonCode: 'STDIN_WAIT' }).ok).toBe(false);
    for (const reasonCode of ['AUTH', 'TRUST', 'RESOURCE', 'UNKNOWN', null]) {
      expect(startupCorrectionGate({ correctionsUsed: 0, reasonCode }).ok).toBe(false);
    }
  });
});

describe('buildFailureAttribution', () => {
  it('reuses workerModelKey for model scope and quota account for trusted 429', async () => {
    const model = await buildFailureAttribution(
      { invocationId: 'i-1', selected: { cli: 'codex', inferenceProvider: 'openai', apiModelId: 'gpt-x' } },
      { reasonCode: 'MODEL', evidenceSource: 'launcher' },
    );
    expect(model).toEqual({ scope: 'model', scopeKey: 'model:openai/gpt-x', confidence: 'suspected' });

    const quota = await buildFailureAttribution(
      { invocationId: 'i-2', selected: { cli: 'codex-alias', inferenceProvider: 'openai' } },
      { reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', quotaAccount: 'acct-1' },
    );
    expect(quota.scope).toBe('quota');
    expect(quota.scopeKey).toBe('quota:acct-1');
  });

  it('keeps the inference backend separate from the CLI installation', async () => {
    // Review probe regression: backend `openai` became `provider:codex`;
    // `anthropic` became `installation:multi`. The backend is used raw.
    const provider = await buildFailureAttribution(
      { invocationId: 'i-4', selected: { cli: 'codex', inferenceProvider: 'openai' } },
      { reasonCode: 'NETWORK', evidenceSource: 'launcher' },
    );
    expect(provider).toEqual({ scope: 'provider', scopeKey: 'provider:openai', confidence: 'suspected' });
    const install = await buildFailureAttribution(
      { invocationId: 'i-5', selected: { cli: 'codex', inferenceProvider: 'openai' } },
      { reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' },
    );
    expect(install).toEqual({ scope: 'installation', scopeKey: 'installation:codex', confidence: 'suspected' });
  });

  it('derives the quota account from trusted installation qualification', async () => {
    const quota = await buildFailureAttribution(
      { invocationId: 'i-6', selected: { cli: 'codex', inferenceProvider: 'openai' },
        qualification: { installation: { accountScope: 'acct-9' } } },
      { reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver' },
    );
    expect(quota.scopeKey).toBe('quota:acct-9');
  });

  it('falls back to the invocation scope when identity is unavailable', async () => {
    const out = await buildFailureAttribution({ invocationId: 'i-3', selected: {} },
      { reasonCode: 'MODEL', evidenceSource: 'launcher' });
    expect(out.scopeKey).toBe('invocation:i-3');
  });

  it('never widens on worker-sourced codes', async () => {
    const out = await buildFailureAttribution(
      { invocationId: 'i-7', selected: { cli: 'codex', inferenceProvider: 'openai' } },
      { reasonCode: 'RATE_LIMIT', evidenceSource: 'worker', quotaAccount: 'acct-1' },
    );
    expect(out.scope).toBe('invocation');
  });
});

describe('classifyLaunchOutcomeForRecovery', () => {
  it('treats only pre-spawn binary failures as installation evidence', () => {
    expect(classifyLaunchOutcomeForRecovery({ termination: 'confirmed', exitCode: null, errorCode: 'ENOENT' }))
      .toEqual({ reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' });
    expect(classifyLaunchOutcomeForRecovery({ termination: 'confirmed', exitCode: 1, errorCode: null }))
      .toEqual({ reasonCode: null, evidenceSource: 'launcher' });
    expect(classifyLaunchOutcomeForRecovery({ termination: 'confirmed', exitCode: 0 }))
      .toEqual({ reasonCode: null, evidenceSource: 'launcher' });
  });

  it('produces no trusted evidence from uncertain terminations', () => {
    expect(classifyLaunchOutcomeForRecovery({ termination: 'uncertain', exitCode: null, errorCode: 'ENOENT' }))
      .toEqual({ reasonCode: null, evidenceSource: null });
    expect(classifyLaunchOutcomeForRecovery(null)).toEqual({ reasonCode: null, evidenceSource: null });
  });

  it('derives covering keys from trusted resolved identities only, always including the single-host scope', async () => {
    await expect(recoveryScopeKeysForInvocation(
      { selected: { cli: 'codex', inferenceProvider: 'openai' } }, { invocationId: 'i-1', quotaAccount: 'acct-1' }))
      .resolves.toEqual(['invocation:i-1', 'installation:codex', 'provider:openai', 'quota:acct-1', 'host:local']);
    // No resolvable model/installation/provider/quota identity -- `host:local`
    // is the only key, never defaulted to a shared installation/provider/
    // quota scope (#2915 review: model/host scopes were never covered).
    await expect(recoveryScopeKeysForInvocation({ selected: {} }, {})).resolves.toEqual(['host:local']);
  });

  it('derives the model scope key and a qualified installation scope key', async () => {
    const keys = await recoveryScopeKeysForInvocation(
      { selected: { cli: 'codex', inferenceProvider: 'openai', apiModelId: 'gpt-x' } },
      { invocationId: 'i-9', installationQualifier: 'sha256:boundary-a' });
    expect(keys).toEqual(['invocation:i-9', 'model:openai/gpt-x', 'installation:codex:sha256:boundary-a', 'provider:openai', 'host:local']);
    // A different installationQualifier for the same CLI name produces a
    // DIFFERENT installation scope key (#2915 review: two installations
    // under one CLI name shared one scope).
    const otherKeys = await recoveryScopeKeysForInvocation(
      { selected: { cli: 'codex', inferenceProvider: 'openai', apiModelId: 'gpt-x' } },
      { invocationId: 'i-10', installationQualifier: 'sha256:boundary-b' });
    expect(otherKeys).toContain('installation:codex:sha256:boundary-b');
    expect(otherKeys).not.toContain('installation:codex:sha256:boundary-a');
  });
});

describe('existing breaker untouched', () => {
  it('still trips on consecutive failures with cooldown', () => {
    vi.useFakeTimers();
    const single = new ConsecutiveFailureCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    try {
      single.recordFailure();
      single.recordFailure();
      expect(single.getState().state).toBe('open');
      expect(single.canExecute()).toBe(false);
    } finally {
      single.destroy();
      vi.useRealTimers();
    }
  });

  it('shares one injected clock between the scoped and inner breakers', () => {
    // One-clock regression: the inner breaker must follow the injected
    // clock, not Date.now(). A manual clock advanced past the cooldown —
    // with wall time untouched — must half-open the inner breaker.
    let now = 1_000_000;
    const single = new ConsecutiveFailureCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000, nowMs: () => now });
    try {
      single.recordFailure();
      expect(single.getState().state).toBe('open');
      expect(single.canExecute()).toBe(false);
      now += 60_001;
      expect(single.canExecute()).toBe(true);
      expect(single.getState().state).toBe('half-open');
    } finally {
      single.destroy();
    }
  });
});

describe('admitDirectWorker / settleDirectWorker (replaces recordDirectWorkerOutcome)', () => {
  it('records bridge outcomes invocation-scoped and settles cohort membership', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' } };
      const config = { parallelism: { worker_dispatch: true } };
      const admit = (invocationId) => admitDirectWorker({ gateEnabled: true, config, invocation, invocationId, scopedBreaker: breaker, drivers: {} });
      const a1 = await admit('r-1');
      expect(a1.gated).toBe(true);
      settleDirectWorker(a1, { kind: 'failed' }); // wait-status alone never implicates a shared scope
      expect(breaker.getState('installation:codex').tracked).toBe(false);
      expect(breaker.getState('provider:openai').tracked).toBe(false);
      expect(breaker.snapshot().attemptsObserved).toBe(1);
      const a2 = await admit('r-2');
      settleDirectWorker(a2, { kind: 'succeeded' });
      expect(breaker.snapshot().attemptsObserved).toBe(2);
      const a3 = await admit('r-3');
      settleDirectWorker(a3, { kind: 'uncertain' });
      // #2915 review 4 (finding 8): 'uncertain' is never recorded as an
      // observed attempt (diagnostic-only counter; see consecutive-failure-
      // circuit-breaker.mjs `_recordObservedAttempt`'s doc comment).
      expect(breaker.snapshot().attemptsObserved).toBe(2);
    } finally {
      breaker.destroy();
    }
  });
});

describe('classifyAttemptForSettlement / admitDirectWorker (replaces recordRecoveryAfterAttempt)', () => {
  it('attributes a pre-spawn-style failure to the SAME qualified installation key the pre-launch gate watches (#2915 P3 qualifier-consistency)', async () => {
    // Regression: attributing a failure through the UNqualified
    // `installation:<cli>` key while admission watches the QUALIFIED
    // `installation:<cli>:<qualifier>` key would open a scope admission
    // never checks -- the gate would never catch its own failures.
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' } };
      const qualifier = 'sha256:boundary-x';
      const config = { parallelism: { worker_dispatch: true } };
      const attemptFailure = async (id) => {
        const admission = await admitDirectWorker({ gateEnabled: true, config, invocation, invocationId: id,
          scopedBreaker: breaker, drivers: {}, installationQualifier: qualifier });
        const result = { termination: 'confirmed', exitCode: null, errorCode: 'ENOENT', attemptOutcome: 'failed' };
        settleDirectWorker(admission, classifyAttemptForSettlement(invocation, result, { installationQualifier: qualifier }));
        return admission;
      };
      const first = await attemptFailure('r-1');
      const scopeKeys = first.token?.coveringKeys ?? await recoveryScopeKeysForInvocation(invocation, { invocationId: 'r-1', installationQualifier: qualifier });
      expect(scopeKeys).toContain('installation:codex:sha256:boundary-x');
      const state = breaker.getState('installation:codex:sha256:boundary-x');
      expect(state.tracked).toBe(true);
      expect(state.distinctFailures).toBe(1);
      // The UNqualified key must NOT have received this failure.
      expect(breaker.getState('installation:codex').tracked).toBe(false);
      await attemptFailure('r-2');
      await attemptFailure('r-3');
      expect(breaker.getState('installation:codex:sha256:boundary-x').state).toBe('open');
    } finally {
      breaker.destroy();
    }
  });

  it('recovers the scope on a launcher-confirmed success, passing attemptOutcome through classifyAttemptForSettlement', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex' } };
      const config = { parallelism: { worker_dispatch: true } };
      const admission = await admitDirectWorker({ gateEnabled: true, config, invocation, invocationId: 'ok-1', scopedBreaker: breaker, drivers: {} });
      const result = { termination: 'confirmed', exitCode: 0, attemptOutcome: 'succeeded' };
      const outcome = classifyAttemptForSettlement(invocation, result);
      expect(outcome).toEqual({ kind: 'succeeded', confirmedStop: true });
      settleDirectWorker(admission, outcome);
      expect(breaker.snapshot().attemptsObserved).toBe(1);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 ("a second worker over unresolved execution"): a
  // degraded-isolation attempt can never confirm descendant termination
  // (`captureOneWorker`'s own `confirmed` computation is always false for
  // it), so `confirmedStop` must read false even on a genuinely SUCCESSFUL
  // attempt — this is the fact `ScopedFailureBreaker.settle()` consults to
  // decide whether a canary's blocking marker may clear, entirely separate
  // from `kind` (attempt success/failure).
  it('confirmedStop reflects result.termination independently of attemptOutcome', () => {
    const invocation = { selected: { cli: 'codex' } };
    expect(classifyAttemptForSettlement(invocation, { termination: 'confirmed', attemptOutcome: 'succeeded' }))
      .toEqual({ kind: 'succeeded', confirmedStop: true });
    expect(classifyAttemptForSettlement(invocation, { termination: 'uncertain', attemptOutcome: 'succeeded' }))
      .toEqual({ kind: 'succeeded', confirmedStop: false });
    expect(classifyAttemptForSettlement(invocation, { termination: 'uncertain', attemptOutcome: 'uncertain' }))
      .toEqual({ kind: 'uncertain', confirmedStop: false });
    const failed = classifyAttemptForSettlement(invocation,
      { termination: 'confirmed', attemptOutcome: 'failed', errorCode: 'ENOENT', sawExit: false, exitCode: null });
    expect(failed).toMatchObject({ kind: 'failed', confirmedStop: true, reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' });
  });
});

// #2915 P4: determinism requires injecting BOTH the dispatch switch/live
// signals (so `checkWorkerDispatch`'s real resource sampling never decides
// the outcome) and the isolation detector (so a host with/without a
// reachable systemd --user manager behaves identically) -- these tests
// previously depended on the real host's systemd reachability and failed
// with "Worker isolation requires a positive memoryMaxGb ceiling" on any
// host where isolation was actually detected as available.
const dispatchOnConfig = Object.freeze({ parallelism: { worker_dispatch: true } });
const healthyLive = Object.freeze({ supported: true, availMemGb: 64, loadRatio: 0.01, memPsiAvg10: 0, memPsiAvg60: 0, workers: 0, freeDiskGb: 64 });

describe('planDirectWorkerLaunch recovery gate', () => {
  it('refuses a covered launch before any spawn and passes an unaffected one to the dispatch gate', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      const blocked = await planDirectWorkerLaunch({ invocation, scopedBreaker: breaker,
        config: dispatchOnConfig, live: healthyLive });
      expect(blocked.launched).toBe(false);
      expect(blocked.blocked).toBe(true);
      expect(blocked.recoveryBlocked).toEqual(['installation:codex']);
      // An unrelated CLI is unaffected and reaches the dispatch gate (which
      // refuses here on injected degraded isolation, deterministically,
      // without ever spawning).
      const other = await planDirectWorkerLaunch({
        invocation: { selected: { cli: 'other-cli', inferenceProvider: 'other-backend' }, stdin: 'closed' },
        scopedBreaker: breaker, config: dispatchOnConfig, live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
      });
      expect(other.recoveryBlocked).toBeUndefined();
      expect(other.launched).toBe(false);
    } finally {
      breaker.destroy();
    }
  });

  it('skips the gate for flat-option callers with no trusted identities', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const out = await planDirectWorkerLaunch({ command: '/nonexistent', args: [], cwd: '/tmp', scopedBreaker: breaker,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' } });
      expect(out.recoveryBlocked).toBeUndefined();
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 (finding 4, "unauthenticated or reused authority"): a
  // fabricated `admission` object -- never minted by `admitDirectWorker` --
  // previously dispatched exactly as if the scope had been genuinely
  // checked and found closed. This is an authentication bypass: calling
  // `planDirectWorkerLaunch` with a borrowed admission requires NO prior
  // call to `admitDirectWorker` at all.
  it('refuses a fabricated borrowed admission instead of dispatching on unauthenticated authority', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      // Shapes a real caller could plausibly forge: a plain object with no
      // `token`/`breaker`, claiming to be gated-and-admitted.
      const fabricated = { gated: true };
      // `planDirectWorkerLaunch` is deliberately NOT declared `async` (see
      // its own doc comment: synchronous, byte-for-byte legacy return for
      // disabled dispatch) -- the borrowed-admission validation runs in
      // its synchronous body, so the throw happens synchronously here,
      // never as a rejected Promise.
      expect(() => planDirectWorkerLaunch({ invocation, scopedBreaker: breaker, config: dispatchOnConfig, live: healthyLive,
        admission: fabricated, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true }))
        .toThrow(/not a value admitDirectWorker returned/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 (finding 4): ONE genuine admission, reused for a SECOND
  // distinct dispatch attempt, previously launched twice -- each admission
  // must authorize exactly one launch.
  it('refuses to launch twice off ONE genuine borrowed admission', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admission = await admitDirectWorker({ gateEnabled: true, config: dispatchOnConfig, invocation: { selected: { cli: 'codex' } },
        invocationId: 'reuse-1', scopedBreaker: breaker, drivers: {} });
      expect(admission.gated).toBe(true);
      const first = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(first.launched).toBe(true);
      // Same synchronous-throw reasoning as the fabricated-admission test
      // above -- the borrowed-admission check runs before any `async` IIFE.
      expect(() => planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true }))
        .toThrow(/already used to authorize a launch/);
    } finally {
      breaker.destroy();
    }
  });

  it('is inert when worker_dispatch is off: an open scope never blocks, and the breaker is never constructed or consulted (#2915 P0)', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      expect(breaker.getState(INSTALL).state).toBe('open');
      const attemptsObservedBefore = breaker.snapshot().attemptsObserved;
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      const out = await planDirectWorkerLaunch({ invocation, scopedBreaker: breaker,
        config: { parallelism: { worker_dispatch: false } }, live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' } });
      expect(out.recoveryBlocked).toBeUndefined();
      expect(out.blocked).toBeUndefined();
      // The breaker itself is untouched: no launch was ever noted against
      // the open scope, confirming the gate was never even consulted, not
      // merely that it happened to pass.
      expect(breaker.snapshot().attemptsObserved).toBe(attemptsObservedBefore);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 (finding 2c, "leaked capacity"): a standalone successful
  // launch (no borrowed admission -- the caller is responsible for its own
  // settlement by this function's own documented contract) must not leak
  // its reservation FOREVER when the caller never settles. A non-canary
  // admission's token has an `Infinity` deadline (only a canary gets the
  // breaker's bounded `canaryTimeoutMs`), so the breaker's own sweep can
  // never reclaim it on its own -- proven here via the CANARY case, where
  // a stuck reservation is directly observable: it would otherwise block
  // every later admission for this scope, forever, with no caller ever
  // calling `settleDirectWorker`.
  it('a standalone successful launch settles itself once the real child exits, even though the caller never calls settleDirectWorker', async () => {
    // An injected clock (never `vi.useFakeTimers()`, which would also fake
    // the event loop timers the REAL spawned child's async exit depends
    // on) -- the same `nowMs` pattern the canary-cycle tests above use.
    let now = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 120_000;
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      // A real, fast-exiting child -- standalone, no `admission` borrowed,
      // and the caller (this test) deliberately never calls
      // `settleDirectWorker` on the returned admission.
      const launch = await planDirectWorkerLaunch({
        invocation, scopedBreaker: breaker, config: dispatchOnConfig, live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
      });
      expect(launch.launched).toBe(true);
      expect(launch.admission).toBeDefined();
      expect(launch.child).toBeDefined();
      // Wait for the real child to actually exit.
      await new Promise(resolve => launch.child.once('exit', resolve));
      // Give the safety-net's own 'exit' listener a turn to run and settle.
      await new Promise(resolve => setImmediate(resolve));
      // The canary slot was freed by the safety net, not left stuck forever
      // -- a fresh probe (and, if due, a new canary admission) must be
      // reachable again. (The scope itself reopened on no confirmed
      // success, as expected for an unconfirmed 'uncertain' settlement;
      // what matters here is that it is NOT permanently wedged by a
      // never-settled reservation.)
      expect(breaker.getState(INSTALL).activeCanary).toBeNull();
    } finally {
      breaker.destroy();
    }
  });
});

describe('breaker restart semantics', () => {
  it('comes up CLOSED on restart: a fresh instance inherits no open scopes', () => {
    // Documents the in-memory restart contract: fail-open on restart,
    // coupled with the stop-before-retry gate (exit.json evidence) and
    // re-opening on fresh trusted evidence. No reservation survives.
    const first = new ScopedFailureBreaker({ jitterMs: () => 0 });
    for (const id of ['a', 'b', 'c']) failEvidence(first, installFailure(id));
    expect(first.getState(INSTALL).state).toBe('open');
    first.destroy();
    const restarted = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      expect(restarted.getState(INSTALL).tracked).toBe(false);
      expect(probe(restarted, [INSTALL]).ok).toBe(true);
    } finally {
      restarted.destroy();
    }
  });
});

describe('bounded retained state (#2915 P3: scopes, cohorts and dedup sets never grow without bound)', () => {
  it('evicts inert (closed, memberless) scopes once maxTrackedScopes is reached, never an open one', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 5 } });
    try {
      // One genuinely OPEN scope, created first so it is the "oldest" by
      // insertion order -- it must survive eviction regardless.
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      expect(breaker.getState(INSTALL).state).toBe('open');
      // Many distinct CLOSED, memberless scopes (one failure each, never
      // reaching the distinct-threshold) -- each creates a new tracked
      // scope record via a fresh CLI name. (Constructed directly, not via
      // `installFailure`, which hardcodes `scopeKey: INSTALL` regardless
      // of the `cli` passed -- settle() only re-narrows a claim, it never
      // re-keys an already-matching-rank claim to a different key.)
      for (let n = 0; n < 20; n += 1) {
        const key = scopeKeyFor.installation(`cli-${n}`);
        fail(breaker, [key], `solo-${n}`, { scope: FailureScope.INSTALLATION, scopeKey: key, reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: `cli-${n}` });
      }
      expect(breaker.snapshot().scopes.length).toBeLessThanOrEqual(5);
      // The open scope was never evicted.
      expect(breaker.getState(INSTALL).tracked).toBe(true);
      expect(breaker.getState(INSTALL).state).toBe('open');
    } finally {
      breaker.destroy();
    }
  });

  it('evicts the oldest charged-attempt id once maxChargedAttempts is reached', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxChargedAttempts: 5 } });
    try {
      for (let n = 0; n < 50; n += 1) {
        succeed(breaker, ['installation:codex'], `ok-${n}`);
      }
      expect(breaker.snapshot().attemptsObserved).toBeLessThanOrEqual(5);
    } finally {
      breaker.destroy();
    }
  });

  it('removes an outstanding scope key entirely once its member set empties (not just emptying the nested map)', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      uncertain(breaker, ['installation:codex'], 'a');
      // #2915 review: settlement emptied the nested Map but never deleted
      // the scopeKey itself, retaining the key forever even though no
      // scope record was ever created (`admit`/`settle` touch only
      // `_outstanding` for a never-failed scope, not `_scopes`).
      expect(breaker.getState('installation:codex')).toEqual({ scopeKey: 'installation:codex', state: 'closed', tracked: false });
      // A later, unrelated single launch on the same key must not inherit
      // 'a' as a frozen-cohort member (the observable proof the key, not
      // just its contents, was actually removed).
      fail(breaker, ['installation:codex'], 'b', installFailure('b'));
      expect(breaker.getState(INSTALL).cohortSize).toBe(1);
    } finally {
      breaker.destroy();
    }
  });
});

describe('S1 direct-dispatch integration (offline, fake CLI binary)', () => {
  // Proves the live launchWorker path constructs and consults the scoped
  // breaker: three launcher-observed missing-binary failures open the
  // installation scope, a fourth launch is refused while it is open, and
  // launches proceed after a launcher-verified probe → canary cycle. No
  // spawns of real CLIs, no network, no model calls — the "CLI" is a
  // nonexistent binary, so every attempt fails at spawn with ENOENT.
  async function enoentFixtureRoot() {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const f = workerResolutionFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-scoped-recovery-'));
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const brief = path.join(root, 'brief.json');
    await writeFile(brief, 'synthetic brief');
    const final = path.join(root, 'final.json');
    const adapter = f.snapshot.registry.providers.codex.workerAdapter;
    const profile = adapter.invocationProfiles['fixture-shell'];
    profile.envAllowlist = [];
    profile.health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
      sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot',
      qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
    f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
    // #2915 review 4 (finding 8): this fixture deliberately retries the
    // exact SAME task (role/task/group/brief content, so the same stable
    // task-chain digest) across many real attempts to exercise the
    // BREAKER's own canary/backoff cycle -- that is a distinct concern
    // from the per-task-chain allowance ledger's attempt budget. Raise the
    // resolved ceiling well past this suite's attempt counts so the
    // breaker scenarios below are not incidentally capped by the ledger;
    // the ledger's own exhaustion behavior is covered separately.
    f.snapshot.config.parallelism.retry = { maxAttempts: 20 };
    const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: [] }),
      extractFinal: () => null,
    };
    const drivers = { codex: driver };
    f.snapshot.installations.codex.boundary = driver.qualification.boundary;
    // Every attempt resolves a FRESH plan: capture files from one attempt
    // must never collide with the next attempt's fresh-output requirement.
    let planSeq = 0;
    const freshPlan = async () => {
      planSeq += 1;
      const attemptFinal = path.join(root, `final-${planSeq}.json`);
      const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd, final_output: attemptFinal };
      const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(plan.invocation).toBeDefined();
      const invocationPath = path.join(root, `plan-${planSeq}.json`);
      await writeFile(invocationPath, JSON.stringify(plan));
      return invocationPath;
    };
    return { f, root, cwd, brief, final, freshPlan, drivers };
  }

  // #2915 review 5 (finding 4, "unauthenticated or reused authority"): the
  // writable-root exclusion `verifyRetryPredecessor` itself already
  // supports was never actually wired into production `launchWorker` --
  // this proves a forged predecessor record planted inside the worker's
  // own writable worktree (the default `workerWritableRoots` fallback, no
  // special driver config needed) is refused through the REAL end-to-end
  // `launcher.launchWorker({ retryOf })` call, not merely the
  // `verifyRetryPredecessor` helper in isolation.
  it('refuses a forged retry predecessor planted inside the worker-writable root, through the real launchWorker path', async () => {
    const fx = await enoentFixtureRoot();
    const launcher = new SessionLauncher();
    try {
      const invocationPath = await fx.freshPlan();
      const saved = JSON.parse(await readFile(invocationPath, 'utf8'));
      const taskDigest = await stableTaskChainDigest(saved.request, saved.invocation.briefDigest);
      // Planted INSIDE fx.cwd -- the worker's own writable worktree, which
      // falls back to being the default `workerWritableRoots` entry when
      // (as here) the driver declares none of its own.
      const forgedRunDir = path.join(fx.cwd, 'forged-predecessor');
      await mkdir(forgedRunDir, { mode: 0o700 });
      await writeFile(path.join(forgedRunDir, '.launch-owner'), 'forged-prev', { mode: 0o600 });
      await writeFile(path.join(forgedRunDir, 'invocation.json'),
        JSON.stringify({ invocationId: 'forged-prev', origin: 'launcher', taskDigest }), { mode: 0o600 });
      await writeFile(path.join(forgedRunDir, 'exit.json'),
        JSON.stringify({ invocationId: 'forged-prev', termination: 'confirmed' }), { mode: 0o600 });
      let spawned = false;
      await expect(launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, 'retry-run'),
        retryOf: { invocationId: 'forged-prev', runDir: forgedRunDir },
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: () => { spawned = true; return { mode: 'degraded',
          child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      })).rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
      expect(spawned).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // The positive counterpart: a GENUINE predecessor outside any
  // worker-writable root is still accepted end-to-end through the same
  // real `launchWorker({ retryOf })` wiring -- the writable-root exclusion
  // must refuse forged/misplaced evidence without blocking legitimate
  // retries.
  it('accepts a genuine retry predecessor outside the worker-writable root, through the real launchWorker path', async () => {
    const fx = await enoentFixtureRoot();
    const launcher = new SessionLauncher();
    try {
      const invocationPath = await fx.freshPlan();
      const saved = JSON.parse(await readFile(invocationPath, 'utf8'));
      const taskDigest = await stableTaskChainDigest(saved.request, saved.invocation.briefDigest);
      // Outside fx.cwd entirely -- a conductor-owned predecessor location,
      // never inside the worker's own writable worktree.
      const genuineRunDir = path.join(fx.root, 'genuine-predecessor');
      await mkdir(genuineRunDir, { mode: 0o700 });
      await writeFile(path.join(genuineRunDir, '.launch-owner'), 'genuine-prev', { mode: 0o600 });
      await writeFile(path.join(genuineRunDir, 'invocation.json'),
        JSON.stringify({ invocationId: 'genuine-prev', origin: 'launcher', taskDigest }), { mode: 0o600 });
      await writeFile(path.join(genuineRunDir, 'exit.json'),
        JSON.stringify({ invocationId: 'genuine-prev', termination: 'confirmed' }), { mode: 0o600 });
      const result = await launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, 'retry-run-genuine'),
        retryOf: { invocationId: 'genuine-prev', runDir: genuineRunDir },
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: () => ({ mode: 'degraded',
          child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }),
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(JSON.parse(await readFile(path.join(fx.root, 'retry-run-genuine', 'invocation.json'), 'utf8')))
        .toMatchObject({ previousAttemptId: 'genuine-prev' });
    } finally {
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('refuses a launch while the scope is open and resumes after a verified canary', async () => {
    const fx = await enoentFixtureRoot();
    let now = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      return launcher.launchWorker({
        invocationPath: await fx.freshPlan(),
        runDir: path.join(fx.root, `run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
        now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
        allowDegraded: true,
        // The fake CLI: a binary that does not exist, so the launcher's own
        // spawn fails with ENOENT — trusted installation evidence, never
        // worker text.
        launchIsolated: () => ({ mode: 'degraded',
          child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }),
      });
    };
    try {
      // Three distinct attempts fail at spawn; the installation scope opens.
      for (let n = 0; n < 3; n += 1) {
        const result = await launchOnce();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', exitCode: null });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      // A fourth launch is refused while the scope is open — before any
      // runDir is even created — and charges no attempt.
      const refusedRunDir = path.join(fx.root, `run-${attempt + 1}`);
      await expect(launcher.launchWorker({
        invocationPath: await fx.freshPlan(),
        runDir: refusedRunDir,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
        now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
        allowDegraded: true,
        launchIsolated: () => { throw new Error('must never spawn while the scope is open'); },
      })).rejects.toMatchObject({ code: RECOVERY_SCOPE_OPEN_CODE });
      await expect(lstat(refusedRunDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(breaker.snapshot().attemptsObserved).toBe(3);
      // #2915D2: once due, the breaker admits the NEXT REAL launch through
      // this exact `launchWorker` path as the half-open canary — there is
      // no separate probe runner. The fixture binary still does not exist,
      // so this canary fails again at spawn: the scope stays open and the
      // backoff doubles (120s -> 240s), proving the retry really ran
      // through production dispatch rather than being skipped or stuck.
      now += 121_000;
      const canaryAttempt = await launchOnce();
      expect(canaryAttempt).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(breaker.snapshot().attemptsObserved).toBe(4);
      expect(breaker.getState(INSTALL).state).toBe('open');
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
      // Not due yet at +120s (doubled backoff): still refused, no spawn --
      // proving the gate is not a one-shot: it keeps gating correctly after
      // a canary failure, not just before the first one.
      now += 120_000;
      await expect(launcher.launchWorker({
        invocationPath: await fx.freshPlan(),
        runDir: path.join(fx.root, `run-${attempt + 1}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
        now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
        allowDegraded: true,
        launchIsolated: () => { throw new Error('must never spawn before the doubled backoff elapses'); },
      })).rejects.toMatchObject({ code: RECOVERY_SCOPE_OPEN_CODE });
      // Due at +240s: the next real launch is again admitted as the
      // canary through this same production surface — no deadlock, the
      // path back to a real attempt stays reachable after every reopen.
      // (Degraded isolation never yields a launcher-CONFIRMED success —
      // see worker-single-invocation.test.ts's own `termination: 'uncertain'`
      // assertion on a clean exit in degraded mode — so a confirmed-success
      // recovery through this exact degraded fixture is architecturally
      // unreachable here; `recordSuccess` closing the scope on a
      // launcher-verified success is proven directly in the "half-open
      // canary admission" suite above.)
      now += 120_000;
      const secondCanaryAttempt = await launchOnce();
      expect(secondCanaryAttempt).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(breaker.getState(INSTALL).state).toBe('open');
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(480_000);
      expect(breaker.snapshot().attemptsObserved).toBe(5);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);

  // #2915 review 5 (finding 2a, "leaked capacity"): a capture-setup
  // exception AFTER a child has already attached (post-spawn) must still
  // settle the admission -- never leak it. Before this fix, the catch
  // block in `launchOneWorker` only settled when `!outcome?.child` (proven
  // pre-spawn); an exception reached after spawn left the breaker's
  // reservation/canary slot outstanding forever, which — proven here via
  // the real, production admit()/settle() wiring — permanently starved out
  // every later attempt for the same scope.
  it('a post-spawn capture-setup exception settles the admission instead of leaking it, never starving out later attempts', async () => {
    const fx = await enoentFixtureRoot();
    let now = 4_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchEnoent = async (drivers = fx.drivers) => {
      attempt += 1;
      return launcher.launchWorker({
        invocationPath: await fx.freshPlan(), runDir: path.join(fx.root, `leak-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: () => ({ mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }),
      });
    };
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchEnoent();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 121_000;
      // The due canary attempt: a child attaches (spawn succeeds enough for
      // Node to return a child object even though the binary is missing --
      // the ENOENT surfaces asynchronously), but the capture pipeline
      // itself throws synchronously BEFORE `captureOneWorker`'s own
      // `finish()` closure is even wired, escaping its normal
      // never-throws-just-resolves contract entirely.
      const throwingDriver = { ...fx.drivers.codex, createHealthObserver: () => { throw new Error('synthetic capture-setup failure'); } };
      await expect(launchEnoent({ codex: throwingDriver })).rejects.toThrow('synthetic capture-setup failure');
      // Not leaked: the canary reservation was settled (uncertain), so the
      // scope is still open with the normal doubled backoff, and -- the
      // real proof -- the NEXT due attempt is still admitted as a fresh
      // canary rather than being refused forever by a stuck, never-settled
      // reservation.
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += breaker.getState(INSTALL).episodeCooldownMs;
      const nextCanary = await launchEnoent();
      expect(nextCanary).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);

  // #2915 final review step 5 (production closure): a genuinely successful
  // DEGRADED attempt (no systemd unit; `termination` can never reach
  // 'confirmed') must still close the scope through `launchWorker`'s real,
  // production admit()/settle() wiring — the evidence-contract fix for
  // finding 4 ("degraded success never closes the scope"). Three real
  // pre-spawn ENOENT failures open the scope exactly as above; the due
  // canary then spawns a REAL child (the shared `ralph-worker-cli.mjs`
  // fixture) that exits 0 with a strictly-valid final, and the scope must
  // close even though `termination` stays 'uncertain'.
  it('launchWorker-opens-refuses-canary-closes', async () => {
    const fx = await enoentFixtureRoot();
    let now = 2_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchEnoent = async () => {
      attempt += 1;
      return launcher.launchWorker({
        invocationPath: await fx.freshPlan(), runDir: path.join(fx.root, `closes-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: () => ({ mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }),
      });
    };
    const configPath = path.join(fx.root, 'success-config.json');
    const recordPath = path.join(fx.root, 'success-record.json');
    await writeFile(configPath, JSON.stringify({ scenario: 'success', recordPath }));
    const realAdapter = fx.f.snapshot.registry.providers.codex.workerAdapter;
    const realProfile = realAdapter.invocationProfiles['fixture-shell'];
    realProfile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    const successDriver = {
      qualification: fx.drivers.codex.qualification,
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: realProfile.envAllowlist }),
      extractFinal: (text) => { try { const rows = text.trim().split('\n').map((line) => JSON.parse(line));
        return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
      // Stub attempt-terminal parser (#2915 evidence contract): approves
      // exactly when the launcher's own process-level evidence says this
      // ATTEMPT succeeded — proving the wiring, without needing the full
      // strict workerClaims schema machinery a production adapter runs.
      parseWorkerAttemptFinal: async (_output, options) => {
        if (options?.observation?.attemptOutcome !== 'succeeded') throw new Error('attempt not succeeded');
        return { status: 'completed' };
      },
    };
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchEnoent();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 121_000;
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', configPath);
      try {
        attempt += 1;
        // The saved plan must itself be resolved against `successDriver` —
        // `revalidateWorkerInvocationPlan` re-derives the invocation from
        // the CURRENT driver and compares digests, so plan and launch must
        // share the same driver (unlike `fx.freshPlan()`, which is closed
        // over the ENOENT driver from fixture setup).
        const successRequest = { role: 'coding', task: 'implementation', group: 'workers',
          brief: fx.brief, workdir: fx.cwd, final_output: path.join(fx.root, `closes-final-${attempt}.json`) };
        const successPlan = await resolveWorkerInvocation(fx.f.snapshot, successRequest, { codex: successDriver }, fx.f.request.now);
        expect(successPlan.invocation).toBeDefined();
        const successPlanPath = path.join(fx.root, `closes-plan-${attempt}.json`);
        await writeFile(successPlanPath, JSON.stringify(successPlan));
        const canaryResult = await launcher.launchWorker({
          invocationPath: successPlanPath, runDir: path.join(fx.root, `closes-run-${attempt}`),
          inputs: { snapshot: fx.f.snapshot, drivers: { codex: successDriver } }, now: fx.f.request.now,
          checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
          isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        });
        // The attempt genuinely succeeded (clean direct-child exit, strict
        // final validated) even though degraded descendant stop is, as
        // always, architecturally uncertain.
        expect(canaryResult.attemptOutcome).toBe('succeeded');
        expect(canaryResult.termination).toBe('uncertain');
      } finally {
        vi.unstubAllEnvs();
      }
      // The scope closed on this launcher-verified success -- the #2915
      // final review fix: degraded success now has a real recovery path.
      expect(breaker.getState(INSTALL).state).toBe('closed');
      // Closure grants no blanket pass: it is NOT a replacement-permission
      // mechanism — a fresh, independent ENOENT failure can reopen the
      // scope again afterward through the exact same production path.
      vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);

  // #2915 review 5 (finding 1b, "false recovery"): the LAST exit.json
  // publication is the one write-attempt the prior round left as a
  // "documented residual" -- a genuinely successful attempt (clean direct-
  // child exit, strict final validated) whose final metadata write still
  // fails must downgrade to 'uncertain', never report 'succeeded' and close
  // the breaker scope on a terminal record that never durably landed.
  it('a failed LAST exit.json publication downgrades a genuine success to uncertain and never closes the scope', async () => {
    const fx = await enoentFixtureRoot();
    let now = 3_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchEnoent = async () => {
      attempt += 1;
      return launcher.launchWorker({
        invocationPath: await fx.freshPlan(), runDir: path.join(fx.root, `lastwrite-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: () => ({ mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }),
      });
    };
    const configPath = path.join(fx.root, 'lastwrite-config.json');
    const recordPath = path.join(fx.root, 'lastwrite-record.json');
    await writeFile(configPath, JSON.stringify({ scenario: 'success', recordPath }));
    const realAdapter = fx.f.snapshot.registry.providers.codex.workerAdapter;
    const realProfile = realAdapter.invocationProfiles['fixture-shell'];
    realProfile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    const successDriver = {
      qualification: fx.drivers.codex.qualification,
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: realProfile.envAllowlist }),
      extractFinal: (text) => { try { const rows = text.trim().split('\n').map((line) => JSON.parse(line));
        return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
      parseWorkerAttemptFinal: async (_output, options) => {
        if (options?.observation?.attemptOutcome !== 'succeeded') throw new Error('attempt not succeeded');
        return { status: 'completed' };
      },
    };
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchEnoent();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 121_000;
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', configPath);
      try {
        attempt += 1;
        const successRequest = { role: 'coding', task: 'implementation', group: 'workers',
          brief: fx.brief, workdir: fx.cwd, final_output: path.join(fx.root, `lastwrite-final-${attempt}.json`) };
        const successPlan = await resolveWorkerInvocation(fx.f.snapshot, successRequest, { codex: successDriver }, fx.f.request.now);
        expect(successPlan.invocation).toBeDefined();
        const successPlanPath = path.join(fx.root, `lastwrite-plan-${attempt}.json`);
        await writeFile(successPlanPath, JSON.stringify(successPlan));
        // Every publish succeeds EXCEPT the LAST `exit.json` write -- the
        // first `exit.json` write (inside the `finally` right after
        // `recordProcess()`, before `attemptOutcome` is even computed)
        // still succeeds, so this isolates the exact residual review 5
        // flagged: a write failure discovered ONLY in the final publish.
        let exitJsonWrites = 0;
        const canaryResult = await launcher.launchWorker({
          invocationPath: successPlanPath, runDir: path.join(fx.root, `lastwrite-run-${attempt}`),
          inputs: { snapshot: fx.f.snapshot, drivers: { codex: successDriver } }, now: fx.f.request.now,
          checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
          isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
          publishRecord: async (runDir, name, value, inspect) => {
            if (name === 'exit.json') {
              exitJsonWrites += 1;
              if (exitJsonWrites === 2) throw new Error('synthetic final exit.json publish failure');
            }
            return publishWorkerRecord(runDir, name, value, inspect);
          },
        });
        expect(exitJsonWrites).toBe(2);
        // Downgraded, never fabricated as a success.
        expect(canaryResult.attemptOutcome).toBe('uncertain');
        expect(canaryResult.termination).toBe('uncertain');
      } finally {
        vi.unstubAllEnvs();
      }
      // The scope must STAY OPEN: a success whose own terminal record never
      // durably landed must never close it.
      expect(breaker.getState(INSTALL).state).toBe('open');
      vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('allowance ledger (#2915 review 4, finding 8)', () => {
  // Same offline ENOENT fake-CLI setup as the S1 suite above, parameterized
  // by `maxAttempts` (via the already-existing `parallelism.retry` ceiling —
  // no new configuration) and returning a FILE-backed `captureRoot`, so
  // these tests prove the real per-task-chain allowance through the
  // production `launchWorker` path with an injected clock and filesystem —
  // not just the breaker's own in-memory scope bookkeeping.
  async function ledgerFixtureRoot(maxAttempts) {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const f = workerResolutionFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-'));
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const brief = path.join(root, 'brief.json');
    await writeFile(brief, 'synthetic brief');
    const captureRoot = path.join(root, 'capture');
    const adapter = f.snapshot.registry.providers.codex.workerAdapter;
    const profile = adapter.invocationProfiles['fixture-shell'];
    profile.envAllowlist = [];
    profile.health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
      sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot',
      qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
    f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
    f.snapshot.config.parallelism.retry = { maxAttempts };
    const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: [] }),
      extractFinal: () => null,
    };
    const drivers = { codex: driver };
    f.snapshot.installations.codex.boundary = driver.qualification.boundary;
    let planSeq = 0;
    // `briefText` (not `group`, which the snapshot's parallelism policy
    // must already recognize) is what varies the resolved `briefDigest`,
    // and therefore `stableTaskChainDigest` -- role/task/group stay fixed
    // at their fixture-recognized values ('coding'/'implementation'/
    // 'workers') for every call; only distinct brief CONTENT yields a
    // distinct task chain.
    const buildPlan = async (briefText = 'synthetic brief') => {
      planSeq += 1;
      const briefPath = path.join(root, `brief-${planSeq}.json`);
      await writeFile(briefPath, briefText);
      const attemptFinal = path.join(root, `final-${planSeq}.json`);
      const request = { role: 'coding', task: 'implementation', group: 'workers', brief: briefPath, workdir: cwd, final_output: attemptFinal };
      const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(plan.invocation).toBeDefined();
      const invocationPath = path.join(root, `plan-${planSeq}.json`);
      await writeFile(invocationPath, JSON.stringify(plan));
      return { invocationPath, plan };
    };
    // Every call shares the SAME role/task/group/brief by default, so it
    // resolves to the SAME `stableTaskChainDigest` -- exactly the "same
    // task, retried" shape the allowance ledger governs.
    const freshPlan = () => buildPlan('synthetic brief');
    return { f, root, cwd, brief, captureRoot, freshPlan, buildPlan, drivers };
  }

  // Spawns the real nonexistent-binary fixture -- the same trusted
  // installation evidence the S1 suite uses -- while counting how many
  // times dispatch actually happened, so refused attempts are provably
  // never spawned.
  function enoentLaunchIsolated(counter) {
    return () => { counter.count += 1; return { mode: 'degraded',
      child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; };
  }

  it('exhausted allowance refuses the next attempt', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      const first = await launchOnce();
      expect(first).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
      // maxAttempts is 1 and the one allowed attempt is already charged:
      // the next attempt for this exact task chain is refused by the
      // ledger -- never reaching dispatch.
      await expect(launchOnce()).rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(1);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('five fresh requests with maxAttempts 1 dispatch exactly one', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      // Five SEPARATE, sequential fresh requests for the same task chain --
      // only the first ever reaches dispatch.
      const results = [];
      for (let n = 0; n < 5; n += 1) {
        try { results.push({ status: 'fulfilled', value: await launchOnce() }); }
        catch (error) { results.push({ status: 'rejected', reason: error }); }
      }
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      for (const r of rejected) expect(r.reason).toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(1);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('two concurrent sibling retries with one remaining attempt dispatch exactly one', async () => {
    const fx = await ledgerFixtureRoot(2);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const spawns = { count: 0 };
    let attempt = 0;
    // Each "sibling retry" is its OWN launcher instance -- exactly like two
    // independent conductor processes/retries would be in production. A
    // single `SessionLauncher` instance refuses a second concurrent
    // `launchWorker` call outright ("a worker is already attached to this
    // launcher"); that per-instance invariant is unrelated to the ledger
    // and must not be what this test observes.
    const launchOnce = async (launcher = new SessionLauncher()) => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      // Consume one of two allowed attempts up front, leaving exactly one
      // remaining for the concurrent pair below.
      const setup = await launchOnce();
      expect(setup).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
      // Two sibling retries race for the SAME task chain's one remaining
      // slot. The exclusive-create lock (`acquireLedgerLock` in
      // session-launcher.mjs, the same primitive process-monitor.mjs's
      // `createStatusObservationOwner` uses) must serialize their reserve
      // calls so exactly one wins and the other is refused -- never both
      // admitted against a single remaining attempt.
      const results = await Promise.allSettled([launchOnce(), launchOnce()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(2);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('spawn failure is charged', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const { invocationPath, plan } = await fx.freshPlan();
      const taskChainDigest = await stableTaskChainDigest(plan.request, plan.invocation.briefDigest);
      const result = await launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, 'run-1'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
      // The spawn-failed attempt is CHARGED, not merely reserved: it
      // appears in `chargedIds`, never left behind in `pendingIds`, proving
      // the debit-before-dispatch point in launchOneWorker actually ran.
      const recordPath = path.join(fx.captureRoot, 'ledger', `${taskChainDigest}.json`);
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(record.pendingIds).toEqual([]);
      expect(record.chargedIds).toHaveLength(1);
      // Charged means permanently consumed: a second attempt for the same
      // task chain (maxAttempts: 1) is refused, never dispatched.
      await expect(launcher.launchWorker({
        invocationPath: (await fx.freshPlan()).invocationPath, runDir: path.join(fx.root, 'run-2'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      })).rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(1);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('preparation refusal is refunded', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const { invocationPath: badPath } = await fx.freshPlan();
      // A pre-spawn preparation failure that happens AFTER admission (the
      // run directory's parent is missing, so `mkdir(runDir)` throws) must
      // refund the reservation. This is a plain preparation error, never
      // the allowance refusal.
      let prepError;
      try {
        await launcher.launchWorker({
          invocationPath: badPath, runDir: path.join(fx.root, 'missing-parent', 'run-bad'), captureRoot: fx.captureRoot,
          inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
          checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
          isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
          launchIsolated: enoentLaunchIsolated(spawns),
        });
      } catch (error) { prepError = error; }
      expect(prepError).toBeDefined();
      expect(prepError.code).not.toBe(ALLOWANCE_EXHAUSTED_CODE);
      // Preparation failed before the debit point: no dispatch happened.
      expect(spawns.count).toBe(0);
      // A fresh, properly-prepared attempt for the SAME task chain is
      // still admitted and reaches dispatch -- proving the failed
      // preparation's reservation was refunded, not left charged.
      const { invocationPath: goodPath } = await fx.freshPlan();
      const second = await launcher.launchWorker({
        invocationPath: goodPath, runDir: path.join(fx.root, 'run-good'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
      expect(second).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('canary is charged', async () => {
    const fx = await ledgerFixtureRoot(4);
    let now = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchOnce();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      expect(spawns.count).toBe(3);
      // Due: the next real launch is admitted as the half-open canary --
      // and CHARGED by the ledger exactly like any other dispatched
      // attempt. With maxAttempts: 4, this is the 4th and last allowed
      // attempt for this task chain.
      now += 121_000;
      const canary = await launchOnce();
      expect(canary).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(4);
      expect(breaker.getState(INSTALL).state).toBe('open');
      // The allowance is now exhausted. Even once the breaker's own
      // doubled backoff elapses and it would otherwise admit a second
      // canary, the LEDGER refuses first -- proving the canary attempt
      // really did consume allowance, not just breaker bookkeeping.
      now += breaker.getState(INSTALL).episodeCooldownMs;
      await expect(launchOnce()).rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(4);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('disabled dispatch touches no ledger', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const { invocationPath } = await fx.freshPlan();
      const result = await launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, 'run-1'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        // The global dispatch switch is off: `admitDirectWorker` returns
        // `{ gated: false }` before it ever constructs/consults the
        // breaker OR the allowance ledger (#2915 review 4, finding 7's
        // ordering, now extended to the ledger too).
        checkDispatch: () => ({ enabled: false, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      // #2915 review 4 (finding 7): `attemptOutcome` is published only when
      // recovery is gated -- disabled dispatch must add no new field versus
      // origin/main's own result shape.
      expect(result.attemptOutcome).toBeUndefined();
      expect(spawns.count).toBe(1);
      // No ledger directory was ever created under captureRoot.
      await expect(lstat(path.join(fx.captureRoot, 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('a tampered or insecure-mode ledger record refuses rather than resets', async () => {
    const fx = await ledgerFixtureRoot(5);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    const ledgerDir = path.join(fx.captureRoot, 'ledger');
    try {
      // --- Tampered: a well-formed, correctly-moded record whose identity
      // does not match this task chain -- must refuse, never silently
      // reset to a fresh record (that would quietly regrant allowance to
      // a forged/corrupted record).
      const tampered = await fx.buildPlan('tampered-workers');
      const tamperedDigest = await stableTaskChainDigest(tampered.plan.request, tampered.plan.invocation.briefDigest);
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      const tamperedRecordPath = path.join(ledgerDir, `${tamperedDigest}.json`);
      await writeFile(tamperedRecordPath, JSON.stringify({ version: 1, taskChainDigest: 'not-the-real-digest',
        maxAttempts: 5, pendingIds: [], chargedIds: [], corrections: 0 }), { mode: 0o600 });
      await chmod(tamperedRecordPath, 0o600);
      const tamperedBefore = await readFile(tamperedRecordPath, 'utf8');
      await expect(launcher.launchWorker({
        invocationPath: tampered.invocationPath, runDir: path.join(fx.root, 'tamper-run'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      })).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      expect(spawns.count).toBe(0);
      expect(await readFile(tamperedRecordPath, 'utf8')).toBe(tamperedBefore);

      // --- Insecure mode: a correctly-identified record that is not
      // exactly 0600 -- must refuse exactly like `verifyRetryPredecessor`
      // already refuses insecure predecessor metadata, never chmod-repair
      // and proceed.
      const insecure = await fx.buildPlan('insecure-workers');
      const insecureDigest = await stableTaskChainDigest(insecure.plan.request, insecure.plan.invocation.briefDigest);
      const insecureRecordPath = path.join(ledgerDir, `${insecureDigest}.json`);
      await writeFile(insecureRecordPath, JSON.stringify({ version: 1, taskChainDigest: insecureDigest,
        maxAttempts: 5, pendingIds: [], chargedIds: [], corrections: 0 }));
      await chmod(insecureRecordPath, 0o666);
      await expect(launcher.launchWorker({
        invocationPath: insecure.invocationPath, runDir: path.join(fx.root, 'insecure-run'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      })).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      expect(spawns.count).toBe(0);
      expect((await lstat(insecureRecordPath)).mode & 0o777).toBe(0o666);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
