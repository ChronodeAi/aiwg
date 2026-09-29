import type { AliasEvent, PromotionEligibility } from '../calibration/types.js';
import type { DecisionFailureReason, DecisionResult } from '../types.js';
import type { DecisionTelemetryHook, DecisionTelemetrySpan, TelemetryAttributes } from '../telemetry/types.js';
import { createTelemetryContext, randomTelemetryIds } from '../telemetry/context.js';
import { DECISION_TELEMETRY_SCHEMA_VERSION } from '../telemetry/types.js';
import { recordDecisionSpanMetrics, type BoundedDecisionMetrics } from '../telemetry/metrics.js';
import {
  championChallengerEligibilityProblems,
  compareEnsembleKeys,
  ensembleContractDigest,
  pairedThresholdsDigest,
  validateChampionChallenger,
  validateEnsembleIntegrityReport,
  validateEnsemblePolicy,
  type EnsemblePolicyValidationOptions,
} from './contract.js';
import { canonicalJson } from '../../security/artifact-trust.js';
import { assertDecisionResultWriterVersion } from '../validate.js';
import { aggregateEnsembleResults } from './aggregate.js';
import { buildEnsembleIntegrityReport } from './report.js';
import { resolveDriftResponse } from './drift.js';
import type {
  ChampionChallengerRolePin,
  DecisionChampionChallenger,
  DecisionDriftResponse,
  DecisionEnsembleAggregate,
  DecisionEnsembleIntegrityReport,
  DecisionEnsemblePolicy,
  DriftResponseAction,
  DriftResponseDecision,
  DriftSignal,
  EnsembleBudgetPlan,
  EnsembleDigest,
  EnsembleMember,
  EnsembleMemberResult,
  PairedDeltaObservation,
  PairedMetric,
} from './types.js';

export class EnsembleRuntimeError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'EnsembleRuntimeError';
  }
}

export interface EnsembleMemberDispatchRequest {
  policy: DecisionEnsemblePolicy;
  policyDigest: EnsembleDigest;
  member: EnsembleMember;
  sampleIndex: number;
  invocationId: string;
  deadlineEpochMs: number;
  signal: AbortSignal;
  /** Hard per-call limits: this sample's reservation. The ensemble ceilings hold only when the
   * dispatcher enforces them; reported usage above them is a budget violation that stops dispatch. */
  limits: { attempts: number; tokens: number; costMicros: number };
}

export interface EnsembleRuntimeTelemetry {
  hook?: DecisionTelemetryHook;
  metrics?: BoundedDecisionMetrics;
  traceId?: string;
  parentSpanId?: string | null;
}

export interface EnsembleExecutionOptions {
  enabled?: boolean;
  invocationId: string;
  dispatch: (request: EnsembleMemberDispatchRequest) => Promise<DecisionResult>;
  hostCeilings?: EnsemblePolicyValidationOptions['hostCeilings'];
  calibrationPins?: EnsemblePolicyValidationOptions['calibrationPins'];
  authorizeMember?: (member: EnsembleMember) => boolean | Promise<boolean>;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  telemetry?: EnsembleRuntimeTelemetry;
}

export interface EnsembleExecutionResult {
  status: 'disabled' | 'completed';
  reason: 'disabled' | 'policy-disabled' | 'completed';
  policyDigest: EnsembleDigest;
  budget: EnsembleBudgetPlan;
  aggregate: DecisionEnsembleAggregate | null;
  memberResults: EnsembleMemberResult[];
  retainedResults: Record<string, DecisionResult>;
}

