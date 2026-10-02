import { createHash } from 'node:crypto';
import {
  DECISION_API_VERSION, DECISION_API_VERSION_STRUCTURED, type AdapterObservation, type ArtifactPin,
  type DecisionDefinition, type DecisionResult, type DecisionRuleset, type JsonSchema, type JsonValue,
  type PrimitiveAcceptancePolicy,
} from './types.js';
import type { CreateReviewInput } from './review/types.js';
import { reviewDigest } from './review/validate.js';
import { qualificationIntegrityAllowlistProblems, type QualificationIntegrityMetadata } from './qualification/release.js';
import {
  evaluateBinaryHeldout, pairedBinaryDifferenceInterval, pairedNonInferiority, verifyQualificationSplits, wilsonScoreInterval,
  type PairedDifferenceInterval, type QualificationSplit,
} from './qualification/quality.js';
import { applyPrimitiveAcceptance } from './acceptance.js';
import { composeRuleset } from './compose.js';
import {
  validateProjectionPolicy, type DecisionProjectionPolicy, type DecisionSensitivity, type DecisionTrust,
} from './projection.js';
import { artifactPin, assertArtifactPin, validateDistribution } from './validate.js';
import { CalibrationRegistry } from './calibration/registry.js';
import type { CompatibilityPolicy, CompatibilityRequest } from './calibration/types.js';
import { canonicalJson } from '../security/artifact-trust.js';

export const SDLC_SCREENING_SCHEMA_VERSION = 'decision-sdlc-evidence-screening/v1' as const;
export const SDLC_SCREENING_PREREGISTRATION_VERSION = 'decision-sdlc-screening-preregistration/v1' as const;
export const SDLC_SCREENING_PREREGISTRATION_VERSION_V2 = 'decision-sdlc-screening-preregistration/v2' as const;
export const SDLC_SCREENING_RELEASE_VERSION = 'decision-sdlc-screening-release/v1' as const;
/** Release reports over a v2 preregistration (nullable NI); v1 stays bound to v1 preregistrations. */
export const SDLC_SCREENING_RELEASE_VERSION_V2 = 'decision-sdlc-screening-release/v2' as const;
export const SDLC_SCREENING_HELDOUT_RECORDS_VERSION = 'decision-sdlc-screening-heldout-records/v1' as const;
export const SDLC_SCREENING_HELDOUT_REPORT_VERSION = 'decision-sdlc-screening-heldout-report/v1' as const;
export const SDLC_GATE_EVIDENCE_POLICY_KIND = 'SdlcGateEvidencePolicy' as const;

export type SdlcScreeningMode = 'disabled' | 'shadow' | 'advisory';
export type SdlcScreeningSubjectKind = 'citation' | 'phase-criterion';
export type SdlcDeterministicStatus = 'pass' | 'review' | 'fail';
export type SdlcScreeningRoute = 'ADVISORY_READY' | 'REVIEW' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';
export type SdlcSupportLabel = 'supports' | 'does-not-support' | 'contradicts' | 'unclear';

export type SdlcPreflightReason =
  | 'subject-isolation-violated' | 'unknown-id' | 'source-not-found' | 'locator-not-found'
  | 'source-not-retrieved' | 'source-provenance-unverified' | 'publication-not-authorized'
  | 'artifact-missing' | 'test-failed' | 'approval-absent' | 'signature-invalid'
  | 'schema-invalid' | 'evidence-expired' | 'criterion-missing' | 'required-evidence-missing'
  | 'evidence-untrusted' | 'evidence-restricted' | 'content-digest-mismatch' | 'invalid-observation'
  | 'calibration-incompatible' | 'duplicate-evidence-id' | 'foreign-evidence' | 'invalid-evidence'
  | 'content-unverified' | 'evidence-trust-mismatch' | 'gate-policy-untrusted' | 'gate-policy-mismatch'
  | 'gate-policy-invalid' | 'invalid-request';

export interface SdlcScreeningPin {
  id: string;
  version: string;
  digest: `sha256:${string}`;
}

/**
 * Evidence facts in a subject (`present`, `passed`, `retrieved`, `provenanceVerified`, ...)
 * are caller-asserted. This module fails closed on what it is told plus the trusted
 * gate policy; hosts must source these facts from the deterministic validators.
 */
export interface SdlcSourceEvidence extends SdlcScreeningPin {
  locator: string;
  locatorExists: boolean;
  retrieved: boolean;
  contentDigest: `sha256:${string}`;
  /** Omitted content cannot be digest-verified, so the source stays non-ready. */
  content?: string;
  provenanceVerified: boolean;
  publicationAuthorized: boolean;
  trust: DecisionTrust;
  sensitivity: DecisionSensitivity;
}

export interface SdlcGateEvidenceItem extends SdlcScreeningPin {
  type: 'artifact' | 'test-result' | 'approval' | 'signature' | 'schema';
  /** Informational only; the trusted gate policy decides what is required. */
  required: boolean;
  present: boolean;
  passed: boolean;
  expiresAtEpochMs?: number;
}

export interface SdlcCitationSubject {
  kind: 'citation';
  subjectId: string;
  claimId: string;
  requirementIds: string[];
  sourceId: string;
  locator: string;
  evidence: [SdlcSourceEvidence];
}

export interface SdlcPhaseCriterionSubject {
  kind: 'phase-criterion';
  subjectId: string;
  criterionId: string;
  requirementIds: string[];
  evidence: SdlcGateEvidenceItem[];
}

export type SdlcScreeningSubject = SdlcCitationSubject | SdlcPhaseCriterionSubject;

export interface SdlcScreeningInventory {
  claimIds: string[];
  requirementIds: string[];
  sourceIds: string[];
  locators: string[];
  criterionIds: string[];
  evidenceIds: string[];
}

export type SdlcEvidenceOwner =
  | { kind: 'phase-criterion'; criterionId: string }
  | { kind: 'citation'; claimId: string; sourceId: string; locator: string; trust: DecisionTrust; sensitivity: DecisionSensitivity };

/** Trusted gate policy artifact, resolved only by a host-pinned digest (see `SdlcScreeningTrustContext`). */
export interface SdlcGateEvidencePolicy {
  kind: typeof SDLC_GATE_EVIDENCE_POLICY_KIND;
  metadata: { id: string; version: string };
  spec: {
    requiredEvidenceByCriterion: Record<string, string[]>;
    evidenceSubjects: Record<string, SdlcEvidenceOwner>;
  };
}

/** Host-owned trust inputs. They never come from the screening request. */
export interface SdlcScreeningTrustContext {
  /** Pin of the gate policy from trusted host configuration. */
  gatePolicyPin: ArtifactPin;
  /** Registry of gate policy artifacts; the pinned one is verified with `assertArtifactPin`. */
  gatePolicies: readonly SdlcGateEvidencePolicy[];
  /** D09 compatibility resolved through the calibration registry; null routes to review. */
  calibration: { registry: CalibrationRegistry; request: CompatibilityRequest; policy: CompatibilityPolicy } | null;
}

/** Native per-question distributions over the closed option sets. Absent distributions route to review. */
export interface SdlcCitationObservation {
  kind: 'citation';
  claimId: string;
  sourceId: string;
  locator: string;
  support: SdlcSupportLabel;
  supportDistribution?: Record<string, number>;
  supportStrengthBps: number;
  injection: 'yes' | 'no' | 'unclear';
  confidenceBps: number;
  model: string;
  attempts: number;
}

export interface SdlcPhaseCriterionObservation {
  kind: 'phase-criterion';
  criterionId: string;
  evidenceIds: string[];
  relevance: 'relevant' | 'irrelevant' | 'unclear';
  completeness: 'complete' | 'incomplete' | 'unclear';
  contradiction: 'none' | 'present' | 'unclear';
  ambiguity: 'low' | 'high' | 'unclear';
  reviewerAttention: 'needed' | 'not-needed';
  distributions?: Partial<Record<'relevance' | 'completeness' | 'contradiction' | 'ambiguity' | 'reviewerAttention', Record<string, number>>>;
  confidenceBps: number;
  model: string;
  attempts: number;
}

export type SdlcScreeningObservation = SdlcCitationObservation | SdlcPhaseCriterionObservation;

export interface SdlcPreflightFinding {
  reason: SdlcPreflightReason;
  id: string;
  status: Exclude<SdlcDeterministicStatus, 'pass'>;
}

export interface SdlcScreeningReceipt {
  schemaVersion: typeof SDLC_SCREENING_SCHEMA_VERSION;
  mode: Exclude<SdlcScreeningMode, 'disabled'>;
  subject: {
    kind: SdlcScreeningSubjectKind | 'unknown';
    subjectId: string;
    claimId?: string;
    sourceId?: string;
    locator?: string;
    criterionId?: string;
    evidenceIds: string[];
    requirementIds: string[];
  };
  deterministic: {
    status: SdlcDeterministicStatus;
    findings: SdlcPreflightFinding[];
  };
  semantic: {
    observed: boolean;
    accepted: boolean;
    reason: string;
    model: string | null;
    attempts: number;
    confidenceBps: number | null;
  };
  route: SdlcScreeningRoute;
  reviewRequired: boolean;
  reviewReasons: string[];
  gatePolicy: SdlcScreeningPin | null;
  pins: SdlcScreeningPin[];
  trace: {
    redaction: 'metadata-only';
    subjectDigest: `sha256:${string}` | null;
    observationDigest: `sha256:${string}` | null;
  };
  action: { status: 'unexecuted' };
}

export interface SdlcScreeningRequest {
  schemaVersion: typeof SDLC_SCREENING_SCHEMA_VERSION;
  mode: SdlcScreeningMode;
  inventory: SdlcScreeningInventory;
  /** Must equal the host-pinned gate policy; any other policy reference is rejected. */
  gatePolicyPin: SdlcScreeningPin;
  subject: SdlcScreeningSubject;
  observation?: SdlcScreeningObservation;
  nowEpochMs: number;
}

export interface SdlcScreeningOutcomeApplication<T extends JsonValue> {
  outcome: T;
  publication: 'unchanged';
  auditReceipts: SdlcScreeningPin[];
  alternateScreening?: SdlcScreeningReceipt;
}

