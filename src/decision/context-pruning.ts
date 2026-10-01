import { ContextBudgetManager, type BudgetConfig, type ContextItem } from '../metrics/context-budget.js';
import { sha256 } from './compile-cache/identity.js';
import { admitEntry } from './entry.js';
import type { ContextQuestion } from './context-plan.js';
import {
  PairedDifferenceError,
  pairedBinaryDifferenceInterval,
  pairedMeanDifferenceBootstrap,
  pairedNonInferiority,
  type PairedDifferenceInterval,
} from './qualification/quality.js';
import type { QualificationIntegrityMetadata } from './qualification/release.js';

export const CONTEXT_PRUNING_PROTECTED_POLICY_VERSION = 'decision-context-protected/v1' as const;
export const CONTEXT_PRUNING_CANDIDATE_SCHEMA = 'decision-context-candidate/v1' as const;
export const CONTEXT_PRUNING_RECEIPT_SCHEMA = 'decision-context-pruning-receipt/v1' as const;
export const CONTEXT_PRUNING_PREREGISTRATION_SCHEMA = 'decision-context-pruning-preregistration/v1' as const;
export const CONTEXT_PRUNING_EVALUATION_REPORT_SCHEMA = 'decision-context-pruning-evaluation-report/v1' as const;
/**
 * Clock-skew allowance for `holdoutAccessedAt` attestations: the recorder that stamps holdout access and the
 * evaluator that builds the report may disagree by up to five minutes. An attestation later than the
 * evaluation clock plus this allowance is a future attestation and is rejected.
 */
export const CONTEXT_PRUNING_HOLDOUT_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type ContextPruningSourceKind =
  | 'system'
  | 'developer'
  | 'project'
  | 'security-policy'
  | 'user'
  | 'approval'
  | 'blocker'
  | 'provenance'
  | 'citation'
  | 'artifact'
  | 'test-evidence'
  | 'open-decision'
  | 'retrieved'
  | 'memory'
  | 'tool-output'
  | 'ordinary';
export type ContextTrust = 'verified' | 'untrusted';
export type ContextSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type ContextPruningAction = 'keep' | 'drop' | 'truncate' | 'summarize';
export type ContextPruningMode = 'disabled' | 'shadow' | 'advisory';
export type ContextProtectedReason =
  | 'system-rule'
  | 'developer-rule'
  | 'project-rule'
  | 'security-policy'
  | 'current-user-requirement'
  | 'explicit-mention'
  | 'unresolved-blocker'
  | 'action-approval'
  | 'artifact-pin'
  | 'version-pin'
  | 'digest-pin'
  | 'provenance-required'
  | 'citation-required'
  | 'test-gate-evidence'
  | 'open-decision-evidence'
  | 'protected-dependency'
  | 'external-evaluation-denied'
  | 'local-only'
  | 'restricted-data'
  | 'legal-policy';

export interface ContextPruningCandidate {
  schemaVersion: typeof CONTEXT_PRUNING_CANDIDATE_SCHEMA;
  itemId: string;
  locator: string;
  contentDigest: `sha256:${string}`;
  /** Optional host-owned body used only for prompt reconstruction tests. It never crosses model policy. */
  content?: string;
  source: { kind: ContextPruningSourceKind; addedAt: string };
  tokenEstimate: number;
  priority: number;
  trust: ContextTrust;
  sensitivity: ContextSensitivity;
  dependencies: string[];
  protectedHints: ContextProtectedReason[];
  taskSubject: string;
  dataPolicy: {
    externalEvaluation: 'allowed' | 'denied';
    localOnly: boolean;
    legalAction: 'none' | 'requires-review';
  };
}

export interface ContextProtectedClassification {
  schemaVersion: typeof CONTEXT_PRUNING_PROTECTED_POLICY_VERSION;
  itemId: string;
  protected: boolean;
  reasons: ContextProtectedReason[];
  policyDigest: `sha256:${string}`;
}

export interface ContextPruningDecisionEvidence {
  itemId: string;
  subject: string;
  status: 'success' | 'invalid' | 'uncertain' | 'uncalibrated' | 'incomplete' | 'cancelled' | 'failed' | 'drifted';
  proposedAction?: ContextPruningAction;
  confidenceBps?: number;
  marginBps?: number;
  disagreement?: boolean;
  calibrated?: boolean;
  calibrationDigest?: `sha256:${string}`;
  decisionReceiptDigest?: `sha256:${string}`;
  modelIdentityDigest?: `sha256:${string}`;
  transformation?: ContextTransformationReference;
}

export interface ContextTransformationReference {
  action: 'truncate' | 'summarize';
  locator: string;
  digest: `sha256:${string}`;
  sourceDigest: `sha256:${string}`;
  qualityCheck: 'passed' | 'failed' | 'missing';
}

export interface ContextPruningPolicy {
  mode: ContextPruningMode;
  minimumConfidenceBps: number;
  minimumMarginBps: number;
  allowedDestructiveActions: ContextPruningAction[];
  /** The runtime disables advisory behavior when either digest changes. */
  calibrationDigest: `sha256:${string}` | null;
  modelIdentityDigest: `sha256:${string}` | null;
}