export async function executeDecisionEnsemble(
  policyInput: unknown,
  options: EnsembleExecutionOptions,
): Promise<EnsembleExecutionResult> {
  const validated = validateEnsemblePolicy(policyInput, {
    hostCeilings: options.hostCeilings,
    calibrationPins: options.calibrationPins,
  });
  const { policy, digest: policyDigest, budget } = validated;
  if (options.enabled !== true || policy.mode === 'disabled') {
    emitEnsembleSpan(options.telemetry, options.now, {
      'aiwg.ensemble.id': policy.id,
      'aiwg.ensemble.version': policy.version,
      'aiwg.ensemble.mode': policy.mode,
      'aiwg.ensemble.status': 'disabled',
      'aiwg.ensemble.members': policy.members.length,
    });
    return {
      status: 'disabled',
      reason: options.enabled === true ? 'policy-disabled' : 'disabled',
      policyDigest,
      budget,
      aggregate: null,
      memberResults: [],
      retainedResults: {},
    };
  }

  if (!options.authorizeMember) {
    throw new EnsembleRuntimeError('ensemble member authorization callback is required before dispatch', 'member-authorization-missing');
  }
  for (const member of [...policy.members].sort((a, b) => compareEnsembleKeys(a.id, b.id))) {
    if (await options.authorizeMember(member) !== true) {
      throw new EnsembleRuntimeError(`ensemble member ${member.id} failed security/privacy/capability authorization`, 'member-disallowed');
    }
  }

  const now = options.now ?? Date.now;
  const deadlineEpochMs = now() + budget.effective.deadlineMs;
  const deadline = createDeadlineSignal(options.signal, budget.effective.deadlineMs, options.delay);
  const signal = deadline.signal;
  const tasks = canonicalSamples(policy);
  const retainedResults: Record<string, DecisionResult> = {};
  let actualAttempts = 0;
  let actualTokens = 0;
  let actualCostMicros = 0;
  let inFlightAttempts = 0;
  let inFlightTokens = 0;
  let inFlightCostMicros = 0;
  const dispatchedMembers = new Set<string>();
  let exhausted = false;
  const reservations = new Map(budget.reservations.map(item => [`${item.memberId}:${item.sampleIndex}`, item]));
  try {
    const memberResults = await runBounded(tasks, budget.effective.concurrency, async ({ member, sampleIndex }) => {
      if (signal.aborted || now() >= deadlineEpochMs) return syntheticMemberResult(policy, member, sampleIndex, 'timeout', retainedResults);
      if (exhausted) return syntheticMemberResult(policy, member, sampleIndex, 'budget-exhausted', retainedResults);
      // Reserve before dispatch against what is already spent plus every in-flight reservation.
      const reservation = reservations.get(`${member.id}:${sampleIndex}`);
      if (!reservation
        || (!dispatchedMembers.has(member.id) && dispatchedMembers.size + 1 > budget.effective.members)
        || actualAttempts + inFlightAttempts + reservation.attempts > budget.effective.attempts
        || actualTokens + inFlightTokens + reservation.tokens > budget.effective.tokens
        || actualCostMicros + inFlightCostMicros + reservation.costMicros > budget.effective.costMicros) {
        exhausted = true;
        return syntheticMemberResult(policy, member, sampleIndex, 'budget-exhausted', retainedResults);
      }
      dispatchedMembers.add(member.id);
      inFlightAttempts += reservation.attempts;
      inFlightTokens += reservation.tokens;
      inFlightCostMicros += reservation.costMicros;
      let settled = false;
      /** Moves the reservation into actual spend. Without trusted usage the full reserved bound is charged. */
      const settle = (usage: { attempts: number; tokens: number; costMicros: number } = reservation) => {
        if (settled) return;
        settled = true;
        inFlightAttempts -= reservation.attempts;
        inFlightTokens -= reservation.tokens;
        inFlightCostMicros -= reservation.costMicros;
        actualAttempts += usage.attempts;
        actualTokens += usage.tokens;
        actualCostMicros += usage.costMicros;
      };

      let result: DecisionResult;
      try {
        result = await dispatchWithDeadline(options.dispatch({
          policy, policyDigest, member: structuredClone(member), sampleIndex,
          invocationId: `${options.invocationId}:${member.id}:${sampleIndex}`, deadlineEpochMs, signal,
          limits: { attempts: reservation.attempts, tokens: reservation.tokens, costMicros: reservation.costMicros },
        }), signal);
      } catch (error) {
        // A timed-out or rejected dispatch may still have spent its reservation; it is never refunded.
        settle();
        const reason = signal.aborted || now() >= deadlineEpochMs || (error instanceof EnsembleRuntimeError && error.reason === 'timeout')
          ? 'timeout' : 'dispatch-error';
        if (reason === 'timeout') exhausted = true;
        return syntheticMemberResult(policy, member, sampleIndex, reason, retainedResults);
      }
      try {
        assertDecisionResultWriterVersion(result);
        if (result.kind !== 'DecisionResult') throw new EnsembleRuntimeError('ensemble member must return a DecisionResult', 'invalid-output');
      } catch {
        settle();
        return syntheticMemberResult(policy, member, sampleIndex, 'invalid-output', retainedResults);
      }

      const attempts = result.spec.attempts.length;
      const tokens = result.spec.attempts.reduce((sum, attempt) =>
        sum + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0), 0);
      const cost = resultCostMicros(policy, result);
      if (cost === null) {
        settle({ attempts: Math.max(attempts, reservation.attempts), tokens: Math.max(tokens, reservation.tokens), costMicros: reservation.costMicros });
        exhausted = true;
        return syntheticMemberResult(policy, member, sampleIndex, 'unknown-cost', retainedResults, result);
      }
      settle({ attempts, tokens, costMicros: cost });
      if (attempts > member.fallbackDepth + 1) {
        return syntheticMemberResult(policy, member, sampleIndex, 'fallback-depth-exceeded', retainedResults, result);
      }
      if (attempts > reservation.attempts || tokens > reservation.tokens || cost > reservation.costMicros
        || actualAttempts > budget.effective.attempts || actualTokens > budget.effective.tokens
        || actualCostMicros > budget.effective.costMicros || now() > deadlineEpochMs) {
        exhausted = true;
        return syntheticMemberResult(policy, member, sampleIndex, 'budget-exhausted', retainedResults, result);
      }
      return memberResultFromDecision(member, sampleIndex, result, retainedResults);
    });

    const aggregate = aggregateEnsembleResults(policy, memberResults, {
      hostCeilings: options.hostCeilings,
      calibrationPins: options.calibrationPins,
    });
    emitEnsembleSpan(options.telemetry, options.now, {
      'aiwg.ensemble.id': policy.id,
      'aiwg.ensemble.version': policy.version,
      'aiwg.ensemble.mode': policy.mode,
      'aiwg.ensemble.status': 'completed',
      'aiwg.ensemble.members': policy.members.length,
      'aiwg.ensemble.disagreement_bps': aggregate.disagreement.valueBps,
      'aiwg.ensemble.outcome': aggregate.outcome.disposition,
      'aiwg.budget.attempts.planned': budget.demand.attempts,
      'aiwg.budget.attempts.actual': actualAttempts,
      'aiwg.budget.tokens.actual': actualTokens,
      'aiwg.budget.cost_micros.actual': actualCostMicros,
    });
    return { status: 'completed', reason: 'completed', policyDigest, budget, aggregate, memberResults, retainedResults };
  } finally {
    deadline.cancel();
  }
}

