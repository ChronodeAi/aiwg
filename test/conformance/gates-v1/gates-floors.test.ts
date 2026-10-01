import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest } from '../../../src/decision/validate.js';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { evaluateGates } from '../../../src/gates/evaluate.js';
import {
  DEFAULT_PROJECT_FLOOR_PACK, resolveProjectFloors, validateGatesConfig,
} from '../../../src/gates/floors.js';
import type { ProjectFloors } from '../../../src/gates/floors.js';
import { GateRegistry, GateRegistryError, validateResolvedPack } from '../../../src/gates/registry.js';
import { validateGateReport } from '../../../src/gates/report.js';
import type { GateBinding, GateDefinition, GatePack } from '../../../src/gates/types.js';
import {
  createCoreProviderRegistry, evidenceProvider, pairedProvider, proportionProvider, scalarProvider,
} from '../../../src/gates/providers/index.js';
import {
  NOW, FROZEN_AT, REGISTERED_AT, makeBinding, makeUpstream, passingMetrics,
  testHoldout, testRegistry, trustedDigest, loadPack,
} from './helper.js';

/**
 * Project gate floors (#2832): every test here names the property it guards.
 * Refusal tests assert the GateRegistryError class and a diagnostic naming the
 * floor gate; they fail if enforcement is skipped, weakened or misattributed.
 */

const FLOOR_ID = 'project:conformance-floors';
const BINDING_ID = 'test-gates/floor-case';

/** Inline floor pack: the conformance fixture gates as project policy. */
const floorPack = (): GatePack => {
  const pack = JSON.parse(JSON.stringify(loadPack())) as GatePack;
  pack.metadata = { id: FLOOR_ID, version: '1.0.0', description: 'Conformance project floors.' };
  delete pack.spec.extends;
  return pack;
};

const floorsOf = (pack: GatePack = floorPack()): ProjectFloors =>
  resolveProjectFloors({ floors: [{ pack }] });

const floorGate = (id: string): GateDefinition => {
  const gate = floorPack().spec.gates.find(candidate => candidate.id === id);
  if (gate === undefined) throw new Error(`floor gate missing: ${id}`);
  return gate;
};

/** A standalone variant of the floor pack with selected gates rewritten. */
const variantPack = (id: string, rewrite: (gate: GateDefinition) => GateDefinition): GatePack => {
  const pack = floorPack();
  pack.metadata = { ...pack.metadata, id };
  pack.spec.gates = pack.spec.gates.map(rewrite);
  return pack;
};

const loosenOnly = (id: string, patch: Partial<GateDefinition>) =>
  (gate: GateDefinition): GateDefinition => (gate.id === id ? { ...gate, ...patch } : gate);

const dropGate = (id: string) => {
  const pack = floorPack();
  pack.metadata = { ...pack.metadata, id: 'aiwg:test-gates/floor-drop-case' };
  pack.spec.gates = pack.spec.gates.filter(gate => gate.id !== id);
  return pack;
};

/** A binding over a variant pack. Parameter values mirror the fixture defaults. */
const variantBinding = (
  pack: GatePack,
  overrides?: { parameters?: Record<string, number>; ceiling?: GateBinding['spec']['ceiling'] },
): GateBinding => {
  const qualify = (name: string): string => `${pack.metadata.id}.${name}`;
  return {
    apiVersion: 'gates.aiwg.io/v1alpha1',
    kind: 'GateBinding',
    metadata: { id: BINDING_ID, version: '1.0.0', description: 'Floor conformance binding.' },
    spec: {
      packs: [{
        id: pack.metadata.id, version: pack.metadata.version,
        digest: artifactDigest(pack), resolvedDigest: artifactDigest(pack),
      }],
      parameters: {
        [qualify('falseReadyMaxBps')]: 100,
        [qualify('coverageMinBps')]: 1500,
        [qualify('minTotalN')]: 50,
        [qualify('maxBlockingEvents')]: 0,
        [qualify('maxLatency')]: 500,
        ...(overrides?.parameters ?? {}),
      },
      slices: ['a', 'b'],
      references: [{ name: 'always-review', kind: 'always-review' }],
      metricProviders: [proportionProvider, pairedProvider, scalarProvider, evidenceProvider]
        .map(provider => ({ id: provider.id, version: provider.version, sourceDigest: provider.sourceDigest })),
      ceiling: overrides?.ceiling ?? 'PROMOTE',
      registeredAt: REGISTERED_AT,
      frozenAt: FROZEN_AT,
      holdoutAccessedAt: null,
    },
  };
};

