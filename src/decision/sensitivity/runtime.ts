import { randomUUID } from 'node:crypto';
import { applyTargetAcceptance } from '../acceptance.js';
import { composeRuleset } from '../compose.js';
import { decisionInvocationFingerprint } from '../receipts.js';
import { artifactDigest, artifactPin, assertArtifactPin, validateAgainstSchema, validateBinding, validateRuleset } from '../validate.js';
import type {
  AdapterObservation,
  ArtifactPin,
  DecisionBinding,
  DecisionAnswer,
  DecisionDefinition,
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
  SensitivityProbeIdentity,
  SensitivityProbeState,
  SensitivityRuntimeRequest,
} from './types.js';

export async function analyzeDecisionSensitivity(request: SensitivityRuntimeRequest): Promise<SensitivityReport> {
  let plan: SensitivityPlan;
  const runNonce = randomUUID();
  const warnings = ['not-causal-explanation', 'not-correctness-proof', 'not-action-authority'];
  try {
    plan = validateSensitivityPlan(request.plan);
    validateInputs(plan, request, request.now?.() ?? Date.now());
    validateChangeTargets(plan, request);
  } catch (error) {
    if (error instanceof SensitivityContractError) return rejectedReport(request, error.details.length ? [...error.details] : [error.message]);
    throw error;
  }
  if (plan.mode === 'disabled') return rejectedReport(request, ['sensitivity plan is disabled']);
  // Every pre-inference rejection happens before the probe budget is charged: a rejected plan
  // performs no inference and discloses no boundary, so it does not consume the budget.
  if (plan.analysisKind === 'input-reevaluation' && !request.reevaluate && requiresEvaluator(plan, request)) {
    return rejectedReport(request, ['input reevaluation requires a host-supplied evaluator']);
  }
  try {
    enforceProbeLimits(plan, request.probeState ?? defaultProbeState, probeRoot(plan, request), request.now?.() ?? Date.now(),
      request.probeIdentity, probeSubjectDigest(request));
  } catch (error) {
    if (error instanceof SensitivityContractError) return rejectedReport(request, error.details.length ? [...error.details] : [error.message]);
    throw error;
  }
  const rows: SensitivityReportRow[] = [];
  const budget = { maxVariants: plan.budgets.maxVariants, processedVariants: 0, backendCalls: 0, tokens: 0, costMicros: 0, exhausted: false };
  const deadline = (request.now?.() ?? Date.now()) + plan.budgets.deadlineMs;
  const usedInvocations = new Set([request.sourceResult.spec.invocationId]);

  if (plan.analysisKind === 'input-reevaluation' && plan.baselineStability.enabled) {
    if (!request.reevaluate) return rejectedReport(request, ['input reevaluation requires a host-supplied evaluator']);
    for (let repeat = 0; repeat < plan.baselineStability.repeats; repeat += 1) {
      if (!canSpendCall(plan, request.sourceBinding, request.sourceResult, budget, deadline, request.now?.() ?? Date.now())) { budget.exhausted = true; break; }
      const variantId = `baseline-${repeat + 1}`;
      const input = structuredClone(request.sourceInput);
      const invocationId = freshInvocationId(plan, variantId, runNonce);
      const receiptFingerprint = expectedReceiptFingerprint(request, invocationId, input);
      try {
        ensureFreshBeforeDispatch(invocationId, receiptFingerprint, usedInvocations);
      } catch (error) {
        if (error instanceof SensitivityContractError) return failedPartialReport(request, plan, rows, budget, warnings, error.message);
        throw error;
      }
      let result: RulesetResult;
      try {
        result = await request.reevaluate({ variantId, invocationId, receiptFingerprint, input, changes: [] });
      } catch (error) {
        if (!spendFailure(budget, error)) spendUnknownReserve(budget, warnings, request.sourceBinding, request.sourceResult);
        return failedPartialReport(request, plan, rows, budget, warnings, `baseline ${variantId} failed: ${sanitizeReason(error)}`);
      }
      if (!isRulesetResultShape(result)) {
        chargeUnusableResult(budget, warnings, request, result);
        return failedPartialReport(request, plan, rows, budget, warnings, `baseline ${variantId} returned a malformed result`);
      }
      try {
        const failure = validateReevaluationResult(request, result, variantId, invocationId, receiptFingerprint, input);
        if (failure) {
          spendResult(budget, result);
          return failedPartialReport(request, plan, rows, budget, warnings, failure);
        }
        rows.push(rowForResult({ plan, source: request.sourceResult, result, variantId: `baseline-${repeat + 1}`,
          kind: 'baseline-stability', inference: 'new-invocation', changes: [], invocationId }));
      } catch {
        chargeUnusableResult(budget, warnings, request, result);
        return failedPartialReport(request, plan, rows, budget, warnings, `baseline ${variantId} returned an unusable result`);
      }
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
    if (noChange) {
      rows.push(rowForResult({ plan, source: request.sourceResult, result: request.sourceResult, variantId: variant.id,
        kind: 'unchanged-control', inference: 'deduplicated-control', changes: variant.changes, invocationId: null }));
      budget.processedVariants += 1;
      continue;
    }
    if (plan.analysisKind === 'policy-replay') {
      const { ruleset, binding } = replayArtifacts(request.sourceRuleset, request.sourceBinding, variant.changes);
      const replay = replayPolicy(request.sourceResult, request.sourceBinding, ruleset, binding, request.sourceDefinitions ?? {}, request.sourceInput, variant.id);
      if (replay.unreplayable || dependsOnUnobservedOutcome(variant.changes, request.sourceBinding, request.sourceResult)) {
        // The row would depend on a target outcome that was never observed; it makes no sensitivity claim.
        rows.push(rowForResult({ plan, source: request.sourceResult, result: request.sourceResult, variantId: variant.id,
          kind: 'variant', inference: 'unreplayable', changes: variant.changes, invocationId: null,
          extraWarnings: ['unreplayable-unobserved-outcome'] }));
        if (!warnings.includes('unreplayable-rows-present')) warnings.push('unreplayable-rows-present');
      } else {
        rows.push(rowForResult({ plan, source: request.sourceResult, result: replay.result, variantId: variant.id,
          kind: 'variant', inference: 'reused-stored-evidence', changes: variant.changes, invocationId: null }));
      }
      budget.processedVariants += 1;
      continue;
    }
    if (!request.reevaluate) return rejectedReport(request, ['input reevaluation requires a host-supplied evaluator']);
    if (!canSpendCall(plan, request.sourceBinding, request.sourceResult, budget, deadline, request.now?.() ?? Date.now())) { budget.exhausted = true; break; }
    const input = applyChanges({ input: structuredClone(request.sourceInput) }, variant.changes).input;
    const invocationId = freshInvocationId(plan, variant.id, runNonce);
    const receiptFingerprint = expectedReceiptFingerprint(request, invocationId, input);
    try {
      ensureFreshBeforeDispatch(invocationId, receiptFingerprint, usedInvocations);
    } catch (error) {
      if (error instanceof SensitivityContractError) return failedPartialReport(request, plan, rows, budget, warnings, error.message);
      throw error;
    }
    let result: RulesetResult;
    try {
      result = await request.reevaluate({ variantId: variant.id, invocationId, receiptFingerprint, input, changes: structuredClone(variant.changes) });
    } catch (error) {
      if (!spendFailure(budget, error)) spendUnknownReserve(budget, warnings, request.sourceBinding, request.sourceResult);
      return failedPartialReport(request, plan, rows, budget, warnings, `variant ${variant.id} failed: ${sanitizeReason(error)}`);
    }
    if (!isRulesetResultShape(result)) {
      chargeUnusableResult(budget, warnings, request, result);
      return failedPartialReport(request, plan, rows, budget, warnings, `variant ${variant.id} returned a malformed result`);
    }
    try {
      const failure = validateReevaluationResult(request, result, variant.id, invocationId, receiptFingerprint, input);
      if (failure) {
        spendResult(budget, result);
        return failedPartialReport(request, plan, rows, budget, warnings, failure);
      }
      rows.push(rowForResult({ plan, source: request.sourceResult, result, variantId: variant.id,
        kind: noChange ? 'unchanged-control' : 'variant', inference: 'new-invocation', changes: variant.changes, invocationId }));
    } catch {
      // For example a cyclic or non-serializable result: fail the run, never throw into the caller.
      chargeUnusableResult(budget, warnings, request, result);
      return failedPartialReport(request, plan, rows, budget, warnings, `variant ${variant.id} returned an unusable result`);
    }
    spendResult(budget, result);
    budget.processedVariants += 1;
  }

  const report = buildReport(request, plan, rows, budget, warnings);
  validateSensitivityReport(report);
  return report;
}

// The implicit state is a process-local safety net, not durable storage. When it is full it fails
// closed instead of evicting live limit state; only counters from windows before the current one
// are evicted. Production hosts must supply durable, non-resettable probe state.
const DEFAULT_PROBE_STATE_MAX_ENTRIES = 512;
const DEFAULT_PROBE_STATE_MAX_ENTRIES_PER_PRINCIPAL = 64;
const DEFAULT_PROBE_WINDOW_MS = 3_600_000;
const defaultProbeState: Required<Pick<SensitivityProbeState, 'reportsByWindow' | 'pathCounts'>> = {
  reportsByWindow: new Map(), pathCounts: new Map(),
};

function probeRoot(plan: SensitivityPlan, request: SensitivityRuntimeRequest): unknown {
  return plan.analysisKind === 'policy-replay'
    ? { ruleset: request.sourceRuleset, binding: request.sourceBinding } : { input: request.sourceInput };
}

function validateInputs(plan: SensitivityPlan, request: SensitivityRuntimeRequest, now: number): void {
  assertArtifactPin(request.sourceRuleset, plan.source.ruleset, 'sensitivity source ruleset');
  assertArtifactPin(request.sourceBinding, plan.source.binding, 'sensitivity source binding');
  assertArtifactPin(request.sourceResult, plan.source.result, 'sensitivity source result');
  validateRuleset(request.sourceRuleset);
  validateBinding(request.sourceBinding, request.sourceRuleset);
  if (request.sourceResult.spec.invocationId.length === 0) throw new SensitivityContractError('source result must have an invocation ID');
  if (Date.parse(plan.authorization.expiresAt) <= now) {
    throw new SensitivityContractError('sensitivity authorization is expired', 'semantic', ['authorization expired']);
  }
  try {
    validateAgainstSchema(request.sourceRuleset.spec.inputSchema, request.sourceInput, 'sensitivity source input');
  } catch {
    throw new SensitivityContractError('sensitivity source input does not match the ruleset input schema', 'semantic',
      ['source input does not match the ruleset input schema']);
  }
  const identity = request.probeIdentity as Partial<SensitivityProbeIdentity> | undefined;
  const fields = ['tenantId', 'workspaceId', 'projectId', 'principalId'] as const;
  if (!identity || typeof identity !== 'object' || fields.some(field => typeof identity[field] !== 'string' || identity[field]!.length === 0)) {
    throw new SensitivityContractError('sensitivity probe identity is missing', 'semantic', ['probe identity is missing; the host must supply it']);
  }
  if (identity.tenantId !== plan.tenantId || identity.workspaceId !== plan.workspaceId || identity.projectId !== plan.projectId
    || identity.principalId !== plan.actor.principalId) {
    throw new SensitivityContractError('sensitivity probe identity does not match the plan', 'semantic', ['probe identity does not match the plan']);
  }
}

// The probed subject is the decision input under a named ruleset and binding. The caller-supplied
// result artifact is not part of the key: re-pinning a cosmetically different result must not mint a
// new budget for re-evaluating the same input.
function probeSubjectDigest(request: SensitivityRuntimeRequest): string {
  return sensitivityDigest({
    input: request.sourceInput as JsonValue,
    ruleset: request.sourceRuleset.metadata.id,
    binding: request.sourceBinding.metadata.id,
  });
}

function requiresEvaluator(plan: SensitivityPlan, request: SensitivityRuntimeRequest): boolean {
  return plan.baselineStability.enabled || plan.variants.some(variant => !isNoChange({ input: request.sourceInput }, variant.changes));
}

function validateChangeTargets(plan: SensitivityPlan, request: SensitivityRuntimeRequest): void {
  const root = plan.analysisKind === 'policy-replay'
    ? { ruleset: request.sourceRuleset, binding: request.sourceBinding } : { input: request.sourceInput };
  for (const variant of plan.variants) for (const change of variant.changes) assertPointerTarget(root, change.path);
}

function enforceProbeLimits(
  plan: SensitivityPlan,
  state: SensitivityRuntimeRequest['probeState'],
  root: unknown,
  now: number,
  identity: SensitivityProbeIdentity,
  subjectDigest: string,
): void {
  const reportsByWindow = state?.reportsByWindow ?? new Map<string, number>();
  const pathCounts = state?.pathCounts ?? new Map<string, number>();
  if (state && !state.reportsByWindow) state.reportsByWindow = reportsByWindow;
  if (state && !state.pathCounts) state.pathCounts = pathCounts;
  // The window comes from the host clock and host-owned duration. plan.probeControl.windowId is a
  // descriptive label only: the plan author cannot pick a fresh window to reset the budget.
  const windowMs = state?.windowMs ?? DEFAULT_PROBE_WINDOW_MS;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isFinite(now)) {
    throw new SensitivityContractError('sensitivity probe window is invalid', 'semantic', ['probe window is invalid']);
  }
  const window = Math.floor(now / windowMs);
  // Counters are keyed on the host-authenticated identity and the pinned source result, never on
  // plan-authored tenant, principal or subjectRef fields, so rotating those cannot mint a budget.
  const principal = [identity.tenantId, identity.workspaceId, identity.projectId, identity.principalId];
  const reportKey = JSON.stringify([window, ...principal, subjectDigest]);
  const reports = reportsByWindow.get(reportKey) ?? 0;
  if (reports >= plan.probeControl.maxReportsPerWindow) throw new SensitivityContractError('sensitivity probe report limit exceeded', 'semantic', ['probe report limit exceeded']);
  const charges = changedProbePaths(plan).map(path => ({
    path,
    key: JSON.stringify([window, ...principal, subjectDigest, path]),
    increments: plan.variants.reduce((sum, variant) => sum + (variant.changes.some(change => change.path === path && changeIsEffective(root, change)) ? 1 : 0), 0),
  })).filter(charge => charge.increments > 0);
  for (const charge of charges) {
    if ((pathCounts.get(charge.key) ?? 0) + charge.increments > plan.probeControl.maxPerPrincipalSubjectPath) {
      throw new SensitivityContractError('sensitivity path probe limit exceeded', 'semantic', [`probe path limit exceeded: ${charge.path}`]);
    }
  }
  const perPrincipal = state?.maxEntriesPerPrincipal ?? DEFAULT_PROBE_STATE_MAX_ENTRIES_PER_PRINCIPAL;
  if (!Number.isSafeInteger(perPrincipal) || perPrincipal <= 0) {
    throw new SensitivityContractError('sensitivity probe principal quota is invalid', 'semantic', ['probe principal quota is invalid']);
  }
  if (state === defaultProbeState) {
    evictExpiredWindows(reportsByWindow, window);
    evictExpiredWindows(pathCounts, window);
  }
  const newReportKeys = reportsByWindow.has(reportKey) ? 0 : 1;
  const newPathKeys = charges.filter(charge => !pathCounts.has(charge.key)).length;
  // Applies to host-supplied state too: one principal cannot mint unbounded subjects in a window.
  if (principalEntries(reportsByWindow, principal, window) + newReportKeys > perPrincipal
    || principalEntries(pathCounts, principal, window) + newPathKeys > perPrincipal) {
    throw new SensitivityContractError('sensitivity probe principal quota exhausted', 'semantic',
      ['probe principal quota exhausted for this window']);
  }
  if (state === defaultProbeState) {
    if (reportsByWindow.size + newReportKeys > DEFAULT_PROBE_STATE_MAX_ENTRIES
      || pathCounts.size + newPathKeys > DEFAULT_PROBE_STATE_MAX_ENTRIES) {
      throw new SensitivityContractError('sensitivity probe state capacity exhausted', 'semantic',
        ['probe state capacity exhausted; supply durable probe state']);
    }
  }
  // Charge only after every check has passed.
  reportsByWindow.set(reportKey, reports + 1);
  for (const charge of charges) pathCounts.set(charge.key, (pathCounts.get(charge.key) ?? 0) + charge.increments);
}

