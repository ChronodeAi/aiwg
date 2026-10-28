// Context pruning preregistration, paired quality evaluation and release reporting.
import { ceilingDecision } from '../gates/lattice.js';
import { evaluateUpstreamCeiling, type QualificationIntegrityMetadata } from '../gates/upstream-ceiling.js';
import { PairedDifferenceError, pairedBinaryDifferenceInterval, pairedMeanDifferenceBootstrap,
  pairedNonInferiority, type PairedDifferenceInterval } from './qualification/quality.js';
import { ContextPruningError, SHA, contextPruningDigest, contextPruningPairSetDigest,
  contextPruningReceiptSetDigest, requirePlain } from './context-pruning-common.js';
import { uniqueCandidates, validateContextPruningReceipt } from './context-pruning-pilot.js';
import {
  CONTEXT_PRUNING_PREREGISTRATION_SCHEMA,
  CONTEXT_PRUNING_EVALUATION_REPORT_SCHEMA,
  CONTEXT_PRUNING_HOLDOUT_CLOCK_SKEW_MS,
  type ContextPruningCandidate,
  type ContextPruningReceipt,
  CONTEXT_PRUNING_QUALITY_METRICS,
  type ContextPruningQualityMetricName,
  type ContextPruningQualityScale,
  type ContextPruningPreregistration,
  type ContextPruningPairRecord,
  type ContextPruningQualityOutcomes,
  type ContextPruningPairedMetrics,
  type ContextPruningUsageTotal,
  type ContextPruningUsageAccounting,
  type ContextPruningQualityResult,
  type ContextPruningDerivedEvidence,
  type ContextPruningEvaluationReport
} from './context-pruning-types.js';

export function createContextPruningPreregistration(
  input: Omit<ContextPruningPreregistration, 'schemaVersion' | 'digest'>,
): ContextPruningPreregistration {
  const payload = { schemaVersion: CONTEXT_PRUNING_PREREGISTRATION_SCHEMA, ...input } satisfies Omit<ContextPruningPreregistration, 'digest'>;
  return validateContextPruningPreregistration({ ...payload, digest: contextPruningDigest(payload) });
}

export function validateContextPruningPreregistration(value: ContextPruningPreregistration): ContextPruningPreregistration {
  requirePlain(value, 'preregistration');
  const t = value.thresholds;
  const ci = t?.confidenceInterval;
  const metrics = Array.isArray(t?.qualityMetrics) ? t.qualityMetrics : [];
  const slices = Array.isArray(t?.slices) ? t.slices : [];
  const bootstrapTail = ci && Number.isSafeInteger(ci.bootstrapResamples) && Number.isSafeInteger(ci.levelBps)
    ? Math.floor(ci.bootstrapResamples * (10_000 - ci.levelBps) / 20_000) : 0;
  if (value.schemaVersion !== CONTEXT_PRUNING_PREREGISTRATION_SCHEMA || !value.id
    || !Number.isFinite(Date.parse(value.registeredAt))
    || typeof value.pairSetDigest !== 'string' || !SHA.test(value.pairSetDigest)
    || !t || t.protectedRetentionBps !== 10_000 || !ci
    // pairedBinaryDifferenceInterval accepts only levels strictly between 5000 and 9999.
    || !Number.isSafeInteger(ci.levelBps) || ci.levelBps <= 5_000 || ci.levelBps >= 9_999
    || !['newcombe-10', 'tango'].includes(ci.binaryMethod) || ci.boundedMethod !== 'percentile-bootstrap'
    || !Number.isSafeInteger(ci.bootstrapSeed) || ci.bootstrapSeed < 0 || ci.bootstrapSeed > 0xffff_ffff
    || !Number.isSafeInteger(ci.bootstrapResamples) || ci.bootstrapResamples > 1_000_000 || bootstrapTail < 5
    || metrics.length !== CONTEXT_PRUNING_QUALITY_METRICS.length
    || new Set(metrics.map(item => item?.metric)).size !== metrics.length
    || metrics.some(item => !CONTEXT_PRUNING_QUALITY_METRICS.includes(item?.metric) || !['binary', 'bounded'].includes(item.scale))
    || slices.length === 0 || new Set(slices).size !== slices.length
    || slices.some(slice => typeof slice !== 'string' || !slice.trim())
    || !Number.isSafeInteger(t.minimumOverallN) || t.minimumOverallN < 2
    || !Number.isSafeInteger(t.minimumSliceN) || t.minimumSliceN < 1
    || !Number.isSafeInteger(t.minimumZeroVarianceN) || t.minimumZeroVarianceN < 2
    || !Number.isSafeInteger(t.minimumProtectedN) || t.minimumProtectedN < 2
    || (t.powerRule !== null && (typeof t.powerRule !== 'string' || !t.powerRule.trim()))
    || !Number.isSafeInteger(t.qualityNonInferiorityMarginBps) || t.qualityNonInferiorityMarginBps > 0
    || t.qualityNonInferiorityMarginBps < -10_000
    || !Number.isSafeInteger(t.positiveTotalTokenTarget) || t.positiveTotalTokenTarget <= 0
    || !Number.isFinite(t.positiveTotalCostTargetUsd) || t.positiveTotalCostTargetUsd <= 0) {
    throw new ContextPruningError('invalid context pruning preregistration', 'schema');
  }
  const { digest, ...payload } = value;
  if (digest !== contextPruningDigest(payload)) throw new ContextPruningError('preregistration digest mismatch', 'semantic');
  return value;
}

