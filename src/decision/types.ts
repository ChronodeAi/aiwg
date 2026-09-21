export const DECISION_API_VERSION = 'decision.aiwg.io/v1alpha1' as const;
export const DECISION_API_VERSION_STRUCTURED = 'decision.aiwg.io/v1alpha2' as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
/** Portable, bounded JSON semantic entry. Admission limits are enforced at runtime. */
export type EntryType = JsonValue;
export type JsonSchema = Record<string, unknown>;

export interface ArtifactMetadata {
  id: string;
  version: string;
  description: string;
}

export interface ArtifactPin {
  id: string;
  version: string;
  digest: `sha256:${string}`;
}

export type DecisionAnswer =
  | { kind: 'choice'; options: Array<{ id: string; description: EntryType }> }
  | { kind: 'ordinal-score'; levels: EntryType[] }
  | { kind: 'truth-probability'; trueDescription: EntryType; falseDescription: EntryType };

export interface DecisionDefinition {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'DecisionDefinition';
  metadata: ArtifactMetadata;
  spec: {
    purpose: string;
    inputSchema: JsonSchema;
    question: Exclude<EntryType, null>;
    answer: DecisionAnswer;
    requiredCapabilities: string[];
  };
}

export interface PredicateSource {
  source: 'input' | 'decision';
  alias?: string;
  pointer: string;
}

export type DecisionPredicate =
  | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; left: PredicateSource; right: JsonValue }
  | { op: 'exists'; left: PredicateSource }
  | { all: DecisionPredicate[] }
  | { any: DecisionPredicate[] }
  | { not: DecisionPredicate };

export interface DecisionRuleset {
  apiVersion: typeof DECISION_API_VERSION;
  kind: 'DecisionRuleset';
  metadata: ArtifactMetadata;
  spec: {
    purpose: string;
    inputSchema: JsonSchema;
    evaluations: Array<{ alias: string; decision: ArtifactPin; inputPointer: string }>;
    rules: Array<{ id: string; priority: number; when: DecisionPredicate; outcome: JsonValue }>;
    composition: 'first-match' | 'collect';
    conflict: 'error' | 'review';
    defaultOutcome: JsonValue;
    failureOutcome: JsonValue;
    outputSchema: JsonSchema;
  };
}

export type DecisionFailureReason =
  | 'none' | 'invalid-input' | 'invalid-definition' | 'digest-mismatch'
  | 'unauthorized' | 'data-boundary-denied' | 'unsupported-capability'
  | 'executor-unavailable' | 'invalid-output' | 'low-confidence'
  | 'missing-confidence' | 'confidence-profile-mismatch'
  | 'insufficient-information' | 'timeout' | 'network-transient'
  | 'rate-limited' | 'overloaded' | 'service-error' | 'authentication'
  | 'invalid-request' | 'budget-exhausted' | 'cancelled'
  | 'persistence-error' | 'replay-mismatch' | 'execution-uncertain'
  | 'no-match' | 'conflicting-outcomes' | 'evaluation-failed';

export interface ExecutionTarget {
  adapter: 'jev' | 'llm-subagent';
  adapterVersion: string;
  model: string;
  subagent?: ArtifactPin;
  credentialRef?: string;
  requiredCapabilities: string[];
  acceptance:
    | { mode: 'typed-value' }
    | { mode: 'confidence-threshold'; profile: string; minimumBps: number };
  timeoutMs: number;
  retry: { maxRetries: number; initialDelayMs: number; maxDelayMs: number };
}

export interface DecisionBinding {
  apiVersion: typeof DECISION_API_VERSION;
  kind: 'DecisionBinding';
  metadata: ArtifactMetadata;
  spec: {
    ruleset: ArtifactPin;
    totalTimeoutMs: number;
    maxAttempts: number;
    concurrency: number;
    evaluations: Record<string, { targets: ExecutionTarget[]; fallbackOn: DecisionFailureReason[] }>;
  };
}

export interface DecisionUncertainty {
  source: 'provider' | 'model-self-report' | 'derived';
  profile: string;
  calibration: 'vendor-claimed' | 'uncalibrated' | 'measured';
  confidence: number | null;
  distribution: Record<string, number> | null;
  calibrationRef: string | null;
}

