import { applyPrimitiveAcceptance } from '../acceptance.js';
import { composeRuleset } from '../compose.js';
import { artifactDigest, artifactPin, assertArtifactPin, validateBinding, validateRuleset } from '../validate.js';
import type {
  AdapterObservation,
  ArtifactPin,
  DecisionBinding,
  DecisionResult,
  DecisionRuleset,
  ExecutionTarget,
  JsonValue,
  RulesetResult,
} from '../types.js';
import { sensitivityDigest, validateSensitivityPlan, validateSensitivityReport, SensitivityContractError } from './contract.js';
import type {
  SensitivityChange,
  SensitivityDigest,
  SensitivityPlan,
  SensitivityRedactedChange,
  SensitivityReport,
  SensitivityReportRow,
  SensitivityRuntimeRequest,
} from './types.js';

export async function analyzeDecisionSensitivity(request: SensitivityRuntimeRequest): Promise<SensitivityReport> {
  let plan: SensitivityPlan;
  try {
    plan = validateSensitivityPlan(request.plan);
    validateInputs(plan, request);
    enforceProbeLimits(plan, request.probeState);
  } catch (error) {
    if (error instanceof SensitivityContractError) return rejectedReport(request, error.details.length ? [...error.details] : [error.message]);
    throw error;
  }
  if (plan.mode === 'disabled') return rejectedReport(request, ['sensitivity plan is disabled']);
  const rows: SensitivityReportRow[] = [];
  const warnings = ['not-causal-explanation', 'not-correctness-proof', 'not-action-authority'];
  const budget = { maxVariants: plan.budgets.maxVariants, processedVariants: 0, backendCalls: 0, tokens: 0, costMicros: 0, exhausted: false };
  const deadline = (request.now?.() ?? Date.now()) + plan.budgets.deadlineMs;

  if (plan.analysisKind === 'input-reevaluation' && plan.baselineStability.enabled) {
    if (!request.reevaluate) return rejectedReport(request, ['input reevaluation requires a host-supplied evaluator']);
    for (let repeat = 0; repeat < plan.baselineStability.repeats; repeat += 1) {
      if (!canSpendCall(plan, budget, deadline, request.now?.() ?? Date.now())) { budget.exhausted = true; break; }
      const invocationId = freshInvocationId(plan, `baseline-${repeat + 1}`);
      const result = await request.reevaluate({ variantId: `baseline-${repeat + 1}`, invocationId,
        input: structuredClone(request.sourceInput), changes: [] });
      rows.push(rowForResult({ plan, source: request.sourceResult, result, variantId: `baseline-${repeat + 1}`,
        kind: 'baseline-stability', inference: 'new-invocation', changes: [], invocationId }));
      spendResult(budget, result);
    }
  }

  for (const variant of plan.variants) {
    if (rows.filter(row => row.kind === 'variant' || row.kind === 'unchanged-control').length >= plan.budgets.maxVariants) {
      budget.exhausted = true; break;
    }
    if ((request.now?.() ?? Date.now()) >= deadline) { budget.exhausted = true; break; }
    const noChange = isNoChange(plan.analysisKind === 'policy-replay'
      ? { ruleset: request.sourceRuleset, binding: request.sourceBinding } : { input: request.sourceInput }, variant.changes);
    if (noChange && plan.unchangedVariant === 'deduplicate') {
      rows.push(rowForResult({ plan, source: request.sourceResult, result: request.sourceResult, variantId: variant.id,
        kind: 'unchanged-control', inference: 'deduplicated-control', changes: variant.changes, invocationId: null }));
      budget.processedVariants += 1;
      continue;
    }
    if (plan.analysisKind === 'policy-replay') {
      const { ruleset, binding } = replayArtifacts(request.sourceRuleset, request.sourceBinding, variant.changes);
      const result = replayPolicy(request.sourceResult, ruleset, binding, request.sourceInput, variant.id);
      rows.push(rowForResult({ plan, source: request.sourceResult, result, variantId: variant.id,
        kind: noChange ? 'unchanged-control' : 'variant', inference: 'reused-stored-evidence', changes: variant.changes, invocationId: null }));
      budget.processedVariants += 1;
      continue;
    }
    if (!request.reevaluate) return rejectedReport(request, ['input reevaluation requires a host-supplied evaluator']);
    if (!canSpendCall(plan, budget, deadline, request.now?.() ?? Date.now())) { budget.exhausted = true; break; }
    const input = applyChanges({ input: structuredClone(request.sourceInput) }, variant.changes).input;
    const invocationId = freshInvocationId(plan, variant.id);
    const result = await request.reevaluate({ variantId: variant.id, invocationId, input, changes: structuredClone(variant.changes) });
    if (result.spec.invocationId === request.sourceResult.spec.invocationId) {
      return rejectedReport(request, [`variant ${variant.id} reused the source invocation ID`]);
    }
    if (Object.values(result.spec.evaluations).some(evaluation => evaluation.spec.attempts.length === 0)) {
      return rejectedReport(request, [`variant ${variant.id} did not return complete attempt lineage`]);
    }
    rows.push(rowForResult({ plan, source: request.sourceResult, result, variantId: variant.id,
      kind: noChange ? 'unchanged-control' : 'variant', inference: 'new-invocation', changes: variant.changes, invocationId }));
    spendResult(budget, result);
    budget.processedVariants += 1;
  }

  const report = buildReport(request, plan, rows, budget, warnings);
  validateSensitivityReport(report);
  return report;
}

