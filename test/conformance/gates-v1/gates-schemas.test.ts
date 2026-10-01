import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GateRegistryError } from '../../../src/gates/registry.js';
import { GateSchemaError, validateGateDocument } from '../../../src/gates/schema.js';
import type { GateBinding, GatePack, GateReport } from '../../../src/gates/types.js';
import { evaluateFixture, testRegistry } from './helper.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, 'fixtures', name), 'utf8')) as unknown;

describe('gates schemas', () => {
  it('accepts the valid pack and binding fixtures', () => {
    const pack = validateGateDocument<GatePack>(fixture('valid-pack.json'));
    expect(pack.spec.gates.map(gate => gate.kind).sort()).toEqual([
      'bootstrap-bound', 'count-max', 'count-min', 'evidence', 'interval-bound',
      'interval-bound', 'interval-bound', 'minimum-n', 'paired-difference',
      'predicate', 'upstream-ceiling', 'value-threshold',
    ]);
    const binding = validateGateDocument<GateBinding>(fixture('valid-binding.json'));
    expect(binding.spec.packs).toHaveLength(1);
    expect(binding.spec.packs[0]).toMatchObject({ id: 'aiwg:test-gates/conformance-v1', version: '1.0.0' });
    expect(binding.spec.packs[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(binding.spec.packs[0]!.resolvedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(binding.spec.metricProviders).toHaveLength(4);
  });

  it('rejects unknown kinds, closed-schema violations and empty thresholds', () => {
    for (const name of ['invalid-pack-kind.json', 'invalid-pack-extra-prop.json', 'invalid-pack-threshold.json']) {
      expect(() => validateGateDocument(fixture(name)), name).toThrow(GateSchemaError);
    }
    const pack = fixture('valid-pack.json') as GatePack;
    expect(() => validateGateDocument({ ...pack, apiVersion: 'gates.aiwg.io/v9' })).toThrow(GateSchemaError);
    expect(() => validateGateDocument({ ...pack, kind: 'GateBinding' })).toThrow(GateSchemaError);
    const upstream = pack.spec.gates.find(gate => gate.kind === 'upstream-ceiling');
    expect(() => validateGateDocument({
      ...pack,
      spec: { ...pack.spec, gates: [{ ...upstream, metric: { provider: 'test.proportion/v1', name: 'false-ready' } }] },
    })).toThrow(GateSchemaError);
    const predicate = pack.spec.gates.find(gate => gate.kind === 'predicate');
    expect(() => validateGateDocument({
      ...pack, spec: { ...pack.spec, gates: [{ ...predicate, predicate: undefined }] },
    })).toThrow(GateSchemaError);
  });

  it('emits reports that validate against the GateReport schema', () => {
    const report = evaluateFixture();
    const parsed = validateGateDocument<GateReport>(JSON.parse(JSON.stringify(report)));
    expect(parsed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.gateEvidence.length).toBeGreaterThan(10);
    expect(parsed.gateEvidence.every(entry => entry.reasons.length > 0)).toBe(true);
    expect(() => validateGateDocument({ ...parsed, decision: 'MAYBE' })).toThrow(GateSchemaError);
    expect(() => validateGateDocument({ ...parsed, digest: `sha256:${'0'.repeat(64)}`, extra: true } as unknown))
      .toThrow(GateSchemaError);
  });

  it('rejects invalid bindings at resolution while their schemas stay valid', () => {
    // Both bindings are schema-valid but must fail registry resolution: the
    // first leaves gate providers unpinned, the second uses an unqualified
    // parameter name instead of the namespaced pack parameter.
    for (const name of ['invalid-binding-unpinned-provider.json', 'invalid-binding-param.json']) {
      const binding = validateGateDocument<GateBinding>(fixture(name));
      expect(binding.kind).toBe('GateBinding');
      expect(() => testRegistry().registry.resolveBinding(binding), name).toThrow(GateRegistryError);
    }
    // The upgraded report is schema-valid (self-consistent digest) but promotes
    // past a ROLLBACK component, so report validation must refuse it.
    const upgraded = validateGateDocument<GateReport>(fixture('invalid-report-upgraded.json'));
    expect(upgraded.decision).toBe('PROMOTE');
    expect(upgraded.ceilings.packOutcome).toBe('ROLLBACK');
  });

  it('rejects pinned-baseline references without a baseline pin', () => {
    const binding = fixture('valid-binding.json') as GateBinding;
    expect(() => validateGateDocument({
      ...binding,
      spec: { ...binding.spec, references: [{ name: 'v3', kind: 'pinned-baseline' }] },
    })).toThrow(GateSchemaError);
  });
});
