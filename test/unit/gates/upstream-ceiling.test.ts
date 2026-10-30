// Strict pack verdicts and evidence seal controls for the shared upstream-ceiling evaluator.
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { evaluateUpstreamCeiling } from '../../../src/gates/upstream-ceiling.js';
import { sealUpstream, evaluateGates } from '../../../src/gates/evaluate.js';
import { resolveProjectFloors } from '../../../src/gates/floors.js';
import { loadGatePackFile } from '../../../src/gates/discovery.js';
import { integrityOutcomes, integrityVariants, syntheticIntegrity } from '../decision/integrity-ceiling-fixtures.js';
import { makeBindingForPack, passingMetrics, testHoldout, testRegistry, trustedDigest, NOW } from '../../conformance/gates-v1/helper.js';

const pack = loadGatePackFile(resolve('agentic/code/addons/decision-engine/gate-packs/integrity-ceiling.gatepack.yaml'));
const binding = makeBindingForPack(pack, { spec: { references: [] } });
const input = { binding, registry: testRegistry().registry, trustedBindingDigest: trustedDigest(binding),
  holdout: testHoldout(binding), metrics: passingMetrics(), now: NOW, floors: resolveProjectFloors({}) };

it.each(integrityOutcomes)('strict integrity-ceiling pack preserves verdicts for %s', upstream => {
  for (const variant of integrityVariants) {
    const metadata = syntheticIntegrity({ ...variant.patch, release_gate: { decision: upstream, reasons: [] } });
    const compromised = metadata.integrity_state === 'compromised' || metadata.compromise_labels.length > 0;
    const strictHold = !['verified', 'optional fresh workspace', 'insufficient pairs'].includes(variant.name);
    const expected = upstream === 'ROLLBACK' || compromised ? 'ROLLBACK' : upstream === 'HOLD' || strictHold ? 'HOLD' : 'PROMOTE';
    const result = evaluateGates({ ...input, upstream: sealUpstream(metadata) });
    expect(result.decision, variant.name).toBe(expected);
    expect(result.ceilings.upstreamCeiling, variant.name).toBe(expected);
    expect(result.gateEvidence).toHaveLength(1);
    expect(result.gateEvidence[0]!.outcome, variant.name).toBe(expected);
    expect(evaluateUpstreamCeiling(metadata).ceiling, variant.name).toBe(expected);
  }
});

it('rejects changed upstream metadata and requires a sealed record', () => {
  const upstream = sealUpstream(syntheticIntegrity({ release_gate: { decision: 'ROLLBACK', reasons: ['fixture'] } }));
  const forged = { ...upstream, metadata: { ...upstream.metadata, release_gate: { decision: 'PROMOTE' as const, reasons: [] } } };
  expect(() => evaluateGates({ ...input, upstream: forged })).toThrow('upstream integrity digest');
  expect(() => evaluateGates({ ...input, upstream: null })).toThrow('sealed upstream record');
  expect(evaluateUpstreamCeiling(null)).toEqual({ ceiling: 'HOLD', problems: ['upstream-ceiling-missing'], compromised: false });
});

it('fails closed on malformed strict metadata while retaining the upstream verdict', () => {
  for (const upstream of integrityOutcomes) {
    const metadata = syntheticIntegrity({ sample_n: NaN, release_gate: { decision: upstream, reasons: [] } });
    expect(evaluateUpstreamCeiling(metadata)).toMatchObject({
      ceiling: upstream === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD', problems: ['integrity-invalid'],
    });
  }
});
