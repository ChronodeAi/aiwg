import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { GateEvaluationError, evaluateGates, sealGateHoldout } from '../../../src/gates/evaluate.js';
import { resolveProjectFloors } from '../../../src/gates/floors.js';
import { validateGateReport } from '../../../src/gates/report.js';
import type { GateMetricsDocument } from '../../../src/gates/types.js';
import {
  evidenceProvider, pairedProvider, proportionProvider, scalarProvider,
} from '../../../src/gates/providers/index.js';
import {
  NOW, evaluateFixture, loadPack, makeBinding, makeBindingForPack, makeUpstream, pairedRecords, passingMetrics,
  proportionRecords, scalarRecords, testHoldout, testRegistry, trustedDigest,
} from './helper.js';

const breached = (metrics: GateMetricsDocument) => evaluateFixture({ metrics });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const evaluateContext = (binding = makeBinding()) => {
  const { registry } = testRegistry();
  return {
    binding, registry, trustedBindingDigest: trustedDigest(binding), holdout: testHoldout(binding),
    floors: resolveProjectFloors({}),
  };
};

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
    const binding = makeBinding();
    expect(validateGateReport(first, {
      ...evaluateContext(binding),
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
    // The blocking listed gate is also starved; insufficient evidence holds, never rolls back.
    expect(report.gateEvidence.find(entry => entry.gateId === 'blocking-events')).toMatchObject({
      status: 'insufficient', outcome: 'HOLD',
    });
    expect(report.decision).toBe('HOLD');
  });

  it('refuses untrusted binding digests, forged upstream and post-holdout freezes', () => {
    const binding = makeBinding();
    const input = {
      ...evaluateContext(binding), metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW,
    };
    expect(() => evaluateGates({ ...input, trustedBindingDigest: `sha256:${'0'.repeat(64)}` }))
      .toThrow(GateEvaluationError);
    const forged = { ...makeUpstream('promote') };
    forged.metadata = { ...forged.metadata, sample_n: 9999 };
    expect(() => evaluateGates({ ...input, upstream: forged }))
      .toThrow(/upstream integrity digest/);
    const late = makeBinding();
    const lateHoldout = sealGateHoldout({ firstAccessedAt: '2026-09-02T00:00:00.000Z', frozenDigest: trustedDigest(late) });
    expect(() => evaluateGates({ ...input, binding: late, trustedBindingDigest: trustedDigest(late), holdout: lateHoldout }))
      .toThrow(/at or after holdout access/);
    // The binding's own self-reported field is ignored: a null self-report with a
    // trusted access before the freeze still refuses.
    expect(() => evaluateGates({ ...input, holdout: lateHoldout }))
      .toThrow(/at or after holdout access/);
    expect(() => evaluateGates({ ...input, holdout: undefined as never }))
      .toThrow(/trusted holdout inputs are required/);
    const future = makeBinding({ spec: { frozenAt: '2026-09-10T00:00:00.000Z' } });
    expect(() => evaluateGates({ ...input, binding: future, trustedBindingDigest: trustedDigest(future),
      holdout: sealGateHoldout({ firstAccessedAt: null, frozenDigest: trustedDigest(future) }) }))
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
    // The ceiling gate mirrors the trusted verdict: compromise rolls back, plain allowlist problems only hold.
    expect(compromised.gateEvidence.find(entry => entry.gateId === 'integrity-ceiling')).toMatchObject({
      status: 'fail', outcome: 'ROLLBACK',
    });
    // A bound upstream-ceiling gate without a sealed upstream refuses in the
    // evaluator itself instead of downgrading to HOLD (p1b A3).
    expect(() => evaluateFixture({ upstream: null })).toThrow(/sealed upstream/);
  });

  it('holds without an upstream only when no upstream-ceiling gate is bound', () => {
    const pack = clone(loadPack());
    pack.metadata = { ...pack.metadata, id: 'aiwg:test-gates/no-ceiling' };
    pack.spec.gates = pack.spec.gates.filter(gate => gate.kind !== 'upstream-ceiling');
    const { registry } = testRegistry();
    registry.registerPack(pack, { namespace: 'aiwg', bundle: 'test-gates' });
    const binding = makeBindingForPack(pack);
    const report = evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: null, now: NOW, floors: 'none-explicit-opt-out',
    });
    expect(report.decision).toBe('HOLD');
    expect(report.ceilings.upstreamCeiling).toBe('HOLD');
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
    const context = { ...evaluateContext(binding),
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
    // Flipping the breached evidence to pass breaks byte-identical re-derivation even with a resealed digest.
    const whitewashed = {
      ...breachedReport,
      gateEvidence: breachedReport.gateEvidence.map(entry => entry.gateId === 'false-ready-upper'
        ? { ...entry, status: 'pass' as const, outcome: 'PROMOTE' as const, reasons: ['false-ready-upper:bound-within-threshold'] }
        : entry),
    };
    const washed = validateGateReport(whitewashed, breachedContext);
    expect(washed.valid).toBe(false);
    expect(washed.reasons).toContain('report-reevaluation-mismatch');
  });
});
