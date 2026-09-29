import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSchemaCatalog, SchemaResolver } from '../../../src/schema/index.js';
import {
  DECISION_API_VERSION,
  analyzeDecisionSensitivity,
  artifactPin,
  evaluateDecisionRuleset,
  SENSITIVITY_SCHEMA_FILES,
  SensitivityContractError,
  validateSensitivityPlan,
  validateSensitivityReport,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionResult,
  type DecisionRuleset,
  type RulesetResult,
  type SensitivityPlan,
} from '../../../src/decision/index.js';
import { scanQualificationPrivacy } from '../../../src/decision/qualification/index.js';
import { ROOT, applyPatch, readSensitivityFixture, sensitivityRecords, type AntiFixtureCase } from './sensitivity-fixtures.js';

const plans = sensitivityRecords<SensitivityPlan>('sensitivity-plan.v1.valid.json');

function rejection(run: () => unknown): SensitivityContractError {
  try { run(); } catch (error) { if (error instanceof SensitivityContractError) return error; throw error; }
  throw new Error('expected SensitivityContractError');
}

function artifacts() {
  const definition: DecisionDefinition = {
    apiVersion: DECISION_API_VERSION,
    kind: 'DecisionDefinition',
    metadata: { id: 'risk-choice', version: '1.0.0', description: 'Synthetic risk choice' },
    spec: {
      purpose: 'fixture',
      inputSchema: { type: 'object', additionalProperties: false, required: ['riskSignal'], properties: { riskSignal: { type: 'string' } } },
      question: 'Classify risk',
      answer: { kind: 'choice', options: [{ id: 'approve', description: 'Approve' }, { id: 'review', description: 'Review' }] },
      requiredCapabilities: [],
    },
  };
  const decisionPin = artifactPin(definition);
  const ruleset: DecisionRuleset = {
    apiVersion: DECISION_API_VERSION,
    kind: 'DecisionRuleset',
    metadata: { id: 'triage-rules', version: '1.0.0', description: 'Synthetic triage rules' },
    spec: {
      purpose: 'fixture',
      inputSchema: { type: 'object', additionalProperties: false, required: ['riskSignal'], properties: { riskSignal: { type: 'string' } } },
      evaluations: [{ alias: 'risk', decision: decisionPin, inputPointer: '' }],
      rules: [{
        id: 'rule-approve',
        priority: 10,
        when: { op: 'eq', left: { source: 'decision', alias: 'risk', pointer: '/value' }, right: 'approve' },
        outcome: { route: 'approve', label: 'low-risk' },
      }],
      composition: 'first-match',
      conflict: 'review',
      defaultOutcome: { route: 'review', label: 'needs-review' },
      failureOutcome: { route: 'review', label: 'needs-review' },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['route', 'label'],
        properties: { route: { enum: ['approve', 'review'] }, label: { enum: ['low-risk', 'needs-review'] } },
      },
    },
  };
  const rulesetPin = artifactPin(ruleset);
  const binding: DecisionBinding = {
    apiVersion: DECISION_API_VERSION,
    kind: 'DecisionBinding',
    metadata: { id: 'triage-binding', version: '1.0.0', description: 'Synthetic binding' },
    spec: {
      ruleset: rulesetPin,
      totalTimeoutMs: 1000,
      maxAttempts: 1,
      concurrency: 1,
      evaluations: {
        risk: {
          targets: [{
            adapter: 'jev',
            adapterVersion: 'fixture',
            model: 'fixture-model',
            credentialRef: 'fixture.credential',
            requiredCapabilities: [],
            acceptance: { mode: 'confidence-threshold', profile: 'fixture-confidence', minimumBps: 7000 },
            timeoutMs: 100,
            retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
          }],
          fallbackOn: [],
        },
      },
    },
  };
  const bindingPin = artifactPin(binding);
  const decisionResult: DecisionResult = {
    apiVersion: DECISION_API_VERSION,
    kind: 'DecisionResult',
    metadata: { id: 'run-source-risk', version: '1.0.0', description: 'Source risk result' },
    spec: {
      decision: decisionPin,
      ruleset: rulesetPin,
      binding: bindingPin,
      alias: 'risk',
      runId: 'run-source',
      invocationId: 'invoke-source',
      status: 'success',
      value: 'approve',
      reason: 'none',
      uncertainty: {
        source: 'provider',
        profile: 'fixture-confidence',
        calibration: 'uncalibrated',
        confidence: 0.8,
        distribution: { approve: 0.8, review: 0.2 },
        calibrationRef: null,
      },
      attempts: [{
        ordinal: 1,
        adapter: 'jev',
        adapterVersion: 'fixture',
        requestedModel: 'fixture-model',
        actualModel: 'fixture-model-v1',
        subagent: null,
        status: 'success',
        reason: 'none',
        durationMs: 0,
        usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.00001 },
        requestId: null,
      }],
    },
  };
  const sourceResult: RulesetResult = {
    apiVersion: DECISION_API_VERSION,
    kind: 'RulesetResult',
    metadata: { id: 'run-source', version: '1.0.0', description: 'Source ruleset result' },
    spec: {
      ruleset: rulesetPin,
      binding: bindingPin,
      runId: 'run-source',
      invocationId: 'invoke-source',
      status: 'completed',
      reason: 'none',
      outcome: { route: 'approve', label: 'low-risk' },
      matchedRules: ['rule-approve'],
      evaluations: { risk: decisionResult },
    },
  };
  return { definition, ruleset, binding, sourceInput: { riskSignal: 'low' }, sourceResult };
}