/**
 * Builds the paired evaluation report. `trustedPreregistrationDigest` must come from a separately anchored
 * record made before holdout access (as evaluatePreregisteredBinaryBenchmark requires): a caller-created
 * preregistration cannot attest itself. A report without a recorded holdout access time cannot PROMOTE.
 * A holdout access attested later than the evaluation clock plus CONTEXT_PRUNING_HOLDOUT_CLOCK_SKEW_MS
 * is rejected as a future attestation.
 */
export function buildContextPruningEvaluationReport(input: {
  preregistration: ContextPruningPreregistration;
  trustedPreregistrationDigest: `sha256:${string}`;
  holdoutAccessedAt: string | null;
  integrity: QualificationIntegrityMetadata;
  metrics: ContextPruningPairedMetrics;
  /** One pilot run per evaluated pair: its candidate envelopes and receipts. Protected retention is derived from them. */
  pruningRuns: readonly { pairId: string; candidates: readonly ContextPruningCandidate[]; receipts: readonly ContextPruningReceipt[] }[];
  /** contextPruningReceiptSetDigest of every evaluated receipt, anchored separately from the report input. */
  trustedReceiptSetDigest: `sha256:${string}`;
  missingInputs?: readonly string[];
  /**
   * Injectable evaluation clock (epoch ms) the holdout-access attestation is compared against. Defaults to
   * Date.now; tests pass a fake clock.
   */
  evaluationNow?: () => number;
}): ContextPruningEvaluationReport {
  const preregistration = validateContextPruningPreregistration(input.preregistration);
  if (typeof input.trustedPreregistrationDigest !== 'string' || !SHA.test(input.trustedPreregistrationDigest)
    || preregistration.digest !== input.trustedPreregistrationDigest) {
    throw new ContextPruningError('preregistration is not anchored to the trusted digest', 'semantic');
  }
  const holdoutAccessedAt = input.holdoutAccessedAt;
  const holdoutAtMs = holdoutAccessedAt === null ? NaN : Date.parse(holdoutAccessedAt);
  if (holdoutAccessedAt !== null && (typeof holdoutAccessedAt !== 'string' || !Number.isFinite(holdoutAtMs)
    || holdoutAtMs <= Date.parse(preregistration.registeredAt))) {
    throw new ContextPruningError('holdout access must be recorded after preregistration', 'semantic');
  }
  if (Number.isFinite(holdoutAtMs)) {
    const evaluationNowMs = (input.evaluationNow ?? Date.now)();
    // Fail closed: an unknown evaluation time cannot vouch for the attestation.
    if (!Number.isFinite(evaluationNowMs) || holdoutAtMs - evaluationNowMs > CONTEXT_PRUNING_HOLDOUT_CLOCK_SKEW_MS) {
      throw new ContextPruningError('future holdout access attestation is rejected', 'semantic');
    }
  }
  validateIntegrity(input.integrity);
  const thresholds = preregistration.thresholds;
  validateMetrics(input.metrics, preregistration);
  const metrics = input.metrics;
  if (contextPruningPairSetDigest(metrics.pairs) !== preregistration.pairSetDigest) {
    throw new ContextPruningError('evaluated pair set does not match the preregistered pair set', 'semantic');
  }
  const findings = new Set<string>();
  const missing = new Set(input.missingInputs ?? []);
  if (holdoutAccessedAt === null) findings.add('holdout-access-unrecorded');

  const sliceSupport = Object.fromEntries(thresholds.slices.map(slice => [slice, 0]));
  for (const pair of metrics.pairs) sliceSupport[pair.slice]! += 1;
  if (metrics.pairs.length < thresholds.minimumOverallN) findings.add('insufficient-overall-sample');
  for (const slice of thresholds.slices) {
    if (sliceSupport[slice]! < thresholds.minimumSliceN) findings.add(`insufficient-slice:${slice}`);
  }
  const protectedRetention = deriveProtectedRetention(input.pruningRuns, metrics.pairs, input.trustedReceiptSetDigest);
  if (protectedRetention.bps === null) findings.add('insufficient-protected-receipts');
  else if (protectedRetention.bps !== metrics.protectedRetentionBps) {
    throw new ContextPruningError('protected retention does not reconcile with the pruning receipts', 'semantic');
  }
  if (metrics.protectedRetentionBps < 10_000 || (protectedRetention.bps !== null && protectedRetention.bps < 10_000)) {
    findings.add('protected-retention-breach');
  }
  // A full retention rate on too few protected items is not evidence: the count comes from validated receipts.
  if (protectedRetention.protectedItems < thresholds.minimumProtectedN) findings.add('insufficient-protected-sample');

  const quality = thresholds.qualityMetrics.map(({ metric, scale }) =>
    evaluateQualityMetric(metric, scale, metrics.quality.find(item => item.metric === metric), metrics.pairs, preregistration));
  for (const result of quality) {
    for (const slice of thresholds.slices) {
      if (result.sliceSupport[slice]! < thresholds.minimumSliceN) findings.add(`insufficient-quality-slice:${result.metric}:${slice}`);
    }
    if (result.missingPairs > 0) findings.add(`quality-outcomes-incomplete:${result.metric}`);
    if (result.decision === 'not-non-inferior') {
      findings.add('quality-non-inferiority-failed');
      findings.add(`quality-non-inferiority-failed:${result.metric}`);
      if (result.harm) {
        findings.add('quality-harm');
        findings.add(`quality-harm:${result.metric}`);
      } else {
        findings.add(`quality-non-inferiority-inconclusive:${result.metric}`);
      }
    } else if (result.decision === 'insufficient' && result.n === 0) {
      findings.add(`quality-metric-missing:${result.metric}`);
    } else if (result.decision === 'insufficient' && result.n < thresholds.minimumOverallN) {
      findings.add(`insufficient-quality-sample:${result.metric}`);
    } else if (result.decision === 'insufficient' && result.missingPairs === 0 && result.scale === 'bounded'
      && result.interval !== null && result.interval.lowerBps === result.interval.upperBps
      && result.n < thresholds.minimumZeroVarianceN) {
      // A conclusive-sized read withheld for lack of variability evidence: a zero-width bounded
      // interval below the preregistered zero-variance support.
      findings.add(`insufficient-quality-support:${result.metric}`);
    } else if (result.decision === 'insufficient') {
      // Interval construction failed, the verdict was unreadable, or a passing
      // verdict was withheld for omitted pairs: adequate n is not evidence.
      findings.add(`insufficient-quality-evidence:${result.metric}`);
    }
  }

  const providerSavings = providerUsageSavings(metrics.providerUsage);
  const estimatorSavings = { totalTokens: totalSavings(metrics.estimatorUsage, 'total') };
  if (providerSavings.totalTokens < 0 || providerSavings.uncachedTokens < 0
    || (providerSavings.costUsd !== null && providerSavings.costUsd < 0)) {
    findings.add('negative-net-economics');
  }
  if (providerSavings.totalTokens < thresholds.positiveTotalTokenTarget
    || providerSavings.uncachedTokens < thresholds.positiveTotalTokenTarget) findings.add('provider-token-target-not-met');
  if (estimatorSavings.totalTokens < thresholds.positiveTotalTokenTarget) findings.add('estimator-token-target-not-met');
  if (providerSavings.costUsd === null) findings.add('provider-cost-unknown');
  else if (providerSavings.costUsd < thresholds.positiveTotalCostTargetUsd) findings.add('provider-cost-target-not-met');

  const integrityGate = evaluateUpstreamCeiling(input.integrity, { policy: 'context-pruning' });
  for (const finding of integrityGate.problems) findings.add(finding);
  const upstreamDecision = input.integrity.release_gate.decision;
  for (const name of missing) findings.add(`missing-input:${name}`);
  // Automatic rollback triggers from the D26 rollout plan: protected miss, demonstrated quality harm, negative
  // economics. An inconclusive non-inferiority result (no evidence of harm) holds instead.
  const rollback = findings.has('protected-retention-breach')
    || findings.has('quality-harm') || findings.has('negative-net-economics');
  const decision = ceilingDecision(integrityGate.ceiling, rollback ? 'ROLLBACK' : findings.size > 0 ? 'HOLD' : 'PROMOTE');
  const advisory = [...findings].some(item => item.startsWith('insufficient-') || item.startsWith('quality-metric-missing:')
    || item.startsWith('missing-input:') || item.startsWith('quality-outcomes-incomplete:')
    || item.startsWith('quality-non-inferiority-inconclusive:')
    || item === 'holdout-access-unrecorded' || item === 'provider-cost-unknown')
    ? 'INSUFFICIENT EVIDENCE' : null;
  const payload: Omit<ContextPruningEvaluationReport, 'digest'> = {
    schemaVersion: CONTEXT_PRUNING_EVALUATION_REPORT_SCHEMA,
    preregistration,
    holdoutAccessedAt,
    integrity: input.integrity,
    metrics,
    derived: { sampleN: metrics.pairs.length, sliceSupport, quality, providerSavings, estimatorSavings, protectedRetention },
    missingInputs: [...missing].sort(),
    findings: [...findings].sort(),
    upstreamDecision,
    decision,
    advisory,
  };
  return { ...payload, digest: contextPruningDigest(payload) };
}