export interface ContextPruningReceipt {
  schemaVersion: typeof CONTEXT_PRUNING_RECEIPT_SCHEMA;
  /** Binds the receipt to one pilot run: contextPruningRunId(pairId, candidates). */
  runId: `sha256:${string}`;
  /** The frozen evaluation pair this run belongs to; null outside paired evaluation. */
  pairId: string | null;
  itemId: string;
  locator: string;
  originalDigest: `sha256:${string}`;
  originalTokenEstimate: number;
  classification: ContextProtectedClassification;
  proposedAction: ContextPruningAction;
  appliedAction: ContextPruningAction;
  mode: ContextPruningMode | 'deterministic-fallback';
  reason:
    | 'protected-item'
    | 'disabled'
    | 'shadow-only'
    | 'accepted-evidence'
    | 'prior-deterministic-fallback'
    | 'invalid-evidence'
    | 'uncertain-evidence'
    | 'uncalibrated'
    | 'incomplete-state'
    | 'cancelled'
    | 'evaluation-failed'
    | 'drift-or-monitoring-regression'
    | 'unsupported-transformation'
    | 'policy-denied-action';
  decisionReceiptDigest: `sha256:${string}` | null;
  reversibleReference: {
    locator: string;
    originalDigest: `sha256:${string}`;
    restorationPath: string;
    transformation: ContextTransformationReference | null;
  };
  createdAt: string;
  receiptDigest: `sha256:${string}`;
}

export interface ContextPruningRun {
  schemaVersion: 'decision-context-pruning-run/v1';
  runId: `sha256:${string}`;
  pairId: string | null;
  mode: ContextPruningMode | 'deterministic-fallback';
  baselineItemIds: string[];
  downstreamItemIds: string[];
  receipts: ContextPruningReceipt[];
  disabledReason: 'configured-disabled' | 'drift-or-monitoring-regression' | null;
  /** The ContextBudgetManager selection used as the prior deterministic fallback; null when no budget is configured. */
  deterministicBaseline: ContextBudgetManagerBaseline | null;
}

interface ContextPruningActionDecision {
  proposedAction: ContextPruningAction;
  appliedAction: ContextPruningAction;
  mode: ContextPruningMode | 'deterministic-fallback';
  reason: ContextPruningReceipt['reason'];
  decisionReceiptDigest: `sha256:${string}` | null;
  transformation: ContextTransformationReference | null;
}

export interface ContextPruningQuestion {
  id: string;
  itemId: string;
  subject: string;
  kind: 'relevance' | 'disposition' | 'omission-risk';
  entry: ContextQuestion['entry'];
  batchKey?: string;
}

export interface ContextPruningEvaluationJob {
  subject: string;
  itemId: string;
  state: { candidateDigest: `sha256:${string}`; itemId: string; locator: string };
  questions: ContextPruningQuestion[];
  contextQuestion: ContextQuestion;
}

export interface ContextPruningEvaluationExclusion {
  itemId: string;
  reasons: ContextProtectedReason[];
}

export interface ContextPruningEvaluationPlan {
  jobs: ContextPruningEvaluationJob[];
  exclusions: ContextPruningEvaluationExclusion[];
}

export const CONTEXT_PRUNING_QUALITY_METRICS = [
  'downstream-task-success',
  'requirement-coverage',
  'factual-coverage',
  'citation-accuracy',
  'human-preference',
] as const;
export type ContextPruningQualityMetricName = typeof CONTEXT_PRUNING_QUALITY_METRICS[number];
/** `binary` outcomes are 0 or 1 per pair; `bounded` outcomes are finite scores in [0, 1] per pair. */
export type ContextPruningQualityScale = 'binary' | 'bounded';

export interface ContextPruningPreregistration {
  schemaVersion: typeof CONTEXT_PRUNING_PREREGISTRATION_SCHEMA;
  id: string;
  registeredAt: string;
  /** contextPruningPairSetDigest of the frozen evaluation pairs (IDs and slice membership), fixed before holdout access. */
  pairSetDigest: `sha256:${string}`;
  thresholds: {
    protectedRetentionBps: 10_000;
    confidenceInterval: {
      levelBps: number;
      binaryMethod: 'newcombe-10' | 'tango';
      boundedMethod: 'percentile-bootstrap';
      bootstrapSeed: number;
      bootstrapResamples: number;
    };
    /** Every quality metric, each exactly once, with the scale its raw per-pair outcomes use. */
    qualityMetrics: { metric: ContextPruningQualityMetricName; scale: ContextPruningQualityScale }[];
    /** Every slice the report must support; slices absent from the pair records count as zero. */
    slices: string[];
    minimumOverallN: number;
    minimumSliceN: number;
    powerRule: string | null;
    /** Non-positive integer bps: -250 lets the candidate be at most 2.5 points worse. */
    qualityNonInferiorityMarginBps: number;
    positiveTotalTokenTarget: number;
    positiveTotalCostTargetUsd: number;
  };
  digest: `sha256:${string}`;
}

/** One frozen paired task: the same task run with the baseline context and with the pruned context. */
export interface ContextPruningPairRecord {
  pairId: string;
  slice: string;
}

export interface ContextPruningQualityOutcomes {
  metric: ContextPruningQualityMetricName;
  /** Raw per-pair outcomes; each metric has its own n. */
  pairs: { pairId: string; baseline: number; candidate: number }[];
}