export interface ShadowInputItem {
  id: string;
  input: unknown;
  slice?: string;
}

export interface ChampionChallengerObservation {
  inputDigest: EnsembleDigest;
  receiptDigest: EnsembleDigest;
  quality: number | null;
  calibration: number | null;
  riskCoverage: number | null;
  abstention: number | null;
  latencyMs: number | null;
  tokens: number | null;
  costMicros: number | null;
  slice: number | null;
}

export interface ChampionChallengerShadowOptions {
  enabled?: boolean;
  invocationId: string;
  items: readonly ShadowInputItem[];
  evaluate: (request: {
    role: 'champion' | 'challenger';
    rolePin: ChampionChallengerRolePin;
    item: ShadowInputItem;
    invocationId: string;
    signal: AbortSignal;
  }) => Promise<ChampionChallengerObservation>;
  eligibility?: PromotionEligibility;
  aliasHistory?: readonly AliasEvent[];
  now?: () => number;
  signal?: AbortSignal;
  telemetry?: EnsembleRuntimeTelemetry;
}

export interface ChampionChallengerShadowResult {
  status: 'disabled' | 'completed';
  recordDigest: EnsembleDigest;
  pairedDeltas: PairedDeltaObservation[];
  receipts: Array<{ itemId: string; champion: EnsembleDigest; challenger: EnsembleDigest }>;
}

export function championChallengerInputSetDigest(items: readonly ShadowInputItem[]): EnsembleDigest {
  return ensembleContractDigest(items.map(item => ({
    id: item.id,
    inputDigest: ensembleContractDigest(item.input),
    ...(item.slice ? { slice: item.slice } : {}),
  })).sort((a, b) => compareEnsembleKeys(a.id, b.id)));
}