function principalEntries(map: Map<string, number>, principal: readonly string[], window: number): number {
  let count = 0;
  for (const key of map.keys()) {
    let parts: unknown;
    try { parts = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parts) || parts[0] !== window) continue;
    if (principal.every((value, index) => parts[index + 1] === value)) count += 1;
  }
  return count;
}

function evictExpiredWindows(map: Map<string, number>, currentWindow: number): void {
  for (const key of [...map.keys()]) {
    let window: unknown;
    try { window = (JSON.parse(key) as unknown[])[0]; } catch { continue; }
    if (typeof window === 'number' && window < currentWindow) map.delete(key);
  }
}

function changedProbePaths(plan: SensitivityPlan): string[] {
  return [...new Set(plan.variants.flatMap(variant => variant.changes.map(change => change.path)))];
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
  sourceBinding: DecisionBinding,
  ruleset: DecisionRuleset,
  binding: DecisionBinding,
  definitions: Readonly<Record<string, DecisionDefinition>>,
  input: unknown,
  variantId: string,
): { result: RulesetResult; unreplayable: boolean } {
  let unreplayable = false;
  const evaluations = Object.fromEntries(Object.entries(source.spec.evaluations).map(([alias, result]) => {
    const targets = binding.spec.evaluations[alias]?.targets ?? [];
    const index = replayTargetIndex(result, sourceBinding.spec.evaluations[alias]?.targets ?? []);
    const sourceTarget = index === null ? undefined : sourceBinding.spec.evaluations[alias]?.targets[index];
    const target = index === null ? undefined : targets[index];
    const definition = definitions[result.spec.decision.id];
    const replayed = sourceTarget && target ? replayAcceptance(result, sourceTarget, target, definition) : structuredClone(result);
    // Stored evidence says nothing about a different executor: any change of target identity is unreplayable.
    if (!sameTargetIdentities(sourceBinding.spec.evaluations[alias]?.targets ?? [], targets)) unreplayable = true;
    // A newly failed acceptance that the binding would route to a later target depends on that
    // target's unobserved outcome.
    if (index !== null && result.spec.status === 'success' && replayed.spec.status !== 'success'
      && index < targets.length - 1 && binding.spec.evaluations[alias]!.fallbackOn.includes(replayed.spec.reason)) unreplayable = true;
    return [alias, replayed];
  }));
  const composition = composeRuleset(ruleset, input, evaluations);
  const rulesetPin = artifactPin(ruleset);
  const bindingPin = artifactPin(binding);
  return { unreplayable, result: {
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
  } };
}