export interface ContextPruningPromptCacheArm {
  hits: number;
  misses: number;
  /** Provider-reported cached (cache-read) prompt tokens for this arm. */
  cachedInputTokens: number;
}

export interface ContextPruningPairedMetrics {
  pairs: ContextPruningPairRecord[];
  quality: ContextPruningQualityOutcomes[];
  protectedRetentionBps: number;
  providerUsage: ContextPruningUsageAccounting;
  estimatorUsage: ContextPruningUsageAccounting;
  totalCalls: number;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
  /** Provider-reported prompt-cache usage for both downstream arms; reconciled against providerUsage. */
  promptCache: { baseline: ContextPruningPromptCacheArm; prunedDownstream: ContextPruningPromptCacheArm };
  /** Share-once Jev state accounting is not implemented; only `not-applicable` is accepted. */
  sharedStateAccounting: 'not-applicable';
}

export interface ContextPruningUsageTotal {
  inputTokens: number;
  /** Provider-reported cached prompt tokens (subset of inputTokens); null when not observed (estimator usage). */
  cachedInputTokens: number | null;
  outputTokens: number;
  costUsd: number | null;
}

export interface ContextPruningUsageAccounting {
  baseline: ContextPruningUsageTotal;
  prunedDownstream: ContextPruningUsageTotal;
  decisionCalls: ContextPruningUsageTotal;
  fallbackCalls: ContextPruningUsageTotal;
  transformationCalls: ContextPruningUsageTotal;
}

export interface ContextBudgetManagerBaseline {
  source: 'ContextBudgetManager';
  usage: ContextPruningUsageTotal;
  keptItemIds: string[];
  droppedItemIds: string[];
  /** Items ContextBudgetManager would drop that the protected-item classifier keeps; never in droppedItemIds. */
  protectedRetainedItemIds: string[];
  tokensFreed: number;
  /** False when protected items alone keep the selection above the manager's degradation target. */
  withinBudget: boolean;
}

export interface ContextPruningQualityResult {
  metric: ContextPruningQualityMetricName;
  scale: ContextPruningQualityScale;
  n: number;
  /** Recorded pairs with no outcome for this metric; any missing pair makes a passing metric insufficient. */
  missingPairs: number;
  /**
   * Demonstrated harm: the metric is not non-inferior and either the upper bound is below 0 or the point
   * estimate is below the margin. Not-non-inferior without harm is inconclusive (HOLD), not ROLLBACK.
   */
  harm: boolean;
  /** Per-slice support counted from this metric's own outcomes. */
  sliceSupport: Record<string, number>;
  interval: PairedDifferenceInterval | null;
  decision: 'non-inferior' | 'not-non-inferior' | 'insufficient';
}

export interface ContextPruningDerivedEvidence {
  sampleN: number;
  sliceSupport: Record<string, number>;
  quality: ContextPruningQualityResult[];
  providerSavings: {
    totalTokens: number;
    /** Savings after removing provider-reported cached prompt tokens from every arm. */
    uncachedTokens: number;
    costUsd: number | null;
    /** Signed: prunedDownstream cached tokens minus baseline cached tokens. Negative means pruning lost cache hits. */
    cachedInputTokensDelta: number;
  };
  estimatorSavings: { totalTokens: number };
  /** Derived from validated pruning receipts; metrics.protectedRetentionBps must match it. */
  protectedRetention: { protectedItems: number; retained: number; bps: number | null };
}

export interface ContextPruningEvaluationReport {
  schemaVersion: typeof CONTEXT_PRUNING_EVALUATION_REPORT_SCHEMA;
  preregistration: ContextPruningPreregistration;
  holdoutAccessedAt: string | null;
  integrity: QualificationIntegrityMetadata;
  metrics: ContextPruningPairedMetrics;
  derived: ContextPruningDerivedEvidence;
  missingInputs: string[];
  findings: string[];
  upstreamDecision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  advisory: 'INSUFFICIENT EVIDENCE' | null;
  digest: `sha256:${string}`;
}

export class ContextPruningError extends Error {
  constructor(message: string, readonly reason: 'invalid-input' | 'schema' | 'semantic') {
    super(message);
    this.name = 'ContextPruningError';
  }
}

const SHA = /^sha256:[0-9a-f]{64}$/;
const SOURCE_TO_REASON: Partial<Record<ContextPruningSourceKind, ContextProtectedReason>> = {
  system: 'system-rule',
  developer: 'developer-rule',
  project: 'project-rule',
  'security-policy': 'security-policy',
  user: 'current-user-requirement',
  approval: 'action-approval',
  blocker: 'unresolved-blocker',
  provenance: 'provenance-required',
  citation: 'citation-required',
  artifact: 'artifact-pin',
  'test-evidence': 'test-gate-evidence',
  'open-decision': 'open-decision-evidence',
};
const VALID_SOURCE_KINDS = new Set<ContextPruningSourceKind>([
  'system', 'developer', 'project', 'security-policy', 'user', 'approval', 'blocker',
  'provenance', 'citation', 'artifact', 'test-evidence', 'open-decision', 'retrieved',
  'memory', 'tool-output', 'ordinary',
]);
const VALID_PROTECTED_REASONS = new Set<ContextProtectedReason>([
  'system-rule', 'developer-rule', 'project-rule', 'security-policy', 'current-user-requirement',
  'explicit-mention', 'unresolved-blocker', 'action-approval', 'artifact-pin', 'version-pin',
  'digest-pin', 'provenance-required', 'citation-required', 'test-gate-evidence',
  'open-decision-evidence', 'protected-dependency', 'external-evaluation-denied', 'local-only',
  'restricted-data', 'legal-policy',
]);

