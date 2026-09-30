import type { DecisionDefinition, RulesetResult } from '../types.js';
import type { DecisionProjectionPolicy } from '../projection.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';

export type Digest = `sha256:${string}`;
export type Study = 'D17' | 'D29';
export interface HeldoutRequest { id: string; arm: string; definitionId: string }
export interface HeldoutRow {
  provenance: { generatorId: string; seed: string; outputDigest: Digest };
  id: string; familyId: string; split: 'tuning' | 'calibration' | 'test'; slice: string;
  input: { payload: unknown }; requests: HeldoutRequest[];
  /** An observed deterministic policy outcome, never a fabricated provider observation. */
  localOutcome: unknown | null;
}
export interface HeldoutCorpus {
  schemaVersion: 'decision-heldout-corpus/v1'; study: Study; syntheticOnly: true;
  provenance: { kind: 'authored-synthetic'; generatorDigest: Digest; seed: string; goldDigest: Digest };
  definitions: DecisionDefinition[]; rows: HeldoutRow[];
}
export interface HeldoutPreregistration {
  schemaVersion: 'decision-heldout-preregistration/v1'; study: Study; frozenAt: string;
  corpusDigest: Digest; studyAnalysisDigest: Digest; scorerDigest: Digest;
  providerFailurePolicy: { maxRetries: 0 | 1; maximumSliceFailureBps: number; retryOnlyTerminal: true };
  perRequestTokenBound: number; providerOverheadTokens?: number; outputAndHiddenTokenAllowance: number;
  requestTimeoutMs: number; minDispatchIntervalMs: number; sessionLimitMs: number;
  regeneration?: { reason: string; previousCorpusDigest: Digest; previousPreregistrationDigest: Digest;
    previousApprovalTemplateDigest: Digest; liveObservationsAtRegeneration: false };
}
export interface HeldoutApproval {
  schemaVersion: 'decision-heldout-approval/v1'; approved: true; study: Study; runId: string;
  reviewer: string; approvalReference: string; sourceCommit: string; exactHeadCi: string;
  stagingHost: 'titan'; stagingWorkspace: string; model: 'jev-1.13.0'; servedModel: 'jev-1.13.0';
  region: string; credentialRef: string; credentialResolverDigest: Digest;
  corpusDigest: Digest; preregistrationDigest: Digest; executionDigest: Digest; calibrationDigest: Digest;
  providerTermsReference: string;
  priceBound: { inputUsdPerMTok: number; outputUsdPerMTok: number; perRequestUsd: number;
    outputTokenBound?: number;
    evidenceReferences: string[]; approvalReference: string };
  budget: { calls: number; tokens: number; usd: number };
  priorStudySpendUsd: number; priorPortfolioSpendUsd: number;
}
export interface HeldoutBundle { corpus: HeldoutCorpus; preregistration: HeldoutPreregistration; approval: HeldoutApproval }
export interface HeldoutAttempt {
  schemaVersion: 'decision-heldout-attempt/v1'; study: Study; runId: string; corpusDigest: Digest;
  preregistrationDigest: Digest; approvalDigest: Digest; rowId: string; requestId: string; ordinal: number;
  reservedUsdMicros: number; reservedTokens: number; requestDigest: Digest;
  /** A reservation without a terminal event is uncertain, consumes spend and blocks resumption. */
  result: null | { disposition: 'success' | 'retryable' | 'measurement-failure' | 'stop'; reason: string;
    servedModel: string | null; inputTokens: number | null; outputTokens: number | null; providerCostUsd: number | null;
    responseDigest: Digest | null; receipt: RulesetResult | null; receiptDigest: Digest | null; traceDigest: Digest;
    latencyMs: number; accountedUsdMicros: number };
}
export interface HeldoutEvent { schemaVersion: 'decision-heldout-event/v1'; sequence: number; previous: Digest | null; attempt: HeldoutAttempt; digest: Digest }
export interface HeldoutSummary {
  schemaVersion: 'decision-heldout-summary/v1';
  status: 'complete' | 'checkpoint' | 'stopped'; reason: string | null; source: 'injected-transport' | 'provider';
  study: Study; runId: string; reservedUsdMicros: number; completedRows: number; measurementFailures: string[];
  missingRows: string[]; evidenceDigest: Digest; decision: 'HOLD';
}
/** Trusted source modules generate data locally. Gold is returned separately and is never a request field. */
export interface HeldoutStudyModule {
  prepare(seed: string): Promise<{ corpus: HeldoutCorpus; preregistration: HeldoutPreregistration; gold: unknown }>;
  score(input: { corpus: HeldoutCorpus; preregistration: HeldoutPreregistration; attempts: readonly HeldoutAttempt[];
    gold: unknown; integrity: QualificationIntegrityMetadata }): Promise<unknown>;
}
export interface HeldoutExecution { definition: DecisionDefinition; projection: DecisionProjectionPolicy;
  ruleset: import('../types.js').DecisionRuleset; binding: import('../types.js').DecisionBinding }
