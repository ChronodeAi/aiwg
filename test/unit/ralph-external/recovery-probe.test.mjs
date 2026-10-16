import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRecoveryProbe } from '../../../tools/ralph-external/lib/recovery-probe.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { admitDirectWorker, debitDirectWorkerAllowance, reserveDirectWorkerAllowance, settleDirectWorker,
  resetInProcessAllowanceLedger, ALLOWANCE_EXHAUSTED_CODE } from '../../../tools/ralph-external/session-launcher.mjs';

const endpoint = 'https://provider.invalid/account-health';
afterEach(() => { vi.restoreAllMocks(); resetInProcessAllowanceLedger(); });
function fixture() {
  return { driver: { qualification: { installation: { endpoints: [endpoint] } },
    buildInvocation: vi.fn(() => { throw new Error('Never execute a CLI as an uncontained probe'); }) },
  invocation: { transport: 'shell', selected: { cli: 'fixture' },
    argv: ['/untrusted-task-only-secret', '--setsid-descendant'], cwd: '/task-only-secret',
    limits: { wallSeconds: 300, maxAttempts: 3, costUsd: null } } };
}

describe('bounded qualified recovery probes', () => {
  it('T-OG-22 makes one relevant request to the exact qualified endpoint without task bytes or processes', async () => {
    const options = fixture();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const charged = vi.fn();
    const result = await runRecoveryProbe({ ...options, fetchImpl, onDispatch: charged });
    expect(result).toMatchObject({ success: true, relevant: true, termination: 'confirmed' });
    expect(charged).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(endpoint, {
      method: 'HEAD', redirect: 'error', signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('task-only-secret');
    expect(options.driver.buildInvocation).not.toHaveBeenCalled();
  });

  it.each(['echo', 'version'])('T-OG-22 %s cannot prove upstream recovery or launch escaped descendants', async kind => {
    const options = fixture();
    delete options.driver.qualification.installation.endpoints;
    options.invocation.argv = [kind, 'setsid', 'sleep', '300'];
    const fetchImpl = vi.fn();
    expect(await runRecoveryProbe({ ...options, fetchImpl })).toMatchObject({
      success: false, relevant: false, termination: 'confirmed', reason: 'probe-profile-unavailable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(options.driver.buildInvocation).not.toHaveBeenCalled();
  });

  it('worker-authored final claims never substitute for an unsuccessful endpoint observation', async () => {
    const options = fixture();
    options.invocation.final = { status: 'completed' };
    const result = await runRecoveryProbe({ ...options, fetchImpl: async () => new Response(null, { status: 503 }) });
    expect(result).toMatchObject({ success: false, relevant: false, reason: 'probe-failed' });
  });

  it('T-OG-22 aborts an unresponsive endpoint at the probe deadline', async () => {
    const started = performance.now();
    let signal;
    const result = await runRecoveryProbe({ ...fixture(), timeoutMs: 20,
      fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
    expect(result).toMatchObject({ success: false, reason: 'probe-timeout', termination: 'confirmed' });
    expect(signal.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('T-OG-22 bounds actual endpoint headers to 64KiB', async () => {
    const result = await runRecoveryProbe({ ...fixture(),
      fetchImpl: async () => new Response(null, { headers: { 'x-large': 'a'.repeat(65_536) } }) });
    expect(result).toMatchObject({ success: false, relevant: false, reason: 'probe-output-limit' });
  });

  it('cancels unexpected response bodies without reading output or task final files', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const result = await runRecoveryProbe({ ...fixture(), fetchImpl: async () => new Response(body) });
    expect(result).toMatchObject({ success: false, reason: 'probe-body-unexpected' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('refuses an endpoint absent from trusted installation qualification without dispatching', async () => {
    const options = fixture();
    delete options.driver.qualification.installation.endpoints;
    options.invocation.endpoint = endpoint;
    const dispatch = vi.fn();
    const fetchImpl = vi.fn();
    expect(await runRecoveryProbe({ ...options, onDispatch: dispatch, fetchImpl })).toMatchObject({
      success: false, reason: 'probe-profile-unavailable',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves an allowance refusal and sends no request', async () => {
    const fetchImpl = vi.fn();
    let charged = 0;
    await expect(runRecoveryProbe({ ...fixture(), fetchImpl,
      onDispatch: async () => { charged++; throw new Error('allowance-exhausted'); } })).rejects.toThrow('allowance-exhausted');
    expect(charged).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects bounds above the mandatory probe limits', async () => {
    await expect(runRecoveryProbe({ ...fixture(), timeoutMs: 10_001 })).rejects.toThrow(/10s\/64KiB/);
    await expect(runRecoveryProbe({ ...fixture(), maxOutputBytes: 65_537 })).rejects.toThrow(/10s\/64KiB/);
  });

  it('respects a later 429 reset during half-open probing', async () => {
    const { breaker, admissionOptions } = pausedFixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 429, headers: { 'retry-after': '600' } }));
    try {
      const admission = await admitDirectWorker({ ...admissionOptions, invocationId: 'rate-limited', maxAttempts: 2 });
      expect(admission.refused.code).toBe('RECOVERY_SCOPE_OPEN');
      expect(breaker.getState('quota:shared')).toMatchObject({ state: 'open', nextProbeAtMs: 720_000 });
    } finally { breaker.destroy(); }
  });
});

function pausedFixture(status = 200) {
  let now = 0;
  const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
  for (let i = 0; i < 3; i++) {
    const { token } = breaker.admit({ invocationId: `quota-failure-${i}`, scopeKeys: ['quota:shared'] });
    breaker.settle(token, { kind: 'failed', reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher',
      quotaAccount: 'shared', confirmedStop: true });
  }
  now = 120_000;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status }));
  const options = fixture();
  options.driver.qualification.installation.accountScope = 'shared';
  return { breaker, options, advance: ms => { now += ms; }, admissionOptions: { gateEnabled: true,
    config: { parallelism: { worker_dispatch: true } }, invocation: options.invocation,
    drivers: { fixture: options.driver }, scopedBreaker: breaker, taskChainDigest: 'probe-integration-chain' } };
}

describe('T-OG-22 production probe and canary cumulative allowance', () => {
  it('automatically probes before the task canary and charges both actual dispatches', async () => {
    const { breaker, admissionOptions } = pausedFixture();
    try {
      const admission = await admitDirectWorker({ ...admissionOptions, invocationId: 'canary', maxAttempts: 2 });
      expect(admission.refused).toBeUndefined();
      expect(admission.token.canaryKeys).toContain('quota:shared');
      expect(breaker.snapshot().attemptsObserved).toBe(4);
      expect(breaker.beginDispatch(admission.token, { invocationId: 'canary', selectionDigest: admission.selectionDigest }).ok).toBe(true);
      await debitDirectWorkerAllowance(admission.ledger);
      expect(breaker.commitDispatch(admission.token).ok).toBe(true);
      await settleDirectWorker(admission, { kind: 'succeeded', evidenceSource: 'launcher', confirmedStop: true });
      expect(breaker.getState('quota:shared').state).toBe('closed');
      expect(breaker.snapshot().attemptsObserved).toBe(5);
      const exhausted = await admitDirectWorker({ ...admissionOptions, invocationId: 'third-dispatch', maxAttempts: 2 });
      expect(exhausted.refused?.code).toBe(ALLOWANCE_EXHAUSTED_CODE);
    } finally { breaker.destroy(); resetInProcessAllowanceLedger(); }
  });

  it('T-OG-22 reports unavailable profiles once as operator intervention instead of infinite backoff', async () => {
    const { breaker, admissionOptions, options, advance } = pausedFixture();
    delete options.driver.qualification.installation.endpoints;
    const summaries = vi.fn();
    try {
      const admission = await admitDirectWorker({ ...admissionOptions, invocationId: 'no-profile', maxAttempts: 2,
        onTransition: summaries });
      expect(admission.refused).toMatchObject({ code: 'RECOVERY_OPERATOR_INTERVENTION',
        reason: expect.stringContaining('restore a qualified scope-relevant probe'),
        probeDiagnostic: { reason: 'probe-profile-unavailable', operatorIntervention: true } });
      const state = breaker.getState('quota:shared');
      expect(state.state).toBe('operator-intervention');
      const reports = summaries.mock.calls.length;
      for (let n = 0; n < 3; n++) {
        advance(1_000_000);
        const again = await admitDirectWorker({ ...admissionOptions, invocationId: `no-profile-${n}`, maxAttempts: 2,
          onTransition: summaries });
        expect(again.refused.code).toBe('RECOVERY_OPERATOR_INTERVENTION');
        expect(breaker.getState('quota:shared').episodeCooldownMs).toBe(state.episodeCooldownMs);
      }
      expect(summaries).toHaveBeenCalledTimes(reports);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      const unused = await reserveDirectWorkerAllowance({ taskChainDigest: admissionOptions.taskChainDigest,
        invocationId: 'unused', maxAttempts: 2 });
      await debitDirectWorkerAllowance(unused);
    } finally { breaker.destroy(); }
  });

  it('a failed upstream probe backs off and consumes exactly one remaining slot', async () => {
    const { breaker, admissionOptions } = pausedFixture(503);
    try {
      const admission = await admitDirectWorker({ ...admissionOptions, invocationId: 'blocked-canary', maxAttempts: 2 });
      expect(admission.refused?.code).toBe('RECOVERY_SCOPE_OPEN');
      expect(breaker.getState('quota:shared')).toMatchObject({ state: 'open', episodeCooldownMs: 240_000 });
      expect(breaker.snapshot().attemptsObserved).toBe(4);
      const remaining = await reserveDirectWorkerAllowance({ taskChainDigest: admissionOptions.taskChainDigest,
        invocationId: 'one-slot-left', maxAttempts: 2 });
      await debitDirectWorkerAllowance(remaining);
      await expect(reserveDirectWorkerAllowance({ taskChainDigest: admissionOptions.taskChainDigest,
        invocationId: 'no-slots-left', maxAttempts: 2 })).rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
    } finally { breaker.destroy(); resetInProcessAllowanceLedger(); }
  });

  it('an expired task budget prevents the preliminary probe and preserves allowance', async () => {
    const { breaker, admissionOptions } = pausedFixture();
    try {
      const admission = await admitDirectWorker({ ...admissionOptions, invocationId: 'expired', maxAttempts: 1,
        dispatchGuard: { deadlineAtMs: 1, nowMs: () => 2 } });
      expect(admission.refused?.code).toBe('RECOVERY_SCOPE_OPEN');
      expect(breaker.snapshot().attemptsObserved).toBe(3);
      const remaining = await reserveDirectWorkerAllowance({ taskChainDigest: admissionOptions.taskChainDigest,
        invocationId: 'still-available', maxAttempts: 1 });
      await debitDirectWorkerAllowance(remaining);
    } finally { breaker.destroy(); resetInProcessAllowanceLedger(); }
  });

  it('includes probe time in the task admission budget instead of granting a fresh wall allowance', async () => {
    const { breaker, admissionOptions, advance } = pausedFixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { advance(25); return new Response(null); });
    try {
      const admission = await admitDirectWorker({ ...admissionOptions, invocationId: 'timed-canary', maxAttempts: 2 });
      expect(admission.startedAtMs).toBe(120_000);
      expect(admission.token.mintedAtMs).toBe(120_025);
      await settleDirectWorker(admission, { kind: 'uncertain', confirmedStop: true });
    } finally { breaker.destroy(); }
  });

  it('a successful probe using the final allowance refuses the task canary', async () => {
    const { breaker, admissionOptions } = pausedFixture();
    try {
      const admission = await admitDirectWorker({ ...admissionOptions, invocationId: 'unfunded-canary', maxAttempts: 1 });
      expect(admission.refused?.code).toBe(ALLOWANCE_EXHAUSTED_CODE);
      expect(breaker.snapshot().attemptsObserved).toBe(4);
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally { breaker.destroy(); resetInProcessAllowanceLedger(); }
  });
});
