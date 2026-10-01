import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import {
  buildQualificationReleaseRecord, verifyQualificationReleaseDigest,
} from '../../../src/decision/qualification/release.js';
import {
  freezeBinaryBenchmarkPlan, freezeQualificationSplit, verifyBinaryBenchmarkPlanDigest,
} from '../../../src/decision/qualification/quality.js';
import { evaluateGates, sealGateHoldout } from '../../../src/gates/evaluate.js';
import { validateGateReport } from '../../../src/gates/report.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { legacySha256 } from '../../../src/gates/stats/digest.js';
import { createCoreProviderRegistry, proportionProvider } from '../../../src/gates/providers/index.js';
import { syntheticReleaseInput } from './digest-helper.js';
import {
  NOW, loadPack, makeBinding, makeUpstream, packParam, passingMetrics,
  proportionRecords, testHoldout, testRegistry, trustedDigest,
} from './helper.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Metrics that breach the fixture false-ready upper bound (30% false-ready vs 100bps cap). */
const breachedMetrics = () => {
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

describe('gates fix round 2 regressions', () => {
  it('HIGH1-N1: subclassed registry that empties gates and loosens params must not PROMOTE', () => {
    const binding = makeBinding();
    class Evil extends GateRegistry {
      override resolveBinding(doc: unknown) {
        const resolved = super.resolveBinding(doc);
        return {
          ...resolved,
          packs: resolved.packs.map(pack => ({
            ...pack,
            resolved: {
              ...pack.resolved,
              spec: {
                ...pack.resolved.spec,
                gates: pack.resolved.spec.gates.filter(gate => gate.kind === 'minimum-n'),
              },
            },
          })),
          parameters: { ...resolved.parameters, [packParam('falseReadyMaxBps')]: 10000 },
        };
      }
    }
    const evil = new Evil(createCoreProviderRegistry());
    evil.registerPack(loadPack(), { namespace: 'aiwg', bundle: 'test-gates' });
    const input = {
      binding, registry: evil, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: breachedMetrics(),
      upstream: makeUpstream('promote'), now: NOW,
    };
    const report = evaluateGates(input);
    // Honest evaluation of breached metrics holds; tampered composition must never promote.
    expect(report.decision).not.toBe('PROMOTE');
    expect(report.gateEvidence.length).toBeGreaterThan(1);
  });

  it('HIGH1-N1b: duck-typed registry must be rejected, never PROMOTE', () => {
    const binding = makeBinding();
    const { registry: real } = testRegistry();
    const fake = {
      resolveBinding: (doc: unknown) => {
        const resolved = real.resolveBinding(doc);
        return {
          ...resolved,
          packs: resolved.packs.map(pack => ({
            ...pack,
            resolved: { ...pack.resolved, spec: { ...pack.resolved.spec, gates: [pack.resolved.spec.gates[0]] } },
          })),
        };
      },
    };
    expect(() => evaluateGates({
      binding, registry: fake as never, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: breachedMetrics(),
      upstream: makeUpstream('promote'), now: NOW,
    })).toThrow(/GateRegistry/);
  });

  it('HIGH1: tampered resolved digest that keeps pins must not validate as PROMOTE', () => {
    const binding = makeBinding();
    class Evil extends GateRegistry {
      override resolveBinding(doc: unknown) {
        const resolved = super.resolveBinding(doc);
        return {
          ...resolved,
          packs: resolved.packs.map(pack => ({
            ...pack,
            resolved: {
              ...pack.resolved,
              spec: {
                ...pack.resolved.spec,
                gates: pack.resolved.spec.gates.filter(gate => gate.kind === 'minimum-n'),
              },
            },
          })),
          parameters: { ...resolved.parameters, [packParam('falseReadyMaxBps')]: 10000 },
        };
      }
    }
    const evil = new Evil(createCoreProviderRegistry());
    evil.registerPack(loadPack(), { namespace: 'aiwg', bundle: 'test-gates' });
    const input = {
      binding, registry: evil, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: breachedMetrics(),
      upstream: makeUpstream('promote'), now: NOW,
    };
    const report = evaluateGates(input);
    expect(report.decision).not.toBe('PROMOTE');
    expect(validateGateReport(report, input).valid).toBe(true);
  });

  it('HIGH2: forged null holdout on a split binding must refuse instead of PROMOTE', () => {
    const splitDigest = artifactDigest({ split: 'test' });
    const binding = makeBinding({ spec: { splitDigest } });
    const input = {
      binding,
      registry: testRegistry().registry,
      trustedBindingDigest: trustedDigest(binding),
      holdout: { firstAccessedAt: null, frozenDigest: trustedDigest(binding) },
      metrics: passingMetrics(),
      upstream: makeUpstream('promote'),
      now: NOW,
    };
    // The binding declares held-out data yet the caller asserts no access: fail closed.
    expect(() => evaluateGates(input)).toThrow(/holdout/);
  });

  it('HIGH2: binding frozen after its own declared access must refuse even with null holdout', () => {
    const binding = makeBinding({
      spec: {
        frozenAt: '2026-09-02T00:00:00.000Z',
        holdoutAccessedAt: '2026-09-01T12:00:00.000Z',
        splitDigest: artifactDigest({ split: 'test' }),
      },
    });
    expect(() => evaluateGates({
      binding,
      registry: testRegistry().registry,
      trustedBindingDigest: trustedDigest(binding),
      holdout: { firstAccessedAt: null, frozenDigest: trustedDigest(binding) },
      metrics: passingMetrics(),
      upstream: makeUpstream('promote'),
      now: NOW,
    })).toThrow(/holdout/);
  });

  it('R3: a sealed holdout record with a first-access time after the evaluation timestamp is refused', () => {
    const binding = makeBinding({ spec: { splitDigest: artifactDigest({ split: 'test' }) } });
    const future = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect(() => evaluateGates({
      binding,
      registry: testRegistry().registry,
      trustedBindingDigest: trustedDigest(binding),
      holdout: sealGateHoldout({ frozenDigest: trustedDigest(binding), firstAccessedAt: future }),
      metrics: passingMetrics(),
      upstream: makeUpstream('promote'),
      now: NOW,
    })).toThrow(/after the evaluation timestamp/);
  });

  it('HIGH3: legacy digest on a freshly built release record must be rejected even under allowlist', () => {
    const { executed, input } = syntheticReleaseInput();
    const record = buildQualificationReleaseRecord(executed, input) as unknown as Record<string, unknown>;
    const { digest: _dropped, ...fields } = record as { digest: unknown } & Record<string, unknown>;
    void _dropped;
    // Fresh builders emit canonical-only digests: a legacy digest over the same
    // freshly built fields must never verify, even under an explicit allowlist.
    const legacy = { ...fields, digest: legacySha256(fields) };
    expect(verifyQualificationReleaseDigest(legacy as never, { digestModes: ['canonical', 'legacy'] })).toBeNull();
  });

  it('HIGH3: legacy digest on a freshly built benchmark plan must be rejected even under allowlist', () => {
    const splits = [
      freezeQualificationSplit('tuning', ['train-1']),
      freezeQualificationSplit('calibration', ['cal-1']),
      freezeQualificationSplit('test', ['test-1', 'test-2']),
    ];
    const labels = ['train-1', 'cal-1', 'test-1', 'test-2'].map(id => ({ id, label: 1 as const, slice: 'a' }));
    const limits = { minimumOverallN: 2, minimumSliceN: 1, maximumSelectiveRisk: 0.1, maximumReviewRate: 0.5, maximumBrier: 0.2 };
    const plan = freezeBinaryBenchmarkPlan(splits, labels, limits) as unknown as Record<string, unknown>;
    const { digest: _dropped, ...fields } = plan as { digest: unknown } & Record<string, unknown>;
    void _dropped;
    // Fresh builders emit canonical-only digests: a legacy digest over the same
    // freshly built fields must never verify, even under an explicit allowlist.
    const legacy = { ...fields, digest: legacySha256(fields) };
    expect(verifyBinaryBenchmarkPlanDigest(legacy as never, labels, { digestModes: ['canonical', 'legacy'] })).toBeNull();
  });

  it('HIGH3: existing v1 evidence with legacy digest still verifies under allowlist', () => {
    const splits = [
      freezeQualificationSplit('tuning', ['train-1']),
      freezeQualificationSplit('calibration', ['cal-1']),
      freezeQualificationSplit('test', ['test-1', 'test-2']),
    ];
    const labels = ['train-1', 'cal-1', 'test-1', 'test-2'].map(id => ({ id, label: 1 as const, slice: 'a' }));
    const limits = { minimumOverallN: 2, minimumSliceN: 1, maximumSelectiveRisk: 0.1, maximumReviewRate: 0.5, maximumBrier: 0.2 };
    const plan = freezeBinaryBenchmarkPlan(splits, labels, limits) as unknown as Record<string, unknown>;
    const { digest: _dropped, ...fields } = plan as { digest: unknown } & Record<string, unknown>;
    void _dropped;
    const v1fields = { ...fields, schemaVersion: 'decision-binary-benchmark-plan/v1' };
    const legacy = { ...v1fields, digest: legacySha256(v1fields) };
    expect(verifyBinaryBenchmarkPlanDigest(legacy as never, labels, { digestModes: ['canonical', 'legacy'] })).toBe('legacy');
    const { executed, input } = syntheticReleaseInput();
    const record = buildQualificationReleaseRecord(executed, input) as unknown as Record<string, unknown>;
    const { digest: _r, ...rfields } = record as { digest: unknown } & Record<string, unknown>;
    void _r;
    const v1record = { ...rfields, schemaVersion: 'decision-qualification-release/v1' };
    const legacyRecord = { ...v1record, digest: legacySha256(v1record) };
    expect(verifyQualificationReleaseDigest(legacyRecord as never, { digestModes: ['canonical', 'legacy'] })).toBe('legacy');
  });
});