const registryWith = (pack: GatePack): GateRegistry => {
  const { registry } = testRegistry();
  registry.registerPack(pack, { namespace: 'aiwg', bundle: 'test-gates' });
  return registry;
};

describe('project floors config validation', () => {
  it('accepts an absent section and a fully specified one', () => {
    expect(validateGatesConfig(undefined)).toEqual([]);
    expect(validateGatesConfig(null)).toEqual([]);
    expect(validateGatesConfig({
      floors: [
        { pack: floorPack() },
        { packRef: { id: 'aiwg:test-gates/conformance-v1', version: '1.0.0', digest: `sha256:${'ab'.repeat(32)}` } },
      ],
      ceilings: { 'some-study': 'HOLD' },
    })).toEqual([]);
  });

  it('fails closed on malformed sections, entries, packs, refs and ceilings', () => {
    expect(validateGatesConfig('nope')).toEqual(['gates: must be an object']);
    expect(validateGatesConfig({ unknown: 1 })).toEqual(['gates.unknown: unknown field']);
    expect(validateGatesConfig({ floors: 'nope' })).toEqual(['gates.floors: must be an array']);
    expect(validateGatesConfig({ floors: [{}] }))
      .toEqual([`gates.floors[0]: must set exactly one of 'pack' or 'packRef'`]);
    expect(validateGatesConfig({ floors: [{ pack: floorPack(), packRef: { id: 'x', version: '1.0.0', digest: `sha256:${'ab'.repeat(32)}` } }] }))
      .toEqual([`gates.floors[0]: must set exactly one of 'pack' or 'packRef'`]);
    expect(validateGatesConfig({ floors: [{ pack: { ...floorPack(), extra: 1 } }] })[0])
      .toMatch(/^gates\.floors\[0\]\.pack: /);
    expect(validateGatesConfig({ floors: [{ pack: { ...floorPack(), kind: 'GateBinding' } }] })[0])
      .toMatch(/^gates\.floors\[0\]\.pack: /);
    const shipped = { ...floorPack(), metadata: { ...floorPack().metadata, id: 'aiwg:test-gates/not-project' } };
    expect(validateGatesConfig({ floors: [{ pack: shipped }] }))
      .toEqual(['gates.floors[0].pack: floor pack id must use the project: namespace (got \'aiwg:test-gates/not-project\')']);
    expect(validateGatesConfig({ floors: [{ packRef: { id: 'aiwg:test-gates/x', version: '1.0', digest: 'nope' } }] }))
      .toEqual([
        'gates.floors[0].packRef.version: required, must be a semantic version (X.Y.Z)',
        'gates.floors[0].packRef.digest: required, must be a sha256 digest',
      ]);
    expect(validateGatesConfig({ floors: [{ packRef: { id: 'no-namespace', version: '1.0.0', digest: `sha256:${'ab'.repeat(32)}` } }] })[0])
      .toMatch(/^gates\.floors\[0\]\.packRef\.id: /);
    expect(validateGatesConfig({ ceilings: { study: 'MAYBE' } }))
      .toEqual(['gates.ceilings.study: must be PROMOTE, HOLD or ROLLBACK']);
    expect(validateGatesConfig({ ceilings: [] }))
      .toEqual(['gates.ceilings: must be an object mapping study ids to outcome ceilings']);
  });
});

