import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { evaluateGates, sealGateHoldout, sealUpstream } from '../../../src/gates/evaluate.js';
import { resolveProjectFloors } from '../../../src/gates/floors.js';
import { validateGateReport } from '../../../src/gates/report.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { loadGatePackFile } from '../../../src/gates/discovery.js';
import { createCoreProviderRegistry, screeningProvider } from '../../../src/gates/providers/index.js';

const ADDON = new URL('../../../agentic/code/addons/decision-engine/gate-packs/', import.meta.url);
const PACK_ID = 'aiwg:decision-engine/absolute-screening';
const CEILING_ID = 'aiwg:decision-engine/integrity-ceiling';
const NOW = '2026-10-02T00:00:00.000Z';
const FROZEN_AT = '2026-09-30T00:00:00.000Z';
const ACCESSED_AT = '2026-10-01T00:00:00.000Z';

const SLICES = ['citation-supports', 'citation-contradicts', 'citation-unclear', 'citation-does-not-support',
  'criterion-ready', 'criterion-incomplete', 'missing-artifact', 'failed-test', 'citation-injection', 'criterion-injection'];
const BLOCKING = ['citation-injection', 'criterion-injection', 'missing-artifact', 'failed-test'];
const CITATIONS = SLICES.filter(slice => slice.startsWith('citation'));

function registry() {
  const registry = new GateRegistry(createCoreProviderRegistry());
  registry.registerPack(loadGatePackFile(new URL('absolute-screening.gatepack.yaml', ADDON).pathname), { namespace: 'aiwg', bundle: 'decision-engine' });
  registry.registerPack(loadGatePackFile(new URL('integrity-ceiling.gatepack.yaml', ADDON).pathname), { namespace: 'aiwg', bundle: 'decision-engine' });
  return registry;
}

function packDigest(id) {
  const file = id === PACK_ID ? 'absolute-screening.gatepack.yaml' : 'integrity-ceiling.gatepack.yaml';
  return artifactDigest(loadGatePackFile(new URL(file, ADDON).pathname));
}

const param = name => `${PACK_ID}.${name}`;

function binding({ parameters: parameterOverrides = {}, ...specOverrides } = {}) {
  return {
    apiVersion: 'gates.aiwg.io/v1alpha1',
    kind: 'GateBinding',
    metadata: { id: 'd29-synthetic-v7-absolute-gates', version: '1.0.0', description: 'D29 v7 absolute screening gates.' },
    spec: {
      packs: [PACK_ID, CEILING_ID].map(id => ({ id, version: '1.0.0', digest: packDigest(id), resolvedDigest: packDigest(id) })),
      parameters: {
        [param('falseReadyMaxBps')]: 100,
        [param('falseSupportMaxBps')]: 100,
        [param('blockingFalseReadyMaxEvents')]: 0,
        [param('blockingFalseReadyMaxUpperBps')]: 500,
        [param('coverageMinLowerBps')]: 1500,
        [param('accuracyMinLowerBps')]: 5000,
        [param('supportTotalMinN')]: 1500,
        [param('supportSliceMinN')]: 100,
        [param('supportBlockingMinN')]: 500,
        [param('classSupportMinN')]: 100,
        [param('confidenceLevelBps')]: 9500,
        ...parameterOverrides,
      },
      slices: SLICES,
      sliceGroups: { blocking: BLOCKING },
      references: [{ name: 'always-review', kind: 'always-review' }],
      metricProviders: [{ id: screeningProvider.id, version: screeningProvider.version, sourceDigest: screeningProvider.sourceDigest }],
      ceiling: 'HOLD',
      registeredAt: FROZEN_AT,
      frozenAt: FROZEN_AT,
      holdoutAccessedAt: null,
      splitDigest: `sha256:${'a'.repeat(64)}`,
      corpusDigest: `sha256:${'b'.repeat(64)}`,
      goldDigest: `sha256:${'c'.repeat(64)}`,
      ...specOverrides,
    },
  };
}

