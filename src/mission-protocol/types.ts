export const MISSION_API_VERSION = 'mission.aiwg.io/v1' as const;

export type MissionState =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'operator-review'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'cancelled'
  | 'unknown';

export interface MissionArtifact {
  id: string;
  kind: string;
  uri?: string;
  sha256?: string;
  mediaType?: string;
  sizeBytes?: number;
  extensions?: Record<string, unknown>;
}

export interface CanonicalMission {
  apiVersion: typeof MISSION_API_VERSION;
  kind: 'Mission';
  metadata: {
    id: string;
    createdAt?: string;
    updatedAt?: string;
    parentId?: string;
    previousId?: string;
    lineage?: Array<{ relation: string; id: string }>;
  };
  spec: {
    objective: string;
    completionCriterion?: string;
    budgets?: { maxAttempts?: number; timeoutSeconds?: number; maxCostUsd?: number; maxTokens?: number };
  };
  status: {
    state: MissionState;
    terminal: boolean;
    nativeState?: string;
    sourceUpdatedAt?: string;
    partialOutput?: unknown;
    error?: { code?: string; message: string; retryable?: boolean };
    completion?: { satisfied: boolean; reason?: string };
    artifacts: MissionArtifact[];
    verification?: Array<{ name: string; status: 'passed' | 'failed' | 'skipped' | 'unknown'; evidence?: string }>;
  };
  provenance: {
    sourceContract: string;
    sourceVersion: string;
    transport?: string;
    sourceId?: string;
  };
  extensions?: Record<string, unknown>;
}

export interface MissionLoss {
  path: string;
  reason: string;
  severity: 'informational' | 'warning' | 'required';
}

export interface MissionDecodeResult {
  value: CanonicalMission;
  sourceVersion: string;
  warnings: string[];
  preservedExtensions: Record<string, unknown>;
  lossReport: MissionLoss[];
}

export interface MissionEncodeResult<T = unknown> {
  value: T;
  targetVersion: string;
  warnings: string[];
  lossReport: MissionLoss[];
}

export type MissionSource =
  | 'canonical'
  | 'mission-plan'
  | 'mission-ledger'
  | 'mission-control-session'
  | 'executor-v1'
  | 'fleet-workload-v1'
  | 'a2a'
  | 'uhp-2026-08-11'
  | 'graph-flow-v1'
  | 'cockpit'
  | 'activity-v1';

export type MissionTarget = Exclude<MissionSource, 'canonical'> | 'canonical';

// Worker dispatch payloads merged from 05 §5.1 into schemas/mission-v1.schema.json.
// The schema file is the executable contract; these types mirror its shapes.

export const WORKER_CONTRACT_REVISION = 1 as const;

export const WORKER_BASELINE_FEATURES = [
  'worker-dispatch.v1',
  'worker-policy-origins.v1',
  'worker-admission-fencing.v1',
  'worker-claims.v1',
  'worker-activation.v1',
] as const;

export const WORKER_OPTIONAL_FEATURES = ['worker-health.v1'] as const;

/** Adapter capability additionally required before Flow invokeNode. */
export const WORKER_FLOW_VALUE_FEATURE = 'worker-flow-values.v1' as const;

export const WORKER_KNOWN_FEATURES = [
  ...WORKER_BASELINE_FEATURES,
  ...WORKER_OPTIONAL_FEATURES,
  WORKER_FLOW_VALUE_FEATURE,
] as const;

export type WorkerFeature = (typeof WORKER_KNOWN_FEATURES)[number];

export const WORKER_DEFINITIONS = [
  'workerArtifact',
  'workerEffort',
  'workerTuple',
  'workerLimits',
  'workerSelectionIntent',
  'workerBrief',
  'workerClaims',
  'workerUsage',
  'workerExecution',
  'workerVerification',
  'workerResult',
  'workerDispatch',
  'workerDirectIntent',
  'workerDirectBrief',
  'workerResolvedInvocation',
  'workerDirectVerification',
  'workerDirectResult',
  'workerHealthSummary',
  'workerEffectiveHealth',
] as const;