/** Shadow binding a #2037/#2048 integrity report must carry at `paired_baseline.championChallengerShadow`
 * (alongside any upstream paired-baseline fields) for its paired deltas to be promotable. It binds the deltas and per-item receipts of one completed shadow run to the record's
 * stable identity fields (not its whole digest, which pins the integrity report itself). */
export interface ChampionChallengerShadowBaseline {
  kind: 'decision-champion-challenger-shadow/v1';
  recordId: string;
  inputSetDigest: EnsembleDigest;
  thresholdsDigest: EnsembleDigest;
  championIdentityDigest: EnsembleDigest;
  challengerIdentityDigest: EnsembleDigest;
  pairedDeltasDigest: EnsembleDigest;
  receiptsDigest: EnsembleDigest;
}

export function championChallengerShadowBaseline(
  recordInput: unknown,
  shadow: Pick<ChampionChallengerShadowResult, 'status' | 'pairedDeltas' | 'receipts'>,
): ChampionChallengerShadowBaseline {
  const { record } = validateChampionChallenger(recordInput);
  const items = new Set(shadow.receipts.map(receipt => receipt.itemId));
  if (shadow.status !== 'completed' || shadow.receipts.length !== record.inputSet.itemCount || items.size !== shadow.receipts.length) {
    throw new EnsembleRuntimeError('a shadow baseline needs one completed receipt per frozen input item', 'shadow-incomplete');
  }
  return {
    ...shadowBaselineIdentity(record),
    pairedDeltasDigest: pairedDeltasDigest(shadow.pairedDeltas),
    receiptsDigest: ensembleContractDigest([...shadow.receipts].sort((a, b) => compareEnsembleKeys(a.itemId, b.itemId))),
  };
}

function shadowBaselineIdentity(record: DecisionChampionChallenger): Omit<ChampionChallengerShadowBaseline, 'pairedDeltasDigest' | 'receiptsDigest'> {
  return {
    kind: 'decision-champion-challenger-shadow/v1',
    recordId: record.id,
    inputSetDigest: record.inputSet.digest,
    thresholdsDigest: record.preregistration.thresholdsDigest,
    championIdentityDigest: record.champion.identityDigest,
    challengerIdentityDigest: record.challenger.identityDigest,
  };
}

function pairedDeltasDigest(deltas: readonly PairedDeltaObservation[]): EnsembleDigest {
  return ensembleContractDigest(deltas.map(item => ({ metric: item.metric, delta: item.delta, pairs: item.pairs }))
    .sort((a, b) => compareEnsembleKeys(a.metric, b.metric)));
}

/** The alias's current revision: the event with the highest revision. */
function currentAliasEvent(history: readonly AliasEvent[]): AliasEvent | undefined {
  return history.reduce<AliasEvent | undefined>((latest, event) => !latest || event.revision > latest.revision ? event : latest, undefined);
}

export async function runChampionChallengerShadow(
  recordInput: unknown,
  options: ChampionChallengerShadowOptions,
): Promise<ChampionChallengerShadowResult> {
  const { record, digest } = validateChampionChallenger(recordInput, {
    ...(options.eligibility ? { eligibility: options.eligibility } : {}),
    ...(options.aliasHistory ? { aliasHistory: options.aliasHistory } : {}),
  });
  if (options.enabled !== true) {
    emitEnsembleSpan(options.telemetry, options.now, {
      'aiwg.ensemble.champion_challenger.id': record.id,
      'aiwg.ensemble.champion_challenger.status': 'disabled',
      'aiwg.ensemble.alias': record.alias,
    });
    return { status: 'disabled', recordDigest: digest, pairedDeltas: [], receipts: [] };
  }
  if (options.items.length !== record.inputSet.itemCount || championChallengerInputSetDigest(options.items) !== record.inputSet.digest) {
    throw new EnsembleRuntimeError('shadow input set does not match the immutable champion/challenger record', 'input-set-mismatch');
  }
  const signal = options.signal ?? new AbortController().signal;
  const pairs: Array<{ item: ShadowInputItem; champion: ChampionChallengerObservation; challenger: ChampionChallengerObservation }> = [];
  for (const item of options.items) {
    const before = ensembleContractDigest(item.input);
    const [champion, challenger] = await Promise.all([
      options.evaluate({ role: 'champion', rolePin: structuredClone(record.champion), item: structuredClone(item),
        invocationId: `${options.invocationId}:${item.id}:champion`, signal }),
      options.evaluate({ role: 'challenger', rolePin: structuredClone(record.challenger), item: structuredClone(item),
        invocationId: `${options.invocationId}:${item.id}:challenger`, signal }),
    ]);
    const after = ensembleContractDigest(item.input);
    if (before !== after || champion.inputDigest !== before || challenger.inputDigest !== before) {
      throw new EnsembleRuntimeError('champion and challenger must evaluate identical immutable inputs', 'input-mutated');
    }
    pairs.push({ item, champion, challenger });
  }
  const pairedDeltas = record.pairedMetrics.map(threshold => observationDelta(threshold.metric, pairs));
  emitEnsembleSpan(options.telemetry, options.now, {
    'aiwg.ensemble.champion_challenger.id': record.id,
    'aiwg.ensemble.champion_challenger.status': 'completed',
    'aiwg.ensemble.alias': record.alias,
    'aiwg.ensemble.role': 'paired-shadow',
    'aiwg.ensemble.pairs': pairs.length,
  });
  return {
    status: 'completed',
    recordDigest: digest,
    pairedDeltas,
    receipts: pairs.map(pair => ({ itemId: pair.item.id, champion: pair.champion.receiptDigest, challenger: pair.challenger.receiptDigest })),
  };
}