/** Builds screening records: per-slice binary tallies plus the calibration and held-out record attestations. */
function records({ perSlice = {}, falseReady = {}, falseSupport = {}, coverage = {}, accuracy = {}, calibration = true, record = true }) {
  const rows = [];
  for (const slice of SLICES) {
    const n = perSlice[slice] ?? 200;
    const take = (table, fallback) => Math.min(table[slice] ?? fallback, n);
    for (let i = 0; i < n; i++) {
      rows.push({ slice, metric: 'false-ready', event: i < take(falseReady, 0) });
      rows.push({ slice, metric: 'coverage', event: i < take(coverage, 150) });
      rows.push({ slice, metric: 'accuracy', event: i < take(accuracy, 190) });
    }
    if (CITATIONS.includes(slice)) {
      for (let i = 0; i < n; i++) rows.push({ slice, metric: 'false-support', event: i < take(falseSupport, 0) });
    }
  }
  // One ready event overall keeps every bound honest without breaching it.
  rows.push({ slice: 'citation-supports', metric: 'false-ready', event: true });
  rows.push({ slice: 'citation-supports', metric: 'false-support', event: true });
  if (calibration) rows.push({ id: 'staged-calibration-artifact', passed: true });
  if (record) {
    rows.push({ id: 'd29-heldout-evaluated-at', passed: true });
    rows.push({ id: 'd29-heldout-split', passed: true });
    rows.push({ id: 'd29-heldout-slices-registered', passed: true });
    rows.push({ id: 'd29-heldout-class-support', passed: true });
  }
  return rows;
}

function metrics(rows) {
  const section = screeningProvider.compute(rows);
  return { providers: { [screeningProvider.id]: section } };
}

function cleanIntegrity(overrides = {}) {
  return {
    sample_n: 1500, uncertainty: { profile: 'test' }, paired_baseline: { baseline: 'test' },
    integrity_mode: 'fresh', fresh_workspace_required: true, fresh_workspace_verified: true,
    integrity_state: 'verified', trusted_score_source: 'fresh-workspace',
    compromise_labels: [], weak_signal_reason: null,
    release_gate: { decision: 'PROMOTE', reasons: [] }, ...overrides,
  };
}

function evaluate({ rows = records({}), ceiling = 'HOLD', integrity = cleanIntegrity(), accessedAt = ACCESSED_AT, now = NOW, spec = {} }) {
  const gateBinding = binding({ ceiling, ...spec });
  const registries = registry();
  return evaluateGates({
    binding: gateBinding, registry: registries, trustedBindingDigest: artifactDigest(gateBinding),
    holdout: sealGateHoldout({ frozenDigest: artifactDigest(gateBinding), firstAccessedAt: accessedAt }),
    metrics: metrics(rows), upstream: sealUpstream(integrity), now, floors: resolveProjectFloors({}),
  });
}

