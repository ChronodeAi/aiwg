/** T-OG-24 S1: pure health→trace/lease mapping vectors; synthetic data only. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HEALTH_ACTIVITY_SUMMARY_MAX_UTF8_BYTES,
  HEALTH_KNOWN_REASON_CODES,
  advanceProgressWatermark,
  boundTraceText,
  classifyHealthTrace,
  decideLeaseMapping,
  healthLifecycleDigest,
  healthReasonLabel,
  projectHealthTrace,
  stopProofFromHealth,
  validateWorkerPayload,
  workerContractSchemaId,
  WorkerContractError,
  type LeaseMappingInput,
  type WorkerHealthSummary,
} from '../../../src/mission-protocol/index.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';

const baseHealth: WorkerHealthSummary = {
  version: 1,
  state: 'active',
  coverage: 'full',
  handshake: 'semantic',
  lastObservedAt: '2026-10-08T00:00:01Z',
  lastActivityAt: '2026-10-08T00:00:01Z',
  lastProgressAt: '2026-10-08T00:00:01Z',
  reasonCode: 'PROGRESS',
  termination: 'running',
  transitionCount: 3,
  restartCount: 0,
  unavailableSignals: [],
  transitionRefs: [],
  observerGeneration: 7,
  startupDeadlineAt: null,
  hardDeadlineAt: null,
  maxCheckGapSeconds: 15,
  confidence: 'observed',
  handshakeAt: '2026-10-08T00:00:00Z',
  stalledAt: null,
};

const health = (overrides: Partial<WorkerHealthSummary>): WorkerHealthSummary => ({ ...baseHealth, ...overrides });

describe('T-OG-24 health trace classification', () => {
  it.each([
    ['launching', 'running', null, 'setup'],
    ['started', 'running', null, 'setup'],
    ['active', 'running', '2026-10-08T00:00:01Z', 'productive'],
    ['active', 'running', null, 'activity-only'],
    ['quiet', 'running', null, 'quiet'],
    ['stalled', 'running', null, 'stalled'],
    ['hung', 'running', null, 'stalled'],
    ['active', 'uncertain', null, 'uncertain'],
    ['quiet', 'uncertain', null, 'uncertain'],
    ['crashed', 'running', null, 'terminal-unconfirmed'],
    ['failed-to-start', 'running', null, 'terminal-unconfirmed'],
    ['crashed', 'confirmed', null, 'terminal-proof'],
    ['completed', 'confirmed', null, 'terminal-proof'],
    ['failed', 'confirmed', null, 'terminal-proof'],
    ['cancelled', 'confirmed', null, 'terminal-proof'],
    ['completed', 'uncertain', null, 'terminal-unconfirmed'],
    ['failed', 'running', null, 'terminal-unconfirmed'],
    ['active', 'confirmed', '2026-10-08T00:00:01Z', 'uncertain'],
    ['quiet', 'confirmed', null, 'uncertain'],
    ['launching', 'confirmed', null, 'uncertain'],
  ] as const)('state=%s termination=%s progress=%s => %s', (state, termination, progress, expected) => {
    expect(classifyHealthTrace(health({ state, termination, lastProgressAt: progress }))).toBe(expected);
  });

  it('downgrades confirmed termination with a non-terminal state: never productive, never proof', () => {
    const contradictory = health({ state: 'active', termination: 'confirmed' });
    expect(classifyHealthTrace(contradictory)).toBe('uncertain');
    expect(projectHealthTrace(contradictory).progressCredit).toBe(false);
    expect(stopProofFromHealth(contradictory)).toBe('uncertain');
  });

  it('maps quiet, stalled and uncertain distinctly', () => {
    const kinds = new Set([
      classifyHealthTrace(health({ state: 'quiet' })),
      classifyHealthTrace(health({ state: 'stalled' })),
      classifyHealthTrace(health({ state: 'active', termination: 'uncertain', lastProgressAt: null })),
    ]);
    expect(kinds).toEqual(new Set(['quiet', 'stalled', 'uncertain']));
  });

  it('never credits heartbeat/lease-only observation as productive work', () => {
    const heartbeatOnly = health({ state: 'active', lastProgressAt: null, lastActivityAt: '2026-10-08T00:00:02Z' });
    expect(validateWorkerPayload('workerHealthSummary', heartbeatOnly).valid).toBe(true);
    expect(projectHealthTrace(heartbeatOnly).progressCredit).toBe(false);
    expect(projectHealthTrace(health({ state: 'launching', lastProgressAt: null, lastActivityAt: null })).progressCredit).toBe(false);
  });

  it('credits only fresh progress: heartbeat replays earn nothing, new progress credits once', () => {
    const progress = health({ lastProgressAt: '2026-10-08T00:00:01Z' });
    expect(projectHealthTrace(progress).progressCredit).toBe(true);
    const heartbeat = health({ lastProgressAt: '2026-10-08T00:00:01Z', lastActivityAt: '2026-10-08T00:00:02Z', lastObservedAt: '2026-10-08T00:00:02Z' });
    const replay = projectHealthTrace(heartbeat, 'active', progress);
    expect(replay.kind).toBe('productive');
    expect(replay.progressCredit).toBe(false);
    const repeated = health({ lastProgressAt: '2026-10-08T00:00:01Z', lastActivityAt: '2026-10-08T00:00:03Z', lastObservedAt: '2026-10-08T00:00:03Z' });
    expect(projectHealthTrace(repeated, 'active', heartbeat).progressCredit).toBe(false);
    const fresh = health({ lastProgressAt: '2026-10-08T00:00:04Z', lastActivityAt: '2026-10-08T00:00:04Z', lastObservedAt: '2026-10-08T00:00:04Z' });
    expect(projectHealthTrace(fresh, 'active', repeated).progressCredit).toBe(true);
    expect(projectHealthTrace(fresh, 'active', fresh).progressCredit).toBe(false);
    expect(projectHealthTrace(progress, 'active', fresh).progressCredit).toBe(false);
  });

  it('nondecreasing watermark: real A->B->A->B delivery credits true,true,false,false, never re-crediting a replayed B', () => {
    const a = health({ lastProgressAt: '2026-10-08T00:00:01Z' });
    const b = health({ lastProgressAt: '2026-10-08T00:00:02Z' });
    let watermark: Pick<WorkerHealthSummary, 'lastProgressAt'> | null = null;
    const credits: boolean[] = [];
    for (const snapshot of [a, b, a, b]) {
      const trace = projectHealthTrace(snapshot, 'active', watermark);
      credits.push(trace.progressCredit);
      watermark = advanceProgressWatermark(watermark, trace.progressCredit, snapshot);
    }
    expect(credits).toEqual([true, true, false, false]);
    // A naive caller that re-threads "the last observation" instead of the
    // reducer's watermark regresses to the historical bug: the fourth B
    // compares against the third snapshot (A), which is older, so it
    // wrongly re-credits.
    const naiveCredits = [
      projectHealthTrace(a, 'active', null).progressCredit,
      projectHealthTrace(b, 'active', a).progressCredit,
      projectHealthTrace(a, 'active', b).progressCredit,
      projectHealthTrace(b, 'active', a).progressCredit,
    ];
    expect(naiveCredits).toEqual([true, true, false, true]);
  });

  it('treats equivalent timestamp representations as the same instant: no duplicate credit', () => {
    const zulu = health({ lastProgressAt: '2026-10-08T00:00:00Z' });
    const dotZeroZulu = health({ lastProgressAt: '2026-10-08T00:00:00.000Z' });
    expect(projectHealthTrace(zulu).progressCredit).toBe(true);
    expect(projectHealthTrace(dotZeroZulu, 'active', { lastProgressAt: zulu.lastProgressAt }).progressCredit).toBe(false);
    expect(projectHealthTrace(zulu, 'active', { lastProgressAt: dotZeroZulu.lastProgressAt }).progressCredit).toBe(false);
  });

  it('rejects an unparseable watermark as no-credit rather than throwing or defaulting to fresh', () => {
    const current = health({ lastProgressAt: '2026-10-08T00:00:05Z' });
    const corruptWatermark = { lastProgressAt: 'not-a-timestamp' };
    expect(() => projectHealthTrace(current, 'active', corruptWatermark)).not.toThrow();
    expect(projectHealthTrace(current, 'active', corruptWatermark).progressCredit).toBe(false);
  });

  it('never re-credits heartbeat polls from the real #2896 observer', () => {
    const launchTime = '2026-10-08T00:00:00.000Z';
    let nowMs = 0;
    const observer = createWorkerHealthObserver({
      health: { handshake: 'semantic', progressEvidence: ['tool-completion'] },
      launchTime,
      now: () => nowMs,
      wallNow: () => Date.parse(launchTime) + nowMs,
    });
    const worktree = { kind: 'worktree', id: 'owned-worktree' };
    nowMs += 1000;
    observer.observe({ kind: 'accepted' }, worktree);
    nowMs += 1000;
    observer.observe({ kind: 'progress', key: 'step:1' }, worktree);
    nowMs += 1000;
    const first = observer.check() as WorkerHealthSummary;
    expect(validateWorkerPayload('workerHealthSummary', first).valid).toBe(true);
    expect(first.state).toBe('active');
    expect(projectHealthTrace(first).progressCredit).toBe(true);
    // Two heartbeat-only polls: the observer keeps state=active with the
    // frozen progress watermark while observed/activity timestamps advance.
    nowMs += 5000;
    observer.observe({ kind: 'heartbeat' }, { kind: 'socket', id: 'hb' });
    nowMs += 1000;
    const second = observer.check() as WorkerHealthSummary;
    expect(second.state).toBe('active');
    expect(second.lastProgressAt).toBe(first.lastProgressAt);
    expect(second.lastObservedAt).not.toBe(first.lastObservedAt);
    const replay = projectHealthTrace(second, 'active', first);
    expect(replay.kind).toBe('productive');
    expect(replay.progressCredit).toBe(false);
    nowMs += 5000;
    observer.observe({ kind: 'heartbeat' }, { kind: 'socket', id: 'hb' });
    nowMs += 1000;
    const third = observer.check() as WorkerHealthSummary;
    expect(third.lastProgressAt).toBe(first.lastProgressAt);
    expect(projectHealthTrace(third, 'active', second).progressCredit).toBe(false);
    expect(new Set([projectHealthTrace(first).effectRef.digest,
      replay.effectRef.digest,
      projectHealthTrace(third, 'active', second).effectRef.digest]).size).toBe(3);
    // Genuinely new progress credits exactly once.
    nowMs += 1000;
    observer.observe({ kind: 'progress', key: 'step:2' }, worktree);
    nowMs += 1000;
    const fourth = observer.check() as WorkerHealthSummary;
    expect(fourth.lastProgressAt).not.toBe(third.lastProgressAt);
    expect(projectHealthTrace(fourth, 'active', third).progressCredit).toBe(true);
    expect(projectHealthTrace(fourth, 'active', fourth).progressCredit).toBe(false);
  });

  it('grants completion credit to no health state; Mission/Flow gates stay authoritative', () => {
    for (const state of ['launching', 'started', 'active', 'quiet', 'stalled', 'hung', 'crashed',
      'failed-to-start', 'completed', 'failed', 'cancelled'] as const) {
      const summary = health({ state, termination: state === 'completed' ? 'confirmed' : 'running' });
      expect(projectHealthTrace(summary).completionCredit).toBe(false);
    }
  });
});

describe('T-OG-24 bounded and redacted trace references', () => {
  it('passes short text through and strips control characters', () => {
    expect(boundTraceText('health.active:running', 64)).toBe('health.active:running');
    expect(boundTraceText('a\x00b\x1Fc\x7Fd\u009Fe', 64)).toBe('abcde');
  });

  it('truncates on UTF-8 byte budget without splitting characters', () => {
    const text = `ok-${'✅'.repeat(40)}-tail`;
    const bounded = boundTraceText(text, 64);
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(64);
    expect(bounded).toMatch(/…\[truncated\]$/);
    expect(bounded).not.toContain('tail');
  });

  it('never exceeds budgets smaller than the truncation marker', () => {
    for (const budget of [0, 1, 5, 13, 14]) {
      const bounded = boundTraceText('abcdef', budget);
      expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(budget);
    }
    expect(boundTraceText('abcdef', 1)).toBe('');
    expect(boundTraceText('abcdef', 64)).toBe('abcdef');
  });

  it('strips Unicode line separators instead of leaking them into the trace', () => {
    expect(boundTraceText('a\u2028b', 64)).toBe('ab');
    expect(boundTraceText('a\u2029b', 64)).toBe('ab');
  });

  it('rejects a forged previous state instead of interpolating free text', () => {
    const forged = 'quiet reason=OK gen=0 bearer sk-fake-LEAK token\u2028end';
    expect(() => projectHealthTrace(health(), forged as WorkerHealthSummary['state']))
      .toThrowError(WorkerContractError);
    const summary = projectHealthTrace(health(), 'active').activitySummary;
    expect(summary).toContain('prev=active');
    expect(summary).not.toContain('sk-fake-LEAK');
    expect(summary).not.toContain('\u2028');
    expect(projectHealthTrace(health(), null).activitySummary).toContain('prev=none');
  });

  it('rejects invalid summaries before projecting', () => {
    expect(() => projectHealthTrace({ ...health(), state: 'bogus' } as unknown as WorkerHealthSummary))
      .toThrowError(WorkerContractError);
  });
});

describe('T-OG-24 stop proof derivation', () => {
  const uncertain = () => health({ state: 'active', termination: 'uncertain', lastProgressAt: null, reasonCode: 'DISCONNECTED' });
  const terminalUnconfirmed = () => health({ state: 'completed', termination: 'uncertain', reasonCode: 'OK' });
  const confirmed = () => health({ state: 'completed', termination: 'confirmed', reasonCode: 'OK' });

  it('derives proof from owner evidence, never from a caller assertion', () => {
    expect(stopProofFromHealth(null)).toBe('none');
    expect(stopProofFromHealth(health({ state: 'active', termination: 'running' }))).toBe('none');
    expect(stopProofFromHealth(uncertain())).toBe('uncertain');
    expect(stopProofFromHealth(terminalUnconfirmed())).toBe('uncertain');
    expect(stopProofFromHealth(health({ state: 'crashed', termination: 'running' }))).toBe('uncertain');
    expect(stopProofFromHealth(confirmed())).toBe('confirmed');
    expect(stopProofFromHealth(health({ state: 'active', termination: 'confirmed' }))).toBe('uncertain');
    expect(() => stopProofFromHealth({ ...health(), state: 'bogus' } as unknown as WorkerHealthSummary))
      .toThrowError(WorkerContractError);
  });
});

describe('T-OG-24 pure lease mapping vectors', () => {
  const uncertain = () => health({ state: 'active', termination: 'uncertain', lastProgressAt: null, reasonCode: 'DISCONNECTED' });
  // Generation defaults to 3 to match mapping()'s default leaseGeneration: the
  // proof must carry the SAME generation as the lease for release to be
  // granted (see the dedicated generation-binding vectors below).
  const confirmed = (observerGeneration: number | null = 3) => health({
    state: 'completed', termination: 'confirmed', reasonCode: 'OK', observerGeneration,
  });
  const mapping = (overrides: Partial<LeaseMappingInput>): LeaseMappingInput => ({
    leaseState: 'admitted', leaseGeneration: 3, observedGeneration: 3, health: null, settled: false, ...overrides,
  });

  it.each([
    [mapping(), 'renew'],
    [mapping({ health: uncertain() }), 'retain-uncertain'],
    [mapping({ leaseState: 'expired' }), 'retain-uncertain'],
    [mapping({ leaseState: 'expired', health: uncertain() }), 'retain-uncertain'],
    [mapping({ leaseState: 'cancelled-disconnected' }), 'retain-uncertain'],
    [mapping({ leaseState: 'cancelled-disconnected', health: uncertain() }), 'retain-uncertain'],
    [mapping({ leaseState: 'expired', health: confirmed() }), 'release-once'],
    [mapping({ leaseState: 'cancelled-disconnected', health: confirmed() }), 'release-once'],
    [mapping({ health: confirmed() }), 'release-once'],
    [mapping({ observedGeneration: 2 }), 'deny-stale'],
    [mapping({ observedGeneration: 4, health: confirmed() }), 'deny-stale'],
    [mapping({ leaseState: 'expired', observedGeneration: 2, health: confirmed() }), 'deny-stale'],
    [mapping({ health: confirmed(), settled: true }), 'deny-already-settled'],
    [mapping({ leaseState: 'expired', health: confirmed(), settled: true }), 'deny-already-settled'],
    // Generation binding (regression): leaseGeneration===observedGeneration===3
    // (not stale by the caller-asserted fields) but the confirmed proof's OWN
    // generation is 2 (stale evidence smuggled in under a current-looking
    // claim). Must never release.
    [mapping({ health: confirmed(2) }), 'retain-uncertain'],
    [mapping({ leaseState: 'cancelled-disconnected', health: confirmed(2) }), 'retain-uncertain'],
    // A missing observerGeneration bridges to 0 (the bootstrap generation),
    // consistent with the leaseGeneration/observedGeneration bridge: it
    // only releases when the lease itself is at generation 0.
    [mapping({ leaseGeneration: 0, observedGeneration: 0, health: confirmed(null) }), 'release-once'],
    [mapping({ health: confirmed(null) }), 'retain-uncertain'],
  ])('%j => %s', (input, expected) => {
    expect(decideLeaseMapping({ ...input })).toBe(expected);
  });

  it('never releases on a confirmed proof carried over from a stale generation even when leaseGeneration===observedGeneration', () => {
    // This is the exact Codex-probe shape: leaseGeneration=observedGeneration=3
    // (passes the caller-asserted staleness check) with REAL confirmed
    // generation-2 health. Must retain, never release.
    const stale = decideLeaseMapping({
      leaseState: 'admitted', leaseGeneration: 3, observedGeneration: 3, health: confirmed(2), settled: false,
    });
    expect(stale).toBe('retain-uncertain');
    const current = decideLeaseMapping({
      leaseState: 'admitted', leaseGeneration: 3, observedGeneration: 3, health: confirmed(3), settled: false,
    });
    expect(current).toBe('release-once');
  });

  it('renewal carries no progress payload by construction', () => {
    const verdict = decideLeaseMapping({ leaseState: 'admitted', leaseGeneration: 1, observedGeneration: 1, health: null, settled: false });
    expect(typeof verdict).toBe('string');
    expect(verdict).toBe('renew');
  });

  it.each([
    [{ leaseState: 'bogus', leaseGeneration: 1, observedGeneration: 1, health: null, settled: false }],
    [{ leaseState: 'admitted', leaseGeneration: -1, observedGeneration: 1, health: null, settled: false }],
    [{ leaseState: 'admitted', leaseGeneration: 1, observedGeneration: 1, settled: false }],
    [{ leaseState: 'admitted', leaseGeneration: 1, observedGeneration: 1, health: { ...baseHealth, state: 'bogus' }, settled: false }],
    [{ leaseState: 'admitted', leaseGeneration: 1, observedGeneration: 1, health: null, settled: 'no' }],
    [null],
  ] as const)('rejects invalid mapping input %j', (input) => {
    expect(() => decideLeaseMapping(input as never)).toThrowError(WorkerContractError);
  });

  it('rejects boxed primitives that pass String() coercion but fail strict typing', () => {
    expect(() => decideLeaseMapping({
      leaseState: Object('admitted') as unknown as LeaseMappingInput['leaseState'],
      leaseGeneration: 1, observedGeneration: 1, health: null, settled: false,
    })).toThrowError(WorkerContractError);
  });

  it('keeps the reason-code allowlist in parity with the #2896 observer set', () => {
    const source = readFileSync(
      new URL('../../../tools/ralph-external/lib/worker-health.mjs', import.meta.url), 'utf8');
    const match = /const reasons = new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(match).not.toBeNull();
    const observerCodes = [...match![1].matchAll(/'([A-Za-z0-9_]+)'/g)].map(entry => entry[1]).sort();
    expect(observerCodes.length).toBeGreaterThan(0);
    expect([...HEALTH_KNOWN_REASON_CODES].sort()).toEqual(observerCodes);
  });

  it('shows a missing observer generation as none in the trace', () => {
    expect(projectHealthTrace(health({ observerGeneration: null })).activitySummary).toContain('gen=none');
  });

  it('ships under the unchanged mission schema identity', () => {
    expect(workerContractSchemaId()).toBe('https://aiwg.io/schemas/mission.aiwg.io/v1');
  });
});
