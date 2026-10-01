import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { GateRegistry, GateRegistryError, splitPackId } from '../../../src/gates/registry.js';
import type { GateDefinition, GatePack } from '../../../src/gates/types.js';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import { loadPack, makeBinding, packParam, testRegistry } from './helper.js';

const origin = { namespace: 'aiwg', bundle: 'test-gates' } as const;

const parentPin = (pack: GatePack = loadPack()) => ({
  id: pack.metadata.id, version: pack.metadata.version, digest: artifactDigest(pack),
});

const childPack = (gates: GateDefinition[], extra?: Partial<GatePack['spec']>): GatePack => {
  const parent = loadPack();
  return {
    apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
    metadata: { id: 'aiwg:test-gates/conformance-child', version: '1.0.0', description: 'Tightening child.' },
    spec: { extends: parentPin(parent), metrics: {}, gates, ...extra },
  };
};

const findGate = (id: string): GateDefinition => {
  const gate = loadPack().spec.gates.find(candidate => candidate.id === id);
  if (gate === undefined) throw new Error(`fixture gate missing: ${id}`);
  return JSON.parse(JSON.stringify(gate)) as GateDefinition;
};

/** A top-level (non-extending) clone of the fixture pack under a new id. */
const topPack = (id: string): GatePack => {
  const pack = JSON.parse(JSON.stringify(loadPack())) as GatePack;
  pack.metadata = { ...pack.metadata, id };
  delete pack.spec.extends;
  return pack;
};

describe('gates registry namespaces', () => {
  it('parses the five namespaces and rejects malformed ids', () => {
    expect(splitPackId('aiwg:decision-engine/absolute-screening')).toEqual({
      namespace: 'aiwg', rest: 'decision-engine/absolute-screening',
    });
    expect(splitPackId('project:floor-pack')).toEqual({ namespace: 'project', rest: 'floor-pack' });
    for (const id of ['no-namespace', 'aiwg:', 'other:x/y', 'aiwg:bundle-only', 'project:a/b', 'aiwg:a b/c', '']) {
      expect(() => splitPackId(id), id).toThrow(GateRegistryError);
    }
  });

  it('pins contributions to their origin bundle and refuses duplicates', () => {
    const { registry } = testRegistry();
    expect(() => registry.registerPack(loadPack(), { namespace: 'aiwg', bundle: 'other-bundle' }))
      .toThrow(/does not belong to bundle/);
    expect(() => registry.registerPack(loadPack(), origin)).toThrow(/duplicate gate pack/);
    expect(() => registry.getPack('aiwg:test-gates/missing')).toThrow(/unknown gate pack/);
  });

  it('refuses non-aiwg packs that shadow a shipped aiwg: name', () => {
    const { registry } = testRegistry();
    const shadow = topPack('addon:test-gates/conformance-v1');
    expect(() => registry.registerPack(shadow, { namespace: 'addon', bundle: 'test-gates' }))
      .toThrow(/shadows shipped pack/);
  });

  it('refuses shipped packs that shadow an already registered non-aiwg name', () => {
    const registry = new GateRegistry(createCoreProviderRegistry());
    const addon = topPack('addon:test-gates/conformance-v1');
    registry.registerPack(addon, { namespace: 'addon', bundle: 'test-gates' });
    expect(() => registry.registerPack(loadPack(), origin)).toThrow(/shadows shipped pack/);
  });

  it('reports ambiguous rest-paths unless the full id is pinned', () => {
    const registry = new GateRegistry(createCoreProviderRegistry());
    registry.registerPack(topPack('addon:test-gates/shared-name'), { namespace: 'addon', bundle: 'test-gates' });
    registry.registerPack(topPack('extension:test-gates/shared-name'), { namespace: 'extension', bundle: 'test-gates' });
    expect(() => registry.resolvePack('test-gates/shared-name')).toThrow(/ambiguous/);
    expect(registry.resolvePack('addon:test-gates/shared-name').authored.metadata.id)
      .toBe('addon:test-gates/shared-name');
  });

  it('registers project packs that do not collide', () => {
    const { registry } = testRegistry();
    const project = topPack('project:conformance-floor');
    expect(registry.registerPack(project, { namespace: 'project' }).metadata.id).toBe('project:conformance-floor');
  });
});