describe('D29 absolute screening gates', () => {
  it('ships a validating absolute-screening pack declared in the decision-engine manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../agentic/code/addons/decision-engine/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.entry.gatePacks).toBe('gate-packs/');
    expect(manifest.gatePacks).toContain('absolute-screening');
    const pack = loadGatePackFile(new URL('absolute-screening.gatepack.yaml', ADDON).pathname);
    expect(pack.metadata).toMatchObject({ id: PACK_ID, version: '1.0.0' });
    expect(pack.spec.gates.map(gate => gate.id)).toEqual(['support-total', 'support-slice', 'support-blocking',
      'heldout-evaluated-at', 'heldout-split', 'heldout-slices-registered', 'class-support-minimum',
      'false-ready-upper', 'false-support-upper', 'blocking-false-ready-events', 'blocking-false-ready-upper',
      'coverage-lower', 'accuracy-floor', 'calibration-artifact']);
    expect(pack.spec.gates.find(gate => gate.id === 'blocking-false-ready-events').onFail).toBe('ROLLBACK');
  });

  it('promotes when every absolute gate passes and re-derives byte-identically', () => {
    const first = evaluate({ ceiling: 'PROMOTE' });
    expect(first.decision).toBe('PROMOTE');
    expect(first.ceilings).toMatchObject({ packOutcome: 'PROMOTE', upstreamCeiling: 'PROMOTE', bindingCeiling: 'PROMOTE' });
    expect(first.gateEvidence.every(entry => entry.status === 'pass')).toBe(true);
    expect(first.references).toEqual([{ name: 'always-review', kind: 'always-review', observed: false }]);
    const second = evaluate({ ceiling: 'PROMOTE' });
    expect(second.digest).toBe(first.digest);
    expect(second).toEqual(first);
  });

  it('caps a passing D29 run at the preregistered HOLD ceiling without upgrading it', () => {
    const report = evaluate({});
    expect(report.decision).toBe('HOLD');
    expect(report.ceilings).toMatchObject({ packOutcome: 'PROMOTE', bindingCeiling: 'HOLD' });
    expect(report.gateEvidence.every(entry => entry.outcome !== 'ROLLBACK')).toBe(true);
  });

  it('rolls back on a single false-ready event in a gate-blocking slice', () => {
    const rows = records({});
    rows.push({ slice: 'missing-artifact', metric: 'false-ready', event: true });
    const report = evaluate({ rows, ceiling: 'PROMOTE' });
    expect(report.decision).toBe('ROLLBACK');
    expect(report.gateEvidence.find(entry => entry.gateId === 'blocking-false-ready-events' && entry.slice === 'missing-artifact'))
      .toMatchObject({ status: 'fail', outcome: 'ROLLBACK' });
  });

  it('holds a regressed false-ready rate instead of promoting it', () => {
    const rows = records({ falseReady: { 'citation-supports': 20 } });
    const report = evaluate({ rows, ceiling: 'PROMOTE' });
    expect(report.decision).toBe('HOLD');
    const upper = report.gateEvidence.find(entry => entry.gateId === 'false-ready-upper');
    expect(upper).toMatchObject({ status: 'fail', outcome: 'HOLD' });
    expect(upper.statistic.upperBps).toBeGreaterThan(100);
  });

  it('holds a regressed false-support rate instead of promoting it', () => {
    const rows = records({ falseSupport: { 'citation-contradicts': 8 } });
    const report = evaluate({ rows, ceiling: 'PROMOTE' });
    expect(report.decision).toBe('HOLD');
    expect(report.gateEvidence.find(entry => entry.gateId === 'false-support-upper'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
  });

  it('holds when support is insufficient and never promotes a shortfall', () => {
    const report = evaluate({ rows: [{ id: 'staged-calibration-artifact', passed: true }] });
    expect(report.decision).toBe('HOLD');
    expect(report.gateEvidence.find(entry => entry.gateId === 'support-total'))
      .toMatchObject({ status: 'insufficient', outcome: 'HOLD' });
  });

  it('holds a failed held-out record attestation through its record gate', () => {
    for (const [gateId, id] of [['heldout-evaluated-at', 'd29-heldout-evaluated-at'], ['heldout-split', 'd29-heldout-split'],
      ['heldout-slices-registered', 'd29-heldout-slices-registered'], ['class-support-minimum', 'd29-heldout-class-support']]) {
      const rows = records({});
      rows.find(row => row.id === id).passed = false;
      const report = evaluate({ rows, ceiling: 'PROMOTE' });
      expect(report.decision, gateId).toBe('HOLD');
      expect(report.gateEvidence.find(entry => entry.gateId === gateId), gateId)
        .toMatchObject({ status: 'fail', outcome: 'HOLD' });
      expect(report.gateEvidence.filter(entry => entry.gateId !== gateId && entry.gateId !== 'calibration-artifact'
        && !['heldout-evaluated-at', 'heldout-split', 'heldout-slices-registered', 'class-support-minimum'].includes(entry.gateId))
        .every(entry => entry.status === 'pass'), gateId).toBe(true);
    }
  });

  it('holds a missing held-out record attestation as insufficient evidence', () => {
    const rows = records({}).filter(row => row.id !== 'd29-heldout-split');
    const report = evaluate({ rows, ceiling: 'PROMOTE' });
    expect(report.decision).toBe('HOLD');
    expect(report.gateEvidence.find(entry => entry.gateId === 'heldout-split'))
      .toMatchObject({ status: 'insufficient', outcome: 'HOLD' });
  });

  it('drives minimum-n from the preregistered parameter value, not a literal', () => {
    const rows = records({});
    const support = rows.filter(row => row.metric === 'false-ready').length;
    const report = evaluate({ rows, ceiling: 'PROMOTE',
      spec: { parameters: { [param('supportTotalMinN')]: support + 1 } } });
    expect(report.decision).toBe('HOLD');
    expect(report.gateEvidence.find(entry => entry.gateId === 'support-total' && entry.slice === null))
      .toMatchObject({ status: 'insufficient', outcome: 'HOLD' });
  });

  it('drives the interval level from the preregistered confidence parameter', () => {
    const rows = records({ falseReady: { 'criterion-ready': 10 } });
    const at9500 = evaluate({ rows, ceiling: 'PROMOTE' });
    expect(at9500.gateEvidence.find(entry => entry.gateId === 'false-ready-upper' && entry.slice === null).status).toBe('pass');
    const at9998 = evaluate({ rows, ceiling: 'PROMOTE',
      spec: { parameters: { [param('confidenceLevelBps')]: 9998 } } });
    expect(at9998.decision).toBe('HOLD');
    expect(at9998.gateEvidence.find(entry => entry.gateId === 'false-ready-upper' && entry.slice === null))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
  });

  it('holds a missing staged-calibration attestation while every other gate passes', () => {
    const report = evaluate({ rows: records({ calibration: false }), ceiling: 'PROMOTE' });
    expect(report.decision).toBe('HOLD');
    expect(report.gateEvidence.find(entry => entry.gateId === 'calibration-artifact'))
      .toMatchObject({ status: 'insufficient', outcome: 'HOLD' });
    expect(report.gateEvidence.filter(entry => entry.gateId !== 'calibration-artifact').every(entry => entry.status === 'pass')).toBe(true);
  });

  it('holds all-review coverage below the floor while the always-review reference stays non-gating', () => {
    const rows = records({ coverage: Object.fromEntries(SLICES.map(slice => [slice, 0])) });
    const report = evaluate({ rows, ceiling: 'PROMOTE' });
    expect(report.decision).toBe('HOLD');
    expect(report.gateEvidence.find(entry => entry.gateId === 'coverage-lower'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
    expect(report.references).toEqual([{ name: 'always-review', kind: 'always-review', observed: false }]);
  });

  it('holds a per-slice accuracy shortfall without failing the other slices', () => {
    const rows = records({ accuracy: { 'criterion-incomplete': 60 } });
    const report = evaluate({ rows, ceiling: 'PROMOTE' });
    expect(report.decision).toBe('HOLD');
    const failed = report.gateEvidence.filter(entry => entry.gateId === 'accuracy-floor' && entry.status === 'fail');
    expect(failed.map(entry => entry.slice)).toEqual(['criterion-incomplete']);
  });

  it('refuses a binding frozen at or after holdout access', () => {
    expect(() => evaluate({ accessedAt: FROZEN_AT })).toThrow(/froze at or after holdout access/);
    expect(() => evaluate({ accessedAt: null })).toThrow(/no access but the binding declares held-out data/);
  });

  it('never upgrades an upstream HOLD or ROLLBACK ceiling', () => {
    for (const decision of ['HOLD', 'ROLLBACK']) {
      const integrity = cleanIntegrity({ release_gate: { decision, reasons: ['operator-hold'] } });
      const report = evaluate({ integrity });
      expect(report.decision).toBe(decision);
      expect(report.ceilings.upstreamCeiling).toBe(decision);
    }
  });

  it('refuses a forged or missing upstream integrity record instead of downgrading it', () => {
    const gateBinding = binding();
    const registries = registry();
    const forged = cleanIntegrity({ sample_n: 999 });
    expect(() => evaluateGates({
      binding: gateBinding, registry: registries, trustedBindingDigest: artifactDigest(gateBinding),
      holdout: sealGateHoldout({ frozenDigest: artifactDigest(gateBinding), firstAccessedAt: ACCESSED_AT }),
      metrics: metrics(records({})), upstream: { metadata: forged, digest: sealUpstream(cleanIntegrity()).digest },
      now: NOW, floors: resolveProjectFloors({}),
    })).toThrow(/upstream integrity digest does not match/);
    expect(() => evaluateGates({
      binding: gateBinding, registry: registries, trustedBindingDigest: artifactDigest(gateBinding),
      holdout: sealGateHoldout({ frozenDigest: artifactDigest(gateBinding), firstAccessedAt: ACCESSED_AT }),
      metrics: metrics(records({})), upstream: null, now: NOW, floors: resolveProjectFloors({}),
    })).toThrow(/sealed upstream/);
  });

  it('validates the D29 gate report through the shared report validator', () => {
    const gateBinding = binding();
    const report = evaluate({});
    expect(validateGateReport(report, {
      binding: gateBinding, registry: registry(), trustedBindingDigest: artifactDigest(gateBinding),
      holdout: sealGateHoldout({ frozenDigest: artifactDigest(gateBinding), firstAccessedAt: ACCESSED_AT }),
      metrics: metrics(records({})), upstream: sealUpstream(cleanIntegrity()), now: NOW, floors: resolveProjectFloors({}),
    })).toEqual({ valid: true, reasons: [] });
  });
});
