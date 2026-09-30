import { canonicalJson } from '../../security/artifact-trust.js';
import { ensembleIntegrityDecision, integrityMetadataFindings } from '../ensemble/contract.js';
import { pairedBinaryDifferenceInterval, pairedNonInferiority, type PairedDifferenceInterval } from '../qualification/quality.js';
import type { RoutingDigest, RoutingEvalIntegrityMetadata, RoutingPreregistration, RoutingPromotionThresholds,
  RoutingShadowArmObservation, RoutingShadowArmSummary, RoutingShadowReport } from './types.js';
import { checkRoutingSchema, compareRoutingKeys, RoutingContractError, routingDigest, verifyRoutingPreregistration } from './contract.js';

export interface RoutingShadowReportInput {
  id: string;
  preregistration: RoutingPreregistration;
  /** Anchored outside the report (e.g. a signed registry); a caller-built preregistration cannot attest itself. */
  trustedPreregistrationDigest: RoutingDigest;
  holdoutAccessedAt: string | null;
  evaluatedAt: string;
  observations: readonly RoutingShadowArmObservation[];
  integrity: RoutingEvalIntegrityMetadata;
}

const ARMS = ['fixed', 'heuristic', 'jev-assisted'] as const;

/**
 * Paired held-out comparison. PROMOTE requires a trusted preregistration, registeredAt <
 * holdoutAccessedAt <= evaluatedAt, every registered task observed exactly once per arm with its
 * registered slice, the shared paired non-inferiority interval, every preregistered rate, latency,
 * provider-call, budget and risk-adjusted economics gate, and the shared #2037/#2048 integrity
 * findings. The upstream integrity HOLD/ROLLBACK is never upgraded.
 */
export function buildRoutingShadowReport(input: RoutingShadowReportInput): RoutingShadowReport {
  const report = computeRoutingShadowReport(input);
  checkRoutingSchema('shadowReport', report);
  return report;
}

/** Rebuilds the report from its carried inputs against a trusted preregistration digest and requires
 * canonical equality, so a rewritten decision, reason or metric is rejected even with a fresh digest. */
