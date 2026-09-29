import type { RoutingEvalIntegrityMetadata, RoutingPromotionThresholds, RoutingShadowArmObservation, RoutingShadowReport } from './types.js';
import { routingDigest, routingThresholdsDigest, validateRoutingShadowReport } from './contract.js';

export interface RoutingShadowReportInput {
  id: string;
  policy: RoutingShadowReport['policy'];
  thresholds: RoutingPromotionThresholds;
  registeredAt: string;
  holdoutAccessedAt: string | null;
  observations: readonly RoutingShadowArmObservation[];
  integrity: RoutingEvalIntegrityMetadata;
  baselineArm?: 'fixed' | 'heuristic';
}

export function buildRoutingShadowReport(input: RoutingShadowReportInput): RoutingShadowReport {
  const baselineArm = input.baselineArm ?? 'fixed';
  const arms = (['fixed', 'heuristic', 'jev-assisted'] as const).map(arm => summarizeArm(arm, input.observations.filter(item => item.arm === arm)));
  const baseline = arms.find(item => item.arm === baselineArm)!;
  const candidate = arms.find(item => item.arm === 'jev-assisted')!;
  const qualityDelta = candidate.sampleN && baseline.sampleN ? candidate.successRate - baseline.successRate : null;
  const netSavingsMicros = candidate.sampleN && baseline.sampleN ? baseline.totalCostMicros - candidate.totalCostMicros : null;
  const reasons = promotionProblems(input.thresholds, baseline, candidate, qualityDelta, netSavingsMicros, input.integrity);
  const upstream = input.integrity.release_gate.decision;
  const decision: RoutingShadowReport['decision'] = upstream === 'ROLLBACK' || input.integrity.integrity_state === 'compromised'
    || input.integrity.compromise_labels.length > 0 ? 'ROLLBACK'
    : upstream === 'HOLD' || reasons.length ? 'HOLD' : 'PROMOTE';
  const payload: Omit<RoutingShadowReport, 'digest'> = {
    schemaVersion: 'decision-routing-shadow-report/v1',
    id: input.id,
    policy: input.policy,
    preregistration: {
      thresholdsDigest: routingThresholdsDigest(input.thresholds),
      registeredAt: input.registeredAt,
      holdoutAccessedAt: input.holdoutAccessedAt,
    },
    thresholds: input.thresholds,
    arms,
    comparisons: {
      baselineArm,
      candidateArm: 'jev-assisted',
      qualityDelta,
      netSavingsMicros,
      budgetCompliant: candidate.policyViolations === 0,
    },
    integrity: input.integrity,
    decision,
    reasons,
  };
  return validateRoutingShadowReport({ ...payload, digest: routingDigest(payload) });
}

function summarizeArm(arm: RoutingShadowArmObservation['arm'], items: readonly RoutingShadowArmObservation[]): RoutingShadowReport['arms'][number] {
  const accepted = items.filter(item => item.accepted);
  const sortedLatency = [...items].map(item => item.latencyMs).sort((a, b) => a - b);
  const slices: RoutingShadowReport['arms'][number]['slices'] = {};
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
  return {
    arm,
    sampleN: items.length,
    slices,
    successRate: rate(items, item => item.success),
    failureRate: rate(items, item => !item.success),
    reworkRate: rate(items, item => item.rework),
    fallbackRate: rate(items, item => item.fallback),
    selectiveCoverage: items.length ? accepted.length / items.length : 0,
    humanOverrideRate: rate(items, item => item.humanOverride),
    providerCalls: sum(items, item => item.providerCalls),
    inputTokens: sum(items, item => item.inputTokens),
    outputTokens: sum(items, item => item.outputTokens),
    totalCostMicros: sum(items, item => item.totalCostMicros),
    latencyMsP95: sortedLatency.length ? sortedLatency[Math.ceil(sortedLatency.length * 0.95) - 1]! : 0,
    policyViolations: items.filter(item => item.policyViolation).length,
  };
}

function promotionProblems(thresholds: RoutingPromotionThresholds, baseline: RoutingShadowReport['arms'][number],
  candidate: RoutingShadowReport['arms'][number], qualityDelta: number | null, netSavingsMicros: number | null,
  integrity: RoutingEvalIntegrityMetadata): string[] {
  const reasons: string[] = [];
  if (candidate.sampleN < thresholds.minimumOverallN) reasons.push('insufficient-overall-sample');
  for (const [slice, metrics] of Object.entries(candidate.slices)) {
    if (metrics.sampleN < thresholds.minimumSliceN) reasons.push(`insufficient-slice:${slice}`);
  }
  if (qualityDelta === null || qualityDelta < -thresholds.qualityNonInferiorityMargin) reasons.push('quality-non-inferiority');
  if (candidate.failureRate > thresholds.maxFailureRate) reasons.push('failure-rate');
  if (candidate.reworkRate > thresholds.maxReworkRate) reasons.push('rework-rate');
  if (candidate.fallbackRate > thresholds.maxFallbackRate) reasons.push('fallback-rate');
  if (thresholds.budgetComplianceRequired && candidate.policyViolations > 0) reasons.push('budget-compliance');
  if (thresholds.positiveNetEconomicsRequired && (netSavingsMicros === null || netSavingsMicros <= 0)) reasons.push('net-economics');
  if (baseline.sampleN !== candidate.sampleN) reasons.push('paired-shadow-mismatch');
  if (integrity.integrity_state !== 'verified' || integrity.compromise_labels.length > 0) reasons.push('integrity-not-verified');
  return reasons.sort();
}

function rate(items: readonly RoutingShadowArmObservation[], predicate: (item: RoutingShadowArmObservation) => boolean): number {
  return items.length ? items.filter(predicate).length / items.length : 0;
}

function sum(items: readonly RoutingShadowArmObservation[], value: (item: RoutingShadowArmObservation) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