export function contextPruningDigest(value: unknown): `sha256:${string}` {
  return sha256(value);
}

/** Order-independent digest of the frozen evaluation pairs: sorted (pairId, slice) tuples. */
export function contextPruningPairSetDigest(pairs: readonly ContextPruningPairRecord[]): `sha256:${string}` {
  const tuples = pairs.map(pair => [pair.pairId, pair.slice] as const)
    .sort(([a, sa], [b, sb]) => a < b ? -1 : a > b ? 1 : sa < sb ? -1 : sa > sb ? 1 : 0);
  return contextPruningDigest({ schemaVersion: 'decision-context-pruning-pair-set/v1', pairs: tuples });
}

/** Identity of one pilot run over an ordered candidate set, optionally tied to an evaluation pair. */
export function contextPruningRunId(pairId: string | null, candidates: readonly ContextPruningCandidate[]): `sha256:${string}` {
  return contextPruningDigest({
    schemaVersion: 'decision-context-pruning-run-id/v1',
    pairId,
    candidates: candidates.map(candidate => contextPruningDigest(candidate)),
  });
}

/** Order-independent digest of a receipt set, for anchoring the evaluated receipts separately from the report. */
export function contextPruningReceiptSetDigest(receipts: readonly ContextPruningReceipt[]): `sha256:${string}` {
  return contextPruningDigest({
    schemaVersion: 'decision-context-pruning-receipt-set/v1',
    receipts: receipts.map(receipt => receipt.receiptDigest).sort(),
  });
}

export function classifyContextPruningCandidate(candidate: ContextPruningCandidate): ContextProtectedClassification {
  validateContextPruningCandidate(candidate);
  const reasons = new Set<ContextProtectedReason>();
  const mapped = SOURCE_TO_REASON[candidate.source.kind];
  if (mapped) reasons.add(mapped);
  for (const hint of candidate.protectedHints) reasons.add(hint);
  if (candidate.dataPolicy.externalEvaluation === 'denied') reasons.add('external-evaluation-denied');
  if (candidate.dataPolicy.localOnly) reasons.add('local-only');
  if (candidate.dataPolicy.legalAction === 'requires-review') reasons.add('legal-policy');
  if (candidate.sensitivity === 'restricted') reasons.add('restricted-data');
  const sorted = [...reasons].sort();
  const policy = {
    version: CONTEXT_PRUNING_PROTECTED_POLICY_VERSION,
    sourceRules: SOURCE_TO_REASON,
    dataPolicy: ['externalEvaluation', 'localOnly', 'legalAction'],
    sensitivity: ['restricted'],
    protectedHints: [...VALID_PROTECTED_REASONS].sort(),
  };
  return {
    schemaVersion: CONTEXT_PRUNING_PROTECTED_POLICY_VERSION,
    itemId: candidate.itemId,
    protected: sorted.length > 0,
    reasons: sorted,
    policyDigest: contextPruningDigest(policy),
  };
}

export function classifyContextPruningCandidates(
  candidates: readonly ContextPruningCandidate[],
): Map<string, ContextProtectedClassification> {
  const byId = uniqueCandidates(candidates);
  const classifications = new Map<string, ContextProtectedClassification>();
  for (const candidate of candidates) classifications.set(candidate.itemId, classifyContextPruningCandidate(candidate));
  const protectedQueue = candidates.filter(candidate => classifications.get(candidate.itemId)!.protected)
    .map(candidate => candidate.itemId);
  for (let index = 0; index < protectedQueue.length; index++) {
    const item = byId.get(protectedQueue[index]!)!;
    for (const dependencyId of item.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new ContextPruningError(`unknown context dependency '${dependencyId}'`, 'semantic');
      const current = classifications.get(dependencyId)!;
      if (current.reasons.includes('protected-dependency')) continue;
      classifications.set(dependencyId, {
        ...current,
        protected: true,
        reasons: [...new Set([...current.reasons, 'protected-dependency' as const])].sort(),
      });
      protectedQueue.push(dependencyId);
    }
  }
  return classifications;
}

export function planContextPruningEvaluations(
  candidates: readonly ContextPruningCandidate[],
  questions: readonly ContextPruningQuestion[],
): ContextPruningEvaluationJob[] {
  return planContextPruningEvaluationRun(candidates, questions).jobs;
}

