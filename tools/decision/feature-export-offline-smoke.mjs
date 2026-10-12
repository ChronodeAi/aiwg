#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  artifactPin,
  buildDecisionFeatureEvalIntegrity,
  createDecisionFeatureObservation,
  decisionFeatureTrainServeContract,
  deterministicFeatureSplit,
  generateDecisionFeatureSet,
  loadDecisionFeatureCsv,
  semanticFeatureContentDigest,
  serializeDecisionFeatureCsv,
  serializeDecisionFeatureJsonl,
  validateDecisionFeatureTrainServe,
} from '../../dist/src/decision/index.js';

const apiVersion = 'decision.aiwg.io/v1alpha2';
const answer = { kind: 'truth-probability', trueDescription: 'approve', falseDescription: 'review' };
const definition = {
  apiVersion,
  kind: 'DecisionDefinition',
  metadata: { id: 'offline-risk', version: '1.0.0', description: 'Offline risk fixture' },
  spec: { purpose: 'offline-smoke', inputSchema: { type: 'object' }, question: 'risk?', answer, requiredCapabilities: [] },
};
const ruleset = {
  apiVersion,
  kind: 'DecisionRuleset',
  metadata: { id: 'offline-ruleset', version: '1.0.0', description: 'Offline smoke ruleset' },
  spec: {
    purpose: 'offline-smoke',
    inputSchema: { type: 'object' },
    evaluations: [{ alias: 'risk', decision: artifactPin(definition), inputPointer: '' }],
    rules: [{
      id: 'manual-review',
      priority: 1,
      when: { op: 'eq', left: { source: 'input', pointer: '/never' }, right: true },
      outcome: { route: 'review' },
    }],
    composition: 'collect',
    conflict: 'review',
    defaultOutcome: { route: 'review' },
    failureOutcome: { route: 'review' },
    outputSchema: { type: 'object' },
  },
};
const binding = {
  apiVersion,
  kind: 'DecisionBinding',
  metadata: { id: 'offline-binding', version: '1.0.0', description: 'Offline smoke binding' },
  spec: {
    ruleset: artifactPin(ruleset),
    totalTimeoutMs: 1000,
    maxAttempts: 1,
    concurrency: 1,
    evaluations: {
      risk: { targets: [{
        adapter: 'jev',
        adapterVersion: 'offline',
        model: 'offline-model',
        credentialRef: 'typesafe-api',
        requiredCapabilities: [],
        acceptance: { mode: 'typed-value' },
        timeoutMs: 1000,
        retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
      }], fallbackOn: [] },
    },
  },
};
const authorization = {
  tenantId: 'tenant',
  projectId: 'project',
  actorId: 'offline-smoke',
  recipient: 'local-fixture',
  purpose: 'offline-interchange-smoke',
  datasetPolicyId: 'offline-dataset-policy',
  accessScope: 'feature-exporter',
  operations: ['create', 'list', 'read', 'export', 'delete', 'share'],
  allowExternalDelivery: true,
  allowRawState: false,
  allowOutcomeLabels: false,
};
const featureSet = generateDecisionFeatureSet({
  id: 'offline-feature-set',
  version: '1.0.0',
  description: 'Offline deterministic feature export smoke',
  ruleset,
  binding,
  definitions: { risk: definition },
  compatibleServedModels: { risk: ['offline-model-v1'] },
  calibration: { risk: { calibrationRef: 'calibration:offline@sha256:abcd', maxAgeMs: 86_400_000, recordedAtEpochMs: 1_000 } },
  privacy: {
    classification: 'restricted',
    retentionMs: 86_400_000,
    accessScope: 'feature-exporter',
    exportPolicyId: 'offline-dataset-policy',
    deletion: 'tombstone',
    lifecycleSurface: 'export',
  },
});

const probabilities = [0.12, 0.18, 0.31, 0.44, 0.57, 0.66, 0.73, 0.81, 0.89, 0.94];
const frozenLabels = Object.fromEntries(probabilities.map((value, index) => [`subject-${index + 1}`, value >= 0.57 ? 1 : 0]));
const rows = probabilities.map((value, index) => createDecisionFeatureObservation({
  featureSet,
  result: decisionResult(value, index),
  definitions: { risk: definition },
  subjectId: `subject-${index + 1}`,
  eventTime: `2026-09-24T00:00:${String(index).padStart(2, '0')}.000Z`,
  exportTime: '2026-09-24T00:00:30.000Z',
  authorization,
}));
const contract = decisionFeatureTrainServeContract(featureSet);
for (const row of rows) validateDecisionFeatureTrainServe(featureSet, contract, row, 2_000);
const split = deterministicFeatureSplit(rows, 20260924);
const evalIntegrity = buildDecisionFeatureEvalIntegrity({
  qualificationRelease: qualificationRelease({
    sample_n: rows.length,
    uncertainty: { split: split.algorithm, seed: split.seed },
    paired_baseline: null,
    integrity_mode: 'offline-deterministic-feature-export-smoke',
    fresh_workspace_required: true,
    fresh_workspace_verified: false,
    integrity_state: 'fixture-synthetic-hold',
    trusted_score_source: 'frozen-synthetic-heldout-labels-not-production',
    compromise_labels: [],
    weak_signal_reason: 'offline smoke is deterministic package evidence, not production model-quality evidence',
    release_gate: { decision: 'HOLD', reasons: ['offline smoke evidence only'] },
  }),
  reportRef: 'offline-feature-export-smoke',
});
const jsonl = serializeDecisionFeatureJsonl(featureSet, rows, authorization, { generatedAt: '2026-09-24T00:00:31.000Z', evalIntegrity });
const csv = serializeDecisionFeatureCsv(featureSet, rows, authorization, { generatedAt: '2026-09-24T00:00:31.000Z', evalIntegrity });
const loaded = loadDecisionFeatureCsv(featureSet, csv.payload);
if (semanticFeatureContentDigest(loaded) !== jsonl.manifest.semanticContentDigest) {
  throw new Error('CSV and JSONL semantic digests differ');
}
if (/"label"|frozenLabels|groundTruth/.test(jsonl.payload) || /"label"|frozenLabels|groundTruth/.test(csv.payload)) {
  throw new Error('Frozen labels leaked into exported feature payloads');
}

