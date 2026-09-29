import type { DecisionProjectionEvidence, DecisionProjectionPolicy } from '../projection.js';
import type { DecisionChampionChallenger, DecisionDriftResponse, DriftSignal, EnsembleDigest } from '../ensemble/types.js';
import type { AliasEvent } from '../calibration/types.js';
import type { PairedDifferenceInterval } from '../qualification/quality.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';

/** No mode lets Jev choose the executed route: shadow executes only the deterministic route. */
export type RoutingMode = 'disabled' | 'shadow';
export type RoutingDigest = `sha256:${string}`;

export type RoutingHardConstraint =
  | 'privacy' | 'authorization' | 'region' | 'tools' | 'context'
  | 'allowlist' | 'budget' | 'deadline' | 'health' | 'executable';

export type RoutingExclusionReason =
  | 'privacy-denied' | 'authorization-denied' | 'region-denied' | 'tool-denied'
  | 'context-denied' | 'allowlist-denied' | 'budget-denied' | 'deadline-denied'
  | 'health-denied' | 'not-executable' | 'capability-denied' | 'permission-denied' | 'provider-denied';

export type RoutingDecisionStatus = 'disabled' | 'no-route' | 'review' | 'selected';
export type RoutingAttemptStatus = 'succeeded' | 'failed';
export type RoutingDispatchFailure = 'rate-limit' | 'outage' | 'circuit-open' | 'timeout' | 'rejected' | 'failed' | 'cancelled';
export type RoutingSkipReason = 'circuit-open' | 'budget-exhausted' | 'deadline-exhausted' | 'reservation-denied';

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

/** Validated against `DecisionRoutingTask.v1`. `description` is operator-facing and never model-visible:
 * only `state` fields declared by the D10 `projection` reach Jev. */