export interface ChampionAliasGateway {
  aliasHistory(alias: string): readonly AliasEvent[];
  /** D09's stored eligibility record, the one `promoteAlias` acts on (`CalibrationRegistry.promotionEligibility`). */
  promotionEligibility(eligibilityId: string): PromotionEligibility | null;
  promoteAlias(eligibilityId: string, at: string): AliasEvent;
  rollbackAlias(alias: string, targetRevision: number, approvalReference: string, at: string): AliasEvent;
}

export interface ChampionRunPin {
  runId: string;
  alias: string;
  aliasRevision: number;
  identityDigest: EnsembleDigest;
  actualModel: string;
}

export function pinChampionForRun(recordInput: unknown, runId: string): ChampionRunPin {
  const { record } = validateChampionChallenger(recordInput);
  return {
    runId,
    alias: record.alias,
    aliasRevision: record.champion.aliasRevision,
    identityDigest: record.champion.identityDigest,
    actualModel: record.champion.actualModel,
  };
}

export function promoteChampionChallenger(input: {
  record: unknown;
  integrityReport: DecisionEnsembleIntegrityReport;
  eligibility: PromotionEligibility;
  gateway: ChampionAliasGateway;
  at: string;
  telemetry?: EnsembleRuntimeTelemetry;
  now?: () => number;
}): AliasEvent {
  const aliasHistory = input.gateway.aliasHistory((input.record as DecisionChampionChallenger).alias);
  const { record, digest } = validateChampionChallenger(input.record, { eligibility: input.eligibility, aliasHistory });
  // The gateway promotes D09's stored record, so that is the one that must have been validated.
  const stored = input.gateway.promotionEligibility(record.eligibilityId);
  if (!stored || canonicalJson(stored) !== canonicalJson(input.eligibility)) {
    throw new EnsembleRuntimeError('supplied eligibility does not match the D09 stored promotion eligibility', 'promotion-eligibility-mismatch');
  }
  const current = currentAliasEvent(aliasHistory);
  if (!current || current.kind === 'retired' || current.revision !== record.champion.aliasRevision
    || current.actualIdentityDigest !== record.champion.identityDigest) {
    throw new EnsembleRuntimeError('alias no longer holds the champion this record pins', 'promotion-stale-champion');
  }
  if (aliasHistory.some(event => event.promotionEligibilityId === record.eligibilityId)) {
    throw new EnsembleRuntimeError(`promotion eligibility ${record.eligibilityId} was already used`, 'promotion-replayed');
  }
  const report = validateEnsembleIntegrityReport(input.integrityReport);
  // Never trust the supplied report's findings, flags or decision: rebuild it from the trusted
  // record, D09 eligibility and alias history, and require the exact same canonical report.
  const rebuilt = buildEnsembleIntegrityReport({
    record, integrity: report.integrity, eligibility: input.eligibility, aliasHistory,
    pairedDeltas: report.pairedDeltas.map(item => ({ metric: item.metric, delta: item.delta, pairs: item.pairs })),
  });
  if (canonicalJson(rebuilt) !== canonicalJson(report)) {
    throw new EnsembleRuntimeError('integrity report does not match the report rebuilt from the trusted record', 'promotion-report-mismatch');
  }
  const problems = championChallengerEligibilityProblems(record, input.eligibility);
  if (report.decision !== 'PROMOTE' || report.subject.id !== record.id
    || report.subject.digest !== digest || report.subject.eligibilityId !== record.eligibilityId
    || input.eligibility.eligible !== true || problems.length > 0) {
    throw new EnsembleRuntimeError('promotion requires eligible D09 state, verified eval-integrity and a pinned rollback target', 'promotion-gate');
  }
  if (ensembleContractDigest(report.integrity) !== record.evaluationIntegrityReport.digest) {
    throw new EnsembleRuntimeError('integrity fields do not match the record\'s pinned evaluation-integrity report digest', 'promotion-integrity-binding');
  }
  const pairedBaseline = report.integrity.paired_baseline as { championChallengerShadow?: unknown } | null;
  const baseline = pairedBaseline && typeof pairedBaseline === 'object' ? pairedBaseline.championChallengerShadow : null;
  const { receiptsDigest, ...boundFields } = (baseline && typeof baseline === 'object' ? baseline : {}) as Partial<ChampionChallengerShadowBaseline>;
  if (canonicalJson(boundFields) !== canonicalJson({ ...shadowBaselineIdentity(record), pairedDeltasDigest: pairedDeltasDigest(report.pairedDeltas) })
    || typeof receiptsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(receiptsDigest)) {
    throw new EnsembleRuntimeError('paired deltas are not bound to a completed shadow run for this record', 'promotion-shadow-unbound');
  }
  const event = input.gateway.promoteAlias(record.eligibilityId, input.at);
  emitEnsembleSpan(input.telemetry, input.now, {
    'aiwg.ensemble.champion_challenger.id': record.id,
    'aiwg.ensemble.alias': record.alias,
    'aiwg.ensemble.promotion': 'promoted',
    'aiwg.ensemble.rollback_revision': record.rollbackTarget.aliasRevision,
  });
  return event;
}