function validateInputs(plan: SensitivityPlan, request: SensitivityRuntimeRequest): void {
  assertArtifactPin(request.sourceRuleset, plan.source.ruleset, 'sensitivity source ruleset');
  assertArtifactPin(request.sourceBinding, plan.source.binding, 'sensitivity source binding');
  assertArtifactPin(request.sourceResult, plan.source.result, 'sensitivity source result');
  validateRuleset(request.sourceRuleset);
  validateBinding(request.sourceBinding, request.sourceRuleset);
  if (request.sourceResult.spec.invocationId.length === 0) throw new SensitivityContractError('source result must have an invocation ID');
}

function enforceProbeLimits(plan: SensitivityPlan, state?: SensitivityRuntimeRequest['probeState']): void {
  if (!state) return;
  const reportKey = `${plan.probeControl.windowId}:${plan.actor.principalId}:${plan.sourceSubject.subjectRef}`;
  const reports = state.reportsByWindow?.get(reportKey) ?? 0;
  if (reports >= plan.probeControl.maxReportsPerWindow) throw new SensitivityContractError('sensitivity probe report limit exceeded', 'semantic', ['probe report limit exceeded']);
  state.reportsByWindow?.set(reportKey, reports + 1);
  for (const path of plan.allowedPaths) {
    const key = `${reportKey}:${path}`;
    const count = state.pathCounts?.get(key) ?? 0;
    if (count + plan.variants.length > plan.probeControl.maxPerPrincipalSubjectPath) {
      throw new SensitivityContractError('sensitivity path probe limit exceeded', 'semantic', [`probe path limit exceeded: ${path}`]);
    }
    state.pathCounts?.set(key, count + plan.variants.length);
  }
}

function replayArtifacts(sourceRuleset: DecisionRuleset, sourceBinding: DecisionBinding, changes: readonly SensitivityChange[]): {
  ruleset: DecisionRuleset; binding: DecisionBinding;
} {
  const artifacts = { ruleset: structuredClone(sourceRuleset), binding: structuredClone(sourceBinding) };
  applyChanges(artifacts, changes);
  validateRuleset(artifacts.ruleset);
  if (artifactDigest(artifacts.ruleset) !== artifacts.binding.spec.ruleset.digest) {
    artifacts.binding.spec.ruleset = artifactPin(artifacts.ruleset);
  }
  validateBinding(artifacts.binding, artifacts.ruleset);
  return artifacts;
}

function replayPolicy(
  source: RulesetResult,
  ruleset: DecisionRuleset,
  binding: DecisionBinding,
  input: unknown,
  variantId: string,
): RulesetResult {
  const evaluations = Object.fromEntries(Object.entries(source.spec.evaluations).map(([alias, result]) => {
    const target = binding.spec.evaluations[alias]?.targets[0];
    return [alias, target ? replayAcceptance(result, target) : structuredClone(result)];
  }));
  const composition = composeRuleset(ruleset, input, evaluations);
  const rulesetPin = artifactPin(ruleset);
  const bindingPin = artifactPin(binding);
  return {
    ...source,
    metadata: { id: `${source.metadata.id}-${variantId}`, version: source.metadata.version, description: source.metadata.description },
    spec: {
      ...source.spec,
      ruleset: rulesetPin,
      binding: bindingPin,
      status: composition.status,
      reason: composition.reason,
      ...(composition.outcome !== undefined ? { outcome: composition.outcome } : {}),
      matchedRules: composition.matchedRules,
      evaluations,
    },
  };
}