function sameTargetIdentities(left: readonly ExecutionTarget[], right: readonly ExecutionTarget[]): boolean {
  const identity = (target: ExecutionTarget) => sensitivityDigest({
    adapter: target.adapter, adapterVersion: target.adapterVersion, model: target.model,
    subagent: target.subagent ?? null, credentialRef: target.credentialRef ?? null,
  });
  return left.length === right.length && left.every((target, index) => identity(target) === identity(right[index]!));
}

// Changing a target other than the one that produced the stored result, when that target was
// attempted and abstained, or changing fallback routing, depends on an outcome never observed.
function dependsOnUnobservedOutcome(changes: readonly SensitivityChange[], sourceBinding: DecisionBinding, source: RulesetResult): boolean {
  for (const change of changes) {
    const parts = change.path.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts[0] !== 'binding' || parts[1] !== 'spec' || parts[2] !== 'evaluations' || parts[3] === undefined) continue;
    const result = source.spec.evaluations[parts[3]];
    const targets = sourceBinding.spec.evaluations[parts[3]]?.targets ?? [];
    if (!result) continue;
    if (parts[4] === 'fallbackOn') return true;
    if (parts[4] !== 'targets' || parts[5] === undefined) continue;
    const replayIndex = replayTargetIndex(result, targets);
    if (replayIndex === null) return true;
    const changed = Number(parts[5]);
    if (changed === replayIndex) continue;
    const target = targets[changed];
    if (target && result.spec.attempts.some(attempt => attempt.status === 'abstained' && attempt.adapter === target.adapter
      && attempt.adapterVersion === target.adapterVersion && attempt.requestedModel === target.model)) return true;
  }
  return false;
}

