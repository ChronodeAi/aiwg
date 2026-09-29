import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSchemaCatalog, SchemaResolver } from '../../../src/schema/index.js';
import {
  DECISION_API_VERSION,
  DECISION_API_VERSION_STRUCTURED,
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
  type SensitivityProbeState,
} from '../../../src/decision/index.js';
import { scanQualificationPrivacy } from '../../../src/decision/qualification/index.js';
import { ROOT, applyPatch, readSensitivityFixture, sensitivityRecords, type AntiFixtureCase } from './sensitivity-fixtures.js';

const plans = sensitivityRecords<SensitivityPlan>('sensitivity-plan.v1.valid.json');

function probeState(): SensitivityProbeState {
  return { reportsByWindow: new Map(), pathCounts: new Map() };
}

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
  return { definition, ruleset, binding, sourceDefinitions: { [definition.metadata.id]: definition }, sourceInput: { riskSignal: 'low' }, sourceResult };
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

function adapterAbstainedSource(built: ReturnType<typeof artifacts>): RulesetResult {
  const sourceResult = structuredClone(built.sourceResult);
  const risk = sourceResult.spec.evaluations.risk!;
  risk.spec.status = 'abstained';
  risk.spec.reason = 'low-confidence';
  delete risk.spec.value;
  delete risk.spec.acceptance;
  risk.spec.uncertainty = { ...risk.spec.uncertainty!, confidence: 0.9, distribution: { approve: 0.9, review: 0.1 } };
  risk.spec.attempts = [{ ...risk.spec.attempts[0]!, status: 'abstained', reason: 'low-confidence' }];
  sourceResult.spec.status = 'review';
  sourceResult.spec.reason = 'evaluation-failed';
  sourceResult.spec.outcome = { route: 'review', label: 'needs-review' };
  sourceResult.spec.matchedRules = [];
  return sourceResult;
}

