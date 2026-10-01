import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { GateEvaluationError, evaluateGates } from '../../../src/gates/evaluate.js';
import { validateGateReport } from '../../../src/gates/report.js';
import type { GateMetricsDocument } from '../../../src/gates/types.js';
import {
  evidenceProvider, pairedProvider, proportionProvider, scalarProvider,
} from '../../../src/gates/providers/index.js';
import {
  NOW, evaluateFixture, makeBinding, makeUpstream, pairedRecords, passingMetrics,
  proportionRecords, resolveTestBinding, scalarRecords, trustedDigest,
} from './helper.js';

const breached = (metrics: GateMetricsDocument) => evaluateFixture({ metrics });

describe('gates evaluator oracle', () => {
  it('promotes when every gate passes and reports byte-identical digests', () => {
    const first = evaluateFixture();
    expect(first.decision).toBe('PROMOTE');
    expect(first.ceilings).toEqual({ packOutcome: 'PROMOTE', upstreamCeiling: 'PROMOTE', bindingCeiling: 'PROMOTE' });
    expect(first.gateEvidence.every(entry => entry.status === 'pass' && entry.outcome === 'PROMOTE')).toBe(true);
    expect(first.references).toEqual([{ name: 'always-review', kind: 'always-review', observed: false }]);
    const second = evaluateFixture();
    expect(second.digest).toBe(first.digest);
    expect(second).toEqual(first);
    expect(validateGateReport(first, {
      resolved: resolveTestBinding(), trustedBindingDigest: trustedDigest(makeBinding()),
      metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW,
    })).toEqual({ valid: true, reasons: [] });
  });

  it('holds on a breached Wilson upper bound and never promotes it', () => {
    const metrics = passingMetrics();
    const proportion = proportionProvider.compute([
      ...proportionRecords({ a: { n: 1000, events: 12 }, b: { n: 1000, events: 0 } }, 'false-ready'),
      ...proportionRecords({ a: { n: 1000, events: 500 }, b: { n: 1000, events: 500 } }, 'coverage'),
    ]);
    const report = breached({ ...metrics, providers: { ...metrics.providers, [proportionProvider.id]: proportion } });
    expect(report.decision).toBe('HOLD');
    expect(report.ceilings.packOutcome).toBe('HOLD');
    const upper = report.gateEvidence.find(entry => entry.gateId === 'false-ready-upper');
    expect(upper).toMatchObject({ status: 'fail', outcome: 'HOLD' });
    expect(upper?.reasons).toEqual(['false-ready-upper:bound-breaches-threshold']);
    expect(upper?.statistic?.method).toBe('wilson');
    expect(upper?.threshold).toMatchObject({ op: 'lte', param: 'falseReadyMaxBps', resolved: 100 });
  });

  it('rolls back on a false-ready event in the blocking slice', () => {
    const metrics = passingMetrics();
    const proportion = proportionProvider.compute([
      ...proportionRecords({ a: { n: 1000, events: 0 }, b: { n: 1000, events: 1 } }, 'false-ready'),
      ...proportionRecords({ a: { n: 1000, events: 500 }, b: { n: 1000, events: 500 } }, 'coverage'),
    ]);
    const report = breached({ ...metrics, providers: { ...metrics.providers, [proportionProvider.id]: proportion } });
    expect(report.decision).toBe('ROLLBACK');
    expect(report.gateEvidence.find(entry => entry.gateId === 'blocking-events')).toMatchObject({
      status: 'fail', outcome: 'ROLLBACK', slice: 'b',
    });
  });

  it('rolls back on a regressed paired contrast through the blocking gate', () => {
    const metrics = passingMetrics();
    const paired = pairedProvider.compute(pairedRecords({
      a: { both: 300, candidateOnly: 5, baselineOnly: 90, neither: 605 },
      b: { both: 300, candidateOnly: 5, baselineOnly: 90, neither: 605 },
    }));
    const report = breached({ ...metrics, providers: { ...metrics.providers, [pairedProvider.id]: paired } });
    expect(report.decision).toBe('ROLLBACK');
    expect(report.gateEvidence.find(entry => entry.gateId === 'contrast-ni')).toMatchObject({
      status: 'fail', outcome: 'ROLLBACK',
    });
  });

  it('holds on coverage, latency, count, bootstrap, evidence and predicate shortfalls', () => {
    const base = passingMetrics();
    const thin = proportionProvider.compute([
      ...proportionRecords({ a: { n: 1000, events: 0 }, b: { n: 1000, events: 0 } }, 'false-ready'),
      ...proportionRecords({ a: { n: 1000, events: 3 }, b: { n: 1000, events: 3 } }, 'coverage'),
    ]);
    const slow = scalarProvider.compute(scalarRecords({
      a: Array.from({ length: 100 }, () => 900), b: Array.from({ length: 100 }, () => 950),
    }));
    const worse = scalarProvider.compute(scalarRecords({
      a: Array.from({ length: 100 }, () => -0.5), b: Array.from({ length: 100 }, () => -0.5),
    }));
    const unattested = evidenceProvider.compute([]);
    const cases: Array<[string, GateMetricsDocument, string]> = [
      ['coverage-lower', { ...base, providers: { ...base.providers, [proportionProvider.id]: thin } }, 'fail'],
      ['latency-cap', { ...base, providers: { ...base.providers, [scalarProvider.id]: slow } }, 'fail'],
      ['coverage-events', { ...base, providers: { ...base.providers, [proportionProvider.id]: thin } }, 'fail'],
      ['delta-bootstrap', { ...base, providers: { ...base.providers, [scalarProvider.id]: worse } }, 'fail'],
    ];
    for (const [gateId, metrics, status] of cases) {
      const report = breached(metrics);
      expect(report.gateEvidence.find(entry => entry.gateId === gateId)?.status, gateId).toBe(status);
      expect(report.decision, gateId).toBe('HOLD');
    }
    const missing = breached({ ...base, providers: { ...base.providers, [evidenceProvider.id]: unattested } });
    expect(missing.gateEvidence.find(entry => entry.gateId === 'release-evidence')).toMatchObject({ status: 'insufficient' });
    expect(missing.decision).toBe('HOLD');
    const failed = evidenceProvider.compute([{ id: 'review-passed', passed: false }]);
    const denied = breached({ ...base, providers: { ...base.providers, [evidenceProvider.id]: failed } });
    expect(denied.gateEvidence.find(entry => entry.gateId === 'release-evidence')).toMatchObject({ status: 'fail' });
    expect(denied.decision).toBe('HOLD');
  });
});