export interface SdlcScreeningPreregistration {
  schemaVersion: typeof SDLC_SCREENING_PREREGISTRATION_VERSION;
  planId: string;
  frozenAt: string;
  /** Digest of the frozen held-out test split (`QualificationSplit.digest`). */
  heldoutSplitDigest: `sha256:${string}`;
  /** Every preregistered slice must be present with `minimumSliceSupport`. */
  slices: string[];
  gateBlockingSlices: string[];
  maximumFalseSupportRateBps: number;
  maximumFalseReadyRateBps: number;
  minimumTotalSupport: number;
  minimumSliceSupport: number;
  minimumGateBlockingSliceSupport: number;
  confidenceInterval: { method: 'wilson' | 'exact-binomial'; levelBps: number };
  /** Paired non-inferiority margin against the baseline screening path. */
  qualityNonInferiorityBps: number;
  efficiencyClaim: { enabled: boolean; minimumPositiveTotalEconomicsUsd: number | null };
}

/**
 * v2 preregistration: paired non-inferiority is optional. A null margin skips
 * the NI gate entirely (no NI reasons); passage baselines stay reported
 * diagnostics and never gate. Every other field is v1-identical.
 */
export interface SdlcScreeningPreregistrationV2 extends Omit<SdlcScreeningPreregistration, 'schemaVersion' | 'qualityNonInferiorityBps'> {
  schemaVersion: typeof SDLC_SCREENING_PREREGISTRATION_VERSION_V2;
  qualityNonInferiorityBps: number | null;
}

/** One adjudicated held-out item with the paired baseline outcome on the same item. */
export interface SdlcScreeningHeldoutSample {
  id: string;
  kind: SdlcScreeningSubjectKind;
  slice: string;
  gold: { ready: boolean; support: SdlcSupportLabel | null };
  candidate: {
    route: SdlcScreeningRoute;
    support: SdlcSupportLabel | null;
    readyProbability: number;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    calls: number;
    retries: number;
    fallbacks: number;
  };
  /** Baseline screening on the same item; `correct` uses the same definition as the candidate
   * (readiness route matches gold and, for citations, the support label matches gold). */
  baseline: { correct: boolean; costUsd: number | null };
  reviewer: { agreed: boolean; overridden: boolean } | null;
}

export interface SdlcScreeningHeldoutRecords {
  schemaVersion: typeof SDLC_SCREENING_HELDOUT_RECORDS_VERSION;
  evaluatedAt: string;
  splits: QualificationSplit[];
  samples: SdlcScreeningHeldoutSample[];
}

export interface SdlcRateEvidence {
  events: number;
  n: number;
  rateBps: number | null;
  /** Upper bound of the preregistered interval, rounded up; null when not computable. */
  upperBps: number | null;
}

export interface SdlcClassMetrics {
  n: number;
  precisionBps: number | null;
  recallBps: number | null;
}

/** Computed only from per-sample records; never caller-asserted. */
export interface SdlcScreeningHeldoutReport {
  schemaVersion: typeof SDLC_SCREENING_HELDOUT_REPORT_VERSION;
  evaluatedAt: string;
  heldoutSplitDigest: `sha256:${string}`;
  recordsDigest: `sha256:${string}`;
  totalSupport: number;
  gateBlockingSliceSupport: number;
  classes: { support: SdlcClassMetrics; contradiction: SdlcClassMetrics; unclear: SdlcClassMetrics };
  falseSupport: SdlcRateEvidence;
  falseReady: SdlcRateEvidence;
  reviewer: { n: number; agreementRateBps: number | null; overrideRateBps: number | null };
  /** Per-item correctness (readiness and citation label), candidate versus the paired baseline outcome. */
  paired: {
    n: number; both: number; candidateOnly: number; baselineOnly: number; neither: number;
    /** Candidate minus baseline at the preregistered level; null when no supported level was given. */
    interval: PairedDifferenceInterval | null;
  };
  calibrationRiskCoverage: { brier: number; expectedCalibrationError: number; coverage: number; selectiveRisk: number | null };
  slices: Record<string, { n: number; coverage: number; selectiveRisk: number | null }>;
  latencyMs: { p50: number; p95: number; p99: number };
  tokens: { input: number | null; output: number | null };
  costUsd: { candidate: number | null; baseline: number | null; netSavings: number | null };
  reviewLoad: { reviewRate: number };
}

export interface SdlcScreeningPreregistrationResult {
  decision: 'pass' | 'fail' | 'insufficient-evidence';
  reasons: string[];
  heldout: SdlcScreeningHeldoutReport | null;
}

export interface SdlcScreeningReleaseReport {
  schemaVersion: typeof SDLC_SCREENING_RELEASE_VERSION | typeof SDLC_SCREENING_RELEASE_VERSION_V2;
  preregistration: SdlcScreeningPreregistration | SdlcScreeningPreregistrationV2;
  preregistrationDigest: `sha256:${string}`;
  trustedPreregistrationDigest: `sha256:${string}`;
  heldout: SdlcScreeningHeldoutReport | null;
  integrity: QualificationIntegrityMetadata;
  preregisteredDecision: SdlcScreeningPreregistrationResult['decision'];
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  reasons: string[];
  digest: `sha256:${string}`;
}

export class SdlcScreeningValidationError extends Error {
  constructor(
    message: string,
    readonly reason: SdlcPreflightReason = 'invalid-request',
    readonly status: Exclude<SdlcDeterministicStatus, 'pass'> = 'fail',
    readonly id = 'validation',
  ) {
    super(message);
    this.name = 'SdlcScreeningValidationError';
  }
}

const SCREENING_MODES: readonly SdlcScreeningMode[] = ['disabled', 'shadow', 'advisory'];
const SUPPORT_LABELS: readonly SdlcSupportLabel[] = ['supports', 'does-not-support', 'contradicts', 'unclear'];
const CRITERION_OPTIONS = {
  relevance: ['relevant', 'irrelevant', 'unclear'],
  completeness: ['complete', 'incomplete', 'unclear'],
  contradiction: ['none', 'present', 'unclear'],
  ambiguity: ['low', 'high', 'unclear'],
  reviewerAttention: ['needed', 'not-needed'],
} as const;
const EVIDENCE_TYPES = ['artifact', 'test-result', 'approval', 'signature', 'schema'] as const;
const TRUST_VALUES: readonly DecisionTrust[] = ['untrusted', 'verified'];
const SENSITIVITY_VALUES: readonly DecisionSensitivity[] = ['public', 'internal', 'confidential', 'restricted'];
const ROUTES: readonly SdlcScreeningRoute[] = ['ADVISORY_READY', 'REVIEW', 'FAIL', 'INSUFFICIENT_EVIDENCE'];
/** An injection "no" must be at least this confident; anything else routes to review. */
const INJECTION_CLEAR_MINIMUM_BPS = 8_000;
const SUPPORT_STRENGTH_MINIMUM_BPS = 8_000;

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const routeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['route', 'reason'],
  properties: {
    route: { enum: ['ADVISORY_READY', 'REVIEW', 'FAIL'] },
    reason: { type: 'string' },
  },
};
const subjectInputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subjectId'],
  properties: { subjectId: { type: 'string', minLength: 1 } },
};

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function reject(message: string, reason: SdlcPreflightReason = 'invalid-request',
  status: Exclude<SdlcDeterministicStatus, 'pass'> = 'fail', id = 'validation'): never {
  throw new SdlcScreeningValidationError(message, reason, status, id);
}

function definition(id: string, description: string, answer: DecisionDefinition['spec']['answer']): DecisionDefinition {
  return {
    apiVersion: DECISION_API_VERSION,
    kind: 'DecisionDefinition',
    metadata: { id, version: '1.0.0', description },
    spec: {
      purpose: 'Advisory SDLC evidence readiness screening; deterministic gates remain authoritative.',
      inputSchema: subjectInputSchema,
      question: description,
      answer,
      requiredCapabilities: ['bounded-output'],
    },
  };
}

function pinDefinition(item: DecisionDefinition) {
  return { id: item.metadata.id, version: item.metadata.version, digest: digest(item) };
}

