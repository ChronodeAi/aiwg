import { describe, expect, it } from 'vitest';
import {
  DECISION_API_VERSION,
  DECISION_API_VERSION_STRUCTURED,
  DecisionFeatureExportError,
  artifactPin,
  createDecisionFeatureObservation,
  decisionFeatureTrainServeContract,
  deterministicFeatureSplit,
  generateDecisionFeatureSet,
  loadDecisionFeatureCsv,
  semanticFeatureContentDigest,
  serializeDecisionFeatureCsv,
  serializeDecisionFeatureJsonl,
  validateDecisionFeatureExportAuthorization,
  validateDecisionFeatureTrainServe,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionFeatureExportPolicy,
  type DecisionResult,
  type DecisionRuleset,
  type RulesetResult,
} from '../../../src/decision/index.js';

function definition(alias: string, kind: 'choice' | 'ordinal-score' | 'truth-probability'): DecisionDefinition {
  const answer = kind === 'choice'
    ? { kind, options: [{ id: 'yes', description: 'yes' }, { id: 'no', description: 'no' }, { id: 'none', description: 'none' }] }
    : kind === 'ordinal-score' ? { kind, levels: ['low', 'medium', 'high'] }
      : { kind, trueDescription: 'true', falseDescription: 'false' };
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionDefinition',
    metadata: { id: `decision-${alias}`, version: '1.0.0', description: alias },
    spec: { purpose: alias, inputSchema: { type: 'object' }, question: `question-${alias}`, answer, requiredCapabilities: [] },
  } as DecisionDefinition;
}

const definitions = {
  category: definition('category', 'choice'),
  severity: definition('severity', 'ordinal-score'),
  risk: definition('risk', 'truth-probability'),
};

function ruleset(): DecisionRuleset {
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionRuleset',
    metadata: { id: 'triage-ruleset', version: '1.0.0', description: 'triage' },
    spec: {
      purpose: 'triage',
      inputSchema: { type: 'object' },
      evaluations: [
        { alias: 'category', decision: artifactPin(definitions.category), inputPointer: '' },
        { alias: 'severity', decision: artifactPin(definitions.severity), inputPointer: '' },
        { alias: 'risk', decision: artifactPin(definitions.risk), inputPointer: '' },
      ],
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
}

function binding(sourceRuleset = ruleset()): DecisionBinding {
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionBinding',
    metadata: { id: 'triage-binding', version: '1.0.0', description: 'binding' },
    spec: {
      ruleset: artifactPin(sourceRuleset),
      totalTimeoutMs: 1000,
      maxAttempts: 1,
      concurrency: 1,
      evaluations: Object.fromEntries(sourceRuleset.spec.evaluations.map(entry => [entry.alias, { targets: [{
        adapter: 'jev',
        adapterVersion: '2026-09-24',
        model: 'jev-fixture',
        credentialRef: 'typesafe-api',
        requiredCapabilities: [],
        acceptance: { mode: 'typed-value' },
        timeoutMs: 1000,
        retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
      }], fallbackOn: [] }])),
    },
  };
}

function policy(): DecisionFeatureExportPolicy {
  return {
    tenantId: 'tenant',
    projectId: 'project',
    actorId: 'actor',
    recipient: 'offline-lab',
    purpose: 'feature-export-smoke',
    datasetPolicyId: 'dataset-policy-v1',
    accessScope: 'feature-exporter',
    operations: ['create', 'list', 'read', 'export', 'delete', 'share'],
    allowExternalDelivery: true,
    allowRawState: false,
    allowOutcomeLabels: false,
    reidentificationCanary: 'CANARY_NEVER_IN_FEATURES',
  };
}

function featureSet() {
  const sourceRuleset = ruleset();
  return generateDecisionFeatureSet({
    id: 'triage-features',
    version: '1.0.0',
    description: 'triage feature set',
    ruleset: sourceRuleset,
    binding: binding(sourceRuleset),
    definitions,
    compatibleServedModels: { category: ['jev-fixture-v1'], severity: ['jev-fixture-v1'], risk: ['jev-fixture-v1'] },
    calibration: { risk: { calibrationRef: 'calibration:risk@sha256:1234', maxAgeMs: 1000, recordedAtEpochMs: 100 } },
    privacy: {
      classification: 'restricted',
      retentionMs: 86_400_000,
      accessScope: 'feature-exporter',
      exportPolicyId: 'dataset-policy-v1',
      deletion: 'tombstone',
      lifecycleSurface: 'export',
    },
  });
}