// The stored result came from the final attempt (the final successful one when it was accepted), so
// its adapter, adapter version and requested model select the target whose acceptance is replayed.
// An ambiguous or unmatched attempt keeps the stored result rather than guessing a target.
function replayTargetIndex(result: DecisionResult, targets: readonly ExecutionTarget[]): number | null {
  const attempts = result.spec.attempts;
  const attempt = result.spec.status === 'success'
    ? [...attempts].reverse().find(item => item.status === 'success') : attempts.at(-1);
  if (!attempt) return null;
  const matches = targets.flatMap((target, index) => target.adapter === attempt.adapter
    && target.adapterVersion === attempt.adapterVersion && target.model === attempt.requestedModel ? [index] : []);
  return matches.length === 1 ? matches[0]! : null;
}

function replayAcceptance(
  result: DecisionResult,
  sourceTarget: ExecutionTarget,
  target: ExecutionTarget,
  definition?: DecisionDefinition,
): DecisionResult {
  if (!canReplayAcceptance(result, sourceTarget, definition)) return structuredClone(result);
  const replayed = acceptanceObservation(result, target, definition);
  const spec = {
    ...result.spec,
    status: replayed.status,
    reason: replayed.reason,
    uncertainty: replayed.uncertainty,
    ...(replayed.acceptance ? { acceptance: replayed.acceptance } : {}),
  };
  if (replayed.status === 'success' && replayed.value !== undefined) spec.value = replayed.value;
  else delete spec.value;
  return {
    ...result,
    spec,
  };
}

