import { createHash } from 'node:crypto';
import { DECISION_API_VERSION, type DecisionDefinition, type DecisionRuleset, type JsonSchema, type JsonValue } from './types.js';
import type { CreateReviewInput } from './review/types.js';
import { reviewDigest } from './review/validate.js';
import type { QualificationIntegrityMetadata } from './qualification/release.js';
import { canonicalJson } from '../security/artifact-trust.js';

export const SDLC_SCREENING_SCHEMA_VERSION = 'decision-sdlc-evidence-screening/v1' as const;
export const SDLC_SCREENING_PREREGISTRATION_VERSION = 'decision-sdlc-screening-preregistration/v1' as const;
export const SDLC_SCREENING_RELEASE_VERSION = 'decision-sdlc-screening-release/v1' as const;

export type SdlcScreeningMode = 'disabled' | 'shadow' | 'advisory';
export type SdlcScreeningSubjectKind = 'citation' | 'phase-criterion';
export type SdlcDeterministicStatus = 'pass' | 'review' | 'fail';
export type SdlcScreeningRoute = 'ADVISORY_READY' | 'REVIEW' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';

export type SdlcPreflightReason =
  | 'subject-isolation-violated' | 'unknown-id' | 'source-not-found' | 'locator-not-found'
  | 'source-not-retrieved' | 'source-provenance-unverified' | 'publication-not-authorized'
  | 'artifact-missing' | 'test-failed' | 'approval-absent' | 'signature-invalid'
  | 'schema-invalid' | 'evidence-expired' | 'criterion-missing' | 'required-evidence-missing';

export interface SdlcScreeningPin {
  id: string;
  version: string;
  digest: `sha256:${string}`;
}

export interface SdlcSourceEvidence extends SdlcScreeningPin {
  locator: string;
  locatorExists: boolean;
  retrieved: boolean;
  contentDigest: `sha256:${string}`;
  provenanceVerified: boolean;
  publicationAuthorized: boolean;
  trust: 'untrusted' | 'verified';
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
}