export function rollbackChampionForNewRuns(input: {
  record: unknown;
  gateway: ChampionAliasGateway;
  approvalReference: string;
  at: string;
  telemetry?: EnsembleRuntimeTelemetry;
  now?: () => number;
}): AliasEvent {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,127}$/.test(input.approvalReference)) {
    throw new EnsembleRuntimeError('rollback requires a non-empty valid approval reference', 'rollback-approval-reference');
  }
  const aliasHistory = input.gateway.aliasHistory((input.record as DecisionChampionChallenger).alias);
  const { record } = validateChampionChallenger(input.record, { aliasHistory });
  // Only undo this record's own promotion: the alias's current revision must be the promoted
  // challenger, and the revision it replaced must be the pinned champion (the rollback target).
  const current = currentAliasEvent(aliasHistory);
  const replaced = current && currentAliasEvent(aliasHistory.filter(event => event.revision < current.revision));
  if (!current || current.kind !== 'promoted' || current.alias !== record.alias || current.promotionEligibilityId !== record.eligibilityId
    || current.actualIdentityDigest !== record.challenger.identityDigest || current.actualModel !== record.challenger.actualModel) {
    throw new EnsembleRuntimeError('rollback requires the alias to currently hold this record\'s promoted challenger', 'rollback-not-promoted');
  }
  if (!replaced || replaced.revision !== record.rollbackTarget.aliasRevision || replaced.actualIdentityDigest !== record.rollbackTarget.identityDigest) {
    throw new EnsembleRuntimeError('rollback requires the promotion to have directly replaced the pinned champion', 'rollback-champion-mismatch');
  }
  const event = input.gateway.rollbackAlias(record.alias, record.rollbackTarget.aliasRevision, input.approvalReference, input.at);
  emitEnsembleSpan(input.telemetry, input.now, {
    'aiwg.ensemble.champion_challenger.id': record.id,
    'aiwg.ensemble.alias': record.alias,
    'aiwg.ensemble.rollback': 'restored-champion',
    'aiwg.ensemble.rollback_revision': record.rollbackTarget.aliasRevision,
  });
  return event;
}

export interface DriftRuntimeHandlers {
  [action: string]: ((decision: DriftResponseDecision) => void | Promise<void>) | undefined;
}

