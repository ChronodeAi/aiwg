import { assertGateTightens } from '../../../src/gates/registry.js';
import { readFileSync } from 'node:fs';
import { buildDecisionFeatureEvalIntegrity } from '../../../src/decision/feature-export.js';
import type { QualificationReleaseRecord } from '../../../src/decision/qualification/release.js';
import { describe, expect, it } from 'vitest';
import { GATE_RANK, ceilingDecision, maxOutcome, assertDecisionCeiling, GateDecisionUpgradeError } from '../../../src/gates/lattice.js';
import { projectCeilingSatisfied, assertCeilingDefaults } from '../../../src/gates/floors.js';
import { ensembleIntegrityDecision, integrityGateRank } from '../../../src/decision/ensemble/contract.js';
import { buildSdlcScreeningReleaseReport } from '../../../src/decision/sdlc-screening.js';
import { validateGateReport } from '../../../src/gates/report.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { HELDOUT_NOW, anchored, heldoutRecords, preregistration, verifiedIntegrity } from '../decision/sdlc-screening-fixtures.js';
import { evaluateFixture, loadPack, makeBinding, makeUpstream, NOW, passingMetrics, testHoldout, testRegistry, trustedDigest } from '../../conformance/gates-v1/helper.js';

const outcomes = ['PROMOTE', 'HOLD', 'ROLLBACK'] as const;
const pairs = outcomes.flatMap((left, i) => outcomes.map((right, j) => ({ left, right, expected: outcomes[Math.max(i, j)]! })));

describe('shared outcome lattice (#2829)', () => {
  it.each(pairs)('preserves $left with $right as $expected', ({ left, right, expected }) => {
    expect(maxOutcome(left, right)).toBe(expected);
    expect(ceilingDecision(left, right)).toBe(expected);
    expect(maxOutcome(right, left)).toBe(expected);
    expect(maxOutcome(left, left)).toBe(left);
  });
  it('has an identity, is associative, and exposes an immutable rank', () => {
    expect(maxOutcome()).toBe('PROMOTE');
    expect(Object.isFrozen(GATE_RANK)).toBe(true);
    for (const a of outcomes) for (const b of outcomes) for (const c of outcomes) {
      expect(maxOutcome(a, maxOutcome(b, c))).toBe(maxOutcome(maxOutcome(a, b), c));
    }
  });
  it.each(pairs)('gate floors preserve the ordering of $left and $right', ({ left, right, expected }) => {
    expect(projectCeilingSatisfied(left, right)).toBe(left === expected);
    if (left === expected) expect(() => assertCeilingDefaults({ '*': right, study: left })).not.toThrow();
    else expect(() => assertCeilingDefaults({ '*': right, study: left })).toThrow();
    expect(integrityGateRank(left)).toBe(outcomes.indexOf(left));
  });
  it.each(outcomes)('ensemble integrity preserves the original verdict table for %s', upstream => {
    for (const compromised of [false, true]) for (const labels of [[], ['fixture-change']]) for (const findings of [0, 1, 3]) {
      const integrity = verifiedIntegrity({ release_gate: { decision: upstream, reasons: [] },
        integrity_state: compromised ? 'compromised' : 'verified', compromise_labels: labels });
      const expected = upstream === 'ROLLBACK' || compromised || labels.length > 0 ? 'ROLLBACK'
        : upstream === 'HOLD' || findings > 0 ? 'HOLD' : 'PROMOTE';
      expect(ensembleIntegrityDecision(integrity, findings)).toBe(expected);
    }
  });
  it.each(outcomes)('SDLC release preserves the original verdict table for %s', upstream => {
    const plan = preregistration();
    for (const compromised of [false, true]) for (const heldout of [null, heldoutRecords()]) {
      const integrity = verifiedIntegrity({ release_gate: { decision: upstream, reasons: [] },
        integrity_state: compromised ? 'compromised' : 'verified' });
      const report = buildSdlcScreeningReleaseReport({ preregistration: plan, trustedPreregistrationDigest: anchored(plan),
        heldout, integrity, nowEpochMs: HELDOUT_NOW });
      expect(report.decision).toBe(upstream === 'ROLLBACK' || compromised ? 'ROLLBACK'
        : upstream === 'HOLD' || heldout === null ? 'HOLD' : 'PROMOTE');
    }
  });
  it.each(outcomes)('the core evaluator applies every binding/upstream ceiling for %s', upstream => {
    for (const ceiling of outcomes) {
      const binding = makeBinding();
      binding.spec.ceiling = ceiling;
      expect(evaluateFixture({ binding, upstream: makeUpstream(upstream.toLowerCase() as 'promote' | 'hold' | 'rollback') }).decision)
        .toBe(outcomes[Math.max(outcomes.indexOf(upstream), outcomes.indexOf(ceiling))]);
    }
  });
  it.each(pairs)('validates the report/component pair $left / $right with a typed error', ({ left, right, expected }) => {
    if (left === expected) expect(() => assertDecisionCeiling(left, right)).not.toThrow();
    else expect(() => assertDecisionCeiling(left, right)).toThrow(GateDecisionUpgradeError);
  });
  it('rejects a resealed PROMOTE report containing a ROLLBACK component with a typed error', () => {
    const binding = makeBinding();
    const input = { binding, registry: testRegistry().registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW,
      floors: 'none-explicit-opt-out' as const };
    const report = evaluateFixture({ binding });
    report.gateEvidence[0]!.outcome = 'ROLLBACK';
    report.decision = 'PROMOTE';
    const { digest: _old, ...fields } = report;
    report.digest = artifactDigest(fields);
    const result = validateGateReport(report, input);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('report-upgrades-component');
    expect(result.error).toBeInstanceOf(GateDecisionUpgradeError);
    expect(result.error).toMatchObject({ decision: 'PROMOTE', component: 'ROLLBACK' });
  });
});

it.each(pairs)('feature export preserves the report/component verdict table $left / $right', ({ left, right, expected }) => {
  const fields = { schemaVersion: 'decision-qualification-release/v2' as const, runId: 'lattice-fixture', sourceCommit: 'a'.repeat(40),
    decision: right, integrity: verifiedIntegrity({ release_gate: { decision: right, reasons: [] } }), gates: [] };
  const release = { ...fields, digest: artifactDigest(fields) } as QualificationReleaseRecord;
  const build = () => buildDecisionFeatureEvalIntegrity({ qualificationRelease: release, reportRef: 'fixture', disposition: left });
  if (left === expected) expect(build().disposition).toBe(left);
  else expect(build).toThrow(GateDecisionUpgradeError);
});

it('keeps the lattice independent of evaluators, transports and configuration', () => {
  const source = readFileSync(new URL('../../../src/gates/lattice.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/^\s*import\s|^\s*export[^\n]*\bfrom\s/m);
  expect(source).not.toMatch(/\b(?:fetch|require|readFile|process)\s*\(/);
});

it('gate inheritance uses the same ordering for every failure-outcome pair', () => {
  const gate = loadPack().spec.gates[0]!;
  for (const parent of ['HOLD', 'ROLLBACK'] as const) for (const child of ['HOLD', 'ROLLBACK'] as const) {
    const check = () => assertGateTightens({ ...gate, onFail: parent }, { ...gate, onFail: child }, loadPack().spec.parameters ?? {});
    if (parent === 'ROLLBACK' && child === 'HOLD') expect(check).toThrow(/ROLLBACK/);
    else expect(check).not.toThrow();
  }
});