export type WorkerDefinitionName = (typeof WORKER_DEFINITIONS)[number];

export interface WorkerArtifact {
  ref: string;
  digest: string;
}

export interface WorkerEffort {
  support: 'explicit' | 'not-applicable';
  value: string | null;
}

export interface WorkerTuple {
  group: string;
  member: string;
  cli: string;
  model: string;
  inferenceProvider: string;
  family: string;
  effort: WorkerEffort;
  profileRef: string;
  qualificationDigest: string;
}

export interface WorkerLimits {
  tokens: number;
  costUsd: number | null;
  wallSeconds: number;
  maxAttempts: number;
}

export interface WorkerAcceptance {
  id: string;
  criterion: string;
  checkRef: string;
}

export interface WorkerSelectionIntent {
  version: typeof WORKER_CONTRACT_REVISION;
  taskId: string;
  requestId: string;
  parent: { kind: 'mission' | 'flow' | 'ralph' | 'job'; id: string };
  objective: string;
  taskClass: string;
  role: 'efficiency' | 'coding' | 'reasoning';
  inputs: WorkerArtifact[];
  ownership: string[];
  requiredTools: string[];
  dataClass: string;
  group: string;
  pins: { member?: string; model?: string; effort?: WorkerEffort };
  allowFallback: boolean;
  limits: WorkerLimits;
  acceptance: WorkerAcceptance[];
  verification: { runnerRef: string; independentReview: 'required' | 'advisory'; differentFamily: 'require' | 'prefer' };
}

export interface WorkerBrief {
  version: typeof WORKER_CONTRACT_REVISION;
  invocationId: string;
  intent: WorkerSelectionIntent;
  intentDigest: string;
  decision: WorkerArtifact;
  policyDigest: string;
  catalogDigest: string;
  selected: WorkerTuple;
  lease: { authorityRef: string; generation: number; reservationId: string };
  workspace: { path: string; baseRevision: string | null };
  authorizationRefs: string[];
  delegationAllowance: 0;
  output: { schemaRef: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerClaims'; resultPath: string };
}

export interface WorkerClaim {
  id: string;
  text: string;
  evidence: WorkerArtifact[];
}

export interface WorkerClaimArtifact {
  path: string;
  digest: string;
  change: 'created' | 'modified' | 'deleted' | 'unchanged';
}

export interface WorkerClaimCheck {
  checkId: string;
  exitCode: number | null;
  evidence: WorkerArtifact;
  environment: string;
}

export interface WorkerClaims {
  version: typeof WORKER_CONTRACT_REVISION;
  status: 'completed' | 'partial' | 'blocked' | 'failed';
  summary: string;
  claims: WorkerClaim[];
  artifacts: WorkerClaimArtifact[];
  checks: WorkerClaimCheck[];
  limitations: string[];
}

export interface WorkerUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  quality: 'reported' | 'estimated' | 'unknown';
  reservedTokens: number;
  reservedUsd: number | null;
}

export interface WorkerExecution {
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'uncertain';
  exitCode: number | null;
  requested: WorkerTuple;
  observedModel: string | null;
  observedFamily: string | null;
  observedEffort: WorkerEffort | null;
  identityEvidence: WorkerArtifact[];
  identityQuality: 'backend-attested' | 'runtime-configured-only' | 'unavailable';
  startedAt: string;
  endedAt: string | null;
  termination: 'confirmed' | 'uncertain';
  usage: WorkerUsage;
  failure: {
    class: 'rate-limit' | 'unavailable' | 'timeout' | 'auth' | 'invalid-request' | 'policy' | 'parse' | 'verification' | 'unknown';
    message: string;
    retryable: boolean;
    quotaScope?: string;
    resetAt?: string;
  } | null;
  health?: WorkerHealthSummary;
}