function buildScreeningArtifacts(): { definitions: DecisionDefinition[]; rulesets: DecisionRuleset[] } {
  const definitions = [
    definition('sdlc-screening.citation.support', 'Classify whether one cited source supports one claim.', {
      kind: 'choice',
      options: SUPPORT_LABELS.map(id => ({ id, description: `Citation support label: ${id}` })),
    }),
    definition('sdlc-screening.citation.injection', 'Estimate whether the source contains prompt-injection or authority-seeking content.', {
      kind: 'truth-probability',
      trueDescription: 'The source contains likely prompt injection or unrelated instructions.',
      falseDescription: 'The source is ordinary evidence content.',
    }),
    definition('sdlc-screening.criterion.relevance', 'Classify whether enumerated evidence is relevant to one gate criterion.', {
      kind: 'choice',
      options: CRITERION_OPTIONS.relevance.map(id => ({ id, description: `Criterion relevance label: ${id}` })),
    }),
    definition('sdlc-screening.criterion.completeness', 'Classify whether enumerated evidence is complete for one gate criterion.', {
      kind: 'choice',
      options: CRITERION_OPTIONS.completeness.map(id => ({ id, description: `Criterion completeness label: ${id}` })),
    }),
    definition('sdlc-screening.criterion.contradiction', 'Classify whether enumerated evidence contradicts itself or the criterion.', {
      kind: 'choice',
      options: CRITERION_OPTIONS.contradiction.map(id => ({ id, description: `Criterion contradiction label: ${id}` })),
    }),
    definition('sdlc-screening.criterion.ambiguity', 'Classify whether one criterion/evidence bundle is ambiguous.', {
      kind: 'choice',
      options: CRITERION_OPTIONS.ambiguity.map(id => ({ id, description: `Criterion ambiguity label: ${id}` })),
    }),
    definition('sdlc-screening.criterion.reviewer-attention', 'Classify whether one criterion needs reviewer attention.', {
      kind: 'choice',
      options: CRITERION_OPTIONS.reviewerAttention.map(id => ({ id, description: `Reviewer attention label: ${id}` })),
    }),
  ];
  const byId = new Map(definitions.map(item => [item.metadata.id, item]));
  const citationSupport = pinDefinition(byId.get('sdlc-screening.citation.support')!);
  const citationInjection = pinDefinition(byId.get('sdlc-screening.citation.injection')!);
  const criterionRelevance = pinDefinition(byId.get('sdlc-screening.criterion.relevance')!);
  const criterionCompleteness = pinDefinition(byId.get('sdlc-screening.criterion.completeness')!);
  const criterionContradiction = pinDefinition(byId.get('sdlc-screening.criterion.contradiction')!);
  const criterionAmbiguity = pinDefinition(byId.get('sdlc-screening.criterion.ambiguity')!);
  const criterionAttention = pinDefinition(byId.get('sdlc-screening.criterion.reviewer-attention')!);
  const rulesets: DecisionRuleset[] = [
    {
      apiVersion: DECISION_API_VERSION,
      kind: 'DecisionRuleset',
      metadata: { id: 'sdlc-screening.citation', version: '1.1.0', description: 'Closed citation support screening ruleset.' },
      spec: {
        purpose: 'Route one claim/source pair to advisory-ready or review evidence.',
        inputSchema: subjectInputSchema,
        evaluations: [
          { alias: 'support', decision: citationSupport, inputPointer: '' },
          { alias: 'injection', decision: citationInjection, inputPointer: '' },
        ],
        rules: [
          // The injection value is P(injection). Only a confident "no" (P <= 0.2) is clear; "unclear"
          // and "yes" are encoded as 1. A failed evaluation takes the failureOutcome (review).
          { id: 'injection-review', priority: 300, when: { op: 'gt', left: { source: 'decision', alias: 'injection', pointer: '/value' }, right: 0.2 }, outcome: { route: 'REVIEW', reason: 'prompt-injection-flagged' } },
          { id: 'contradiction-review', priority: 200, when: { op: 'eq', left: { source: 'decision', alias: 'support', pointer: '/value' }, right: 'contradicts' }, outcome: { route: 'REVIEW', reason: 'citation-contradicts' } },
          { id: 'support-ready', priority: 100, when: { op: 'eq', left: { source: 'decision', alias: 'support', pointer: '/value' }, right: 'supports' }, outcome: { route: 'ADVISORY_READY', reason: 'citation-supported' } },
        ],
        composition: 'first-match',
        conflict: 'review',
        defaultOutcome: { route: 'REVIEW', reason: 'citation-unclear' },
        failureOutcome: { route: 'REVIEW', reason: 'evidence-not-accepted' },
        outputSchema: routeSchema,
      },
    },
    {
      apiVersion: DECISION_API_VERSION,
      kind: 'DecisionRuleset',
      metadata: { id: 'sdlc-screening.phase-criterion', version: '1.0.0', description: 'Closed phase-criterion screening ruleset.' },
      spec: {
        purpose: 'Route one criterion/evidence bundle to advisory-ready or review evidence.',
        inputSchema: subjectInputSchema,
        evaluations: [
          { alias: 'relevance', decision: criterionRelevance, inputPointer: '' },
          { alias: 'completeness', decision: criterionCompleteness, inputPointer: '' },
          { alias: 'contradiction', decision: criterionContradiction, inputPointer: '' },
          { alias: 'ambiguity', decision: criterionAmbiguity, inputPointer: '' },
          { alias: 'attention', decision: criterionAttention, inputPointer: '' },
        ],
        rules: [
          { id: 'needs-review', priority: 200, when: { any: [
            { op: 'ne', left: { source: 'decision', alias: 'relevance', pointer: '/value' }, right: 'relevant' },
            { op: 'ne', left: { source: 'decision', alias: 'completeness', pointer: '/value' }, right: 'complete' },
            { op: 'ne', left: { source: 'decision', alias: 'contradiction', pointer: '/value' }, right: 'none' },
            { op: 'ne', left: { source: 'decision', alias: 'ambiguity', pointer: '/value' }, right: 'low' },
            { op: 'eq', left: { source: 'decision', alias: 'attention', pointer: '/value' }, right: 'needed' },
          ] }, outcome: { route: 'REVIEW', reason: 'criterion-needs-review' } },
          { id: 'ready-indicator', priority: 100, when: { all: [
            { op: 'eq', left: { source: 'decision', alias: 'relevance', pointer: '/value' }, right: 'relevant' },
            { op: 'eq', left: { source: 'decision', alias: 'completeness', pointer: '/value' }, right: 'complete' },
            { op: 'eq', left: { source: 'decision', alias: 'contradiction', pointer: '/value' }, right: 'none' },
            { op: 'eq', left: { source: 'decision', alias: 'ambiguity', pointer: '/value' }, right: 'low' },
            { op: 'eq', left: { source: 'decision', alias: 'attention', pointer: '/value' }, right: 'not-needed' },
          ] }, outcome: { route: 'ADVISORY_READY', reason: 'criterion-ready-indicator' } },
        ],
        composition: 'first-match',
        conflict: 'review',
        defaultOutcome: { route: 'REVIEW', reason: 'criterion-needs-review' },
        failureOutcome: { route: 'REVIEW', reason: 'evidence-not-accepted' },
        outputSchema: routeSchema,
      },
    },
  ];
  return { definitions, rulesets };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

let cachedArtifacts: { definitions: DecisionDefinition[]; rulesets: DecisionRuleset[] } | null = null;

function screeningArtifacts(): { definitions: DecisionDefinition[]; rulesets: DecisionRuleset[] } {
  cachedArtifacts ??= deepFreeze(buildScreeningArtifacts());
  return cachedArtifacts;
}

const artifactPins = new WeakMap<object, ArtifactPin>();

/** Pins of the module-owned screening artifacts, computed once per immutable artifact object. */
function cachedPin(value: DecisionDefinition | DecisionRuleset): ArtifactPin {
  let pin = artifactPins.get(value);
  if (!pin) {
    pin = artifactPin(value);
    artifactPins.set(value, pin);
  }
  return pin;
}

/** Closed portable definitions/rulesets for the D29 screening pack. They are data, not authority. */
export function sdlcScreeningDecisionArtifacts(): { definitions: DecisionDefinition[]; rulesets: DecisionRuleset[] } {
  return structuredClone(screeningArtifacts());
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && digestPattern.test(value);
}

function isPin(value: unknown): value is SdlcScreeningPin {
  return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.version) && isDigest(value.digest);
}

function assertBps(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new SdlcScreeningValidationError(`Invalid basis points: ${label}`, 'invalid-observation');
  }
}

function requireKnown(ids: readonly string[], value: string): void {
  if (!ids.includes(value)) reject(`unknown-id: ${value}`, 'unknown-id', 'review', value);
}

function rejectUnknownKeys(value: object, allowed: readonly string[], label: string,
  reason: SdlcPreflightReason = 'invalid-request'): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) reject(`${label} contains unsupported fields: ${unknown.join(', ')}`, reason);
}

/** Resolves the gate policy by host pin through `assertArtifactPin`; the request can only reference it. */
function resolveTrustedGatePolicy(request: SdlcScreeningRequest, trust: SdlcScreeningTrustContext | undefined): SdlcGateEvidencePolicy {
  if (!isRecord(trust) || !isPin(trust.gatePolicyPin) || !Array.isArray(trust.gatePolicies)) {
    reject('Trusted gate policy context is required', 'gate-policy-untrusted', 'review');
  }
  const pin = trust.gatePolicyPin;
  const matches = trust.gatePolicies.filter(policy => isRecord(policy) && isRecord(policy.metadata)
    && policy.metadata.id === pin.id && policy.metadata.version === pin.version);
  if (matches.length !== 1) reject('Pinned gate policy is not uniquely registered', 'gate-policy-untrusted', 'review', pin.id);
  const policy = matches[0]!;
  try {
    assertArtifactPin(policy, pin, 'SDLC gate policy');
  } catch {
    reject('Gate policy does not match its trusted pin', 'gate-policy-untrusted', 'review', pin.id);
  }
  const requested = request.gatePolicyPin;
  if (!isPin(requested) || Object.keys(requested).length !== 3
    || requested.id !== pin.id || requested.version !== pin.version || requested.digest !== pin.digest) {
    reject('Request gate policy does not match the trusted pinned policy', 'gate-policy-mismatch', 'review', pin.id);
  }
  // Freeze a private copy so later mutation of the registry cannot change this evaluation.
  const resolved = structuredClone(policy);
  validateGatePolicy(resolved, request.inventory);
  return resolved;
}

function validateGatePolicy(policy: SdlcGateEvidencePolicy, inventory: SdlcScreeningInventory): void {
  const invalid = (id: string): never => reject(`Invalid gate policy entry: ${id}`, 'gate-policy-invalid', 'review', id);
  if (policy.kind !== SDLC_GATE_EVIDENCE_POLICY_KIND || !isRecord(policy.spec)
    || !isRecord(policy.spec.requiredEvidenceByCriterion) || !isRecord(policy.spec.evidenceSubjects)) invalid('policy');
  rejectUnknownKeys(policy, ['kind', 'metadata', 'spec'], 'Gate policy', 'gate-policy-invalid');
  rejectUnknownKeys(policy.spec, ['requiredEvidenceByCriterion', 'evidenceSubjects'], 'Gate policy spec', 'gate-policy-invalid');
  const criteria = new Set(inventory.criterionIds);
  const evidence = new Set(inventory.evidenceIds);
  for (const [evidenceId, owner] of Object.entries(policy.spec.evidenceSubjects)) {
    if (!isRecord(owner)) invalid(evidenceId);
    if (owner.kind === 'phase-criterion') {
      rejectUnknownKeys(owner, ['kind', 'criterionId'], 'Gate policy owner', 'gate-policy-invalid');
      if (!isNonEmptyString(owner.criterionId)) invalid(evidenceId);
      if (!evidence.has(evidenceId) || !criteria.has(owner.criterionId)) reject(`unknown-id: ${evidenceId}`, 'unknown-id', 'review', evidenceId);
    } else if (owner.kind === 'citation') {
      rejectUnknownKeys(owner, ['kind', 'claimId', 'sourceId', 'locator', 'trust', 'sensitivity'], 'Gate policy owner', 'gate-policy-invalid');
      if (evidenceId !== owner.sourceId || !isNonEmptyString(owner.claimId) || !isNonEmptyString(owner.locator)
        || !TRUST_VALUES.includes(owner.trust) || !SENSITIVITY_VALUES.includes(owner.sensitivity)) invalid(evidenceId);
      requireKnown(inventory.claimIds, owner.claimId);
      requireKnown(inventory.sourceIds, owner.sourceId);
      requireKnown(inventory.locators, owner.locator);
    } else {
      invalid(evidenceId);
    }
  }
  for (const [criterionId, ids] of Object.entries(policy.spec.requiredEvidenceByCriterion)) {
    if (!criteria.has(criterionId)) reject(`criterion-missing: ${criterionId}`, 'criterion-missing', 'review', criterionId);
    if (!isStringArray(ids) || !ids.length || new Set(ids).size !== ids.length) invalid(criterionId);
    for (const id of ids) {
      const owner = hasOwn(policy.spec.evidenceSubjects, id) ? policy.spec.evidenceSubjects[id] : undefined;
      if (!evidence.has(id)) reject(`unknown-id: ${id}`, 'unknown-id', 'review', id);
      if (!owner || owner.kind !== 'phase-criterion' || owner.criterionId !== criterionId) invalid(id);
    }
  }
}