function evaluateQualityMetric(
  metric: ContextPruningQualityMetricName,
  scale: ContextPruningQualityScale,
  outcomes: ContextPruningQualityOutcomes | undefined,
  recordedPairs: readonly ContextPruningPairRecord[],
  preregistration: ContextPruningPreregistration,
): ContextPruningQualityResult {
  const { confidenceInterval: ci, minimumOverallN, minimumZeroVarianceN, qualityNonInferiorityMarginBps, slices } =
    preregistration.thresholds;
  const pairs = outcomes?.pairs ?? [];
  const sliceOf = new Map(recordedPairs.map(pair => [pair.pairId, pair.slice]));
  const sliceSupport = Object.fromEntries(slices.map(slice => [slice, 0]));
  for (const pair of pairs) sliceSupport[sliceOf.get(pair.pairId)!]! += 1;
  // validateMetrics guarantees outcome pair IDs are a unique subset of the recorded pairs.
  const missingPairs = recordedPairs.length - pairs.length;
  const result = (interval: PairedDifferenceInterval | null, decision: ContextPruningQualityResult['decision']) => ({
    metric, scale, n: pairs.length, missingPairs,
    harm: decision === 'not-non-inferior' && interval !== null
      && (interval.upperBps < 0 || interval.estimateBps < qualityNonInferiorityMarginBps),
    sliceSupport, interval, decision,
  });
  if (pairs.length < minimumOverallN) return result(null, 'insufficient');
  let interval: PairedDifferenceInterval;
  try {
    if (scale === 'binary') {
      const counts = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
      for (const pair of pairs) {
        if (pair.candidate === 1 && pair.baseline === 1) counts.both++;
        else if (pair.candidate === 1) counts.candidateOnly++;
        else if (pair.baseline === 1) counts.baselineOnly++;
        else counts.neither++;
      }
      interval = pairedBinaryDifferenceInterval({ counts, levelBps: ci.levelBps, method: ci.binaryMethod });
    } else {
      interval = pairedMeanDifferenceBootstrap({
        differences: pairs.map(pair => pair.candidate - pair.baseline), levelBps: ci.levelBps,
        seed: ci.bootstrapSeed, resamples: ci.bootstrapResamples, bounds: [-1, 1],
      });
    }
  } catch (error) {
    if (error instanceof PairedDifferenceError) return result(null, 'insufficient');
    throw error;
  }
  const verdict = pairedNonInferiority({ interval, marginBps: qualityNonInferiorityMarginBps });
  // A regression visible in the reported outcomes still fails; omitted pairs can only withhold a pass.
  if (verdict.decision === 'non-inferior' && missingPairs > 0) return result(interval, 'insufficient');
  // A zero-width bounded interval carries no variability evidence: identical pairs at a small n are
  // inconclusive, so a would-be pass needs the preregistered zero-variance support first. Only passes
  // are withheld here; demonstrated harm still rolls back through the verdict below.
  if (verdict.decision === 'non-inferior' && scale === 'bounded'
    && interval.lowerBps === interval.upperBps && pairs.length < minimumZeroVarianceN) {
    return result(interval, 'insufficient');
  }
  return result(interval, verdict.decision);
}