export interface WorkerVerification {
  status: 'pending' | 'accepted' | 'rejected' | 'blocked';
  verifierId: string | null;
  runnerRef: string | null;
  artifactDigest: string | null;
  evidence: WorkerArtifact[];
  findings: string[];
}

export interface WorkerResult {
  version: typeof WORKER_CONTRACT_REVISION;
  taskId: string;
  invocationId: string;
  briefDigest: string;
  execution: WorkerExecution;
  worker: WorkerClaims | null;
  verification: WorkerVerification;
}

export interface WorkerDispatch {
  version: typeof WORKER_CONTRACT_REVISION;
  requiredFeatures: string[];
  taskId: string;
  requestId: string;
  invocationId: string;
  state: 'prepared' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'uncertain';
  intent: WorkerArtifact;
  brief: WorkerArtifact | null;
  result: WorkerArtifact | null;
  previousRecord: WorkerArtifact | null;
}

export interface WorkerDirectIntent {
  version: typeof WORKER_CONTRACT_REVISION;
  taskId: string;
  requestId: string;
  parent?: { kind: 'conductor-session'; id: string } | null;
  objective: string;
  taskClass: string;
  role: 'efficiency' | 'coding' | 'reasoning';
  inputs: WorkerArtifact[];
  ownership: string[];
  requiredTools: string[];
  dataClass: string;
  group: string;
  pins: { member?: string; model?: string; effort?: WorkerEffort };
  allowFallback: boolean;
  limits: WorkerLimits;
  acceptance: WorkerAcceptance[];
  verification: {
    runnerRef?: string | null;
    independentReview: 'required' | 'advisory';
    differentFamily: 'require' | 'prefer';
    controlledContext: string;
  };
}

