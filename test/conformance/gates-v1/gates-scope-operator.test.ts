import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import {
  GateRegistry, GateRegistryError, applyGateExtends, validateResolvedPack,
} from '../../../src/gates/registry.js';
import { gateStatusOutcome } from '../../../src/gates/evaluate.js';
import { validateGateDocument } from '../../../src/gates/schema.js';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import type { GateDefinition, GatePack, GateScope } from '../../../src/gates/types.js';
import { loadPack } from './helper.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const PARENT_ID = 'aiwg:test-gates/scope-parent';
const CHILD_ID = 'project:scope-child';

const PACK_METRICS: GatePack['spec']['metrics'] = {
  'false-ready': { provider: 'test.proportion/v1', kind: 'proportion' },
  contrast: { provider: 'test.paired/v1', kind: 'paired' },
  measurement: { provider: 'test.scalar/v1', kind: 'scalar' },
  delta: { provider: 'test.scalar/v1', kind: 'differences' },
  attestations: { provider: 'test.evidence/v1', kind: 'evidence' },
};

/** One valid gate per kind; only `scope` varies across the matrix. */
function gateFor(kind: GateDefinition['kind'], scope: GateScope): GateDefinition {
  const base = { id: 'g', onFail: 'HOLD' as const, scope };
  switch (kind) {
    case 'interval-bound':
      return { ...base, kind, direction: 'lower-is-stricter',
        metric: { provider: 'test.proportion/v1', name: 'false-ready' },
        statistic: { kind, method: 'wilson', bound: 'upper', levelBps: 9500 },
        threshold: { op: 'lte', value: 200 } };
    case 'paired-difference':
      return { ...base, kind, direction: 'higher-is-stricter',
        metric: { provider: 'test.paired/v1', name: 'contrast' },
        statistic: { kind, method: 'newcombe', levelBps: 9500, mode: 'non-inferiority', marginBps: -250 } };
    case 'bootstrap-bound':
      return { ...base, kind, direction: 'higher-is-stricter',
        metric: { provider: 'test.scalar/v1', name: 'delta' },
        statistic: { kind, method: 'bootstrap', bound: 'lower', levelBps: 9500, seed: 7, resamples: 2000, bounds: [-1, 1] } as GateDefinition['statistic'],
        threshold: { op: 'gte', value: 50 } };
    case 'count-max':
      return { ...base, kind, direction: 'lower-is-stricter',
        metric: { provider: 'test.proportion/v1', name: 'false-ready' },
        threshold: { op: 'lte', value: 2 } };
    case 'count-min':
      return { ...base, kind, direction: 'higher-is-stricter',
        metric: { provider: 'test.proportion/v1', name: 'false-ready' },
        threshold: { op: 'gte', value: 10 } };
    case 'value-threshold':
      return { ...base, kind, direction: 'lower-is-stricter',
        metric: { provider: 'test.scalar/v1', name: 'measurement' },
        threshold: { op: 'lte', value: 500 } };
    case 'minimum-n':
      return { ...base, kind, direction: 'higher-is-stricter',
        metric: { provider: 'test.proportion/v1', name: 'false-ready' }, minimumN: 50 };
    case 'evidence':
      return { ...base, kind, direction: 'higher-is-stricter',
        metric: { provider: 'test.evidence/v1', name: 'attestations' },
        evidence: { required: ['review-passed'] } };
    case 'predicate':
      return { ...base, kind, direction: 'higher-is-stricter',
        predicate: { op: 'exists', left: { source: 'input', pointer: '/parameters' } } };
    case 'upstream-ceiling':
      return { ...base, kind, direction: 'higher-is-stricter' };
  }
}

const KINDS = ['interval-bound', 'paired-difference', 'bootstrap-bound', 'count-max', 'count-min',
  'value-threshold', 'minimum-n', 'evidence', 'predicate', 'upstream-ceiling'] as const;

/** Kinds whose per-slice floors imply the pooled floor, so all -> each tightens. */
const PER_SLICE_IMPLIES_POOLED = new Set(['count-min', 'minimum-n']);

