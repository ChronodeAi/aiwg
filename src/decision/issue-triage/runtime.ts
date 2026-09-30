import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { redactText, type OrganizationRedactionPattern } from '../../governance/redaction.js';
import { canonicalJson } from '../../security/artifact-trust.js';
import { correlateAtomicBatch } from '../batch.js';
import { admitEntry } from '../entry.js';
import { projectDecisionState, type DecisionProjectionField, type DecisionProjectionPolicy } from '../projection.js';
import {
  evaluateBinaryHeldout,
  evaluateOrdinalHeldout,
  evaluateRankingHeldout,
  freezeQualificationSplit,
  pairedBinaryDifferenceInterval,
  pairedNonInferiority,
  verifyQualificationSplits,
  wilsonScoreInterval,
  type QualificationSplit,
} from '../qualification/quality.js';
import { artifactDigest } from '../validate.js';
import type {
  BinaryMetrics,
  IssueTriageBatchQuestion,
  IssueTriageCalibrationContext,
  IssueTriageCandidateInput,
  IssueTriageCandidateLineage,
  IssueTriageDuplicateCandidate,
  IssueTriageEvaluationInput,
  IssueTriageEvaluationManifest,
  IssueTriageEvaluationReport,
  IssueTriageEvaluationSample,
  IssueTriageGateDecision,
  IssueTriageIssueRecord,
  IssueTriageModelResponse,
  IssueTriageModelState,
  IssueTriageNonInferiority,
  IssueTriagePilotPack,
  IssueTriageProjection,
  IssueTriageShadowArtifact,
  IssueTriageSliceMetrics,
  IssueTriageUsageReceipt,
  IssueTriageValidatedResponse,
  MulticlassMetrics,
  PrecisionRecallF1,
} from './types.js';

type SchemaKind = 'pilotPack' | 'manifest' | 'report';

export class IssueTriagePilotError extends Error {
  constructor(message: string, readonly layer: 'admission' | 'schema' | 'semantic' = 'semantic', readonly details: readonly string[] = []) {
    super(message);
    this.name = 'IssueTriagePilotError';
  }
}

const SCHEMA_FILES: Record<SchemaKind, string> = {
  pilotPack: 'DecisionIssueTriagePilotPack.v1.schema.json',
  manifest: 'DecisionIssueTriageEvaluationManifest.v1.schema.json',
  report: 'DecisionIssueTriageEvaluationReport.v1.schema.json',
};

const GATE_RANK: Record<IssueTriageGateDecision, number> = { PROMOTE: 0, HOLD: 1, ROLLBACK: 2 };
const FINAL_FIELDS = ['finalLabels', 'finalDuplicateOf', 'resolution', 'closedAt'] as const;
const RESPONSE_FIELDS = ['issueId', 'issueType', 'area', 'urgency', 'completeness', 'clarificationNeed', 'duplicate',
  'uncertaintyProfile', 'accepted', 'actualModel', 'requestedModel', 'latencyMs', 'usage', 'usageReceipts', 'calls', 'retries', 'fallbacks',
  'cacheHit'] as const;
const DUPLICATE_RESPONSE_FIELDS = ['issueId', 'rank'] as const;
const METADATA_ALLOWLIST = ['component', 'provider', 'framework', 'source', 'environment', 'reproduction'] as const;
const CANDIDATE_FIELDS = ['id', 'repository', 'createdAt', 'revisions'] as const;
const REVISION_FIELDS = ['observedAt', 'title', 'body'] as const;
const RECEIPT_FIELDS = ['kind', 'requestId', 'inputTokens', 'outputTokens', 'costUsd'] as const;
// Formats the shared governance redactor does not cover on its own.
const ISSUE_TRIAGE_REDACTION_PATTERNS: readonly OrganizationRedactionPattern[] = [
  { id: 'jwt', pattern: '\\beyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}' },
  { id: 'aws-access-key', pattern: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b' },
];

let validators: Map<SchemaKind, ValidateFunction> | null = null;

function schemaRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')];
  const found = candidates.find(candidate => existsSync(resolve(candidate, SCHEMA_FILES.pilotPack)));
  if (!found) throw new IssueTriagePilotError('Issue triage schema directory is unavailable');
  return found;
}

function schemaValidator(kind: SchemaKind): ValidateFunction {
  if (!validators) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    addFormats(ajv);
    validators = new Map((Object.keys(SCHEMA_FILES) as SchemaKind[]).map(name => [
      name,
      ajv.compile(JSON.parse(readFileSync(resolve(schemaRoot(), SCHEMA_FILES[name]), 'utf8')) as object),
    ]));
  }
  return validators.get(kind)!;
}

