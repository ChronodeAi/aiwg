import { createHash } from 'node:crypto';
import {
  DECISION_API_VERSION, DECISION_API_VERSION_STRUCTURED, type AdapterObservation,
  type DecisionDefinition, type DecisionResult, type DecisionRuleset, type JsonSchema, type JsonValue,
  type PrimitiveAcceptancePolicy,
} from './types.js';
import type { CreateReviewInput } from './review/types.js';
import { reviewDigest } from './review/validate.js';
import type { QualificationIntegrityMetadata } from './qualification/release.js';
import { applyPrimitiveAcceptance } from './acceptance.js';
import { composeRuleset } from './compose.js';
import { validateProjectionPolicy, type DecisionProjectionPolicy } from './projection.js';
import { artifactPin } from './validate.js';
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
  | 'schema-invalid' | 'evidence-expired' | 'criterion-missing' | 'required-evidence-missing'
  | 'evidence-untrusted' | 'evidence-restricted' | 'content-digest-mismatch' | 'invalid-observation'
  | 'calibration-incompatible';

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
  content?: string;
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

export interface SdlcGateEvidencePolicy extends SdlcScreeningPin {
  requiredEvidenceByCriterion: Record<string, string[]>;
  evidenceSubjects: Record<string, { kind: 'phase-criterion'; criterionId: string } |
    { kind: 'citation'; claimId: string; sourceId: string; locator: string }>;
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
  gatePolicy?: SdlcGateEvidencePolicy;
  subject: SdlcScreeningSubject;
  observation?: SdlcScreeningObservation;
  calibrationCompatibility?: { action: 'allow' | 'defer' | 'fail' | 'shadow' | 'require-approval'; reasons: string[] };
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
  evaluatedAt?: string;
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
    definition('sdlc-screening.criterion.ambiguity', 'Classify whether one criterion/evidence bundle is ambiguous.', {
      kind: 'choice',
      options: ['low', 'high', 'unclear'].map(id => ({ id, description: `Criterion ambiguity label: ${id}` })),
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
  const criterionAmbiguity = pinDefinition(byId.get('sdlc-screening.criterion.ambiguity')!);
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

function assertDigest(value: string, label: string): asserts value is `sha256:${string}` {
  if (!digestPattern.test(value)) throw new SdlcScreeningValidationError(`Invalid digest: ${label}`);
}

function assertBps(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new SdlcScreeningValidationError(`Invalid basis points: ${label}`);
}

function requireKnown(ids: readonly string[], value: string, reason: SdlcPreflightReason): void {
  if (!ids.includes(value)) throw new SdlcScreeningValidationError(`${reason}: ${value}`);
}

function rejectUnknownKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new SdlcScreeningValidationError(`${label} contains unsupported fields`);
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
    validateGatePolicy(request);
  }
}

function validateGatePolicy(request: SdlcScreeningRequest): void {
  const policy = request.gatePolicy;
  if (!policy) throw new SdlcScreeningValidationError('criterion-missing: gate policy is required');
  validatePins([policy]);
  const criteria = new Set(request.inventory.criterionIds);
  const evidence = new Set(request.inventory.evidenceIds);
  for (const [criterionId, ids] of Object.entries(policy.requiredEvidenceByCriterion)) {
    if (!criteria.has(criterionId) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !evidence.has(id))) {
      throw new SdlcScreeningValidationError(`criterion-missing: ${criterionId}`);
    }
  }
  for (const [evidenceId, owner] of Object.entries(policy.evidenceSubjects)) {
    if (owner.kind === 'phase-criterion') {
      if (!evidence.has(evidenceId) || !criteria.has(owner.criterionId)) {
        throw new SdlcScreeningValidationError(`unknown-id: ${evidenceId}`);
      }
    }
    if (owner.kind === 'citation') {
      if (evidenceId !== owner.sourceId) throw new SdlcScreeningValidationError(`unknown-id: ${evidenceId}`);
      requireKnown(request.inventory.claimIds, owner.claimId, 'unknown-id');
      requireKnown(request.inventory.sourceIds, owner.sourceId, 'unknown-id');
      requireKnown(request.inventory.locators, owner.locator, 'unknown-id');
    }
  }
}