function deriveProtectedRetention(
  runs: readonly { pairId: string; candidates: readonly ContextPruningCandidate[]; receipts: readonly ContextPruningReceipt[] }[],
  pairs: readonly ContextPruningPairRecord[],
  trustedReceiptSetDigest: `sha256:${string}`,
): ContextPruningDerivedEvidence['protectedRetention'] {
  const pairIds = new Set(pairs.map(pair => pair.pairId));
  if (!Array.isArray(runs) || runs.length !== pairIds.size || new Set(runs.map(run => run?.pairId)).size !== runs.length
    || runs.some(run => !run || !pairIds.has(run.pairId) || !Array.isArray(run.candidates) || !Array.isArray(run.receipts))) {
    throw new ContextPruningError('pruning runs must cover every evaluated pair exactly once', 'invalid-input');
  }
  const allReceipts = runs.flatMap(run => run.receipts);
  if (typeof trustedReceiptSetDigest !== 'string' || !SHA.test(trustedReceiptSetDigest)
    || contextPruningReceiptSetDigest(allReceipts) !== trustedReceiptSetDigest) {
    throw new ContextPruningError('evaluated receipt set does not match the trusted receipt-set digest', 'semantic');
  }
  let protectedItems = 0;
  let retained = 0;
  for (const run of runs) {
    uniqueCandidates(run.candidates);
    const itemIds = run.receipts.map((receipt: ContextPruningReceipt) => receipt?.itemId);
    if (new Set(itemIds).size !== itemIds.length || itemIds.length !== run.candidates.length) {
      throw new ContextPruningError('pruning receipts are not bound to the evaluated run candidates', 'semantic');
    }
    for (const receipt of run.receipts) {
      if (receipt?.pairId !== run.pairId) throw new ContextPruningError('pruning receipt is not bound to the evaluated run', 'semantic');
      validateContextPruningReceipt(receipt, run.candidates);
      if (!receipt.classification.protected) continue;
      protectedItems++;
      if (receipt.proposedAction === 'keep' && receipt.appliedAction === 'keep') retained++;
    }
  }
  return { protectedItems, retained, bps: protectedItems === 0 ? null : Math.floor(retained * 10_000 / protectedItems) };
}

