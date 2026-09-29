import { canonicalJson } from '../../security/artifact-trust.js';
import { redactStructured } from '../../governance/redaction.js';
import { admitEntry } from '../entry.js';
import { projectDecisionState } from '../projection.js';
import { executeDriftResponse, rollbackChampionForNewRuns } from '../ensemble/runtime.js';
import type { AliasEvent } from '../calibration/types.js';
import type { JevRoutingEvidence, RouteCandidate, RouteCandidateSummary, RouteAttemptReceipt, RoutingControlDrillInput,
  RoutingControlDrillResult, RoutingCounterfactual, RoutingDispatchResult, RoutingEligibleCandidate, RoutingExclusionReason,
  RoutingPin, RoutingPolicy, RoutingReceipt, RoutingRuntimeOptions, RoutingSkipReason, RoutingTask } from './types.js';
import {
  compareRoutingKeys, frozenRoutingClone, RoutingContractError, routingDigest, validateJevRoutingEvidence, validateRoutingPolicy,
  validateRoutingTask,
} from './contract.js';

/** Provider-level failures open that provider's circuit for the rest of the run. */
const CIRCUIT_REASONS = new Set<string>(['rate-limit', 'outage', 'circuit-open']);
const DISPATCH_FAILURES = new Set<string>(['rate-limit', 'outage', 'circuit-open', 'timeout', 'rejected', 'failed', 'cancelled']);
const RESULT_KEYS = ['actualModel', 'actualProvider', 'costMicros', 'inputTokens', 'latencyMs', 'outcomeLabel', 'outputTokens',
  'reason', 'status', 'verified', 'workerId'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_BACKOFF_MS = 30_000;

type Eligibility = { policy: RoutingPolicy; digest: ReturnType<typeof routingDigest>; task: RoutingTask;
  eligible: RoutingEligibleCandidate[]; excluded: RoutingReceipt['excluded'] };
type ReceiptBody = Omit<RoutingReceipt, 'schemaVersion' | 'routing' | 'candidatePins' | 'createdAtEpochMs' | 'digest'>;

/** Pure hard-constraint filter: no hooks, no reservations, no model input. Invalid policy or task throws. */
export function evaluateRoutingEligibility(policyInput: unknown, taskInput: unknown): Eligibility {
  const { policy, digest } = validateRoutingPolicy(policyInput);
  const task = validateRoutingTask(taskInput);
  const eligible: RoutingEligibleCandidate[] = [];
  const excluded: RoutingReceipt['excluded'] = [];
  for (const candidate of policy.candidates) {
    const reasons = exclusionReasons(candidate, task, policy);
    if (reasons.length) excluded.push({ routeId: candidate.id, reasons });
    else eligible.push({ candidate, summary: summarize(candidate) });
  }
  return { policy, digest, task, eligible, excluded };
}

/**
 * D28 shadow routing. Shadow executes only the existing deterministic route (`defaultRouteId`, then
 * `deterministicFallbackRouteId`) and records the Jev-assisted choice as a counterfactual that never
 * executes. Disabled mode calls no hook. Every path after policy validation returns a receipt.
 */
export async function runRoutingPilot(policyInput: unknown, taskInput: unknown, options: RoutingRuntimeOptions = {}): Promise<RoutingReceipt> {
  const { policy, digest } = validateRoutingPolicy(policyInput);
  const clock = (): number => {
    const value = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new RoutingContractError('routing clock returned an invalid time');
    return value;
  };
  let createdAtEpochMs = 0;
  const body: ReceiptBody = {
    task: { id: safeTaskId(taskInput), projection: null },
    status: 'review', reason: 'runtime-error', eligibleRouteIds: [], excluded: [], jev: null,
    counterfactual: notEvaluated('not-evaluated'), selectedRouteId: null, selectionReason: 'review',
    actual: { workerId: null, provider: null, model: null }, attempts: [], skipped: [], fallbacks: [],
    budget: { limitMicros: null, spentMicros: null }, deadlineEpochMs: null, usage: nullUsage(), outcome: { verified: null, label: null },
  };
  const receipt = (): RoutingReceipt => {
    const payload = {
      schemaVersion: 'decision-route-receipt/v1' as const,
      routing: { id: policy.id, version: policy.version, policyVersion: policy.policyVersion, mode: policy.mode, digest },
      candidatePins: candidatePins(policy),
      createdAtEpochMs,
      ...body,
    };
    return { ...payload, digest: routingDigest(payload) };
  };

  try {
    createdAtEpochMs = clock();
  } catch {
    body.reason = 'clock-invalid';
    return receipt();
  }
  if (options.enabled !== true || policy.mode === 'disabled') {
    Object.assign(body, { status: 'disabled', reason: policy.mode === 'disabled' ? 'policy-disabled' : 'runtime-disabled',
      selectionReason: 'existing-behavior-preserved', counterfactual: notEvaluated('disabled') });
    return receipt();
  }
  try {
    await runShadow(policy, taskInput, options, clock, createdAtEpochMs, body);
  } catch {
    // A failure inside a hook or the runtime keeps every attempt already recorded.
    body.status = 'review';
    body.reason = 'runtime-error';
    body.selectedRouteId = null;
    body.selectionReason = 'review';
  }
  try {
    return receipt();
  } catch {
    // Only a value that escaped validation can fail canonical encoding; keep the decision, drop the value.
    body.jev = null;
    body.actual = { workerId: null, provider: null, model: null };
    body.status = 'review';
    body.reason = 'runtime-error';
    return receipt();
  }
}

async function runShadow(policy: RoutingPolicy, taskInput: unknown, options: RoutingRuntimeOptions, clock: () => number,
  startedAt: number, body: ReceiptBody): Promise<void> {
  let task: RoutingTask;
  try {
    task = validateRoutingTask(taskInput);
  } catch {
    Object.assign(body, { status: 'review', reason: 'invalid-task', counterfactual: notEvaluated('invalid-task') });
    return;
  }
  const { eligible, excluded } = evaluateRoutingEligibility(policy, task);
  body.eligibleRouteIds = eligible.map(item => item.candidate.id);
  body.excluded = excluded;
  const limitMicros = Math.min(task.requirements.maxCostMicros, policy.ceilings.maxCostMicros);
  const deadlineEpochMs = startedAt + Math.min(task.requirements.deadlineMs, policy.ceilings.deadlineMs);
  body.budget = { limitMicros, spentMicros: 0 };
  body.deadlineEpochMs = deadlineEpochMs;

  const eligibleById = new Map(eligible.map(item => [item.candidate.id, item.candidate]));
  const chainIds = [...new Set([policy.defaultRouteId, policy.deterministicFallbackRouteId].filter((id): id is string => id !== null))];
  const chain = chainIds.map(id => eligibleById.get(id)).filter((item): item is RouteCandidate => item !== undefined);

  if (!eligible.length) {
    Object.assign(body, { status: 'no-route', reason: 'empty-eligible-set' });
  } else if (!chainIds.length) {
    Object.assign(body, { status: 'no-route', reason: 'no-deterministic-route' });
  } else if (!chain.length) {
    Object.assign(body, { status: 'no-route', reason: 'deterministic-route-ineligible' });
  } else if (!options.dispatch) {
    Object.assign(body, { status: 'selected', reason: 'deterministic-route', selectedRouteId: chain[0]!.id,
      selectionReason: 'deterministic-authoritative' });
  } else if (!options.reserve || !options.release) {
    Object.assign(body, { status: 'review', reason: 'reservation-unavailable' });
  } else {
    await executeDeterministicChain(policy, chain, options, clock, { limitMicros, deadlineEpochMs }, body);
  }

  const shadow = await counterfactual(policy, task, eligible, chain[0]?.id ?? null, options);
  body.counterfactual = shadow.counterfactual;
  body.jev = shadow.jev;
  body.task = { id: task.id, projection: shadow.projection };
}

async function executeDeterministicChain(policy: RoutingPolicy, chain: RouteCandidate[], options: RoutingRuntimeOptions,
  clock: () => number, limits: { limitMicros: number; deadlineEpochMs: number }, body: ReceiptBody): Promise<void> {
  const dispatch = options.dispatch!;
  const reserve = options.reserve!;
  const release = options.release!;
  const delay = options.delay ?? realTimer;
  const timer = options.timer ?? realTimer;
  const openProviders = new Set<string>();
  let spent: number | null = 0;
  let ordinal = 0;
  let fallbacksUsed = 0;
  let exhausted: 'fallbacks-exhausted' | 'budget-exhausted' | 'deadline-exhausted' = 'fallbacks-exhausted';
  let concluded = false;
  const stop = (reason: string): void => {
    concluded = true;
    Object.assign(body, { status: 'review', reason, selectedRouteId: null, selectionReason: 'review' });
  };
  const skip = (routeId: string, reason: RoutingSkipReason): void => {
    body.skipped.push({ routeId, reason });
    if (reason === 'budget-exhausted' || reason === 'deadline-exhausted') exhausted = reason;
  };

  routes: for (const [index, route] of chain.entries()) {
    let triesOnRoute = 0;
    while (triesOnRoute < route.operations.maxAttempts) {
      if (options.signal?.aborted) { stop('cancelled'); break routes; }
      if (ordinal >= policy.ceilings.maxAttempts) { stop('attempts-exhausted'); break routes; }
      if (index > 0 && triesOnRoute === 0 && fallbacksUsed >= policy.ceilings.maxFallbacks) break routes;
      // Every attempt, including a fallback, re-checks the constraints that change during the run.
      if (openProviders.has(route.model.provider)) { skip(route.id, 'circuit-open'); continue routes; }
      const cost = route.operations.costMicrosPerAttempt!;
      if (spent! + cost > limits.limitMicros) { skip(route.id, 'budget-exhausted'); continue routes; }
      const backoff = ordinal === 0 ? 0 : Math.min(policy.ceilings.retryDelayMs * 2 ** (ordinal - 1), MAX_BACKOFF_MS);
      if (clock() + backoff + route.operations.deadlineMs > limits.deadlineEpochMs) { skip(route.id, 'deadline-exhausted'); continue routes; }
      if (backoff > 0) {
        try {
          await delay(backoff, options.signal ?? new AbortController().signal);
        } catch {
          stop('cancelled');
          break routes;
        }
        if (options.signal?.aborted) { stop('cancelled'); break routes; }
        if (clock() + route.operations.deadlineMs > limits.deadlineEpochMs) { skip(route.id, 'deadline-exhausted'); continue routes; }
      }
      let granted = false;
      try { granted = await reserve(route, ordinal + 1) === true; } catch { granted = false; }
      if (!granted) { skip(route.id, 'reservation-denied'); continue routes; }

      ordinal += 1;
      triesOnRoute += 1;
      if (index > 0 && triesOnRoute === 1) fallbacksUsed += 1;
      const startedAt = clock();
      const attemptDeadline = startedAt + route.operations.deadlineMs;
      const outcome = await raceDispatch(dispatch, route, ordinal, attemptDeadline, route.operations.deadlineMs, timer, options.signal);
      const result = outcome.forced ? failedDispatch(outcome.forced) : outcome.result;
      const charged = result ? result.costMicros : null;
      // A failing release hook must not discard the attempt record; the receipt keeps the charge.
      try { await release(route, ordinal, charged); } catch { /* recorded below */ }
      spent = spent === null || charged === null ? null : spent + charged;
      body.budget = { limitMicros: limits.limitMicros, spentMicros: spent };

      if (!result) {
        body.attempts.push(attemptReceipt(ordinal, route, failedDispatch('failed'), 'invalid-result'));
        body.usage = aggregateUsage(body.attempts);
        stop('invalid-dispatch-result');
        break routes;
      }
      const substituted = result.status === 'success'
        && (result.actualProvider !== route.model.provider || result.actualModel !== route.model.pinnedVersion);
      body.attempts.push(attemptReceipt(ordinal, route, result, substituted ? 'substituted' : result.reason));
      body.usage = aggregateUsage(body.attempts);
      body.actual = { workerId: result.workerId, provider: result.actualProvider, model: result.actualModel };
      if (result.status === 'success') {
        if (substituted) stop(result.actualProvider === null || result.actualModel === null ? 'actual-model-unknown' : 'model-substitution');
        else if (spent === null) stop('cost-unknown');
        else if (spent > limits.limitMicros) stop('budget-exceeded');
        else {
          concluded = true;
          Object.assign(body, { status: 'selected', reason: 'deterministic-route', selectedRouteId: route.id,
            selectionReason: 'deterministic-authoritative', outcome: { verified: result.verified, label: result.outcomeLabel } });
        }
        break routes;
      }
      if (spent === null) { stop('cost-unknown'); break routes; }
      if (spent > limits.limitMicros) { stop('budget-exceeded'); break routes; }
      if (result.reason === 'cancelled') { stop('cancelled'); break routes; }
      if (CIRCUIT_REASONS.has(result.reason)) {
        openProviders.add(route.model.provider);
        body.fallbacks.push(route.id);
        continue routes;
      }
      if (result.reason !== 'timeout') { stop('dispatch-failed'); break routes; }
      if (triesOnRoute >= route.operations.maxAttempts) body.fallbacks.push(route.id);
    }
  }
  if (!concluded) stop(exhausted);
}

/** Races one dispatch against its attempt deadline and the caller's signal; a hung dispatch is aborted. */
async function raceDispatch(dispatch: NonNullable<RoutingRuntimeOptions['dispatch']>, candidate: RouteCandidate, attemptOrdinal: number,
  deadlineEpochMs: number, budgetMs: number, timer: NonNullable<RoutingRuntimeOptions['timer']>, parent: AbortSignal | undefined):
Promise<{ result: RoutingDispatchResult | null; forced: 'timeout' | 'cancelled' | 'rejected' | null }> {
  const controller = new AbortController();
  const timerControl = new AbortController();
  const onParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onParent, { once: true });
  type Outcome = { kind: 'result'; value: unknown } | { kind: 'rejected' } | { kind: 'timeout' } | { kind: 'cancelled' };
  const never = new Promise<never>(() => undefined);
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(dispatch({ candidate, attemptOrdinal, deadlineEpochMs, signal: controller.signal }));
  } catch (error) {
    pending = Promise.reject(error);
  }
  try {
    const outcome = await Promise.race<Outcome>([
      pending.then(value => ({ kind: 'result' as const, value }), () => ({ kind: 'rejected' as const })),
      Promise.resolve().then(() => timer(budgetMs, timerControl.signal)).then(() => ({ kind: 'timeout' as const }), () => never),
      new Promise<Outcome>(resolve => {
        if (controller.signal.aborted) resolve({ kind: 'cancelled' });
        controller.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
      }),
    ]);
    if (outcome.kind === 'timeout') controller.abort();
    if (outcome.kind === 'result') return { result: validDispatchResult(outcome.value) ? outcome.value : null, forced: null };
    return { result: null, forced: outcome.kind };
  } finally {
    timerControl.abort();
    parent?.removeEventListener('abort', onParent);
  }
}