describe('gates extends tightening', () => {
  it('accepts threshold, support, outcome and scope tightenings', () => {
    const { registry } = testRegistry();
    const upper = { ...findGate('false-ready-upper'), threshold: { op: 'lte' as const, value: 80 } };
    const support = { ...findGate('support-total'), minimumN: 100 };
    const promoted = { ...findGate('coverage-lower'), onFail: 'ROLLBACK' as const };
    const widened = { ...findGate('blocking-events'), scope: { mode: 'listed' as const, slices: ['a', 'b'] } };
    const perSlice = { ...findGate('coverage-events'), scope: { mode: 'each' as const } };
    const dropped = ['false-ready-upper', 'support-total', 'coverage-lower', 'blocking-events', 'coverage-events'];
    const remaining = loadPack().spec.gates.filter(gate => gate.id !== 'latency-cap' && !dropped.includes(gate.id));
    const child = childPack([upper, support, promoted, widened, perSlice, ...remaining]);
    expect(() => registry.registerPack(child, origin)).not.toThrow();
    const resolved = registry.resolvePack(child.metadata.id).resolved;
    expect(resolved.spec.gates.find(gate => gate.id === 'false-ready-upper')?.threshold).toEqual({ op: 'lte', value: 80 });
    // Removing a non-floor gate is allowed.
    expect(resolved.spec.gates.some(gate => gate.id === 'latency-cap')).toBe(false);
    // count-min all -> each is a monotone tightening (per-slice floors imply the pooled floor).
    expect(resolved.spec.gates.find(gate => gate.id === 'coverage-events')?.scope).toEqual({ mode: 'each' });
  });

  it('rejects every loosening with a load error', () => {
    const cases: Array<[string, (gate: GateDefinition) => GateDefinition]> = [
      ['threshold', gate => gate.id === 'false-ready-upper'
        ? { ...gate, threshold: { op: 'lte' as const, value: 120 } } : gate],
      ['literal-to-param', gate => gate.id === 'false-ready-exact'
        ? { ...gate, threshold: { op: 'lte' as const, param: 'looseCap' } } : gate],
      ['minimumN', gate => gate.id === 'support-total' ? { ...gate, minimumN: 10 } : gate],
      ['onFail', gate => gate.id === 'contrast-ni' ? { ...gate, onFail: 'HOLD' as const } : gate],
      ['unfloor', gate => gate.id === 'false-ready-upper' ? { ...gate, floor: false } : gate],
      ['method', gate => gate.id === 'false-ready-upper'
        ? { ...gate, statistic: { ...gate.statistic!, kind: 'interval-bound' as const, method: 'clopper-pearson' as const } } : gate],
      ['level', gate => gate.id === 'false-ready-upper'
        ? { ...gate, statistic: { ...gate.statistic!, kind: 'interval-bound' as const, levelBps: 9000 } } : gate],
      ['kind', gate => gate.id === 'coverage-events' ? { ...gate, kind: 'count-max' as const } : gate],
      ['metric', gate => gate.id === 'coverage-events'
        ? { ...gate, metric: { provider: 'test.proportion/v1', name: 'false-ready' } } : gate],
      ['scope', gate => gate.id === 'blocking-events'
        ? { ...gate, scope: { mode: 'listed' as const, slices: ['a'] } } : gate],
      ['scope-each-each', gate => gate.id === 'false-ready-exact'
        ? { ...gate, scope: { mode: 'each' as const, except: ['a'] } } : gate],
      ['all-to-listed', gate => gate.id === 'false-ready-upper'
        ? { ...gate, scope: { mode: 'listed' as const, slices: ['a'] } } : gate],
      ['value-all-each', gate => gate.id === 'latency-cap'
        ? { ...gate, scope: { mode: 'each' as const } } : gate],
      ['margin', gate => gate.id === 'contrast-ni'
        ? { ...gate, statistic: { ...gate.statistic!, kind: 'paired-difference' as const, marginBps: -500 } } : gate],
    ];
    for (const [label, rewrite] of cases) {
      const { registry } = testRegistry();
      const gates = loadPack().spec.gates.map(rewrite);
      const extra = label === 'literal-to-param'
        ? { parameters: { looseCap: { type: 'bps' as const, direction: 'lower-is-stricter' as const, default: 200 } } }
        : undefined;
      expect(() => registry.registerPack(childPack(gates, extra), origin), label).toThrow(GateRegistryError);
    }
  });

  it('refuses to remove a floor gate and to resolve unknown parents', () => {
    const { registry } = testRegistry();
    const gates = loadPack().spec.gates.filter(gate => gate.id !== 'false-ready-upper');
    expect(() => registry.registerPack(childPack(gates), origin)).toThrow(/floor gate/);
    const orphan = childPack(loadPack().spec.gates, {
      extends: { id: 'aiwg:test-gates/missing', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` },
    });
    expect(() => registry.registerPack(orphan, origin)).toThrow(/unknown pack/);
  });

  it('loads packs as data: unknown providers, metrics and incoherent blocks fail', () => {
    const { registry } = testRegistry();
    const unknownProvider = topPack('aiwg:test-gates/unknown-provider');
    unknownProvider.spec.metrics['false-ready'] = { provider: 'test.nope/v1', kind: 'proportion' };
    expect(() => registry.registerPack(unknownProvider, origin)).toThrow(/unknown provider/);
    const unknownMetric = topPack('aiwg:test-gates/unknown-metric');
    unknownMetric.spec.gates = [{ ...findGate('latency-cap'), metric: { provider: 'test.scalar/v1', name: 'nope' } }];
    expect(() => registry.registerPack(unknownMetric, origin)).toThrow(/undeclared metric/);
    const wrongKind = topPack('aiwg:test-gates/wrong-kind');
    wrongKind.spec.metrics.measurement = { provider: 'test.scalar/v1', kind: 'proportion' };
    wrongKind.spec.gates = [{ ...findGate('latency-cap'), metric: { provider: 'test.scalar/v1', name: 'measurement' } }];
    expect(() => registry.registerPack(wrongKind, origin)).toThrow(/does not match provider kind/);
    const strayThreshold = topPack('aiwg:test-gates/stray-threshold');
    strayThreshold.spec.gates = [{ ...findGate('contrast-ni'), threshold: { op: 'gte', value: 0 } }];
    expect(() => registry.registerPack(strayThreshold, origin)).toThrow(/must not carry a threshold/);
  });
});

describe('gates binding resolution', () => {
  it('resolves pins, namespaced parameters and slice inventory', () => {
    const { registry } = testRegistry();
    const resolved = registry.resolveBinding(makeBinding());
    expect(resolved.packs).toHaveLength(1);
    expect(resolved.packs[0]!.resolvedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolved.parameters[packParam('falseReadyMaxBps')]).toBe(100);
    expect(resolved.binding.spec.slices).toEqual(['a', 'b']);
  });

  it('fails closed on pin, provider, parameter, slice and reference mismatches', () => {
    const pack = loadPack();
    const digest = artifactDigest(pack);
    const binding = makeBinding();
    const cases: Array<[string, () => unknown]> = [
      ['unknown pack', () => makeBinding({ spec: { packs: [{ id: 'aiwg:test-gates/missing', version: '1.0.0', digest, resolvedDigest: digest }] } })],
      ['digest mismatch', () => makeBinding({
        spec: { packs: [{ id: pack.metadata.id, version: pack.metadata.version,
          digest: `sha256:${'0'.repeat(64)}`, resolvedDigest: digest }] } })],
      ['composed digest mismatch', () => makeBinding({
        spec: { packs: [{ id: pack.metadata.id, version: pack.metadata.version,
          digest, resolvedDigest: `sha256:${'0'.repeat(64)}` }] } })],
      ['unknown provider', () => makeBinding({
        spec: { metricProviders: [...binding.spec.metricProviders, { id: 'test.nope/v1', version: '1.0.0', sourceDigest: `sha256:${'0'.repeat(64)}` }] } })],
      ['provider digest', () => makeBinding({
        spec: { metricProviders: binding.spec.metricProviders.map(pin => ({ ...pin, sourceDigest: `sha256:${'0'.repeat(64)}` })) } })],
      ['unpinned provider', () => makeBinding({
        spec: { metricProviders: binding.spec.metricProviders.filter(pin => pin.id === 'test.proportion/v1') } })],
      ['undeclared parameter', () => makeBinding({ spec: { parameters: { ...binding.spec.parameters, nope: 1 } } })],
      ['out-of-range parameter', () => makeBinding({
        spec: { parameters: { ...binding.spec.parameters, [packParam('falseReadyMaxBps')]: 20000 } } })],
      ['undeclared reference', () => {
        const altered = loadPack();
        const gates = altered.spec.gates.map(gate => gate.id === 'contrast-ni'
          ? { ...gate, statistic: { ...gate.statistic!, kind: 'paired-difference' as const, vs: 'missing-baseline' } } : gate);
        const { registry: fresh } = testRegistry();
        const parent = { ...altered, metadata: { ...altered.metadata, id: 'aiwg:test-gates/vs-child' },
          spec: { ...altered.spec, extends: parentPin(altered), gates } };
        fresh.registerPack(parent, origin);
        const childDigest = artifactDigest(parent);
        const composed = fresh.resolvePack(parent.metadata.id).resolvedDigest;
        return makeBinding({ spec: { packs: [{ id: 'aiwg:test-gates/vs-child', version: '1.0.0',
          digest: childDigest, resolvedDigest: composed }],
        parameters: {
          'aiwg:test-gates/vs-child.falseReadyMaxBps': 100,
          'aiwg:test-gates/vs-child.coverageMinBps': 1500,
          'aiwg:test-gates/vs-child.minTotalN': 50,
          'aiwg:test-gates/vs-child.maxBlockingEvents': 0,
          'aiwg:test-gates/vs-child.maxLatency': 500,
        } } });
      }],
    ];
    for (const [label, build] of cases) {
      const { registry } = testRegistry();
      expect(() => registry.resolveBinding(build() as never), label).toThrow(GateRegistryError);
    }
  });

  it('requires values for parameters without defaults and rejects time travel', () => {
    const { registry } = testRegistry();
    const required = topPack('aiwg:test-gates/required-param');
    required.spec.parameters = { strictCap: { type: 'bps', direction: 'lower-is-stricter' } };
    required.spec.gates = [{ ...findGate('false-ready-upper'), threshold: { op: 'lte', param: 'strictCap' } }];
    registry.registerPack(required, origin);
    const binding = makeBinding({
      spec: { packs: [{ id: required.metadata.id, version: '1.0.0',
        digest: artifactDigest(required), resolvedDigest: artifactDigest(required) }],
      parameters: {} },
    });
    expect(() => registry.resolveBinding(binding)).toThrow(/missing required parameter/);
    expect(() => registry.resolveBinding(makeBinding({ spec: { registeredAt: '2026-09-05T00:00:00.000Z' } })))
      .toThrow(/registers after it freezes/);
  });
});
