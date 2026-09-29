import type { AliasEvent, PromotionEligibility } from '../calibration/types.js';
import type { DecisionResult } from '../types.js';
import type { DecisionTelemetryHook, DecisionTelemetrySpan, TelemetryAttributes } from '../telemetry/types.js';
import { DECISION_TELEMETRY_SCHEMA_VERSION } from '../telemetry/types.js';
import { recordDecisionSpanMetrics, type BoundedDecisionMetrics } from '../telemetry/metrics.js';
import {
  championChallengerEligibilityProblems,
  compareEnsembleKeys,
  ensembleContractDigest,
  pairedThresholdsDigest,
  validateChampionChallenger,
  validateEnsemblePolicy,
  type EnsemblePolicyValidationOptions,
} from './contract.js';
import { aggregateEnsembleResults } from './aggregate.js';
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

  for (const member of [...policy.members].sort((a, b) => compareEnsembleKeys(a.id, b.id))) {
    if (options.authorizeMember && await options.authorizeMember(member) !== true) {
      throw new EnsembleRuntimeError(`ensemble member ${member.id} failed security/privacy/capability authorization`, 'member-disallowed');
    }
  }

  const now = options.now ?? Date.now;
  const deadlineEpochMs = now() + budget.effective.deadlineMs;
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(budget.effective.deadlineMs)]);
  const tasks = canonicalSamples(policy);
  const retainedResults: Record<string, DecisionResult> = {};
  let actualAttempts = 0;
  let actualTokens = 0;
  let actualCostMicros = 0;
  const memberResults = await runBounded(tasks, budget.effective.concurrency, async ({ member, sampleIndex }) => {
    if (signal.aborted || now() >= deadlineEpochMs) return syntheticMemberResult(policy, member, sampleIndex, 'timeout', retainedResults);
    const result = await options.dispatch({ policy, policyDigest, member: structuredClone(member), sampleIndex,
      invocationId: `${options.invocationId}:${member.id}:${sampleIndex}`, deadlineEpochMs, signal });
    const attempts = result.spec.attempts.length;
    actualAttempts += attempts;
    actualTokens += result.spec.attempts.reduce((sum, attempt) =>
      sum + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0), 0);
    const cost = result.spec.attempts.reduce((sum, attempt) => sum + (attempt.usage.costUsd ?? 0) * 1_000_000, 0);
    actualCostMicros += Math.round(cost);
    if (attempts > member.fallbackDepth + 1) {
      return syntheticMemberResult(policy, member, sampleIndex, 'fallback-depth-exceeded', retainedResults, result);
    }
    if (actualAttempts > budget.effective.attempts || actualTokens > budget.effective.tokens
      || actualCostMicros > budget.effective.costMicros || now() > deadlineEpochMs) {
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
  const { record } = validateChampionChallenger(input.record, { eligibility: input.eligibility, aliasHistory });
  const problems = championChallengerEligibilityProblems(record, input.eligibility);
  if (input.integrityReport.decision !== 'PROMOTE' || input.integrityReport.subject.id !== record.id
    || input.integrityReport.subject.digest !== ensembleContractDigest(record) || input.integrityReport.subject.eligibilityId !== record.eligibilityId
    || input.eligibility.eligible !== true || problems.length > 0) {
    throw new EnsembleRuntimeError('promotion requires eligible D09 state, verified eval-integrity and a pinned rollback target', 'promotion-gate');
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
  const { record } = validateChampionChallenger(input.record, { aliasHistory: input.gateway.aliasHistory((input.record as DecisionChampionChallenger).alias) });
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
  if (decision.response) await handlers[decision.response]?.(decision);
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
      reason: reason === 'timeout' ? 'timeout' as const : 'budget-exhausted' as const,
      uncertainty: null,
      attempts: [],
    },
  };
  return memberResultFromDecision(member, sampleIndex, {
    ...result,
    spec: { ...result.spec, status: 'error', value: undefined, uncertainty: null },
  }, retainedResults);
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
  const traceId = telemetry.traceId ?? '11111111111111111111111111111111';
  const spanId = spanIdFor(attributes);
  const clean = Object.fromEntries(Object.entries(attributes).filter(([, value]) =>
    value === null || ['string', 'number', 'boolean'].includes(typeof value))) as TelemetryAttributes;
  const span: DecisionTelemetrySpan = {
    schemaVersion: DECISION_TELEMETRY_SCHEMA_VERSION,
    name: 'decision.workflow',
    context: { traceId, spanId, traceFlags: '01' },
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

function spanIdFor(attributes: TelemetryAttributes): string {
  return ensembleContractDigest(attributes).slice('sha256:'.length, 'sha256:'.length + 16);
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