async function counterfactual(policy: RoutingPolicy, task: RoutingTask, eligible: RoutingEligibleCandidate[], deterministicRouteId: string | null,
  options: RoutingRuntimeOptions): Promise<{ counterfactual: RoutingCounterfactual; jev: JevRoutingEvidence | null; projection: RoutingReceipt['task']['projection'] }> {
  const review = (reason: string, projection: RoutingReceipt['task']['projection'] = null, jev: JevRoutingEvidence | null = null) =>
    ({ counterfactual: { status: 'review' as const, reason, routeId: null, ranking: [] }, jev, projection });
  if (!policy.jevEvidence.enabled) return { counterfactual: notEvaluated('jev-evidence-disabled'), jev: null, projection: null };
  if (!options.evidence) return { counterfactual: notEvaluated('jev-evidence-unavailable'), jev: null, projection: null };
  if (!eligible.length) return { counterfactual: notEvaluated('empty-eligible-set'), jev: null, projection: null };
  if (options.signal?.aborted) return { counterfactual: notEvaluated('cancelled'), jev: null, projection: null };
  if (task.projection?.provider !== 'jev') return review('projection-denied');

  // D10: only declared state fields cross, then credential-shaped values are redacted. The task
  // description and every undeclared field stay behind.
  let projectedState: Readonly<Record<string, unknown>>;
  let projection: NonNullable<RoutingReceipt['task']['projection']>;
  try {
    const projected = await projectDecisionState(task.state, task.projection);
    projectedState = frozenRoutingClone(redactStructured(projected.state).value);
    projection = projected.evidence;
  } catch {
    return review('projection-denied');
  }

  let raw: unknown;
  const timerControl = new AbortController();
  try {
    raw = await Promise.race([
      Promise.resolve().then(() => options.evidence!({
        task: { id: task.id },
        projectedState,
        projection: frozenRoutingClone(projection),
        candidates: frozenRoutingClone(eligible.map(item => item.summary)),
      })),
      Promise.resolve().then(() => (options.timer ?? realTimer)(policy.ceilings.deadlineMs, timerControl.signal))
        .then(() => { throw new RoutingContractError('Jev evidence timed out'); }, () => new Promise<never>(() => undefined)),
    ]);
  } catch {
    return review('jev-evidence-unavailable', projection);
  } finally {
    timerControl.abort();
  }

  let evidence: JevRoutingEvidence;
  try {
    evidence = frozenRoutingClone(validateJevRoutingEvidence(raw));
  } catch {
    return review('malformed-jev-evidence', projection);
  }
  if (evidence.model !== task.projection.model) return review('malformed-jev-evidence', projection);
  const normalized: JevRoutingEvidence = {
    ...evidence,
    distributions: [...evidence.distributions].sort((a, b) => compareRoutingKeys(a.routeId, b.routeId)),
  };
  if (!policy.jevEvidence.compatibleProfiles.includes(evidence.profile)) return review('incompatible-profile', projection, normalized);
  if (evidence.calibration !== 'calibrated') return review('uncalibrated-evidence', projection, normalized);
  const ids = normalized.distributions.map(item => item.routeId);
  const eligibleIds = new Set(eligible.map(item => item.candidate.id));
  if (new Set(ids).size !== ids.length) return review('duplicate-jev-route', projection);
  if (ids.some(id => !eligibleIds.has(id))) return review('malformed-jev-evidence', projection);
  if (ids.length !== eligibleIds.size) return review('incomplete-jev-evidence', projection, normalized);
  if (Math.round(evidence.ambiguity * 10_000) > policy.jevEvidence.uncertaintyThresholdBps) {
    return deterministicRouteId
      ? { counterfactual: { status: 'deterministic-fallback', reason: 'ambiguous-evidence', routeId: deterministicRouteId, ranking: [] }, jev: normalized, projection }
      : review('ambiguous-evidence', projection, normalized);
  }
  const ranking = rankRoutes(policy, eligible, normalized).map(item => item.candidate.id);
  return { counterfactual: { status: 'selected', reason: 'deterministic-utility', routeId: ranking[0]!, ranking }, jev: normalized, projection };
}

