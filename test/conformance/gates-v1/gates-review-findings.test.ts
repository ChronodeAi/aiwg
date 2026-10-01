import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import {
  buildQualificationReleaseRecord, verifyQualificationReleaseDigest,
} from '../../../src/decision/qualification/release.js';
import { GateEvaluationError, evaluateGates, sealGateHoldout } from '../../../src/gates/evaluate.js';
import { validateGateReport } from '../../../src/gates/report.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { validateGateDocument } from '../../../src/gates/schema.js';
import type { GatePack } from '../../../src/gates/types.js';
import { legacySha256 } from '../../../src/gates/stats/digest.js';
import { createCoreProviderRegistry, proportionProvider } from '../../../src/gates/providers/index.js';
import { syntheticReleaseInput } from './digest-helper.js';
import {
  NOW, evaluateFixture, loadPack, makeBinding, makeUpstream, passingMetrics,
  proportionRecords, testHoldout, testRegistry, trustedDigest,
} from './helper.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const badMetrics = () => {
  const metrics = passingMetrics();
  return {
    ...metrics,
    providers: {
      ...metrics.providers,
      [proportionProvider.id]: proportionProvider.compute([
        ...proportionRecords({ a: { n: 1000, events: 300 }, b: { n: 1000, events: 300 } }, 'false-ready'),
        ...proportionRecords({ a: { n: 1000, events: 500 }, b: { n: 1000, events: 500 } }, 'coverage'),
      ]),
    },
  };
};

const evaluateContext = (binding = makeBinding()) => {
  const { registry } = testRegistry();
  return {
    binding, registry, trustedBindingDigest: trustedDigest(binding), holdout: testHoldout(binding),
  };
};

const parentPin = (pack: GatePack) => ({
  id: pack.metadata.id, version: pack.metadata.version, digest: artifactDigest(pack),
});