function replayAcceptance(result: DecisionResult, target: ExecutionTarget): DecisionResult {
  const observation: AdapterObservation = {
    status: result.spec.status,
    reason: result.spec.reason,
    ...(result.spec.value !== undefined ? { value: result.spec.value } : {}),
    uncertainty: structuredClone(result.spec.uncertainty),
    acceptance: result.spec.acceptance ? structuredClone(result.spec.acceptance) : undefined,
    actualModel: result.spec.attempts.at(-1)?.actualModel ?? null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
    requestId: null,
  };
  let replayed = observation;
  if (target.acceptance.mode === 'primitive-policy') {
    replayed = applyPrimitiveAcceptance({
      apiVersion: result.apiVersion,
      kind: 'DecisionDefinition',
      metadata: { id: result.spec.decision.id, version: result.spec.decision.version, description: result.spec.alias },
      spec: { purpose: 'sensitivity replay placeholder', inputSchema: {}, question: 'sensitivity replay', answer: inferAnswer(result), requiredCapabilities: [] },
    }, target.acceptance, observation);
  } else if (target.acceptance.mode === 'confidence-threshold') {
    replayed = applyLegacyThreshold(observation, target);
  }
  return {
    ...result,
    spec: {
      ...result.spec,
      status: replayed.status,
      reason: replayed.reason,
      ...(replayed.status === 'success' && replayed.value !== undefined ? { value: replayed.value } : {}),
      uncertainty: replayed.uncertainty,
      ...(replayed.acceptance ? { acceptance: replayed.acceptance } : {}),
    },
  };
}

function inferAnswer(result: DecisionResult): any {
  if (typeof result.spec.value === 'string') {
    const keys = result.spec.uncertainty?.distribution ? Object.keys(result.spec.uncertainty.distribution) : [result.spec.value, 'other'];
    return { kind: 'choice', options: [...new Set(keys)].map(id => ({ id, description: id })) };
  }
  if (result.spec.uncertainty?.distribution && Object.keys(result.spec.uncertainty.distribution).some(key => key !== 'true' && key !== 'false')) {
    return { kind: 'ordinal-score', levels: Object.keys(result.spec.uncertainty.distribution).map(key => key) };
  }
  return { kind: 'truth-probability', trueDescription: 'true', falseDescription: 'false' };
}

function applyLegacyThreshold(observation: AdapterObservation, target: ExecutionTarget): AdapterObservation {
  if (observation.status !== 'success' || target.acceptance.mode !== 'confidence-threshold') return observation;
  if (!observation.uncertainty?.profile || observation.uncertainty.profile !== target.acceptance.profile) {
    return { ...observation, status: 'abstained', reason: 'confidence-profile-mismatch' };
  }
  if (observation.uncertainty.confidence === null) return { ...observation, status: 'abstained', reason: 'missing-confidence' };
  return observation.uncertainty.confidence * 10_000 < target.acceptance.minimumBps
    ? { ...observation, status: 'abstained', reason: 'low-confidence' } : observation;
}

function applyChanges<T>(target: T, changes: readonly SensitivityChange[]): T {
  for (const change of changes) setPointer(target, change.path, structuredClone(change.value));
  return target;
}

function setPointer(root: unknown, pointer: string, value: JsonValue): void {
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!parts.length) throw new SensitivityContractError('root replacement is not supported');
  let current: any = root;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts[parts.length - 1]!] = value;
}

function isNoChange(root: unknown, changes: readonly SensitivityChange[]): boolean {
  const before = sensitivityDigest(root);
  const copy = structuredClone(root);
  const normalized = changes.map(change => ({ path: change.path, value: change.value }));
  applyChanges(copy, normalized);
  return sensitivityDigest(copy) === before;
}

function rowForResult(input: {
  plan: SensitivityPlan;
  source: RulesetResult;
  result: RulesetResult;
  variantId: string;
  kind: SensitivityReportRow['kind'];
  inference: SensitivityReportRow['inference'];
  changes: readonly SensitivityChange[];
  invocationId: string | null;
}): SensitivityReportRow {
  const sourceReceipt = artifactPin(input.source);
  const resultDigest = sensitivityDigest(input.result);
  return {
    variantId: input.variantId,
    kind: input.kind,
    changes: input.changes.map(change => redactChange(input.plan, change)),
    inference: input.inference,
    sourceReceipt,
    counterfactualReceipt: input.inference === 'new-invocation' ? artifactPin(input.result) : null,
    resultDigest,
    freshInvocationId: input.invocationId,
    deltas: deltas(input.source, input.result),
    resourceUse: usage(input.source, input.result, input.inference),
    warnings: warningForResult(input.source, input.result),
  };
}