describe('project floors default resolution', () => {
  it('injects the operator default integrity-ceiling floor when unconfigured', () => {
    const inputs: Array<ProjectFloors | undefined> = [undefined, {}, { floors: [] }, { ceilings: { study: 'HOLD' } }];
    for (const input of inputs) {
      const resolved = resolveProjectFloors(input);
      expect(resolved.floors).toHaveLength(1);
      const source = resolved.floors[0]!;
      expect(source).toHaveProperty('pack');
      const pack = (source as { pack: GatePack }).pack;
      expect(pack.metadata.id).toBe('project:default-floors');
      expect(pack.spec.gates).toHaveLength(1);
      expect(pack.spec.gates[0]).toMatchObject({
        id: 'integrity-ceiling', kind: 'upstream-ceiling', scope: { mode: 'all' }, onFail: 'HOLD',
      });
    }
    expect(resolveProjectFloors({ ceilings: { study: 'HOLD' } }).ceilings).toEqual({ study: 'HOLD' });
  });

  it('keeps a project-governed integrity ceiling instead of the default', () => {
    const resolved = resolveProjectFloors({ floors: [{ pack: floorPack() }] });
    expect(resolved.floors).toHaveLength(1);
    expect((resolved.floors[0] as { pack: GatePack }).pack.metadata.id).toBe(FLOOR_ID);
  });

  it('appends the default when custom floors do not govern the ceiling', () => {
    const custom = floorPack();
    custom.spec.gates = custom.spec.gates.filter(gate => gate.id !== 'integrity-ceiling');
    const resolved = resolveProjectFloors({ floors: [{ pack: custom }] });
    expect(resolved.floors).toHaveLength(2);
    expect((resolved.floors[1] as { pack: GatePack }).pack.metadata.id).toBe('project:default-floors');
  });

  it('ships a schema-valid default floor pack', () => {
    expect(() => validateResolvedPack(DEFAULT_PROJECT_FLOOR_PACK, createCoreProviderRegistry())).not.toThrow();
  });
});