const scopeLabel = (scope: GateScope): string =>
  scope.mode + (scope.slices === undefined ? '' : `[${scope.slices.join(',')}]`)
  + (scope.except === undefined ? '' : `~[${scope.except.join(',')}]`);

const attemptTransition = (kind: GateDefinition['kind'], from: GateScope, to: GateScope): void => {
  const registry = new GateRegistry(createCoreProviderRegistry());
  const parent: GatePack = {
    apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
    metadata: { id: PARENT_ID, version: '1.0.0', description: 'Scope matrix parent.' },
    spec: { metrics: PACK_METRICS, gates: [gateFor(kind, clone(from))] },
  };
  registry.registerPack(parent, { namespace: 'aiwg', bundle: 'test-gates' });
  const child: GatePack = {
    apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
    metadata: { id: CHILD_ID, version: '1.0.0', description: 'Scope matrix child.' },
    spec: {
      extends: { id: parent.metadata.id, version: parent.metadata.version, digest: artifactDigest(parent) },
      metrics: {}, gates: [gateFor(kind, clone(to))],
    },
  };
  registry.registerPack(child, { namespace: 'project' });
};

describe('gates scope tightening covers a superset under every slice universe', () => {
  // Hand-derived verdicts: the child must observe every slice the parent
  // observes, no matter how large the binding inventory is. Cross-aggregation
  // (per-slice each/listed vs pooled all/pooled) transitions stay rejected
  // except the two historically allowed narrowings below.
  const cases: Array<{ from: GateScope; to: GateScope; accept: boolean | 'per-slice-floor' }> = [
    { from: { mode: 'all' }, to: { mode: 'all' }, accept: true },
    { from: { mode: 'all' }, to: { mode: 'each' }, accept: 'per-slice-floor' },
    // all covers the whole inventory: any exception drops a slice the parent sees.
    { from: { mode: 'all' }, to: { mode: 'each', except: ['a'] }, accept: false },
    { from: { mode: 'all' }, to: { mode: 'listed', slices: ['a'] }, accept: false },
    { from: { mode: 'all' }, to: { mode: 'pooled', slices: ['b'] }, accept: false },
    { from: { mode: 'each' }, to: { mode: 'all' }, accept: false },
    { from: { mode: 'each' }, to: { mode: 'each' }, accept: true },
    { from: { mode: 'each' }, to: { mode: 'each', except: ['a'] }, accept: false },
    { from: { mode: 'each' }, to: { mode: 'listed', slices: ['b'] }, accept: false },
    { from: { mode: 'each' }, to: { mode: 'pooled', slices: ['b'] }, accept: false },
    { from: { mode: 'each', except: ['a'] }, to: { mode: 'all' }, accept: false },
    { from: { mode: 'each', except: ['a'] }, to: { mode: 'each' }, accept: true },
    { from: { mode: 'each', except: ['a'] }, to: { mode: 'each', except: ['a'] }, accept: true },
    { from: { mode: 'each', except: ['a'] }, to: { mode: 'each', except: ['a', 'b'] }, accept: false },
    { from: { mode: 'each', except: ['a'] }, to: { mode: 'listed', slices: ['b'] }, accept: false },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'listed', slices: ['a'] }, accept: false },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'listed', slices: ['b'] }, accept: true },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'listed', slices: ['a', 'b'] }, accept: true },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'each' }, accept: true },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'each', except: ['a'] }, accept: true },
    // A breach in b goes unobserved when the child stops watching b.
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'each', except: ['b'] }, accept: false },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'each', except: ['a', 'b'] }, accept: false },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'all' }, accept: false },
    { from: { mode: 'listed', slices: ['b'] }, to: { mode: 'pooled', slices: ['b'] }, accept: false },
    { from: { mode: 'pooled', slices: ['b'] }, to: { mode: 'pooled', slices: ['b'] }, accept: true },
    { from: { mode: 'pooled', slices: ['b'] }, to: { mode: 'pooled', slices: ['a'] }, accept: false },
    { from: { mode: 'pooled', slices: ['b'] }, to: { mode: 'all' }, accept: false },
    { from: { mode: 'pooled', slices: ['b'] }, to: { mode: 'each' }, accept: false },
    { from: { mode: 'pooled', slices: ['b'] }, to: { mode: 'listed', slices: ['b'] }, accept: false },
  ];

  for (const kind of KINDS) {
    for (const { from, to, accept } of cases) {
      const expected = accept === 'per-slice-floor' ? PER_SLICE_IMPLIES_POOLED.has(kind) : accept;
      const label = `${kind} ${scopeLabel(from)} -> ${scopeLabel(to)} ${expected ? 'tightens' : 'fails load'}`;
      it(label, () => {
        if (expected) {
          expect(() => attemptTransition(kind, from, to), label).not.toThrow();
        } else {
          expect(() => attemptTransition(kind, from, to), label).toThrow(GateRegistryError);
        }
      });
    }
  }
});

