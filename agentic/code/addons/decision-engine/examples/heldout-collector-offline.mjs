/** Tiny synthetic interface example, not a D17 or D29 holdout or a live approval. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { heldoutDigest } from '../../../../../src/decision/heldout/contract.ts';
import { generateHeldoutRow, heldoutGeneratorDigest } from '../../../../../src/decision/heldout/generators.ts';

export async function prepare(seed) {
  const moduleDigest = `sha256:${createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')}`;
  const gold = { example_0: 'yes', example_1: 'no' };
  const definition = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition',
    metadata: { id: 'heldout-example', version: '1.0.0', description: 'Fictional lamp state' },
    spec: { purpose: 'Offline collector interface demonstration.', inputSchema: { type: 'object', properties: { payload: { type: 'string' } },
      required: ['payload'], additionalProperties: false }, question: 'Is the fictional lamp on?', answer: { kind: 'choice',
      options: [{ id: 'yes', description: 'On' }, { id: 'no', description: 'Off' }] }, requiredCapabilities: ['choice'] } };
  const corpus = { schemaVersion: 'decision-heldout-corpus/v1', study: 'D17', syntheticOnly: true,
    provenance: { kind: 'authored-synthetic', generatorDigest: heldoutGeneratorDigest('heldout-lamp/v1'), seed, goldDigest: heldoutDigest(gold) }, definitions: [definition],
    rows: [0, 1].map(i => generateHeldoutRow('heldout-lamp/v1', `${seed}:${i}:example`)) };
  return { corpus, gold, preregistration: { schemaVersion: 'decision-heldout-preregistration/v1', study: 'D17',
    frozenAt: '2026-09-30T00:00:00Z', corpusDigest: heldoutDigest(corpus), studyAnalysisDigest: heldoutDigest({ exampleOnly: true }),
    scorerDigest: moduleDigest, calibration: { scope: 'uncalibrated-diagnostic', allowedModes: ['uncalibrated-diagnostic'] },
    providerFailurePolicy: { maxRetries: 1, maximumSliceFailureBps: 500, retryOnlyTerminal: true },
    perRequestTokenBound: 4000, providerOverheadTokens: 512, outputAndHiddenTokenAllowance: 256, requestTimeoutMs: 1000, minDispatchIntervalMs: 1000, sessionLimitMs: 1800000 } };
}
export async function prepareStaged(seed) {
  const prepared = await prepare(seed);
  prepared.corpus.rows = ['tuning', 'calibration', 'test'].map((split, i) =>
    generateHeldoutRow('heldout-lamp-splits/v1', `${seed}:${i}:single:${split}`));
  prepared.gold = { row_0: 'yes', row_1: 'no', row_2: 'yes' };
  prepared.corpus.provenance.goldDigest = heldoutDigest(prepared.gold);
  prepared.preregistration.corpusDigest = heldoutDigest(prepared.corpus);
  prepared.preregistration.calibration = { scope: 'calibrated', allowedModes: ['staged'], calibrationPhaseSplits: ['tuning', 'calibration'] };
  return prepared;
}
export async function score({ attempts, approvedCalibration, calibrated }) {
  if (approvedCalibration.mode !== 'uncalibrated-diagnostic' && approvedCalibration.mode !== 'staged'
    || approvedCalibration.mode === 'uncalibrated-diagnostic' && calibrated !== false) throw new Error('example-calibration-scope');
  return { exampleOnly: true, calibrated: false, d09Qualified: false, calibratedGate: false, successfulRequests: attempts.filter(a => a.result?.disposition === 'success').length,
    missingInputs: ['full study corpus', 'calibration', 'blind human audit', 'native statistical report'], decision: 'HOLD' };
}
