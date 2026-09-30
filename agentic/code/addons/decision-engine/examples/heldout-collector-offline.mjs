/** Tiny synthetic interface example, not a D17 or D29 holdout or a live approval. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { heldoutDigest } from '../../../../../src/decision/heldout/contract.ts';

export async function prepare(seed) {
  const moduleDigest = `sha256:${createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')}`;
  const gold = { example_0: 'yes', example_1: 'no' };
  const definition = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition',
    metadata: { id: 'heldout-example', version: '1.0.0', description: 'Fictional lamp state' },
    spec: { purpose: 'Offline collector interface demonstration.', inputSchema: { type: 'object', properties: { payload: { type: 'string' } },
      required: ['payload'], additionalProperties: false }, question: 'Is the fictional lamp on?', answer: { kind: 'choice',
      options: [{ id: 'yes', description: 'On' }, { id: 'no', description: 'Off' }] }, requiredCapabilities: ['choice'] } };
  const corpus = { schemaVersion: 'decision-heldout-corpus/v1', study: 'D17', syntheticOnly: true,
    provenance: { kind: 'authored-synthetic', generatorDigest: moduleDigest, seed, goldDigest: heldoutDigest(gold) }, definitions: [definition],
    rows: [true, false].map((on, i) => ({ id: `example_${i}`, familyId: `family_${i}`, split: 'test', slice: 'direct',
      input: { payload: `In fictional world ${seed}, lamp ${i} is ${on ? 'on' : 'off'}.` },
      requests: [{ id: 'champion', arm: 'baseline', definitionId: definition.metadata.id },
        ...[1, 2, 3].map(n => ({ id: `member_${n}`, arm: 'candidate', definitionId: definition.metadata.id }))], localOutcome: null })) };
  return { corpus, gold, preregistration: { schemaVersion: 'decision-heldout-preregistration/v1', study: 'D17',
    frozenAt: '2026-09-30T00:00:00Z', corpusDigest: heldoutDigest(corpus), studyAnalysisDigest: heldoutDigest({ exampleOnly: true }),
    scorerDigest: moduleDigest, providerFailurePolicy: { maxRetries: 1, maximumSliceFailureBps: 500, retryOnlyTerminal: true },
    perRequestTokenBound: 4000, outputAndHiddenTokenAllowance: 256, requestTimeoutMs: 1000, minDispatchIntervalMs: 1000, sessionLimitMs: 1800000 } };
}
export async function score({ attempts }) {
  return { exampleOnly: true, successfulRequests: attempts.filter(a => a.result?.disposition === 'success').length,
    missingInputs: ['full study corpus', 'calibration', 'blind human audit', 'native statistical report'], decision: 'HOLD' };
}