function validateInventory(inventory: unknown): asserts inventory is SdlcScreeningInventory {
  if (!isRecord(inventory)) reject('Screening inventory is required');
  rejectUnknownKeys(inventory, ['claimIds', 'requirementIds', 'sourceIds', 'locators', 'criterionIds', 'evidenceIds'], 'Screening inventory');
  for (const key of ['claimIds', 'requirementIds', 'sourceIds', 'locators', 'criterionIds', 'evidenceIds']) {
    if (!isStringArray(inventory[key])) reject(`Screening inventory ${key} must be a string array`);
  }
}

function validateSourceEvidence(source: unknown): asserts source is SdlcSourceEvidence {
  if (!isRecord(source)) reject('Citation source evidence must be an object', 'invalid-evidence');
  rejectUnknownKeys(source, ['id', 'version', 'digest', 'locator', 'locatorExists', 'retrieved', 'contentDigest', 'content',
    'provenanceVerified', 'publicationAuthorized', 'trust', 'sensitivity'], 'Citation source evidence', 'invalid-evidence');
  if (!isPin(source) || !isNonEmptyString(source.locator) || !isDigest(source.contentDigest)
    || (source.content !== undefined && typeof source.content !== 'string')
    || [source.locatorExists, source.retrieved, source.provenanceVerified, source.publicationAuthorized].some(value => typeof value !== 'boolean')
    || !TRUST_VALUES.includes(source.trust as DecisionTrust) || !SENSITIVITY_VALUES.includes(source.sensitivity as DecisionSensitivity)) {
    reject('Invalid citation source evidence', 'invalid-evidence', 'fail', isNonEmptyString(source.id) ? source.id : 'validation');
  }
}

function validateGateEvidenceItem(item: unknown): asserts item is SdlcGateEvidenceItem {
  if (!isRecord(item)) reject('Gate evidence item must be an object', 'invalid-evidence');
  const id = isNonEmptyString(item.id) ? item.id : 'validation';
  rejectUnknownKeys(item, ['id', 'version', 'digest', 'type', 'required', 'present', 'passed', 'expiresAtEpochMs'], 'Gate evidence item', 'invalid-evidence');
  if (!isPin(item) || !EVIDENCE_TYPES.includes(item.type as SdlcGateEvidenceItem['type'])
    || [item.required, item.present, item.passed].some(value => typeof value !== 'boolean')) {
    reject('Invalid gate evidence item', 'invalid-evidence', 'fail', id);
  }
  if (item.expiresAtEpochMs !== undefined
    && (typeof item.expiresAtEpochMs !== 'number' || !Number.isSafeInteger(item.expiresAtEpochMs) || item.expiresAtEpochMs < 0)) {
    reject('Evidence expiry must be a non-negative integer epoch', 'invalid-evidence', 'fail', id);
  }
}

function validateSubject(request: SdlcScreeningRequest): void {
  const { inventory, subject } = request;
  if (!isRecord(subject) || (subject.kind !== 'citation' && subject.kind !== 'phase-criterion')) reject('Screening subject kind is required');
  if (!isNonEmptyString(subject.subjectId) || !isStringArray(subject.requirementIds) || !subject.requirementIds.length) {
    reject('Screening subject identity is required');
  }
  for (const requirementId of subject.requirementIds) requireKnown(inventory.requirementIds, requirementId);
  if (!Array.isArray(subject.evidence) || !subject.evidence.length) reject('Screening subject evidence is required', 'required-evidence-missing', 'review');
  if (subject.kind === 'citation') {
    rejectUnknownKeys(subject, ['kind', 'subjectId', 'claimId', 'requirementIds', 'sourceId', 'locator', 'evidence'], 'Citation subject');
    if (!isNonEmptyString(subject.claimId) || !isNonEmptyString(subject.sourceId) || !isNonEmptyString(subject.locator)) {
      reject('Citation subject identity is required');
    }
    if (subject.evidence.length !== 1) reject('Citation screening requires exactly one source', 'subject-isolation-violated', 'review');
    requireKnown(inventory.claimIds, subject.claimId);
    requireKnown(inventory.sourceIds, subject.sourceId);
    requireKnown(inventory.locators, subject.locator);
    const [source] = subject.evidence;
    validateSourceEvidence(source);
    if (source.id !== subject.sourceId || source.locator !== subject.locator) {
      reject('Citation subject and source evidence mismatch', 'subject-isolation-violated', 'review', source.id);
    }
  } else {
    rejectUnknownKeys(subject, ['kind', 'subjectId', 'criterionId', 'requirementIds', 'evidence'], 'Criterion subject');
    if (!isNonEmptyString(subject.criterionId)) reject('Criterion subject identity is required');
    requireKnown(inventory.criterionIds, subject.criterionId);
    const seen = new Set<string>();
    for (const item of subject.evidence) {
      validateGateEvidenceItem(item);
      // Duplicates are rejected outright; there is no "latest version wins" resolution.
      if (seen.has(item.id)) reject(`Duplicate evidence ID: ${item.id}`, 'duplicate-evidence-id', 'fail', item.id);
      seen.add(item.id);
      requireKnown(inventory.evidenceIds, item.id);
    }
  }
}

function validateRequest(request: SdlcScreeningRequest, trust: SdlcScreeningTrustContext | undefined): SdlcGateEvidencePolicy {
  rejectUnknownKeys(request, ['schemaVersion', 'mode', 'inventory', 'gatePolicyPin', 'subject', 'observation', 'nowEpochMs'], 'Screening request');
  if (request.schemaVersion !== SDLC_SCREENING_SCHEMA_VERSION) reject('Unsupported screening schema');
  if (typeof request.nowEpochMs !== 'number' || !Number.isSafeInteger(request.nowEpochMs) || request.nowEpochMs < 0) {
    reject('Invalid screening clock');
  }
  validateInventory(request.inventory);
  const policy = resolveTrustedGatePolicy(request, trust);
  validateSubject(request);
  return policy;
}

function validateObservation(subject: SdlcScreeningSubject, observation: unknown): void {
  if (observation === undefined) return;
  if (!isRecord(observation)) reject('Observation must be an object', 'invalid-observation');
  assertBps(observation.confidenceBps, 'confidence');
  if (typeof observation.attempts !== 'number' || !Number.isSafeInteger(observation.attempts) || observation.attempts < 1) {
    reject('Observation attempts must be positive', 'invalid-observation');
  }
  if (!isNonEmptyString(observation.model)) reject('Observation model is required', 'invalid-observation');
  if (subject.kind === 'citation') {
    rejectUnknownKeys(observation, ['kind', 'claimId', 'sourceId', 'locator', 'support', 'supportDistribution', 'supportStrengthBps',
      'injection', 'confidenceBps', 'model', 'attempts'], 'Citation observation', 'invalid-observation');
    if (!SUPPORT_LABELS.includes(observation.support as SdlcSupportLabel)
      || !['yes', 'no', 'unclear'].includes(observation.injection as string)
      || (observation.supportDistribution !== undefined && !isRecord(observation.supportDistribution))) {
      reject('Citation observation is outside the closed answer domain', 'invalid-observation');
    }
    assertBps(observation.supportStrengthBps, 'support strength');
    if (observation.kind !== 'citation' || observation.claimId !== subject.claimId ||
        observation.sourceId !== subject.sourceId || observation.locator !== subject.locator) {
      reject('Observation subject mismatch', 'subject-isolation-violated', 'review');
    }
  } else {
    rejectUnknownKeys(observation, ['kind', 'criterionId', 'evidenceIds', 'relevance', 'completeness', 'contradiction', 'ambiguity',
      'reviewerAttention', 'distributions', 'confidenceBps', 'model', 'attempts'], 'Criterion observation', 'invalid-observation');
    for (const [field, options] of Object.entries(CRITERION_OPTIONS)) {
      if (!(options as readonly string[]).includes(observation[field] as string)) {
        reject('Criterion observation is outside the closed answer domain', 'invalid-observation');
      }
    }
    if (observation.distributions !== undefined && (!isRecord(observation.distributions)
      || Object.keys(observation.distributions).some(key => !hasOwn(CRITERION_OPTIONS, key)))) {
      reject('Criterion observation distributions are invalid', 'invalid-observation');
    }
    if (observation.kind !== 'phase-criterion' || observation.criterionId !== subject.criterionId
      || !isStringArray(observation.evidenceIds)
      || canonicalJson([...observation.evidenceIds].sort()) !== canonicalJson(subject.evidence.map(item => item.id).sort())) {
      reject('Observation subject mismatch', 'subject-isolation-violated', 'review');
    }
  }
}

/**
 * Deterministic preflight over one validated subject and the trusted gate policy.
 * Every bundle item is inspected, not only policy-required ones.
 */