const loadedById = new Map(loaded.map(row => [row.observationId, row]));
const model = trainLogistic(split.train.map(id => mustRow(loadedById, id)), frozenLabels);
const heldout = evaluate(split.test.map(id => mustRow(loadedById, id)), frozenLabels, model);
if (heldout.n === 0 || heldout.accuracy < 0.5 || heldout.brier >= 0.25) throw new Error('Heldout deterministic model metrics failed');

console.log(JSON.stringify({
  status: 'pass',
  rowCount: rows.length,
  featureSetDigest: featureSet.metadata.digest,
  semanticContentDigest: jsonl.manifest.semanticContentDigest,
  evalIntegrity: jsonl.manifest.evalIntegrity,
  split,
  model: { kind: 'logistic-regression-1d', weight: round(model.weight), bias: round(model.bias), trainedRows: split.train.length },
  heldout,
  labelEvidence: { digest: digestObject(frozenLabels), retainedSeparately: true },
}, null, 2));


function qualificationRelease(integrity) {
  const fields = {
    schemaVersion: 'decision-qualification-release/v1',
    runId: 'offline-feature-export-smoke',
    sourceCommit: 'offline-fixture-synthetic-source',
    dirty: false,
    environment: 'offline-smoke',
    commands: ['node tools/decision/feature-export-offline-smoke.mjs'],
    pins: { featureSet: featureSet.metadata.digest },
    budgets: {},
    actuals: {},
    reviewer: null,
    suites: [],
    gates: [],
    integrity,
    benchmark: null,
    metrics: null,
    integritySnapshot: null,
    cacheLayers: null,
    decision: integrity.release_gate.decision,
  };
  return { ...fields, digest: `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}` };
}

function decisionResult(value, index) {
  return {
    apiVersion,
    kind: 'DecisionResult',
    metadata: { id: `offline-result-${index}`, version: '1.0.0', description: 'Offline smoke result' },
    spec: {
      decision: artifactPin(definition),
      ruleset: artifactPin(ruleset),
      binding: artifactPin(binding),
      alias: 'risk',
      runId: 'offline-run',
      invocationId: `offline-invocation-${index}`,
      status: 'success',
      value,
      reason: 'none',
      uncertainty: {
        source: 'provider',
        profile: 'typesafe-truth-v1',
        calibration: 'measured',
        confidence: null,
        distribution: null,
        calibrationRef: 'calibration:offline@sha256:abcd',
        calibratedRisk: { value: 1 - value, calibrationRef: 'calibration:offline@sha256:abcd' },
      },
      attempts: [{
        ordinal: 1,
        adapter: 'jev',
        adapterVersion: 'offline',
        requestedModel: 'offline-model',
        actualModel: 'offline-model-v1',
        subagent: null,
        status: 'success',
        reason: 'none',
        durationMs: 1,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        requestId: null,
      }],
    },
  };
}

function trainLogistic(trainRows, labels) {
  let weight = 0;
  let bias = 0;
  for (let epoch = 0; epoch < 400; epoch++) {
    let gradW = 0;
    let gradB = 0;
    for (const row of trainRows) {
      const x = probability(row);
      const y = labels[row.subjectId];
      const p = sigmoid(weight * x + bias);
      gradW += (p - y) * x;
      gradB += p - y;
    }
    weight -= 0.8 * gradW / trainRows.length;
    bias -= 0.8 * gradB / trainRows.length;
  }
  return { weight, bias };
}

function evaluate(testRows, labels, model) {
  const predictions = testRows.map(row => {
    const score = sigmoid(model.weight * probability(row) + model.bias);
    const actual = labels[row.subjectId];
    return { observationId: row.observationId, probability: round(score), predicted: score >= 0.5 ? 1 : 0, actual };
  });
  const correct = predictions.filter(item => item.predicted === item.actual).length;
  const brier = predictions.reduce((sum, item) => sum + (item.probability - item.actual) ** 2, 0) / predictions.length;
  return { n: predictions.length, accuracy: round(correct / predictions.length), brier: round(brier), predictions };
}

function probability(row) {
  const value = row.features['raw.provider.risk.noul.truth_probability']?.value;
  if (typeof value !== 'number') throw new Error(`Missing risk probability for ${row.observationId}`);
  return value;
}

function mustRow(rows, observationId) {
  const row = rows.get(observationId);
  if (!row) throw new Error(`Missing loaded row ${observationId}`);
  return row;
}

function sigmoid(value) { return 1 / (1 + Math.exp(-value)); }
function round(value) { return Math.round(value * 1_000_000) / 1_000_000; }
function digestObject(value) { return `sha256:${createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort())).digest('hex')}`; }