export function planContextPruningEvaluationRun(
  candidates: readonly ContextPruningCandidate[],
  questions: readonly ContextPruningQuestion[],
): ContextPruningEvaluationPlan {
  const byId = uniqueCandidates(candidates);
  const classifications = classifyContextPruningCandidates(candidates);
  const exclusions = [...classifications.values()]
    .filter(classification => classification.protected)
    .map(classification => ({ itemId: classification.itemId, reasons: [...classification.reasons].sort() }));
  const excluded = new Set(exclusions.map(item => item.itemId));
  const groups = new Map<string, ContextPruningQuestion[]>();
  for (const question of questions) {
    if (!question.id || !question.itemId || !question.subject || !['relevance', 'disposition', 'omission-risk'].includes(question.kind)) {
      throw new ContextPruningError('invalid context pruning question', 'schema');
    }
    const candidate = byId.get(question.itemId);
    if (!candidate) throw new ContextPruningError(`unknown context item '${question.itemId}'`, 'semantic');
    if (excluded.has(candidate.itemId)) continue;
    const subject = pruningSubject(candidate);
    if (question.subject !== subject) throw new ContextPruningError('question subject must be the context item subject', 'semantic');
    const key = `${question.itemId}\0${question.batchKey ?? 'default'}`;
    const group = groups.get(key) ?? [];
    group.push(question);
    groups.set(key, group);
  }
  const jobs = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
    const candidate = byId.get(group[0]!.itemId)!;
    const subject = pruningSubject(candidate);
    if (group.some(question => question.itemId !== candidate.itemId || question.subject !== subject)) {
      throw new ContextPruningError('unrelated context chunks cannot share a native batch', 'semantic');
    }
    return {
      subject,
      itemId: candidate.itemId,
      state: { candidateDigest: contextPruningDigest(candidate), itemId: candidate.itemId, locator: candidate.locator },
      questions: [...group].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      contextQuestion: {
        id: `context-pruning:${candidate.itemId}:${group[0]!.batchKey ?? 'default'}`,
        subject,
        compatibilityKey: `context-pruning:${candidate.itemId}:${group[0]!.batchKey ?? 'default'}`,
        entry: { candidateDigest: contextPruningDigest(candidate), questions: group.map(question => question.kind).sort() },
      },
    };
  });
  return { jobs, exclusions };
}

export interface ApplyContextPruningInput {
  candidates: readonly ContextPruningCandidate[];
  policy: ContextPruningPolicy;
  evidence?: readonly ContextPruningDecisionEvidence[];
  now?: () => string;
  monitoringRegression?: boolean;
  /**
   * When set, the existing deterministic ContextBudgetManager selection under this budget is the prior
   * deterministic fallback, and every candidate must carry its host-owned content. When absent, the prior
   * behavior is "no pruning", so the fallback proposal is keep.
   */
  budget?: Partial<BudgetConfig>;
  /** The frozen evaluation pair this run serves; recorded on the run and every receipt. */
  pairId?: string;
}

export function applyContextPruningPilot(input: ApplyContextPruningInput): ContextPruningRun {
  validatePolicy(input.policy);
  if (input.pairId !== undefined && (typeof input.pairId !== 'string' || !input.pairId)) {
    throw new ContextPruningError('pairId must be a non-empty string', 'invalid-input');
  }
  const pairId = input.pairId ?? null;
  const now = input.now ?? (() => new Date().toISOString());
  const baseline = input.candidates.map(candidate => candidate.itemId);
  const evidence = new Map((input.evidence ?? []).map(item => [item.itemId, item]));
  const disabledReason = input.monitoringRegression ? 'drift-or-monitoring-regression'
    : input.policy.mode === 'disabled' ? 'configured-disabled' : null;
  const mode: ContextPruningRun['mode'] = disabledReason ? 'deterministic-fallback' : input.policy.mode;
  const classifications = classifyContextPruningCandidates(input.candidates);
  const runId = contextPruningRunId(pairId, input.candidates);
  const deterministicBaseline = input.budget === undefined ? null
    : computeContextBudgetManagerBaseline(input.candidates, input.budget);
  const deterministicDrops = new Set(deterministicBaseline?.droppedItemIds ?? []);
  const receipts = input.candidates.map(candidate => {
    validateContextPruningCandidate(candidate);
    const classification = classifications.get(candidate.itemId)!;
    const itemEvidence = evidence.get(candidate.itemId);
    const fallbackAction: ContextPruningAction = deterministicDrops.has(candidate.itemId) ? 'drop' : 'keep';
    const decision = decideContextAction(candidate, classification, input.policy, itemEvidence, disabledReason, fallbackAction);
    return buildContextPruningReceipt(candidate, classification, decision, now(), runId, pairId);
  });
  return {
    schemaVersion: 'decision-context-pruning-run/v1',
    runId,
    pairId,
    mode,
    baselineItemIds: baseline,
    // A distinct array: callers that mutate one list cannot silently alter the other.
    downstreamItemIds: [...baseline],
    receipts,
    disabledReason,
    deterministicBaseline,
  };
}

/**
 * Validates a receipt's shape and self-digest. When the run's candidate envelopes are supplied, it also
 * re-derives the run identity and the protected-item classification and refuses any mismatch, so a
 * relabelled receipt with a recomputed digest, or a receipt from another run, is rejected.
 */