function redactChange(plan: SensitivityPlan, change: SensitivityChange): SensitivityRedactedChange {
  return {
    path: change.path,
    valueDigest: sensitivityDigest(change.value),
    sensitivity: plan.pathDomains.find(domain => domain.path === change.path)?.sensitivity ?? 'restricted',
  };
}

function deltas(source: RulesetResult, result: RulesetResult): SensitivityReportRow['deltas'] {
  const sourceRules = source.spec.matchedRules;
  const resultRules = result.spec.matchedRules;
  return {
    outcomeChanged: sensitivityDigest(source.spec.outcome ?? null) !== sensitivityDigest(result.spec.outcome ?? null),
    acceptanceChanged: acceptanceDigest(source) !== acceptanceDigest(result),
    ruleChanged: sensitivityDigest(sourceRules) !== sensitivityDigest(resultRules),
    firstChangedRule: firstChanged(sourceRules, resultRules),
    distributionDistanceBps: distributionDistanceBps(source, result),
    status: result.spec.status,
    reason: result.spec.reason,
  };
}

function acceptanceDigest(result: RulesetResult): SensitivityDigest {
  return sensitivityDigest(Object.fromEntries(Object.entries(result.spec.evaluations)
    .map(([alias, evaluation]) => [alias, {
      status: evaluation.spec.status,
      reason: evaluation.spec.reason,
      acceptance: evaluation.spec.acceptance ?? null,
    }])));
}

function firstChanged(left: readonly string[], right: readonly string[]): string | null {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return right[index] ?? left[index] ?? null;
  return null;
}

function distributionDistanceBps(source: RulesetResult, result: RulesetResult): number | null {
  const distances = Object.entries(source.spec.evaluations).map(([alias, left]) => {
    const right = result.spec.evaluations[alias];
    const a = left.spec.uncertainty?.distribution;
    const b = right?.spec.uncertainty?.distribution;
    if (!a || !b) return null;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const total = [...keys].reduce((sum, key) => sum + Math.abs((a[key] ?? 0) - (b[key] ?? 0)), 0) / 2;
    return Math.round(total * 10_000);
  }).filter((value): value is number => value !== null);
  return distances.length ? Math.max(...distances) : null;
}

function usage(source: RulesetResult, result: RulesetResult, inference: SensitivityReportRow['inference']): SensitivityReportRow['resourceUse'] {
  if (inference !== 'new-invocation') return { backendCalls: 0, tokens: 0, costMicros: 0 };
  const attempts = Object.values(result.spec.evaluations).flatMap(evaluation => evaluation.spec.attempts);
  const sourceAttempts = new Set(Object.values(source.spec.evaluations).flatMap(evaluation => evaluation.spec.attempts)
    .map(attempt => `${attempt.ordinal}:${attempt.adapter}:${attempt.requestedModel}`));
  const newAttempts = attempts.filter(attempt => !sourceAttempts.has(`${attempt.ordinal}:${attempt.adapter}:${attempt.requestedModel}`));
  return {
    backendCalls: newAttempts.length,
    tokens: newAttempts.reduce((sum, attempt) => sum + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0), 0),
    costMicros: Math.round(newAttempts.reduce((sum, attempt) => sum + (attempt.usage.costUsd ?? 0), 0) * 1_000_000),
  };
}

function spendResult(budget: SensitivityReport['budget'], result: RulesetResult): void {
  const attempts = Object.values(result.spec.evaluations).flatMap(evaluation => evaluation.spec.attempts);
  budget.backendCalls += attempts.length;
  budget.tokens += attempts.reduce((sum, attempt) => sum + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0), 0);
  budget.costMicros += Math.round(attempts.reduce((sum, attempt) => sum + (attempt.usage.costUsd ?? 0), 0) * 1_000_000);
}

function canSpendCall(plan: SensitivityPlan, budget: SensitivityReport['budget'], deadline: number, now: number): boolean {
  return now < deadline && budget.backendCalls < plan.budgets.maxBackendCalls
    && budget.tokens <= plan.budgets.maxTokens && budget.costMicros <= plan.budgets.maxCostMicros;
}

function warningForResult(source: RulesetResult, result: RulesetResult): string[] {
  const warnings: string[] = [];
  if (result.spec.status !== source.spec.status) warnings.push('status-changed');
  if (result.spec.reason !== source.spec.reason) warnings.push('reason-changed');
  return warnings;
}