describe('project floors per-kind loosening', () => {
  // One loosened gate per v1alpha1 kind (plus the scope/outcome/omit/parameter
  // dimensions). Each case fails if floor enforcement is skipped or weakened:
  // the loosened binding resolves cleanly without floors.
  const cases: Array<{ label: string; gate: string; pack: () => GatePack; fragment: RegExp }> = [
    {
      label: 'interval-bound upper threshold', gate: 'false-ready-upper',
      pack: () => variantPack('aiwg:test-gates/floor-loose-upper',
        loosenOnly('false-ready-upper', { threshold: { op: 'lte', value: 200 } })),
      fragment: /loosens project floor gate 'false-ready-upper'/,
    },
    {
      label: 'interval-bound lower threshold', gate: 'coverage-lower',
      pack: () => variantPack('aiwg:test-gates/floor-loose-lower',
        loosenOnly('coverage-lower', { threshold: { op: 'gte', value: 1000 } })),
      fragment: /loosens project floor gate 'coverage-lower'/,
    },
    {
      label: 'interval-bound exact threshold', gate: 'false-ready-exact',
      pack: () => variantPack('aiwg:test-gates/floor-loose-exact',
        loosenOnly('false-ready-exact', { threshold: { op: 'lte', value: 300 } })),
      fragment: /loosens project floor gate 'false-ready-exact'/,
    },
    {
      label: 'paired-difference margin', gate: 'contrast-ni',
      pack: () => {
        const parent = floorGate('contrast-ni');
        return variantPack('aiwg:test-gates/floor-loose-margin', gate => gate.id === 'contrast-ni'
          ? { ...gate, statistic: { ...parent.statistic!, kind: 'paired-difference' as const, marginBps: -500 } }
          : gate);
      },
      fragment: /loosens project floor gate 'contrast-ni'/,
    },
    {
      label: 'paired-difference outcome demotion', gate: 'contrast-ni',
      pack: () => variantPack('aiwg:test-gates/floor-loose-outcome',
        loosenOnly('contrast-ni', { onFail: 'HOLD' as const })),
      fragment: /loosens project floor gate 'contrast-ni'/,
    },
    {
      label: 'bootstrap-bound threshold', gate: 'delta-bootstrap',
      pack: () => variantPack('aiwg:test-gates/floor-loose-bootstrap',
        loosenOnly('delta-bootstrap', { threshold: { op: 'gte', value: 0 } })),
      fragment: /loosens project floor gate 'delta-bootstrap'/,
    },
    {
      label: 'count-max threshold', gate: 'blocking-events',
      pack: () => variantPack('aiwg:test-gates/floor-loose-countmax',
        loosenOnly('blocking-events', { threshold: { op: 'lte', value: 2 } })),
      fragment: /loosens project floor gate 'blocking-events'/,
    },
    {
      label: 'count-max listed scope narrowing', gate: 'blocking-events',
      pack: () => variantPack('aiwg:test-gates/floor-loose-scope',
        loosenOnly('blocking-events', { scope: { mode: 'listed' as const, slices: ['a'] } })),
      fragment: /loosens project floor gate 'blocking-events'/,
    },
    {
      label: 'count-min threshold', gate: 'coverage-events',
      pack: () => variantPack('aiwg:test-gates/floor-loose-countmin',
        loosenOnly('coverage-events', { threshold: { op: 'gte', value: 5 } })),
      fragment: /loosens project floor gate 'coverage-events'/,
    },
    {
      label: 'value-threshold', gate: 'latency-cap',
      pack: () => variantPack('aiwg:test-gates/floor-loose-value',
        loosenOnly('latency-cap', { threshold: { op: 'lte', value: 1000 } })),
      fragment: /loosens project floor gate 'latency-cap'/,
    },
    {
      label: 'minimum-n support', gate: 'support-total',
      pack: () => variantPack('aiwg:test-gates/floor-loose-support',
        loosenOnly('support-total', { minimumN: 10 })),
      fragment: /loosens project floor gate 'support-total'/,
    },
    {
      label: 'evidence required set', gate: 'release-evidence',
      pack: () => variantPack('aiwg:test-gates/floor-loose-evidence',
        loosenOnly('release-evidence', { evidence: { required: ['other-attestation'] } })),
      fragment: /loosens project floor gate 'release-evidence'/,
    },
    {
      label: 'predicate body', gate: 'slices-registered',
      pack: () => variantPack('aiwg:test-gates/floor-loose-predicate',
        loosenOnly('slices-registered', {
          predicate: { op: 'exists' as const, left: { source: 'input' as const, pointer: '/other' } },
        })),
      fragment: /loosens project floor gate 'slices-registered'/,
    },
    {
      label: 'each-scope exception widening', gate: 'false-ready-exact',
      pack: () => variantPack('aiwg:test-gates/floor-loose-except',
        loosenOnly('false-ready-exact', { scope: { mode: 'each' as const, except: ['a'] } })),
      fragment: /loosens project floor gate 'false-ready-exact'/,
    },
  ];

  for (const { label, gate, pack, fragment } of cases) {
    it(`refuses a binding loosening the floor: ${label}`, () => {
      const variant = pack();
      const registry = registryWith(variant);
      const binding = variantBinding(variant);
      // The loosening is real: without floors the same binding resolves.
      expect(() => registry.resolveBinding(binding)).not.toThrow();
      expect(() => registry.resolveBinding(binding, floorsOf())).toThrow(GateRegistryError);
      expect(() => registry.resolveBinding(binding, floorsOf())).toThrow(fragment);
      expect(() => registry.resolveBinding(binding, floorsOf())).toThrow(
        new RegExp(`floor pack '${FLOOR_ID}'.*${gate}|${gate}.*floor pack '${FLOOR_ID}'`),
      );
    });
  }

  it('refuses a binding that omits a floor gate', () => {
    const pack = dropGate('coverage-events');
    const registry = registryWith(pack);
    const binding = variantBinding(pack);
    expect(() => registry.resolveBinding(binding)).not.toThrow();
    expect(() => registry.resolveBinding(binding, floorsOf()))
      .toThrow(/omits project floor gate 'coverage-events'.*floor pack 'project:conformance-floors'/);
  });

  it('refuses a loosened threshold parameter value, and accepts a tightened one', () => {
    const pack = variantPack('aiwg:test-gates/floor-param-case', gate => gate);
    const registry = registryWith(pack);
    const qualify = `${pack.metadata.id}.falseReadyMaxBps`;
    const loose = variantBinding(pack, { parameters: { [qualify]: 200 } });
    expect(() => registry.resolveBinding(loose, floorsOf()))
      .toThrow(/loosens project floor gate 'false-ready-upper'/);
    const tight = variantBinding(pack, { parameters: { [qualify]: 50 } });
    expect(() => registry.resolveBinding(tight, floorsOf())).not.toThrow();
  });

  it('accepts a binding that includes and tightens every floor', () => {
    const pack = variantPack('aiwg:test-gates/floor-tight-case',
      loosenOnly('false-ready-upper', { threshold: { op: 'lte', value: 50 } }));
    const registry = registryWith(pack);
    const binding = variantBinding(pack);
    const resolved = registry.resolveBinding(binding, floorsOf());
    expect(resolved.binding.metadata.id).toBe(BINDING_ID);
    expect(resolved.packs).toHaveLength(1);
  });
});