function validateObservation(subject: SdlcScreeningSubject, observation?: SdlcScreeningObservation): void {
  if (!observation) return;
  assertBps(observation.confidenceBps, 'confidence');
  if (!Number.isSafeInteger(observation.attempts) || observation.attempts < 1) throw new SdlcScreeningValidationError('Observation attempts must be positive');
  if (!observation.model) throw new SdlcScreeningValidationError('Observation model is required');
  if (subject.kind === 'citation') {
    rejectUnknownKeys(observation, ['kind', 'claimId', 'sourceId', 'locator', 'support', 'supportStrengthBps', 'injection', 'confidenceBps', 'model', 'attempts'], 'Citation observation');
    if (observation.kind !== 'citation' || observation.claimId !== subject.claimId ||
        observation.sourceId !== subject.sourceId || observation.locator !== subject.locator) {
      throw new SdlcScreeningValidationError('Observation subject mismatch');
    }
    assertBps(observation.supportStrengthBps, 'support strength');
  } else {
    rejectUnknownKeys(observation, ['kind', 'criterionId', 'evidenceIds', 'relevance', 'completeness', 'contradiction', 'ambiguity', 'reviewerAttention', 'confidenceBps', 'model', 'attempts'], 'Criterion observation');
    if (observation.kind !== 'phase-criterion' || observation.criterionId !== subject.criterionId ||
        canonicalJson([...observation.evidenceIds].sort()) !== canonicalJson(subject.evidence.map(item => item.id).sort())) {
      throw new SdlcScreeningValidationError('Observation subject mismatch');
    }
  }
}

export function sdlcScreeningPreflight(
  subject: SdlcScreeningSubject,
  nowEpochMs: number,
  gatePolicy?: SdlcGateEvidencePolicy,
): SdlcPreflightFinding[] {
  const findings: SdlcPreflightFinding[] = [];
  if (subject.kind === 'citation') {
    const [source] = subject.evidence;
    if (source.id !== subject.sourceId) findings.push({ reason: 'source-not-found', id: subject.sourceId, status: 'review' });
    if (source.locator !== subject.locator || !source.locatorExists) findings.push({ reason: 'locator-not-found', id: subject.locator, status: 'review' });
    if (!source.retrieved) findings.push({ reason: 'source-not-retrieved', id: subject.locator, status: 'review' });
    if (!source.provenanceVerified) findings.push({ reason: 'source-provenance-unverified', id: source.id, status: 'review' });
    if (!source.publicationAuthorized) findings.push({ reason: 'publication-not-authorized', id: source.id, status: 'review' });
    if (source.trust !== 'verified') findings.push({ reason: 'evidence-untrusted', id: source.id, status: 'review' });
    if (source.sensitivity === 'restricted') findings.push({ reason: 'evidence-restricted', id: source.id, status: 'review' });
    findings.push(...projectionBoundaryFindings(subject));
    if (source.content !== undefined && digest(source.content) !== source.contentDigest) {
      findings.push({ reason: 'content-digest-mismatch', id: source.id, status: 'review' });
    }
    const owner = gatePolicy?.evidenceSubjects[source.id];
    if (owner && (owner.kind !== 'citation' || owner.claimId !== subject.claimId ||
        owner.sourceId !== subject.sourceId || owner.locator !== subject.locator)) {
      findings.push({ reason: 'subject-isolation-violated', id: source.id, status: 'review' });
    }
    return findings;
  }
  const required = gatePolicy?.requiredEvidenceByCriterion[subject.criterionId];
  if (!required?.length) findings.push({ reason: 'criterion-missing', id: subject.criterionId, status: 'review' });
  const byId = new Map(subject.evidence.map(item => [item.id, item]));
  for (const id of required ?? []) {
    const item = byId.get(id);
    const owner = gatePolicy?.evidenceSubjects[id];
    if (!item) {
      findings.push({ reason: 'required-evidence-missing', id, status: 'review' });
      continue;
    }
    if (owner && (owner.kind !== 'phase-criterion' || owner.criterionId !== subject.criterionId)) {
      findings.push({ reason: 'subject-isolation-violated', id: item.id, status: 'review' });
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
        : item.type === 'schema' ? 'schema-invalid' : 'required-evidence-missing';
      findings.push({ reason, id: item.id, status: item.type === 'test-result' ? 'fail' : 'review' });
    }
    if (item.expiresAtEpochMs !== undefined && item.expiresAtEpochMs <= nowEpochMs) {
      findings.push({ reason: 'evidence-expired', id: item.id, status: 'review' });
    }
  }
  return findings;
}