export function validateContextPruningReceipt(
  receipt: ContextPruningReceipt,
  candidates?: readonly ContextPruningCandidate[],
): ContextPruningReceipt {
  requirePlain(receipt, 'receipt');
  if (receipt.schemaVersion !== CONTEXT_PRUNING_RECEIPT_SCHEMA || !receipt.itemId || !receipt.locator
    || typeof receipt.runId !== 'string' || !SHA.test(receipt.runId)
    || !(receipt.pairId === null || (typeof receipt.pairId === 'string' && receipt.pairId))
    || !SHA.test(receipt.originalDigest) || !Number.isSafeInteger(receipt.originalTokenEstimate) || receipt.originalTokenEstimate < 0
    || !['keep', 'drop', 'truncate', 'summarize'].includes(receipt.proposedAction)
    || !['keep', 'drop', 'truncate', 'summarize'].includes(receipt.appliedAction)
    || !(receipt.decisionReceiptDigest === null || SHA.test(receipt.decisionReceiptDigest))
    || !receipt.reversibleReference || receipt.reversibleReference.originalDigest !== receipt.originalDigest
    || !receipt.reversibleReference.locator || !receipt.reversibleReference.restorationPath
    || !SHA.test(receipt.receiptDigest)) {
    throw new ContextPruningError('invalid pruning receipt', 'schema');
  }
  if ((receipt.proposedAction === 'truncate' || receipt.proposedAction === 'summarize')
    && receipt.reason === 'accepted-evidence' && receipt.reversibleReference.transformation === null) {
    throw new ContextPruningError('transformed receipts require a reversible artifact reference', 'semantic');
  }
  if (receipt.reversibleReference.transformation !== null
    && receipt.reversibleReference.transformation.sourceDigest !== receipt.originalDigest) {
    throw new ContextPruningError('transformation source digest must match the original context item', 'semantic');
  }
  const { receiptDigest, ...payload } = receipt;
  if (receiptDigest !== contextPruningDigest(payload)) throw new ContextPruningError('pruning receipt digest mismatch', 'semantic');
  if (candidates !== undefined) {
    const candidate = candidates.find(item => item.itemId === receipt.itemId);
    if (!candidate || receipt.runId !== contextPruningRunId(receipt.pairId, candidates)
      || receipt.originalDigest !== candidate.contentDigest || receipt.locator !== candidate.locator
      || receipt.originalTokenEstimate !== candidate.tokenEstimate) {
      throw new ContextPruningError('pruning receipt is not bound to the evaluated run', 'semantic');
    }
    const derived = classifyContextPruningCandidates(candidates).get(candidate.itemId)!;
    if (contextPruningDigest(derived) !== contextPruningDigest(receipt.classification)) {
      throw new ContextPruningError('pruning receipt classification does not match the candidate envelope', 'semantic');
    }
    // A protected item is never proposed for, or subjected to, a destructive action by this pilot.
    if (derived.protected && (receipt.proposedAction !== 'keep' || receipt.appliedAction !== 'keep')) {
      throw new ContextPruningError('pruning receipt classification does not match its protected action', 'semantic');
    }
  }
  return receipt;
}

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

  if (input.integrity.integrity_state !== 'verified') findings.add('integrity-not-verified');
  const upstreamDecision = input.integrity.release_gate.decision;
  if (upstreamDecision === 'ROLLBACK') findings.add('upstream-rollback');
  if (upstreamDecision === 'HOLD') findings.add('upstream-hold');
  for (const name of missing) findings.add(`missing-input:${name}`);
  // Automatic rollback triggers from the D26 rollout plan: protected miss, demonstrated quality harm, negative
  // economics. An inconclusive non-inferiority result (no evidence of harm) holds instead.
  const rollback = upstreamDecision === 'ROLLBACK' || findings.has('protected-retention-breach')
    || findings.has('quality-harm') || findings.has('negative-net-economics');
  const decision = rollback ? 'ROLLBACK' : upstreamDecision === 'HOLD' || findings.size > 0 ? 'HOLD' : 'PROMOTE';
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
  const { confidenceInterval: ci, minimumOverallN, qualityNonInferiorityMarginBps, slices } = preregistration.thresholds;
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

function pruningSubject(candidate: ContextPruningCandidate): string {
  return `context-item:${candidate.itemId}`;
}

function decideContextAction(
  candidate: ContextPruningCandidate,
  classification: ContextProtectedClassification,
  policy: ContextPruningPolicy,
  evidence: ContextPruningDecisionEvidence | undefined,
  disabledReason: ContextPruningRun['disabledReason'],
  fallbackAction: ContextPruningAction,
): ContextPruningActionDecision {
  if (classification.protected) return { proposedAction: 'keep', appliedAction: 'keep',
    mode: disabledReason ? 'deterministic-fallback' : policy.mode,
    reason: 'protected-item', decisionReceiptDigest: null, transformation: null };
  const fallback = (reason: ContextPruningReceipt['reason']) => deterministicFallback(fallbackAction, reason);
  if (disabledReason) return fallback(disabledReason === 'configured-disabled' ? 'disabled' : 'drift-or-monitoring-regression');
  if (policy.mode === 'disabled') return fallback('disabled');
  if (!evidence || evidence.itemId !== candidate.itemId || evidence.subject !== pruningSubject(candidate)) return fallback('invalid-evidence');
  if (evidence.status === 'cancelled') return fallback('cancelled');
  if (evidence.status === 'incomplete') return fallback('incomplete-state');
  if (evidence.status === 'uncalibrated') return fallback('uncalibrated');
  if (evidence.status === 'drifted') return fallback('drift-or-monitoring-regression');
  if (evidence.status === 'failed') return fallback('evaluation-failed');
  if (policy.modelIdentityDigest === null || policy.calibrationDigest === null
    || evidence.modelIdentityDigest === undefined || evidence.calibrationDigest === undefined
    || evidence.modelIdentityDigest !== policy.modelIdentityDigest || evidence.calibrationDigest !== policy.calibrationDigest) {
    return fallback('drift-or-monitoring-regression');
  }
  const confidenceBps = evidence.confidenceBps;
  const marginBps = evidence.marginBps;
  if (evidence.status !== 'success' || evidence.disagreement || evidence.proposedAction === undefined
    || typeof confidenceBps !== 'number' || typeof marginBps !== 'number'
    || !Number.isSafeInteger(confidenceBps) || !Number.isSafeInteger(marginBps)
    || confidenceBps < policy.minimumConfidenceBps || marginBps < policy.minimumMarginBps
    || evidence.calibrated !== true || !evidence.decisionReceiptDigest || !SHA.test(evidence.decisionReceiptDigest)) {
    return fallback(evidence.status === 'uncertain' ? 'uncertain-evidence' : 'invalid-evidence');
  }
  const proposed = evidence.proposedAction;
  if (!policy.allowedDestructiveActions.includes(proposed) && proposed !== 'keep') return fallback('policy-denied-action');
  if ((proposed === 'truncate' || proposed === 'summarize') && !validTransformation(evidence.transformation, proposed, candidate.contentDigest)) {
    return fallback('unsupported-transformation');
  }
  return {
    proposedAction: proposed,
    appliedAction: 'keep',
    mode: policy.mode,
    reason: policy.mode === 'shadow' && proposed !== 'keep' ? 'shadow-only' : 'accepted-evidence',
    decisionReceiptDigest: evidence.decisionReceiptDigest,
    transformation: evidence.transformation ?? null,
  };
}