function acceptanceObservation(result: DecisionResult, target: ExecutionTarget, definition?: DecisionDefinition): AdapterObservation {
  const replayDefinition = definition ?? replayDefinitionFromEvidence(result, target);
  const value = replayValue(result, replayDefinition);
  const observation: AdapterObservation = {
    status: value === undefined ? result.spec.status : 'success',
    reason: value === undefined ? result.spec.reason : 'none',
    ...(value !== undefined ? { value } : {}),
    uncertainty: structuredClone(result.spec.uncertainty),
    actualModel: result.spec.attempts.at(-1)?.actualModel ?? null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
    requestId: null,
  };
  return applyTargetAcceptance(replayDefinition, target, observation);
}

// Only an abstention that acceptance produced may be replayed. Primitive-policy acceptance records
// DecisionAcceptanceEvidence, so its absence means the adapter abstained. Confidence-threshold
// acceptance records no evidence, so the abstention must be reproduced by the source target's own
// threshold; one the source threshold would have accepted came from the adapter. An adapter that
// abstains with a confidence below the source threshold is indistinguishable and is replayed.
function canReplayAcceptance(result: DecisionResult, sourceTarget: ExecutionTarget, definition?: DecisionDefinition): boolean {
  if (result.spec.status === 'success') return true;
  if (sourceTarget.acceptance.mode === 'primitive-policy') return result.spec.acceptance !== undefined;
  if (sourceTarget.acceptance.mode !== 'confidence-threshold') return false;
  if (result.spec.reason !== 'low-confidence' && result.spec.reason !== 'missing-confidence'
    && result.spec.reason !== 'confidence-profile-mismatch') return false;
  const reproduced = acceptanceObservation(result, sourceTarget, definition);
  return reproduced.status === result.spec.status && reproduced.reason === result.spec.reason;
}