export interface SdlcGateEvidenceItem extends SdlcScreeningPin {
  type: 'artifact' | 'test-result' | 'approval' | 'signature' | 'schema';
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

export interface SdlcCitationObservation {
  kind: 'citation';
  claimId: string;
  sourceId: string;
  locator: string;
  support: 'supports' | 'does-not-support' | 'contradicts' | 'unclear';
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
    kind: SdlcScreeningSubjectKind;
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
  pins: SdlcScreeningPin[];
  trace: {
    redaction: 'metadata-only';
    subjectDigest: `sha256:${string}`;
    observationDigest: `sha256:${string}` | null;
  };
  action: { status: 'unexecuted' };
}

export interface SdlcScreeningRequest {
  schemaVersion: typeof SDLC_SCREENING_SCHEMA_VERSION;
  mode: SdlcScreeningMode;
  inventory: SdlcScreeningInventory;
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
  maximumFalseSupportRateBps: number;
  maximumFalseReadyRateBps: number;
  minimumTotalSupport: number;
  minimumGateBlockingSliceSupport: number;
  confidenceInterval: { method: 'wilson' | 'exact-binomial'; levelBps: number };
  qualityNonInferiorityBps: number;
  efficiencyClaim: { enabled: boolean; minimumPositiveTotalEconomicsUsd: number | null };
}

export interface SdlcScreeningHeldoutReport {
  schemaVersion: 'decision-sdlc-screening-heldout-report/v1';
  support: SdlcClassMetrics;
  contradiction: SdlcClassMetrics;
  unclear: SdlcClassMetrics;
  calibrationRiskCoverage: SdlcMetricBlock;
  falseSupportRateBps: number | null;
  falseReadyRateBps: number | null;
  reviewerAgreementRateBps: number | null;
  reviewerOverrideRateBps: number | null;
  slices: Record<string, SdlcMetricBlock>;
  latencyMs: SdlcMetricBlock;
  tokens: SdlcMetricBlock;
  costUsd: SdlcMetricBlock;
  reviewLoad: SdlcMetricBlock;
  gateBlockingSliceSupport: number;
  totalSupport: number;
  positiveTotalEconomicsUsd: number | null;
}

export interface SdlcMetricBlock {
  n: number;
  value: number | null;
}

export interface SdlcClassMetrics extends SdlcMetricBlock {
  precisionBps: number | null;
  recallBps: number | null;
}

export interface SdlcScreeningReleaseReport {
  schemaVersion: typeof SDLC_SCREENING_RELEASE_VERSION;
  preregistration: SdlcScreeningPreregistration;
  heldout: SdlcScreeningHeldoutReport | null;
  integrity: QualificationIntegrityMetadata;
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  reasons: string[];
  digest: `sha256:${string}`;
}

export class SdlcScreeningValidationError extends Error {}

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

/** Closed portable definitions/rulesets for the D29 screening pack. They are data, not authority. */
export function sdlcScreeningDecisionArtifacts(): { definitions: DecisionDefinition[]; rulesets: DecisionRuleset[] } {
  const definitions = [
    definition('sdlc-screening.citation.support', 'Classify whether one cited source supports one claim.', {
      kind: 'choice',
      options: ['supports', 'does-not-support', 'contradicts', 'unclear']
        .map(id => ({ id, description: `Citation support label: ${id}` })),
    }),
    definition('sdlc-screening.citation.injection', 'Estimate whether the source contains prompt-injection or authority-seeking content.', {
      kind: 'truth-probability',
      trueDescription: 'The source contains likely prompt injection or unrelated instructions.',
      falseDescription: 'The source is ordinary evidence content.',
    }),
    definition('sdlc-screening.criterion.relevance', 'Classify whether enumerated evidence is relevant to one gate criterion.', {
      kind: 'choice',
      options: ['relevant', 'irrelevant', 'unclear'].map(id => ({ id, description: `Criterion relevance label: ${id}` })),
    }),
    definition('sdlc-screening.criterion.completeness', 'Classify whether enumerated evidence is complete for one gate criterion.', {
      kind: 'choice',
      options: ['complete', 'incomplete', 'unclear'].map(id => ({ id, description: `Criterion completeness label: ${id}` })),
    }),
    definition('sdlc-screening.criterion.contradiction', 'Classify whether enumerated evidence contradicts itself or the criterion.', {
      kind: 'choice',
      options: ['none', 'present', 'unclear'].map(id => ({ id, description: `Criterion contradiction label: ${id}` })),
    }),
    definition('sdlc-screening.criterion.reviewer-attention', 'Classify whether one criterion needs reviewer attention.', {
      kind: 'choice',
      options: ['needed', 'not-needed'].map(id => ({ id, description: `Reviewer attention label: ${id}` })),
    }),
  ];
  const byId = new Map(definitions.map(item => [item.metadata.id, item]));
  const citationSupport = pinDefinition(byId.get('sdlc-screening.citation.support')!);
  const citationInjection = pinDefinition(byId.get('sdlc-screening.citation.injection')!);
  const criterionRelevance = pinDefinition(byId.get('sdlc-screening.criterion.relevance')!);
  const criterionCompleteness = pinDefinition(byId.get('sdlc-screening.criterion.completeness')!);
  const criterionContradiction = pinDefinition(byId.get('sdlc-screening.criterion.contradiction')!);
  const criterionAttention = pinDefinition(byId.get('sdlc-screening.criterion.reviewer-attention')!);
  const rulesets: DecisionRuleset[] = [
    {
      apiVersion: DECISION_API_VERSION,
      kind: 'DecisionRuleset',
      metadata: { id: 'sdlc-screening.citation', version: '1.0.0', description: 'Closed citation support screening ruleset.' },
      spec: {
        purpose: 'Route one claim/source pair to advisory-ready or review evidence.',
        inputSchema: subjectInputSchema,
        evaluations: [
          { alias: 'support', decision: citationSupport, inputPointer: '' },
          { alias: 'injection', decision: citationInjection, inputPointer: '' },
        ],
        rules: [
          { id: 'injection-review', priority: 300, when: { op: 'gte', left: { source: 'decision', alias: 'injection', pointer: '/value' }, right: 0.8 }, outcome: { route: 'REVIEW', reason: 'prompt-injection-flagged' } },
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
          { alias: 'attention', decision: criterionAttention, inputPointer: '' },
        ],
        rules: [
          { id: 'needs-review', priority: 200, when: { any: [
            { op: 'ne', left: { source: 'decision', alias: 'relevance', pointer: '/value' }, right: 'relevant' },
            { op: 'ne', left: { source: 'decision', alias: 'completeness', pointer: '/value' }, right: 'complete' },
            { op: 'ne', left: { source: 'decision', alias: 'contradiction', pointer: '/value' }, right: 'none' },
            { op: 'eq', left: { source: 'decision', alias: 'attention', pointer: '/value' }, right: 'needed' },
          ] }, outcome: { route: 'REVIEW', reason: 'criterion-needs-review' } },
          { id: 'ready-indicator', priority: 100, when: { all: [
            { op: 'eq', left: { source: 'decision', alias: 'relevance', pointer: '/value' }, right: 'relevant' },
            { op: 'eq', left: { source: 'decision', alias: 'completeness', pointer: '/value' }, right: 'complete' },
            { op: 'eq', left: { source: 'decision', alias: 'contradiction', pointer: '/value' }, right: 'none' },
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

function assertDigest(value: string, label: string): asserts value is `sha256:${string}` {
  if (!digestPattern.test(value)) throw new SdlcScreeningValidationError(`Invalid digest: ${label}`);
}

function assertBps(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new SdlcScreeningValidationError(`Invalid basis points: ${label}`);
}

function requireKnown(ids: readonly string[], value: string, reason: SdlcPreflightReason): void {
  if (!ids.includes(value)) throw new SdlcScreeningValidationError(`${reason}: ${value}`);
}

function validatePins(pins: readonly SdlcScreeningPin[]): void {
  const seen = new Set<string>();
  for (const pin of pins) {
    if (!pin.id || !pin.version) throw new SdlcScreeningValidationError('Pin identity is required');
    assertDigest(pin.digest, pin.id);
    const key = `${pin.id}\0${pin.version}`;
    if (seen.has(key)) throw new SdlcScreeningValidationError(`Duplicate pin: ${pin.id}`);
    seen.add(key);
  }
}

function subjectPins(subject: SdlcScreeningSubject): SdlcScreeningPin[] {
  return subject.kind === 'citation' ? [...subject.evidence] : [...subject.evidence];
}

function validateSubject(request: SdlcScreeningRequest): void {
  if (request.schemaVersion !== SDLC_SCREENING_SCHEMA_VERSION) throw new SdlcScreeningValidationError('Unsupported screening schema');
  if (!Number.isSafeInteger(request.nowEpochMs) || request.nowEpochMs < 0) throw new SdlcScreeningValidationError('Invalid screening clock');
  const { inventory, subject } = request;
  if (!subject.subjectId || !subject.requirementIds.length) throw new SdlcScreeningValidationError('Screening subject identity is required');
  for (const requirementId of subject.requirementIds) requireKnown(inventory.requirementIds, requirementId, 'unknown-id');
  validatePins(subjectPins(subject));
  if (subject.kind === 'citation') {
    if (subject.evidence.length !== 1) throw new SdlcScreeningValidationError('Citation screening requires exactly one source');
    requireKnown(inventory.claimIds, subject.claimId, 'unknown-id');
    requireKnown(inventory.sourceIds, subject.sourceId, 'unknown-id');
    requireKnown(inventory.locators, subject.locator, 'unknown-id');
    const [source] = subject.evidence;
    if (source.id !== subject.sourceId || source.locator !== subject.locator) throw new SdlcScreeningValidationError('Citation subject and source evidence mismatch');
    assertDigest(source.contentDigest, source.id);
  } else {
    requireKnown(inventory.criterionIds, subject.criterionId, 'unknown-id');
    if (!subject.evidence.length) throw new SdlcScreeningValidationError('Criterion screening requires at least one evidence item');
    for (const item of subject.evidence) requireKnown(inventory.evidenceIds, item.id, 'unknown-id');
  }
}

function validateObservation(subject: SdlcScreeningSubject, observation?: SdlcScreeningObservation): void {
  if (!observation) return;
  assertBps(observation.confidenceBps, 'confidence');
  if (!Number.isSafeInteger(observation.attempts) || observation.attempts < 1) throw new SdlcScreeningValidationError('Observation attempts must be positive');
  if (!observation.model) throw new SdlcScreeningValidationError('Observation model is required');
  if (subject.kind === 'citation') {
    if (observation.kind !== 'citation' || observation.claimId !== subject.claimId ||
        observation.sourceId !== subject.sourceId || observation.locator !== subject.locator) {
      throw new SdlcScreeningValidationError('Observation subject mismatch');
    }
    assertBps(observation.supportStrengthBps, 'support strength');
  } else if (observation.kind !== 'phase-criterion' || observation.criterionId !== subject.criterionId ||
      canonicalJson([...observation.evidenceIds].sort()) !== canonicalJson(subject.evidence.map(item => item.id).sort())) {
    throw new SdlcScreeningValidationError('Observation subject mismatch');
  }
}

export function sdlcScreeningPreflight(subject: SdlcScreeningSubject, nowEpochMs: number): SdlcPreflightFinding[] {
  const findings: SdlcPreflightFinding[] = [];
  if (subject.kind === 'citation') {
    const [source] = subject.evidence;
    if (source.id !== subject.sourceId) findings.push({ reason: 'source-not-found', id: subject.sourceId, status: 'review' });
    if (source.locator !== subject.locator || !source.locatorExists) findings.push({ reason: 'locator-not-found', id: subject.locator, status: 'review' });
    if (!source.retrieved) findings.push({ reason: 'source-not-retrieved', id: subject.locator, status: 'review' });
    if (!source.provenanceVerified) findings.push({ reason: 'source-provenance-unverified', id: source.id, status: 'review' });
    if (!source.publicationAuthorized) findings.push({ reason: 'publication-not-authorized', id: source.id, status: 'review' });
    return findings;
  }
  for (const item of subject.evidence) {
    if (item.required && !item.present) {
      const reason: SdlcPreflightReason = item.type === 'artifact' ? 'artifact-missing'
        : item.type === 'test-result' ? 'test-failed'
        : item.type === 'approval' ? 'approval-absent'
        : item.type === 'signature' ? 'signature-invalid' : 'schema-invalid';
      findings.push({ reason, id: item.id, status: item.type === 'test-result' ? 'fail' : 'review' });
    } else if (item.required && !item.passed) {
      const reason: SdlcPreflightReason = item.type === 'test-result' ? 'test-failed'
        : item.type === 'signature' ? 'signature-invalid'
        : item.type === 'schema' ? 'schema-invalid' : 'required-evidence-missing';
      findings.push({ reason, id: item.id, status: item.type === 'test-result' ? 'fail' : 'review' });
    }
    if (item.required && item.expiresAtEpochMs !== undefined && item.expiresAtEpochMs < nowEpochMs) {
      findings.push({ reason: 'evidence-expired', id: item.id, status: 'review' });
    }
  }
  return findings;
}

function deterministicStatus(findings: readonly SdlcPreflightFinding[]): SdlcDeterministicStatus {
  return findings.some(item => item.status === 'fail') ? 'fail' : findings.length ? 'review' : 'pass';
}

function semanticDecision(subject: SdlcScreeningSubject, observation?: SdlcScreeningObservation): SdlcScreeningReceipt['semantic'] {
  if (!observation) return { observed: false, accepted: false, reason: 'semantic-evidence-missing', model: null, attempts: 0, confidenceBps: null };
  if (observation.kind === 'citation' && subject.kind === 'citation') {
    if (observation.injection !== 'no') return { observed: true, accepted: false, reason: 'prompt-injection-flagged', model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
    if (observation.support === 'contradicts') return { observed: true, accepted: false, reason: 'citation-contradicts', model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
    if (observation.support === 'supports' && observation.supportStrengthBps >= 8_000 && observation.confidenceBps >= 8_000) {
      return { observed: true, accepted: true, reason: 'citation-supported', model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
    }
    return { observed: true, accepted: false, reason: observation.support === 'unclear' ? 'citation-unclear' : 'citation-not-supported', model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
  }
  if (observation.kind === 'phase-criterion' && subject.kind === 'phase-criterion') {
    const clean = observation.relevance === 'relevant' && observation.completeness === 'complete' &&
      observation.contradiction === 'none' && observation.ambiguity === 'low' &&
      observation.reviewerAttention === 'not-needed' && observation.confidenceBps >= 8_000;
    return { observed: true, accepted: clean, reason: clean ? 'criterion-ready-indicator' : 'criterion-needs-review',
      model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
  }
  throw new SdlcScreeningValidationError('Observation subject kind mismatch');
}

export function evaluateSdlcEvidenceScreening(request: SdlcScreeningRequest): SdlcScreeningReceipt | null {
  if (request.mode === 'disabled') return null;
  validateSubject(request);
  validateObservation(request.subject, request.observation);
  const findings = sdlcScreeningPreflight(request.subject, request.nowEpochMs);
  const status = deterministicStatus(findings);
  const semantic = semanticDecision(request.subject, request.observation);
  const reviewReasons = [...findings.map(item => item.reason), ...(semantic.accepted ? [] : [semantic.reason])];
  const route: SdlcScreeningRoute = status === 'fail' ? 'FAIL'
    : status === 'review' ? 'REVIEW'
    : semantic.accepted ? 'ADVISORY_READY' : 'REVIEW';
  const evidenceIds = request.subject.kind === 'phase-criterion' ? request.subject.evidence.map(item => item.id) : [request.subject.sourceId];
  const receipt: SdlcScreeningReceipt = {
    schemaVersion: SDLC_SCREENING_SCHEMA_VERSION,
    mode: request.mode,
    subject: {
      kind: request.subject.kind, subjectId: request.subject.subjectId,
      requirementIds: [...request.subject.requirementIds], evidenceIds,
      ...(request.subject.kind === 'citation' ? { claimId: request.subject.claimId, sourceId: request.subject.sourceId, locator: request.subject.locator }
        : { criterionId: request.subject.criterionId }),
    },
    deterministic: { status, findings },
    semantic,
    route,
    reviewRequired: route !== 'ADVISORY_READY',
    reviewReasons,
    pins: subjectPins(request.subject).map(pin => ({ id: pin.id, version: pin.version, digest: pin.digest })),
    trace: { redaction: 'metadata-only', subjectDigest: digest(request.subject), observationDigest: request.observation ? digest(request.observation) : null },
    action: { status: 'unexecuted' },
  };
  return receipt;
}

export function applySdlcScreeningToGateOutcome<T extends JsonValue>(
  currentOutcome: T,
  mode: SdlcScreeningMode,
  auditReceipts: SdlcScreeningPin[] = [],
  receipt: SdlcScreeningReceipt | null = null,
): SdlcScreeningOutcomeApplication<T> {
  const base = { outcome: structuredClone(currentOutcome), publication: 'unchanged' as const,
    auditReceipts: auditReceipts.map(item => ({ ...item })) };
  return mode === 'disabled' || !receipt ? base : { ...base, alternateScreening: receipt };
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
  if (!options.enabled || !receipt.reviewRequired) return null;
  const policyDigest = reviewDigest({ schemaVersion: receipt.schemaVersion, route: receipt.route, reasons: receipt.reviewReasons });
  return {
    reviewId: options.reviewId,
    sourceReceipt: { id: receipt.subject.subjectId, digest: reviewDigest(receipt) },
    evidencePins: receipt.pins,
    policyPins: [{ id: 'sdlc-evidence-screening', version: '1.0.0', digest: policyDigest }],
    reasonCodes: [...receipt.reviewReasons],
    riskTier: options.riskTier,
    presentation: { ...options.requesterPresentation, subject: receipt.subject, route: receipt.route, trace: receipt.trace },
    action: { kind: 'sdlc-screening-review', subject: receipt.subject, route: receipt.route },
    rationale: options.rationale,
    expiresAtEpochMs: options.expiresAtEpochMs,
    continuationId: options.continuationId,
    resumeToken: options.resumeToken,
  };
}

export function evaluateSdlcScreeningPreregistration(
  preregistration: SdlcScreeningPreregistration,
  report: SdlcScreeningHeldoutReport | null,
): { decision: 'pass' | 'fail' | 'insufficient-evidence'; reasons: string[] } {
  if (preregistration.schemaVersion !== SDLC_SCREENING_PREREGISTRATION_VERSION || !preregistration.planId) {
    throw new SdlcScreeningValidationError('Invalid screening preregistration');
  }
  for (const [label, value] of [
    ['maximumFalseSupportRateBps', preregistration.maximumFalseSupportRateBps],
    ['maximumFalseReadyRateBps', preregistration.maximumFalseReadyRateBps],
    ['confidence level', preregistration.confidenceInterval.levelBps],
  ] as const) assertBps(value, label);
  if (!report) return { decision: 'insufficient-evidence', reasons: ['heldout-report-missing'] };
  const reasons: string[] = [];
  if (report.totalSupport < preregistration.minimumTotalSupport) reasons.push('minimum-total-support-missing');
  if (report.gateBlockingSliceSupport < preregistration.minimumGateBlockingSliceSupport) reasons.push('gate-blocking-slice-support-missing');
  if (report.falseSupportRateBps === null || report.falseSupportRateBps > preregistration.maximumFalseSupportRateBps) reasons.push('false-support-bound-failed');
  if (report.falseReadyRateBps === null || report.falseReadyRateBps > preregistration.maximumFalseReadyRateBps) reasons.push('false-ready-bound-failed');
  if (preregistration.efficiencyClaim.enabled && (report.positiveTotalEconomicsUsd === null || report.positiveTotalEconomicsUsd <= 0 ||
      (preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd !== null && report.positiveTotalEconomicsUsd < preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd))) {
    reasons.push('positive-total-economics-missing');
  }
  return reasons.length ? { decision: reasons.some(reason => reason.includes('missing')) ? 'insufficient-evidence' : 'fail', reasons } : { decision: 'pass', reasons: [] };
}

export function buildSdlcScreeningReleaseReport(input: {
  preregistration: SdlcScreeningPreregistration;
  heldout: SdlcScreeningHeldoutReport | null;
  integrity: QualificationIntegrityMetadata;
}): SdlcScreeningReleaseReport {
  const preregistered = evaluateSdlcScreeningPreregistration(input.preregistration, input.heldout);
  const upstream = input.integrity.release_gate.decision;
  const reasons = [...preregistered.reasons];
  if (upstream !== 'PROMOTE') reasons.push(`upstream-integrity-${upstream.toLowerCase()}`);
  if (input.integrity.integrity_state === 'compromised' || input.integrity.compromise_labels.length > 0) reasons.push('integrity-compromised');
  const decision: SdlcScreeningReleaseReport['decision'] = upstream === 'ROLLBACK' || reasons.includes('integrity-compromised') ? 'ROLLBACK'
    : upstream === 'PROMOTE' && preregistered.decision === 'pass' ? 'PROMOTE' : 'HOLD';
  const unsigned = {
    schemaVersion: SDLC_SCREENING_RELEASE_VERSION,
    preregistration: input.preregistration,
    heldout: input.heldout,
    integrity: input.integrity,
    decision,
    reasons,
  };
  return { ...unsigned, digest: digest(unsigned) };
}