function buildReport(
  request: SensitivityRuntimeRequest,
  plan: SensitivityPlan,
  rows: SensitivityReportRow[],
  budget: SensitivityReport['budget'],
  warnings: string[],
): SensitivityReport {
  const minimum = minimumThresholdChange(plan);
  const status = budget.exhausted ? rows.length ? 'partial' : 'budget-exhausted' : 'completed';
  const withoutDigest: Omit<SensitivityReport, 'digest'> = {
    schemaVersion: 'decision-sensitivity-report/v1',
    id: `${plan.id}-report`,
    plan: { id: plan.id, version: plan.version, digest: sensitivityDigest(plan) },
    tenantId: plan.tenantId,
    workspaceId: plan.workspaceId,
    projectId: plan.projectId,
    sourceSubject: structuredClone(plan.sourceSubject),
    analysisKind: plan.analysisKind,
    semantics: 'associative-sensitivity-not-causal',
    actionAuthorization: 'not-authorized',
    status,
    generatedAt: request.generatedAt,
    privacy: { redaction: plan.privacy.redaction, summaryPrecisionBps: plan.privacy.summaryPrecisionBps },
    retention: structuredClone(plan.retention),
    budget,
    baseline: {
      resultRef: artifactPin(request.sourceResult),
      outcomeDigest: sensitivityDigest(request.sourceResult.spec.outcome ?? null),
      status: request.sourceResult.spec.status,
      reason: request.sourceResult.spec.reason,
    },
    rows,
    summary: {
      totalRows: rows.length,
      changedOutcomes: rows.filter(row => row.deltas.outcomeChanged).length,
      changedAcceptance: rows.filter(row => row.deltas.acceptanceChanged).length,
      changedRules: rows.filter(row => row.deltas.ruleChanged).length,
      minimumThresholdChangeBps: minimum,
    },
    warnings,
  };
  return { ...withoutDigest, digest: sensitivityDigest(withoutDigest) };
}

function minimumThresholdChange(plan: SensitivityPlan): number | null {
  const values = plan.variants.flatMap(variant => variant.changes.map(change => change.value))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length < 2 || plan.privacy.differencing === 'deny') return null;
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const distances = sorted.slice(1).map((value, index) => value - sorted[index]!);
  const raw = Math.min(...distances);
  return Math.ceil(raw / plan.privacy.summaryPrecisionBps) * plan.privacy.summaryPrecisionBps;
}

function freshInvocationId(plan: SensitivityPlan, variantId: string): string {
  return `sens-${plan.id}-${variantId}`;
}

function rejectedReport(request: SensitivityRuntimeRequest, reasons: string[]): SensitivityReport {
  const plan = request.plan;
  const budget = { maxVariants: plan.budgets.maxVariants, processedVariants: 0, backendCalls: 0, tokens: 0, costMicros: 0, exhausted: false };
  const withoutDigest: Omit<SensitivityReport, 'digest'> = {
    schemaVersion: 'decision-sensitivity-report/v1',
    id: `${plan.id}-report`,
    plan: { id: plan.id, version: plan.version, digest: sensitivityDigest(plan) },
    tenantId: plan.tenantId,
    workspaceId: plan.workspaceId,
    projectId: plan.projectId,
    sourceSubject: structuredClone(plan.sourceSubject),
    analysisKind: plan.analysisKind,
    semantics: 'associative-sensitivity-not-causal',
    actionAuthorization: 'not-authorized',
    status: 'rejected',
    generatedAt: request.generatedAt,
    privacy: { redaction: plan.privacy.redaction, summaryPrecisionBps: plan.privacy.summaryPrecisionBps },
    retention: structuredClone(plan.retention),
    budget,
    baseline: {
      resultRef: safePin(request.sourceResult),
      outcomeDigest: sensitivityDigest(request.sourceResult?.spec?.outcome ?? null),
      status: request.sourceResult?.spec?.status ?? 'error',
      reason: request.sourceResult?.spec?.reason ?? 'invalid-definition',
    },
    rows: [],
    summary: { totalRows: 0, changedOutcomes: 0, changedAcceptance: 0, changedRules: 0, minimumThresholdChangeBps: null },
    warnings: ['rejected-before-inference', ...reasons.map(reason => reason.replace(/[^\w .:/-]/g, ''))],
  };
  return { ...withoutDigest, digest: sensitivityDigest(withoutDigest) };
}

function safePin(value: unknown): ArtifactPin {
  try { return artifactPin(value as RulesetResult); }
  catch { return { id: 'invalid', version: '0.0.0', digest: `sha256:${'0'.repeat(64)}` }; }
}
