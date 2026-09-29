import { projectDecisionState } from '../projection.js';
import { executeDriftResponse, pinChampionForRun, rollbackChampionForNewRuns } from '../ensemble/runtime.js';
import type { RouteCandidate, RouteCandidateSummary, RouteAttemptReceipt, RoutingControlDrillInput,
  RoutingControlDrillResult, RoutingDispatchResult, RoutingEligibleCandidate, RoutingExclusionReason,
  RoutingPolicy, RoutingReceipt, RoutingRuntimeOptions, RoutingTask } from './types.js';
import { routingDigest, validateRoutingPolicy } from './contract.js';

const TERMINAL_FALLBACK_REASONS = new Set(['rate-limit', 'outage', 'circuit-open', 'timeout'] as const);

export async function evaluateRoutingEligibility(policyInput: unknown, task: RoutingTask, reserve?: RoutingRuntimeOptions['reserve']):
Promise<{ policy: RoutingPolicy; digest: ReturnType<typeof routingDigest>; eligible: RoutingEligibleCandidate[]; excluded: RoutingReceipt['excluded'] }> {
  const { policy, digest } = validateRoutingPolicy(policyInput);
  const eligible: RoutingEligibleCandidate[] = [];
  const excluded: RoutingReceipt['excluded'] = [];
  let ordinal = 1;
  for (const candidate of [...policy.candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const reasons = exclusionReasons(candidate, task, policy);
    if (!reasons.length && reserve && await reserve(candidate, ordinal) !== true) reasons.push('reservation-denied');
    if (reasons.length) excluded.push({ routeId: candidate.id, reasons });
    else eligible.push({ candidate, summary: summarize(candidate) });
    ordinal += 1;
  }
  return { policy, digest, eligible, excluded };
}

export async function runRoutingPilot(policyInput: unknown, task: RoutingTask, options: RoutingRuntimeOptions = {}): Promise<RoutingReceipt> {
  const now = options.now ?? Date.now;
  const { policy, digest, eligible, excluded } = await evaluateRoutingEligibility(policyInput, task, options.reserve);
  const createdAtEpochMs = now();
  const base = (partial: Omit<RoutingReceipt, 'schemaVersion' | 'routing' | 'task' | 'candidatePins' | 'createdAtEpochMs' | 'digest'>,
    projection: RoutingReceipt['task']['projection'] = null): RoutingReceipt => {
    const payload = {
      schemaVersion: 'decision-route-receipt/v1' as const,
      routing: { id: policy.id, version: policy.version, policyVersion: policy.policyVersion, mode: policy.mode, digest },
      task: { id: task.id, projection },
      candidatePins: candidatePins(policy),
      createdAtEpochMs,
      ...partial,
    };
    return { ...payload, digest: routingDigest(payload) };
  };

  if (options.enabled !== true || policy.mode === 'disabled') {
    return base(disabledReceipt(policy, eligible, excluded));
  }
  if (!eligible.length) {
    return base({
      status: 'no-route', reason: 'empty-eligible-set', eligibleRouteIds: [], excluded,
      jev: null, selectedRouteId: null, selectionReason: 'review',
      actual: { workerId: null, provider: null, model: null }, attempts: [], fallbacks: [], usage: nullUsage(), outcome: { verified: null, label: null },
    });
  }
  if (!options.evidence || !policy.jevEvidence.enabled) {
    return base(reviewReceipt('jev-evidence-unavailable', eligible, excluded));
  }

  let projected: Awaited<ReturnType<typeof projectDecisionState>>;
  try {
    projected = await projectDecisionState(task.state, task.projection);
  } catch {
    return base(reviewReceipt('projection-denied', eligible, excluded));
  }

  let evidence;
  try {
    evidence = await options.evidence({
      task: { id: task.id, description: task.description },
      projectedState: Object.freeze(projected.state),
      projection: projected.evidence,
      candidates: eligible.map(item => item.summary),
    });
  } catch {
    return base(reviewReceipt('jev-evidence-unavailable', eligible, excluded, projected.evidence), projected.evidence);
  }

  const evidenceProblem = evidenceProblemCode(policy, eligible.map(item => item.candidate.id), evidence);
  if (evidenceProblem) return base(reviewReceipt(evidenceProblem, eligible, excluded, projected.evidence, evidence), projected.evidence);

  const ordered = rankRoutes(policy, eligible, evidence);
  if (!ordered.length) return base(reviewReceipt('ambiguous-or-uncalibrated', eligible, excluded, projected.evidence, evidence), projected.evidence);
  const attempts: RouteAttemptReceipt[] = [];
  const fallbacks: string[] = [];
  let selected = ordered[0]!.candidate;
  let final: RoutingDispatchResult | null = null;
  if (options.dispatch) {
    const deadlineEpochMs = now() + policy.ceilings.deadlineMs;
    const signal = options.signal ?? new AbortController().signal;
    let ordinal = 1;
    for (const route of ordered.slice(0, policy.ceilings.maxFallbacks + 1)) {
      if (ordinal > policy.ceilings.maxAttempts || signal.aborted || now() >= deadlineEpochMs) break;
      selected = route.candidate;
      let result: RoutingDispatchResult;
      try {
        result = await options.dispatch({ candidate: selected, attemptOrdinal: ordinal, deadlineEpochMs, signal });
      } catch {
        result = failedDispatch('rejected');
      }
      attempts.push(attemptReceipt(ordinal, selected, result));
      if (result.status === 'success') { final = result; break; }
      if (!TERMINAL_FALLBACK_REASONS.has(result.reason as never)) { final = result; break; }
      fallbacks.push(selected.id);
      ordinal += 1;
      if (options.delay && ordinal <= policy.ceilings.maxAttempts) await options.delay(policy.ceilings.retryDelayMs, signal);
    }
  }

  const selectedId = final?.status === 'success' || !options.dispatch ? selected.id : null;
  return base({
    status: selectedId ? 'selected' : 'review',
    reason: selectedId ? 'policy-selected' : 'fallbacks-exhausted',
    eligibleRouteIds: eligible.map(item => item.candidate.id),
    excluded,
    jev: evidence,
    selectedRouteId: selectedId,
    selectionReason: selectedId ? 'deterministic-utility' : 'review',
    actual: { workerId: final?.workerId ?? null, provider: final?.actualProvider ?? null, model: final?.actualModel ?? null },
    attempts,
    fallbacks,
    usage: aggregateUsage(attempts),
    outcome: { verified: final?.verified ?? null, label: final?.outcomeLabel ?? null },
  }, projected.evidence);
}

export async function runRoutingControlDrill(input: RoutingControlDrillInput): Promise<RoutingControlDrillResult> {
  const runPins = input.activeRunIds.map(runId => {
    const pin = pinChampionForRun(input.championChallenger, runId);
    return { runId, aliasRevision: pin.aliasRevision, identityDigest: pin.identityDigest };
  });
  const drift = await executeDriftResponse(input.driftPolicy, input.driftSignal, {
    'restore-champion': async () => undefined,
    alert: async () => undefined,
    'route-to-review': async () => undefined,
    'reduce-coverage': async () => undefined,
    'disable-challenger': async () => undefined,
    'require-recertification': async () => undefined,
  });
  const rollbackEvent = drift.executed === 'restore-champion'
    ? rollbackChampionForNewRuns({
      record: input.championChallenger,
      gateway: input.gateway,
      approvalReference: input.approvalReference,
      at: input.at,
    }) : null;
  return { runPins, driftResponse: drift.executed, rollbackEvent };
}

function disabledReceipt(policy: RoutingPolicy, eligible: RoutingEligibleCandidate[], excluded: RoutingReceipt['excluded']):
Omit<RoutingReceipt, 'schemaVersion' | 'routing' | 'task' | 'candidatePins' | 'createdAtEpochMs' | 'digest'> {
  return {
    status: 'disabled',
    reason: policy.mode === 'disabled' ? 'policy-disabled' : 'runtime-disabled',
    eligibleRouteIds: eligible.map(item => item.candidate.id),
    excluded,
    jev: null,
    selectedRouteId: policy.deterministicFallbackRouteId,
    selectionReason: 'existing-behavior-preserved',
    actual: { workerId: null, provider: null, model: null },
    attempts: [],
    fallbacks: [],
    usage: nullUsage(),
    outcome: { verified: null, label: null },
  };
}

function reviewReceipt(reason: string, eligible: RoutingEligibleCandidate[], excluded: RoutingReceipt['excluded'],
  projection: RoutingReceipt['task']['projection'] = null, jev: RoutingReceipt['jev'] = null):
Omit<RoutingReceipt, 'schemaVersion' | 'routing' | 'task' | 'candidatePins' | 'createdAtEpochMs' | 'digest'> {
  void projection;
  return {
    status: 'review',
    reason,
    eligibleRouteIds: eligible.map(item => item.candidate.id),
    excluded,
    jev,
    selectedRouteId: null,
    selectionReason: 'review',
    actual: { workerId: null, provider: null, model: null },
    attempts: [],
    fallbacks: [],
    usage: nullUsage(),
    outcome: { verified: null, label: null },
  };
}

function candidatePins(policy: Pick<RoutingPolicy, 'candidates'>): RoutingReceipt['candidatePins'] {
  return [...policy.candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(candidate => ({
    routeId: candidate.id,
    binding: structuredClone(candidate.binding),
    model: structuredClone(candidate.model),
    subagent: candidate.subagent ? structuredClone(candidate.subagent) : null,
    health: candidate.operations.health,
    priceCatalogVersion: candidate.operations.priceCatalogVersion,
    latencyMsP95: candidate.operations.latencyMsP95,
    costMicrosPerAttempt: candidate.operations.costMicrosPerAttempt,
  }));
}

function exclusionReasons(candidate: RouteCandidate, task: RoutingTask, policy: RoutingPolicy): RoutingExclusionReason[] {
  const reasons: RoutingExclusionReason[] = [];
  if (!candidate.policy.privacy.includes(task.requirements.privacy)) reasons.push('privacy-denied');
  if (task.requirements.authorizationScopes.some(scope => !candidate.policy.authorizationScopes.includes(scope))) reasons.push('authorization-denied');
  if (!candidate.policy.regions.includes(task.requirements.region)) reasons.push('region-denied');
  if (task.requirements.tools.some(tool => !candidate.permissions.tools.includes(tool))) reasons.push('tool-denied');
  if (candidate.policy.contextBytes < task.requirements.contextBytes) reasons.push('context-denied');
  if (!candidate.policy.allowlisted || !task.requirements.allowlist.includes(candidate.id)) reasons.push('allowlist-denied');
  if (candidate.operations.costMicrosPerAttempt === null || candidate.operations.costMicrosPerAttempt > Math.min(task.requirements.maxCostMicros, policy.ceilings.maxCostMicros)) reasons.push('budget-denied');
  if (candidate.operations.deadlineMs > Math.min(task.requirements.deadlineMs, policy.ceilings.deadlineMs)) reasons.push('deadline-denied');
  if (['outage', 'rate-limited', 'circuit-open'].includes(candidate.operations.health)) reasons.push('health-denied');
  if (!candidate.policy.executable) reasons.push('not-executable');
  if (task.requirements.capabilities.some(capability => !candidate.capabilities.includes(capability))) reasons.push('capability-denied');
  return reasons;
}

function summarize(candidate: RouteCandidate): RouteCandidateSummary {
  return {
    id: candidate.id,
    capabilities: [...candidate.capabilities].sort(),
    provider: candidate.model.provider,
    backend: candidate.model.backend,
    requestedModel: candidate.model.requested,
    pinnedModelVersion: candidate.model.pinnedVersion,
    subagentId: candidate.subagent?.id ?? null,
    health: candidate.operations.health,
    latencyMsP95: candidate.operations.latencyMsP95,
    costMicrosPerAttempt: candidate.operations.costMicrosPerAttempt,
  };
}

function evidenceProblemCode(policy: RoutingPolicy, eligibleIds: string[], evidence: RoutingReceipt['jev']): string | null {
  if (!evidence || evidence.schemaVersion !== 'decision-routing-jev-evidence/v1') return 'malformed-jev-evidence';
  if (policy.jevEvidence.calibrationRequired && evidence.calibration !== 'calibrated') return 'ambiguous-or-uncalibrated';
  if (!policy.jevEvidence.compatibleProfiles.includes(evidence.profile)) return 'ambiguous-or-uncalibrated';
  if (![evidence.taskComplexity, evidence.ambiguity].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return 'malformed-jev-evidence';
  const eligible = new Set(eligibleIds);
  if (evidence.distributions.some(item => !eligible.has(item.routeId))) return 'malformed-jev-evidence';
  return null;
}

function rankRoutes(policy: RoutingPolicy, eligible: RoutingEligibleCandidate[], evidence: NonNullable<RoutingReceipt['jev']>): RoutingEligibleCandidate[] {
  const byRoute = new Map(evidence.distributions.map(item => [item.routeId, item]));
  return [...eligible].sort((a, b) => {
    const scoreA = utility(policy, a.candidate, byRoute.get(a.candidate.id), evidence);
    const scoreB = utility(policy, b.candidate, byRoute.get(b.candidate.id), evidence);
    return scoreB - scoreA || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0);
  });
}

function utility(policy: RoutingPolicy, candidate: RouteCandidate, evidence: NonNullable<RoutingReceipt['jev']>['distributions'][number] | undefined,
  allEvidence: NonNullable<RoutingReceipt['jev']>): number {
  if (!evidence || candidate.operations.costMicrosPerAttempt === null) return Number.NEGATIVE_INFINITY;
  const healthPenalty = candidate.operations.health === 'degraded' ? 1 : 0;
  return evidence.taskFit * policy.utility.taskFit
    + (1 - Math.abs(allEvidence.taskComplexity - evidence.reasoningNeed)) * policy.utility.complexityFit
    - allEvidence.ambiguity * policy.utility.ambiguityPenalty
    - candidate.operations.latencyMsP95 * policy.utility.latencyPenalty
    - candidate.operations.costMicrosPerAttempt * policy.utility.costPenalty
    - healthPenalty * policy.utility.healthPenalty;
}

function failedDispatch(reason: RoutingDispatchResult['reason']): RoutingDispatchResult {
  return { status: 'failure', reason, actualProvider: null, actualModel: null, workerId: null,
    inputTokens: null, outputTokens: null, costMicros: null, latencyMs: null, verified: null, outcomeLabel: null };
}

function attemptReceipt(ordinal: number, candidate: RouteCandidate, result: RoutingDispatchResult): RouteAttemptReceipt {
  return {
    ordinal,
    routeId: candidate.id,
    status: result.status === 'success' ? 'succeeded' : 'failed',
    reason: result.reason,
    actualProvider: result.actualProvider,
    actualModel: result.actualModel,
    workerId: result.workerId,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicros: result.costMicros },
    latencyMs: result.latencyMs,
  };
}

function nullUsage() { return { inputTokens: null, outputTokens: null, costMicros: null }; }

function aggregateUsage(attempts: RouteAttemptReceipt[]): RoutingReceipt['usage'] {
  const fields = ['inputTokens', 'outputTokens', 'costMicros'] as const;
  return Object.fromEntries(fields.map(field => [field, attempts.every(attempt => attempt.usage[field] !== null)
    ? attempts.reduce((sum, attempt) => sum + attempt.usage[field]!, 0) : null])) as RoutingReceipt['usage'];
}