/**
 * AC9 drill. Every drift response opens the Jev route circuit except a plain alert; `restore-champion`
 * also restores the prior pinned routing policy for new runs and rolls the D17 alias back. Active-run
 * pins are re-read after the response and must equal the pins read before it.
 */
export async function runRoutingControlDrill(input: RoutingControlDrillInput): Promise<RoutingControlDrillResult> {
  const { control } = input;
  const before = frozenRoutingClone(control.activeRunPins());
  const history = control.policyHistory();
  const previousPolicy = history[history.length - 1];
  if (!previousPolicy) throw new RoutingContractError('routing control has no current pinned policy');
  let restoredPolicy: RoutingPin | null = null;
  let rollbackEvent: AliasEvent | null = null;
  let jevCircuitOpen = false;
  const openCircuit = (reason: string) => { control.openJevCircuit(reason, input.at); jevCircuitOpen = true; };
  const contain = (action: string) => async () => { openCircuit(action); };
  const drift = await executeDriftResponse(input.driftPolicy, input.driftSignal, {
    'restore-champion': async () => {
      const prior = [...history].reverse().find(pin => pin.version !== previousPolicy.version || pin.digest !== previousPolicy.digest);
      if (!prior) throw new RoutingContractError('rollback requires a prior pinned routing policy');
      openCircuit('restore-champion');
      restoredPolicy = control.restorePolicy(prior, input.approvalReference, input.at);
      const current = control.policyHistory().at(-1);
      if (canonicalJson(restoredPolicy) !== canonicalJson(prior) || canonicalJson(current) !== canonicalJson(prior)) {
        throw new RoutingContractError('routing policy restore did not install the prior pinned policy');
      }
      rollbackEvent = rollbackChampionForNewRuns({
        record: input.championChallenger, gateway: input.gateway, approvalReference: input.approvalReference, at: input.at,
      });
    },
    alert: async () => undefined,
    'route-to-review': contain('route-to-review'),
    'reduce-coverage': contain('reduce-coverage'),
    'disable-challenger': contain('disable-challenger'),
    'require-recertification': contain('require-recertification'),
  });
  const after = control.activeRunPins();
  if (canonicalJson(after) !== canonicalJson(before)) throw new RoutingContractError('active run pins changed during the drift response');
  return { driftResponse: drift.executed, previousPolicy, restoredPolicy, rollbackEvent, jevCircuitOpen, activeRunPins: structuredClone([...after]) };
}