describe('project floors pack references and ceilings', () => {
  const REF_ID = 'project:conformance-ref-floors';

  const refPack = (): GatePack => {
    const source = floorPack();
    return {
      apiVersion: source.apiVersion,
      kind: 'GatePack',
      metadata: { id: REF_ID, version: '1.0.0', description: 'Referenced conformance floors.' },
      spec: {
        metrics: source.spec.metrics,
        gates: source.spec.gates.filter(gate => gate.id === 'support-total' || gate.id === 'integrity-ceiling'),
      },
    };
  };

  const refFloors = (pack: GatePack): ProjectFloors => resolveProjectFloors({
    floors: [{ packRef: { id: pack.metadata.id, version: pack.metadata.version, digest: artifactDigest(pack) } }],
  });

  it('enforces referenced packs by digest, including the appended default', () => {
    const pack = refPack();
    const { registry } = testRegistry();
    registry.registerPack(pack, { namespace: 'project' });
    const floors = refFloors(pack);
    // The reference plus the appended default both govern integrity-ceiling.
    expect(floors.floors).toHaveLength(2);
    const binding = makeBinding();
    expect(() => registry.resolveBinding(binding, floors)).not.toThrow();
    const loosened = variantPack('aiwg:test-gates/floor-loose-ref',
      loosenOnly('support-total', { minimumN: 10 }));
    registry.registerPack(loosened, { namespace: 'aiwg', bundle: 'test-gates' });
    expect(() => registry.resolveBinding(variantBinding(loosened), floors))
      .toThrow(/loosens project floor gate 'support-total'.*floor pack 'project:conformance-ref-floors'/);
  });

  it('refuses forged pack references and unknown packs', () => {
    const pack = refPack();
    const { registry } = testRegistry();
    registry.registerPack(pack, { namespace: 'project' });
    const forged: ProjectFloors = {
      floors: [{ packRef: { id: pack.metadata.id, version: pack.metadata.version, digest: `sha256:${'0'.repeat(64)}` } }],
      ceilings: {},
    };
    expect(() => registry.resolveBinding(makeBinding(), forged)).toThrow(/pin mismatch/);
    const unknown: ProjectFloors = {
      floors: [{ packRef: { id: 'project:missing-floors', version: '1.0.0', digest: `sha256:${'ab'.repeat(32)}` } }],
      ceilings: {},
    };
    expect(() => registry.resolveBinding(makeBinding(), unknown)).toThrow(/unknown gate pack/);
  });

  it('enforces the composed minima of a referenced extends chain', () => {
    const parent = loadPack();
    const child: GatePack = {
      apiVersion: 'gates.aiwg.io/v1alpha1',
      kind: 'GatePack',
      metadata: { id: 'aiwg:test-gates/floor-child', version: '1.0.0', description: 'Tightening floor child.' },
      spec: {
        extends: { id: parent.metadata.id, version: parent.metadata.version, digest: artifactDigest(parent) },
        metrics: {},
        gates: [
          { ...floorGate('false-ready-upper'), threshold: { op: 'lte' as const, value: 80 } },
          { ...floorGate('integrity-ceiling') },
        ],
      },
    };
    const { registry } = testRegistry();
    registry.registerPack(child, { namespace: 'aiwg', bundle: 'test-gates' });
    const floors = refFloors(child);
    const loosePack = variantPack('aiwg:test-gates/floor-extends-loose',
      loosenOnly('false-ready-upper', { threshold: { op: 'lte', value: 100 } }));
    registry.registerPack(loosePack, { namespace: 'aiwg', bundle: 'test-gates' });
    // 100 tightens the parent default (100) but loosens the composed child floor (80).
    expect(() => registry.resolveBinding(variantBinding(loosePack), floors))
      .toThrow(/loosens project floor gate 'false-ready-upper'.*floor pack 'aiwg:test-gates\/floor-child'/);
    const tightPack = variantPack('aiwg:test-gates/floor-extends-tight',
      loosenOnly('false-ready-upper', { threshold: { op: 'lte', value: 50 } }));
    registry.registerPack(tightPack, { namespace: 'aiwg', bundle: 'test-gates' });
    expect(() => registry.resolveBinding(variantBinding(tightPack), floors)).not.toThrow();
  });

  it('refuses bindings below their per-study ceiling and accepts tighter ones', () => {
    const pack = variantPack('aiwg:test-gates/floor-ceiling-case', gate => gate);
    const registry = registryWith(pack);
    const floors: ProjectFloors = { ...floorsOf(), ceilings: { [BINDING_ID]: 'HOLD' } };
    expect(() => registry.resolveBinding(variantBinding(pack), floors))
      .toThrow(/declares ceiling PROMOTE below the project ceiling HOLD/);
    expect(() => registry.resolveBinding(variantBinding(pack, { ceiling: 'HOLD' }), floors)).not.toThrow();
    expect(() => registry.resolveBinding(variantBinding(pack, { ceiling: 'ROLLBACK' }), floors)).not.toThrow();
    // Studies without a configured ceiling resolve under the same floors.
    const other: ProjectFloors = { ...floorsOf(), ceilings: { 'other-study': 'HOLD' } };
    expect(() => registry.resolveBinding(variantBinding(pack), other)).not.toThrow();
  });

  it('requires defaults for floor threshold parameters', () => {
    const pack = floorPack();
    pack.spec.parameters = {
      ...pack.spec.parameters,
      strictCap: { type: 'bps' as const, direction: 'lower-is-stricter' as const },
    };
    pack.spec.gates = pack.spec.gates.map(gate => gate.id === 'false-ready-upper'
      ? { ...gate, threshold: { op: 'lte' as const, param: 'strictCap' } }
      : gate);
    const { registry } = testRegistry();
    const variant = variantPack('aiwg:test-gates/floor-nodefault-case', gate => gate);
    registry.registerPack(variant, { namespace: 'aiwg', bundle: 'test-gates' });
    expect(() => registry.resolveBinding(variantBinding(variant), resolveProjectFloors({ floors: [{ pack }] })))
      .toThrow(/parameter 'strictCap' requires a default/);
  });
});

