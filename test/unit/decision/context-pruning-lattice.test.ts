// Synthetic context-pruning inputs for the shared outcome regression table.
import { describe, expect, it } from 'vitest';
import {
  applyContextPruningPilot,
  buildContextPruningEvaluationReport,
  contextPruningDigest,
  contextPruningPairSetDigest,
  contextPruningReceiptSetDigest,
  createContextPruningPreregistration,
  type ContextPruningCandidate,
  type ContextPruningDecisionEvidence,
  type ContextPruningPairedMetrics,
  type ContextPruningPairRecord,
  type ContextPruningPolicy,
  type ContextPruningPreregistration,
  type ContextPruningReceipt,
  type ContextPruningUsageAccounting,
  type ContextPruningUsageTotal,
} from '../../../src/decision/context-pruning.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';

const now = () => '2026-09-29T12:00:00.000Z';
const digest = (value: unknown) => contextPruningDigest(value);
const policy: ContextPruningPolicy = {
  mode: 'shadow',
  minimumConfidenceBps: 8_000,
  minimumMarginBps: 1_000,
  allowedDestructiveActions: ['keep', 'drop', 'truncate', 'summarize'],
  calibrationDigest: `sha256:${'c'.repeat(64)}`,
  modelIdentityDigest: `sha256:${'d'.repeat(64)}`,
};

function candidate(id: string, overrides: Partial<ContextPruningCandidate> = {}): ContextPruningCandidate {
  const content = overrides.content ?? `synthetic content for ${id}`;
  return {
    schemaVersion: 'decision-context-candidate/v1',
    itemId: id,
    locator: `fixture://${id}`,
    content,
    contentDigest: digest(content),
    source: { kind: 'ordinary', addedAt: now() },
    tokenEstimate: 10,
    priority: 0.1,
    trust: 'untrusted',
    sensitivity: 'internal',
    dependencies: [],
    protectedHints: [],
    taskSubject: 'issue-2619',
    dataPolicy: { externalEvaluation: 'allowed', localOnly: false, legalAction: 'none' },
    ...overrides,
  };
}

const success = (itemId: string, action: 'keep' | 'drop' | 'truncate' | 'summarize' = 'drop'): ContextPruningDecisionEvidence => ({
  itemId,
  subject: `context-item:${itemId}`,
  status: 'success',
  proposedAction: action,
  confidenceBps: 9_000,
  marginBps: 2_000,
  calibrated: true,
  calibrationDigest: policy.calibrationDigest!,
  modelIdentityDigest: policy.modelIdentityDigest!,
  decisionReceiptDigest: digest(`decision-${itemId}`),
});

const integrity = (decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK' = 'PROMOTE'): QualificationIntegrityMetadata => ({
  sample_n: 10,
  uncertainty: { method: 'fixture' },
  paired_baseline: { id: 'baseline' },
  integrity_mode: 'strict',
  fresh_workspace_required: true,
  fresh_workspace_verified: true,
  integrity_state: 'verified',
  trusted_score_source: 'fixture',
  compromise_labels: [],
  weak_signal_reason: null,
  release_gate: { decision, reasons: [] },
});

const HOLDOUT_AT = '2026-09-30T12:00:00.000Z';

const usage = (inputTokens: number, cachedInputTokens: number | null, outputTokens = 0, costUsd: number | null = null): ContextPruningUsageTotal =>
  ({ inputTokens, cachedInputTokens, outputTokens, costUsd });

/** Provider usage: baseline 11000 tokens (2000 cached), pruned arm 7000 (1500 cached), decision calls 550. */
function providerAccounting(overrides: Partial<ContextPruningUsageAccounting> = {}): ContextPruningUsageAccounting {
  return {
    baseline: usage(10_000, 2_000, 1_000, 1.00),
    prunedDownstream: usage(6_000, 1_500, 1_000, 0.60),
    decisionCalls: usage(500, 0, 50, 0.05),
    fallbackCalls: usage(0, 0, 0, 0),
    transformationCalls: usage(0, 0, 0, 0),
    ...overrides,
  };
}

function estimatorAccounting(): ContextPruningUsageAccounting {
  return {
    baseline: usage(10_000, null, 1_000), prunedDownstream: usage(6_000, null, 1_000), decisionCalls: usage(500, null, 50),
    fallbackCalls: usage(0, null), transformationCalls: usage(0, null),
  };
}

function preregister(
  overrides: Partial<ContextPruningPreregistration['thresholds']> = {}, registeredAt = now(),
  pairs: readonly ContextPruningPairRecord[] = goodMetrics().pairs,
): ContextPruningPreregistration {
  return createContextPruningPreregistration({
    id: 'd26-fixture',
    registeredAt,
    pairSetDigest: contextPruningPairSetDigest(pairs),
    thresholds: {
      protectedRetentionBps: 10_000,
      confidenceInterval: { levelBps: 9_500, binaryMethod: 'newcombe-10', boundedMethod: 'percentile-bootstrap',
        bootstrapSeed: 2619, bootstrapResamples: 2_000 },
      qualityMetrics: [
        { metric: 'downstream-task-success', scale: 'binary' },
        { metric: 'requirement-coverage', scale: 'bounded' },
        { metric: 'factual-coverage', scale: 'bounded' },
        { metric: 'citation-accuracy', scale: 'binary' },
        { metric: 'human-preference', scale: 'bounded' },
      ],
      slices: ['code', 'docs'],
      minimumOverallN: 40,
      minimumSliceN: 20,
      minimumZeroVarianceN: 30,
      minimumProtectedN: 30,
      powerRule: 'fixture: reviewer-owned power analysis before held-out access',
      qualityNonInferiorityMarginBps: -500,
      positiveTotalTokenTarget: 100,
      positiveTotalCostTargetUsd: 0.01,
      ...overrides,
    },
  });
}