export function sdlcScreeningPreflight(
  subject: SdlcScreeningSubject,
  nowEpochMs: number,
  gatePolicy: SdlcGateEvidencePolicy,
): SdlcPreflightFinding[] {
  const findings: SdlcPreflightFinding[] = [];
  const owners = gatePolicy.spec.evidenceSubjects;
  if (subject.kind === 'citation') {
    const [source] = subject.evidence;
    const owner = hasOwn(owners, source.id) ? owners[source.id] : undefined;
    const citationOwner = owner?.kind === 'citation' && owner.claimId === subject.claimId
      && owner.sourceId === subject.sourceId && owner.locator === subject.locator ? owner : null;
    if (!citationOwner) findings.push({ reason: 'subject-isolation-violated', id: source.id, status: 'review' });
    if (source.id !== subject.sourceId) findings.push({ reason: 'source-not-found', id: subject.sourceId, status: 'review' });
    if (source.locator !== subject.locator || !source.locatorExists) findings.push({ reason: 'locator-not-found', id: subject.locator, status: 'review' });
    if (!source.retrieved) findings.push({ reason: 'source-not-retrieved', id: subject.locator, status: 'review' });
    if (!source.provenanceVerified) findings.push({ reason: 'source-provenance-unverified', id: source.id, status: 'review' });
    if (!source.publicationAuthorized) findings.push({ reason: 'publication-not-authorized', id: source.id, status: 'review' });
    // Trust and sensitivity come from the trusted policy; a caller claim that differs is itself a finding.
    const trust: DecisionTrust = citationOwner?.trust ?? 'untrusted';
    const sensitivity: DecisionSensitivity = citationOwner?.sensitivity ?? 'restricted';
    if (citationOwner && (source.trust !== citationOwner.trust || source.sensitivity !== citationOwner.sensitivity)) {
      findings.push({ reason: 'evidence-trust-mismatch', id: source.id, status: 'review' });
    }
    if (trust !== 'verified') findings.push({ reason: 'evidence-untrusted', id: source.id, status: 'review' });
    if (sensitivity === 'restricted') findings.push({ reason: 'evidence-restricted', id: source.id, status: 'review' });
    findings.push(...projectionBoundaryFindings(subject, trust, sensitivity));
    if (source.content === undefined) {
      findings.push({ reason: 'content-unverified', id: source.id, status: 'review' });
    } else if (digest(source.content) !== source.contentDigest) {
      findings.push({ reason: 'content-digest-mismatch', id: source.id, status: 'review' });
    }
    return uniqueFindings(findings);
  }
  const required = hasOwn(gatePolicy.spec.requiredEvidenceByCriterion, subject.criterionId)
    ? gatePolicy.spec.requiredEvidenceByCriterion[subject.criterionId] : undefined;
  if (!required?.length) findings.push({ reason: 'criterion-missing', id: subject.criterionId, status: 'review' });
  const counts = new Map<string, number>();
  for (const item of subject.evidence) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  for (const item of subject.evidence) {
    if ((counts.get(item.id) ?? 0) > 1) findings.push({ reason: 'duplicate-evidence-id', id: item.id, status: 'fail' });
    const owner = hasOwn(owners, item.id) ? owners[item.id] : undefined;
    if (!owner || owner.kind !== 'phase-criterion' || owner.criterionId !== subject.criterionId) {
      findings.push({ reason: 'foreign-evidence', id: item.id, status: 'review' });
    }
    if (!item.present) {
      const reason: SdlcPreflightReason = item.type === 'artifact' ? 'artifact-missing'
        : item.type === 'test-result' ? 'test-failed'
        : item.type === 'approval' ? 'approval-absent'
        : item.type === 'signature' ? 'signature-invalid' : 'schema-invalid';
      findings.push({ reason, id: item.id, status: item.type === 'test-result' ? 'fail' : 'review' });
    } else if (!item.passed) {
      const reason: SdlcPreflightReason = item.type === 'test-result' ? 'test-failed'
        : item.type === 'signature' ? 'signature-invalid'
        : item.type === 'schema' ? 'schema-invalid'
        : item.type === 'approval' ? 'approval-absent' : 'artifact-missing';
      findings.push({ reason, id: item.id, status: item.type === 'test-result' ? 'fail' : 'review' });
    }
    if (item.expiresAtEpochMs !== undefined) {
      if (!Number.isSafeInteger(item.expiresAtEpochMs) || item.expiresAtEpochMs < 0) {
        findings.push({ reason: 'invalid-evidence', id: item.id, status: 'fail' });
      } else if (item.expiresAtEpochMs <= nowEpochMs) {
        findings.push({ reason: 'evidence-expired', id: item.id, status: 'review' });
      }
    }
  }
  for (const id of required ?? []) {
    if (!counts.has(id)) findings.push({ reason: 'required-evidence-missing', id, status: 'review' });
  }
  return uniqueFindings(findings);
}

