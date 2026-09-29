import type {
  ArtifactPin,
  DecisionDefinition,
  DecisionBinding,
  DecisionRuleset,
  JsonValue,
  RulesetResult,
} from '../types.js';

export type SensitivityDigest = `sha256:${string}`;
export type SensitivityAnalysisKind = 'policy-replay' | 'input-reevaluation';
export type SensitivityMode = 'disabled' | 'shadow';
export type SensitivityReportStatus = 'completed' | 'partial' | 'budget-exhausted' | 'rejected' | 'failed';
export type SensitivityInference = 'reused-stored-evidence' | 'new-invocation' | 'deduplicated-control';
export type SensitivityRowKind = 'variant' | 'unchanged-control' | 'baseline-stability';
export type SensitivityDataClass = 'public' | 'internal' | 'confidential' | 'restricted';

export interface SensitivityActor {
  principalId: string;
  authenticatedAt: string;
}

export interface SensitivitySubject {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  subjectRef: string;
}

export interface SensitivityChange {
  path: string;
  value: JsonValue;
}

export interface SensitivityVariant {
  id: string;
  changes: SensitivityChange[];
}

export interface SensitivityPathDomain {
  path: string;
  values: JsonValue[];
  sensitivity: SensitivityDataClass;
}

export interface SensitivityPlan {
  schemaVersion: 'decision-sensitivity-plan/v1';
  id: string;
  version: string;
  mode: SensitivityMode;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  actor: SensitivityActor;
  purpose: string;
  sourceSubject: SensitivitySubject;
  source: {
    ruleset: ArtifactPin;
    binding: ArtifactPin;
    result: ArtifactPin;
    evidencePins: ArtifactPin[];
    policyPins: ArtifactPin[];
  };
  analysisKind: SensitivityAnalysisKind;
  allowedPaths: string[];
  pathDomains: SensitivityPathDomain[];
  variants: SensitivityVariant[];
  budgets: {
    maxVariants: number;
    maxBackendCalls: number;
    maxTokens: number;
    maxCostMicros: number;
    concurrency: number;
    deadlineMs: number;
  };
  privacy: {
    egress: 'metadata-only' | 'no-external-egress';
    redaction: 'hash-values' | 'opaque-ids';
    summaryPrecisionBps: number;
    differencing: 'deny' | 'coarsen';
  };
  retention: {
    class: 'ephemeral' | 'review-evidence';
    deleteAfterEpochMs: number;
    legalHold: boolean;
  };
  baselineStability: { enabled: boolean; repeats: number };
  unchangedVariant: 'deduplicate' | 'retain-control';
  authorization: {
    authorizedLabels: string[];
    authorizedActions: string[];
    approvedAt: string;
    expiresAt: string;
  };
  probeControl: {
    windowId: string;
    maxPerPrincipalSubjectPath: number;
    maxReportsPerWindow: number;
    prohibitMembershipQueries: boolean;
  };
  requestedMetrics: Array<'outcome-change' | 'acceptance-change' | 'rule-change' | 'distribution-distance' | 'minimum-threshold-change' | 'stability-repeat'>;
  comparisonBaseline: 'source-result' | 'stability-control';
}

export interface SensitivityRedactedChange {
  path: string;
  valueDigest: SensitivityDigest;
  sensitivity: SensitivityDataClass;
}

export interface SensitivityReportRow {
  variantId: string;
  kind: SensitivityRowKind;
  changes: SensitivityRedactedChange[];
  inference: SensitivityInference;
  sourceReceipt: ArtifactPin;
  counterfactualReceipt: ArtifactPin | null;
  resultDigest: SensitivityDigest;
  freshInvocationId: string | null;
  deltas: {
    outcomeChanged: boolean;
    acceptanceChanged: boolean;
    ruleChanged: boolean;
    firstChangedRule: string | null;
    distributionDistanceBps: number | null;
    status: string;
    reason: string;
  };
  resourceUse: {
    backendCalls: number;
    tokens: number;
    costMicros: number;
  };
  warnings: string[];
}

export interface SensitivityReport {
  schemaVersion: 'decision-sensitivity-report/v1';
  id: string;
  plan: ArtifactPin;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  sourceSubject: SensitivitySubject;
  analysisKind: SensitivityAnalysisKind;
  semantics: 'associative-sensitivity-not-causal';
  actionAuthorization: 'not-authorized';
  status: SensitivityReportStatus;
  generatedAt: string;
  privacy: {
    redaction: 'hash-values' | 'opaque-ids';
    summaryPrecisionBps: number;
  };
  retention: SensitivityPlan['retention'];
  budget: {
    maxVariants: number;
    processedVariants: number;
    backendCalls: number;
    tokens: number;
    costMicros: number;
    exhausted: boolean;
  };
  baseline: {
    resultRef: ArtifactPin;
    outcomeDigest: SensitivityDigest;
    status: string;
    reason: string;
  };
  rows: SensitivityReportRow[];
  summary: {
    totalRows: number;
    changedOutcomes: number;
    changedAcceptance: number;
    changedRules: number;
    minimumThresholdChangeBps: number | null;
  };
  warnings: string[];
  digest: SensitivityDigest;
}

export interface SensitivityProbeState {
  reportsByWindow?: Map<string, number>;
  pathCounts?: Map<string, number>;
}

export interface SensitivityReevaluationRequest {
  variantId: string;
  invocationId: string;
  receiptFingerprint: SensitivityDigest;
  input: unknown;
  changes: SensitivityChange[];
}

export interface SensitivityRuntimeRequest {
  plan: SensitivityPlan;
  sourceRuleset: DecisionRuleset;
  sourceBinding: DecisionBinding;
  sourceDefinitions?: Record<string, DecisionDefinition>;
  sourceInput: unknown;
  sourceResult: RulesetResult;
  generatedAt: string;
  now?: () => number;
  probeState?: SensitivityProbeState;
  reevaluate?: (request: SensitivityReevaluationRequest) => Promise<RulesetResult>;
}
