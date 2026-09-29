import type { ArtifactPin } from '../types.js';
import type { CalibrationRegistry } from '../calibration/registry.js';
import type { CompatibilityDecision, CompatibilityPolicy, CompatibilityRequest } from '../calibration/types.js';
import type { DecisionProjectionEvidence } from '../projection.js';

export type IssueTriageMode = 'disabled' | 'offline-shadow' | 'advisory';
export type IssueTriageGateDecision = 'PROMOTE' | 'HOLD' | 'ROLLBACK';

export interface IssueTriagePilotPack {
  schemaVersion: 'decision-issue-triage-pilot-pack/v1';
  id: string;
  version: string;
  mode: IssueTriageMode;
  taxonomies: {
    issueTypes: string[];
    areas: string[];
    stateCompleteness: Array<'complete' | 'partial' | 'missing'>;
    clarificationNeed: Array<'needed' | 'not-needed'>;
  };
  urgencyRubric: Array<{ id: string; ordinal: number; description: string }>;
  candidatePolicy: {
    generator: 'deterministic-token-overlap-v1';
    maxCandidates: number;
    includeNone: true;
  };
  acceptance: {
    uncertaintyProfiles: string[];
    calibration: 'advisory' | 'required';
    acceptedScoring: 'disabled-on-incompatibility';
  };
  trackerMutationPolicy: {
    create: 'forbidden';
    edit: 'forbidden';
    label: 'forbidden';
    assign: 'forbidden';
    comment: 'forbidden';
    close: 'forbidden';
    merge: 'forbidden';
  };
  rollback: { disableRestoresPriorWorkflow: true; preserveReceiptsAndLabels: true };
}

export interface IssueTriageEvaluationManifest {
  schemaVersion: 'decision-issue-triage-evaluation-manifest/v1';
  id: string;
  pilotPack: ArtifactPin;
  dataset: {
    id: string;
    digest: `sha256:${string}`;
    splitMethod: 'time' | 'source';
    minimumTotal: number;
    minimumPerSupportedSlice: number;
    /** Digests of the frozen tuning/calibration/test memberships, pinned before holdout access. */
    splitDigests: { tuning: `sha256:${string}`; calibration: `sha256:${string}`; test: `sha256:${string}` };
  };
  slices: Array<{
    id: string;
    dimension: 'issue-type' | 'area' | 'state-completeness' | 'adversarial-authority' | 'new-or-unseen-category';
    minimumSupport: number;
    whenInsufficient: 'label-insufficient';
    aggregation: 'report-supported' | 'suppress-small-n';
  }>;
  thresholds: {
    maximumFalseDuplicateRate: number;
    maximumFalseAutoRate: number;
    /**
     * Cascade-minus-baseline accuracy margin as a proportion. Must be <= 0: -0.02 lets the cascade be at most
     * two points worse. A positive value would be a superiority test, which this manifest does not support.
     */
    qualityNonInferiorityMargin: number;
    minimumAcceptedCoverage: number;
    confidenceInterval: { method: 'wilson' | 'bootstrap' | 'exact'; level: number };
    minimumTotalSamples: number;
    minimumPerSliceSamples: number;
    benefit: { mustBePositive: true; metric: 'total-task-token-cost' | 'reviewer-time' };
  };
  holdout: { thresholdsRegisteredAt: string; holdoutAccessedAt: string | null };
  integrity: { extendsEvalIntegrity: true; preserveGateDecision: true };
}

export interface IssueTriageIssueRecord {
  id: string;
  repository: string;
  title: string;
  body: string;
  createdAt: string;
  author?: string;
  metadata?: Record<string, string | number | boolean | null>;
  finalLabels?: string[];
  finalDuplicateOf?: string | null;
  resolution?: string | null;
  closedAt?: string | null;
}

/** A candidate's title/body as observed at one point in time. */
export interface IssueTriageCandidateRevision {
  observedAt: string;
  title: string;
  body: string;
}

/**
 * Point-in-time candidate input. Only revisions observed at or before the triaged issue's createdAt are
 * used; current-state fields (title, body, labels, state, resolution) are refused.
 */