function replayDefinitionFromEvidence(result: DecisionResult, target: ExecutionTarget): DecisionDefinition {
  let primitive: DecisionAnswer['kind'] | undefined;
  if (target.acceptance.mode === 'primitive-policy') {
    const primitives = [...new Set(target.acceptance.rules.map(rule => rule.primitive))];
    primitive = primitives.length === 1 ? primitives[0] : target.acceptance.requiredOptions ? 'choice' : undefined;
  } else {
    primitive = typeof result.spec.value === 'string' ? 'choice'
      : typeof result.spec.value === 'number' ? 'truth-probability' : undefined;
  }
  if (primitive === 'choice') {
    const keys = [...new Set([...(result.spec.uncertainty?.distribution ? Object.keys(result.spec.uncertainty.distribution) : []),
      ...(typeof result.spec.value === 'string' ? [result.spec.value] : []),
      ...(target.acceptance.mode === 'primitive-policy' ? target.acceptance.requiredOptions ?? [] : [])])];
    return replayDefinitionWithAnswer(result, { kind: 'choice', options: (keys.length ? keys : ['unknown']).map(id => ({ id, description: id })) });
  }
  if (primitive === 'ordinal-score') {
    const levels = Object.keys(result.spec.uncertainty?.distribution ?? {}).sort((a, b) => Number(a) - Number(b));
    return replayDefinitionWithAnswer(result, { kind: 'ordinal-score', levels: levels.length >= 2 ? levels : ['0', '1'] });
  }
  return replayDefinitionWithAnswer(result, { kind: 'truth-probability', trueDescription: 'true', falseDescription: 'false' });
}

function replayDefinitionWithAnswer(result: DecisionResult, answer: DecisionDefinition['spec']['answer']): DecisionDefinition {
  return {
    apiVersion: result.apiVersion,
    kind: 'DecisionDefinition',
    metadata: { id: result.spec.decision.id, version: result.spec.decision.version, description: result.spec.alias },
    spec: { purpose: 'sensitivity replay', inputSchema: {}, question: 'sensitivity replay', answer, requiredCapabilities: [] },
  };
}

function replayValue(result: DecisionResult, definition: DecisionDefinition): string | number | undefined {
  if (result.spec.value !== undefined) return result.spec.value;
  if (definition.spec.answer.kind === 'choice') {
    const distribution = result.spec.uncertainty?.distribution;
    if (!distribution) return undefined;
    return Object.entries(distribution).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  }
  if (definition.spec.answer.kind === 'truth-probability') {
    const yes = result.spec.acceptance?.values['yes-probability'];
    if (yes?.provenance === 'provider-value') return yes.value;
    return undefined;
  }
  return result.spec.acceptance?.values['expected-score']?.value;
}

function applyChanges<T>(target: T, changes: readonly SensitivityChange[]): T {
  for (const change of changes) setPointer(target, change.path, structuredClone(change.value));
  return target;
}

function setPointer(root: unknown, pointer: string, value: JsonValue): void {
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!parts.length) throw new SensitivityContractError('root replacement is not supported');
  let current: any = root;
  for (const part of parts.slice(0, -1)) {
    assertSafePointerSegment(part);
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      throw new SensitivityContractError(`sensitivity path ${pointer} is not structurally present`);
    }
    current = current[part];
  }
  assertSafePointerSegment(parts[parts.length - 1]!);
  if (!current || typeof current !== 'object') throw new SensitivityContractError(`sensitivity path ${pointer} is not structurally present`);
  current[parts[parts.length - 1]!] = value;
}

function assertPointerTarget(root: unknown, pointer: string): void {
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!parts.length) throw new SensitivityContractError('root replacement is not supported');
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    assertSafePointerSegment(part);
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      throw new SensitivityContractError(`sensitivity path ${pointer} is not structurally present`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  assertSafePointerSegment(parts[parts.length - 1]!);
  if (!current || typeof current !== 'object') throw new SensitivityContractError(`sensitivity path ${pointer} is not structurally present`);
}

function assertSafePointerSegment(segment: string): void {
  if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
    throw new SensitivityContractError(`sensitivity path segment ${segment} is prohibited`);
  }
}

function isNoChange(root: unknown, changes: readonly SensitivityChange[]): boolean {
  const before = sensitivityDigest(root);
  const copy = structuredClone(root);
  const normalized = changes.map(change => ({ path: change.path, value: change.value }));
  applyChanges(copy, normalized);
  return sensitivityDigest(copy) === before;
}

