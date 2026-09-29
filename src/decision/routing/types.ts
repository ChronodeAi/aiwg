import type { DecisionProjectionEvidence, DecisionProjectionPolicy } from '../projection.js';
import type { DecisionChampionChallenger, DecisionDriftResponse, DriftSignal, EnsembleDigest } from '../ensemble/types.js';
import type { AliasEvent } from '../calibration/types.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';

export type RoutingMode = 'disabled' | 'shadow';
export type RoutingDigest = `sha256:${string}`;

export type RoutingHardConstraint =
  | 'privacy' | 'authorization' | 'region' | 'tools' | 'context'
  | 'allowlist' | 'budget' | 'deadline' | 'health' | 'executable';

export type RoutingExclusionReason =
  | 'privacy-denied' | 'authorization-denied' | 'region-denied' | 'tool-denied'
  | 'context-denied' | 'allowlist-denied' | 'budget-denied' | 'deadline-denied'
  | 'health-denied' | 'not-executable' | 'capability-denied' | 'reservation-denied';

export type RoutingDecisionStatus = 'disabled' | 'no-route' | 'review' | 'selected';
export type RoutingAttemptStatus = 'succeeded' | 'failed' | 'skipped';
export type RoutingDispatchFailure = 'rate-limit' | 'outage' | 'circuit-open' | 'timeout' | 'rejected' | 'failed';

export interface RoutingPin { id: string; version: string; digest: RoutingDigest }

export interface RouteCandidate {
  id: string;
  binding: RoutingPin;
  model: { provider: string; backend: string; requested: string; pinnedVersion: string };
  subagent: RoutingPin | null;
  capabilities: string[];
  permissions: {
    tools: string[];
    network: boolean;
    filesystem: 'none' | 'read' | 'write';
    secrets: string[];
    actions: string[];
  };
  policy: {
    privacy: string[];
    authorizationScopes: string[];
    regions: string[];
    contextBytes: number;
    allowlisted: boolean;
    executable: boolean;
  };
  operations: {
    health: 'healthy' | 'degraded' | 'rate-limited' | 'outage' | 'circuit-open';
    latencyMsP95: number;
    priceCatalogVersion: string;
    costMicrosPerAttempt: number | null;
    maxAttempts: number;
    deadlineMs: number;
  };
}

export interface RoutingTask {
  id: string;
  description: string;
  requirements: {
    capabilities: string[];
    privacy: string;
    authorizationScopes: string[];
    region: string;
    tools: string[];
    contextBytes: number;
    allowlist: string[];
    maxCostMicros: number;
    deadlineMs: number;
  };
  state: unknown;
  projection: DecisionProjectionPolicy;
}

export interface RoutingUtilityWeights {
  taskFit: number;
  complexityFit: number;
  ambiguityPenalty: number;
  latencyPenalty: number;
  costPenalty: number;
  healthPenalty: number;
}

export interface RoutingPolicy {
  schemaVersion: 'decision-routing-policy/v1';
  id: string;
  version: string;
  mode: RoutingMode;
  policyVersion: string;
  candidates: RouteCandidate[];
  defaultRouteId: string | null;
  deterministicFallbackRouteId: string | null;
  utility: RoutingUtilityWeights;
  ceilings: {
    maxAttempts: number;
    maxFallbacks: number;
    maxCostMicros: number;
    deadlineMs: number;
    retryDelayMs: number;
    unknownCost: 'reject';
  };
  jevEvidence: {
    enabled: boolean;
    calibrationRequired: boolean;
    compatibleProfiles: string[];
    uncertaintyThresholdBps: number;
  };
}

export interface RouteCandidateSummary {
  id: string;
  capabilities: string[];
  provider: string;
  backend: string;
  requestedModel: string;
  pinnedModelVersion: string;
  subagentId: string | null;
  health: RouteCandidate['operations']['health'];
  latencyMsP95: number;
  costMicrosPerAttempt: number | null;
}

export interface JevRoutingEvidence {
  schemaVersion: 'decision-routing-jev-evidence/v1';
  provider: 'jev';
  model: string;
  profile: string;
  calibration: 'calibrated' | 'uncalibrated' | 'unknown';
  provenance: { adapterVersion: string; requestDigest: RoutingDigest; responseDigest: RoutingDigest };
  taskComplexity: number;
  ambiguity: number;
  distributions: Array<{ routeId: string; taskFit: number; reasoningNeed: number }>;
}

export interface RoutingEligibleCandidate {
  candidate: RouteCandidate;
  summary: RouteCandidateSummary;
}

export interface RouteAttemptReceipt {
  ordinal: number;
  routeId: string;
  status: RoutingAttemptStatus;
  reason: 'none' | RoutingDispatchFailure | 'not-attempted';
  actualProvider: string | null;
  actualModel: string | null;
  workerId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costMicros: number | null };
  latencyMs: number | null;
}

