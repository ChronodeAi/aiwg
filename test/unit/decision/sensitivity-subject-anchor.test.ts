import { describe, expect, it } from 'vitest';
import {
  analyzeDecisionSensitivity,
  artifactPin,
  DECISION_API_VERSION,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionResult,
  type DecisionRuleset,
  type RulesetResult,
  type SensitivityPlan,
  type SensitivityProbeState,
} from '../../../src/decision/index.js';
import { sensitivityRecords } from './sensitivity-fixtures.js';

const plans = sensitivityRecords<SensitivityPlan>('sensitivity-plan.v1.valid.json');

const PROBE_IDENTITY = { tenantId: 'tenant-a', workspaceId: 'workspace-a', projectId: 'project-a', principalId: 'reviewer-a' };

function probeState(): SensitivityProbeState {
  return { reportsByWindow: new Map(), pathCounts: new Map() };
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

function inputFieldPlan(id: string): SensitivityPlan {
  const plan = pinnedPlan('triage-input-field');
  plan.id = id;
  plan.probeControl.maxReportsPerWindow = 1;
  plan.baselineStability.enabled = false;
  plan.baselineStability.repeats = 0;
  return plan;
}

describe('sensitivity probe subjects anchored to host artifacts (#2796)', () => {
  it('cosmetic artifact renaming does not reset a subject budget', async () => {
    const built = artifacts();
    const state = probeState();
    const reevaluate = async (request: { input: unknown; invocationId: string }) => resultWith(request.input, request.invocationId);
    const common = {
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      probeIdentity: PROBE_IDENTITY,
      now: () => 1_000,
      probeState: state,
      reevaluate,
    };
    const first = await analyzeDecisionSensitivity({
      ...common,
      plan: inputFieldPlan('anchor-original'),
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
    });
    expect(first.status).toBe('completed');

    const renamedRuleset = structuredClone(built.ruleset);
    renamedRuleset.metadata = { id: 'triage-rules-renamed', version: '2.0.0', description: 'Renamed copy' };
    const renamedBinding = structuredClone(built.binding);
    renamedBinding.metadata = { id: 'triage-binding-renamed', version: '2.0.0', description: 'Renamed copy' };
    renamedBinding.spec.ruleset = artifactPin(renamedRuleset);
    const renamedPlan = inputFieldPlan('anchor-renamed');
    renamedPlan.source.ruleset = artifactPin(renamedRuleset);
    renamedPlan.source.binding = artifactPin(renamedBinding);

    const second = await analyzeDecisionSensitivity({
      ...common,
      plan: renamedPlan,
      sourceRuleset: renamedRuleset,
      sourceBinding: renamedBinding,
    });
    expect(second.status).toBe('rejected');
    expect(second.warnings.join(' ')).toContain('probe report limit');
  });

  it('a genuinely new host-authorized artifact receives a distinct subject', async () => {
    const built = artifacts();
    const state = probeState();
    const reevaluate = async (request: { input: unknown; invocationId: string }) => resultWith(request.input, request.invocationId);
    const common = {
      sourceInput: built.sourceInput,
      sourceResult: built.sourceResult,
      generatedAt: '2026-09-29T12:00:00.000Z',
      probeIdentity: PROBE_IDENTITY,
      now: () => 1_000,
      probeState: state,
      reevaluate,
    };
    const first = await analyzeDecisionSensitivity({
      ...common,
      plan: inputFieldPlan('anchor-genuine-original'),
      sourceRuleset: built.ruleset,
      sourceBinding: built.binding,
    });
    expect(first.status).toBe('completed');

    const revisedRuleset = structuredClone(built.ruleset);
    revisedRuleset.metadata.version = '1.0.1';
    revisedRuleset.spec.rules[0]!.outcome = { route: 'review', label: 'needs-review' };
    const revisedBinding = structuredClone(built.binding);
    revisedBinding.spec.ruleset = artifactPin(revisedRuleset);
    const revisedPlan = inputFieldPlan('anchor-genuine-revised');
    revisedPlan.source.ruleset = artifactPin(revisedRuleset);
    revisedPlan.source.binding = artifactPin(revisedBinding);

    const second = await analyzeDecisionSensitivity({
      ...common,
      plan: revisedPlan,
      sourceRuleset: revisedRuleset,
      sourceBinding: revisedBinding,
    });
    expect(second.status).toBe('completed');
  });

  it('per-principal quota still applies to canonical subjects on host-supplied state', async () => {
    const built = artifacts();
    const state = probeState();
    const statuses: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const plan = pinnedPlan('triage-threshold-replay');
      plan.id = `anchor-quota-${index}`;
      plan.probeControl.maxReportsPerWindow = 100;
      plan.probeControl.maxPerPrincipalSubjectPath = 100;
      plan.variants = [{
        id: 'threshold-tighten',
        changes: [{ path: '/binding/spec/evaluations/risk/targets/0/acceptance/minimumBps', value: 9000 }],
      }];
      const report = await analyzeDecisionSensitivity({
        plan,
        sourceRuleset: built.ruleset,
        sourceBinding: built.binding,
        sourceDefinitions: built.sourceDefinitions,
        sourceInput: { riskSignal: `quota-${index}` },
        sourceResult: built.sourceResult,
        generatedAt: '2026-09-29T12:00:00.000Z',
        probeIdentity: PROBE_IDENTITY,
        now: () => 1_000,
        probeState: state,
      });
      statuses.push(report.status);
      if (report.status === 'rejected') expect(report.warnings.join(' ')).toContain('probe principal quota exhausted');
    }
    expect(statuses.filter(status => status === 'completed')).toHaveLength(64);
  });
});