describe('project floors default integrity ceiling', () => {
  it('refuses bindings that omit the ceiling, and accepts ones that include it', () => {
    const source = floorPack();
    const standalone: GatePack = {
      ...source,
      metadata: { id: 'aiwg:test-gates/floor-no-ceiling', version: '1.0.0', description: 'No ceiling.' },
      spec: { ...source.spec, gates: source.spec.gates.filter(gate => gate.id !== 'integrity-ceiling') },
    };
    const registry = registryWith(standalone);
    const binding = variantBinding(standalone);
    expect(() => registry.resolveBinding(binding)).not.toThrow();
    expect(() => registry.resolveBinding(binding, resolveProjectFloors(undefined)))
      .toThrow(/omits project floor gate 'integrity-ceiling'.*floor pack 'project:default-floors'/);
    const { registry: fresh } = testRegistry();
    expect(() => fresh.resolveBinding(makeBinding(), resolveProjectFloors(undefined))).not.toThrow();
  });
});

describe('project floors evaluation and legacy behavior', () => {
  it('refuses a loosened binding at evaluation time, before any gate runs', () => {
    const pack = variantPack('aiwg:test-gates/floor-eval-loose',
      loosenOnly('false-ready-upper', { threshold: { op: 'lte', value: 200 } }));
    const registry = registryWith(pack);
    const binding = variantBinding(pack);
    expect(() => evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: makeUpstream('promote'), now: NOW, floors: floorsOf(),
    })).toThrow(/loosens project floor gate 'false-ready-upper'/);
  });

  it('evaluates a tightening binding to PROMOTE with a re-derivable report', () => {
    const pack = variantPack('aiwg:test-gates/floor-eval-tight',
      loosenOnly('false-ready-upper', { threshold: { op: 'lte', value: 50 } }));
    const registry = registryWith(pack);
    const binding = variantBinding(pack);
    const floors = floorsOf();
    const input = {
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: makeUpstream('promote'), now: NOW, floors,
    };
    const report = evaluateGates(input);
    expect(report.decision).toBe('PROMOTE');
    expect(report.gateEvidence.find(entry => entry.gateId === 'false-ready-upper'))
      .toMatchObject({ status: 'pass', outcome: 'PROMOTE' });
    expect(validateGateReport(report, input)).toEqual({ valid: true, reasons: [] });
  });

  it('leaves floors-unaware resolution and evaluation byte-identical', () => {
    const pack = variantPack('aiwg:test-gates/floor-legacy-case',
      loosenOnly('false-ready-upper', { threshold: { op: 'lte', value: 200 } }));
    const registry = registryWith(pack);
    const binding = variantBinding(pack);
    // The floor-violating binding keeps its legacy behavior when floors are
    // not passed: resolution succeeds and evaluation promotes on clean metrics.
    const resolved = registry.resolveBinding(binding);
    expect(resolved.binding.metadata.id).toBe(BINDING_ID);
    const report = evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: makeUpstream('promote'), now: NOW,
    });
    expect(report.decision).toBe('PROMOTE');
    // Passing `floors: undefined` explicitly is the same as omitting it.
    expect(registry.resolveBinding(binding, undefined)).toEqual(resolved);
  });
});