describe('gates operator semantics: insufficient evidence holds, never rolls back', () => {
  it('schema rejects onInsufficient ROLLBACK at load', () => {
    const pack = clone(loadPack()) as unknown as Record<string, unknown>;
    const spec = pack.spec as { gates: Array<Record<string, unknown>> };
    spec.gates = [{ ...spec.gates[0], onInsufficient: 'ROLLBACK' }];
    expect(() => validateGateDocument(pack)).toThrow();
    spec.gates = [{ ...spec.gates[0], onInsufficient: 'HOLD' }];
    expect(() => validateGateDocument(pack)).not.toThrow();
  });

  it('runtime rejects onInsufficient ROLLBACK on a resolved pack', () => {
    const resolved = clone(loadPack());
    (resolved.spec.gates[0] as unknown as Record<string, unknown>).onInsufficient = 'ROLLBACK';
    expect(() => validateResolvedPack(resolved, createCoreProviderRegistry())).toThrow(/onInsufficient must be HOLD/);
    delete (resolved.spec.gates[0] as unknown as Record<string, unknown>).onInsufficient;
    expect(() => validateResolvedPack(resolved, createCoreProviderRegistry())).not.toThrow();
  });

  it('pure extends composition rejects an onInsufficient escalation to ROLLBACK', () => {
    const parent = clone(loadPack());
    const child = clone(loadPack());
    child.metadata = { ...child.metadata, id: 'project:rollback-child' };
    child.spec.gates = parent.spec.gates.map(gate => {
      if (gate.id !== 'false-ready-upper') return clone(gate);
      const escalated = clone(gate);
      (escalated as unknown as Record<string, unknown>).onInsufficient = 'ROLLBACK';
      return escalated;
    });
    expect(() => applyGateExtends(parent, child)).toThrow(/onInsufficient must be HOLD/);
  });

  it('registering a child that escalates onInsufficient to ROLLBACK fails load', () => {
    const registry = new GateRegistry(createCoreProviderRegistry());
    const parent = clone(loadPack());
    registry.registerPack(parent, { namespace: 'aiwg', bundle: 'test-gates' });
    const gate = clone(parent.spec.gates.find(candidate => candidate.id === 'false-ready-upper')!);
    (gate as unknown as Record<string, unknown>).onInsufficient = 'ROLLBACK';
    const child: GatePack = {
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: 'project:rollback-child', version: '1.0.0', description: 'c' },
      spec: {
        extends: { id: parent.metadata.id, version: parent.metadata.version, digest: artifactDigest(parent) },
        metrics: {}, gates: [gate],
      },
    };
    expect(() => registry.registerPack(child, { namespace: 'project' })).toThrow();
  });

  it('the conformance fixture never rolls back on insufficient evidence', () => {
    for (const gate of loadPack().spec.gates) {
      expect(gate.onInsufficient ?? 'HOLD', gate.id).toBe('HOLD');
    }
  });

  it('insufficient status maps to HOLD even beside a ROLLBACK onFail', () => {
    expect(gateStatusOutcome('insufficient', { onFail: 'ROLLBACK', onInsufficient: 'HOLD' })).toBe('HOLD');
    expect(gateStatusOutcome('insufficient', { onFail: 'ROLLBACK' })).toBe('HOLD');
    expect(gateStatusOutcome('fail', { onFail: 'ROLLBACK' })).toBe('ROLLBACK');
  });
});