function notEvaluated(reason: string): RoutingCounterfactual {
  return { status: 'not-evaluated', reason, routeId: null, ranking: [] };
}

function safeTaskId(value: unknown): string | null {
  const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
  return typeof id === 'string' && NAME.test(id) ? id : null;
}

function candidatePins(policy: Pick<RoutingPolicy, 'candidates'>): RoutingReceipt['candidatePins'] {
  return [...policy.candidates].sort((a, b) => compareRoutingKeys(a.id, b.id)).map(candidate => ({
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

const FILESYSTEM_RANK = { none: 0, read: 1, write: 2 } as const;

/** Hard constraints. The authorization ceiling is two-sided: a route must hold what the task needs
 * and nothing its ordinary authorization does not already allow, so routing can never widen it. */
function exclusionReasons(candidate: RouteCandidate, task: RoutingTask, policy: RoutingPolicy): RoutingExclusionReason[] {
  const reasons: RoutingExclusionReason[] = [];
  const need = task.requirements;
  const held = candidate.permissions;
  const allowed = need.authorized;
  if (!candidate.policy.privacy.includes(need.privacy)) reasons.push('privacy-denied');
  if (need.authorizationScopes.some(scope => !candidate.policy.authorizationScopes.includes(scope))) reasons.push('authorization-denied');
  if (!candidate.policy.regions.includes(need.region)) reasons.push('region-denied');
  if (need.tools.some(tool => !held.tools.includes(tool))) reasons.push('tool-denied');
  if (candidate.policy.contextBytes < need.contextBytes) reasons.push('context-denied');
  if (!candidate.policy.allowlisted || !need.allowlist.includes(candidate.id)) reasons.push('allowlist-denied');
  if (candidate.operations.costMicrosPerAttempt === null || candidate.operations.costMicrosPerAttempt > Math.min(need.maxCostMicros, policy.ceilings.maxCostMicros)) reasons.push('budget-denied');
  if (candidate.operations.deadlineMs > Math.min(need.deadlineMs, policy.ceilings.deadlineMs)) reasons.push('deadline-denied');
  if (['outage', 'rate-limited', 'circuit-open'].includes(candidate.operations.health)) reasons.push('health-denied');
  if (!candidate.policy.executable) reasons.push('not-executable');
  if (need.capabilities.some(capability => !candidate.capabilities.includes(capability))) reasons.push('capability-denied');
  if (held.tools.some(tool => !allowed.tools.includes(tool)) || (held.network && !allowed.network)
    || FILESYSTEM_RANK[held.filesystem] > FILESYSTEM_RANK[allowed.filesystem]
    || held.secrets.some(secret => !allowed.secrets.includes(secret))
    || held.actions.some(action => !allowed.actions.includes(action))) reasons.push('permission-denied');
  if (!need.providers.includes(candidate.model.provider)) reasons.push('provider-denied');
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

/** Only called with complete, unique, finite, bounded evidence for every eligible route. */
function rankRoutes(policy: RoutingPolicy, eligible: RoutingEligibleCandidate[], evidence: JevRoutingEvidence): RoutingEligibleCandidate[] {
  const byRoute = new Map(evidence.distributions.map(item => [item.routeId, item]));
  const scored = eligible.map(item => ({ item, score: utility(policy, item.candidate, byRoute.get(item.candidate.id)!, evidence) }));
  return scored.sort((a, b) => b.score - a.score || compareRoutingKeys(a.item.candidate.id, b.item.candidate.id)).map(entry => entry.item);
}

function utility(policy: RoutingPolicy, candidate: RouteCandidate, evidence: JevRoutingEvidence['distributions'][number], all: JevRoutingEvidence): number {
  const healthPenalty = candidate.operations.health === 'degraded' ? 1 : 0;
  return evidence.taskFit * policy.utility.taskFit
    + (1 - Math.abs(all.taskComplexity - evidence.reasoningNeed)) * policy.utility.complexityFit
    - all.ambiguity * policy.utility.ambiguityPenalty
    - candidate.operations.latencyMsP95 * policy.utility.latencyPenalty
    - candidate.operations.costMicrosPerAttempt! * policy.utility.costPenalty
    - healthPenalty * policy.utility.healthPenalty;
}

function validDispatchResult(value: unknown): value is RoutingDispatchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { admitEntry(value); } catch { return false; }
  const record = value as Record<string, unknown>;
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson(RESULT_KEYS)) return false;
  const text = (item: unknown) => item === null || (typeof item === 'string' && NAME.test(item));
  const count = (item: unknown) => item === null || (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0);
  const statusOk = (record.status === 'success' && record.reason === 'none')
    || (record.status === 'failure' && typeof record.reason === 'string' && DISPATCH_FAILURES.has(record.reason));
  return statusOk && [record.actualProvider, record.actualModel, record.workerId, record.outcomeLabel].every(text)
    && [record.inputTokens, record.outputTokens, record.costMicros, record.latencyMs].every(count)
    && (record.verified === null || typeof record.verified === 'boolean');
}

function failedDispatch(reason: RoutingDispatchResult['reason']): RoutingDispatchResult {
  return { status: 'failure', reason, actualProvider: null, actualModel: null, workerId: null,
    inputTokens: null, outputTokens: null, costMicros: null, latencyMs: null, verified: null, outcomeLabel: null };
}

function attemptReceipt(ordinal: number, candidate: RouteCandidate, result: RoutingDispatchResult,
  reason: RouteAttemptReceipt['reason']): RouteAttemptReceipt {
  return {
    ordinal,
    routeId: candidate.id,
    status: result.status === 'success' ? 'succeeded' : 'failed',
    reason,
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

function realTimer(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('cancelled'));
    }, { once: true });
  });
}