describe('project floors aiwg.config parsing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `aiwg-gates-floors-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeRawConfig = (gates: unknown): void => {
    const dir = join(tmpDir, '.aiwg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['claude'], installed: {}, scripts: {}, gates,
    }));
  };

  it('fails closed when the gates section does not parse', async () => {
    writeRawConfig({ floors: 'nope' });
    await expect(readAiwgConfig(tmpDir)).rejects.toThrow('gates.floors: must be an array');
    writeRawConfig({ floors: [{ pack: { ...floorPack(), kind: 'GateBinding' } }] });
    await expect(readAiwgConfig(tmpDir)).rejects.toThrow(/^Invalid \.aiwg\/aiwg\.config:\ngates\.floors\[0\]\.pack: /);
  });

  it('round-trips a valid gates section and resolves its floors', async () => {
    const cfg = emptyConfig();
    cfg.gates = resolveProjectFloors({
      floors: [{ pack: floorPack() }],
      ceilings: { [BINDING_ID]: 'HOLD' },
    });
    await writeAiwgConfig(tmpDir, cfg);
    const read = await readAiwgConfig(tmpDir);
    expect(read?.gates?.ceilings).toEqual({ [BINDING_ID]: 'HOLD' });
    expect(validateGatesConfig(read?.gates)).toEqual([]);
    const floors = resolveProjectFloors(read?.gates);
    expect(floors.floors).toHaveLength(1);
    const { registry } = testRegistry();
    const pack = variantPack('aiwg:test-gates/floor-config-case', gate => gate);
    registry.registerPack(pack, { namespace: 'aiwg', bundle: 'test-gates' });
    expect(() => registry.resolveBinding(variantBinding(pack), floors)).toThrow(/below the project ceiling/);
  });

  it('refuses to write a config with an invalid gates section', async () => {
    const cfg = emptyConfig();
    cfg.gates = { floors: 'nope' } as never;
    await expect(writeAiwgConfig(tmpDir, cfg)).rejects.toThrow('gates.floors: must be an array');
  });
});