function changeIsEffective(root: unknown, change: SensitivityChange): boolean {
  const current = getPointer(root, change.path);
  return current === POINTER_MISSING || sensitivityDigest(current) !== sensitivityDigest(change.value);
}

const POINTER_MISSING = Symbol('pointer-missing');

function getPointer(root: unknown, pointer: string): unknown | typeof POINTER_MISSING {
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return POINTER_MISSING;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
  extraWarnings?: readonly string[];
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
    warnings: [...warningForResult(input.source, input.result), ...(input.extraWarnings ?? [])],
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
    tokens: newAttempts.reduce((sum, attempt) => sum + usageNumber(attempt.usage.inputTokens) + usageNumber(attempt.usage.outputTokens), 0),
    costMicros: Math.round(newAttempts.reduce((sum, attempt) => sum + usageNumber(attempt.usage.costUsd), 0) * 1_000_000),
  };
}

function spendResult(budget: SensitivityReport['budget'], result: RulesetResult): void {
  const attempts = Object.values(result.spec.evaluations).flatMap(evaluation => evaluation.spec.attempts);
  budget.backendCalls += attempts.length;
  budget.tokens += attempts.reduce((sum, attempt) => sum + usageNumber(attempt.usage.inputTokens) + usageNumber(attempt.usage.outputTokens), 0);
  budget.costMicros += Math.round(attempts.reduce((sum, attempt) => sum + usageNumber(attempt.usage.costUsd), 0) * 1_000_000);
}

/** Spend can be read from a value only when every evaluation carries attempts with usage objects. */
function hasAttemptLineage(value: unknown): value is RulesetResult {
  const spec = isRecord(value) ? value.spec : undefined;
  if (!isRecord(spec) || !isRecord(spec.evaluations)) return false;
  return Object.values(spec.evaluations).every(evaluation => isRecord(evaluation) && isRecord(evaluation.spec)
    && Array.isArray(evaluation.spec.attempts)
    && evaluation.spec.attempts.every(attempt => isRecord(attempt) && isRecord(attempt.usage)
      && validUsage(attempt.usage.inputTokens) && validUsage(attempt.usage.outputTokens) && validUsage(attempt.usage.costUsd)));
}