function deterministicFallback(action: ContextPruningAction, reason: ContextPruningReceipt['reason']) {
  return {
    proposedAction: action,
    appliedAction: 'keep' as const,
    mode: 'deterministic-fallback' as const,
    reason: reason === 'disabled' ? 'disabled' as const
      : ['invalid-evidence', 'uncertain-evidence', 'uncalibrated', 'incomplete-state', 'cancelled', 'evaluation-failed',
        'drift-or-monitoring-regression', 'unsupported-transformation', 'policy-denied-action'].includes(reason)
        ? reason : 'prior-deterministic-fallback' as const,
    decisionReceiptDigest: null,
    transformation: null,
  };
}

function buildContextPruningReceipt(
  candidate: ContextPruningCandidate,
  classification: ContextProtectedClassification,
  decision: ContextPruningActionDecision,
  createdAt: string,
  runId: `sha256:${string}`,
  pairId: string | null,
): ContextPruningReceipt {
  const transformation = decision.transformation ?? null;
  const payload = {
    schemaVersion: CONTEXT_PRUNING_RECEIPT_SCHEMA,
    runId,
    pairId,
    itemId: candidate.itemId,
    locator: candidate.locator,
    originalDigest: candidate.contentDigest,
    originalTokenEstimate: candidate.tokenEstimate,
    classification,
    proposedAction: decision.proposedAction,
    appliedAction: decision.appliedAction,
    mode: decision.mode,
    reason: decision.reason,
    decisionReceiptDigest: decision.decisionReceiptDigest,
    reversibleReference: {
      locator: candidate.locator,
      originalDigest: candidate.contentDigest,
      restorationPath: candidate.locator,
      transformation,
    },
    createdAt,
  } satisfies Omit<ContextPruningReceipt, 'receiptDigest'>;
  return validateContextPruningReceipt({ ...payload, receiptDigest: contextPruningDigest(payload) });
}

function validTransformation(value: ContextTransformationReference | undefined, action: 'truncate' | 'summarize', sourceDigest: string): boolean {
  return Boolean(value && value.action === action && value.qualityCheck === 'passed'
    && value.sourceDigest === sourceDigest && value.locator && SHA.test(value.digest));
}

export function computeContextBudgetManagerBaseline(
  candidates: readonly ContextPruningCandidate[],
  config?: Partial<BudgetConfig>,
): ContextBudgetManagerBaseline {
  const manager = new ContextBudgetManager(process.cwd(), config);
  for (const candidate of candidates) {
    validateContextPruningCandidate(candidate);
    // ContextBudgetManager sizes item text itself; sizing the digest string would understate real content.
    if (candidate.content === undefined) {
      throw new ContextPruningError(`ContextBudgetManager baseline requires host-owned content for '${candidate.itemId}'`, 'invalid-input');
    }
    // The envelope priority is passed as ContextBudgetManager similarity; the manager derives its own priority.
    manager.addItem(candidate.itemId, candidate.content, sourceTypeForBudget(candidate), candidate.priority);
  }
  const result = manager.degrade();
  // ContextBudgetManager spares only source type 'system'; protected (and dependency-protected) items are
  // retained here so the drop list can be applied as the fallback without removing protected context.
  const classifications = classifyContextPruningCandidates(candidates);
  const isProtected = (id: string) => classifications.get(id)!.protected;
  const byId = new Map([...result.kept, ...result.dropped].map(item => [item.id, item]));
  const droppedIds = new Set(result.dropped.filter(item => !isProtected(item.id)).map(item => item.id));
  // Re-adding protected items can exceed the manager's target, so continue its own rule (ascending priority,
  // never system items) over the remaining unprotected items until the target is met or none remain.
  const target = Math.floor(manager.contextBudget * manager.getConfig().warningThreshold);
  let current = candidates.reduce((sum, candidate) => sum + (droppedIds.has(candidate.itemId) ? 0 : byId.get(candidate.itemId)!.tokens), 0);
  const remaining = candidates.map(candidate => byId.get(candidate.itemId)!)
    .filter(item => !droppedIds.has(item.id) && !isProtected(item.id) && item.source.type !== 'system')
    .sort((a, b) => a.priority - b.priority);
  for (const item of remaining) {
    if (current <= target) break;
    droppedIds.add(item.id);
    current -= item.tokens;
  }
  const kept = candidates.map(candidate => byId.get(candidate.itemId)!).filter(item => !droppedIds.has(item.id));
  const dropped = candidates.map(candidate => byId.get(candidate.itemId)!).filter(item => droppedIds.has(item.id));
  return {
    source: 'ContextBudgetManager',
    usage: {
      inputTokens: kept.reduce((sum, item) => sum + item.tokens, 0),
      cachedInputTokens: null,
      outputTokens: 0,
      costUsd: null,
    },
    keptItemIds: kept.map(item => item.id).sort(),
    droppedItemIds: dropped.map(item => item.id).sort(),
    protectedRetainedItemIds: result.dropped.filter(item => isProtected(item.id)).map(item => item.id).sort(),
    tokensFreed: dropped.reduce((sum, item) => sum + item.tokens, 0),
    withinBudget: current <= target,
  };
}