export interface DecisionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface DecisionAttempt {
  ordinal: number;
  adapter: string;
  adapterVersion: string;
  requestedModel: string;
  actualModel: string | null;
  subagent: ArtifactPin | null;
  status: DecisionStatus;
  reason: DecisionFailureReason;
  durationMs: number;
  usage: DecisionUsage;
  requestId: string | null;
}

export type DecisionStatus = 'success' | 'abstained' | 'error' | 'unsupported' | 'cancelled';

export interface DecisionResult {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'DecisionResult';
  metadata: ArtifactMetadata;
  spec: {
    decision: ArtifactPin;
    ruleset: ArtifactPin;
    binding: ArtifactPin;
    alias: string;
    runId: string;
    invocationId: string;
    status: DecisionStatus;
    value?: string | number;
    reason: DecisionFailureReason;
    uncertainty: DecisionUncertainty | null;
    attempts: DecisionAttempt[];
  };
}

export interface RulesetResult {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'RulesetResult';
  metadata: ArtifactMetadata;
  spec: {
    ruleset: ArtifactPin;
    binding: ArtifactPin;
    runId: string;
    invocationId: string;
    status: 'completed' | 'defaulted' | 'review' | 'error' | 'cancelled';
    reason: DecisionFailureReason;
    outcome?: JsonValue;
    matchedRules: string[];
    evaluations: Record<string, DecisionResult>;
  };
}

export interface AdapterCapabilities {
  answerKinds: DecisionAnswer['kind'][];
  features: string[];
  maxOptions: number | null;
  maxLevels: number | null;
  confidenceProfiles: string[];
  executable: boolean;
}

export interface AdapterObservation {
  status: DecisionStatus;
  reason: DecisionFailureReason;
  value?: string | number;
  uncertainty: DecisionUncertainty | null;
  actualModel: string | null;
  usage: DecisionUsage;
  requestId: string | null;
  /** Transport hint used only by the dispatcher; never persisted as decision data. */
  retryAfterMs?: number;
}

export interface DecisionAdapterRequest {
  alias: string;
  definition: DecisionDefinition;
  input: unknown;
  target: ExecutionTarget;
  invocationId: string;
  deadlineEpochMs: number;
  signal: AbortSignal;
  resolveCredential: (logicalRef: string) => Promise<Uint8Array>;
  /** Persist an opaque remote handle before the adapter reports completion. */
  onRemoteHandle?: (handle: string) => Promise<void>;
}

export interface DecisionAdapter {
  readonly id: string;
  readonly version: string;
  capabilities(): Promise<AdapterCapabilities>;
  evaluate(request: DecisionAdapterRequest): Promise<AdapterObservation>;
}

export type DecisionReceiptState = 'acquired' | 'dispatched' | 'remote-handle-known' | 'observation-received' | 'composed' | 'completed' | 'failed' | 'execution-uncertain';

export interface DecisionReceipt {
  schema: 'decision-receipt/v2';
  revision: number;
  projectId: string;
  invocationId: string;
  fingerprint: string;
  state: DecisionReceiptState;
  result?: RulesetResult;
  remoteHandles: string[];
}

export interface DecisionReceiptStore {
  read(invocationId: string, projectId?: string): Promise<DecisionReceipt | null>;
  acquire(invocationId: string, projectId: string, fingerprint: string): Promise<{ owner: boolean; receipt: DecisionReceipt }>;
  compareAndSwap(invocationId: string, projectId: string, expectedRevision: number, next: DecisionReceipt): Promise<boolean>;
  waitForTerminal(invocationId: string, projectId: string, fingerprint: string, signal?: AbortSignal): Promise<DecisionReceipt>;
}

export interface DecisionEvaluationRequest {
  ruleset: DecisionRuleset;
  binding: DecisionBinding;
  definitions: Record<string, DecisionDefinition>;
  input: unknown;
  runId: string;
  invocationId: string;
  adapters: Record<string, DecisionAdapter>;
  resolveCredential?: (logicalRef: string) => Promise<Uint8Array>;
  receiptStore?: DecisionReceiptStore;
  receiptProjectId?: string;
  policyPin?: ArtifactPin | null;
  calibrationPin?: ArtifactPin | null;
  /** Resolve a persisted handle without starting another remote operation. */
  reconcileRemote?: (handle: string, signal: AbortSignal) => Promise<AdapterObservation | null>;
  signal?: AbortSignal;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}
