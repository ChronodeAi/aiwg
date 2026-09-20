export const DECISION_API_VERSION = 'decision.aiwg.io/v1alpha1' as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
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
  | { kind: 'choice'; options: Array<{ id: string; description: string }> }
  | { kind: 'ordinal-score'; levels: string[] }
  | { kind: 'truth-probability'; trueDescription: string; falseDescription: string };

export interface DecisionDefinition {
  apiVersion: typeof DECISION_API_VERSION;
  kind: 'DecisionDefinition';
  metadata: ArtifactMetadata;
  spec: {
    purpose: string;
    inputSchema: JsonSchema;
    question: string;
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
  apiVersion: typeof DECISION_API_VERSION;
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
  apiVersion: typeof DECISION_API_VERSION;
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
}

export interface DecisionAdapter {
  readonly id: string;
  readonly version: string;
  capabilities(): Promise<AdapterCapabilities>;
  evaluate(request: DecisionAdapterRequest): Promise<AdapterObservation>;
}

export interface DecisionReceipt {
  fingerprint: string;
  state: 'incomplete' | 'completed';
  result?: RulesetResult;
  remoteHandles?: string[];
}

export interface DecisionReceiptStore {
  read(invocationId: string): Promise<DecisionReceipt | null>;
  write(invocationId: string, receipt: DecisionReceipt): Promise<void>;
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
  signal?: AbortSignal;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}
