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
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
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
  recordDirectWorkerOutcome,
  planDirectWorkerLaunch,
} from '../../../tools/ralph-external/session-launcher.mjs';

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

describe('RecoveryPolicy explicit bounds', () => {
  it('pins every loop to an explicit number', () => {
    expect(RecoveryPolicy.distinctThreshold).toBe(3);
    expect(RecoveryPolicy.windowMs).toBe(120_000);
    expect(RecoveryPolicy.minOutstanding).toBe(2);
    expect(RecoveryPolicy.cooldownMs).toBe(120_000);
    expect(RecoveryPolicy.maxCooldownMs).toBe(900_000);
    expect(RecoveryPolicy.probeTimeoutMs).toBe(10_000);
    expect(RecoveryPolicy.probeMaxBytes).toBe(65_536);
    expect(RecoveryPolicy.canaryTimeoutMs).toBe(300_000);
    expect(RecoveryPolicy.maxProbesPerEpisode).toBe(4);
    expect(RecoveryPolicy.maxCanariesPerEpisode).toBe(1);
  });

  it('rejects unbounded or out-of-range policy overrides', () => {
    for (const policy of [
      { cooldownMs: Number.NaN },
      { cooldownMs: Number.POSITIVE_INFINITY },
      { distinctThreshold: 0 },
      { maxCooldownMs: 1 },
      { probeTimeoutMs: -5 },
      { maxProbesPerEpisode: 1.5 },
      { backoffMultiplier: 0.5 },
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
  let summaries;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    summaries = [];
    breaker.on('summary', (s) => summaries.push(s));
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  it('opens the narrowest scope at three distinct failures in 120s', () => {
    expect(breaker.recordFailure(installFailure('a')).opened).toBe(false);
    expect(breaker.recordFailure(installFailure('b')).opened).toBe(false);
    const third = breaker.recordFailure(installFailure('c'));
    expect(third.opened).toBe(true);
    expect(breaker.getState(INSTALL).state).toBe('open');

    // Covered launches stop by the next check; unaffected scopes continue.
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(false);
    expect(breaker.canLaunch({ scopeKeys: [scopeKeyFor.installation('claude')] }).ok).toBe(true);
    expect(breaker.canLaunch({ scopeKeys: [PROVIDER, QUOTA, HOST] }).ok).toBe(true);
  });

  it('counts each distinct invocation once per window', () => {
    breaker.recordFailure(installFailure('a'));
    breaker.recordFailure(installFailure('a'));
    breaker.recordFailure(installFailure('a'));
    expect(breaker.getState(INSTALL).distinctFailures).toBe(1);
    expect(breaker.getState(INSTALL).state).toBe('closed');
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(true);
  });

  it('opens when all of two outstanding attempts fail, stays shut for two-of-five', () => {
    breaker.noteLaunched([INSTALL], 'a');
    breaker.noteLaunched([INSTALL], 'b');
    breaker.recordFailure(installFailure('a'));
    expect(breaker.recordFailure(installFailure('b')).opened).toBe(true);

    breaker.reset(INSTALL);
    for (const id of ['c', 'd', 'e', 'f', 'g']) breaker.noteLaunched([INSTALL], id);
    breaker.recordFailure(installFailure('c'));
    expect(breaker.recordFailure(installFailure('d')).opened).toBe(false);
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('prunes failures outside the rolling window', () => {
    breaker.recordFailure(installFailure('a'));
    breaker.recordFailure(installFailure('b'));
    vi.advanceTimersByTime(121_000);
    breaker.recordFailure(installFailure('c'));
    expect(breaker.recordFailure(installFailure('d')).opened).toBe(false);
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('never opens a wider scope for independent task failures', () => {
    for (const id of ['t1', 't2', 't3']) {
      breaker.recordFailure({ scope: FailureScope.INVOCATION, scopeKey: scopeKeyFor.invocation(id), invocationId: id, reasonCode: 'TASK_ASSERT_FAILED' });
    }
    expect(breaker.canLaunch({ scopeKeys: [PROVIDER, INSTALL, QUOTA, HOST] }).ok).toBe(true);
    expect(breaker.getState(PROVIDER).tracked).toBe(false);
  });

  it('emits exactly one actionable summary per transition, never per-tick noise', () => {
    breaker.recordFailure(installFailure('a'));
    breaker.recordFailure(installFailure('b'));
    breaker.recordFailure(installFailure('c'));
    breaker.recordFailure(installFailure('d'));
    expect(summaries.filter((s) => s.transition === 'opened')).toHaveLength(1);
    const opened = summaries[0];
    expect(opened.affectedAttempts.sort()).toEqual(['a', 'b', 'c']);
    expect(opened.remedy).toBeTruthy();
    expect(opened.nextProbeAtMs).toBeGreaterThan(0);
    expect(opened.costUsd).toBeNull();

    // Repeated launch checks emit nothing.
    breaker.canLaunch({ scopeKeys: [INSTALL] });
    breaker.canLaunch({ scopeKeys: [INSTALL] });
    expect(summaries).toHaveLength(1);
  });

  it('shares quota scope across CLIs and honors the 429 reset', () => {
    breaker.recordFailure(trustedQuotaFailure('q1', 'codex', { retryAfterSeconds: 300 }));
    breaker.recordFailure(trustedQuotaFailure('q2', 'cursor', { retryAfterSeconds: 300 }));
    expect(breaker.recordFailure(trustedQuotaFailure('q3', 'codex', { retryAfterSeconds: 300 })).opened).toBe(true);
    const state = breaker.getState(QUOTA);
    expect(state.resetAtMs).toBe(Date.now() + 300_000);
    // Earliest probe is max(120s cooldown, reset): still not due at +121s.
    vi.advanceTimersByTime(121_000);
    expect(breaker.reserveProbe(QUOTA).reason).toBe('not-due');
    vi.advanceTimersByTime(180_000);
    expect(breaker.reserveProbe(QUOTA).ok).toBe(true);
  });

  it('refuses to open the quota scope on worker-claimed 429 without trusted account identity', () => {
    // Scope-poisoning regression at the recordFailure enforcement point: a
    // wide claim on untrusted evidence folds back instead of opening.
    for (const id of ['w1', 'w2', 'w3']) {
      breaker.recordFailure({ scope: FailureScope.QUOTA, scopeKey: QUOTA, invocationId: id,
        reasonCode: 'RATE_LIMIT', evidenceSource: 'worker', cli: 'codex', quotaAccount: 'acct-1' });
    }
    expect(breaker.getState(QUOTA).tracked).toBe(false);
    expect(breaker.canLaunch({ scopeKeys: [QUOTA] }).ok).toBe(true);
  });

  it('falls back to bounded backoff on a malformed reset', () => {
    const t0 = Date.now();
    breaker.recordFailure(trustedQuotaFailure('m1', 'codex', { retryAfterSeconds: Number.NaN }));
    breaker.recordFailure(trustedQuotaFailure('m2', 'codex', { resetAtMs: -5 }));
    breaker.recordFailure(trustedQuotaFailure('m3', 'codex'));
    const state = breaker.getState(QUOTA);
    expect(state.state).toBe('open');
    expect(state.resetAtMs).toBeNull();
    expect(state.nextProbeAtMs).toBe(t0 + 120_000); // deterministic: zero jitter
    vi.advanceTimersByTime(120_000);
    expect(breaker.reserveProbe(QUOTA).ok).toBe(true);
  });

  it('pushes the next probe out when a later failure carries a further reset', () => {
    // Updated-reset regression: reset 420s must move nextProbeAtMs, so no
    // probe is admitted at +120s.
    breaker.recordFailure(trustedQuotaFailure('r1', 'codex'));
    breaker.recordFailure(trustedQuotaFailure('r2', 'codex'));
    expect(breaker.recordFailure(trustedQuotaFailure('r3', 'codex')).opened).toBe(true);
    const openedProbeAt = breaker.getState(QUOTA).nextProbeAtMs;
    expect(openedProbeAt).toBeGreaterThan(0);
    breaker.recordFailure(trustedQuotaFailure('r4', 'codex', { retryAfterSeconds: 420 }));
    const state = breaker.getState(QUOTA);
    expect(state.resetAtMs).toBe(Date.now() + 420_000);
    expect(state.nextProbeAtMs).toBeGreaterThanOrEqual(state.resetAtMs);
    vi.advanceTimersByTime(120_000);
    expect(breaker.reserveProbe(QUOTA).reason).toBe('not-due');
    vi.advanceTimersByTime(300_000);
    expect(breaker.reserveProbe(QUOTA).ok).toBe(true);
  });

  it('stops cross-provider retries while the corroborated host scope is open', () => {
    const hostFailure = (id) => ({ scope: FailureScope.HOST, scopeKey: HOST, invocationId: id,
      reasonCode: 'RESOURCE', evidenceSource: 'launcher', cli: 'codex',
      corroboratedBackends: ['openai', 'anthropic'] });
    for (const id of ['h1', 'h2', 'h3']) breaker.recordFailure(hostFailure(id));
    expect(breaker.getState(HOST).state).toBe('open');
    expect(breaker.canLaunch({ scopeKeys: [scopeKeyFor.installation('claude'), PROVIDER, HOST] }).ok).toBe(false);
  });

  it('promotes a genuine provider outage beyond invocation scope by the distinct-invocation rule', () => {
    // Outage-promotion regression: 20 distinct stalls with no trusted
    // evidence stay invocation-scoped and launchable...
    for (let n = 0; n < 20; n += 1) {
      breaker.recordFailure({ scope: FailureScope.INVOCATION, scopeKey: scopeKeyFor.invocation(`stall-${n}`),
        invocationId: `stall-${n}`, reasonCode: 'NO_PROGRESS', evidenceSource: 'worker' });
    }
    expect(breaker.getState(PROVIDER).tracked).toBe(false);
    expect(breaker.canLaunch({ scopeKeys: [PROVIDER] }).ok).toBe(true);
    // ...while N distinct invocations carrying the same TRUSTED backend
    // evidence open the provider scope.
    const netFailure = (id) => ({ scope: FailureScope.PROVIDER, scopeKey: PROVIDER, invocationId: id,
      reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', inferenceProvider: 'openai' });
    expect(breaker.recordFailure(netFailure('p1')).opened).toBe(false);
    expect(breaker.recordFailure(netFailure('p2')).opened).toBe(false);
    expect(breaker.recordFailure(netFailure('p3')).opened).toBe(true);
    expect(breaker.getState(PROVIDER).state).toBe('open');
    expect(breaker.canLaunch({ scopeKeys: [PROVIDER] }).ok).toBe(false);
    // A different backend is unaffected by this outage.
    expect(breaker.canLaunch({ scopeKeys: [scopeKeyFor.provider('anthropic')] }).ok).toBe(true);
  });

  it('retains still-recent failures across the cohort epoch boundary', () => {
    // Rolling-window regression: failures at 0, 119s, 120.001s and 120.002s
    // hold three in-window distinct failures at the end and must open.
    breaker.recordFailure(installFailure('e0'));
    vi.advanceTimersByTime(119_000);
    breaker.recordFailure(installFailure('e1'));
    vi.advanceTimersByTime(1_001);
    breaker.recordFailure(installFailure('e2'));
    vi.advanceTimersByTime(1);
    expect(breaker.recordFailure(installFailure('e3')).opened).toBe(true);
    expect(breaker.getState(INSTALL).state).toBe('open');
  });

  it('freezes cohort membership: late joiners neither open nor veto', () => {
    breaker.noteLaunched([INSTALL], 'a');
    breaker.noteLaunched([INSTALL], 'b');
    breaker.recordFailure(installFailure('a'));
    // 'c' launches after the cohort froze: it never joins, so the unanimous
    // failure of the original pair still opens the scope...
    breaker.noteLaunched([INSTALL], 'c');
    expect(breaker.recordFailure(installFailure('b')).opened).toBe(true);
    expect(breaker.getState(INSTALL).cohortSize).toBe(2);
  });
});

describe('bounded probe and canary episodes', () => {
  let breaker;
  let summaries;

  const openInstall = () => {
    breaker.recordFailure(installFailure('a'));
    breaker.recordFailure(installFailure('b'));
    breaker.recordFailure(installFailure('c'));
    expect(breaker.getState(INSTALL).state).toBe('open');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    summaries = [];
    breaker.on('summary', (s) => summaries.push(s));
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  it('runs one verified relevant probe, one canary, then recovers', () => {
    openInstall();
    expect(breaker.reserveProbe(INSTALL).reason).toBe('not-due');
    vi.advanceTimersByTime(120_000);
    const { reservation } = breaker.reserveProbe(INSTALL);
    expect(reservation.deadlineMs - reservation.reservedAtMs).toBe(10_000);
    expect(reservation.maxBytes).toBe(65_536);
    // A relevant success WITHOUT launcher verification never advances.
    expect(breaker.completeProbe(reservation.id, { ok: true, evidenceSource: 'worker' }).transition)
      .toBe('echo-insufficient');
    expect(breaker.getState(INSTALL).state).toBe('open');
    vi.advanceTimersByTime(120_000);
    const second = breaker.reserveProbe(INSTALL);
    expect(second.ok).toBe(true);
    expect(breaker.completeProbe(second.reservation.id, { ok: true, evidenceSource: 'launcher' }).transition)
      .toBe('canary-admitted');

    // The scope stays gated until the single canary succeeds.
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(false);
    expect(breaker.reserveProbe(INSTALL).reason).toBe('canary-pending');
    const canary = breaker.reserveCanary(INSTALL);
    expect(canary.ok).toBe(true);
    expect(breaker.reserveProbe(INSTALL).reason).toBe('canary-pending');
    expect(breaker.reserveCanary(INSTALL).reason).toBe('no-canary-pending');
    // An unverified canary "success" never recovers...
    expect(breaker.completeCanary(INSTALL, { ok: true, canaryId: canary.canary.id }).transition)
      .toBe('canary-unverified');
    expect(breaker.getState(INSTALL).state).toBe('open');
    // ...but a launcher-verified canary on a fresh cycle does.
    vi.advanceTimersByTime(120_000);
    const probe = breaker.reserveProbe(INSTALL);
    expect(breaker.completeProbe(probe.reservation.id, { ok: true, evidenceSource: 'launcher' }).transition)
      .toBe('canary-admitted');
    const canary2 = breaker.reserveCanary(INSTALL);
    expect(breaker.completeCanary(INSTALL, { ok: true, evidenceSource: 'launcher', canaryId: canary2.canary.id }).transition)
      .toBe('recovered');
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(true);
    expect(breaker.snapshot().canariesCharged).toBe(2);
  });

  it('refuses canary completion with no reservation', () => {
    // Unauthorized-canary regression: completeCanary without any admitted
    // canary must not recover an open scope.
    openInstall();
    expect(breaker.completeCanary(INSTALL, { ok: true, evidenceSource: 'launcher' }))
      .toEqual({ ok: false, reason: 'no-canary-reservation' });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(false);
  });

  it('probes unrelated scopes independently but never concurrently within one scope', () => {
    openInstall();
    for (const id of ['x', 'y', 'z']) breaker.recordFailure(trustedQuotaFailure(id, 'codex'));
    vi.advanceTimersByTime(120_000);
    const first = breaker.reserveProbe(INSTALL);
    expect(first.ok).toBe(true);
    // Same scope, second reservation: refused while one is active...
    expect(breaker.reserveProbe(INSTALL).reason).toBe('probe-already-active');
    // ...but an unrelated scope probes independently.
    const other = breaker.reserveProbe(QUOTA);
    expect(other.ok).toBe(true);
    expect(breaker.completeProbe(first.reservation.id, { ok: false }).transition).toBe('probe-failed');
    expect(breaker.completeProbe(other.reservation.id, { ok: false }).transition).toBe('probe-failed');

    // Failed probes double the cooldown: next probe due at +240s, not +120s.
    vi.advanceTimersByTime(120_000);
    expect(breaker.reserveProbe(INSTALL).reason).toBe('not-due');
    vi.advanceTimersByTime(120_000);
    expect(breaker.reserveProbe(INSTALL).ok).toBe(true);
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
  });

  it('accounts a hung probe as failed and frees the reservation on expiry', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const hung = breaker.reserveProbe(INSTALL);
    expect(hung.ok).toBe(true);
    // The probe hangs: past its 10s deadline the next check accounts it as
    // failed (backoff) and closes the reservation, so a fresh probe can be
    // admitted once due. A never-completed probe monopolizes nothing.
    vi.advanceTimersByTime(10_001);
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(false);
    expect(summaries.map((s) => s.transition)).toContain('probe-expired');
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    expect(breaker.getState(INSTALL).activeProbe).toBeNull();
    // The stale completion for the expired id is refused, not honored.
    expect(breaker.completeProbe(hung.reservation.id, { ok: true, evidenceSource: 'launcher' }))
      .toEqual({ ok: false, reason: 'unknown-probe' });
    vi.advanceTimersByTime(240_000);
    const fresh = breaker.reserveProbe(INSTALL);
    expect(fresh.ok).toBe(true);
    expect(fresh.reservation.id).not.toBe(hung.reservation.id);
  });

  it('caps backoff at 900s and bounds the episode probe count', () => {
    openInstall();
    let at = 120_000;
    vi.advanceTimersByTime(at);
    // Three failed probes: cooldowns 240s, 480s, then capped 900s.
    const cooldowns = [240_000, 480_000, 900_000];
    for (const expected of cooldowns) {
      const r = breaker.reserveProbe(INSTALL);
      expect(r.ok).toBe(true);
      breaker.completeProbe(r.reservation.id, { ok: false });
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(expected);
      at += expected;
      vi.advanceTimersByTime(expected);
    }
    // Fourth probe is an echo success: never closes the outage, exhausts the episode.
    const echo = breaker.reserveProbe(INSTALL, { kind: 'echo' });
    expect(echo.ok).toBe(true);
    expect(breaker.completeProbe(echo.reservation.id, { ok: true }).transition).toBe('probes-exhausted');
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.reserveProbe(INSTALL).reason).toBe('probe-budget-exhausted');
    expect(breaker.probesCharged).toBe(4);
  });

  it('charges every launched attempt, probe and canary once and keeps unknown cost unknown', () => {
    breaker.recordFailure(installFailure('same'));
    breaker.recordFailure(installFailure('same'));
    expect(breaker.snapshot().attemptsCharged).toBe(1);
    // A successful launched attempt is charged too (review: successes
    // charged 0), exactly once even across repeated reports.
    breaker.noteLaunched([INSTALL], 'ok-1');
    breaker.recordSuccess({ scopeKey: INSTALL, invocationId: 'ok-1' });
    breaker.recordSuccess({ scopeKey: INSTALL, invocationId: 'ok-1' });
    expect(breaker.snapshot().attemptsCharged).toBe(2);
    // An uncertain termination is charged but opens nothing.
    breaker.noteUncertainTermination({ scopeKeys: [INSTALL], invocationId: 'u-1' });
    expect(breaker.snapshot().attemptsCharged).toBe(3);
    expect(breaker.getState(INSTALL).state).toBe('closed');
    expect(summaries.every((s) => s.costUsd === null)).toBe(true);
  });

  it('expires a hung canary with backoff instead of gating forever', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const probe = breaker.reserveProbe(INSTALL);
    breaker.completeProbe(probe.reservation.id, { ok: true, evidenceSource: 'launcher' });
    const canary = breaker.reserveCanary(INSTALL);
    expect(canary.ok).toBe(true);
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(false);
    vi.advanceTimersByTime(300_001);
    expect(breaker.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(false);
    expect(summaries.map((s) => s.transition)).toContain('canary-expired');
    expect(breaker.getState(INSTALL).activeCanary).toBeNull();
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

  it('blocks launchWorker before any spawn on uncertain termination', async () => {
    const launcher = new SessionLauncher();
    await expect(launcher.launchWorker({ afterAttempt: { termination: 'uncertain' } })).rejects.toMatchObject({
      code: STOP_BEFORE_RETRY_CODE,
    });
    expect(launcher.lastAttemptResult).toBeNull();
  });

  it('blocks a same-launcher retry on the stored uncertain attempt even when afterAttempt is omitted', async () => {
    // Default-on regression: the gate reads lastAttemptResult, so omitting
    // afterAttempt after an uncertain attempt still blocks.
    const launcher = new SessionLauncher();
    launcher.lastAttemptResult = { termination: 'uncertain', invocationId: 'prev-1' };
    launcher.lastAttemptInvocationId = 'prev-1';
    await expect(launcher.launchWorker({})).rejects.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
    expect(launcher.lastAttemptResult.invocationId).toBe('prev-1');
  });

  it('blocks a same-launcher retry on unrelated confirmed evidence', async () => {
    const launcher = new SessionLauncher();
    launcher.lastAttemptResult = { termination: 'confirmed', invocationId: 'prev-1' };
    launcher.lastAttemptInvocationId = 'prev-1';
    await expect(launcher.launchWorker({ afterAttempt: { termination: 'confirmed', invocationId: 'other' } }))
      .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
  });

  it('refuses a conductor-declared startup correction past its single budget', async () => {
    const launcher = new SessionLauncher();
    await expect(launcher.launchWorker({ correctStartup: { reasonCode: 'AUTH', correctionsUsed: 0 } }))
      .rejects.toMatchObject({ code: 'STARTUP_CORRECTION_REFUSED' });
    await expect(launcher.launchWorker({ correctStartup: { reasonCode: 'STDIN_WAIT', correctionsUsed: 1 } }))
      .rejects.toMatchObject({ code: 'STARTUP_CORRECTION_REFUSED' });
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

  it('derives covering keys from trusted resolved identities only', () => {
    expect(recoveryScopeKeysForInvocation(
      { selected: { cli: 'codex', inferenceProvider: 'openai' } }, { invocationId: 'i-1', quotaAccount: 'acct-1' }))
      .toEqual(['invocation:i-1', 'installation:codex', 'provider:openai', 'quota:acct-1']);
    expect(recoveryScopeKeysForInvocation({ selected: {} }, {})).toEqual([]);
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

describe('recordDirectWorkerOutcome', () => {
  it('records bridge outcomes invocation-scoped and settles cohort membership', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const keys = ['invocation:r-1', 'installation:codex', 'provider:openai'];
      breaker.noteLaunched(keys, 'r-1');
      recordDirectWorkerOutcome(breaker, { scopeKeys: keys, invocationId: 'r-1',
        outcome: { termination: 'confirmed', exitCode: 3 } });
      expect(breaker.getState('installation:codex').tracked).toBe(false);
      expect(breaker.getState('provider:openai').tracked).toBe(false);
      expect(breaker.snapshot().attemptsCharged).toBe(1);
      recordDirectWorkerOutcome(breaker, { scopeKeys: keys, invocationId: 'r-2',
        outcome: { termination: 'confirmed', exitCode: 0 } });
      expect(breaker.snapshot().attemptsCharged).toBe(2);
      recordDirectWorkerOutcome(breaker, { scopeKeys: keys, invocationId: 'r-3',
        outcome: { termination: 'uncertain', exitCode: null } });
      expect(breaker.snapshot().attemptsCharged).toBe(3);
    } finally {
      breaker.destroy();
    }
  });
});

describe('planDirectWorkerLaunch recovery gate', () => {
  it('refuses a covered launch before any spawn and passes an unaffected one to the dispatch gate', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) breaker.recordFailure(installFailure(id));
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      const blocked = await planDirectWorkerLaunch({ invocation, scopedBreaker: breaker });
      expect(blocked.launched).toBe(false);
      expect(blocked.blocked).toBe(true);
      expect(blocked.recoveryBlocked).toEqual(['installation:codex']);
      // An unrelated CLI is unaffected and reaches the dispatch gate (which
      // refuses here on degraded isolation without ever spawning).
      const other = await planDirectWorkerLaunch({
        invocation: { selected: { cli: 'other-cli', inferenceProvider: 'other-backend' }, stdin: 'closed' },
        scopedBreaker: breaker,
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
      const out = await planDirectWorkerLaunch({ command: '/nonexistent', args: [], cwd: '/tmp', scopedBreaker: breaker });
      expect(out.recoveryBlocked).toBeUndefined();
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
    for (const id of ['a', 'b', 'c']) first.recordFailure(installFailure(id));
    expect(first.getState(INSTALL).state).toBe('open');
    first.destroy();
    const restarted = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      expect(restarted.getState(INSTALL).tracked).toBe(false);
      expect(restarted.canLaunch({ scopeKeys: [INSTALL] }).ok).toBe(true);
    } finally {
      restarted.destroy();
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
      expect(breaker.snapshot().attemptsCharged).toBe(3);
      // Launcher-verified probe → canary → recovery reopens dispatch.
      now += 121_000;
      const probe = breaker.reserveProbe(INSTALL);
      expect(probe.ok).toBe(true);
      expect(breaker.completeProbe(probe.reservation.id, { ok: true, evidenceSource: 'launcher' }).transition)
        .toBe('canary-admitted');
      const canary = breaker.reserveCanary(INSTALL);
      expect(canary.ok).toBe(true);
      expect(breaker.completeCanary(INSTALL, { ok: true, evidenceSource: 'launcher', canaryId: canary.canary.id }).transition)
        .toBe('recovered');
      // The retry proceeds (and fails at spawn again — recorded, scope
      // closed — proving the refusal was the scope, not the fixture).
      const retry = await launchOnce();
      expect(retry).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(breaker.snapshot().attemptsCharged).toBe(4);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);
});