export function validateRoutingShadowReport(value: unknown, trustedPreregistrationDigest: RoutingDigest): RoutingShadowReport {
  checkRoutingSchema('shadowReport', value);
  const report = value as RoutingShadowReport;
  const rebuilt = computeRoutingShadowReport({
    id: report.id, preregistration: report.preregistration, trustedPreregistrationDigest,
    holdoutAccessedAt: report.holdoutAccessedAt, evaluatedAt: report.evaluatedAt,
    observations: report.observations, integrity: report.integrity,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(report)) {
    throw new RoutingContractError('routing shadow report does not match the report rebuilt from its inputs', 'semantic');
  }
  return report;
}

function computeRoutingShadowReport(input: RoutingShadowReportInput): RoutingShadowReport {
  const preregistration = verifyRoutingPreregistration(input.preregistration, input.trustedPreregistrationDigest);
  const { thresholds, baselineArm } = preregistration;
  for (const item of input.observations ?? []) checkRoutingSchema('observation', item);
  const observations = [...(input.observations ?? [])].map(item => ({ ...item }))
    .sort((a, b) => compareRoutingKeys(a.taskId, b.taskId) || compareRoutingKeys(a.arm, b.arm));
  const reasons = new Set<string>();

  const registeredAt = Date.parse(preregistration.registeredAt);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const holdoutAt = input.holdoutAccessedAt === null ? null : Date.parse(input.holdoutAccessedAt);
  if (!Number.isFinite(evaluatedAt) || (holdoutAt !== null && !Number.isFinite(holdoutAt))) throw new RoutingContractError('report timestamps are invalid');
  if (holdoutAt === null) reasons.add('holdout-not-accessed');
  else {
    if (holdoutAt <= registeredAt) reasons.add('holdout-before-registration');
    if (evaluatedAt < holdoutAt) reasons.add('evaluated-before-holdout');
  }

  // Pairing: every registered task exactly once per arm, with its registered slice.
  const registered = new Map(preregistration.tasks.map(item => [item.id, item.slice]));
  const byArm = new Map(ARMS.map(arm => [arm, new Map<string, RoutingShadowArmObservation>()]));
  let unpaired = false;
  for (const item of observations) {
    const arm = byArm.get(item.arm)!;
    if (!registered.has(item.taskId)) { reasons.add('unregistered-task'); unpaired = true; continue; }
    if (arm.has(item.taskId)) { unpaired = true; continue; }
    if (registered.get(item.taskId) !== item.slice) reasons.add('slice-mismatch');
    arm.set(item.taskId, item);
  }
  for (const arm of byArm.values()) if (arm.size !== registered.size) unpaired = true;
  if (unpaired) reasons.add('unpaired-arms');
  const pairedIds = preregistration.tasks.map(item => item.id).filter(id => ARMS.every(arm => byArm.get(arm)!.has(id)));
  const pairedN = unpaired ? 0 : pairedIds.length;

  const arms = ARMS.map(arm => summarizeArm(arm, [...byArm.get(arm)!.values()], thresholds));
  const baseline = arms.find(item => item.arm === baselineArm)!;
  const candidate = arms.find(item => item.arm === 'jev-assisted')!;

  if (pairedN < thresholds.minimumOverallN) reasons.add('insufficient-overall-sample');
  for (const slice of [...new Set(preregistration.tasks.map(item => item.slice))].sort()) {
    const support = pairedIds.filter(id => registered.get(id) === slice).length;
    if (unpaired || support < thresholds.minimumSliceN) reasons.add(`insufficient-slice:${slice}`);
  }

  const marginBps = thresholds.qualityNonInferiorityMarginBps === 0 ? 0 : -thresholds.qualityNonInferiorityMarginBps;
  let interval: PairedDifferenceInterval | null = null;
  let qualityDecision: RoutingShadowReport['comparisons']['quality']['decision'] = 'insufficient';
  if (!unpaired && pairedN > 0) {
    const counts = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
    for (const id of pairedIds) {
      const c = byArm.get('jev-assisted')!.get(id)!.success;
      const b = byArm.get(baselineArm)!.get(id)!.success;
      if (c && b) counts.both += 1; else if (c) counts.candidateOnly += 1; else if (b) counts.baselineOnly += 1; else counts.neither += 1;
    }
    interval = pairedBinaryDifferenceInterval({ counts, levelBps: thresholds.ciLevelBps, method: thresholds.ciMethod });
    qualityDecision = pairedNonInferiority({ interval, marginBps }).decision;
  }
  if (qualityDecision !== 'non-inferior') reasons.add('quality-non-inferiority');

  if (candidate.failureRate > thresholds.maxFailureRate) reasons.add('failure-rate');
  if (candidate.reworkRate > thresholds.maxReworkRate) reasons.add('rework-rate');
  if (candidate.fallbackRate > thresholds.maxFallbackRate) reasons.add('fallback-rate');
  if (candidate.humanOverrideRate > thresholds.maxHumanOverrideRate) reasons.add('human-override-rate');
  const latencyP95IncreaseMs = candidate.latencyMsP95 - baseline.latencyMsP95;
  if (latencyP95IncreaseMs > thresholds.maxLatencyP95IncreaseMs) reasons.add('latency');
  const providerCallsPerTask = candidate.sampleN ? candidate.providerCalls / candidate.sampleN : 0;
  if (!candidate.sampleN || providerCallsPerTask > thresholds.maxProviderCallsPerTask) reasons.add('provider-calls');
  if (candidate.policyViolations > 0) reasons.add('policy-violation');
  const budgetCompliant = candidate.sampleN > 0 && candidate.overBudgetTasks === 0 && candidate.policyViolations === 0;
  if (thresholds.budgetComplianceRequired && !budgetCompliant) reasons.add('budget-compliance');
  const economics = {
    baselineRiskAdjustedMicros: baseline.riskAdjustedCostMicros,
    candidateRiskAdjustedMicros: candidate.riskAdjustedCostMicros,
    netSavingsMicros: baseline.riskAdjustedCostMicros - candidate.riskAdjustedCostMicros,
  };
  if (thresholds.positiveNetEconomicsRequired && (unpaired || economics.netSavingsMicros <= 0)) reasons.add('net-economics');

  // Shared #2037/#2048 integrity findings (#2611), plus the carried sample must be this paired set.
  const integrityFindings = new Set(integrityMetadataFindings(input.integrity, thresholds.minimumOverallN));
  if (input.integrity.sample_n !== pairedN) integrityFindings.add('integrity-sample-mismatch');
  for (const finding of integrityFindings) reasons.add(`integrity:${finding}`);
  const sortedReasons = [...reasons].sort();

  const payload: Omit<RoutingShadowReport, 'digest'> = {
    schemaVersion: 'decision-routing-shadow-report/v1',
    id: input.id,
    preregistration,
    holdoutAccessedAt: input.holdoutAccessedAt,
    evaluatedAt: input.evaluatedAt,
    observations,
    arms,
    comparisons: {
      baselineArm,
      candidateArm: 'jev-assisted',
      pairedN,
      quality: { marginBps, interval, decision: qualityDecision },
      economics,
      latencyP95IncreaseMs,
      providerCallsPerTask,
      budgetCompliant,
    },
    integrity: input.integrity,
    integrityFindings: [...integrityFindings].sort(),
    decision: ensembleIntegrityDecision(input.integrity, sortedReasons.length),
    reasons: sortedReasons,
  };
  return { ...payload, digest: routingDigest(payload) };
}

function summarizeArm(arm: RoutingShadowArmObservation['arm'], items: readonly RoutingShadowArmObservation[],
  thresholds: RoutingPromotionThresholds): RoutingShadowArmSummary {
  const sortedLatency = items.map(item => item.latencyMs).sort((a, b) => a - b);
  const slices: RoutingShadowArmSummary['slices'] = {};
  for (const slice of [...new Set(items.map(item => item.slice))].sort()) {
    const group = items.filter(item => item.slice === slice);
    slices[slice] = {
      sampleN: group.length,
      successRate: rate(group, item => item.success),
      failureRate: rate(group, item => !item.success),
      reworkRate: rate(group, item => item.rework),
      fallbackRate: rate(group, item => item.fallback),
    };
  }
  const attemptCostMicros = sum(items, item => item.attemptCostMicros);
  const reworkCostMicros = sum(items, item => item.reworkCostMicros);
  return {
    arm,
    sampleN: items.length,
    slices,
    successRate: rate(items, item => item.success),
    failureRate: rate(items, item => !item.success),
    reworkRate: rate(items, item => item.rework),
    fallbackRate: rate(items, item => item.fallback),
    selectiveCoverage: rate(items, item => item.accepted),
    humanOverrideRate: rate(items, item => item.humanOverride),
    providerCalls: sum(items, item => item.providerCalls),
    inputTokens: sum(items, item => item.inputTokens),
    outputTokens: sum(items, item => item.outputTokens),
    attemptCostMicros,
    reworkCostMicros,
    totalCostMicros: attemptCostMicros + reworkCostMicros,
    // Failed and rerouted attempts are already in attemptCostMicros; failures and overrides also carry a penalty.
    riskAdjustedCostMicros: attemptCostMicros + reworkCostMicros
      + items.filter(item => !item.success).length * thresholds.failurePenaltyMicros
      + items.filter(item => item.humanOverride).length * thresholds.humanOverridePenaltyMicros,
    overBudgetTasks: items.filter(item => item.attemptCostMicros > item.budgetMicros).length,
    latencyMsP95: sortedLatency.length ? sortedLatency[Math.ceil(sortedLatency.length * 0.95) - 1]! : 0,
    policyViolations: items.filter(item => item.policyViolation).length,
  };
}

function rate(items: readonly RoutingShadowArmObservation[], predicate: (item: RoutingShadowArmObservation) => boolean): number {
  return items.length ? items.filter(predicate).length / items.length : 0;
}

function sum(items: readonly RoutingShadowArmObservation[], value: (item: RoutingShadowArmObservation) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