const PAIR_IDS = Array.from({ length: 100 }, (_, index) => `pair-${String(index).padStart(3, '0')}`);

/** 100 frozen pairs, 50 per slice, with equivalent quality in both arms. */
function goodMetrics(overrides: Partial<ContextPruningPairedMetrics> = {}): ContextPruningPairedMetrics {
  const binary = (metric: 'downstream-task-success' | 'citation-accuracy') => ({ metric, pairs: PAIR_IDS.map((pairId, index) => {
    const outcome = index % 10 === 0 ? 0 : 1;
    return { pairId, baseline: outcome, candidate: outcome };
  }) });
  const bounded = (metric: 'requirement-coverage' | 'factual-coverage' | 'human-preference') => ({ metric,
    pairs: PAIR_IDS.map((pairId, index) => ({ pairId, baseline: 0.8, candidate: index % 2 === 0 ? 0.81 : 0.79 })) });
  return {
    pairs: PAIR_IDS.map((pairId, index) => ({ pairId, slice: index % 2 === 0 ? 'code' : 'docs' })),
    quality: [binary('downstream-task-success'), bounded('requirement-coverage'), bounded('factual-coverage'),
      binary('citation-accuracy'), bounded('human-preference')],
    protectedRetentionBps: 10_000,
    providerUsage: providerAccounting(),
    estimatorUsage: estimatorAccounting(),
    totalCalls: 300,
    latencyMs: { p50: 10, p95: 20, p99: 30 },
    promptCache: {
      baseline: { hits: 20, misses: 80, cachedInputTokens: 2_000 },
      prunedDownstream: { hits: 15, misses: 85, cachedInputTokens: 1_500 },
    },
    sharedStateAccounting: 'not-applicable',
    ...overrides,
  };
}

type PruningRunEvidence = { pairId: string; candidates: ContextPruningCandidate[]; receipts: ContextPruningReceipt[] };

function report(
  metrics: ContextPruningPairedMetrics,
  options: { gate?: 'PROMOTE' | 'HOLD' | 'ROLLBACK'; preregistration?: ContextPruningPreregistration;
    holdoutAccessedAt?: string | null; trustedDigest?: `sha256:${string}`; missingInputs?: string[];
    runs?: PruningRunEvidence[]; trustedReceiptSetDigest?: `sha256:${string}`;
    evaluationNow?: () => number } = {},
) {
  // By default the preregistration froze exactly the pair set being reported.
  const preregistration = options.preregistration ?? preregister({}, now(), metrics.pairs);
  const runs = options.runs ?? fixtureRuns(metrics.pairs);
  return buildContextPruningEvaluationReport({
    preregistration,
    trustedPreregistrationDigest: options.trustedDigest ?? preregistration.digest,
    holdoutAccessedAt: options.holdoutAccessedAt === undefined ? HOLDOUT_AT : options.holdoutAccessedAt,
    integrity: integrity(options.gate ?? 'PROMOTE'),
    metrics,
    pruningRuns: runs,
    trustedReceiptSetDigest: options.trustedReceiptSetDigest ?? contextPruningReceiptSetDigest(runs.flatMap(run => run.receipts)),
    missingInputs: options.missingInputs,
    evaluationNow: options.evaluationNow,
  });
}

/** One shadow pruning run per evaluated pair, each with a protected rule and an ordinary note. */
const fixtureRunCache = new Map<string, PruningRunEvidence[]>();
function fixtureRuns(pairs: readonly ContextPruningPairRecord[] = goodMetrics().pairs): PruningRunEvidence[] {
  const key = contextPruningPairSetDigest(pairs);
  if (!fixtureRunCache.has(key)) fixtureRunCache.set(key, buildFixtureRuns(pairs));
  return fixtureRunCache.get(key)!;
}

function buildFixtureRuns(pairs: readonly ContextPruningPairRecord[]): PruningRunEvidence[] {
  const candidates = [candidate('rules', { source: { kind: 'system', addedAt: now() } }), candidate('note')];
  return [...new Set(pairs.map(pair => pair.pairId))].map(pairId => ({
    pairId,
    candidates,
    receipts: applyContextPruningPilot({ candidates, policy, now, pairId,
      evidence: [success('rules', 'drop'), success('note', 'drop')] }).receipts,
  }));
}

describe('context pruning shared lattice (#2829)', () => {
  it('preserves upstream, incomplete-evidence and observed-harm verdicts', () => {
    for (const upstream of ['PROMOTE', 'HOLD', 'ROLLBACK'] as const) {
      for (const missing of [false, true]) for (const harm of [false, true]) {
        const metrics = goodMetrics(harm ? { providerUsage: providerAccounting({
          prunedDownstream: usage(20_000, 1_500, 1_000, 2.00),
        }) } : {});
        expect(report(metrics, { gate: upstream, missingInputs: missing ? ['fixture-missing'] : [] }).decision)
          .toBe(upstream === 'ROLLBACK' || harm ? 'ROLLBACK' : upstream === 'HOLD' || missing ? 'HOLD' : 'PROMOTE');
      }
    }
  });
});
