// Context pruning data contracts and version constants.
import type { ContextQuestion } from './context-plan.js';
import type { PairedDifferenceInterval } from './qualification/quality.js';
import type { QualificationIntegrityMetadata } from '../gates/upstream-ceiling.js';

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

export interface ContextPruningActionDecision {
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
    /** Minimum pairs for a zero-variance bounded read (every per-pair difference identical) to support non-inferiority. */
    minimumZeroVarianceN: number;
    /** Protected receipts below this count cannot PROMOTE, even at 100% retention. */
    minimumProtectedN: number;
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