function projectionBoundaryFindings(subject: SdlcCitationSubject): SdlcPreflightFinding[] {
  const [source] = subject.evidence;
  const policy: DecisionProjectionPolicy = {
    version: 'sdlc-screening-d10/v1', provider: 'jev', model: 'sdlc-screening',
    origin: 'https://decision.invalid', region: 'offline', purpose: 'sdlc-evidence-screening',
    allowIncompleteContext: false, maxSensitivity: 'confidential',
    fields: [{
      pointer: '/evidence/0/content', output: 'sourceContent', source: source.id,
      subject: subject.subjectId, trust: source.trust, sensitivity: source.sensitivity,
      purpose: 'sdlc-evidence-screening', retentionClass: 'metadata-only',
      accessScopes: ['decision:sdlc-screening'], exportPolicy: source.sensitivity === 'restricted' ? 'denied' : 'sanitized',
      deletionPolicy: 'erase', backupPolicy: source.sensitivity === 'restricted' ? 'not-persisted' : 'expire-with-primary',
      allowedProviders: ['jev'], allowedModels: ['sdlc-screening'],
      allowedOrigins: ['https://decision.invalid'], allowedRegions: ['offline'],
    }],
  };
  try {
    validateProjectionPolicy(policy);
    return [];
  } catch {
    return [{ reason: source.sensitivity === 'restricted' ? 'evidence-restricted' : 'source-provenance-unverified',
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

function semanticDecision(
  subject: SdlcScreeningSubject,
  observation?: SdlcScreeningObservation,
  calibrationCompatibility?: SdlcScreeningRequest['calibrationCompatibility'],
): SdlcScreeningReceipt['semantic'] {
  if (!observation) return { observed: false, accepted: false, reason: 'semantic-evidence-missing', model: null, attempts: 0, confidenceBps: null };
  if (calibrationCompatibility && calibrationCompatibility.action !== 'allow') {
    return { observed: true, accepted: false, reason: `calibration-${calibrationCompatibility.action}`,
      model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
  }
  const { definitions, rulesets } = sdlcScreeningDecisionArtifacts();
  const ruleset = rulesets.find(item => item.metadata.id === (subject.kind === 'citation'
    ? 'sdlc-screening.citation' : 'sdlc-screening.phase-criterion'))!;
  const byId = new Map(definitions.map(item => [item.metadata.id, item]));
  const evaluations: Record<string, DecisionResult> = {};
  const add = (alias: string, value: string | number, confidenceBps: number, distribution: Record<string, number> | null = null): void => {
    const pin = ruleset.spec.evaluations.find(item => item.alias === alias)!.decision;
    const definition = byId.get(pin.id)!;
    const raw: AdapterObservation = {
      status: 'success', reason: 'none', value, actualModel: observation.model, requestId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
      uncertainty: distribution ? {
        source: 'provider', profile: 'sdlc-screening-choice-v1', calibration: 'uncalibrated',
        confidence: confidenceBps / 10_000, distribution, calibrationRef: null,
      } : {
        source: 'provider', profile: 'sdlc-screening-truth-v1', calibration: 'uncalibrated',
        confidence: null, distribution: null, calibrationRef: null,
      },
    };
    const accepted = distribution ? applyPrimitiveAcceptance(definition, screeningAcceptancePolicy, raw) : raw;
    evaluations[alias] = decisionResultForScreening(definition, ruleset, alias, accepted, observation.model);
  };
  if (observation.kind === 'citation' && subject.kind === 'citation') {
    add('support', observation.support, Math.min(observation.confidenceBps, observation.supportStrengthBps),
      choiceDistribution(['supports', 'does-not-support', 'contradicts', 'unclear'], observation.support,
        Math.min(observation.confidenceBps, observation.supportStrengthBps)));
    add('injection', observation.injection === 'yes' ? 1 : observation.injection === 'unclear' ? 0.5 : 0, observation.confidenceBps);
  } else if (observation.kind === 'phase-criterion' && subject.kind === 'phase-criterion') {
    add('relevance', observation.relevance, observation.confidenceBps,
      choiceDistribution(['relevant', 'irrelevant', 'unclear'], observation.relevance, observation.confidenceBps));
    add('completeness', observation.completeness, observation.confidenceBps,
      choiceDistribution(['complete', 'incomplete', 'unclear'], observation.completeness, observation.confidenceBps));
    add('contradiction', observation.contradiction, observation.confidenceBps,
      choiceDistribution(['none', 'present', 'unclear'], observation.contradiction, observation.confidenceBps));
    add('ambiguity', observation.ambiguity, observation.confidenceBps,
      choiceDistribution(['low', 'high', 'unclear'], observation.ambiguity, observation.confidenceBps));
    add('attention', observation.reviewerAttention, observation.confidenceBps,
      choiceDistribution(['needed', 'not-needed'], observation.reviewerAttention, observation.confidenceBps));
  } else {
    throw new SdlcScreeningValidationError('Observation subject kind mismatch');
  }
  const composition = composeRuleset(ruleset, { subjectId: subject.subjectId }, evaluations);
  const outcome = composition.outcome && typeof composition.outcome === 'object' && !Array.isArray(composition.outcome)
    ? composition.outcome as { route?: unknown; reason?: unknown } : {};
  const route = outcome.route === 'ADVISORY_READY' || outcome.route === 'REVIEW' || outcome.route === 'FAIL'
    ? outcome.route : 'REVIEW';
  const reason = typeof outcome.reason === 'string' ? outcome.reason : composition.reason;
  return { observed: true, accepted: route === 'ADVISORY_READY', reason,
    model: observation.model, attempts: observation.attempts, confidenceBps: observation.confidenceBps };
}

function choiceDistribution(options: readonly string[], selected: string, selectedBps: number): Record<string, number> {
  const selectedProbability = selectedBps / 10_000;
  const remaining = Math.max(0, 1 - selectedProbability);
  const others = options.filter(option => option !== selected);
  return Object.fromEntries(options.map(option => [option, option === selected ? selectedProbability
    : others.length ? remaining / others.length : 0]));
}

function decisionResultForScreening(
  definition: DecisionDefinition,
  ruleset: DecisionRuleset,
  alias: string,
  observation: AdapterObservation,
  model: string,
): DecisionResult {
  const pin = artifactPin(definition);
  const rulesetPin = artifactPin(ruleset);
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

export function evaluateSdlcEvidenceScreening(request: SdlcScreeningRequest): SdlcScreeningReceipt | null {
  if (request.mode === 'disabled') return null;
  let validationFindings: SdlcPreflightFinding[] = [];
  try {
    validateSubject(request);
    validateObservation(request.subject, request.observation);
  } catch (error) {
    if (!(error instanceof SdlcScreeningValidationError)) throw error;
    validationFindings = [validationFinding(error)];
  }
  const findings = validationFindings.length ? validationFindings
    : sdlcScreeningPreflight(request.subject, request.nowEpochMs, request.gatePolicy);
  const status = deterministicStatus(findings);
  let semantic: SdlcScreeningReceipt['semantic'];
  try {
    semantic = validationFindings.length
      ? { observed: false, accepted: false, reason: validationFindings[0]!.reason, model: null, attempts: 0, confidenceBps: null }
      : semanticDecision(request.subject, request.observation, request.calibrationCompatibility);
  } catch (error) {
    if (!(error instanceof SdlcScreeningValidationError)) throw error;
    semantic = { observed: false, accepted: false, reason: 'invalid-observation', model: null, attempts: 0, confidenceBps: null };
    findings.push(validationFinding(error));
  }
  const reviewReasons = uniqueStrings([...findings.map(item => item.reason), ...(semantic.accepted ? [] : [semantic.reason])]);
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
    trace: { redaction: 'metadata-only', subjectDigest: digest(request.subject), observationDigest: request.observation ? optionalDigest(request.observation) : null },
    action: { status: 'unexecuted' },
  };
  return receipt;
}

function validationFinding(error: SdlcScreeningValidationError): SdlcPreflightFinding {
  const message = error.message;
  const reason: SdlcPreflightReason = message.includes('unknown-id') ? 'unknown-id'
    : message.includes('criterion-missing') ? 'criterion-missing'
    : message.includes('subject mismatch') || message.includes('mismatch') ? 'subject-isolation-violated'
    : 'invalid-observation';
  return { reason, id: 'validation', status: reason === 'invalid-observation' ? 'fail' : 'review' };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function optionalDigest(value: unknown): `sha256:${string}` | null {
  try { return digest(value); }
  catch { return null; }
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
  if (!receipt.reviewRequired) return null;
  const policyDigest = reviewDigest({ schemaVersion: receipt.schemaVersion, route: receipt.route, reasons: receipt.reviewReasons });
  const requesterPresentationDigest = options.requesterPresentation
    ? reviewDigest(options.requesterPresentation) : null;
  return {
    reviewId: options.reviewId,
    sourceReceipt: { id: receipt.subject.subjectId, digest: reviewDigest(receipt) },
    evidencePins: receipt.pins,
    policyPins: [{ id: 'sdlc-evidence-screening', version: '1.0.0', digest: policyDigest }],
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

export function evaluateSdlcScreeningPreregistration(
  preregistration: SdlcScreeningPreregistration,
  report: SdlcScreeningHeldoutReport | null,
): { decision: 'pass' | 'fail' | 'insufficient-evidence'; reasons: string[] } {
  if (preregistration.schemaVersion !== SDLC_SCREENING_PREREGISTRATION_VERSION || !preregistration.planId) {
    throw new SdlcScreeningValidationError('Invalid screening preregistration');
  }
  const frozenAt = Date.parse(preregistration.frozenAt);
  if (!Number.isFinite(frozenAt)) throw new SdlcScreeningValidationError('Invalid screening preregistration');
  for (const [label, value] of [
    ['maximumFalseSupportRateBps', preregistration.maximumFalseSupportRateBps],
    ['maximumFalseReadyRateBps', preregistration.maximumFalseReadyRateBps],
    ['confidence level', preregistration.confidenceInterval.levelBps],
    ['qualityNonInferiorityBps', preregistration.qualityNonInferiorityBps],
  ] as const) assertBps(value, label);
  if (preregistration.confidenceInterval.levelBps <= 0 || preregistration.confidenceInterval.levelBps >= 10_000) {
    throw new SdlcScreeningValidationError('Invalid confidence interval level');
  }
  if (!Number.isSafeInteger(preregistration.minimumTotalSupport) || preregistration.minimumTotalSupport < 1
    || !Number.isSafeInteger(preregistration.minimumGateBlockingSliceSupport)
    || preregistration.minimumGateBlockingSliceSupport < 1
    || (preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd !== null
      && (!Number.isFinite(preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd)
        || preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd < 0))) {
    throw new SdlcScreeningValidationError('Invalid screening preregistration minimums');
  }
  if (!report) return { decision: 'insufficient-evidence', reasons: ['heldout-report-missing'] };
  const reasons: string[] = [];
  if (report.evaluatedAt && Date.parse(report.evaluatedAt) <= frozenAt) reasons.push('heldout-not-after-preregistration');
  if (!heldoutReportFinite(report)) reasons.push('heldout-report-invalid');
  if (report.totalSupport < preregistration.minimumTotalSupport) reasons.push('minimum-total-support-missing');
  if (report.gateBlockingSliceSupport < preregistration.minimumGateBlockingSliceSupport) reasons.push('gate-blocking-slice-support-missing');
  for (const [label, metric] of Object.entries({ support: report.support, contradiction: report.contradiction, unclear: report.unclear })) {
    if (metric.n < preregistration.minimumGateBlockingSliceSupport) reasons.push(`class-support-missing:${label}`);
  }
  for (const [label, metric] of Object.entries(report.slices)) {
    if (metric.n < preregistration.minimumGateBlockingSliceSupport) reasons.push(`slice-support-missing:${label}`);
  }
  if (report.falseSupportRateBps === null || report.falseSupportRateBps > preregistration.maximumFalseSupportRateBps) reasons.push('false-support-bound-failed');
  if (report.falseReadyRateBps === null || report.falseReadyRateBps > preregistration.maximumFalseReadyRateBps) reasons.push('false-ready-bound-failed');
  for (const [label, metric] of Object.entries({ support: report.support, contradiction: report.contradiction, unclear: report.unclear })) {
    if (metric.precisionBps === null || metric.recallBps === null
      || metric.precisionBps < preregistration.qualityNonInferiorityBps
      || metric.recallBps < preregistration.qualityNonInferiorityBps) {
      reasons.push(`quality-non-inferiority-failed:${label}`);
    }
  }
  if (preregistration.efficiencyClaim.enabled && (report.positiveTotalEconomicsUsd === null || report.positiveTotalEconomicsUsd <= 0 ||
      (preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd !== null && report.positiveTotalEconomicsUsd < preregistration.efficiencyClaim.minimumPositiveTotalEconomicsUsd))) {
    reasons.push('positive-total-economics-missing');
  }
  return reasons.length ? { decision: reasons.some(reason => reason.includes('missing') || reason.includes('support'))
    ? 'insufficient-evidence' : 'fail', reasons } : { decision: 'pass', reasons: [] };
}

function heldoutReportFinite(report: SdlcScreeningHeldoutReport): boolean {
  const numbers: unknown[] = [
    report.falseSupportRateBps, report.falseReadyRateBps, report.reviewerAgreementRateBps,
    report.reviewerOverrideRateBps, report.gateBlockingSliceSupport, report.totalSupport,
    report.positiveTotalEconomicsUsd,
  ];
  const metrics: SdlcMetricBlock[] = [
    report.support, report.contradiction, report.unclear, report.calibrationRiskCoverage,
    report.latencyMs, report.tokens, report.costUsd, report.reviewLoad, ...Object.values(report.slices),
  ];
  for (const metric of metrics) numbers.push(metric.n, metric.value);
  for (const metric of [report.support, report.contradiction, report.unclear]) {
    numbers.push(metric.precisionBps, metric.recallBps);
  }
  return numbers.every(value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0));
}

function integrityFindings(integrity: QualificationIntegrityMetadata): string[] {
  const findings: string[] = [];
  if (integrity.integrity_state !== 'verified') findings.push('integrity-not-verified');
  if (integrity.integrity_mode === 'standard') findings.push('integrity-mode-standard');
  if (integrity.trusted_score_source === 'local-unverified') findings.push('untrusted-score-source');
  if (integrity.fresh_workspace_required && !integrity.fresh_workspace_verified) findings.push('fresh-workspace-unverified');
  if (integrity.uncertainty === null) findings.push('uncertainty-missing');
  if (integrity.paired_baseline === null) findings.push('paired-baseline-missing');
  if (integrity.weak_signal_reason !== null) findings.push('weak-signal');
  if (integrity.compromise_labels.length > 0) findings.push('compromised');
  if (integrity.sample_n <= 0) findings.push('insufficient-samples');
  if (integrity.release_gate.decision !== 'PROMOTE') findings.push(`upstream-integrity-${integrity.release_gate.decision.toLowerCase()}`);
  return findings;
}

export function buildSdlcScreeningReleaseReport(input: {
  preregistration: SdlcScreeningPreregistration;
  heldout: SdlcScreeningHeldoutReport | null;
  integrity: QualificationIntegrityMetadata;
}): SdlcScreeningReleaseReport {
  const preregistered = evaluateSdlcScreeningPreregistration(input.preregistration, input.heldout);
  const upstream = input.integrity.release_gate.decision;
  const integrity = integrityFindings(input.integrity);
  const reasons = uniqueStrings([...preregistered.reasons, ...integrity]);
  const decision: SdlcScreeningReleaseReport['decision'] = upstream === 'ROLLBACK'
    || input.integrity.integrity_state === 'compromised' || input.integrity.compromise_labels.length > 0 ? 'ROLLBACK'
    : upstream === 'PROMOTE' && preregistered.decision === 'pass' && integrity.length === 0 ? 'PROMOTE' : 'HOLD';
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