export async function executeDriftResponse(
  policyInput: DecisionDriftResponse,
  signal: DriftSignal,
  handlers: DriftRuntimeHandlers = {},
  telemetry?: EnsembleRuntimeTelemetry,
  now?: () => number,
): Promise<{ decision: DriftResponseDecision; executed: DriftResponseAction | null }> {
  const decision = resolveDriftResponse(policyInput, signal);
  if (decision.response) {
    const handler = handlers[decision.response];
    if (!handler) throw new EnsembleRuntimeError(`drift response ${decision.response} has no registered handler`, 'drift-handler-missing');
    await handler(decision);
  }
  emitEnsembleSpan(telemetry, now, {
    'aiwg.ensemble.drift.signal_id': decision.signalId,
    'aiwg.ensemble.drift.source': decision.source,
    'aiwg.ensemble.drift.metric': decision.metric,
    'aiwg.ensemble.drift.state': decision.state,
    'aiwg.ensemble.drift.response': decision.response,
    'aiwg.drift.value': signal.source === 'alias-drift' ? 1 : signal.valueBps,
  });
  return { decision, executed: decision.response };
}

function createDeadlineSignal(
  parent: AbortSignal | undefined,
  deadlineMs: number,
  delay: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = new AbortController();
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const wait = delay ?? defaultDelay;
  void wait(deadlineMs, timer.signal).then(abort, () => undefined);
  return {
    signal: controller.signal,
    cancel: () => {
      timer.abort();
      parent?.removeEventListener('abort', abort);
    },
  };
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('cancelled'));
    }, { once: true });
  });
}

function dispatchWithDeadline(result: Promise<DecisionResult>, signal: AbortSignal): Promise<DecisionResult> {
  if (signal.aborted) return Promise.reject(new EnsembleRuntimeError('ensemble dispatch deadline exceeded', 'timeout'));
  return Promise.race([result, new Promise<DecisionResult>((_, reject) => {
    signal.addEventListener('abort', () => reject(new EnsembleRuntimeError('ensemble dispatch deadline exceeded', 'timeout')), { once: true });
  })]);
}

function canonicalSamples(policy: DecisionEnsemblePolicy): Array<{ member: EnsembleMember; sampleIndex: number }> {
  return [...policy.members].sort((a, b) => compareEnsembleKeys(a.id, b.id))
    .flatMap(member => Array.from({ length: member.samples }, (_, sampleIndex) => ({ member, sampleIndex })));
}

async function runBounded<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

function memberResultFromDecision(
  member: EnsembleMember,
  sampleIndex: number,
  result: DecisionResult,
  retainedResults: Record<string, DecisionResult>,
): EnsembleMemberResult {
  const digest = ensembleContractDigest(result);
  retainedResults[digest] = structuredClone(result);
  return {
    memberId: member.id,
    sampleIndex,
    status: result.spec.status === 'success' ? 'succeeded' : result.spec.status === 'abstained' ? 'abstained' : 'failed',
    resultDigest: digest,
    value: result.spec.status === 'success' ? result.spec.value ?? null : null,
    distribution: result.spec.status === 'success' ? result.spec.uncertainty?.distribution ?? null : null,
    uncertaintyProfile: result.spec.status === 'success' ? result.spec.uncertainty?.profile ?? null : null,
  };
}

function syntheticMemberResult(
  policy: DecisionEnsemblePolicy,
  member: EnsembleMember,
  sampleIndex: number,
  reason: string,
  retainedResults: Record<string, DecisionResult>,
  source?: DecisionResult,
): EnsembleMemberResult {
  const failureReason = syntheticFailureReason(reason);
  const result = source ? structuredClone(source) : {
    apiVersion: 'decision.aiwg.io/v1alpha1' as const,
    kind: 'DecisionResult' as const,
    metadata: { id: `${policy.id}:${member.id}:${sampleIndex}`, version: policy.version, description: reason },
    spec: {
      decision: member.definition,
      ruleset: member.definition,
      binding: member.binding,
      alias: member.id,
      runId: policy.id,
      invocationId: `${policy.id}:${member.id}:${sampleIndex}`,
      status: 'error' as const,
      reason: failureReason,
      uncertainty: null,
      attempts: [syntheticAttempt(member, failureReason)],
    },
  };
  const { value: _value, uncertainty: _uncertainty, ...spec } = result.spec;
  return memberResultFromDecision(member, sampleIndex, {
    ...result,
    spec: { ...spec, status: 'error', reason: failureReason, uncertainty: null },
  }, retainedResults);
}