export interface RoutingCandidatePinReceipt {
  routeId: string;
  binding: RoutingPin;
  model: RouteCandidate['model'];
  subagent: RoutingPin | null;
  health: RouteCandidate['operations']['health'];
  priceCatalogVersion: string;
  latencyMsP95: number;
  costMicrosPerAttempt: number | null;
}

export interface RoutingReceipt {
  schemaVersion: 'decision-route-receipt/v1';
  routing: { id: string; version: string; policyVersion: string; mode: RoutingMode; digest: RoutingDigest };
  task: { id: string; projection: DecisionProjectionEvidence | null };
  status: RoutingDecisionStatus;
  reason: string;
  candidatePins: RoutingCandidatePinReceipt[];
  eligibleRouteIds: string[];
  excluded: Array<{ routeId: string; reasons: RoutingExclusionReason[] }>;
  jev: JevRoutingEvidence | null;
  selectedRouteId: string | null;
  selectionReason: string;
  actual: { workerId: string | null; provider: string | null; model: string | null };
  attempts: RouteAttemptReceipt[];
  fallbacks: string[];
  usage: { inputTokens: number | null; outputTokens: number | null; costMicros: number | null };
  outcome: { verified: boolean | null; label: string | null };
  createdAtEpochMs: number;
  digest: RoutingDigest;
}

export interface RoutingDispatchResult {
  status: 'success' | 'failure';
  reason: 'none' | RoutingDispatchFailure;
  actualProvider: string | null;
  actualModel: string | null;
  workerId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  latencyMs: number | null;
  verified: boolean | null;
  outcomeLabel: string | null;
}

export interface RoutingRuntimeOptions {
  enabled?: boolean;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  reserve?: (candidate: RouteCandidate, attemptOrdinal: number) => boolean | Promise<boolean>;
  evidence?: (request: {
    task: Pick<RoutingTask, 'id' | 'description'>;
    projectedState: Readonly<Record<string, unknown>>;
    projection: DecisionProjectionEvidence;
    candidates: RouteCandidateSummary[];
  }) => Promise<JevRoutingEvidence>;
  dispatch?: (request: {
    candidate: RouteCandidate;
    attemptOrdinal: number;
    deadlineEpochMs: number;
    signal: AbortSignal;
  }) => Promise<RoutingDispatchResult>;
}

export interface RoutingShadowArmObservation {
  arm: 'fixed' | 'heuristic' | 'jev-assisted';
  taskId: string;
  slice: string;
  success: boolean;
  rework: boolean;
  fallback: boolean;
  humanOverride: boolean;
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalCostMicros: number;
  latencyMs: number;
  accepted: boolean;
  policyViolation: boolean;
}

export interface RoutingPromotionThresholds {
  minimumOverallN: number;
  minimumSliceN: number;
  ciMethod: 'wilson';
  ciLevel: number;
  qualityNonInferiorityMargin: number;
  maxFailureRate: number;
  maxReworkRate: number;
  maxFallbackRate: number;
  budgetComplianceRequired: boolean;
  positiveNetEconomicsRequired: boolean;
}

export interface RoutingEvalIntegrityMetadata extends QualificationIntegrityMetadata {}

export interface RoutingShadowReport {
  schemaVersion: 'decision-routing-shadow-report/v1';
  id: string;
  policy: RoutingPin;
  preregistration: { thresholdsDigest: RoutingDigest; registeredAt: string; holdoutAccessedAt: string | null };
  thresholds: RoutingPromotionThresholds;
  arms: Array<{
    arm: RoutingShadowArmObservation['arm'];
    sampleN: number;
    slices: Record<string, { sampleN: number; successRate: number; failureRate: number; reworkRate: number; fallbackRate: number }>;
    successRate: number;
    failureRate: number;
    reworkRate: number;
    fallbackRate: number;
    selectiveCoverage: number;
    humanOverrideRate: number;
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalCostMicros: number;
    latencyMsP95: number;
    policyViolations: number;
  }>;
  comparisons: {
    baselineArm: 'fixed' | 'heuristic';
    candidateArm: 'jev-assisted';
    qualityDelta: number | null;
    netSavingsMicros: number | null;
    budgetCompliant: boolean;
  };
  integrity: RoutingEvalIntegrityMetadata;
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  reasons: string[];
  digest: RoutingDigest;
}

export interface RoutingControlDrillInput {
  championChallenger: DecisionChampionChallenger;
  driftPolicy: DecisionDriftResponse;
  driftSignal: DriftSignal;
  aliasHistory: readonly AliasEvent[];
  activeRunIds: readonly string[];
  approvalReference: string;
  gateway: {
    aliasHistory(alias: string): readonly AliasEvent[];
    promoteAlias(eligibilityId: string, at: string): AliasEvent;
    rollbackAlias(alias: string, targetRevision: number, approvalReference: string, at: string): AliasEvent;
  };
  at: string;
}

export interface RoutingControlDrillResult {
  runPins: Array<{ runId: string; aliasRevision: number; identityDigest: EnsembleDigest }>;
  driftResponse: string | null;
  rollbackEvent: AliasEvent | null;
}