export interface IssueTriageCandidateInput {
  id: string;
  repository: string;
  createdAt: string;
  revisions: IssueTriageCandidateRevision[];
}

export interface IssueTriageDuplicateCandidate {
  issueId: string;
  repository: string;
  title: string;
  rank: number;
  score: number;
  sourceDigest: `sha256:${string}`;
}

export interface IssueTriageCandidateLineage {
  generator: 'deterministic-token-overlap-v1';
  queryDigest: `sha256:${string}`;
  candidates: IssueTriageDuplicateCandidate[];
  noneOutcome: 'none';
}

export interface IssueTriageModelState {
  issue: {
    id: string;
    repository: string;
    title: string;
    body: string;
    createdAt: string;
    author?: string;
    metadata?: Record<string, string | number | boolean | null>;
  };
  duplicateCandidates: IssueTriageDuplicateCandidate[];
  allowed: {
    issueTypes: string[];
    areas: string[];
    urgency: string[];
    stateCompleteness: Array<'complete' | 'partial' | 'missing'>;
    clarificationNeed: Array<'needed' | 'not-needed'>;
    duplicateOutcomes: string[];
  };
}

export interface IssueTriageProjection {
  modelState: IssueTriageModelState;
  lineage: IssueTriageCandidateLineage;
  excludedReplayFields: Record<'finalLabels' | 'finalDuplicateOf' | 'resolution' | 'closedAt', boolean>;
  projectionEvidence: DecisionProjectionEvidence;
  stateDigest: `sha256:${string}`;
}

export interface IssueTriageBatchQuestion {
  questionId: string;
  issueId: string;
  alias: 'issueType' | 'area' | 'urgency' | 'completeness' | 'clarification' | 'duplicate';
}

export interface IssueTriageModelResponse {
  issueId: string;
  issueType: string;
  area: string;
  urgency: string;
  completeness: 'complete' | 'partial' | 'missing';
  clarificationNeed: 'needed' | 'not-needed';
  duplicate: { issueId: string | 'none'; rank: number | null };
  uncertaintyProfile: string;
  accepted: boolean;
  actualModel: string;
  requestedModel: string;
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  /** Provider-reported usage per call or cache read; `usage`, `calls` and `cacheHit` must reconcile to these. */
  usageReceipts: IssueTriageUsageReceipt[];
  calls: { jev: number; fallbackModel: number };
  retries: number;
  fallbacks: number;
  cacheHit: boolean;
}