function checkSchema(kind: SchemaKind, value: unknown): void {
  try {
    admitEntry(value);
  } catch {
    throw new IssueTriagePilotError(`${kind} admission denied`, 'admission');
  }
  const check = schemaValidator(kind);
  if (!check(value)) {
    const details = (check.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`);
    throw new IssueTriagePilotError(`${kind} does not match its v1 schema: ${details[0] ?? 'invalid'}`, 'schema', details);
  }
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function semantic(problems: string[], message: string): void {
  if (problems.length) throw new IssueTriagePilotError(`${message}: ${problems[0]}`, 'semantic', problems);
}

export function validateIssueTriagePilotPack(value: unknown): IssueTriagePilotPack {
  checkSchema('pilotPack', value);
  const pack = value as IssueTriagePilotPack;
  const problems: string[] = [];
  const ordinals = new Set<number>();
  const urgencyIds = new Set<string>();
  for (const level of pack.urgencyRubric) {
    if (ordinals.has(level.ordinal)) problems.push(`urgency ordinal ${level.ordinal} is duplicated`);
    if (urgencyIds.has(level.id)) problems.push(`urgency id ${level.id} is duplicated`);
    ordinals.add(level.ordinal);
    urgencyIds.add(level.id);
  }
  for (let index = 0; index < pack.urgencyRubric.length; index++) {
    if (!ordinals.has(index)) problems.push('urgency ordinals must be contiguous from zero');
  }
  if (!pack.taxonomies.stateCompleteness.includes('complete')
    || !pack.taxonomies.stateCompleteness.includes('partial')
    || !pack.taxonomies.stateCompleteness.includes('missing')) problems.push('state completeness taxonomy is incomplete');
  if (!pack.taxonomies.clarificationNeed.includes('needed')
    || !pack.taxonomies.clarificationNeed.includes('not-needed')) problems.push('clarification taxonomy is incomplete');
  semantic(problems, 'issue triage pilot pack rejected');
  return pack;
}

export function validateIssueTriageEvaluationManifest(value: unknown): IssueTriageEvaluationManifest {
  checkSchema('manifest', value);
  const manifest = value as IssueTriageEvaluationManifest;
  const problems: string[] = [];
  for (const dimension of ['issue-type', 'area', 'state-completeness', 'adversarial-authority', 'new-or-unseen-category'] as const) {
    if (!manifest.slices.some(slice => slice.dimension === dimension)) problems.push(`slice dimension ${dimension} is not preregistered`);
  }
  if (manifest.thresholds.minimumTotalSamples < manifest.dataset.minimumTotal) problems.push('threshold minimum total is below dataset minimum');
  if (manifest.thresholds.minimumPerSliceSamples < manifest.dataset.minimumPerSupportedSlice) problems.push('threshold per-slice minimum is below dataset minimum');
  const marginBps = manifest.thresholds.qualityNonInferiorityMargin * 10000;
  if (manifest.thresholds.qualityNonInferiorityMargin > 0) {
    problems.push('thresholds.qualityNonInferiorityMargin must be <= 0; a positive margin is a superiority test, which is not supported');
  } else if (Math.abs(marginBps - Math.round(marginBps)) > 1e-6) {
    problems.push('thresholds.qualityNonInferiorityMargin must be a whole number of basis points');
  }
  const sliceIds = new Set<string>();
  for (const slice of manifest.slices) {
    if (sliceIds.has(slice.id)) problems.push(`slice id ${slice.id} is duplicated`);
    sliceIds.add(slice.id);
  }
  const splitDigests = Object.values(manifest.dataset.splitDigests);
  if (new Set(splitDigests).size !== splitDigests.length) problems.push('split digests must be distinct');
  if (manifest.holdout.holdoutAccessedAt !== null
    && Date.parse(manifest.holdout.holdoutAccessedAt) <= Date.parse(manifest.holdout.thresholdsRegisteredAt)) {
    problems.push('thresholds must be preregistered before holdout access');
  }
  semantic(problems, 'issue triage evaluation manifest rejected');
  return manifest;
}

function checkIssueTriageEvaluationReportShape(value: unknown): IssueTriageEvaluationReport {
  checkSchema('report', value);
  const report = value as IssueTriageEvaluationReport;
  const problems: string[] = [];
  if (GATE_RANK[report.decision] < GATE_RANK[report.integrity.upstreamDecision]) {
    problems.push(`issue triage report cannot upgrade ${report.integrity.upstreamDecision} to ${report.decision}`);
  }
  if (report.decision === 'PROMOTE' && report.integrity.findings.length > 0) problems.push('PROMOTE requires no findings');
  if (report.decision === 'PROMOTE' && report.baselineComparison.qualityNonInferiority?.decision !== 'non-inferior') {
    problems.push('PROMOTE requires a non-inferior paired quality interval');
  }
  semantic(problems, 'issue triage evaluation report rejected');
  return report;
}

/**
 * A report is accepted only if it is exactly what this module rebuilds from the same inputs, and only if
 * those inputs use the manifest whose digest was preregistered out of band. A spread-copied or edited
 * report, or one built from a relaxed manifest, is rejected.
 */
export function validateIssueTriageEvaluationReport(value: unknown, binding: {
  inputs: IssueTriageEvaluationInput;
  trustedManifestDigest: `sha256:${string}`;
}): IssueTriageEvaluationReport {
  const report = checkIssueTriageEvaluationReportShape(value);
  if (!binding || digest(binding.inputs.manifest) !== binding.trustedManifestDigest
    || report.manifest.digest !== binding.trustedManifestDigest) {
    throw new IssueTriagePilotError('issue triage report manifest does not match the trusted manifest digest');
  }
  verifyPilotPackPin(validateIssueTriagePilotPack(binding.inputs.pack), validateIssueTriageEvaluationManifest(binding.inputs.manifest));
  if (canonicalJson(report.pilotPack) !== canonicalJson(binding.inputs.manifest.pilotPack)) {
    throw new IssueTriagePilotError('issue triage pilot pack does not match the manifest pin');
  }
  const rebuilt = buildIssueTriageEvaluationReport(binding.inputs);
  if (canonicalJson(rebuilt) !== canonicalJson(report)) {
    throw new IssueTriagePilotError('issue triage report does not match a rebuild from its inputs');
  }
  return report;
}

export function defaultIssueTriagePilotPack(): IssueTriagePilotPack {
  return validateIssueTriagePilotPack({
    schemaVersion: 'decision-issue-triage-pilot-pack/v1',
    id: 'aiwg-issue-triage-jev-shadow',
    version: '2026.9.29',
    mode: 'disabled',
    taxonomies: {
      issueTypes: ['bug', 'feature', 'documentation', 'operations', 'security', 'question', 'other'],
      areas: ['decision-engine', 'composition-engine', 'aiwg-cli', 'provider-adapters', 'docs', 'release', 'unknown'],
      stateCompleteness: ['complete', 'partial', 'missing'],
      clarificationNeed: ['needed', 'not-needed'],
    },
    urgencyRubric: [
      { id: 'low', ordinal: 0, description: 'Cosmetic, documentation-only, or low operational impact.' },
      { id: 'normal', ordinal: 1, description: 'User-visible issue with workaround or bounded impact.' },
      { id: 'high', ordinal: 2, description: 'Important workflow failure, no easy workaround, or time-sensitive release risk.' },
      { id: 'critical', ordinal: 3, description: 'Security, data loss, production outage, or release-blocking failure.' },
    ],
    candidatePolicy: { generator: 'deterministic-token-overlap-v1', maxCandidates: 5, includeNone: true },
    acceptance: {
      uncertaintyProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'],
      calibration: 'advisory',
      acceptedScoring: 'disabled-on-incompatibility',
    },
    trackerMutationPolicy: {
      create: 'forbidden',
      edit: 'forbidden',
      label: 'forbidden',
      assign: 'forbidden',
      comment: 'forbidden',
      close: 'forbidden',
      merge: 'forbidden',
    },
    rollback: { disableRestoresPriorWorkflow: true, preserveReceiptsAndLabels: true },
  });
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]+/g)?.filter(token => token.length > 2) ?? []);
}

function issueText(issue: { title: string; body: string }): string {
  return `${issue.title}\n${issue.body}`;
}

/**
 * The candidate revision visible as of `asOf`: the latest revision observed at or before it. Candidates without
 * such a revision are excluded, so a later title, label or state edit can never reach the replayed issue.
 */
function candidateAsOf(candidate: IssueTriageCandidateInput, asOf: number): { title: string; body: string } | null {
  for (const key of Object.keys(candidate)) {
    if (!(CANDIDATE_FIELDS as readonly string[]).includes(key)) {
      throw new IssueTriagePilotError(`candidate ${candidate.id} carries mutable current-state field ${key}; supply point-in-time revisions`);
    }
  }
  if (!Array.isArray(candidate.revisions)) throw new IssueTriagePilotError(`candidate ${candidate.id} requires point-in-time revisions`);
  let visible: { at: number; title: string; body: string } | null = null;
  for (const revision of candidate.revisions) {
    if (Object.keys(revision).some(key => !(REVISION_FIELDS as readonly string[]).includes(key))
      || typeof revision.title !== 'string' || typeof revision.body !== 'string') {
      throw new IssueTriagePilotError(`candidate ${candidate.id} revision must contain only observedAt, title and body`);
    }
    const at = Date.parse(revision.observedAt);
    if (!Number.isFinite(at)) throw new IssueTriagePilotError(`candidate ${candidate.id} revision has an invalid observedAt`);
    if (at <= asOf && (visible === null || at >= visible.at)) visible = { at, title: revision.title, body: revision.body };
  }
  return visible && { title: visible.title, body: visible.body };
}

export function deterministicIssueDuplicateCandidates(
  issue: IssueTriageIssueRecord,
  corpus: readonly IssueTriageCandidateInput[],
  pack: IssueTriagePilotPack = defaultIssueTriagePilotPack(),
): IssueTriageCandidateLineage {
  const query = tokens(issueText(issue));
  const issueCreatedAt = Date.parse(issue.createdAt);
  if (!Number.isFinite(issueCreatedAt)) throw new IssueTriagePilotError('triaged issue createdAt is invalid');
  const scored = corpus
    .filter(candidate => candidate.id !== issue.id && candidate.repository === issue.repository
      && Date.parse(candidate.createdAt) <= issueCreatedAt)
    .flatMap(candidate => {
      const snapshot = candidateAsOf(candidate, issueCreatedAt);
      if (!snapshot) return [];
      const candidateTokens = tokens(issueText(snapshot));
      const overlap = [...query].filter(token => candidateTokens.has(token)).length;
      const union = new Set([...query, ...candidateTokens]).size || 1;
      return [{
        issueId: candidate.id,
        repository: candidate.repository,
        title: redactCredentialMaterial(snapshot.title),
        rank: 0,
        score: overlap / union,
        sourceDigest: digest({ id: candidate.id, repository: candidate.repository, createdAt: candidate.createdAt, ...snapshot }),
      }];
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.issueId.localeCompare(right.issueId))
    .slice(0, pack.candidatePolicy.maxCandidates)
    .map((candidate, index): IssueTriageDuplicateCandidate => ({ ...candidate, rank: index + 1 }));
  return { generator: 'deterministic-token-overlap-v1', queryDigest: digest({ id: issue.id, text: issueText(issue) }), candidates: scored, noneOutcome: 'none' };
}

/** Shared governance redactor plus JWT and AWS STS key formats; fails closed on oversized input. */
function redactCredentialMaterial(value: string): string {
  return redactText(value, { organizationPatterns: ISSUE_TRIAGE_REDACTION_PATTERNS, includeLength: false }).text;
}

function allowedMetadata(metadata: IssueTriageIssueRecord['metadata']): IssueTriageModelState['issue']['metadata'] | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata)
    .filter(([key]) => (METADATA_ALLOWLIST as readonly string[]).includes(key))
    .map(([key, value]) => {
      // Structured values could smuggle unredacted text; only scalars are model-visible.
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new IssueTriagePilotError(`metadata ${key} must be a string, number, boolean or null`);
      }
      return [key, typeof value === 'string' ? redactCredentialMaterial(value) : value] as const;
    });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function projectionField(field: Pick<DecisionProjectionField, 'pointer' | 'output' | 'trust' | 'sensitivity'>, subject: string): DecisionProjectionField {
  return {
    ...field,
    source: 'issue-triage-shadow',
    subject,
    purpose: 'issue-triage',
    retentionClass: 'decision-shadow-evaluation',
    accessScopes: ['decision:evaluate'],
    exportPolicy: 'sanitized',
    deletionPolicy: 'erase',
    backupPolicy: 'not-persisted',
    allowedProviders: ['jev'],
    allowedModels: ['jev-shadow'],
    allowedOrigins: ['https://typesafe.ai'],
    allowedRegions: ['us'],
  };
}

export async function projectIssueTriageModelState(
  packInput: IssueTriagePilotPack,
  issue: IssueTriageIssueRecord,
  lineage: IssueTriageCandidateLineage,
): Promise<IssueTriageProjection> {
  const pack = validateIssueTriagePilotPack(packInput);
  const excludedReplayFields = Object.fromEntries(FINAL_FIELDS.map(field => [field, issue[field] !== undefined])) as IssueTriageProjection['excludedReplayFields'];
  const metadata = allowedMetadata(issue.metadata);
  const input = {
    issue: {
      id: issue.id,
      repository: issue.repository,
      title: redactCredentialMaterial(issue.title),
      body: redactCredentialMaterial(issue.body),
      createdAt: issue.createdAt,
      ...(issue.author === undefined ? {} : { author: redactCredentialMaterial(issue.author) }),
      ...(metadata === undefined ? {} : { metadata }),
    },
    duplicateCandidates: lineage.candidates.map(item => ({ ...item, title: redactCredentialMaterial(item.title) })),
    allowed: {
      issueTypes: pack.taxonomies.issueTypes,
      areas: pack.taxonomies.areas,
      urgency: [...pack.urgencyRubric].sort((left, right) => left.ordinal - right.ordinal).map(level => level.id),
      stateCompleteness: pack.taxonomies.stateCompleteness,
      clarificationNeed: pack.taxonomies.clarificationNeed,
      duplicateOutcomes: [...lineage.candidates.map(candidate => candidate.issueId), 'none'],
    },
  };
  const policy: DecisionProjectionPolicy = {
    version: 'issue-triage-shadow-d10/v1',
    provider: 'jev',
    model: 'jev-shadow',
    origin: 'https://typesafe.ai',
    region: 'us',
    purpose: 'issue-triage',
    allowIncompleteContext: false,
    maxSensitivity: 'confidential',
    fields: [
      projectionField({ pointer: '/issue', output: 'issue', trust: 'untrusted', sensitivity: 'confidential' }, issue.id),
      projectionField({ pointer: '/duplicateCandidates', output: 'duplicateCandidates', trust: 'verified', sensitivity: 'internal' }, issue.id),
      projectionField({ pointer: '/allowed', output: 'allowed', trust: 'verified', sensitivity: 'internal' }, issue.id),
    ],
  };
  const projected = await projectDecisionState(input, policy);
  return { modelState: projected.state as unknown as IssueTriageModelState, lineage, excludedReplayFields,
    projectionEvidence: projected.evidence, stateDigest: projected.evidence.projectedDigest };
}

export function validateIssueTriageBatchSubject(questions: readonly IssueTriageBatchQuestion[]): string {
  if (!questions.length) throw new IssueTriagePilotError('issue triage batch requires at least one question');
  const issueIds = new Set(questions.map(question => question.issueId));
  if (issueIds.size !== 1) throw new IssueTriagePilotError('issue triage batch cannot contain more than one issue subject');
  const ids = new Set<string>();
  for (const question of questions) {
    if (!question.questionId.trim()) throw new IssueTriagePilotError('issue triage question id is empty');
    if (ids.has(question.questionId)) throw new IssueTriagePilotError('issue triage question id is duplicated');
    ids.add(question.questionId);
  }
  correlateAtomicBatch([...ids], questions.map(question => ({ questionId: question.questionId, value: question.alias })));
  return questions[0]!.issueId;
}

/** Structural, taxonomy and lineage problems of one response for one subject; usage reconciliation is separate. */
function responseProblems(pack: IssueTriagePilotPack, subjectId: string, lineage: IssueTriageCandidateLineage,
  response: IssueTriageModelResponse): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(response as unknown as Record<string, unknown>)) {
    if (!(RESPONSE_FIELDS as readonly string[]).includes(key)) problems.push(`model response contains unauthorized field ${key}`);
  }
  for (const key of Object.keys(response.duplicate as unknown as Record<string, unknown>)) {
    if (!(DUPLICATE_RESPONSE_FIELDS as readonly string[]).includes(key)) problems.push(`duplicate response contains unauthorized field ${key}`);
  }
  if (response.issueId !== subjectId) problems.push('response issue id does not match the projected subject');
  if (!pack.taxonomies.issueTypes.includes(response.issueType)) problems.push(`issue type ${response.issueType} is not in the governed taxonomy`);
  if (!pack.taxonomies.areas.includes(response.area)) problems.push(`area ${response.area} is not in the governed taxonomy`);
  if (!pack.urgencyRubric.some(level => level.id === response.urgency)) problems.push(`urgency ${response.urgency} is not in the governed rubric`);
  if (!pack.taxonomies.stateCompleteness.includes(response.completeness)) problems.push(`completeness ${response.completeness} is not in the governed taxonomy`);
  if (!pack.taxonomies.clarificationNeed.includes(response.clarificationNeed)) problems.push(`clarification ${response.clarificationNeed} is not in the governed taxonomy`);
  if (response.duplicate.issueId !== 'none' && !lineage.candidates.some(candidate => candidate.issueId === response.duplicate.issueId)) {
    problems.push(`duplicate candidate ${response.duplicate.issueId} was not deterministically generated`);
  }
  const deterministicRank = response.duplicate.issueId === 'none'
    ? null
    : lineage.candidates.find(candidate => candidate.issueId === response.duplicate.issueId)?.rank ?? null;
  if (response.duplicate.issueId === 'none' && response.duplicate.rank !== null) problems.push('none duplicate outcome must not carry a rank');
  if (response.duplicate.issueId !== 'none' && response.duplicate.rank !== deterministicRank) {
    problems.push(`duplicate rank for ${response.duplicate.issueId} does not match deterministic rank ${deterministicRank}`);
  }
  if (typeof response.accepted !== 'boolean') problems.push('accepted must be a boolean');
  if (!Number.isFinite(response.latencyMs) || response.latencyMs < 0) problems.push('latency must be finite and nonnegative');
  if ([response.calls.jev, response.calls.fallbackModel, response.retries, response.fallbacks].some(value => !Number.isSafeInteger(value) || value < 0)) {
    problems.push('call, retry and fallback counts must be nonnegative integers');
  }
  return problems;
}

/**
 * The single acceptance rule for shadow scoring. Compatibility comes only from resolving the registry
 * request; with calibration: required, no registry resolution means no accepted scoring.
 */
function acceptanceFor(pack: IssueTriagePilotPack, response: IssueTriageModelResponse,
  calibration: IssueTriageCalibrationContext): IssueTriageValidatedResponse['acceptance'] {
  const compatibility = calibration.registry
    ? calibration.registry.registry.resolve(calibration.registry.request, calibration.registry.policy)
    : null;
  const profileCompatible = pack.acceptance.uncertaintyProfiles.includes(calibration.uncertaintyProfile)
    && calibration.uncertaintyProfile === response.uncertaintyProfile;
  const aliasCompatible = calibration.requestedModel === response.requestedModel
    && calibration.actualModel === response.actualModel
    && calibration.compatibleActualModels.includes(response.actualModel);
  // The registry pin must describe this response's alias and served model; drift or an unknown identity is not "allow".
  const registryDrift = compatibility !== null && (compatibility.requestedAlias !== response.requestedModel
    || compatibility.actualModel !== response.actualModel || compatibility.reasons.includes('alias-drift') || compatibility.state === 'unknown');
  const registryCompatible = compatibility === null
    ? pack.acceptance.calibration !== 'required'
    : compatibility.action === 'allow' && !registryDrift;
  const modelCompatible = aliasCompatible && !registryDrift;
  const acceptedScoring = response.accepted === true && profileCompatible && modelCompatible && registryCompatible;
  const reason = acceptedScoring ? 'compatible' : response.accepted !== true ? 'defer-response-rejected'
    : modelCompatible ? 'defer-calibration-incompatible' : 'defer-drift';
  const driftEvent = modelCompatible ? null : `model-drift:${response.requestedModel}->${response.actualModel}`;
  return { acceptedScoring, reason, driftEvent, compatibility };
}

export function validateIssueTriageModelResponse(
  packInput: IssueTriagePilotPack,
  projection: IssueTriageProjection,
  response: IssueTriageModelResponse,
  calibration: IssueTriageCalibrationContext,
): IssueTriageValidatedResponse {
  const pack = validateIssueTriagePilotPack(packInput);
  const problems = [
    ...responseProblems(pack, projection.modelState.issue.id, projection.lineage, response),
    ...usageReconciliationProblems(response),
  ];
  semantic(problems, 'issue triage model response rejected');
  return { ...response, acceptance: acceptanceFor(pack, response, calibration) };
}

/**
 * Caller totals are derived values; the provider-reported receipts are authoritative. Totals, per-kind call
 * counts and the cache flag must all agree with the receipts, and a null receipt value makes the total null.
 */
function usageReconciliationProblems(response: IssueTriageModelResponse): string[] {
  const problems: string[] = [];
  const receipts = response.usageReceipts;
  if (!Array.isArray(receipts)) return ['usage receipts are required'];
  const ids = new Set<string>();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object' || Object.keys(receipt).some(key => !(RECEIPT_FIELDS as readonly string[]).includes(key))
      || !['jev', 'fallback-model', 'cache'].includes(receipt.kind) || typeof receipt.requestId !== 'string' || !receipt.requestId.trim()
      || [receipt.inputTokens, receipt.outputTokens].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))
      || (receipt.costUsd !== null && (!Number.isFinite(receipt.costUsd) || receipt.costUsd < 0))) {
      problems.push('usage receipt is malformed');
      continue;
    }
    if (ids.has(receipt.requestId)) problems.push(`usage receipt ${receipt.requestId} is duplicated`);
    ids.add(receipt.requestId);
  }
  if (problems.length) return problems;
  const count = (kind: IssueTriageUsageReceipt['kind']) => receipts.filter(receipt => receipt.kind === kind).length;
  if (count('jev') !== response.calls.jev) problems.push('Jev call count does not match provider receipts');
  if (count('fallback-model') !== response.calls.fallbackModel) problems.push('fallback call count does not match provider receipts');
  if ((count('cache') > 0) !== response.cacheHit) problems.push('cache flag does not match cache receipts');
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    const total = receiptTotal(receipts, key);
    const claimed = response.usage[key];
    if (total === null ? claimed !== null : claimed === null || Math.abs(claimed - total) > 1e-9) {
      problems.push(`usage ${key} does not match provider receipts`);
    }
  }
  return problems;
}

function receiptTotal(receipts: readonly IssueTriageUsageReceipt[], key: 'inputTokens' | 'outputTokens' | 'costUsd'): number | null {
  if (receipts.some(receipt => receipt[key] === null)) return null;
  return receipts.reduce((sum, receipt) => sum + (receipt[key] as number), 0);
}

export async function runIssueTriageShadow(
  pack: IssueTriagePilotPack,
  issue: IssueTriageIssueRecord,
  corpus: readonly IssueTriageCandidateInput[],
  response: IssueTriageModelResponse,
  calibration: IssueTriageCalibrationContext,
): Promise<IssueTriageShadowArtifact> {
  const active = validateIssueTriagePilotPack(pack);
  if (active.mode !== 'offline-shadow') throw new IssueTriagePilotError('issue triage shadow run requires offline-shadow mode');
  const lineage = deterministicIssueDuplicateCandidates(issue, corpus, active);
  const projection = await projectIssueTriageModelState(active, issue, lineage);
  const validated = validateIssueTriageModelResponse(active, projection, response, calibration);
  return {
    schemaVersion: 'decision-issue-triage-shadow-artifact/v1',
    mode: 'offline-shadow',
    subject: { issueId: issue.id, stateDigest: projection.stateDigest },
    lineage,
    response: validated,
    actionAuthorization: 'not-authorized',
    trackerMutations: 0,
  };
}

export interface IssueTriageShadowFailureArtifact {
  schemaVersion: 'decision-issue-triage-shadow-failure/v1';
  mode: 'offline-shadow';
  actionAuthorization: 'not-authorized';
  trackerMutations: 0;
  error: { name: string; message: string };
}

function failureArtifact(error: unknown): IssueTriageShadowFailureArtifact {
  return {
    schemaVersion: 'decision-issue-triage-shadow-failure/v1',
    mode: 'offline-shadow',
    actionAuthorization: 'not-authorized',
    trackerMutations: 0,
    error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
  };
}

type IssueTriageArtifactRecorder = (artifact: IssueTriageShadowArtifact | IssueTriageShadowFailureArtifact) => void | Promise<void>;

/**
 * Records without ever throwing or leaving a rejected promise. A recorder failure on a success artifact is
 * retried once as a failure artifact; a failing failure record is dropped, because the shadow path must not
 * change the host workflow.
 */
function containedRecord(record: IssueTriageArtifactRecorder, artifact: IssueTriageShadowArtifact | IssueTriageShadowFailureArtifact,
  retry: boolean): void {
  const onError = (error: unknown) => { if (retry) containedRecord(record, failureArtifact(error), false); };
  try {
    const pending = record(artifact);
    if (pending && typeof (pending as Promise<void>).then === 'function') (pending as Promise<void>).then(undefined, onError);
  } catch (error) {
    onError(error);
  }
}

export function applyIssueTriagePilot<T>(
  enabled: boolean,
  previousWorkflowResult: T,
  shadow: () => IssueTriageShadowArtifact | Promise<IssueTriageShadowArtifact>,
  recordArtifact: IssueTriageArtifactRecorder = () => {},
): T {
  if (!enabled) return previousWorkflowResult;
  try {
    const artifact = shadow();
    if (artifact && typeof (artifact as Promise<IssueTriageShadowArtifact>).then === 'function') {
      (artifact as Promise<IssueTriageShadowArtifact>).then(
        resolved => containedRecord(recordArtifact, resolved, true),
        error => containedRecord(recordArtifact, failureArtifact(error), false),
      ).then(undefined, () => {});
    } else {
      containedRecord(recordArtifact, artifact as IssueTriageShadowArtifact, true);
    }
  } catch (error) {
    containedRecord(recordArtifact, failureArtifact(error), false);
  }
  return previousWorkflowResult;
}

/** A sample whose cascade acceptance was recomputed by this module. */
type ScoredSample = Omit<IssueTriageEvaluationSample, 'cascade'> & { cascade: IssueTriageValidatedResponse };

function prf(tp: number, fp: number, fn: number): PrecisionRecallF1 {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) };
}

function multiclass(samples: readonly ScoredSample[], key: 'issueType' | 'area', pack: IssueTriagePilotPack): MulticlassMetrics {
  const classes = key === 'issueType' ? pack.taxonomies.issueTypes : pack.taxonomies.areas;
  const perClass = Object.fromEntries(classes.map(label => {
    const tp = samples.filter(sample => sample.label[key] === label && sample.cascade[key] === label).length;
    const fp = samples.filter(sample => sample.label[key] !== label && sample.cascade[key] === label).length;
    const fn = samples.filter(sample => sample.label[key] === label && sample.cascade[key] !== label).length;
    return [label, prf(tp, fp, fn)];
  }));
  const macro = {
    precision: classes.reduce((sum, label) => sum + perClass[label]!.precision, 0) / classes.length,
    recall: classes.reduce((sum, label) => sum + perClass[label]!.recall, 0) / classes.length,
    f1: classes.reduce((sum, label) => sum + perClass[label]!.f1, 0) / classes.length,
  };
  return { sampleN: samples.length, macro, perClass };
}

function binary(samples: readonly ScoredSample[], predicted: (sample: ScoredSample) => boolean,
  actual: (sample: ScoredSample) => boolean): BinaryMetrics {
  const tp = samples.filter(sample => predicted(sample) && actual(sample)).length;
  const fp = samples.filter(sample => predicted(sample) && !actual(sample)).length;
  const fn = samples.filter(sample => !predicted(sample) && actual(sample)).length;
  return { sampleN: samples.length, ...prf(tp, fp, fn) };
}

function rate(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0;
}

function correct(sample: ScoredSample, which: 'baseline' | 'cascade'): boolean {
  const observed = sample[which];
  return observed.issueType === sample.label.issueType
    && observed.area === sample.label.area
    && observed.urgency === sample.label.urgency
    && observed.completeness === sample.label.completeness
    && observed.clarificationNeed === sample.label.clarificationNeed
    && observed.duplicate.issueId === sample.label.duplicateOf;
}

function gateDecision(upstream: IssueTriageGateDecision, findings: readonly string[]): IssueTriageGateDecision {
  if (upstream === 'ROLLBACK') return 'ROLLBACK';
  if (upstream === 'HOLD' || findings.length > 0) return 'HOLD';
  return 'PROMOTE';
}

/** Supported interval level in bps, or null. The paired helpers accept integer levels strictly in (5000, 9999). */
function levelInBps(confidenceInterval: IssueTriageEvaluationManifest['thresholds']['confidenceInterval']): number | null {
  if (confidenceInterval.method !== 'wilson') return null;
  const scaled = confidenceInterval.level * 10000;
  const levelBps = Math.round(scaled);
  return Math.abs(scaled - levelBps) < 1e-6 && levelBps > 5000 && levelBps < 9999 ? levelBps : null;
}

/**
 * The evaluated samples must be exactly the test split of splits frozen before scoring, and those splits must be
 * the ones whose digests the manifest preregistered.
 */
function verifiedSplits(manifest: IssueTriageEvaluationManifest, splits: readonly QualificationSplit[],
  samples: readonly IssueTriageEvaluationSample[]): QualificationSplit[] {
  verifyQualificationSplits(splits);
  const byName = new Map(splits.map(split => [split.name, split]));
  const pinned = manifest.dataset.splitDigests;
  if (byName.get('tuning')!.digest !== pinned.tuning || byName.get('calibration')!.digest !== pinned.calibration
    || byName.get('test')!.digest !== pinned.test) {
    throw new IssueTriagePilotError('evaluation split digests do not match the preregistered manifest');
  }
  const test = byName.get('test')!;
  const ids = samples.map(sample => sample.id);
  if (ids.length !== test.ids.length || new Set(ids).size !== ids.length || ids.some(id => !test.ids.includes(id))) {
    throw new IssueTriagePilotError('evaluation samples do not match the frozen test split membership');
  }
  return [byName.get('tuning')!, byName.get('calibration')!, test];
}

/** Scores a subset of the already-verified test split with the same frozen tuning/calibration splits. */
function subsetSplits(splits: readonly QualificationSplit[], ids: readonly string[]): QualificationSplit[] {
  return [splits[0]!, splits[1]!, freezeQualificationSplit('test', ids)];
}

/** Re-derives the deterministic ordering and checks the cascade's duplicate answer against it. */
function verifySampleLineage(sample: IssueTriageEvaluationSample, pack: IssueTriagePilotPack): void {
  const lineage = sample.lineage;
  const where = `sample ${sample.id}`;
  if (!lineage || lineage.generator !== pack.candidatePolicy.generator || lineage.noneOutcome !== 'none' || !Array.isArray(lineage.candidates)) {
    throw new IssueTriagePilotError(`${where} lineage is missing or was not produced by the pinned generator`);
  }
  const candidates = lineage.candidates;
  if (candidates.length > pack.candidatePolicy.maxCandidates || new Set(candidates.map(item => item.issueId)).size !== candidates.length
    || candidates.some(item => item.issueId === 'none')) {
    throw new IssueTriagePilotError(`${where} lineage exceeds the candidate policy or repeats an ID`);
  }
  for (let index = 0; index < candidates.length; index++) {
    const current = candidates[index]!;
    const previous = candidates[index - 1];
    if (current.rank !== index + 1 || !Number.isFinite(current.score) || current.score <= 0 || current.score > 1
      || (previous && (previous.score < current.score || (previous.score === current.score && previous.issueId.localeCompare(current.issueId) > 0)))) {
      throw new IssueTriagePilotError(`${where} lineage is not deterministically ordered`);
    }
  }
  const answer = sample.cascade.duplicate;
  if (answer.issueId === 'none') {
    if (answer.rank !== null) throw new IssueTriagePilotError(`${where} none duplicate outcome must not carry a rank`);
    return;
  }
  const listed = candidates.find(item => item.issueId === answer.issueId);
  if (!listed) throw new IssueTriagePilotError(`${where} duplicate ${answer.issueId} is not in the deterministic lineage`);
  if (listed.rank !== answer.rank) {
    throw new IssueTriagePilotError(`${where} duplicate rank for ${answer.issueId} does not match deterministic rank ${listed.rank}`);
  }
}

function armUsage(samples: readonly ScoredSample[], which: 'baseline' | 'cascade', key: 'inputTokens' | 'outputTokens' | 'costUsd'): number | null {
  const totals = samples.map(sample => receiptTotal(sample[which].usageReceipts, key));
  if (totals.some(total => total === null)) return null;
  return (totals as number[]).reduce((sum, value) => sum + value, 0);
}

function sliceMetrics(samples: readonly ScoredSample[]): IssueTriageSliceMetrics {
  const accepted = samples.filter(sample => sample.cascade.acceptance.acceptedScoring);
  const noneCases = samples.filter(sample => sample.label.duplicateOf === 'none');
  const duplicateCases = samples.filter(sample => sample.label.duplicateOf !== 'none');
  return {
    cascadeQuality: rate(samples.filter(sample => correct(sample, 'cascade')).length, samples.length),
    baselineQuality: rate(samples.filter(sample => correct(sample, 'baseline')).length, samples.length),
    acceptedCoverage: rate(accepted.length, samples.length),
    falseAutoRate: accepted.length ? accepted.filter(sample => !correct(sample, 'cascade')).length / accepted.length : null,
    falseDuplicateRate: noneCases.length ? noneCases.filter(sample => sample.cascade.duplicate.issueId !== 'none').length / noneCases.length : null,
    duplicateRecall: duplicateCases.length
      ? duplicateCases.filter(sample => sample.cascade.duplicate.issueId === sample.label.duplicateOf).length / duplicateCases.length : null,
  };
}

/**
 * Validates each sample and recomputes its cascade acceptance with the same rule the shadow runtime uses.
 * Caller-supplied acceptance and compatibility pins are discarded.
 */
function scoredSamples(input: IssueTriageEvaluationInput, pack: IssueTriagePilotPack,
  manifest: IssueTriageEvaluationManifest): ScoredSample[] {
  const registeredSlices = new Set(manifest.slices.map(slice => slice.id));
  return input.samples.map(sample => {
    const where = `sample ${sample.id}`;
    if (sample.label.id !== sample.id) throw new IssueTriagePilotError(`${where} label id does not match`);
    for (const arm of ['baseline', 'cascade'] as const) {
      if (sample[arm].issueId !== sample.id) {
        throw new IssueTriagePilotError(`${where} ${arm} issue id ${sample[arm].issueId} does not match`);
      }
    }
    for (const key of ['issueType', 'area'] as const) {
      const allowed = key === 'issueType' ? pack.taxonomies.issueTypes : pack.taxonomies.areas;
      if (!allowed.includes(sample.label[key])) {
        throw new IssueTriagePilotError(`${where} label ${key} ${sample.label[key]} is not in the governed taxonomy`);
      }
    }
    if (!pack.taxonomies.stateCompleteness.includes(sample.label.completeness)
      || !pack.taxonomies.clarificationNeed.includes(sample.label.clarificationNeed)) {
      throw new IssueTriagePilotError(`${where} label completeness or clarification is not in the governed taxonomy`);
    }
    for (const slice of sample.label.slices) {
      if (!registeredSlices.has(slice)) throw new IssueTriagePilotError(`${where} slice ${slice} is not preregistered`);
    }
    verifySampleLineage(sample, pack);
    semantic(responseProblems(pack, sample.id, sample.lineage, sample.baseline), `${where} baseline response rejected`);
    const { acceptance: _ignored, ...response } = sample.cascade;
    semantic(responseProblems(pack, sample.id, sample.lineage, response), `${where} cascade response rejected`);
    const registry = input.calibration.registry;
    const request = registry?.requests[sample.id];
    const acceptance = acceptanceFor(pack, response, {
      requestedModel: input.calibration.requestedModel,
      actualModel: response.actualModel,
      compatibleActualModels: input.calibration.compatibleActualModels,
      uncertaintyProfile: input.calibration.uncertaintyProfile,
      ...(registry && request ? { registry: { registry: registry.registry, policy: registry.policy, request } } : {}),
    });
    return { ...sample, cascade: { ...response, acceptance } };
  });
}

/** The evaluated pack must be exactly the pack the manifest preregistered: same id, version and canonical digest. */
function verifyPilotPackPin(pack: IssueTriagePilotPack, manifest: IssueTriageEvaluationManifest): void {
  const pin = manifest.pilotPack;
  if (pin.id !== pack.id || pin.version !== pack.version || pin.digest !== artifactDigest(pack)) {
    throw new IssueTriagePilotError('issue triage pilot pack does not match the manifest pin');
  }
}

export function buildIssueTriageEvaluationReport(input: IssueTriageEvaluationInput): IssueTriageEvaluationReport {
  const pack = validateIssueTriagePilotPack(input.pack);
  const manifest = validateIssueTriageEvaluationManifest(input.manifest);
  verifyPilotPackPin(pack, manifest);
  if (!input.samples.length) throw new IssueTriagePilotError('issue triage evaluation requires at least one held-out sample');
  const splits = verifiedSplits(manifest, input.splits, input.samples);
  const samples = scoredSamples(input, pack, manifest);
  const findings = new Set<string>();
  const levelBps = levelInBps(manifest.thresholds.confidenceInterval);
  if (levelBps === null) findings.add('confidence-interval-unsupported');
  if (samples.length < manifest.thresholds.minimumTotalSamples) findings.add('insufficient-total-samples');

  const sliceReports = manifest.slices.map(slice => {
    const members = samples.filter(sample => sample.label.slices.includes(slice.id));
    const minimumSupport = Math.max(slice.minimumSupport, manifest.thresholds.minimumPerSliceSamples);
    const status: 'supported' | 'insufficient' = members.length >= minimumSupport ? 'supported' : 'insufficient';
    if (status === 'insufficient') findings.add(`slice-insufficient:${slice.id}`);
    const suppressed = status === 'insufficient' && slice.aggregation === 'suppress-small-n';
    return {
      id: slice.id, dimension: slice.dimension, aggregation: slice.aggregation,
      sampleN: suppressed ? null : members.length, minimumSupport, status, suppressed,
      metrics: suppressed || !members.length ? null : sliceMetrics(members),
    };
  });

  const urgencyOrdinal = new Map(pack.urgencyRubric.map(level => [level.id, level.ordinal]));
  const ordinalOf = (id: string, where: string): number => {
    const ordinal = urgencyOrdinal.get(id);
    if (ordinal === undefined) throw new IssueTriagePilotError(`${where} urgency ${id} is not in the governed rubric`);
    return ordinal;
  };
  const ordinal = evaluateOrdinalHeldout(splits, samples.map(sample => ({
    id: sample.id,
    trueLevel: ordinalOf(sample.label.urgency, `sample ${sample.id} label`),
    predictedLevel: ordinalOf(sample.cascade.urgency, `sample ${sample.id} cascade`),
    levels: pack.urgencyRubric.length,
  })));

  const duplicateCases = samples.filter(sample => sample.label.duplicateOf !== 'none');
  const noneCases = samples.filter(sample => sample.label.duplicateOf === 'none');
  const falseDuplicates = noneCases.filter(sample => sample.cascade.duplicate.issueId !== 'none').length;
  const duplicateHits = duplicateCases.filter(sample => sample.cascade.duplicate.issueId === sample.label.duplicateOf).length;
  const ranking = duplicateCases.length
    ? evaluateRankingHeldout(subsetSplits(splits, duplicateCases.map(sample => sample.id)), duplicateCases.map(sample => {
      const options = new Set([...sample.lineage.candidates.map(item => item.issueId), 'none', sample.label.duplicateOf]);
      return {
        id: sample.id,
        gold: Object.fromEntries([...options].map(option => [option, option === sample.label.duplicateOf ? 1 : 0])),
        predicted: Object.fromEntries([...options].map(option => [option, option === sample.cascade.duplicate.issueId ? 1 : 0])),
      };
    }))
    : { sampleN: 0, comparablePairs: 0, concordance: null };
  const duplicateSupported = duplicateCases.length >= manifest.thresholds.minimumDuplicateSamples;
  if (!duplicateSupported) findings.add('duplicate-insufficient');
  // Ranks below were re-validated against each sample's deterministic lineage.
  const topK: Record<string, number> = {};
  for (const k of [1, 3, 5]) {
    topK[`top${k}`] = rate(duplicateCases.filter(sample => sample.cascade.duplicate.issueId === sample.label.duplicateOf
      && sample.cascade.duplicate.rank !== null && sample.cascade.duplicate.rank <= k).length, duplicateCases.length);
  }
  const ndcg = rate(duplicateCases.reduce((sum, sample) => sample.cascade.duplicate.issueId === sample.label.duplicateOf
    && sample.cascade.duplicate.rank !== null ? sum + 1 / Math.log2(sample.cascade.duplicate.rank + 1) : sum, 0), duplicateCases.length);

  // Selective risk and coverage come from the held-out helper: label 1 means "cascade answer correct".
  const heldout = evaluateBinaryHeldout(splits, samples.map(sample => ({
    id: sample.id,
    slice: 'all',
    label: 1,
    probability: correct(sample, 'cascade') ? 1 : 0,
    accepted: sample.cascade.acceptance.acceptedScoring,
    latencyMs: sample.cascade.latencyMs,
    inputTokens: receiptTotal(sample.cascade.usageReceipts, 'inputTokens'),
    outputTokens: receiptTotal(sample.cascade.usageReceipts, 'outputTokens'),
    costUsd: receiptTotal(sample.cascade.usageReceipts, 'costUsd'),
    calls: sample.cascade.calls.jev + sample.cascade.calls.fallbackModel,
    retries: sample.cascade.retries,
    fallbacks: sample.cascade.fallbacks,
  }))).overall;
  const acceptedN = samples.filter(sample => sample.cascade.acceptance.acceptedScoring).length;
  const acceptedErrors = heldout.selectiveRisk === null ? 0 : Math.round(heldout.selectiveRisk * acceptedN);
  const selectiveRiskUpper = levelBps === null || acceptedN === 0 ? null
    : wilsonScoreInterval({ events: acceptedErrors, n: acceptedN, levelBps })[1];
  const coverageLower = levelBps === null ? null : wilsonScoreInterval({ events: acceptedN, n: samples.length, levelBps })[0];

  const usageReconciled = samples.every(sample => usageReconciliationProblems(sample.baseline).length === 0
    && usageReconciliationProblems(sample.cascade).length === 0);
  if (!usageReconciled) findings.add('usage-unreconciled');

  const baselineComparison = comparison(samples, usageReconciled);
  let qualityNonInferiority: IssueTriageNonInferiority | null = null;
  if (levelBps !== null) {
    const counts = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
    for (const sample of samples) {
      const cascadeCorrect = correct(sample, 'cascade');
      const baselineCorrect = correct(sample, 'baseline');
      if (cascadeCorrect && baselineCorrect) counts.both++;
      else if (cascadeCorrect) counts.candidateOnly++;
      else if (baselineCorrect) counts.baselineOnly++;
      else counts.neither++;
    }
    const marginBps = Math.round(manifest.thresholds.qualityNonInferiorityMargin * 10000);
    const interval = pairedBinaryDifferenceInterval({ counts, levelBps, method: 'newcombe-10' });
    const verdict = pairedNonInferiority({ interval, marginBps });
    qualityNonInferiority = {
      method: 'newcombe-hybrid-score', levelBps, marginBps, lowerBps: interval.lowerBps, upperBps: interval.upperBps,
      estimateBps: interval.estimateBps, n: interval.n, decision: verdict.decision,
    };
    if (verdict.decision !== 'non-inferior') findings.add('quality-non-inferiority');
    if (selectiveRiskUpper === null) findings.add('false-auto-insufficient');
    else if (selectiveRiskUpper > manifest.thresholds.maximumFalseAutoRate) findings.add('false-auto-rate');
    if (coverageLower! < manifest.thresholds.minimumAcceptedCoverage) findings.add('accepted-coverage');
    if (duplicateSupported && wilsonScoreInterval({ events: duplicateHits, n: duplicateCases.length, levelBps })[0]
      < manifest.thresholds.minimumDuplicateRecall) {
      findings.add('duplicate-recall');
    }
    if (!noneCases.length) findings.add('false-duplicate-insufficient');
    else if (wilsonScoreInterval({ events: falseDuplicates, n: noneCases.length, levelBps })[1] > manifest.thresholds.maximumFalseDuplicateRate) {
      findings.add('false-duplicate-rate');
    }
  }
  const compatibilityRequired = pack.acceptance.calibration === 'required';
  if (compatibilityRequired && (!input.calibration.registry
    || samples.some(sample => sample.cascade.acceptance.compatibility === null))) {
    findings.add('calibration-required-unverified');
  }
  const benefit = economicsBenefit(baselineComparison, manifest.thresholds.benefit.metric);
  if (benefit === null) findings.add('benefit-insufficient');
  else if (benefit <= 0) findings.add('benefit-not-positive');

  const sortedFindings = [...findings].sort();
  const report: IssueTriageEvaluationReport = {
    schemaVersion: 'decision-issue-triage-evaluation-report/v1',
    id: input.id,
    manifest: { id: manifest.id, version: 'v1', digest: digest(manifest) },
    pilotPack: { id: pack.id, version: pack.version, digest: artifactDigest(pack) },
    classCounts: {
      issueType: countBy(samples.map(sample => sample.label.issueType)),
      area: countBy(samples.map(sample => sample.label.area)),
      completeness: countBy(samples.map(sample => sample.label.completeness)),
      clarification: countBy(samples.map(sample => sample.label.clarificationNeed)),
    },
    classification: { issueType: multiclass(samples, 'issueType', pack), area: multiclass(samples, 'area', pack) },
    urgency: {
      sampleN: ordinal.sampleN,
      meanAbsoluteError: ordinal.meanAbsoluteError,
      normalizedAbsoluteError: ordinal.normalizedAbsoluteError,
      exactRate: ordinal.exactRate,
    },
    completeness: binary(samples, sample => sample.cascade.completeness === 'complete', sample => sample.label.completeness === 'complete'),
    clarification: binary(samples, sample => sample.cascade.clarificationNeed === 'needed', sample => sample.label.clarificationNeed === 'needed'),
    duplicates: {
      sampleN: samples.length,
      duplicateN: duplicateCases.length,
      noneN: noneCases.length,
      recall: rate(duplicateHits, duplicateCases.length),
      concordance: ranking.concordance,
      comparablePairs: ranking.comparablePairs,
      ndcg,
      topK,
      falseDuplicateRate: rate(falseDuplicates, noneCases.length),
      noneRecall: rate(noneCases.length - falseDuplicates, noneCases.length),
    },
    slices: sliceReports,
    calibration: {
      riskCoverage: {
        sampleN: heldout.sampleN, acceptedN, coverage: heldout.coverage, coverageLower,
        selectiveRisk: heldout.selectiveRisk, selectiveRiskUpper,
      },
      driftEvents: [...new Set(samples.map(sample => sample.cascade.acceptance.driftEvent).filter((value): value is string => value !== null))].sort(),
      compatibilityRequired,
    },
    operations: {
      reviewLoad: rate(samples.filter(sample => !sample.cascade.acceptance.acceptedScoring || sample.cascade.clarificationNeed === 'needed').length, samples.length),
      overrideRate: rate(samples.filter(sample => sample.label.reviewerWouldOverride).length, samples.length),
      latencyMs: heldout.latencyMs,
      tokens: { input: armUsage(samples, 'cascade', 'inputTokens'), output: armUsage(samples, 'cascade', 'outputTokens') },
      costUsd: armUsage(samples, 'cascade', 'costUsd'),
      calls: {
        jev: samples.reduce((sum, sample) => sum + sample.cascade.usageReceipts.filter(receipt => receipt.kind === 'jev').length, 0),
        fallbackModel: samples.reduce((sum, sample) => sum + sample.cascade.usageReceipts.filter(receipt => receipt.kind === 'fallback-model').length, 0),
      },
      retryRate: rate(samples.filter(sample => sample.cascade.retries > 0).length, samples.length),
      fallbackRate: rate(samples.filter(sample => sample.cascade.fallbacks > 0).length, samples.length),
      cache: {
        hits: samples.filter(sample => sample.cascade.usageReceipts.some(receipt => receipt.kind === 'cache')).length,
        misses: samples.filter(sample => !sample.cascade.usageReceipts.some(receipt => receipt.kind === 'cache')).length,
      },
      usageReconciled,
    },
    baselineComparison: { ...baselineComparison, qualityNonInferiority },
    integrity: { upstreamDecision: input.upstreamDecision, findings: sortedFindings },
    decision: gateDecision(input.upstreamDecision, sortedFindings),
  };
  return checkIssueTriageEvaluationReportShape(report);
}

/**
 * Net benefit of the cascade over the baseline on the preregistered metric only. A null value means the
 * evidence is insufficient; the token count is never substituted for an unknown cost.
 */
function economicsBenefit(comparisonArms: Omit<IssueTriageEvaluationReport['baselineComparison'], 'qualityNonInferiority'>,
  metric: IssueTriageEvaluationManifest['thresholds']['benefit']['metric']): number | null {
  const delta = metric === 'reviewer-time' ? comparisonArms.delta.reviewerTimeMinutes : comparisonArms.delta.costUsd;
  return delta === null ? null : -delta;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

/** Arm totals are summed from provider receipts; unreconciled usage leaves token and cost comparisons unknown. */
function comparison(samples: readonly ScoredSample[], usageReconciled: boolean)
  : Omit<IssueTriageEvaluationReport['baselineComparison'], 'qualityNonInferiority'> {
  const arm = (which: 'baseline' | 'cascade') => {
    const input = armUsage(samples, which, 'inputTokens');
    const output = armUsage(samples, which, 'outputTokens');
    return {
      quality: rate(samples.filter(sample => correct(sample, which)).length, samples.length),
      tokens: !usageReconciled || input === null || output === null ? null : input + output,
      costUsd: usageReconciled ? armUsage(samples, which, 'costUsd') : null,
      reviewerTimeMinutes: samples.some(sample => !Number.isFinite(sample.label.reviewerTimeBaselineMinutes)
        || !Number.isFinite(sample.label.reviewerTimeCascadeMinutes)) ? null
        : samples.reduce((sum, sample) => sum + (which === 'baseline' ? sample.label.reviewerTimeBaselineMinutes : sample.label.reviewerTimeCascadeMinutes), 0),
    };
  };
  const baseline = arm('baseline');
  const cascade = arm('cascade');
  return {
    baseline,
    cascade,
    delta: {
      quality: cascade.quality - baseline.quality,
      tokens: baseline.tokens === null || cascade.tokens === null ? null : cascade.tokens - baseline.tokens,
      costUsd: baseline.costUsd === null || cascade.costUsd === null ? null : cascade.costUsd - baseline.costUsd,
      reviewerTimeMinutes: baseline.reviewerTimeMinutes === null || cascade.reviewerTimeMinutes === null
        ? null : cascade.reviewerTimeMinutes - baseline.reviewerTimeMinutes,
    },
  };
}

export function issueTriageArtifactDigest(value: unknown): `sha256:${string}` {
  return artifactDigest(value);
}