export interface RoutingTask {
  id: string;
  description: string;
  requirements: {
    capabilities: string[];
    privacy: string;
    authorizationScopes: string[];
    region: string;
    /** Tools the task needs; a route lacking one is excluded. */
    tools: string[];
    contextBytes: number;
    allowlist: string[];
    maxCostMicros: number;
    deadlineMs: number;
    /** Providers ordinary authorization allows for this task. */
    providers: string[];
    /** Ordinary authorization ceiling: a route whose binding holds more is excluded, never narrowed. */
    authorized: RouteCandidate['permissions'];
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
    /** Always true: uncalibrated or unknown evidence is review, never a Jev selection. */
    calibrationRequired: true;
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
  /** `substituted`: the worker ran but reported a provider/model other than the binding's pin, or none. */
  reason: 'none' | RoutingDispatchFailure | 'invalid-result' | 'substituted';
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

/** The Jev-assisted policy's choice, recorded for shadow comparison only; it never executes. */
export interface RoutingCounterfactual {
  status: 'not-evaluated' | 'selected' | 'deterministic-fallback' | 'review';
  reason: string;
  routeId: string | null;
  /** Eligible routes by deterministic utility, best first; empty unless the evidence was valid. */
  ranking: string[];
}

export interface RoutingReceipt {
  schemaVersion: 'decision-route-receipt/v1';
  routing: { id: string; version: string; policyVersion: string; mode: RoutingMode; digest: RoutingDigest };
  /** `id` is null when the task itself failed validation. */
  task: { id: string | null; projection: DecisionProjectionEvidence | null };
  status: RoutingDecisionStatus;
  reason: string;
  candidatePins: RoutingCandidatePinReceipt[];
  eligibleRouteIds: string[];
  excluded: Array<{ routeId: string; reasons: RoutingExclusionReason[] }>;
  jev: JevRoutingEvidence | null;
  counterfactual: RoutingCounterfactual;
  /** The route that actually executed successfully, or the planned deterministic route without dispatch. */
  selectedRouteId: string | null;
  selectionReason: string;
  actual: { workerId: string | null; provider: string | null; model: string | null };
  attempts: RouteAttemptReceipt[];
  skipped: Array<{ routeId: string; reason: RoutingSkipReason }>;
  fallbacks: string[];
  budget: { limitMicros: number | null; spentMicros: number | null };
  deadlineEpochMs: number | null;
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
  /** Retry/fallback backoff; defaults to a real timer. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Attempt-deadline timer raced against dispatch; defaults to a real timer. */
  timer?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Mandatory with `dispatch`: admission for the one route about to be attempted. */
  reserve?: (candidate: RouteCandidate, attemptOrdinal: number) => boolean | Promise<boolean>;
  /** Mandatory with `dispatch`: called once for every granted reservation with the charged cost (null = unknown). */
  release?: (candidate: RouteCandidate, attemptOrdinal: number, chargedCostMicros: number | null) => void | Promise<void>;
  evidence?: (request: {
    task: Pick<RoutingTask, 'id'>;
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
  /** Actual spend across every attempt for the task, including failed and rerouted ones. */
  attemptCostMicros: number;
  /** Downstream correction cost attributed to the task. */
  reworkCostMicros: number;
  /** The task's budget; compliance compares actual attempt spend against it. */
  budgetMicros: number;
  latencyMs: number;
  accepted: boolean;
  policyViolation: boolean;
}

export interface RoutingPromotionThresholds {
  /** At least ROUTING_MINIMUM_OVERALL_N paired tasks. */
  minimumOverallN: number;
  /** At least ROUTING_MINIMUM_SLICE_N paired tasks in every preregistered slice. */
  minimumSliceN: number;
  ciMethod: 'newcombe-10' | 'tango';
  ciLevelBps: number;
  /** The candidate's success rate may be at most this many bps worse (paired interval lower bound). */
  qualityNonInferiorityMarginBps: number;
  maxFailureRate: number;
  maxReworkRate: number;
  maxFallbackRate: number;
  maxHumanOverrideRate: number;
  maxLatencyP95IncreaseMs: number;
  maxProviderCallsPerTask: number;
  /** Risk adjustment charged per failed task and per human override. */
  failurePenaltyMicros: number;
  humanOverridePenaltyMicros: number;
  budgetComplianceRequired: boolean;
  positiveNetEconomicsRequired: boolean;
}

export interface RoutingEvalIntegrityMetadata extends QualificationIntegrityMetadata {}

/** Frozen before holdout access; its digest must be anchored separately (a caller cannot attest its own preregistration). */
export interface RoutingPreregistration {
  schemaVersion: 'decision-routing-preregistration/v1';
  policy: RoutingPin;
  baselineArm: 'fixed' | 'heuristic';
  registeredAt: string;
  /** The paired held-out task set with its preregistered slice, sorted by id. */
  tasks: Array<{ id: string; slice: string }>;
  thresholds: RoutingPromotionThresholds;
  digest: RoutingDigest;
}

export interface RoutingShadowArmSummary {
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
  attemptCostMicros: number;
  reworkCostMicros: number;
  totalCostMicros: number;
  riskAdjustedCostMicros: number;
  overBudgetTasks: number;
  latencyMsP95: number;
  policyViolations: number;
}

export interface RoutingShadowReport {
  schemaVersion: 'decision-routing-shadow-report/v1';
  id: string;
  preregistration: RoutingPreregistration;
  holdoutAccessedAt: string | null;
  evaluatedAt: string;
  /** Carried so any verifier can rebuild the report and its decision. Sorted by (taskId, arm). */
  observations: RoutingShadowArmObservation[];
  arms: RoutingShadowArmSummary[];
  comparisons: {
    baselineArm: 'fixed' | 'heuristic';
    candidateArm: 'jev-assisted';
    pairedN: number;
    quality: {
      marginBps: number;
      interval: PairedDifferenceInterval | null;
      decision: 'non-inferior' | 'not-non-inferior' | 'insufficient';
    };
    economics: { baselineRiskAdjustedMicros: number; candidateRiskAdjustedMicros: number; netSavingsMicros: number };
    latencyP95IncreaseMs: number;
    providerCallsPerTask: number;
    budgetCompliant: boolean;
  };
  integrity: RoutingEvalIntegrityMetadata;
  integrityFindings: string[];
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  reasons: string[];
  digest: RoutingDigest;
}

export interface RoutingActiveRunPin {
  runId: string;
  policy: RoutingPin;
  aliasRevision: number;
  identityDigest: EnsembleDigest;
}

/** Host-owned routing control plane: pinned policy history, the Jev route circuit and active-run pins. */
export interface RoutingPolicyControl {
  /** Pinned routing policy versions, oldest first; the last entry is current. */
  policyHistory(): readonly RoutingPin[];
  /** Makes `target` current for new runs only and returns the new current pin. */
  restorePolicy(target: RoutingPin, approvalReference: string, at: string): RoutingPin;
  openJevCircuit(reason: string, at: string): void;
  activeRunPins(): readonly RoutingActiveRunPin[];
}

export interface RoutingControlDrillInput {
  championChallenger: DecisionChampionChallenger;
  driftPolicy: DecisionDriftResponse;
  driftSignal: DriftSignal;
  approvalReference: string;
  gateway: {
    aliasHistory(alias: string): readonly AliasEvent[];
    promoteAlias(eligibilityId: string, at: string): AliasEvent;
    rollbackAlias(alias: string, targetRevision: number, approvalReference: string, at: string): AliasEvent;
  };
  control: RoutingPolicyControl;
  at: string;
}

export interface RoutingControlDrillResult {
  driftResponse: string | null;
  previousPolicy: RoutingPin;
  restoredPolicy: RoutingPin | null;
  rollbackEvent: AliasEvent | null;
  jevCircuitOpen: boolean;
  /** Re-read after the response ran and verified equal to the pins read before it. */
  activeRunPins: RoutingActiveRunPin[];
}