function validateIntegrity(integrity: QualificationIntegrityMetadata): void {
  if (!integrity || typeof integrity !== 'object' || !integrity.release_gate
    || !['PROMOTE', 'HOLD', 'ROLLBACK'].includes(integrity.release_gate.decision)
    || typeof integrity.integrity_state !== 'string') {
    throw new ContextPruningError('invalid eval-integrity metadata', 'schema');
  }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function validateMetrics(metrics: ContextPruningPairedMetrics, preregistration: ContextPruningPreregistration): void {
  requirePlain(metrics, 'metrics');
  const slices = new Set(preregistration.thresholds.slices);
  const pairs = Array.isArray(metrics.pairs) ? metrics.pairs : null;
  const pairIds = new Set(pairs?.map(pair => pair?.pairId));
  if (!pairs || pairIds.size !== pairs.length
    || pairs.some(pair => !pair || typeof pair.pairId !== 'string' || !pair.pairId || !slices.has(pair.slice))) {
    throw new ContextPruningError('pair records must have unique IDs and preregistered slices', 'schema');
  }
  const scales = new Map(preregistration.thresholds.qualityMetrics.map(item => [item.metric, item.scale]));
  const quality = Array.isArray(metrics.quality) ? metrics.quality : null;
  if (!quality || new Set(quality.map(item => item?.metric)).size !== quality.length
    || quality.some(item => !item || !scales.has(item.metric) || !Array.isArray(item.pairs))) {
    throw new ContextPruningError('quality outcomes must name each preregistered metric at most once', 'schema');
  }
  for (const item of quality) {
    const scale = scales.get(item.metric)!;
    const seen = new Set<string>();
    for (const pair of item.pairs) {
      const inRange = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
        && (scale === 'binary' ? value === 0 || value === 1 : value >= 0 && value <= 1);
      if (!pair || !pairIds.has(pair.pairId) || seen.has(pair.pairId) || !inRange(pair.baseline) || !inRange(pair.candidate)) {
        throw new ContextPruningError(`quality outcome for '${item.metric}' is out of range or not reconciled with the pair records`, 'schema');
      }
      seen.add(pair.pairId);
    }
  }
  if (!isCount(metrics.protectedRetentionBps) || metrics.protectedRetentionBps > 10_000
    || metrics.sharedStateAccounting !== 'not-applicable'
    || !usageAccounting(metrics.providerUsage, 'provider') || !usageAccounting(metrics.estimatorUsage, 'estimator')
    || !isCount(metrics.totalCalls) || !metrics.latencyMs
    || [metrics.latencyMs.p50, metrics.latencyMs.p95, metrics.latencyMs.p99]
      .some(value => value !== null && (!Number.isFinite(value) || value < 0))) {
    throw new ContextPruningError('invalid context pruning metrics', 'schema');
  }
  const cache = metrics.promptCache;
  for (const arm of ['baseline', 'prunedDownstream'] as const) {
    const reported = cache?.[arm];
    const usage = metrics.providerUsage[arm];
    // Cache credit is never a caller assertion: it must match provider-reported usage for the same arm.
    if (!reported || !isCount(reported.hits) || !isCount(reported.misses) || !isCount(reported.cachedInputTokens)
      || reported.cachedInputTokens !== usage.cachedInputTokens
      || (reported.cachedInputTokens > 0 && reported.hits === 0)) {
      throw new ContextPruningError(`prompt-cache usage for '${arm}' does not reconcile with provider usage`, 'semantic');
    }
  }
}

const USAGE_ARMS = ['baseline', 'prunedDownstream', 'decisionCalls', 'fallbackCalls', 'transformationCalls'] as const;

function usage(value: ContextPruningUsageTotal, source: 'provider' | 'estimator'): boolean {
  return Boolean(value) && isCount(value.inputTokens) && isCount(value.outputTokens)
    && (source === 'provider'
      ? isCount(value.cachedInputTokens) && value.cachedInputTokens <= value.inputTokens
      : value.cachedInputTokens === null)
    && (value.costUsd === null || (Number.isFinite(value.costUsd) && value.costUsd >= 0));
}

function usageAccounting(value: ContextPruningUsageAccounting, source: 'provider' | 'estimator'): boolean {
  return Boolean(value) && typeof value === 'object'
    && Object.keys(value).sort().join() === [...USAGE_ARMS].sort().join()
    && USAGE_ARMS.every(arm => usage(value[arm], source));
}

/** Baseline arm minus every pruned-arm call (downstream, decision, fallback, transformation). */
function totalSavings(value: ContextPruningUsageAccounting, basis: 'total' | 'uncached'): number {
  const tokens = (item: ContextPruningUsageTotal) => item.inputTokens + item.outputTokens
    - (basis === 'uncached' ? item.cachedInputTokens ?? 0 : 0);
  return tokens(value.baseline) - USAGE_ARMS.filter(arm => arm !== 'baseline').reduce((sum, arm) => sum + tokens(value[arm]), 0);
}

function providerUsageSavings(value: ContextPruningUsageAccounting): ContextPruningDerivedEvidence['providerSavings'] {
  const costs = USAGE_ARMS.map(arm => value[arm].costUsd);
  return {
    totalTokens: totalSavings(value, 'total'),
    uncachedTokens: totalSavings(value, 'uncached'),
    costUsd: costs.some(cost => cost === null) ? null
      : value.baseline.costUsd! - USAGE_ARMS.filter(arm => arm !== 'baseline').reduce((sum, arm) => sum + value[arm].costUsd!, 0),
    cachedInputTokensDelta: value.prunedDownstream.cachedInputTokens! - value.baseline.cachedInputTokens!,
  };
}