function validateContextPruningCandidate(candidate: ContextPruningCandidate): void {
  requirePlain(candidate, 'candidate');
  if (candidate.schemaVersion !== CONTEXT_PRUNING_CANDIDATE_SCHEMA || !candidate.itemId || !candidate.locator
    || !SHA.test(candidate.contentDigest) || !candidate.source || !VALID_SOURCE_KINDS.has(candidate.source.kind) || !candidate.source.addedAt
    || !Number.isFinite(Date.parse(candidate.source.addedAt))
    || (candidate.content !== undefined && contextPruningDigest(candidate.content) !== candidate.contentDigest)
    || !Number.isSafeInteger(candidate.tokenEstimate) || candidate.tokenEstimate < 0
    || !Number.isFinite(candidate.priority) || candidate.priority < 0 || candidate.priority > 1
    || !['verified', 'untrusted'].includes(candidate.trust)
    || !['public', 'internal', 'confidential', 'restricted'].includes(candidate.sensitivity)
    || !Array.isArray(candidate.dependencies) || new Set(candidate.dependencies).size !== candidate.dependencies.length
    || candidate.dependencies.some(value => typeof value !== 'string' || !value)
    || !Array.isArray(candidate.protectedHints) || new Set(candidate.protectedHints).size !== candidate.protectedHints.length
    || candidate.protectedHints.some(reason => !VALID_PROTECTED_REASONS.has(reason))
    || !candidate.taskSubject || !candidate.dataPolicy
    || !['allowed', 'denied'].includes(candidate.dataPolicy.externalEvaluation)
    || typeof candidate.dataPolicy.localOnly !== 'boolean'
    || !['none', 'requires-review'].includes(candidate.dataPolicy.legalAction)) {
    throw new ContextPruningError('invalid context candidate', 'schema');
  }
  try { admitEntry(candidate); } catch {
    throw new ContextPruningError('context candidate failed admission', 'schema');
  }
}

function validatePolicy(policy: ContextPruningPolicy): void {
  if (!['disabled', 'shadow', 'advisory'].includes(policy.mode)
    || !Number.isSafeInteger(policy.minimumConfidenceBps) || policy.minimumConfidenceBps < 0 || policy.minimumConfidenceBps > 10_000
    || !Number.isSafeInteger(policy.minimumMarginBps) || policy.minimumMarginBps < 0 || policy.minimumMarginBps > 10_000
    || !Array.isArray(policy.allowedDestructiveActions)
    || policy.allowedDestructiveActions.some(action => !['keep', 'drop', 'truncate', 'summarize'].includes(action))
    || (policy.calibrationDigest !== null && !SHA.test(policy.calibrationDigest))
    || (policy.modelIdentityDigest !== null && !SHA.test(policy.modelIdentityDigest))) {
    throw new ContextPruningError('invalid context pruning policy', 'schema');
  }
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

function sourceTypeForBudget(candidate: ContextPruningCandidate): ContextItem['source']['type'] {
  if (candidate.source.kind === 'system' || candidate.source.kind === 'developer' || candidate.source.kind === 'project') return 'system';
  if (candidate.source.kind === 'user') return 'user';
  if (candidate.protectedHints.includes('explicit-mention')) return 'at-mention';
  return 'auto';
}

function uniqueCandidates(candidates: readonly ContextPruningCandidate[]): Map<string, ContextPruningCandidate> {
  const byId = new Map(candidates.map(candidate => [candidate.itemId, candidate]));
  if (byId.size !== candidates.length) throw new ContextPruningError('candidate item IDs must be unique', 'semantic');
  for (const candidate of candidates) validateContextPruningCandidate(candidate);
  for (const candidate of candidates) {
    for (const dependencyId of candidate.dependencies) {
      if (!byId.has(dependencyId)) throw new ContextPruningError(`unknown context dependency '${dependencyId}'`, 'semantic');
    }
  }
  return byId;
}

function requirePlain(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ContextPruningError(`${label} must be a plain object`, 'schema');
  }
}