function decision(alias: keyof typeof definitions, value: string | number,
  distribution: Record<string, number> | null, source: 'provider' | 'model-self-report' = 'provider'): DecisionResult {
  const sourceRuleset = ruleset();
  const sourceBinding = binding(sourceRuleset);
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionResult',
    metadata: { id: `result-${alias}`, version: '1.0.0', description: alias },
    spec: {
      decision: artifactPin(definitions[alias]),
      ruleset: artifactPin(sourceRuleset),
      binding: artifactPin(sourceBinding),
      alias,
      runId: 'run-1',
      invocationId: 'invocation-1',
      status: 'success',
      value,
      reason: 'none',
      uncertainty: {
        source,
        profile: source === 'provider' ? 'typesafe-distribution-v1' : 'llm-self-report-v1',
        calibration: 'measured',
        confidence: source === 'model-self-report' ? 0.61 : 0.9,
        distribution,
        calibrationRef: alias === 'risk' ? 'calibration:risk@sha256:1234' : null,
        ...(alias === 'risk' ? { calibratedRisk: { value: 0.08, calibrationRef: 'calibration:risk@sha256:1234' } } : {}),
      },
      attempts: [{
        ordinal: 1,
        adapter: 'jev',
        adapterVersion: '2026-09-24',
        requestedModel: 'jev-fixture',
        actualModel: 'jev-fixture-v1',
        subagent: null,
        status: 'success',
        reason: 'none',
        durationMs: 5,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        requestId: null,
      }],
    },
  };
}

function result(): RulesetResult {
  const sourceRuleset = ruleset();
  const sourceBinding = binding(sourceRuleset);
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'RulesetResult',
    metadata: { id: 'ruleset-result', version: '1.0.0', description: 'result' },
    spec: {
      ruleset: artifactPin(sourceRuleset),
      binding: artifactPin(sourceBinding),
      runId: 'run-1',
      invocationId: 'invocation-1',
      status: 'completed',
      reason: 'none',
      outcome: { route: 'review' },
      matchedRules: [],
      evaluations: {
        category: decision('category', 'yes', { yes: 0.5, no: 0.5, none: 0 }),
        severity: decision('severity', 1, { 0: 0.5, 1: 0, 2: 0.5 }),
        risk: decision('risk', 0.73, null),
      },
      batchRequests: [{
        groupId: 'batch-1',
        ordinal: 1,
        questionIds: ['category', 'severity', 'risk'],
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        requestId: null,
      }],
    },
  };
}


function makeRow(source = result()) {
 const set = featureSet();
 const row = createDecisionFeatureObservation({ featureSet: set, result: source, definitions,
   subjectId: 'subject-1', eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy() });
 return { set, row };
}
describe('independent feature-export review regressions', () => {
 it.each(['tenantId','projectId','recipient','purpose','datasetPolicyId','accessScope'] as const)('rejects substituted %s on export', field => {
  const { set,row }=makeRow();
  expect(() => serializeDecisionFeatureJsonl(set,[row],{...policy(),[field]:'unapproved-substitute'},'2026-09-24T00:00:02.000Z')).toThrow();
 });
 it('refuses a tombstoned row instead of serializing its feature data', () => {
  const { set,row }=makeRow();row.lifecycle.tombstone=true;
  expect(() => serializeDecisionFeatureJsonl(set,[row],policy(),'2026-09-24T00:00:02.000Z')).toThrow();
 });
 it('does not relabel native concentration confidence as model self-report', () => {
  const { row }=makeRow();
  expect(row.features['model_self_report.category.confidence']!.state).toBe('missing');
 });
 it('does not relabel self-report distributions as provider-native probabilities', () => {
  const r=result();r.spec.evaluations.category!.spec.uncertainty!.source='model-self-report';
  r.spec.evaluations.category!.spec.uncertainty!.profile='llm-self-report-v1';
  const { row }=makeRow(r);
  expect(row.features['raw.provider.category.choice.yes.probability']!.state).toBe('missing');
 });
 it('preserves absent choices as missing instead of all-zero compatibility observations', () => {
  const r=result();const d=r.spec.evaluations.category!;d.spec.status='abstained';d.spec.reason='low-confidence';delete d.spec.value;d.spec.uncertainty=null;
  const { row }=makeRow(r);
  expect(row.features['compat.one_hot.category.choice.yes']!.state).toBe('missing');
 });
 it('rejects a source decision with a different immutable definition pin', () => {
  const r=result();r.spec.evaluations.category!.spec.decision={...r.spec.evaluations.category!.spec.decision,digest:`sha256:${'f'.repeat(64)}`};
  expect(()=>makeRow(r)).toThrow();
 });
 it('rejects adapter-version substitution before row creation', () => {
  const r=result();r.spec.evaluations.category!.spec.attempts[0]!.adapterVersion='unapproved';
  expect(()=>makeRow(r)).toThrow();
 });
 it('rejects missing served-model lineage at inference', () => {
  const { set,row }=makeRow();row.trainServe.servedModels={};
  expect(()=>validateDecisionFeatureTrainServe(set,decisionFeatureTrainServeContract(set),row,500)).toThrow();
 });
 it('rejects unapproved unknown row fields instead of exporting hidden bodies', () => {
  const { set,row }=makeRow();(row as unknown as Record<string,unknown>).rawState='SECRET_CANARY_UNAPPROVED';
  expect(()=>serializeDecisionFeatureJsonl(set,[row],policy(),'2026-09-24T00:00:02.000Z')).toThrow();
 });
 it('round-trips all row semantics, including authorization, lifecycle and time', () => {
  const { set,row }=makeRow();const csv=serializeDecisionFeatureCsv(set,[row],policy(),'2026-09-24T00:00:02.000Z');
  expect(loadDecisionFeatureCsv(set,csv.payload)).toEqual([row]);
 });
});