export interface IssueTriageUsageReceipt {
  kind: 'jev' | 'fallback-model' | 'cache';
  requestId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface IssueTriageValidatedResponse extends IssueTriageModelResponse {
  acceptance: {
    acceptedScoring: boolean;
    reason: 'compatible' | 'defer-drift' | 'defer-calibration-incompatible' | 'defer-response-rejected';
    driftEvent: string | null;
    /** Registry compatibility pin, or null when no registry resolution was supplied. */
    compatibility: CompatibilityDecision | null;
  };
}

export interface IssueTriageCalibrationContext {
  requestedModel: string;
  actualModel: string;
  compatibleActualModels: string[];
  uncertaintyProfile: string;
  /** Compatibility is resolved through the calibration registry; required when the pack sets calibration: required. */
  registry?: { registry: CalibrationRegistry; request: CompatibilityRequest; policy: CompatibilityPolicy };
}

export interface IssueTriageShadowArtifact {
  schemaVersion: 'decision-issue-triage-shadow-artifact/v1';
  mode: 'offline-shadow';
  subject: { issueId: string; stateDigest: `sha256:${string}` };
  lineage: IssueTriageCandidateLineage;
  response: IssueTriageValidatedResponse;
  actionAuthorization: 'not-authorized';
  trackerMutations: 0;
}

export interface IssueTriageEvaluationLabel {
  id: string;
  issueType: string;
  area: string;
  urgency: string;
  completeness: 'complete' | 'partial' | 'missing';
  clarificationNeed: 'needed' | 'not-needed';
  duplicateOf: string | 'none';
  slices: string[];
  useful: boolean;
  reviewerWouldOverride: boolean;
  reviewerTimeBaselineMinutes: number;
  reviewerTimeCascadeMinutes: number;
}

export interface IssueTriageEvaluationSample {
  id: string;
  /** Deterministic candidate lineage the cascade answered against; ranks are re-validated from it. */
  lineage: IssueTriageCandidateLineage;
  label: IssueTriageEvaluationLabel;
  baseline: IssueTriageModelResponse;
  cascade: IssueTriageValidatedResponse;
}

export interface PrecisionRecallF1 {
  precision: number;
  recall: number;
  f1: number;
}

export interface MulticlassMetrics {
  sampleN: number;
  macro: PrecisionRecallF1;
  perClass: Record<string, PrecisionRecallF1>;
}

export interface BinaryMetrics extends PrecisionRecallF1 {
  sampleN: number;
}

export interface IssueTriageEvaluationReport {
  schemaVersion: 'decision-issue-triage-evaluation-report/v1';
  id: string;
  manifest: ArtifactPin;
  classCounts: Record<string, Record<string, number>>;
  classification: { issueType: MulticlassMetrics; area: MulticlassMetrics };
  urgency: { sampleN: number; meanAbsoluteError: number; normalizedAbsoluteError: number; exactRate: number };
  completeness: BinaryMetrics;
  clarification: BinaryMetrics;
  duplicates: {
    sampleN: number;
    duplicateN: number;
    noneN: number;
    recall: number;
    concordance: number | null;
    comparablePairs: number;
    ndcg: number;
    topK: Record<string, number>;
    falseDuplicateRate: number;
    noneRecall: number;
  };
  slices: Array<{
    id: string;
    dimension: IssueTriageEvaluationManifest['slices'][number]['dimension'];
    aggregation: IssueTriageEvaluationManifest['slices'][number]['aggregation'];
    /** Null only when an insufficient slice is suppressed. */
    sampleN: number | null;
    /** Effective minimum: max(slice minimumSupport, thresholds.minimumPerSliceSamples). */
    minimumSupport: number;
    status: 'supported' | 'insufficient';
    suppressed: boolean;
    metrics: IssueTriageSliceMetrics | null;
  }>;
  calibration: {
    riskCoverage: IssueTriageRiskCoverage;
    driftEvents: string[];
    compatibilityRequired: boolean;
  };
  operations: {
    reviewLoad: number;
    overrideRate: number;
    latencyMs: { p50: number; p95: number; p99: number };
    tokens: { input: number | null; output: number | null };
    costUsd: number | null;
    calls: { jev: number; fallbackModel: number };
    retryRate: number;
    fallbackRate: number;
    cache: { hits: number; misses: number };
    usageReconciled: boolean;
  };
  baselineComparison: {
    baseline: { quality: number; tokens: number | null; costUsd: number | null; reviewerTimeMinutes: number | null };
    cascade: { quality: number; tokens: number | null; costUsd: number | null; reviewerTimeMinutes: number | null };
    delta: { quality: number; tokens: number | null; costUsd: number | null; reviewerTimeMinutes: number | null };
    qualityNonInferiority: IssueTriageNonInferiority | null;
  };
  integrity: { upstreamDecision: IssueTriageGateDecision; findings: string[] };
  decision: IssueTriageGateDecision;
}

export interface IssueTriageSliceMetrics {
  cascadeQuality: number;
  baselineQuality: number;
  acceptedCoverage: number;
  falseAutoRate: number | null;
  falseDuplicateRate: number | null;
  duplicateRecall: number | null;
}

export interface IssueTriageRiskCoverage {
  sampleN: number;
  acceptedN: number;
  coverage: number;
  /** Two-sided Wilson lower bound on coverage at the preregistered level; null when the level is unsupported. */
  coverageLower: number | null;
  /** Error rate among accepted samples (the false-auto rate); null when nothing was accepted. */
  selectiveRisk: number | null;
  selectiveRiskUpper: number | null;
}

export interface IssueTriageNonInferiority {
  method: 'newcombe-hybrid-score';
  levelBps: number;
  marginBps: number;
  lowerBps: number;
  upperBps: number;
  estimateBps: number;
  n: number;
  decision: 'non-inferior' | 'not-non-inferior' | 'insufficient';
}