function multiEvaluationArtifacts() {
  const built = artifacts();
  built.ruleset.spec.evaluations.push({ alias: 'compliance', decision: artifactPin(built.definition), inputPointer: '' });
  const rulesetPin = artifactPin(built.ruleset);
  built.binding.spec.ruleset = rulesetPin;
  built.binding.spec.maxAttempts = 2;
  built.binding.spec.evaluations.compliance = structuredClone(built.binding.spec.evaluations.risk!);
  const bindingPin = artifactPin(built.binding);
  const sourceResult = structuredClone(built.sourceResult);
  sourceResult.spec.ruleset = rulesetPin;
  sourceResult.spec.binding = bindingPin;
  const risk = sourceResult.spec.evaluations.risk!;
  risk.spec.ruleset = rulesetPin;
  risk.spec.binding = bindingPin;
  const compliance = structuredClone(risk);
  compliance.metadata.id = 'run-source-compliance';
  compliance.spec.alias = 'compliance';
  sourceResult.spec.evaluations = { risk, compliance };
  return { ...built, sourceResult };
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
      sourceDefinitions: built.sourceDefinitions,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
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

  it('CFX-REPLAY-02 replays acceptance from stored evidence so a loosened threshold can accept', async () => {
    const built = artifacts();
    const sourceResult = structuredClone(built.sourceResult);
    const risk = sourceResult.spec.evaluations.risk!;
    risk.spec.status = 'abstained';
    risk.spec.reason = 'low-confidence';
    delete risk.spec.value;
    risk.spec.uncertainty = { ...risk.spec.uncertainty!, confidence: 0.65, distribution: { approve: 0.65, review: 0.35 } };
    sourceResult.spec.status = 'review';
    sourceResult.spec.reason = 'evaluation-failed';
    sourceResult.spec.outcome = { route: 'review', label: 'needs-review' };
    sourceResult.spec.matchedRules = [];

    const plan = pinnedPlan('triage-threshold-replay');
    plan.id = 'triage-threshold-loosen';
    plan.source.result = artifactPin(sourceResult);
    plan.pathDomains[0]!.values = [6000, 7000];
    plan.variants = [{
      id: 'threshold-loosen',
      changes: [{ path: '/binding/spec/evaluations/risk/targets/0/acceptance/minimumBps', value: 6000 }],
    }];

    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceDefinitions: built.sourceDefinitions,
      sourceInput: built.sourceInput,
      sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
    });

    expect(report.status).toBe('completed');
    expect(report.rows[0]?.deltas.acceptanceChanged).toBe(true);
    expect(report.rows[0]?.deltas.outcomeChanged).toBe(true);
    expect(report.rows[0]?.deltas.status).toBe('completed');
  });

  it('CFX-REPLAY-03 preserves ordinal semantics when a score has no distribution', async () => {
    const built = artifacts();
    built.definition.apiVersion = DECISION_API_VERSION_STRUCTURED;
    built.definition.spec.answer = { kind: 'ordinal-score', levels: ['low', 'high'] };
    const decisionPin = artifactPin(built.definition);
    built.ruleset.spec.evaluations[0]!.decision = decisionPin;
    built.ruleset.spec.rules[0]!.when = { op: 'gt', left: { source: 'decision', alias: 'risk', pointer: '/value' }, right: 0.5 };
    const rulesetPin = artifactPin(built.ruleset);
    built.binding.apiVersion = DECISION_API_VERSION_STRUCTURED;
    built.binding.spec.ruleset = rulesetPin;
    built.binding.spec.evaluations.risk!.targets[0]!.acceptance = {
      mode: 'primitive-policy',
      version: '1.0.0',
      compatibleUncertaintyProfiles: ['fixture-score'],
      precedence: 'first-match',
      calibration: 'advisory',
      rules: [{
        id: 'accept-score',
        primitive: 'ordinal-score',
        all: [{ metric: 'expected-score', op: 'gte', thresholdBps: 5000 }],
        route: { disposition: 'act' },
      }],
      defaultRoute: { disposition: 'act' },
      missingEvidenceRoute: { disposition: 'review' },
      invalidEvidenceRoute: { disposition: 'review' },
      tieRoute: { disposition: 'review' },
    };
    const bindingPin = artifactPin(built.binding);
    const sourceResult = structuredClone(built.sourceResult);
    sourceResult.spec.ruleset = rulesetPin;
    sourceResult.spec.binding = bindingPin;
    const risk = sourceResult.spec.evaluations.risk!;
    risk.spec.decision = decisionPin;
    risk.spec.ruleset = rulesetPin;
    risk.spec.binding = bindingPin;
    risk.spec.value = 1;
    risk.spec.uncertainty = {
      source: 'provider',
      profile: 'fixture-score',
      calibration: 'uncalibrated',
      confidence: null,
      distribution: null,
      calibrationRef: null,
    };

    const plan = pinnedPlan('triage-threshold-replay');
    plan.id = 'triage-ordinal-no-distribution';
    plan.source.ruleset = rulesetPin;
    plan.source.binding = bindingPin;
    plan.source.result = artifactPin(sourceResult);
    plan.allowedPaths = ['/binding/spec/evaluations/risk/targets/0/acceptance/version'];
    plan.pathDomains = [{ path: plan.allowedPaths[0]!, values: ['1.0.1'], sensitivity: 'internal' }];
    plan.variants = [{ id: 'replay-ordinal-policy', changes: [{ path: plan.allowedPaths[0]!, value: '1.0.1' }] }];

    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceDefinitions: { [built.definition.metadata.id]: built.definition },
      sourceInput: built.sourceInput,
      sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
    });

    expect(report.rows[0]?.deltas.status).toBe('review');
    expect(sourceResult.spec.evaluations.risk?.spec.uncertainty?.distribution).toBeNull();
  });

  it('CFX-REPLAY-04 is byte-deterministic for identical policy replay inputs', async () => {
    const built = artifacts();
    const request = {
      plan: pinnedPlan('triage-threshold-replay'),
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceDefinitions: built.sourceDefinitions,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
    };
    const first = await analyzeDecisionSensitivity(request);
    const second = await analyzeDecisionSensitivity({ ...request, plan: structuredClone(request.plan), probeState: probeState() });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('CFX-REPLAY-05 does not invent acceptances from non-acceptance failures with distributions', async () => {
    const probes = [
      { status: 'abstained' as const, reason: 'insufficient-information' as const },
      { status: 'error' as const, reason: 'invalid-output' as const },
    ];
    for (const probe of probes) {
      const built = artifacts();
      const sourceResult = structuredClone(built.sourceResult);
      const risk = sourceResult.spec.evaluations.risk!;
      risk.spec.status = probe.status;
      risk.spec.reason = probe.reason;
      delete risk.spec.value;
      risk.spec.uncertainty = { ...risk.spec.uncertainty!, confidence: 0.65, distribution: { approve: 0.65, review: 0.35 } };
      sourceResult.spec.status = 'review';
      sourceResult.spec.reason = 'evaluation-failed';
      sourceResult.spec.outcome = { route: 'review', label: 'needs-review' };
      sourceResult.spec.matchedRules = [];

      const plan = pinnedPlan('triage-threshold-replay');
      plan.id = `triage-threshold-${probe.reason}`;
      plan.source.result = artifactPin(sourceResult);
      plan.pathDomains[0]!.values = [6000, 7000];
      plan.variants = [{
        id: 'threshold-loosen',
        changes: [{ path: '/binding/spec/evaluations/risk/targets/0/acceptance/minimumBps', value: 6000 }],
      }];

      const report = await analyzeDecisionSensitivity({
        plan,
        sourceRuleset: built.ruleset,
        sourceBinding: built.binding,
        sourceDefinitions: built.sourceDefinitions,
        sourceInput: built.sourceInput,
        sourceResult,
        generatedAt: '2026-09-29T12:00:00.000Z',
        now: () => 1_000,
        probeState: probeState(),
      });

      expect(report.status, probe.reason).toBe('completed');
      expect(report.rows[0]?.deltas.status, probe.reason).toBe('review');
      expect(report.rows[0]?.deltas.outcomeChanged, probe.reason).toBe(false);
      expect(report.rows[0]?.deltas.acceptanceChanged, probe.reason).toBe(false);
    }
  });

  it('CFX-REPLAY-06 replays the acceptance of the fallback target that produced the accepted value', async () => {
    const built = artifacts();
    built.binding.spec.maxAttempts = 2;
    const primary = built.binding.spec.evaluations.risk!.targets[0]!;
    built.binding.spec.evaluations.risk!.targets.push({
      ...structuredClone(primary),
      model: 'fixture-fallback-model',
      acceptance: { mode: 'confidence-threshold', profile: 'fixture-confidence', minimumBps: 5000 },
    });
    built.binding.spec.evaluations.risk!.fallbackOn = ['executor-unavailable'];
    const bindingPin = artifactPin(built.binding);
    const sourceResult = structuredClone(built.sourceResult);
    sourceResult.spec.binding = bindingPin;
    const risk = sourceResult.spec.evaluations.risk!;
    risk.spec.binding = bindingPin;
    risk.spec.uncertainty = { ...risk.spec.uncertainty!, confidence: 0.6, distribution: { approve: 0.6, review: 0.4 } };
    risk.spec.attempts = [
      { ...structuredClone(risk.spec.attempts[0]!), actualModel: null, status: 'error', reason: 'executor-unavailable',
        usage: { inputTokens: null, outputTokens: null, costUsd: null } },
      { ...structuredClone(risk.spec.attempts[0]!), ordinal: 2, requestedModel: 'fixture-fallback-model', actualModel: 'fixture-fallback-model-v1' },
    ];

    const path = '/binding/spec/evaluations/risk/targets/1/acceptance/minimumBps';
    const plan = pinnedPlan('triage-threshold-replay');
    plan.id = 'triage-fallback-target-replay';
    plan.source.binding = bindingPin;
    plan.source.result = artifactPin(sourceResult);
    plan.allowedPaths = [path];
    plan.pathDomains = [{ path, values: [4000, 7000], sensitivity: 'internal' }];
    plan.variants = [
      { id: 'fallback-loosen', changes: [{ path, value: 4000 }] },
      { id: 'fallback-tighten', changes: [{ path, value: 7000 }] },
    ];

    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceDefinitions: built.sourceDefinitions,
      sourceInput: built.sourceInput,
      sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
    });

    expect(report.status).toBe('completed');
    const loosen = report.rows.find(row => row.variantId === 'fallback-loosen')!;
    expect(loosen.deltas.status).toBe('completed');
    expect(loosen.deltas.outcomeChanged).toBe(false);
    expect(loosen.deltas.acceptanceChanged).toBe(false);
    const tighten = report.rows.find(row => row.variantId === 'fallback-tighten')!;
    expect(tighten.deltas.acceptanceChanged).toBe(true);
    expect(tighten.deltas.outcomeChanged).toBe(true);
  });

  it('CFX-REPLAY-07 does not replay an adapter-originated abstention that the source threshold would have accepted', async () => {
    // Confidence-threshold target: the recorded confidence (0.9) clears the source threshold (7000 bps),
    // so the source target's acceptance could not have produced this abstention.
    const threshold = artifacts();
    const thresholdSource = adapterAbstainedSource(threshold);
    const thresholdPlan = pinnedPlan('triage-threshold-replay');
    thresholdPlan.id = 'triage-adapter-abstention-threshold';
    thresholdPlan.source.result = artifactPin(thresholdSource);
    thresholdPlan.pathDomains[0]!.values = [6000, 7000];
    thresholdPlan.variants = [{
      id: 'threshold-loosen',
      changes: [{ path: '/binding/spec/evaluations/risk/targets/0/acceptance/minimumBps', value: 6000 }],
    }];
    const thresholdReport = await analyzeDecisionSensitivity({
      plan: thresholdPlan,
      sourceRuleset: threshold.ruleset,
      sourceBinding: threshold.binding,
      sourceDefinitions: threshold.sourceDefinitions,
      sourceInput: threshold.sourceInput,
      sourceResult: thresholdSource,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
    });
    expect(thresholdReport.rows[0]?.deltas.status).toBe('review');
    expect(thresholdReport.rows[0]?.deltas.outcomeChanged).toBe(false);
    expect(thresholdReport.rows[0]?.deltas.acceptanceChanged).toBe(false);
  });

  it('CFX-REPLAY-08 requires acceptance evidence before replaying a primitive-policy abstention', async () => {
    // Primitive-policy target: acceptance-derived abstentions carry DecisionAcceptanceEvidence; this one does not.
    const primitive = artifacts();
    primitive.binding.apiVersion = DECISION_API_VERSION_STRUCTURED;
    primitive.binding.spec.evaluations.risk!.targets[0]!.acceptance = {
      mode: 'primitive-policy',
      version: '1.0.0',
      compatibleUncertaintyProfiles: ['fixture-confidence'],
      precedence: 'first-match',
      calibration: 'advisory',
      rules: [{
        id: 'accept-choice',
        primitive: 'choice',
        all: [{ metric: 'selected-probability', op: 'gte', thresholdBps: 5000 }],
        route: { disposition: 'act' },
      }],
      defaultRoute: { disposition: 'act' },
      missingEvidenceRoute: { disposition: 'review' },
      invalidEvidenceRoute: { disposition: 'review' },
      tieRoute: { disposition: 'review' },
    };
    const primitiveBindingPin = artifactPin(primitive.binding);
    const primitiveSource = adapterAbstainedSource(primitive);
    primitiveSource.spec.binding = primitiveBindingPin;
    primitiveSource.spec.evaluations.risk!.spec.binding = primitiveBindingPin;
    const primitivePlan = pinnedPlan('triage-threshold-replay');
    primitivePlan.id = 'triage-adapter-abstention-primitive';
    primitivePlan.source.binding = primitiveBindingPin;
    primitivePlan.source.result = artifactPin(primitiveSource);
    primitivePlan.allowedPaths = ['/binding/spec/evaluations/risk/targets/0/acceptance/version'];
    primitivePlan.pathDomains = [{ path: primitivePlan.allowedPaths[0]!, values: ['1.0.1'], sensitivity: 'internal' }];
    primitivePlan.variants = [{ id: 'replay-choice-policy', changes: [{ path: primitivePlan.allowedPaths[0]!, value: '1.0.1' }] }];
    const primitiveReport = await analyzeDecisionSensitivity({
      plan: primitivePlan,
      sourceRuleset: primitive.ruleset,
      sourceBinding: primitive.binding,
      sourceDefinitions: primitive.sourceDefinitions,
      sourceInput: primitive.sourceInput,
      sourceResult: primitiveSource,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
    });
    expect(primitiveReport.rows[0]?.deltas.status).toBe('review');
    expect(primitiveReport.rows[0]?.deltas.outcomeChanged).toBe(false);
    expect(primitiveReport.rows[0]?.deltas.acceptanceChanged).toBe(false);
  });

  it('CFX-INPUT-01 uses fresh invocation IDs, separates stability controls, and redacts sensitive field values', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.variants.push({ id: 'restricted-canary', changes: [{ path: '/input/riskSignal', value: 'REDACTED-CANARY-2616' }] });
    plan.budgets.maxBackendCalls = 4;
    const seen: Array<{ invocationId: string; receiptFingerprint: string }> = [];
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async request => {
        seen.push({ invocationId: request.invocationId, receiptFingerprint: request.receiptFingerprint });
        return resultWith(request.input, request.invocationId);
      },
    });
    expect(report.rows.map(row => row.kind)).toEqual(['baseline-stability', 'variant', 'unchanged-control', 'variant']);
    expect(report.rows.filter(row => row.inference === 'new-invocation').every(row => row.freshInvocationId && row.freshInvocationId !== 'invoke-source')).toBe(true);
    expect(report.rows.find(row => row.variantId === 'risk-high')?.deltas.distributionDistanceBps).toBe(6000);
    expect(seen.every(item => /^sens-triage-input-field-[0-9a-f-]+-/.test(item.invocationId))).toBe(true);
    expect(new Set(seen.map(item => item.receiptFingerprint)).size).toBe(seen.length);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('REDACTED-CANARY-2616');
    expect(scanQualificationPrivacy([{ surface: 'stdout', content: '' }, { surface: 'stderr', content: '' },
      { surface: 'test-report', content: serialized }, { surface: 'trace', content: serialized },
      { surface: 'receipt', content: serialized }, { surface: 'snapshot', content: serialized },
      { surface: 'export', content: serialized }, { surface: 'thrown-error', content: '' },
      { surface: 'activity-record', content: serialized }], ['REDACTED-CANARY-2616']).clean).toBe(true);
  });

  it('CFX-INPUT-02 gives repeat runs fresh invocation IDs without reusing receipt fingerprints', async () => {
    const built = artifacts();
    const invocations: string[][] = [];
    const fingerprints: string[][] = [];
    for (let index = 0; index < 2; index += 1) {
      const runInvocations: string[] = [];
      const runFingerprints: string[] = [];
      const plan = pinnedPlan('triage-input-field');
      plan.baselineStability.enabled = false;
      plan.baselineStability.repeats = 0;
      await analyzeDecisionSensitivity({
        plan,
        sourceRuleset: built.ruleset,
        sourceBinding: built.binding,
        sourceInput: built.sourceInput,
        sourceResult: built.sourceResult,
        generatedAt: '2026-09-29T12:00:00.000Z',
        now: () => 1_000,
        probeState: probeState(),
        reevaluate: async request => {
          runInvocations.push(request.invocationId);
          runFingerprints.push(request.receiptFingerprint);
          return resultWith(request.input, request.invocationId);
        },
      });
      invocations.push(runInvocations);
      fingerprints.push(runFingerprints);
    }
    expect(invocations[0]).not.toEqual(invocations[1]);
    expect(fingerprints[0]).not.toEqual(fingerprints[1]);
  });

  it('CFX-INPUT-03 returns a partial report with completed rows and spend after a mid-run failure', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.variants = [
      { id: 'risk-high-one', changes: [{ path: '/input/riskSignal', value: 'high' }] },
      { id: 'risk-high-two', changes: [{ path: '/input/riskSignal', value: 'high' }] },
    ];
    let calls = 0;
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async request => {
        calls += 1;
        if (calls === 2) throw new Error('fixture transport failed after dispatch');
        return resultWith(request.input, request.invocationId);
      },
    });
    expect(report.status).toBe('partial');
    expect(report.rows).toHaveLength(1);
    // The completed row spent one call; the thrown second call has no spend evidence, so one reserved call is charged.
    expect(report.budget.backendCalls).toBe(2);
    expect(report.budget.costMicros).toBeGreaterThan(0);
    expect(report.warnings).toContain('partial-failure');
    expect(report.warnings).toContain('spend-unknown-reserved');
    expect(report.warnings).not.toContain('rejected-before-inference');
  });

  it('CFX-INPUT-04 rejects reserved baseline variant IDs before inference', () => {
    const plan = pinnedPlan('triage-input-field');
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.variants = [{ id: 'baseline-1', changes: [{ path: '/input/riskSignal', value: 'high' }] }];
    const error = rejection(() => validateSensitivityPlan(plan));
    expect(error.details.join('\n')).toContain('reserved baseline identifier');
  });

  it('CFX-INPUT-05 converts mid-run freshness contract errors into partial reports with spend', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.id = 'p'.repeat(118);
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.budgets.maxBackendCalls = 4;
    plan.variants = [
      { id: 'risk-high-one', changes: [{ path: '/input/riskSignal', value: 'high' }] },
      { id: 'risk-high-two', changes: [{ path: '/input/riskSignal', value: 'high' }] },
    ];
    let calls = 0;
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async request => {
        calls += 1;
        return resultWith(request.input, request.invocationId);
      },
    });
    expect(calls).toBe(1);
    expect(report.status).toBe('partial');
    expect(report.rows).toHaveLength(1);
    expect(report.budget.backendCalls).toBe(1);
    expect(report.warnings.join(' ')).toContain('already used');
  });

  it('CFX-INPUT-06 counts spend when reevaluation validation rejects an executed result', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.variants = [{ id: 'risk-high', changes: [{ path: '/input/riskSignal', value: 'high' }] }];
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async request => resultWith(request.input, `${request.invocationId}-wrong`),
    });
    expect(report.status).toBe('failed');
    expect(report.rows).toHaveLength(0);
    expect(report.budget.backendCalls).toBe(1);
    expect(report.budget.tokens).toBe(14);
    expect(report.warnings.join(' ')).toContain('returned invocation ID');
  });

  it('CFX-INPUT-07 reports first reevaluation transport failure as failed with supplied spend', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.variants = [{ id: 'risk-high', changes: [{ path: '/input/riskSignal', value: 'high' }] }];
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async () => {
        throw Object.assign(new Error('transport failed after dispatch'), {
          resourceUse: { backendCalls: 1, tokens: 14, costMicros: 20 },
        });
      },
    });
    expect(report.status).toBe('failed');
    expect(report.budget.backendCalls).toBe(1);
    expect(report.budget.tokens).toBe(14);
    expect(report.budget.costMicros).toBe(20);
    expect(report.warnings).toContain('partial-failure');
  });

  it('CFX-INPUT-08 conservatively reserves and flags spend when a reevaluation throws without spend evidence', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.variants = [{ id: 'risk-high', changes: [{ path: '/input/riskSignal', value: 'high' }] }];
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async () => { throw new Error('transport failed after dispatch'); },
    });
    expect(report.status).toBe('failed');
    // One evaluation x maxAttempts 1, priced at the largest source attempt (10 + 2 tokens, 10 micros).
    expect(report.budget.backendCalls).toBe(1);
    expect(report.budget.tokens).toBe(12);
    expect(report.budget.costMicros).toBe(10);
    expect(report.warnings).toContain('spend-unknown-reserved');
  });

  it('CFX-AUTH-01 rejects stale authorization before any input reevaluation', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.authorization.expiresAt = '2026-09-29T12:30:00.000Z';
    let calls = 0;
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:45:00.000Z',
      now: () => Date.parse('2026-09-29T12:45:00.000Z'),
      probeState: probeState(),
      reevaluate: async request => {
        calls += 1;
        return resultWith(request.input, request.invocationId);
      },
    });
    expect(report.status).toBe('rejected');
    expect(report.budget.backendCalls).toBe(0);
    expect(calls).toBe(0);
    expect(report.warnings.join(' ')).toContain('authorization expired');
  });

  it('CFX-POINTER-01 rejects prototype pointer segments without polluting Object.prototype', () => {
    const plan = pinnedPlan('triage-input-field');
    plan.allowedPaths = ['/input/__proto__/polluted'];
    plan.pathDomains = [{ path: '/input/__proto__/polluted', values: ['yes'], sensitivity: 'restricted' }];
    plan.variants = [{ id: 'proto-pollution', changes: [{ path: '/input/__proto__/polluted', value: 'yes' }] }];
    const error = rejection(() => validateSensitivityPlan(plan));
    expect(error.details.join('\n')).toContain('prohibited pointer segment');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('CFX-BUDGET-01 stops variants at resource ceilings and marks the report partial/no-action', async () => {
    const built = artifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.budgets.maxBackendCalls = 1;
    plan.variants = [
      { id: 'risk-high-one', changes: [{ path: '/input/riskSignal', value: 'high' }] },
      { id: 'risk-high-two', changes: [{ path: '/input/riskSignal', value: 'high' }] },
    ];
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async request => resultWith(request.input, request.invocationId),
    });
    expect(report.status).toBe('partial');
    expect(report.budget.exhausted).toBe(true);
    expect(report.actionAuthorization).toBe('not-authorized');
    expect(report.rows).toHaveLength(1);
  });

  it('CFX-BUDGET-02 reserves attempts per evaluation before dispatching multi-evaluation reevaluations', async () => {
    const built = multiEvaluationArtifacts();
    const plan = pinnedPlan('triage-input-field');
    plan.source.ruleset = artifactPin(built.ruleset);
    plan.source.binding = artifactPin(built.binding);
    plan.source.result = artifactPin(built.sourceResult);
    plan.baselineStability.enabled = false;
    plan.baselineStability.repeats = 0;
    plan.budgets.maxBackendCalls = 3;
    let calls = 0;
    const report = await analyzeDecisionSensitivity({
      plan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async request => {
        calls += 1;
        return resultWith(request.input, request.invocationId);
      },
    });
    expect(calls).toBe(0);
    expect(report.status).toBe('budget-exhausted');
    expect(report.budget.backendCalls).toBe(0);
  });

  it('CFX-PROBE-01 applies per-principal subject path limits across report IDs', async () => {
    const built = artifacts();
    const state = { reportsByWindow: new Map<string, number>(), pathCounts: new Map<string, number>() };
    const first = pinnedPlan('triage-input-field');
    first.probeControl.maxPerPrincipalSubjectPath = 1;
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

  it('CFX-PROBE-02 does not charge disabled plans and applies default probe limits without caller state', async () => {
    const built = artifacts();
    const disabled = { ...pinnedPlan('triage-input-field'), id: 'triage-disabled-probe', mode: 'disabled' as const };
    disabled.probeControl.windowId = 'window-disabled-probe';
    disabled.probeControl.maxReportsPerWindow = 1;
    disabled.sourceSubject.subjectRef = 'case-disabled-probe';
    const enabled = { ...structuredClone(disabled), mode: 'shadow' as const };
    const common = {
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      reevaluate: async (request: { input: unknown; invocationId: string }) => resultWith(request.input, request.invocationId),
    };
    expect((await analyzeDecisionSensitivity({ ...common, plan: disabled })).status).toBe('rejected');
    expect((await analyzeDecisionSensitivity({ ...common, plan: enabled })).status).toBe('completed');
    const denied = await analyzeDecisionSensitivity({ ...common, plan: { ...structuredClone(enabled), id: 'triage-enabled-probe-second' } });
    expect(denied.status).toBe('rejected');
    expect(denied.warnings.join(' ')).toContain('probe report limit');
  });

  it('CFX-PROBE-03 does not charge no-change variants to path probes or backend spend', async () => {
    const built = artifacts();
    const common = {
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      reevaluate: async (request: { input: unknown; invocationId: string }) => resultWith(request.input, request.invocationId),
    };
    for (let index = 0; index < 2; index += 1) {
      const plan = pinnedPlan('triage-input-field');
      plan.id = `triage-no-change-probe-${index}`;
      plan.probeControl.windowId = 'window-no-change-probe';
      plan.probeControl.maxPerPrincipalSubjectPath = 1;
      plan.probeControl.maxReportsPerWindow = 4;
      plan.sourceSubject.subjectRef = 'case-no-change-probe';
      plan.baselineStability.enabled = false;
      plan.baselineStability.repeats = 0;
      plan.variants = [{ id: `no-change-${index}`, changes: [{ path: '/input/riskSignal', value: 'low' }] }];
      const report = await analyzeDecisionSensitivity({ ...common, plan });
      expect(report.status).toBe('completed');
      expect(report.budget.backendCalls).toBe(0);
      expect(report.rows[0]?.inference).toBe('deduplicated-control');
    }
  });

  it('CFX-PROBE-04 fails closed when the implicit probe state is full and evicts only expired windows', async () => {
    const built = artifacts();
    const windowMs = 3_600_000;
    let clock = 100 * windowMs + 1_000;
    const common = {
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => clock,
      reevaluate: async (request: { input: unknown; invocationId: string }) => resultWith(request.input, request.invocationId),
    };
    const makePlan = (index: number) => {
      const plan = pinnedPlan('triage-input-field');
      plan.id = `triage-capacity-${index}`;
      plan.probeControl.windowId = 'window-capacity-probe';
      plan.probeControl.maxReportsPerWindow = 1;
      plan.sourceSubject.subjectRef = `case-capacity-${index}`;
      plan.baselineStability.enabled = false;
      plan.baselineStability.repeats = 0;
      plan.variants = [{ id: `no-change-${index}`, changes: [{ path: '/input/riskSignal', value: 'low' }] }];
      return plan;
    };
    const statuses: string[] = [];
    for (let index = 0; index < 520; index += 1) {
      const report = await analyzeDecisionSensitivity({ ...common, plan: makePlan(index) });
      statuses.push(report.status);
      if (report.status === 'rejected') expect(report.warnings.join(' ')).toContain('probe state capacity exhausted');
    }
    expect(statuses.filter(status => status === 'completed')).toHaveLength(512);
    expect(statuses.slice(512).every(status => status === 'rejected')).toBe(true);
    const repeatedFirst = await analyzeDecisionSensitivity({ ...common, plan: makePlan(0) });
    expect(repeatedFirst.status).toBe('rejected');
    expect(repeatedFirst.warnings.join(' ')).toContain('probe report limit');
    clock += windowMs;
    const nextWindow = await analyzeDecisionSensitivity({ ...common, plan: makePlan(600) });
    expect(nextWindow.status).toBe('completed');
  });

  it('CFX-PROBE-05 derives probe windows from the injected clock so a new plan windowId cannot reset the budget', async () => {
    const built = artifacts();
    const state = probeState();
    let clock = 1_000;
    const common = {
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => clock,
      probeState: state,
      reevaluate: async (request: { input: unknown; invocationId: string }) => resultWith(request.input, request.invocationId),
    };
    const makePlan = (id: string, windowId: string) => {
      const plan = pinnedPlan('triage-input-field');
      plan.id = id;
      plan.probeControl.windowId = windowId;
      plan.probeControl.maxReportsPerWindow = 1;
      plan.baselineStability.enabled = false;
      plan.baselineStability.repeats = 0;
      return plan;
    };
    expect((await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-window-one', 'w1') })).status).toBe('completed');
    const evaded = await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-window-two', 'w2') });
    expect(evaded.status).toBe('rejected');
    expect(evaded.warnings.join(' ')).toContain('probe report limit');
    expect(evaded.budget.backendCalls).toBe(0);
    clock += 3_600_000;
    expect((await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-window-three', 'w1') })).status).toBe('completed');
  });

  it('CFX-PROBE-06 scopes probe limits by tenant, workspace and project', async () => {
    const built = artifacts();
    const state = probeState();
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
    const makePlan = (id: string, tenantId: string, workspaceId = 'workspace-a', projectId = 'project-a') => {
      const plan = pinnedPlan('triage-input-field');
      plan.id = id;
      plan.tenantId = tenantId;
      plan.workspaceId = workspaceId;
      plan.projectId = projectId;
      plan.sourceSubject = { ...plan.sourceSubject, tenantId, workspaceId, projectId };
      plan.probeControl.maxReportsPerWindow = 1;
      plan.baselineStability.enabled = false;
      plan.baselineStability.repeats = 0;
      return plan;
    };
    expect((await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-tenant-t2', 't2') })).status).toBe('completed');
    expect((await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-tenant-t2-again', 't2') })).status).toBe('rejected');
    expect((await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-tenant-t3', 't3') })).status).toBe('completed');
    expect((await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-t2-workspace-b', 't2', 'workspace-b') })).status).toBe('completed');
    expect((await analyzeDecisionSensitivity({ ...common, plan: makePlan('triage-t2-project-b', 't2', 'workspace-a', 'project-b') })).status).toBe('completed');
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
    const disabledReport = await analyzeDecisionSensitivity({
      plan: disabledPlan,
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async sensitivityRequest => resultWith(sensitivityRequest.input, sensitivityRequest.invocationId),
    });
    expect(disabledReport.status).toBe('rejected');
    expect(disabledReport.budget.backendCalls).toBe(0);
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
      probeState: probeState(),
      reevaluate: async request => resultWith(request.input, request.invocationId),
    });
    expect(report.status).toBe('rejected');
    expect(report.rows).toEqual([]);
    expect(report.budget.backendCalls).toBe(0);
    expect(report.warnings.join(' ')).toContain('disabled');
  });

  it('CFX-DOC-EXAMPLES-01 runs the offline examples for threshold, loss-matrix, field perturbation and no-change controls', async () => {
    expect(readFileSync(resolve(ROOT, 'test/fixtures/decision/sensitivity/sensitivity-plan.v1.valid.json'), 'utf8')).toContain('triage-input-field');
    const built = artifacts();
    const replay = await analyzeDecisionSensitivity({
      plan: pinnedPlan('triage-threshold-replay'),
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceDefinitions: built.sourceDefinitions,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
    });
    const input = await analyzeDecisionSensitivity({
      plan: pinnedPlan('triage-input-field'),
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      now: () => 1_000,
      probeState: probeState(),
      reevaluate: async request => resultWith(request.input, request.invocationId),
    });
    expect(replay.rows.map(row => row.variantId)).toEqual(['threshold-tighten', 'loss-review']);
    expect(input.rows.map(row => row.variantId)).toContain('risk-high');
    expect(input.rows.map(row => row.variantId)).toContain('no-change');
  });
});