describe('gates review findings', () => {
  it('H1-P1: caller-emptied resolved.packs must not PROMOTE on breached metrics', () => {
    const binding = makeBinding();
    const input = {
      ...evaluateContext(binding),
      resolved: { packs: [] },
      metrics: badMetrics(), upstream: makeUpstream('promote'), now: NOW,
    } as never;
    expect(() => evaluateGates(input)).toThrow(GateEvaluationError);
  });

  it('H1-P2: caller-tampered resolved gates are refused (resolution is internal)', () => {
    const binding = makeBinding();
    const input = {
      ...evaluateContext(binding),
      resolved: { packs: [], parameters: {} },
      metrics: badMetrics(), upstream: makeUpstream('promote'), now: NOW,
    } as never;
    expect(() => evaluateGates(input)).toThrow(/caller-supplied gate resolution/);
    // And the honest internal resolution still refuses to PROMOTE breached metrics.
    expect(evaluateGates({ ...evaluateContext(binding), metrics: badMetrics(),
      upstream: makeUpstream('promote'), now: NOW }).decision).not.toBe('PROMOTE');
  });

  it('H1-P3: loosened caller parameters cannot PROMOTE under the pinned digest', () => {
    const binding = makeBinding();
    const tampered = clone(binding);
    const key = Object.keys(tampered.spec.parameters).find(name => name.endsWith('.falseReadyMaxBps'))!;
    tampered.spec.parameters[key] = 10000;
    // A caller-rewritten binding no longer matches its trusted pin.
    expect(() => evaluateGates({ ...evaluateContext(binding), binding: tampered,
      metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW }))
      .toThrow(/binding digest does not match/);
  });

  it('H4: evidence rewritten to pass with a recomputed digest must not validate', () => {
    const binding = makeBinding();
    const input = { ...evaluateContext(binding), metrics: badMetrics(), upstream: makeUpstream('promote'), now: NOW };
    const report = clone(evaluateGates(input));
    expect(report.decision).not.toBe('PROMOTE');
    for (const entry of report.gateEvidence) {
      if (entry.gateId !== 'blocking-events') {
        entry.status = 'pass';
        entry.outcome = 'PROMOTE';
        entry.reasons = [`${entry.gateId}:bound-within-threshold`];
      }
    }
    (report.ceilings as { packOutcome: unknown }).packOutcome = 'PROMOTE';
    const { digest: _dropped, ...fields } = report;
    void _dropped;
    const resealed = { ...fields, digest: artifactDigest(fields) };
    const validation = validateGateReport(resealed, input);
    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain('report-reevaluation-mismatch');
  });

  it('H3: missing trusted holdout inputs must refuse; binding self-report must be ignored', () => {
    const binding = makeBinding();
    const base = { ...evaluateContext(binding), metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW };
    expect(() => evaluateGates({ ...base, holdout: undefined as never })).toThrow(/trusted holdout inputs are required/);
    // Trusted access before the freeze refuses even though the binding's own
    // self-reported field claims no access.
    expect(binding.spec.holdoutAccessedAt).toBeNull();
    expect(() => evaluateGates({
      ...base, holdout: sealGateHoldout({ firstAccessedAt: '2026-09-01T00:00:00.000Z', frozenDigest: trustedDigest(binding) }),
    })).toThrow(/at or after holdout access/);
    // A frozen-record digest that does not match the trusted pin refuses.
    expect(() => evaluateGates({
      ...base, holdout: sealGateHoldout({ firstAccessedAt: null, frozenDigest: `sha256:${'0'.repeat(64)}` }),
    })).toThrow(/frozen record digest/);
    // An unsealed (plain caller object) holdout is forged: the seal never matches.
    expect(() => evaluateGates({
      ...base, holdout: { firstAccessedAt: null, frozenDigest: trustedDigest(binding) } as never,
    })).toThrow(/holdout record seal/);
  });

  it('H2: loosening the parent after child registration must move the child resolved digest', () => {
    const parent = loadPack();
    const first = new GateRegistry(createCoreProviderRegistry());
    first.registerPack(clone(parent), { namespace: 'aiwg', bundle: 'test-gates' });
    const child: GatePack = {
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: 'project:child-pin', version: '1.0.0', description: 'c' },
      spec: {
        extends: parentPin(parent), metrics: {},
        gates: parent.spec.gates.filter(gate => gate.floor === true),
      },
    };
    first.registerPack(clone(child), { namespace: 'project' });
    const before = first.resolvePack(child.metadata.id);
    const loose = clone(parent);
    // Loosen a floor-gate default the child inherits: the composed child moves.
    loose.spec.parameters!.falseReadyMaxBps!.default = 10000;
    const second = new GateRegistry(createCoreProviderRegistry());
    second.registerPack(loose, { namespace: 'aiwg', bundle: 'test-gates' });
    // The child's parent pin still names the original digest, so re-registering
    // the identical child bytes against the loosened parent must refuse.
    expect(() => second.registerPack(clone(child), { namespace: 'project' })).toThrow(/parent pin mismatch/);
    // Re-pinned against the loosened parent, the composed digest moves.
    const repinned: GatePack = clone(child);
    repinned.spec.extends = parentPin(loose);
    second.registerPack(repinned, { namespace: 'project' });
    const after = second.resolvePack(child.metadata.id);
    expect(after.resolvedDigest).not.toBe(before.resolvedDigest);
  });

  it('H5-P8: converting a literal threshold into a parameter must fail load', () => {
    const parent = loadPack();
    const registry = new GateRegistry(createCoreProviderRegistry());
    registry.registerPack(clone(parent), { namespace: 'aiwg', bundle: 'test-gates' });
    const keep = (id: string) => clone(parent.spec.gates.find(gate => gate.id === id)!);
    const exact = keep('false-ready-exact');
    exact.threshold = { op: 'lte', param: 'looseCap' };
    expect(() => registry.registerPack({
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: 'project:loose-child', version: '1.0.0', description: 'c' },
      spec: {
        extends: parentPin(parent), metrics: {},
        parameters: { looseCap: { type: 'bps', direction: 'lower-is-stricter', default: 200 } },
        gates: [exact, keep('false-ready-upper'), keep('integrity-ceiling')],
      },
    }, { namespace: 'project' })).toThrow(/literal threshold into a parameter/);
  });

  it('H5-P9: count-max all->each must fail load (pooled<=2 is stricter than per-slice<=2)', () => {
    const parent = clone(loadPack());
    parent.metadata = { ...parent.metadata, id: 'aiwg:test-gates/countp' };
    const gate = clone(parent.spec.gates.find(item => item.id === 'blocking-events')!);
    gate.scope = { mode: 'all' };
    gate.threshold = { op: 'lte', value: 2 };
    parent.spec.gates = [gate];
    const registry = new GateRegistry(createCoreProviderRegistry());
    registry.registerPack(parent, { namespace: 'aiwg', bundle: 'test-gates' });
    const each = clone(gate);
    each.scope = { mode: 'each' };
    expect(() => registry.registerPack({
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: 'project:cm-child', version: '1.0.0', description: 'c' },
      spec: { extends: parentPin(parent), metrics: {}, gates: [each] },
    }, { namespace: 'project' })).toThrow(/not a monotone tightening/);
  });

  it('H6: insufficient evidence on a blocking gate must HOLD, never ROLLBACK', () => {
    const metrics = passingMetrics();
    const proportion = metrics.providers[proportionProvider.id]!;
    const starved = {
      ...proportion,
      metrics: {
        ...proportion.metrics,
        'false-ready': { bySlice: {}, pooled: proportion.metrics['false-ready']!.pooled },
      },
    };
    const report = evaluateFixture({
      metrics: { ...metrics, providers: { ...metrics.providers, [proportionProvider.id]: starved } },
    });
    expect(report.gateEvidence.find(entry => entry.gateId === 'blocking-events')).toMatchObject({
      status: 'insufficient', outcome: 'HOLD',
    });
  });

  it('H6: a ROLLBACK-onFail ceiling gate must mirror a HOLD upstream, never escalate', () => {
    const parent = clone(loadPack());
    parent.metadata = { ...parent.metadata, id: 'aiwg:test-gates/ceiling-rollback' };
    const ceiling = parent.spec.gates.find(gate => gate.id === 'integrity-ceiling')!;
    ceiling.onFail = 'ROLLBACK';
    const registry = new GateRegistry(createCoreProviderRegistry());
    registry.registerPack(parent, { namespace: 'aiwg', bundle: 'test-gates' });
    const digest = artifactDigest(parent);
    const binding = makeBinding({
      spec: {
        packs: [{ id: parent.metadata.id, version: '1.0.0', digest, resolvedDigest: digest }],
        parameters: {
          [`${parent.metadata.id}.falseReadyMaxBps`]: 100,
          [`${parent.metadata.id}.coverageMinBps`]: 1500,
          [`${parent.metadata.id}.minTotalN`]: 50,
          [`${parent.metadata.id}.maxBlockingEvents`]: 0,
          [`${parent.metadata.id}.maxLatency`]: 500,
        },
      },
    });
    const report = evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(), upstream: makeUpstream('hold'), now: NOW,
    });
    expect(report.gateEvidence.find(entry => entry.gateId === 'integrity-ceiling')).toMatchObject({
      status: 'fail', outcome: 'HOLD',
    });
  });

  it('H6: gate outcomes must come from onFail/onInsufficient, never PROMOTE on shortfall', () => {
    const pack = loadPack() as unknown as Record<string, any>;
    expect(() => validateGateDocument({
      ...pack, spec: { ...pack.spec, gates: [{ ...pack.spec.gates[0], onFail: 'HOLD' }] },
    } as unknown)).not.toThrow();
    expect(() => validateGateDocument({
      ...pack, spec: { ...pack.spec, gates: [{ ...pack.spec.gates[0], onFail: 'PROMOTE' }] },
    } as unknown)).toThrow();
    expect(() => validateGateDocument({
      ...pack, spec: { ...pack.spec, gates: [{ ...pack.spec.gates[0], severity: 'blocking' }] },
    } as unknown)).toThrow();
  });

  it('H7: a legacy digest on a newly written v2 release record is rejected even under allowlist', () => {
    const { executed, input } = syntheticReleaseInput();
    const record = buildQualificationReleaseRecord(executed, input) as unknown as Record<string, any>;
    expect(record.schemaVersion).toBe('decision-qualification-release/v2');
    const { digest: _dropped, ...fields } = record;
    void _dropped;
    const legacy = { ...fields, digest: legacySha256(fields) };
    expect(verifyQualificationReleaseDigest(record as never)).toBe('canonical');
    expect(verifyQualificationReleaseDigest(legacy as never)).toBeNull();
    expect(verifyQualificationReleaseDigest(legacy as never, { digestModes: ['canonical', 'legacy'] })).toBeNull();
    // Pre-migration v1 records with a legacy digest still verify under allowlist.
    const v1fields = { ...fields, schemaVersion: 'decision-qualification-release/v1' };
    const v1legacy = { ...v1fields, digest: legacySha256(v1fields) };
    expect(verifyQualificationReleaseDigest(v1legacy as never, { digestModes: ['canonical', 'legacy'] })).toBe('legacy');
  });

  it('M1: gates over unpinned providers must fail binding load', () => {
    const binding = makeBinding({
      spec: {
        metricProviders: [{
          id: proportionProvider.id, version: proportionProvider.version,
          sourceDigest: proportionProvider.sourceDigest,
        }],
      },
    });
    expect(() => testRegistry().registry.resolveBinding(binding)).toThrow(/unpinned/);
  });

  it('M2: each+except covering every slice must not PROMOTE vacuously', () => {
    const parent = clone(loadPack());
    parent.metadata = { ...parent.metadata, id: 'aiwg:test-gates/vac' };
    const gate = clone(parent.spec.gates.find(item => item.id === 'false-ready-exact')!);
    gate.scope = { mode: 'each', except: ['a', 'b'] };
    parent.spec.gates = [gate];
    const registry = new GateRegistry(createCoreProviderRegistry());
    registry.registerPack(parent, { namespace: 'aiwg', bundle: 'test-gates' });
    const digest = artifactDigest(parent);
    const binding = makeBinding({
      spec: {
        packs: [{ id: parent.metadata.id, version: '1.0.0', digest, resolvedDigest: digest }],
        parameters: {},
      },
    });
    // Statically determinable vacuity is a load error.
    expect(() => registry.resolveBinding(binding)).toThrow(/excludes every binding slice/);
  });

  it('L1: colliding short parameter names across packs must stay namespaced', () => {
    const first = clone(loadPack());
    first.metadata = { ...first.metadata, id: 'aiwg:test-gates/ns-a' };
    first.spec.parameters = { cap: { type: 'bps', direction: 'lower-is-stricter', default: 100 } };
    first.spec.gates = [{ ...first.spec.gates.find(gate => gate.id === 'false-ready-upper')!,
      threshold: { op: 'lte', param: 'cap' } }];
    const second = clone(loadPack());
    second.metadata = { ...second.metadata, id: 'aiwg:test-gates/ns-b' };
    second.spec.parameters = { cap: { type: 'bps', direction: 'lower-is-stricter', default: 50 } };
    second.spec.gates = [{ ...second.spec.gates.find(gate => gate.id === 'false-ready-upper')!,
      threshold: { op: 'lte', param: 'cap' } }];
    const registry = new GateRegistry(createCoreProviderRegistry());
    registry.registerPack(first, { namespace: 'aiwg', bundle: 'test-gates' });
    registry.registerPack(second, { namespace: 'aiwg', bundle: 'test-gates' });
    const both = (pack: GatePack) => {
      const digest = artifactDigest(pack);
      return { id: pack.metadata.id, version: '1.0.0', digest, resolvedDigest: digest };
    };
    // An unqualified short name is undeclared: each pack needs its own qualified value.
    const unqualified = makeBinding({
      spec: { packs: [both(first), both(second)], parameters: { cap: 100 } },
    });
    expect(() => registry.resolveBinding(unqualified)).toThrow(/undeclared parameter/);
    const qualified = makeBinding({
      spec: { packs: [both(first), both(second)],
        parameters: { [`${first.metadata.id}.cap`]: 100, [`${second.metadata.id}.cap`]: 50 } },
    });
    const resolved = registry.resolveBinding(qualified);
    expect(resolved.parameters[`${first.metadata.id}.cap`]).toBe(100);
    expect(resolved.parameters[`${second.metadata.id}.cap`]).toBe(50);
  });

  it('L2: aiwg shadow registration must be order-independent', () => {
    const registry = new GateRegistry(createCoreProviderRegistry());
    const addon = clone(loadPack());
    addon.metadata = { ...addon.metadata, id: 'addon:test-gates/conformance-v1' };
    registry.registerPack(addon, { namespace: 'addon', bundle: 'test-gates' });
    const shipped = clone(loadPack());
    expect(() => registry.registerPack(shipped, { namespace: 'aiwg', bundle: 'test-gates' })).toThrow(/shadow/);
  });

  it('L2: shared rest-paths across non-aiwg namespaces resolve only by full id', () => {
    const registry = new GateRegistry(createCoreProviderRegistry());
    const addon = clone(loadPack());
    addon.metadata = { ...addon.metadata, id: 'addon:test-gates/shared-name' };
    const extension = clone(loadPack());
    extension.metadata = { ...extension.metadata, id: 'extension:test-gates/shared-name' };
    registry.registerPack(addon, { namespace: 'addon', bundle: 'test-gates' });
    registry.registerPack(extension, { namespace: 'extension', bundle: 'test-gates' });
    expect(() => registry.resolvePack('test-gates/shared-name')).toThrow(/ambiguous/);
    expect(registry.resolvePack('addon:test-gates/shared-name').authored.metadata.id)
      .toBe('addon:test-gates/shared-name');
  });

  it('L3: except with mode all must fail load', () => {
    const pack = clone(loadPack());
    pack.metadata = { ...pack.metadata, id: 'aiwg:test-gates/except-all' };
    const gate = clone(pack.spec.gates.find(item => item.id === 'false-ready-upper')!);
    gate.scope = { mode: 'all', except: ['a'] };
    pack.spec.gates = [gate];
    const registry = new GateRegistry(createCoreProviderRegistry());
    expect(() => registry.registerPack(pack, { namespace: 'aiwg', bundle: 'test-gates' })).toThrow(/only allowed with mode each/);
  });

  it('L3: paired observations whose n disagrees with cell sums must be insufficient', () => {
    const metrics = passingMetrics();
    const paired = clone(metrics.providers['test.paired/v1']!);
    for (const observation of Object.values(paired.metrics.contrast!.bySlice)) {
      (observation as { n: number }).n += 5;
    }
    if (paired.metrics.contrast!.pooled !== null) {
      (paired.metrics.contrast!.pooled as { n: number }).n += 10;
    }
    const report = evaluateFixture({
      metrics: { ...metrics, providers: { ...metrics.providers, 'test.paired/v1': paired } },
    });
    expect(report.gateEvidence.find(entry => entry.gateId === 'contrast-ni')?.status).toBe('insufficient');
  });

  it('L3: proportion observations with events above n must be insufficient', () => {
    const metrics = passingMetrics();
    const proportion = clone(metrics.providers[proportionProvider.id]!);
    proportion.metrics['false-ready']!.bySlice.a = { n: 10, events: 11 };
    proportion.metrics['false-ready']!.pooled = { n: 1010, events: 11 };
    const report = evaluateFixture({
      metrics: { ...metrics, providers: { ...metrics.providers, [proportionProvider.id]: proportion } },
    });
    // The corrupt per-slice observation is insufficient, never silently dropped or trusted.
    expect(report.gateEvidence.find(entry => entry.gateId === 'false-ready-exact' && entry.slice === 'a'))
      .toMatchObject({ status: 'insufficient' });
  });
});