function pinnedPlan(id: string): SensitivityPlan {
  const fixture = structuredClone(plans.get(id)!);
  const built = artifacts();
  fixture.source.ruleset = artifactPin(built.ruleset);
  fixture.source.binding = artifactPin(built.binding);
  fixture.source.result = artifactPin(built.sourceResult);
  return fixture;
}

function resultWith(input: unknown, invocationId: string): RulesetResult {
  const built = artifacts();
  const high = (input as { riskSignal?: string }).riskSignal === 'high';
  const value = high ? 'review' : 'approve';
  const distribution = high ? { approve: 0.2, review: 0.8 } : { approve: 0.8, review: 0.2 };
  const decision = structuredClone(built.sourceResult.spec.evaluations.risk!);
  decision.metadata.id = `${invocationId}-risk`;
  decision.spec.invocationId = invocationId;
  decision.spec.value = value;
  decision.spec.uncertainty = { ...decision.spec.uncertainty!, distribution };
  decision.spec.attempts = [{
    ...decision.spec.attempts[0]!,
    usage: { inputTokens: 11, outputTokens: 3, costUsd: 0.00002 },
  }];
  const completed = value === 'approve';
  return {
    ...built.sourceResult,
    metadata: { id: invocationId, version: '1.0.0', description: 'Counterfactual result' },
    spec: {
      ...built.sourceResult.spec,
      invocationId,
      status: completed ? 'completed' : 'defaulted',
      reason: completed ? 'none' : 'no-match',
      outcome: completed ? { route: 'approve', label: 'low-risk' } : { route: 'review', label: 'needs-review' },
      matchedRules: completed ? ['rule-approve'] : [],
      evaluations: { risk: decision },
    },
  };
}