function validUsage(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/** Non-negative finite usage; anything else contributes nothing (validated results never reach this). */
function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function chargeUnusableResult(budget: SensitivityReport['budget'], warnings: string[], request: SensitivityRuntimeRequest, value: unknown): void {
  if (hasAttemptLineage(value)) spendResult(budget, value);
  else spendUnknownReserve(budget, warnings, request.sourceBinding, request.sourceResult);
}

/** A returned reevaluation must have the fields the validator and row builder read. */
function isRulesetResultShape(value: unknown): value is RulesetResult {
  if (!hasAttemptLineage(value)) return false;
  const metadata = (value as unknown as Record<string, unknown>).metadata;
  if (!isRecord(metadata) || typeof metadata.id !== 'string' || typeof metadata.version !== 'string') return false;
  const spec = value.spec as unknown as Record<string, unknown>;
  return typeof spec.invocationId === 'string' && typeof spec.status === 'string' && typeof spec.reason === 'string'
    && Array.isArray(spec.matchedRules) && spec.matchedRules.every(rule => typeof rule === 'string')
    && Object.values(value.spec.evaluations).every(evaluation => typeof evaluation.spec.invocationId === 'string');
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Charges host-supplied spend evidence from a failed reevaluation; returns false when there is none. */
function spendFailure(budget: SensitivityReport['budget'], error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const result = record.result;
  if (hasAttemptLineage(result)) {
    spendResult(budget, result);
    return true;
  }
  const resourceUse = record.resourceUse ?? record.sensitivitySpend;
  if (!resourceUse || typeof resourceUse !== 'object') return false;
  const usage = resourceUse as Partial<SensitivityReportRow['resourceUse']>;
  budget.backendCalls += integerUsage(usage.backendCalls);
  budget.tokens += integerUsage(usage.tokens);
  budget.costMicros += integerUsage(usage.costMicros);
  return true;
}

// A throw without spend evidence may still have reached the backend. Unknown spend is not zero:
// charge the pre-dispatch reservation and flag the figures as a conservative reservation.
function spendUnknownReserve(budget: SensitivityReport['budget'], warnings: string[], binding: DecisionBinding, source: RulesetResult): void {
  const reserve = reevaluationReserve(binding, source);
  budget.backendCalls += reserve.backendCalls;
  budget.tokens += reserve.tokens;
  budget.costMicros += reserve.costMicros;
  if (!warnings.includes('spend-unknown-reserved')) warnings.push('spend-unknown-reserved');
}

function integerUsage(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function canSpendCall(plan: SensitivityPlan, binding: DecisionBinding, source: RulesetResult,
  budget: SensitivityReport['budget'], deadline: number, now: number): boolean {
  const reserve = reevaluationReserve(binding, source);
  return now < deadline && budget.backendCalls + reserve.backendCalls <= plan.budgets.maxBackendCalls
    && budget.tokens + reserve.tokens <= plan.budgets.maxTokens && budget.costMicros + reserve.costMicros <= plan.budgets.maxCostMicros
    && budget.backendCalls < plan.budgets.maxBackendCalls && budget.tokens < plan.budgets.maxTokens
    && budget.costMicros < plan.budgets.maxCostMicros;
}

function reevaluationReserve(binding: DecisionBinding, source: RulesetResult): Pick<SensitivityReport['budget'], 'backendCalls' | 'tokens' | 'costMicros'> {
  const evaluationCount = Math.max(1, Object.keys(source.spec.evaluations).length, Object.keys(binding.spec.evaluations).length);
  const attempts = Math.max(1, binding.spec.maxAttempts) * evaluationCount;
  const sourceAttempts = Object.values(source.spec.evaluations).flatMap(evaluation => evaluation.spec.attempts);
  const perAttemptTokens = Math.max(0, ...sourceAttempts.map(attempt => usageNumber(attempt.usage.inputTokens) + usageNumber(attempt.usage.outputTokens)));
  const perAttemptCostMicros = Math.max(0, ...sourceAttempts.map(attempt => Math.round(usageNumber(attempt.usage.costUsd) * 1_000_000)));
  return { backendCalls: attempts, tokens: attempts * perAttemptTokens, costMicros: attempts * perAttemptCostMicros };
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

function failedPartialReport(
  request: SensitivityRuntimeRequest,
  plan: SensitivityPlan,
  rows: SensitivityReportRow[],
  budget: SensitivityReport['budget'],
  warnings: string[],
  reason: string,
): SensitivityReport {
  budget.exhausted = true;
  const report = buildReport(request, plan, rows, budget, [...warnings, 'partial-failure', reason]);
  const { digest: _digest, ...payload } = report;
  const status: SensitivityReport['status'] = rows.length ? 'partial' : 'failed';
  return { ...payload, status, digest: sensitivityDigest({ ...payload, status }) };
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

function freshInvocationId(plan: SensitivityPlan, variantId: string, runNonce: string): string {
  return `sens-${plan.id}-${runNonce}-${variantId}`.slice(0, 160);
}

function expectedReceiptFingerprint(request: SensitivityRuntimeRequest, invocationId: string, input: unknown): SensitivityDigest {
  return decisionInvocationFingerprint({
    invocationId,
    value: input,
    definitions: request.sourceRuleset.spec.evaluations.map(evaluation => evaluation.decision),
    ruleset: artifactPin(request.sourceRuleset),
    binding: artifactPin(request.sourceBinding),
  }) as SensitivityDigest;
}

function ensureFreshBeforeDispatch(invocationId: string, receiptFingerprint: string, usedInvocations: Set<string>): void {
  if (usedInvocations.has(invocationId)) throw new SensitivityContractError(`invocation ${invocationId} was already used`);
  usedInvocations.add(invocationId);
  if (!/^sha256:[a-f0-9]{64}$/.test(receiptFingerprint)) throw new SensitivityContractError('invalid reevaluation receipt fingerprint');
}

function validateReevaluationResult(
  request: SensitivityRuntimeRequest,
  result: RulesetResult,
  variantId: string,
  invocationId: string,
  receiptFingerprint: string,
  input: unknown,
): string | null {
  if (result.spec.invocationId !== invocationId) return `variant ${variantId} returned invocation ID ${result.spec.invocationId} instead of ${invocationId}`;
  if (result.spec.invocationId === request.sourceResult.spec.invocationId) return `variant ${variantId} reused the source invocation ID`;
  const actualFingerprint = decisionInvocationFingerprint({
    invocationId: result.spec.invocationId,
    value: input,
    definitions: request.sourceRuleset.spec.evaluations.map(evaluation => evaluation.decision),
    ruleset: artifactPin(request.sourceRuleset),
    binding: artifactPin(request.sourceBinding),
  });
  if (actualFingerprint !== receiptFingerprint) return `variant ${variantId} receipt fingerprint mismatch`;
  if (Object.values(result.spec.evaluations).some(evaluation => evaluation.spec.invocationId !== invocationId)) {
    return `variant ${variantId} returned an evaluation with the wrong invocation ID`;
  }
  if (Object.values(result.spec.evaluations).some(evaluation => evaluation.spec.attempts.length === 0)) {
    return `variant ${variantId} did not return complete attempt lineage`;
  }
  return null;
}

function sanitizeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^\w .:/-]/g, '').slice(0, 120) || 'reevaluation failed';
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