describe('gates fail-closed paths', () => {
  it('treats missing slices and null values as insufficient, never promote', () => {
    const base = passingMetrics();
    const proportion = base.providers[proportionProvider.id]!;
    const dropped = {
      ...proportion,
      metrics: { ...proportion.metrics, 'false-ready': { bySlice: {}, pooled: proportion.metrics['false-ready']!.pooled } },
    };
    const report = evaluateFixture({ metrics: { ...base, providers: { ...base.providers, [proportionProvider.id]: dropped } } });
    expect(report.gateEvidence.find(entry => entry.gateId === 'support-total')).toMatchObject({ status: 'pass' });
    const perSlice = report.gateEvidence.filter(entry => entry.gateId === 'false-ready-exact');
    expect(perSlice).toHaveLength(2);
    expect(perSlice.every(entry => entry.status === 'insufficient' && entry.outcome === 'HOLD')).toBe(true);
    // The blocking listed gate is also starved, and blocking insufficient escalates.
    expect(report.gateEvidence.find(entry => entry.gateId === 'blocking-events')).toMatchObject({
      status: 'insufficient', outcome: 'ROLLBACK',
    });
    expect(report.decision).toBe('ROLLBACK');
  });

  it('refuses untrusted binding digests, forged upstream and post-holdout freezes', () => {
    const binding = makeBinding();
    const resolved = resolveTestBinding(binding);
    const input = { resolved, metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW };
    expect(() => evaluateGates({ ...input, trustedBindingDigest: `sha256:${'0'.repeat(64)}` }))
      .toThrow(GateEvaluationError);
    const forged = { ...makeUpstream('promote') };
    forged.metadata = { ...forged.metadata, sample_n: 9999 };
    expect(() => evaluateGates({ ...input, trustedBindingDigest: trustedDigest(binding), upstream: forged }))
      .toThrow(/upstream integrity digest/);
    const late = makeBinding({ spec: { holdoutAccessedAt: '2026-09-02T00:00:00.000Z' } });
    expect(() => evaluateGates({ ...input, resolved: resolveTestBinding(late), trustedBindingDigest: trustedDigest(late) }))
      .toThrow(/at or after holdout access/);
    const future = makeBinding({ spec: { frozenAt: '2026-09-10T00:00:00.000Z' } });
    expect(() => evaluateGates({ ...input, resolved: resolveTestBinding(future), trustedBindingDigest: trustedDigest(future) }))
      .toThrow(/freezes after the evaluation/);
  });

  it('floors diagnostic bindings and missing or hostile upstreams', () => {
    expect(evaluateFixture({ ceiling: 'HOLD' }).decision).toBe('HOLD');
    expect(evaluateFixture({ ceiling: 'HOLD' }).ceilings.bindingCeiling).toBe('HOLD');
    const held = evaluateFixture({ upstream: makeUpstream('hold') });
    expect(held.decision).toBe('HOLD');
    expect(held.ceilings.upstreamCeiling).toBe('HOLD');
    expect(held.gateEvidence.find(entry => entry.gateId === 'integrity-ceiling')).toMatchObject({ status: 'fail', outcome: 'HOLD' });
    const rolled = evaluateFixture({ upstream: makeUpstream('rollback') });
    expect(rolled.decision).toBe('ROLLBACK');
    const compromised = evaluateFixture({ upstream: makeUpstream('compromised') });
    expect(compromised.decision).toBe('ROLLBACK');
    expect(compromised.ceilings.upstreamCeiling).toBe('ROLLBACK');
    // Compromise escalates the gate through the ceiling; plain allowlist problems only hold.
    expect(compromised.gateEvidence.find(entry => entry.gateId === 'integrity-ceiling')).toMatchObject({
      status: 'fail', outcome: 'ROLLBACK',
    });
    const orphan = evaluateFixture({ upstream: null });
    expect(orphan.decision).toBe('HOLD');
    expect(orphan.ceilings.upstreamCeiling).toBe('HOLD');
    expect(orphan.gateEvidence.find(entry => entry.gateId === 'integrity-ceiling')).toMatchObject({ status: 'insufficient' });
  });

  it('reports references without gating on them', () => {
    const metrics = passingMetrics();
    const references = {
      'pinned-baseline:study/v3': { [proportionProvider.id]: proportionProvider.compute(
        proportionRecords({ a: { n: 500, events: 5 }, b: { n: 500, events: 5 } })) },
    };
    const binding = makeBinding({ spec: { references: [
      { name: 'always-review', kind: 'always-review' },
      { name: 'pinned-baseline:study/v3', kind: 'pinned-baseline',
        baseline: { id: 'study/v3', version: '1.0.0', digest: artifactDigest({ sentinel: true }) } },
    ] } });
    const report = evaluateFixture({ binding, metrics: { ...metrics, references } });
    expect(report.decision).toBe('PROMOTE');
    expect(report.references).toEqual([
      { name: 'always-review', kind: 'always-review', observed: false },
      { name: 'pinned-baseline:study/v3', kind: 'pinned-baseline', observed: true },
    ]);
  });
});