function syntheticAttempt(member: EnsembleMember, reason: DecisionFailureReason): DecisionResult['spec']['attempts'][number] {
  return {
    ordinal: 1,
    adapter: member.adapter.id,
    adapterVersion: member.adapter.version,
    requestedModel: member.model.requested,
    actualModel: null,
    subagent: null,
    status: 'error',
    reason,
    durationMs: 0,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
    requestId: null,
  };
}

function syntheticFailureReason(reason: string): DecisionFailureReason {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'invalid-output') return 'invalid-output';
  if (reason === 'dispatch-error') return 'service-error';
  return 'budget-exhausted';
}

function resultCostMicros(policy: DecisionEnsemblePolicy, result: DecisionResult): number | null {
  let cost = 0;
  for (const attempt of result.spec.attempts) {
    if (attempt.usage.costUsd === null) {
      if (policy.ceilings.unknownCost.rule === 'reject') return null;
      cost += policy.ceilings.unknownCost.boundMicrosPerAttempt;
    } else {
      cost += Math.round(attempt.usage.costUsd * 1_000_000);
    }
  }
  return cost;
}

type ObservationMetricKey = 'quality' | 'calibration' | 'riskCoverage' | 'abstention' | 'latencyMs' | 'tokens' | 'costMicros' | 'slice';

function observationDelta(metric: PairedMetric, pairs: ReadonlyArray<{
  champion: ChampionChallengerObservation;
  challenger: ChampionChallengerObservation;
}>): PairedDeltaObservation {
  const key = metricKey(metric);
  const deltas = pairs.map(pair => {
    const champion = pair.champion[key];
    const challenger = pair.challenger[key];
    return champion === null || challenger === null ? null : challenger - champion;
  }).filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    metric,
    delta: deltas.length ? round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length) : null,
    pairs: deltas.length,
  };
}

function metricKey(metric: PairedMetric): ObservationMetricKey {
  if (metric === 'risk-coverage') return 'riskCoverage';
  if (metric === 'latency') return 'latencyMs';
  if (metric === 'cost') return 'costMicros';
  return metric;
}

function round(value: number): number { return Math.round(value * 1e12) / 1e12; }

function emitEnsembleSpan(telemetry: EnsembleRuntimeTelemetry | undefined, nowInput: (() => number) | undefined, attributes: TelemetryAttributes): void {
  if (!telemetry?.hook && !telemetry?.metrics) return;
  const now = nowInput ?? Date.now;
  const at = now();
  const context = telemetryContext(telemetry.traceId);
  const clean = Object.fromEntries(Object.entries(attributes).filter(([, value]) =>
    value === null || ['string', 'number', 'boolean'].includes(typeof value))) as TelemetryAttributes;
  const span: DecisionTelemetrySpan = {
    schemaVersion: DECISION_TELEMETRY_SCHEMA_VERSION,
    name: 'decision.workflow',
    context,
    parentSpanId: telemetry.parentSpanId ?? null,
    startTimeUnixMs: at,
    endTimeUnixMs: at,
    status: 'ok',
    attributes: clean,
    provenance: Object.fromEntries(Object.keys(clean).map(key => [key, 'client-derived' as const])),
    links: [],
    events: [],
  };
  try { if (telemetry.metrics) recordDecisionSpanMetrics(span, telemetry.metrics); } catch { /* observability never controls runtime */ }
  try { void telemetry.hook?.emit(span); } catch { /* observability never controls runtime */ }
}

function telemetryContext(traceId: string | undefined): DecisionTelemetrySpan['context'] {
  try {
    return createTelemetryContext({
      traceId: () => traceId ?? randomTelemetryIds.traceId(),
      spanId: () => randomTelemetryIds.spanId(),
    });
  } catch {
    return createTelemetryContext(randomTelemetryIds);
  }
}

export function preregisterChampionChallengerThresholds(record: DecisionChampionChallenger): DecisionChampionChallenger {
  return {
    ...record,
    preregistration: {
      ...record.preregistration,
      thresholdsDigest: pairedThresholdsDigest(record.pairedMetrics),
    },
  };
}