export interface WorkerDirectBrief {
  version: typeof WORKER_CONTRACT_REVISION;
  invocationId: string;
  intent: WorkerDirectIntent;
  intentDigest: string;
  decision?: WorkerArtifact;
  policyDigest: string;
  catalogDigest: string;
  selected: WorkerTuple;
  workspace: { path: string; baseRevision: string | null };
  authorizationRefs: string[];
  delegationAllowance: 0;
  output: { schemaRef: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerClaims'; resultPath: string };
  mode: 'direct';
}

export interface WorkerResolvedInvocation {
  version: typeof WORKER_CONTRACT_REVISION;
  mode: 'direct' | 'managed';
  transport: 'shell' | 'mcp';
  selected: WorkerTuple;
  policyDigest: string;
  catalogDigest: string;
  profileDigest: string;
  expiresAt: string;
  argv?: string[];
  cwd?: string;
  stdin?: 'closed' | 'brief-text' | 'brief-json';
  briefPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  finalPath?: string;
  shellCommand?: string;
  envNames?: string[];
  mcp?: {
    serverRef: string;
    tool: string;
    arguments: Record<string, unknown>;
    inputSchemaDigest: string;
    timeoutSeconds: number;
    outputSchemaDigest: string;
    sessionIsolation: 'per-call' | 'per-instance' | 'serialized';
  };
  readiness: 'preparatory' | 'launchable';
  briefDigest: string | null;
  limits: WorkerLimits;
  maxOutputBytes: number;
  effectiveCaps: Record<string, number>;
  controlEvidence: string[];
  /** Legacy and preparatory payloads may omit health; runtime owners use defaults. */
  health?: WorkerEffectiveHealth;
}

export interface WorkerDirectVerification {
  status: 'pending' | 'accepted' | 'rejected' | 'blocked';
  verifierId: string | null;
  runnerRef: string | null;
  artifactDigest: string | null;
  evidence: WorkerArtifact[];
  findings: string[];
  controlledContext: string | null;
}

export interface WorkerDirectResult {
  version: typeof WORKER_CONTRACT_REVISION;
  taskId: string;
  invocationId: string;
  briefDigest: string;
  execution: WorkerExecution;
  worker: WorkerClaims | null;
  verification: WorkerDirectVerification;
  mode: 'direct';
}

export interface WorkerHealthSummary {
  version: typeof WORKER_CONTRACT_REVISION;
  state: 'launching' | 'started' | 'active' | 'quiet' | 'stalled' | 'hung' | 'crashed' | 'failed-to-start' | 'completed' | 'failed' | 'cancelled';
  coverage: 'full' | 'degraded' | 'unobserved';
  handshake: 'semantic' | 'process-only' | 'unobserved';
  lastObservedAt: string | null;
  lastActivityAt: string | null;
  lastProgressAt: string | null;
  reasonCode: string;
  termination: 'running' | 'confirmed' | 'uncertain';
  transitionCount: number;
  restartCount: number;
  unavailableSignals: string[];
  transitionRefs: WorkerArtifact[];
  observerGeneration: number | null;
  startupDeadlineAt: string | null;
  hardDeadlineAt: string | null;
  maxCheckGapSeconds: number | null;
  confidence: 'observed' | 'suspected' | 'unobserved';
  handshakeAt: string | null;
  stalledAt: string | null;
}

export interface WorkerEffectiveHealth {
  version: typeof WORKER_CONTRACT_REVISION;
  startupSeconds: number;
  checkSeconds: number;
  quietSeconds: number;
  stallSeconds: number;
  diagnosticGraceSeconds: number;
  terminateGraceSeconds: number;
  hardTimeoutSeconds: number;
  maxSteps: number;
  stepEnforcement: 'native' | 'external' | 'observed' | 'unavailable';
  scale: number;
  profileRef: string;
  runDir: string | null;
}

/** Observer-only bounded diagnostics; never accepted from workerClaims. */
export interface WorkerHealthEvidence {
  invocationId: string;
  sequence: number;
  observerGeneration: number;
  lastWorkerHeartbeatAt: string | null;
  cpuTimeMs: number | null;
  steps: number | null;
  gaps: Array<{ sequence: number; reasonCode: string; source: string }>;
  events: Array<{ sequence: number; kind: string; source: string; generation: number; offset: number; keyDigest: string | null }>;
}

/** Producer ownership from 06 §6–7. Workers emit claims; trusted code assembles results. */
export type WorkerDefinitionProducer =
  | 'conductor'
  | 'worker'
  | 'adapter'
  | 'verifier'
  | 'trusted-assembly'
  | 'shared-component';

export const WORKER_DEFINITION_PRODUCERS: Record<WorkerDefinitionName, WorkerDefinitionProducer> = {
  workerArtifact: 'shared-component',
  workerEffort: 'shared-component',
  workerTuple: 'shared-component',
  workerLimits: 'shared-component',
  workerSelectionIntent: 'conductor',
  workerBrief: 'conductor',
  workerClaims: 'worker',
  workerUsage: 'shared-component',
  workerExecution: 'adapter',
  workerVerification: 'verifier',
  workerResult: 'trusted-assembly',
  workerDispatch: 'conductor',
  workerDirectIntent: 'conductor',
  workerDirectBrief: 'conductor',
  workerResolvedInvocation: 'conductor',
  workerDirectVerification: 'verifier',
  workerDirectResult: 'trusted-assembly',
  workerHealthSummary: 'shared-component',
  workerEffectiveHealth: 'shared-component',
};

/** Trusted registration metadata a consumer reports before any task data handoff. */
export interface WorkerConsumerSupport {
  revision: number;
  bundleDigest: string;
  features?: string[];
  lossless: boolean;
}

export interface WorkerNegotiationRequest {
  requiredFeatures: readonly string[];
  bundleDigest: string;
}

export type WorkerNegotiationVerdict = 'supported' | 'OG_CONTRACT_UNSUPPORTED';

export type WorkerContractCode = 'OG_CONTRACT_UNSUPPORTED' | 'OG_CONTRACT_INVALID';

export class WorkerContractError extends Error {
  readonly code: WorkerContractCode;
  constructor(code: WorkerContractCode, message: string) {
    super(message);
    this.name = 'WorkerContractError';
    this.code = code;
  }
}