describe('gates report validation', () => {
  it('rejects upgraded decisions and tampered evidence', () => {
    const binding = makeBinding();
    const context = { resolved: resolveTestBinding(binding), trustedBindingDigest: trustedDigest(binding),
      metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW };
    const report = evaluateGates(context);
    expect(validateGateReport(report, context)).toEqual({ valid: true, reasons: [] });
    // A breached report upgraded to PROMOTE breaks re-derivation, the digest and the never-upgrade rule.
    const thin = proportionProvider.compute([
      ...proportionRecords({ a: { n: 1000, events: 12 }, b: { n: 1000, events: 0 } }, 'false-ready'),
      ...proportionRecords({ a: { n: 1000, events: 500 }, b: { n: 1000, events: 500 } }, 'coverage'),
    ]);
    const breachedMetrics = { ...passingMetrics(), providers: { ...passingMetrics().providers, [proportionProvider.id]: thin } };
    const breachedContext = { ...context, metrics: breachedMetrics };
    const breachedReport = evaluateGates(breachedContext);
    expect(breachedReport.decision).toBe('HOLD');
    const upgraded = { ...breachedReport, decision: 'PROMOTE' as const };
    const forged = validateGateReport(upgraded, breachedContext);
    expect(forged.valid).toBe(false);
    expect(forged.reasons).toEqual(expect.arrayContaining(['report-digest-mismatch', 'report-decision-mismatch']));
    // A digest-consistent report that still promotes past a ROLLBACK component trips the never-upgrade rule.
    const contradictory = {
      ...breachedReport,
      gateEvidence: breachedReport.gateEvidence.map(entry => entry.gateId === 'blocking-events'
        ? { ...entry, status: 'fail' as const, outcome: 'ROLLBACK' as const, reasons: ['blocking-events:count-breaches-threshold'] }
        : entry),
      decision: 'PROMOTE' as const,
    };
    const { digest: _dropped, ...contradictoryFields } = contradictory;
    void _dropped;
    const resealed = { ...contradictoryFields, digest: artifactDigest(contradictoryFields) };
    const conflicted = validateGateReport(resealed, breachedContext);
    expect(conflicted.valid).toBe(false);
    expect(conflicted.reasons).toContain('report-upgrades-component');
    // Flipping the breached evidence to pass breaks the digest even though the decision still matches re-derivation.
    const whitewashed = {
      ...breachedReport,
      gateEvidence: breachedReport.gateEvidence.map(entry => entry.gateId === 'false-ready-upper'
        ? { ...entry, status: 'pass' as const, outcome: 'PROMOTE' as const, reasons: ['false-ready-upper:bound-within-threshold'] }
        : entry),
    };
    const washed = validateGateReport(whitewashed, breachedContext);
    expect(washed.valid).toBe(false);
    expect(washed.reasons).toContain('report-digest-mismatch');
  });
});