describe('D23 sensitivity contracts (#2616)', () => {
  it('CFX-SCHEMA-01 registers closed v1 schemas in the decision catalog', () => {
    const loaded = loadSchemaCatalog({ rootDir: ROOT });
    expect(loaded.valid, JSON.stringify(loaded.diagnostics)).toBe(true);
    const resolver = new SchemaResolver(loaded.catalog!, { rootDir: ROOT });
    for (const name of ['decision.sensitivity-plan', 'decision.sensitivity-report']) {
      const entry = resolver.require(`${name}@1.0.0`);
      expect(entry.artifact.stability).toBe('experimental');
      expect(Object.values(SENSITIVITY_SCHEMA_FILES).map(file => `schemas/decision/${file}`)).toContain(entry.artifact.authority.path);
      expect(existsSync(resolve(ROOT, entry.artifact.authority.path!))).toBe(true);
      expect(entry.artifact.projections?.map(item => item.kind)).toEqual(['types', 'validator']);
    }
  });

  it('CFX-SCHEMA-02 accepts positive fixtures and rejects declared anti-fixtures before inference', () => {
    const valid = readSensitivityFixture<{ provenance: { origin: string; sanitization: string }; records: SensitivityPlan[] }>('sensitivity-plan.v1.valid.json');
    expect(valid.provenance).toEqual({ origin: 'repository-authored', sanitization: 'synthetic; no personal inputs' });
    for (const record of valid.records) expect(() => validateSensitivityPlan(record)).not.toThrow();
    const invalid = readSensitivityFixture<{ cases: AntiFixtureCase[] }>('sensitivity-plan.v1.invalid.json');
    for (const item of invalid.cases) {
      const base = plans.get(item.base);
      expect(base, item.id).toBeDefined();
      const error = rejection(() => validateSensitivityPlan(applyPatch(base!, item.patch)));
      expect(error.layer, item.id).toBe(item.layer);
      if (item.expect) expect(error.details.join('\n'), item.id).toContain(item.expect);
    }
  });

  it('CFX-REPLAY-01 reuses stored evidence, makes zero adapter calls, and reports threshold and loss-matrix movement', async () => {
    const built = artifacts();
    const report = await analyzeDecisionSensitivity({
      plan: pinnedPlan('triage-threshold-replay'),
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
    });
    expect(validateSensitivityReport(report)).toBe(report);
    expect(report.status).toBe('completed');
    expect(report.actionAuthorization).toBe('not-authorized');
    expect(report.rows).toHaveLength(2);
    expect(report.budget.backendCalls).toBe(0);
    expect(report.rows.every(row => row.inference === 'reused-stored-evidence')).toBe(true);
    expect(report.rows.find(row => row.variantId === 'threshold-tighten')?.deltas.acceptanceChanged).toBe(true);
    expect(report.rows.find(row => row.variantId === 'loss-review')?.deltas.outcomeChanged).toBe(true);
    expect(JSON.stringify(report)).not.toContain('low-risk');
  });

  it('CFX-INPUT-01 uses fresh invocation IDs, separates stability controls, and redacts sensitive field values', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.variants.push({ id: 'restricted-canary', changes: [{ path: '/input/riskSignal', value: 'REDACTED-CANARY-2616' }] });
    plan.budgets.maxBackendCalls = 4;
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      reevaluate: async request => resultWith(request.input, request.invocationId),
    });
    expect(report.rows.map(row => row.kind)).toEqual(['baseline-stability', 'variant', 'unchanged-control', 'variant']);
    expect(report.rows.filter(row => row.inference === 'new-invocation').every(row => row.freshInvocationId && row.freshInvocationId !== 'invoke-source')).toBe(true);
    expect(report.rows.find(row => row.variantId === 'risk-high')?.deltas.distributionDistanceBps).toBe(6000);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('REDACTED-CANARY-2616');
    expect(scanQualificationPrivacy([{ surface: 'stdout', content: '' }, { surface: 'stderr', content: '' },
      { surface: 'test-report', content: serialized }, { surface: 'trace', content: serialized },
      { surface: 'receipt', content: serialized }, { surface: 'snapshot', content: serialized },
      { surface: 'export', content: serialized }, { surface: 'thrown-error', content: '' },
      { surface: 'activity-record', content: serialized }], ['REDACTED-CANARY-2616']).clean).toBe(true);
  });

  it('CFX-BUDGET-01 stops variants at resource ceilings and marks the report partial/no-action', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.budgets.maxBackendCalls = 1;
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      reevaluate: async request => resultWith(request.input, request.invocationId),
    });
    expect(report.status).toBe('partial');
    expect(report.budget.exhausted).toBe(true);
    expect(report.actionAuthorization).toBe('not-authorized');
    expect(report.rows).toHaveLength(1);
  });

  it('CFX-PROBE-01 applies per-principal subject path limits across report IDs', async () => {
    const built = artifacts();
    const state = { reportsByWindow: new Map<string, number>(), pathCounts: new Map<string, number>() };
    const first = pinnedPlan('triage-input-field');
    first.probeControl.maxPerPrincipalSubjectPath = 2;
    first.baselineStability.enabled = false;
    first.baselineStability.repeats = 0;
    const second = { ...structuredClone(first), id: 'triage-input-field-second' };
    const common = {
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: state,
      reevaluate: async (request: { input: unknown; invocationId: string }) => resultWith(request.input, request.invocationId),
    };
    expect((await analyzeDecisionSensitivity({ ...common, plan: first })).status).toBe('completed');
    const denied = await analyzeDecisionSensitivity({ ...common, plan: second });
    expect(denied.status).toBe('rejected');
    expect(denied.warnings.join(' ')).toContain('probe path limit');
    expect(denied.budget.backendCalls).toBe(0);
  });

  it('CFX-DISABLED-01 leaves ordinary decision evaluation byte-identical when sensitivity is not invoked', async () => {
    const built = artifacts();
    const adapter: DecisionAdapter = {
      id: 'jev',
      version: 'fixture',
      async capabilities() {
        return { answerKinds: ['choice'], features: [], maxOptions: null, maxLevels: null,
          confidenceProfiles: ['fixture-confidence'], executable: true, egress: { mode: 'none' } };
      },
      async evaluate(): Promise<AdapterObservation> {
        return {
          status: 'success',
          reason: 'none',
          value: 'approve',
          uncertainty: {
            source: 'provider',
            profile: 'fixture-confidence',
            calibration: 'uncalibrated',
            confidence: 0.8,
            distribution: { approve: 0.8, review: 0.2 },
            calibrationRef: null,
          },
          actualModel: 'fixture-model-v1',
          usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.00001 },
          requestId: null,
        };
      },
    };
    const request = {
      ruleset: built.ruleset,
      binding: built.binding,
      definitions: { [built.definition.metadata.id]: built.definition },
      input: built.sourceInput,
      runId: 'run-disabled',
      invocationId: 'invoke-disabled',
      adapters: { jev: adapter },
      now: () => 1_000,
    };
    const before = await evaluateDecisionRuleset(request);
    const disabledPlan = { ...pinnedPlan('triage-input-field'), mode: 'disabled' as const };
    expect(disabledPlan.mode).toBe('disabled');
    const after = await evaluateDecisionRuleset(request);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('CFX-DISABLED-02 a disabled sensitivity plan performs no analysis or inference', async () => {
    const built = artifacts();
    const plan = { ...pinnedPlan('triage-input-field'), mode: 'disabled' as const };
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      reevaluate: async request => resultWith(request.input, request.invocationId),
    });
    expect(report.status).toBe('rejected');
    expect(report.rows).toEqual([]);
    expect(report.budget.backendCalls).toBe(0);
    expect(report.warnings.join(' ')).toContain('disabled');
  });

  it('CFX-DOC-EXAMPLES-01 covers threshold replay, loss-matrix, field perturbation, and no-change controls', () => {
    const text = readFileSync(resolve(ROOT, 'test/fixtures/decision/sensitivity/sensitivity-plan.v1.valid.json'), 'utf8');
    expect(text).toContain('threshold-tighten');
    expect(text).toContain('loss-review');
    expect(text).toContain('risk-high');
    expect(text).toContain('no-change');
  });
});
