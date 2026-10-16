import { describe, it, expect } from 'vitest';
import { ScopedFailureBreaker, RecoveryPolicy } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';

const scopeKeys = ['quota:shared', 'provider:vendor'];
function fixture() {
  let now = 0;
  const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
  for (const key of scopeKeys) {
    for (let i = 0; i < 3; i++) {
      const invocationId = `${key}:${i}`;
      const { token } = breaker.admit({ invocationId, scopeKeys: [key] });
      breaker.settle(token, { kind: 'failed', confirmedStop: true,
        reasonCode: key.startsWith('quota') ? 'RATE_LIMIT' : 'NETWORK',
        evidenceSource: 'launcher', quotaAccount: 'shared', inferenceProvider: 'vendor' });
    }
  }
  now = 120_000;
  return { breaker, advance: ms => { now += ms; } };
}
function dispatch(breaker, token) {
  expect(breaker.beginDispatch(token, { invocationId: token.invocationId, selectionDigest: null }).ok).toBe(true);
  expect(breaker.commitDispatch(token).ok).toBe(true);
}

describe('T-OG-22 preliminary recovery probe', () => {
  it('requires one shared 10s/64KiB probe, then one canary, before recovery', () => {
    const { breaker } = fixture();
    try {
      expect(breaker.admit({ invocationId: 'task', scopeKeys })).toMatchObject({ ok: false, probeRequired: scopeKeys });
      const { token } = breaker.admit({ invocationId: 'probe', scopeKeys, purpose: 'probe' });
      expect(token.deadlineMs - token.mintedAtMs).toBe(10_000);
      expect(token.maxOutputBytes).toBe(65_536);
      expect(breaker.admit({ invocationId: 'second-probe', scopeKeys, purpose: 'probe' }).ok).toBe(false);
      dispatch(breaker, token);
      breaker.settle(token, { kind: 'succeeded', relevant: true, evidenceSource: 'launcher', confirmedStop: true });
      for (const key of scopeKeys) expect(breaker.getState(key).state).toBe('canary-ready');
      const canary = breaker.admit({ invocationId: 'canary', scopeKeys });
      expect(canary.ok).toBe(true);
      expect(canary.token.purpose).toBe('task');
      expect(breaker.admit({ invocationId: 'second-task', scopeKeys }).ok).toBe(false);
      dispatch(breaker, canary.token);
      breaker.settle(canary.token, { kind: 'succeeded', confirmedStop: true });
      for (const key of scopeKeys) expect(breaker.getState(key).state).toBe('closed');
      expect(breaker.snapshot().attemptsObserved).toBe(8);
    } finally { breaker.destroy(); }
  });

  it('echo success cannot close upstream scopes and failed probes double backoff', () => {
    const { breaker, advance } = fixture();
    try {
      const { token } = breaker.admit({ invocationId: 'echo', scopeKeys, purpose: 'probe' });
      dispatch(breaker, token);
      breaker.settle(token, { kind: 'succeeded', relevant: false, evidenceSource: 'launcher', confirmedStop: true });
      for (const key of scopeKeys) expect(breaker.getState(key)).toMatchObject({ state: 'open', episodeCooldownMs: 240_000 });
      advance(239_999);
      expect(breaker.admit({ invocationId: 'too-soon', scopeKeys, purpose: 'probe' }).ok).toBe(false);
      advance(1);
      const failed = breaker.admit({ invocationId: 'failed', scopeKeys, purpose: 'probe' });
      dispatch(breaker, failed.token);
      breaker.settle(failed.token, { kind: 'failed', confirmedStop: true });
      expect(breaker.getState(scopeKeys[0]).episodeCooldownMs).toBe(480_000);
    } finally { breaker.destroy(); }
  });

  it('rechecks covering scopes and reset floors after asynchronous probe preparation', () => {
    const { breaker } = fixture();
    try {
      const covering = [...scopeKeys, 'installation:cli'];
      const admittedFailures = [0, 1, 2].map(n => breaker.admit({ invocationId: `install-${n}`, scopeKeys: ['installation:cli'] }).token);
      const { token } = breaker.admit({ invocationId: 'pending-probe', scopeKeys: covering, purpose: 'probe' });
      expect(breaker.beginDispatch(token, { invocationId: token.invocationId, selectionDigest: null }).ok).toBe(true);
      for (const failure of admittedFailures) breaker.settle(failure, { kind: 'failed', reasonCode: 'NOT_FOUND',
        evidenceSource: 'launcher', cli: 'cli', confirmedStop: true });
      expect(breaker.commitDispatch(token)).toMatchObject({ ok: false, reason: expect.stringContaining('installation:cli') });
      breaker.abortDispatch(token);
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally { breaker.destroy(); }
  });

  it('emits one actionable summary for each probe/canary transition and manual reset', () => {
    const { breaker } = fixture();
    const events = [];
    breaker.on('transition', event => events.push(event));
    try {
      const probe = breaker.admit({ invocationId: 'summarized-probe', scopeKeys, purpose: 'probe' });
      dispatch(breaker, probe.token);
      breaker.settle(probe.token, { kind: 'succeeded', relevant: true, evidenceSource: 'launcher', confirmedStop: true });
      const canary = breaker.admit({ invocationId: 'summarized-canary', scopeKeys });
      dispatch(breaker, canary.token);
      breaker.settle(canary.token, { kind: 'failed', confirmedStop: true });
      breaker.reset(scopeKeys[0]);
      breaker.reset(scopeKeys[0]);
      for (let i = 0; i < 5; i++) { breaker.snapshot(); breaker.admit({ invocationId: `blocked-${i}`, scopeKeys }); }
      expect(events.filter(event => event.scopeKey === scopeKeys[0]).map(event => event.to))
        .toEqual(['half-open', 'canary-ready', 'canary', 'open', 'closed']);
      expect(events.every(event => event.summary.includes(event.scopeKey) && event.action)).toBe(true);
    } finally { breaker.destroy(); }
  });

  it('expires a lost dispatched probe at 10s and retains stop proof before another probe', () => {
    const { breaker, advance } = fixture();
    try {
      const { token } = breaker.admit({ invocationId: 'lost', scopeKeys, purpose: 'probe' });
      dispatch(breaker, token);
      advance(RecoveryPolicy.probeTimeoutMs);
      expect(breaker.admit({ invocationId: 'next', scopeKeys, purpose: 'probe' }).ok).toBe(false);
      expect(breaker.getState(scopeKeys[0])).toMatchObject({ state: 'open', episodeCooldownMs: 240_000 });
      advance(900_000);
      expect(breaker.admit({ invocationId: 'still-live', scopeKeys, purpose: 'probe' }).ok).toBe(false);
      breaker.reconcileStopEvidence({ invocationId: 'lost', confirmedStop: true });
      expect(breaker.admit({ invocationId: 'stopped', scopeKeys, purpose: 'probe' }).ok).toBe(true);
    } finally { breaker.destroy(); }
  });
});