function uniqueFindings(findings: readonly SdlcPreflightFinding[]): SdlcPreflightFinding[] {
  const seen = new Set<string>();
  return findings.filter(item => {
    const key = `${item.reason}\0${item.id}\0${item.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectionBoundaryFindings(subject: SdlcCitationSubject, trust: DecisionTrust, sensitivity: DecisionSensitivity): SdlcPreflightFinding[] {
  const [source] = subject.evidence;
  const policy: DecisionProjectionPolicy = {
    version: 'sdlc-screening-d10/v1', provider: 'jev', model: 'sdlc-screening',
    origin: 'https://decision.invalid', region: 'offline', purpose: 'sdlc-evidence-screening',
    allowIncompleteContext: false, maxSensitivity: 'confidential',
    fields: [{
      pointer: '/evidence/0/content', output: 'sourceContent', source: source.id,
      subject: subject.subjectId, trust, sensitivity,
      purpose: 'sdlc-evidence-screening', retentionClass: 'metadata-only',
      accessScopes: ['decision:sdlc-screening'], exportPolicy: sensitivity === 'restricted' ? 'denied' : 'sanitized',
      deletionPolicy: 'erase', backupPolicy: sensitivity === 'restricted' ? 'not-persisted' : 'expire-with-primary',
      allowedProviders: ['jev'], allowedModels: ['sdlc-screening'],
      allowedOrigins: ['https://decision.invalid'], allowedRegions: ['offline'],
    }],
  };
  try {
    validateProjectionPolicy(policy);
    return [];
  } catch {
    return [{ reason: sensitivity === 'restricted' ? 'evidence-restricted' : 'source-provenance-unverified',
      id: source.id, status: 'review' }];
  }
}

function deterministicStatus(findings: readonly SdlcPreflightFinding[]): SdlcDeterministicStatus {
  return findings.some(item => item.status === 'fail') ? 'fail' : findings.length ? 'review' : 'pass';
}

const act = { disposition: 'act' as const };
const review = { disposition: 'review' as const };
const screeningAcceptancePolicy: PrimitiveAcceptancePolicy = {
  mode: 'primitive-policy',
  version: '1.0.0',
  compatibleUncertaintyProfiles: ['sdlc-screening-choice-v1'],
  precedence: 'first-match',
  calibration: 'advisory',
  rules: [{ id: 'strong-choice', primitive: 'choice', all: [
    { metric: 'selected-probability', op: 'gte', thresholdBps: 8_000 },
    { metric: 'native-confidence', op: 'gte', thresholdBps: 8_000 },
    { metric: 'top-two-margin', op: 'gte', thresholdBps: 1_500 },
  ], route: act }],
  defaultRoute: review,
  missingEvidenceRoute: review,
  invalidEvidenceRoute: review,
  tieRoute: review,
};

function calibrationBlock(model: string, calibration: SdlcScreeningTrustContext['calibration'] | undefined): string | null {
  if (!calibration) return 'calibration-missing';
  if (!(calibration.registry instanceof CalibrationRegistry)) return 'calibration-invalid';
  try {
    const decision = calibration.registry.resolve(calibration.request, calibration.policy);
    if (decision.actualModel !== model) return 'calibration-model-mismatch';
    return decision.action === 'allow' ? null : `calibration-${decision.action}`;
  } catch {
    return 'calibration-invalid';
  }
}

function semanticDecision(
  subject: SdlcScreeningSubject,
  observation: SdlcScreeningObservation | undefined,
  trust: SdlcScreeningTrustContext | undefined,
): SdlcScreeningReceipt['semantic'] {
  if (!observation) return { observed: false, accepted: false, reason: 'semantic-evidence-missing', model: null, attempts: 0, confidenceBps: null };
  const base = { observed: true, model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
  const notAccepted = (reason: string) => ({ ...base, accepted: false, reason });
  const calibration = calibrationBlock(observation.model, trust?.calibration);
  if (calibration) return notAccepted(calibration);
  const { definitions, rulesets } = screeningArtifacts();
  const ruleset = rulesets.find(item => item.metadata.id === (subject.kind === 'citation'
    ? 'sdlc-screening.citation' : 'sdlc-screening.phase-criterion'))!;
  const byId = new Map(definitions.map(item => [item.metadata.id, item]));
  const evaluations: Record<string, DecisionResult> = {};
  const definitionFor = (alias: string): DecisionDefinition => byId.get(ruleset.spec.evaluations.find(item => item.alias === alias)!.decision.id)!;
  // Only native provider distributions are accepted (D08); a single confidence number is never expanded into one.
  const distributionProblem = (alias: string, distribution: unknown): string | null => {
    if (!isRecord(distribution)) return 'distribution-missing';
    try {
      validateDistribution(definitionFor(alias), distribution as Record<string, number>);
      return null;
    } catch {
      return 'distribution-invalid';
    }
  };
  const add = (alias: string, value: string | number, distribution: Record<string, number> | null): void => {
    const target = definitionFor(alias);
    const raw: AdapterObservation = {
      status: 'success', reason: 'none', value, actualModel: observation.model, requestId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
      uncertainty: distribution ? {
        source: 'provider', profile: 'sdlc-screening-choice-v1', calibration: 'uncalibrated',
        confidence: observation.confidenceBps / 10_000, distribution, calibrationRef: null,
      } : {
        source: 'provider', profile: 'sdlc-screening-truth-v1', calibration: 'uncalibrated',
        confidence: null, distribution: null, calibrationRef: null,
      },
    };
    const accepted = distribution ? applyPrimitiveAcceptance(target, screeningAcceptancePolicy, raw) : raw;
    evaluations[alias] = decisionResultForScreening(target, ruleset, alias, accepted, observation.model);
  };
  if (observation.kind === 'citation' && subject.kind === 'citation') {
    const problem = distributionProblem('support', observation.supportDistribution);
    if (problem) return notAccepted(problem);
    add('support', observation.support, observation.supportDistribution!);
    // P(injection): only an explicit "no" carries (1 - confidence); "yes" and "unclear" are 1.
    add('injection', observation.injection === 'no' ? (10_000 - observation.confidenceBps) / 10_000 : 1, null);
  } else if (observation.kind === 'phase-criterion' && subject.kind === 'phase-criterion') {
    const fields = [
      ['relevance', 'relevance'], ['completeness', 'completeness'], ['contradiction', 'contradiction'],
      ['ambiguity', 'ambiguity'], ['attention', 'reviewerAttention'],
    ] as const;
    for (const [alias, field] of fields) {
      const problem = distributionProblem(alias, observation.distributions?.[field]);
      if (problem) return notAccepted(`${problem}:${field}`);
    }
    for (const [alias, field] of fields) add(alias, observation[field], observation.distributions![field]!);
  } else {
    reject('Observation subject kind mismatch', 'subject-isolation-violated', 'review');
  }
  const composition = composeRuleset(ruleset, { subjectId: subject.subjectId }, evaluations);
  const outcome = isRecord(composition.outcome) ? composition.outcome as { route?: unknown; reason?: unknown } : {};
  const route = outcome.route === 'ADVISORY_READY' || outcome.route === 'REVIEW' || outcome.route === 'FAIL'
    ? outcome.route : 'REVIEW';
  const reason = typeof outcome.reason === 'string' ? outcome.reason : composition.reason;
  if (route !== 'ADVISORY_READY') return notAccepted(reason);
  // Code-level guards independent of the published ruleset data.
  if (observation.kind === 'citation') {
    if (observation.injection !== 'no' || observation.confidenceBps < INJECTION_CLEAR_MINIMUM_BPS) return notAccepted('prompt-injection-flagged');
    if (observation.supportStrengthBps < SUPPORT_STRENGTH_MINIMUM_BPS) return notAccepted('support-strength-low');
  }
  return { ...base, accepted: true, reason };
}

function decisionResultForScreening(
  target: DecisionDefinition,
  ruleset: DecisionRuleset,
  alias: string,
  observation: AdapterObservation,
  model: string,
): DecisionResult {
  const pin = cachedPin(target);
  const rulesetPin = cachedPin(ruleset);
  const bindingPin = { id: 'sdlc-screening.synthetic-binding', version: '1.0.0', digest: digest('sdlc-screening.synthetic-binding') };
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionResult',
    metadata: { id: `sdlc-screening-${alias}`, version: '1.0.0', description: `SDLC screening result for ${alias}` },
    spec: {
      decision: pin, ruleset: rulesetPin, binding: bindingPin, alias, runId: 'sdlc-screening', invocationId: 'sdlc-screening',
      status: observation.status, ...(observation.status === 'success' ? { value: observation.value! } : {}),
      reason: observation.reason, uncertainty: observation.uncertainty,
      ...(observation.acceptance ? { acceptance: observation.acceptance } : {}),
      attempts: [{
        ordinal: 1, adapter: 'jev', adapterVersion: 'sdlc-screening-offline', requestedModel: model, actualModel: model,
        subagent: null, status: observation.status, reason: observation.reason, durationMs: 0,
        usage: observation.usage, requestId: null,
      }],
    },
  };
}

function subjectSummary(subject: unknown): { summary: SdlcScreeningReceipt['subject']; pins: SdlcScreeningPin[] } {
  const value = isRecord(subject) ? subject : {};
  const kind = value.kind === 'citation' || value.kind === 'phase-criterion' ? value.kind : 'unknown';
  const text = (item: unknown): string => typeof item === 'string' ? item : '';
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const summary: SdlcScreeningReceipt['subject'] = {
    kind, subjectId: text(value.subjectId),
    requirementIds: Array.isArray(value.requirementIds) ? value.requirementIds.filter(isNonEmptyString) : [],
    evidenceIds: kind === 'citation' ? [text(value.sourceId)].filter(Boolean)
      : evidence.filter(isRecord).map(item => item.id).filter(isNonEmptyString),
    ...(kind === 'citation' ? { claimId: text(value.claimId), sourceId: text(value.sourceId), locator: text(value.locator) }
      : kind === 'phase-criterion' ? { criterionId: text(value.criterionId) } : {}),
  };
  const pins = evidence.filter(isPin).map(pin => ({ id: pin.id, version: pin.version, digest: pin.digest }));
  return { summary, pins };
}

function optionalDigest(value: unknown): `sha256:${string}` | null {
  if (value === undefined) return null;
  try { return digest(value); }
  catch { return null; }
}

function validationFinding(error: SdlcScreeningValidationError): SdlcPreflightFinding {
  return { reason: error.reason, id: error.id, status: error.status };
}

/**
 * Advisory screening for one subject. `disabled` returns null without reading anything else;
 * an invalid `mode` throws. In shadow/advisory mode every other malformed input produces a
 * non-ready receipt instead of an exception.
 */
export function evaluateSdlcEvidenceScreening(
  request: SdlcScreeningRequest,
  trust?: SdlcScreeningTrustContext,
): SdlcScreeningReceipt | null {
  if (!isRecord(request) || !SCREENING_MODES.includes(request.mode)) {
    throw new SdlcScreeningValidationError('Invalid screening mode', 'invalid-request');
  }
  if (request.mode === 'disabled') return null;
  const mode = request.mode;
  let findings: SdlcPreflightFinding[] = [];
  let semantic: SdlcScreeningReceipt['semantic'] | null = null;
  let gatePolicy: SdlcScreeningPin | null = null;
  const notObserved = (reason: string) => ({ observed: false, accepted: false, reason, model: null, attempts: 0, confidenceBps: null });
  try {
    const policy = validateRequest(request, trust);
    gatePolicy = { ...trust!.gatePolicyPin };
    validateObservation(request.subject, request.observation);
    findings = sdlcScreeningPreflight(request.subject, request.nowEpochMs, policy);
    semantic = semanticDecision(request.subject, request.observation, trust);
  } catch (error) {
    const finding = error instanceof SdlcScreeningValidationError ? validationFinding(error)
      : { reason: 'invalid-request' as const, id: 'validation', status: 'fail' as const };
    findings = uniqueFindings([...findings, finding]);
    semantic ??= notObserved(finding.reason);
  }
  const status = deterministicStatus(findings);
  const route: SdlcScreeningRoute = status === 'fail' ? 'FAIL'
    : status === 'review' ? 'REVIEW'
    : semantic.accepted ? 'ADVISORY_READY' : 'REVIEW';
  const reviewReasons = uniqueStrings([...findings.map(item => item.reason), ...(semantic.accepted ? [] : [semantic.reason])]);
  const { summary, pins } = subjectSummary(request.subject);
  return {
    schemaVersion: SDLC_SCREENING_SCHEMA_VERSION,
    mode,
    subject: summary,
    deterministic: { status, findings },
    semantic,
    route,
    reviewRequired: route !== 'ADVISORY_READY',
    reviewReasons,
    gatePolicy,
    pins,
    trace: { redaction: 'metadata-only', subjectDigest: optionalDigest(request.subject), observationDigest: optionalDigest(request.observation) },
    action: { status: 'unexecuted' },
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Pass-through over a host-owned gate outcome. AIWG has no programmatic SDLC phase-gate
 * evaluator (flow-gate-check is an agent-executed skill), so this adapter only guarantees
 * that screening never alters the outcome value or publication state a host passes in.
 */
export function applySdlcScreeningToGateOutcome<T extends JsonValue>(
  currentOutcome: T,
  mode: SdlcScreeningMode,
  auditReceipts: SdlcScreeningPin[] = [],
  receipt: SdlcScreeningReceipt | null = null,
): SdlcScreeningOutcomeApplication<T> {
  if (!SCREENING_MODES.includes(mode)) throw new SdlcScreeningValidationError('Invalid screening mode', 'invalid-request');
  const base = { outcome: structuredClone(currentOutcome), publication: 'unchanged' as const,
    auditReceipts: auditReceipts.map(item => ({ ...item })) };
  return mode === 'disabled' || !receipt ? base : { ...base, alternateScreening: structuredClone(receipt) };
}

export function sdlcScreeningReviewInputFromReceipt(
  receipt: SdlcScreeningReceipt,
  options: {
    enabled: boolean;
    reviewId: string;
    continuationId: string;
    resumeToken: string;
    expiresAtEpochMs: number;
    riskTier: string;
    rationale: string;
    requesterPresentation?: Record<string, JsonValue>;
  },
): CreateReviewInput | null {
  if (!receipt.reviewRequired) return null;
  const policyDigest = reviewDigest({ schemaVersion: receipt.schemaVersion, route: receipt.route, reasons: receipt.reviewReasons });
  const requesterPresentationDigest = options.requesterPresentation
    ? reviewDigest(options.requesterPresentation) : null;
  return {
    reviewId: options.reviewId,
    sourceReceipt: { id: receipt.subject.subjectId || 'sdlc-screening-invalid-subject', digest: reviewDigest(receipt) },
    evidencePins: receipt.pins,
    policyPins: [
      { id: 'sdlc-evidence-screening', version: '1.0.0', digest: policyDigest },
      ...(receipt.gatePolicy ? [{ ...receipt.gatePolicy }] : []),
    ],
    reasonCodes: [...receipt.reviewReasons],
    riskTier: options.riskTier,
    presentation: {
      redaction: 'metadata-only',
      subject: receipt.subject,
      route: receipt.route,
      trace: receipt.trace,
      requesterPresentationDigest,
      reviewBridgeEnabledFlag: options.enabled,
    },
    action: { kind: 'sdlc-screening-review', subject: receipt.subject, route: receipt.route },
    rationale: options.rationale,
    expiresAtEpochMs: options.expiresAtEpochMs,
    continuationId: options.continuationId,
    resumeToken: options.resumeToken,
  };
}

/** Canonical digest a host anchors separately before held-out access. */
export function sdlcScreeningPreregistrationDigest(preregistration: SdlcScreeningPreregistration | SdlcScreeningPreregistrationV2): `sha256:${string}` {
  return digest(preregistration);
}

function validatePreregistration(preregistration: SdlcScreeningPreregistration | SdlcScreeningPreregistrationV2): number {
  const invalid = (message = 'Invalid screening preregistration'): never => { throw new SdlcScreeningValidationError(message); };
  if (!isRecord(preregistration) || (preregistration.schemaVersion !== SDLC_SCREENING_PREREGISTRATION_VERSION
      && preregistration.schemaVersion !== SDLC_SCREENING_PREREGISTRATION_VERSION_V2)
    || !isNonEmptyString(preregistration.planId) || !isDigest(preregistration.heldoutSplitDigest)) invalid();
  rejectUnknownKeys(preregistration, ['schemaVersion', 'planId', 'frozenAt', 'heldoutSplitDigest', 'slices', 'gateBlockingSlices',
    'maximumFalseSupportRateBps', 'maximumFalseReadyRateBps', 'minimumTotalSupport', 'minimumSliceSupport',
    'minimumGateBlockingSliceSupport', 'confidenceInterval', 'qualityNonInferiorityBps', 'efficiencyClaim'], 'Screening preregistration');
  const frozenAt = typeof preregistration.frozenAt === 'string' ? Date.parse(preregistration.frozenAt) : Number.NaN;
  if (!Number.isFinite(frozenAt)) invalid();
  if (!isStringArray(preregistration.slices) || !preregistration.slices.length
    || new Set(preregistration.slices).size !== preregistration.slices.length
    || !isStringArray(preregistration.gateBlockingSlices) || !preregistration.gateBlockingSlices.length
    || new Set(preregistration.gateBlockingSlices).size !== preregistration.gateBlockingSlices.length
    || preregistration.gateBlockingSlices.some(slice => !preregistration.slices.includes(slice))) {
    invalid('Invalid screening preregistration slices');
  }
  for (const [label, value] of [
    ['maximumFalseSupportRateBps', preregistration.maximumFalseSupportRateBps],
    ['maximumFalseReadyRateBps', preregistration.maximumFalseReadyRateBps],
    ['qualityNonInferiorityBps', preregistration.qualityNonInferiorityBps],
  ] as const) {
    if (value === null) {
      if (label !== 'qualityNonInferiorityBps'
        || preregistration.schemaVersion !== SDLC_SCREENING_PREREGISTRATION_VERSION_V2) invalid(`Invalid basis points: ${label}`);
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) invalid(`Invalid basis points: ${label}`);
  }
  if (!isRecord(preregistration.confidenceInterval) || !['wilson', 'exact-binomial'].includes(preregistration.confidenceInterval.method)
    || !Number.isSafeInteger(preregistration.confidenceInterval.levelBps)
    || preregistration.confidenceInterval.levelBps <= 0 || preregistration.confidenceInterval.levelBps >= 10_000) {
    invalid('Invalid confidence interval level');
  }
  const claim = preregistration.efficiencyClaim;
  if (!Number.isSafeInteger(preregistration.minimumTotalSupport) || preregistration.minimumTotalSupport < 1
    || !Number.isSafeInteger(preregistration.minimumSliceSupport) || preregistration.minimumSliceSupport < 1
    || !Number.isSafeInteger(preregistration.minimumGateBlockingSliceSupport) || preregistration.minimumGateBlockingSliceSupport < 1
    || !isRecord(claim) || typeof claim.enabled !== 'boolean'
    || (claim.minimumPositiveTotalEconomicsUsd !== null
      && (typeof claim.minimumPositiveTotalEconomicsUsd !== 'number' || !Number.isFinite(claim.minimumPositiveTotalEconomicsUsd)
        || claim.minimumPositiveTotalEconomicsUsd < 0))) {
    invalid('Invalid screening preregistration minimums');
  }
  return frozenAt;
}

function validateHeldoutSample(sample: SdlcScreeningHeldoutSample): void {
  const invalid = (): never => { throw new SdlcScreeningValidationError(`Invalid held-out sample: ${String(sample?.id)}`); };
  if (!isRecord(sample) || !isNonEmptyString(sample.id) || !isNonEmptyString(sample.slice)
    || (sample.kind !== 'citation' && sample.kind !== 'phase-criterion')
    || !isRecord(sample.gold) || typeof sample.gold.ready !== 'boolean'
    || !isRecord(sample.candidate) || !ROUTES.includes(sample.candidate.route)
    || !isRecord(sample.baseline) || typeof sample.baseline.correct !== 'boolean'
    || (sample.baseline.costUsd !== null && (typeof sample.baseline.costUsd !== 'number' || !Number.isFinite(sample.baseline.costUsd) || sample.baseline.costUsd < 0))
    || !(sample.reviewer === null || (isRecord(sample.reviewer) && typeof sample.reviewer.agreed === 'boolean'
      && typeof sample.reviewer.overridden === 'boolean'))) invalid();
  rejectUnknownKeys(sample, ['id', 'kind', 'slice', 'gold', 'candidate', 'baseline', 'reviewer'], 'Held-out sample');
  rejectUnknownKeys(sample.gold, ['ready', 'support'], 'Held-out gold label');
  rejectUnknownKeys(sample.candidate, ['route', 'support', 'readyProbability', 'latencyMs', 'inputTokens', 'outputTokens',
    'costUsd', 'calls', 'retries', 'fallbacks'], 'Held-out candidate');
  rejectUnknownKeys(sample.baseline, ['correct', 'costUsd'], 'Held-out baseline');
  if (sample.reviewer) rejectUnknownKeys(sample.reviewer, ['agreed', 'overridden'], 'Held-out reviewer');
  const citation = sample.kind === 'citation';
  for (const label of [sample.gold.support, sample.candidate.support]) {
    if (citation ? !SUPPORT_LABELS.includes(label as SdlcSupportLabel) : label !== null) invalid();
  }
}

function bps(events: number, n: number): number | null {
  return n > 0 ? Math.round(events / n * 10_000) : null;
}

function rateEvidence(events: number, n: number, levelBps: number | null): SdlcRateEvidence {
  if (n === 0 || levelBps === null) return { events, n, rateBps: bps(events, n), upperBps: null };
  const [, upper] = wilsonScoreInterval({ events, n, levelBps });
  return { events, n, rateBps: bps(events, n), upperBps: Math.ceil(upper * 10_000) };
}

/**
 * Computes every held-out metric from per-sample records with the #1585 quality helpers.
 * With a two-sided `levelBps`, false-rate upper bounds use the Wilson score interval and the
 * paired candidate-minus-baseline interval uses Newcombe method 10 at that level; without one
 * (or for an unsupported level) those bounds are null.
 */
export function computeSdlcScreeningHeldoutReport(
  records: SdlcScreeningHeldoutRecords,
  levelBps: number | null = null,
): SdlcScreeningHeldoutReport {
  if (!isRecord(records) || records.schemaVersion !== SDLC_SCREENING_HELDOUT_RECORDS_VERSION
    || typeof records.evaluatedAt !== 'string' || !Array.isArray(records.samples) || !Array.isArray(records.splits)) {
    throw new SdlcScreeningValidationError('Invalid held-out records');
  }
  rejectUnknownKeys(records, ['schemaVersion', 'evaluatedAt', 'splits', 'samples'], 'Held-out records');
  verifyQualificationSplits(records.splits);
  records.samples.forEach(validateHeldoutSample);
  const samples = records.samples;
  const binary = evaluateBinaryHeldout(records.splits, samples.map(sample => ({
    id: sample.id, slice: sample.slice, label: sample.gold.ready ? 1 as const : 0 as const,
    probability: sample.candidate.readyProbability, accepted: sample.candidate.route === 'ADVISORY_READY',
    latencyMs: sample.candidate.latencyMs, inputTokens: sample.candidate.inputTokens, outputTokens: sample.candidate.outputTokens,
    costUsd: sample.candidate.costUsd, calls: sample.candidate.calls, retries: sample.candidate.retries, fallbacks: sample.candidate.fallbacks,
  })));
  const citations = samples.filter(sample => sample.kind === 'citation');
  const classMetrics = (label: SdlcSupportLabel): SdlcClassMetrics => {
    const truePositive = citations.filter(sample => sample.gold.support === label && sample.candidate.support === label).length;
    const predicted = citations.filter(sample => sample.candidate.support === label).length;
    const actual = citations.filter(sample => sample.gold.support === label).length;
    return { n: actual, precisionBps: bps(truePositive, predicted), recallBps: bps(truePositive, actual) };
  };
  const ready = (sample: SdlcScreeningHeldoutSample) => sample.candidate.route === 'ADVISORY_READY';
  const reviewed = samples.filter(sample => sample.reviewer !== null);
  const sum = (values: readonly (number | null)[]): number | null =>
    values.some(value => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
  const baselineCost = sum(samples.map(sample => sample.baseline.costUsd));
  const candidateCost = binary.overall.costUsd;
  const test = records.splits.find(split => split.name === 'test')!;
  // An item is correct only when the readiness route and, for citations, the support label both match gold.
  const correct = (sample: SdlcScreeningHeldoutSample) => ready(sample) === sample.gold.ready
    && (sample.kind !== 'citation' || sample.candidate.support === sample.gold.support);
  const paired = {
    n: samples.length,
    both: samples.filter(sample => sample.baseline.correct && correct(sample)).length,
    candidateOnly: samples.filter(sample => !sample.baseline.correct && correct(sample)).length,
    baselineOnly: samples.filter(sample => sample.baseline.correct && !correct(sample)).length,
    neither: samples.filter(sample => !sample.baseline.correct && !correct(sample)).length,
  };
  return {
    schemaVersion: SDLC_SCREENING_HELDOUT_REPORT_VERSION,
    evaluatedAt: records.evaluatedAt,
    heldoutSplitDigest: test.digest,
    recordsDigest: digest(records),
    totalSupport: samples.length,
    gateBlockingSliceSupport: 0,
    classes: { support: classMetrics('supports'), contradiction: classMetrics('contradicts'), unclear: classMetrics('unclear') },
    falseSupport: rateEvidence(citations.filter(sample => ready(sample) && sample.candidate.support === 'supports'
      && sample.gold.support !== 'supports').length, citations.length, levelBps),
    falseReady: rateEvidence(samples.filter(sample => ready(sample) && !sample.gold.ready).length, samples.length, levelBps),
    reviewer: {
      n: reviewed.length,
      agreementRateBps: bps(reviewed.filter(sample => sample.reviewer!.agreed).length, reviewed.length),
      overrideRateBps: bps(reviewed.filter(sample => sample.reviewer!.overridden).length, reviewed.length),
    },
    paired: { ...paired, interval: levelBps === null ? null
      : pairedBinaryDifferenceInterval({ counts: { both: paired.both, candidateOnly: paired.candidateOnly,
        baselineOnly: paired.baselineOnly, neither: paired.neither }, levelBps, method: 'newcombe-10' }) },
    calibrationRiskCoverage: {
      brier: binary.overall.brier, expectedCalibrationError: binary.overall.expectedCalibrationError,
      coverage: binary.overall.coverage, selectiveRisk: binary.overall.selectiveRisk,
    },
    slices: Object.fromEntries(Object.entries(binary.slices).map(([slice, metrics]) => [slice,
      { n: metrics.sampleN, coverage: metrics.coverage, selectiveRisk: metrics.selectiveRisk }])),
    latencyMs: { ...binary.overall.latencyMs },
    tokens: { input: binary.overall.inputTokens, output: binary.overall.outputTokens },
    costUsd: { candidate: candidateCost, baseline: baselineCost,
      netSavings: candidateCost === null || baselineCost === null ? null : baselineCost - candidateCost },
    reviewLoad: { reviewRate: binary.overall.reviewRate },
  };
}

/** Explicit reason-code dispositions; unknown codes fail closed as `fail`. */
const REASON_DISPOSITIONS: Readonly<Record<string, 'fail' | 'insufficient-evidence'>> = Object.freeze({
  'preregistration-digest-mismatch': 'fail',
  'preregistration-frozen-in-future': 'fail',
  'heldout-records-missing': 'insufficient-evidence',
  'heldout-evaluated-at-invalid': 'fail',
  'heldout-not-after-preregistration': 'fail',
  'heldout-evaluated-in-future': 'fail',
  'heldout-split-mismatch': 'fail',
  'heldout-records-invalid': 'fail',
  'heldout-slice-unregistered': 'fail',
  'minimum-total-support-missing': 'insufficient-evidence',
  'slice-support-missing': 'insufficient-evidence',
  'class-support-missing': 'insufficient-evidence',
  'gate-blocking-slice-support-missing': 'insufficient-evidence',
  'confidence-interval-unsupported': 'insufficient-evidence',
  'false-support-bound-exceeded': 'fail',
  'false-ready-bound-exceeded': 'fail',
  'quality-not-non-inferior': 'fail',
  'quality-non-inferiority-insufficient': 'insufficient-evidence',
  'total-economics-unknown': 'insufficient-evidence',
  'total-economics-not-positive': 'fail',
});

function reasonDisposition(reason: string): 'fail' | 'insufficient-evidence' {
  const code = reason.split(':')[0]!;
  return hasOwn(REASON_DISPOSITIONS, code) ? REASON_DISPOSITIONS[code]! : 'fail';
}

/**
 * Evaluates held-out records against a preregistration anchored by a separately trusted digest.
 * Structurally invalid preregistrations throw; every evidence problem is a reason code.
 */
export function evaluateSdlcScreeningPreregistration(
  preregistration: SdlcScreeningPreregistration | SdlcScreeningPreregistrationV2,
  trustedPreregistrationDigest: `sha256:${string}`,
  records: SdlcScreeningHeldoutRecords | null,
  nowEpochMs: number,
): SdlcScreeningPreregistrationResult {
  const frozenAt = validatePreregistration(preregistration);
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) throw new SdlcScreeningValidationError('Invalid preregistration clock');
  const reasons: string[] = [];
  const finish = (heldout: SdlcScreeningHeldoutReport | null): SdlcScreeningPreregistrationResult => {
    const unique = uniqueStrings(reasons);
    const dispositions = unique.map(reasonDisposition);
    return { decision: dispositions.includes('fail') ? 'fail' : unique.length ? 'insufficient-evidence' : 'pass', reasons: unique, heldout };
  };
  if (!isDigest(trustedPreregistrationDigest) || sdlcScreeningPreregistrationDigest(preregistration) !== trustedPreregistrationDigest) {
    reasons.push('preregistration-digest-mismatch');
  }
  if (frozenAt > nowEpochMs) reasons.push('preregistration-frozen-in-future');
  if (!records) {
    reasons.push('heldout-records-missing');
    return finish(null);
  }
  const evaluatedAt = isRecord(records) && typeof records.evaluatedAt === 'string' ? Date.parse(records.evaluatedAt) : Number.NaN;
  if (!Number.isFinite(evaluatedAt)) reasons.push('heldout-evaluated-at-invalid');
  else {
    if (evaluatedAt < frozenAt) reasons.push('heldout-not-after-preregistration');
    if (evaluatedAt > nowEpochMs) reasons.push('heldout-evaluated-in-future');
  }
  // Wilson score and Newcombe method 10 bounds are implemented for levels the paired helpers accept.
  const { method, levelBps } = preregistration.confidenceInterval;
  const intervalSupported = method === 'wilson' && levelBps > 5_000 && levelBps < 9_999;
  let report: SdlcScreeningHeldoutReport;
  try {
    report = computeSdlcScreeningHeldoutReport(records, intervalSupported ? levelBps : null);
  } catch {
    reasons.push('heldout-records-invalid');
    return finish(null);
  }
  if (report.heldoutSplitDigest !== preregistration.heldoutSplitDigest) reasons.push('heldout-split-mismatch');
  for (const slice of Object.keys(report.slices)) {
    if (!preregistration.slices.includes(slice)) reasons.push(`heldout-slice-unregistered:${slice}`);
  }
  report.gateBlockingSliceSupport = preregistration.gateBlockingSlices
    .reduce((total, slice) => total + (report.slices[slice]?.n ?? 0), 0);
  if (report.totalSupport < preregistration.minimumTotalSupport) reasons.push('minimum-total-support-missing');
  for (const slice of preregistration.slices) {
    if ((report.slices[slice]?.n ?? 0) < preregistration.minimumSliceSupport) reasons.push(`slice-support-missing:${slice}`);
  }
  if (report.gateBlockingSliceSupport < preregistration.minimumGateBlockingSliceSupport) reasons.push('gate-blocking-slice-support-missing');
  for (const [label, metric] of Object.entries(report.classes)) {
    if (metric.n < preregistration.minimumSliceSupport) reasons.push(`class-support-missing:${label}`);
  }
  if (!intervalSupported) reasons.push('confidence-interval-unsupported');
  else {
    if (report.falseSupport.upperBps === null) reasons.push('class-support-missing:false-support');
    else if (report.falseSupport.upperBps > preregistration.maximumFalseSupportRateBps) reasons.push('false-support-bound-exceeded');
    if (report.falseReady.upperBps === null) reasons.push('minimum-total-support-missing');
    else if (report.falseReady.upperBps > preregistration.maximumFalseReadyRateBps) reasons.push('false-ready-bound-exceeded');
  }
  // Paired non-inferiority of per-item readiness correctness against the baseline screening path.
  // The preregistered margin is a tolerated loss in bps; the helper's margin is candidate minus
  // baseline, so it is negated (200 bps tolerated loss => marginBps -200).
  // A null v2 margin skips the NI gate entirely: the paired contrast stays a
  // reported diagnostic and contributes no gate reason.
  if (preregistration.qualityNonInferiorityBps !== null) {
    const nonInferiority = report.paired.interval
      ? pairedNonInferiority({ interval: report.paired.interval, marginBps: -preregistration.qualityNonInferiorityBps })
      : { decision: 'insufficient' as const, reason: 'interval-unavailable' };
    if (nonInferiority.decision === 'not-non-inferior') reasons.push('quality-not-non-inferior');
    else if (nonInferiority.decision !== 'non-inferior') reasons.push('quality-non-inferiority-insufficient');
  }
  if (preregistration.efficiencyClaim.enabled) {
    const net = report.costUsd.netSavings;
    if (net === null) reasons.push('total-economics-unknown');
    else if (net <= 0 || (preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd !== null
      && net < preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd)) reasons.push('total-economics-not-positive');
  }
  return finish(report);
}

export function buildSdlcScreeningReleaseReport(input: {
  preregistration: SdlcScreeningPreregistration | SdlcScreeningPreregistrationV2;
  trustedPreregistrationDigest: `sha256:${string}`;
  heldout: SdlcScreeningHeldoutRecords | null;
  integrity: QualificationIntegrityMetadata;
  nowEpochMs: number;
}): SdlcScreeningReleaseReport {
  const preregistered = evaluateSdlcScreeningPreregistration(
    input.preregistration, input.trustedPreregistrationDigest, input.heldout, input.nowEpochMs);
  const integrityProblems = qualificationIntegrityAllowlistProblems(input.integrity);
  const readable = !integrityProblems.includes('integrity-invalid');
  const compromised = readable && (input.integrity.release_gate.decision === 'ROLLBACK'
    || input.integrity.integrity_state === 'compromised' || input.integrity.compromise_labels.length > 0);
  const decision: SdlcScreeningReleaseReport['decision'] = compromised ? 'ROLLBACK'
    : readable && integrityProblems.length === 0 && preregistered.decision === 'pass'
      && input.integrity.release_gate.decision === 'PROMOTE' ? 'PROMOTE' : 'HOLD';
  const unsigned = {
    schemaVersion: input.preregistration.schemaVersion === SDLC_SCREENING_PREREGISTRATION_VERSION_V2
      ? SDLC_SCREENING_RELEASE_VERSION_V2 : SDLC_SCREENING_RELEASE_VERSION,
    preregistration: input.preregistration,
    preregistrationDigest: sdlcScreeningPreregistrationDigest(input.preregistration),
    trustedPreregistrationDigest: input.trustedPreregistrationDigest,
    heldout: preregistered.heldout,
    integrity: input.integrity,
    preregisteredDecision: preregistered.decision,
    decision,
    reasons: uniqueStrings([...preregistered.reasons, ...integrityProblems]),
  };
  return { ...unsigned, digest: digest(unsigned) };
}
