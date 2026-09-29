import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../../security/artifact-trust.js';
import { correlateAtomicBatch } from '../batch.js';
import { admitEntry } from '../entry.js';
import { projectDecisionState, type DecisionProjectionField, type DecisionProjectionPolicy } from '../projection.js';
import {
  evaluateBinaryHeldout,
  evaluateOrdinalHeldout,
  evaluateRankingHeldout,
  freezeQualificationSplit,
  type BinaryQualificationSample,
} from '../qualification/quality.js';
import { artifactDigest } from '../validate.js';
import type {
  BinaryMetrics,
  IssueTriageBatchQuestion,
  IssueTriageCalibrationContext,
  IssueTriageCandidateInput,
  IssueTriageCandidateLineage,
  IssueTriageDuplicateCandidate,
  IssueTriageEvaluationManifest,
  IssueTriageEvaluationReport,
  IssueTriageEvaluationSample,
  IssueTriageGateDecision,
  IssueTriageIssueRecord,
  IssueTriageModelResponse,
  IssueTriageModelState,
  IssueTriagePilotPack,
  IssueTriageProjection,
  IssueTriageShadowArtifact,
  IssueTriageTrackerClient,
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
const MUTATION_METHODS = ['createIssue', 'editIssue', 'addLabel', 'assignIssue', 'commentIssue', 'closeIssue', 'mergeIssue'] as const;
const FINAL_FIELDS = ['finalLabels', 'finalDuplicateOf', 'resolution', 'closedAt'] as const;
const RESPONSE_FIELDS = ['issueId', 'issueType', 'area', 'urgency', 'completeness', 'clarificationNeed', 'duplicate',
  'uncertaintyProfile', 'accepted', 'actualModel', 'requestedModel', 'latencyMs', 'usage', 'calls', 'retries', 'fallbacks', 'cacheHit'] as const;
const DUPLICATE_RESPONSE_FIELDS = ['issueId', 'rank'] as const;
const METADATA_ALLOWLIST = ['component', 'provider', 'framework', 'source', 'environment', 'reproduction'] as const;

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
  if (manifest.holdout.holdoutAccessedAt !== null
    && Date.parse(manifest.holdout.holdoutAccessedAt) <= Date.parse(manifest.holdout.thresholdsRegisteredAt)) {
    problems.push('thresholds must be preregistered before holdout access');
  }
  semantic(problems, 'issue triage evaluation manifest rejected');
  return manifest;
}

export function validateIssueTriageEvaluationReport(value: unknown): IssueTriageEvaluationReport {
  checkSchema('report', value);
  const report = value as IssueTriageEvaluationReport;
  const problems: string[] = [];
  if (GATE_RANK[report.decision] < GATE_RANK[report.integrity.upstreamDecision]) {
    problems.push(`issue triage report cannot upgrade ${report.integrity.upstreamDecision} to ${report.decision}`);
  }
  if (report.decision === 'PROMOTE' && report.integrity.findings.length > 0) problems.push('PROMOTE requires no findings');
  semantic(problems, 'issue triage evaluation report rejected');
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

export function deterministicIssueDuplicateCandidates(
  issue: IssueTriageIssueRecord,
  corpus: readonly IssueTriageCandidateInput[],
  pack: IssueTriagePilotPack = defaultIssueTriagePilotPack(),
): IssueTriageCandidateLineage {
  const query = tokens(issueText(issue));
  const issueCreatedAt = Date.parse(issue.createdAt);
  const scored = corpus
    .filter(candidate => candidate.id !== issue.id && candidate.repository === issue.repository
      && Number.isFinite(issueCreatedAt) && Date.parse(candidate.createdAt) <= issueCreatedAt)
    .map(candidate => {
      const candidateTokens = tokens(issueText(candidate));
      const overlap = [...query].filter(token => candidateTokens.has(token)).length;
      const union = new Set([...query, ...candidateTokens]).size || 1;
      return {
        issueId: candidate.id,
        repository: candidate.repository,
        title: candidate.title,
        rank: 0,
        score: overlap / union,
        sourceDigest: digest(candidate),
      };
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.issueId.localeCompare(right.issueId))
    .slice(0, pack.candidatePolicy.maxCandidates)
    .map((candidate, index): IssueTriageDuplicateCandidate => ({ ...candidate, rank: index + 1 }));
  return { generator: 'deterministic-token-overlap-v1', queryDigest: digest({ id: issue.id, text: issueText(issue) }), candidates: scored, noneOutcome: 'none' };
}

function redactCredentialMaterial(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'bearer [REDACTED]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/(?:api[_-]?key|token|password|credential)\s*[:=]\s*["']?[^"'\s]+/gi, match => `${match.split(/[:=]/)[0]}=[REDACTED]`);
}

function allowedMetadata(metadata: IssueTriageIssueRecord['metadata']): IssueTriageModelState['issue']['metadata'] | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).filter(([key]) => (METADATA_ALLOWLIST as readonly string[]).includes(key));
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
      title: issue.title,
      body: redactCredentialMaterial(issue.body),
      createdAt: issue.createdAt,
      ...(issue.author === undefined ? {} : { author: issue.author }),
      ...(metadata === undefined ? {} : { metadata }),
    },
    duplicateCandidates: lineage.candidates,
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

export function validateIssueTriageModelResponse(
  packInput: IssueTriagePilotPack,
  projection: IssueTriageProjection,
  response: IssueTriageModelResponse,
  calibration: IssueTriageCalibrationContext,
): IssueTriageValidatedResponse {
  const pack = validateIssueTriagePilotPack(packInput);
  const problems: string[] = [];
  for (const key of Object.keys(response as unknown as Record<string, unknown>)) {
    if (!(RESPONSE_FIELDS as readonly string[]).includes(key)) problems.push(`model response contains unauthorized field ${key}`);
  }
  for (const key of Object.keys(response.duplicate as unknown as Record<string, unknown>)) {
    if (!(DUPLICATE_RESPONSE_FIELDS as readonly string[]).includes(key)) problems.push(`duplicate response contains unauthorized field ${key}`);
  }
  if (response.issueId !== projection.modelState.issue.id) problems.push('response issue id does not match the projected subject');
  if (!pack.taxonomies.issueTypes.includes(response.issueType)) problems.push(`issue type ${response.issueType} is not in the governed taxonomy`);
  if (!pack.taxonomies.areas.includes(response.area)) problems.push(`area ${response.area} is not in the governed taxonomy`);
  if (!pack.urgencyRubric.some(level => level.id === response.urgency)) problems.push(`urgency ${response.urgency} is not in the governed rubric`);
  if (!pack.taxonomies.stateCompleteness.includes(response.completeness)) problems.push(`completeness ${response.completeness} is not in the governed taxonomy`);
  if (!pack.taxonomies.clarificationNeed.includes(response.clarificationNeed)) problems.push(`clarification ${response.clarificationNeed} is not in the governed taxonomy`);
  if (response.duplicate.issueId !== 'none' && !projection.lineage.candidates.some(candidate => candidate.issueId === response.duplicate.issueId)) {
    problems.push(`duplicate candidate ${response.duplicate.issueId} was not deterministically generated`);
  }
  const deterministicRank = response.duplicate.issueId === 'none'
    ? null
    : projection.lineage.candidates.find(candidate => candidate.issueId === response.duplicate.issueId)?.rank ?? null;
  if (response.duplicate.issueId === 'none' && response.duplicate.rank !== null) problems.push('none duplicate outcome must not carry a rank');
  if (response.duplicate.issueId !== 'none' && response.duplicate.rank !== deterministicRank) {
    problems.push(`duplicate rank for ${response.duplicate.issueId} does not match deterministic rank ${deterministicRank}`);
  }
  if (!Number.isFinite(response.latencyMs) || response.latencyMs < 0) problems.push('latency must be finite and nonnegative');
  if ([response.calls.jev, response.calls.fallbackModel, response.retries, response.fallbacks].some(value => !Number.isSafeInteger(value) || value < 0)) {
    problems.push('call, retry and fallback counts must be nonnegative integers');
  }
  semantic(problems, 'issue triage model response rejected');
  const profileCompatible = pack.acceptance.uncertaintyProfiles.includes(calibration.uncertaintyProfile)
    && calibration.uncertaintyProfile === response.uncertaintyProfile;
  const modelCompatible = calibration.requestedModel === response.requestedModel
    && calibration.actualModel === response.actualModel
    && calibration.compatibleActualModels.includes(response.actualModel)
    && (calibration.compatibility === undefined || calibration.compatibility.action === 'allow');
  const acceptedScoring = response.accepted && profileCompatible && modelCompatible;
  const reason = acceptedScoring ? 'compatible' : !response.accepted ? 'defer-response-rejected'
    : modelCompatible ? 'defer-calibration-incompatible' : 'defer-drift';
  const driftEvent = modelCompatible ? null : `model-drift:${response.requestedModel}->${response.actualModel}`;
  return { ...response, acceptance: { acceptedScoring, reason, driftEvent } };
}

export function assertNoTrackerMutations(client: IssueTriageTrackerClient): void {
  for (const method of MUTATION_METHODS) {
    const value = client[method];
    if (value !== undefined) throw new IssueTriagePilotError(`tracker mutation hook ${method} is not accepted by shadow runtime`);
  }
}

export function forbiddenIssueTriageTrackerClient(): Required<IssueTriageTrackerClient> {
  const fail = (method: string) => () => {
    throw new IssueTriagePilotError(`tracker mutation ${method} is forbidden in issue triage shadow mode`);
  };
  return {
    createIssue: fail('createIssue'),
    editIssue: fail('editIssue'),
    addLabel: fail('addLabel'),
    assignIssue: fail('assignIssue'),
    commentIssue: fail('commentIssue'),
    closeIssue: fail('closeIssue'),
    mergeIssue: fail('mergeIssue'),
  };
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
  const tracker = forbiddenIssueTriageTrackerClient();
  const lineage = deterministicIssueDuplicateCandidates(issue, corpus, active);
  const projection = await projectIssueTriageModelState(active, issue, lineage);
  const validated = validateIssueTriageModelResponse(active, projection, response, calibration);
  void tracker;
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

export function applyIssueTriagePilot<T>(
  enabled: boolean,
  previousWorkflowResult: T,
  shadow: () => IssueTriageShadowArtifact | Promise<IssueTriageShadowArtifact>,
  recordArtifact: (artifact: IssueTriageShadowArtifact | IssueTriageShadowFailureArtifact) => void = () => {},
): T {
  if (!enabled) return previousWorkflowResult;
  try {
    const artifact = shadow();
    if (typeof (artifact as Promise<IssueTriageShadowArtifact>).then === 'function') {
      void (artifact as Promise<IssueTriageShadowArtifact>).then(recordArtifact, error => recordArtifact(failureArtifact(error)));
    } else {
      recordArtifact(artifact as IssueTriageShadowArtifact);
    }
  } catch (error) {
    recordArtifact(failureArtifact(error));
  }
  return previousWorkflowResult;
}

function prf(tp: number, fp: number, fn: number): PrecisionRecallF1 {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) };
}

function multiclass(samples: readonly IssueTriageEvaluationSample[], key: 'issueType' | 'area', pack: IssueTriagePilotPack): MulticlassMetrics {
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

function binary(samples: readonly IssueTriageEvaluationSample[], predicted: (sample: IssueTriageEvaluationSample) => boolean,
  actual: (sample: IssueTriageEvaluationSample) => boolean): BinaryMetrics {
  const tp = samples.filter(sample => predicted(sample) && actual(sample)).length;
  const fp = samples.filter(sample => predicted(sample) && !actual(sample)).length;
  const fn = samples.filter(sample => !predicted(sample) && actual(sample)).length;
  return { sampleN: samples.length, ...prf(tp, fp, fn) };
}

function sumKnown(samples: readonly IssueTriageEvaluationSample[], key: 'inputTokens' | 'outputTokens' | 'costUsd'): number | null {
  const values = samples.map(sample => sample.cascade.usage[key]);
  if (values.some(value => value === null)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function quantiles(values: readonly number[]): { p50: number; p95: number; p99: number } {
  if (!values.length) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function quality(samples: readonly IssueTriageEvaluationSample[], which: 'baseline' | 'cascade'): number {
  if (!samples.length) return 0;
  const matches = samples.filter(sample => correct(sample, which)).length;
  return matches / samples.length;
}

function correct(sample: IssueTriageEvaluationSample, which: 'baseline' | 'cascade'): boolean {
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

function qualificationSplits(ids: readonly string[]) {
  return [
    freezeQualificationSplit('tuning', ['issue-triage-tuning-sentinel']),
    freezeQualificationSplit('calibration', ['issue-triage-calibration-sentinel']),
    freezeQualificationSplit('test', ids),
  ];
}

function wilsonLower(successes: number, n: number, _level: number): number {
  if (n === 0) return 0;
  const z = 1.959963984540054;
  const rate = successes / n;
  const denominator = 1 + z * z / n;
  const center = (rate + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / denominator;
  return Math.max(0, center - margin);
}

function binaryHeldout(ids: readonly string[], samples: readonly BinaryQualificationSample[]) {
  return evaluateBinaryHeldout(qualificationSplits(ids), samples);
}

function economicsBenefit(report: Pick<IssueTriageEvaluationReport, 'baselineComparison'>, metric: IssueTriageEvaluationManifest['thresholds']['benefit']['metric']): number | null {
  if (metric === 'reviewer-time') return report.baselineComparison.delta.reviewerTimeMinutes === null
    ? null : -report.baselineComparison.delta.reviewerTimeMinutes;
  if (report.baselineComparison.delta.costUsd !== null) return -report.baselineComparison.delta.costUsd;
  return report.baselineComparison.delta.tokens === null ? null : -report.baselineComparison.delta.tokens;
}

export function buildIssueTriageEvaluationReport(input: {
  id: string;
  manifest: IssueTriageEvaluationManifest;
  pack: IssueTriagePilotPack;
  samples: readonly IssueTriageEvaluationSample[];
  upstreamDecision: IssueTriageGateDecision;
}): IssueTriageEvaluationReport {
  const pack = validateIssueTriagePilotPack(input.pack);
  const manifest = validateIssueTriageEvaluationManifest(input.manifest);
  const samples = [...input.samples];
  const findings = new Set<string>();
  if (samples.length < manifest.thresholds.minimumTotalSamples) findings.add('insufficient-total-samples');
  if (manifest.thresholds.confidenceInterval.method !== 'wilson' || manifest.thresholds.confidenceInterval.level !== 0.95) {
    findings.add('confidence-interval-unsupported');
  }
  for (const slice of manifest.slices) {
    const count = samples.filter(sample => sample.label.slices.includes(slice.id)).length;
    if (count < slice.minimumSupport) findings.add(`slice-insufficient:${slice.id}`);
  }
  const urgencyOrdinal = new Map(pack.urgencyRubric.map(level => [level.id, level.ordinal]));
  const urgencyErrors = samples.map(sample => Math.abs(urgencyOrdinal.get(sample.cascade.urgency)! - urgencyOrdinal.get(sample.label.urgency)!));
  if (samples.length) evaluateOrdinalHeldout(qualificationSplits(samples.map(sample => sample.id)), samples.map(sample => ({
    id: sample.id,
    trueLevel: urgencyOrdinal.get(sample.label.urgency)!,
    predictedLevel: urgencyOrdinal.get(sample.cascade.urgency)!,
    levels: pack.urgencyRubric.length,
  })));
  const duplicateCases = samples.filter(sample => sample.label.duplicateOf !== 'none');
  const noneCases = samples.filter(sample => sample.label.duplicateOf === 'none');
  const falseDuplicates = noneCases.filter(sample => sample.cascade.duplicate.issueId !== 'none').length;
  const duplicateHits = duplicateCases.filter(sample => sample.cascade.duplicate.issueId === sample.label.duplicateOf).length;
  if (duplicateCases.length) evaluateRankingHeldout(qualificationSplits(duplicateCases.map(sample => sample.id)), duplicateCases.map(sample => ({
    id: sample.id,
    gold: { [sample.label.duplicateOf]: 1, none: 0 },
    predicted: { [sample.label.duplicateOf]: sample.cascade.duplicate.issueId === sample.label.duplicateOf ? 1 : 0, none: sample.cascade.duplicate.issueId === 'none' ? 1 : 0 },
  })));
  const topK: Record<string, number> = {};
  for (const k of [1, 3, 5]) {
    const eligible = duplicateCases.filter(sample => sample.cascade.duplicate.rank !== null && sample.cascade.duplicate.rank <= k
      && sample.cascade.duplicate.issueId === sample.label.duplicateOf).length;
    topK[`top${k}`] = duplicateCases.length ? eligible / duplicateCases.length : 0;
  }
  const ndcg = duplicateCases.length ? duplicateCases.reduce((sum, sample) => {
    if (sample.cascade.duplicate.issueId !== sample.label.duplicateOf || sample.cascade.duplicate.rank === null) return sum;
    return sum + 1 / Math.log2(sample.cascade.duplicate.rank + 1);
  }, 0) / duplicateCases.length : 0;
  const accepted = samples.filter(sample => sample.cascade.acceptance.acceptedScoring);
  const acceptedCorrect = accepted.filter(sample => correct(sample, 'cascade')).length;
  const calls = samples.reduce((acc, sample) => ({
    jev: acc.jev + sample.cascade.calls.jev,
    fallbackModel: acc.fallbackModel + sample.cascade.calls.fallbackModel,
  }), { jev: 0, fallbackModel: 0 });
  const report: IssueTriageEvaluationReport = {
    schemaVersion: 'decision-issue-triage-evaluation-report/v1',
    id: input.id,
    manifest: { id: manifest.id, version: 'v1', digest: digest(manifest) },
    classCounts: {
      issueType: countBy(samples.map(sample => sample.label.issueType)),
      area: countBy(samples.map(sample => sample.label.area)),
      completeness: countBy(samples.map(sample => sample.label.completeness)),
      clarification: countBy(samples.map(sample => sample.label.clarificationNeed)),
    },
    classification: { issueType: multiclass(samples, 'issueType', pack), area: multiclass(samples, 'area', pack) },
    urgency: {
      sampleN: samples.length,
      meanAbsoluteError: urgencyErrors.length ? urgencyErrors.reduce((sum, value) => sum + value, 0) / urgencyErrors.length : 0,
      exactRate: urgencyErrors.length ? urgencyErrors.filter(value => value === 0).length / urgencyErrors.length : 0,
    },
    completeness: binary(samples, sample => sample.cascade.completeness === 'complete', sample => sample.label.completeness === 'complete'),
    clarification: binary(samples, sample => sample.cascade.clarificationNeed === 'needed', sample => sample.label.clarificationNeed === 'needed'),
    duplicates: {
      sampleN: samples.length,
      recall: duplicateCases.length ? duplicateHits / duplicateCases.length : 0,
      ndcg,
      topK,
      falseDuplicateRate: noneCases.length ? falseDuplicates / noneCases.length : 0,
      noneRecall: noneCases.length ? (noneCases.length - falseDuplicates) / noneCases.length : 0,
    },
    slices: manifest.slices.map(slice => {
      const sampleN = samples.filter(sample => sample.label.slices.includes(slice.id)).length;
      return { id: slice.id, dimension: slice.dimension, sampleN, minimumSupport: slice.minimumSupport,
        status: sampleN >= slice.minimumSupport ? 'supported' : 'insufficient' };
    }),
    calibration: {
      riskCoverage: acceptedCorrect / Math.max(1, samples.length),
      acceptedCoverage: accepted.length / Math.max(1, samples.length),
      driftEvents: [...new Set(samples.map(sample => sample.cascade.acceptance.driftEvent).filter((value): value is string => value !== null))].sort(),
    },
    operations: {
      reviewLoad: samples.filter(sample => !sample.cascade.acceptance.acceptedScoring || sample.cascade.clarificationNeed === 'needed').length / Math.max(1, samples.length),
      overrideRate: samples.filter(sample => sample.label.reviewerWouldOverride).length / Math.max(1, samples.length),
      latencyMs: quantiles(samples.map(sample => sample.cascade.latencyMs)),
      tokens: { input: sumKnown(samples, 'inputTokens') as number | null, output: sumKnown(samples, 'outputTokens') as number | null },
      costUsd: sumKnown(samples, 'costUsd') as number | null,
      calls,
      retryRate: samples.filter(sample => sample.cascade.retries > 0).length / Math.max(1, samples.length),
      fallbackRate: samples.filter(sample => sample.cascade.fallbacks > 0).length / Math.max(1, samples.length),
      cache: {
        hits: samples.filter(sample => sample.cascade.cacheHit).length,
        misses: samples.filter(sample => !sample.cascade.cacheHit).length,
      },
    },
    baselineComparison: comparison(samples),
    integrity: { upstreamDecision: input.upstreamDecision, findings: [...findings].sort() },
    decision: gateDecision(input.upstreamDecision, [...findings]),
  };
  if (samples.length) {
    const qualityMetrics = binaryHeldout(samples.map(sample => sample.id), samples.map(sample => ({
      id: sample.id,
      slice: sample.label.slices[0] ?? 'unspecified',
      label: 1,
      probability: correct(sample, 'cascade') ? 1 : 0,
      accepted: sample.cascade.acceptance.acceptedScoring,
      latencyMs: sample.cascade.latencyMs,
      inputTokens: sample.cascade.usage.inputTokens,
      outputTokens: sample.cascade.usage.outputTokens,
      costUsd: sample.cascade.usage.costUsd,
      calls: sample.cascade.calls.jev + sample.cascade.calls.fallbackModel,
      retries: sample.cascade.retries,
      fallbacks: sample.cascade.fallbacks,
    })));
    const cascadeQualityLower = 1 - qualityMetrics.overall.errorWilson95[1];
    if (cascadeQualityLower < quality(samples, 'baseline') + manifest.thresholds.qualityNonInferiorityMargin) {
      report.integrity.findings.push('quality-non-inferiority');
    }
    const falseAuto = accepted.length ? (accepted.length - acceptedCorrect) / accepted.length : null;
    if (falseAuto === null) report.integrity.findings.push('false-auto-insufficient');
    else if (falseAuto > manifest.thresholds.maximumFalseAutoRate) report.integrity.findings.push('false-auto-rate');
    if (wilsonLower(accepted.length, samples.length, manifest.thresholds.confidenceInterval.level) < manifest.thresholds.minimumAcceptedCoverage) {
      report.integrity.findings.push('accepted-coverage');
    }
  }
  if (noneCases.length) {
    const falseDuplicateMetrics = binaryHeldout(noneCases.map(sample => sample.id), noneCases.map(sample => ({
      id: sample.id,
      slice: sample.label.slices[0] ?? 'unspecified',
      label: 0,
      probability: sample.cascade.duplicate.issueId !== 'none' ? 1 : 0,
      accepted: sample.cascade.acceptance.acceptedScoring,
      latencyMs: sample.cascade.latencyMs,
      inputTokens: sample.cascade.usage.inputTokens,
      outputTokens: sample.cascade.usage.outputTokens,
      costUsd: sample.cascade.usage.costUsd,
      calls: sample.cascade.calls.jev + sample.cascade.calls.fallbackModel,
      retries: sample.cascade.retries,
      fallbacks: sample.cascade.fallbacks,
    })));
    if (falseDuplicateMetrics.overall.errorWilson95[1] > manifest.thresholds.maximumFalseDuplicateRate) {
      report.integrity.findings.push('false-duplicate-rate');
    }
  } else {
    report.integrity.findings.push('false-duplicate-insufficient');
  }
  const benefit = economicsBenefit(report, manifest.thresholds.benefit.metric);
  if (benefit === null) report.integrity.findings.push('benefit-insufficient');
  else if (benefit <= 0) report.integrity.findings.push('benefit-not-positive');
  report.decision = gateDecision(input.upstreamDecision, report.integrity.findings);
  return validateIssueTriageEvaluationReport(report);
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function comparison(samples: readonly IssueTriageEvaluationSample[]): IssueTriageEvaluationReport['baselineComparison'] {
  const arm = (which: 'baseline' | 'cascade') => ({
    quality: quality(samples, which),
    tokens: sumArm(samples, which, 'inputTokens', 'outputTokens'),
    costUsd: sumArm(samples, which, 'costUsd'),
    reviewerTimeMinutes: samples.some(sample => !Number.isFinite(sample.label.reviewerTimeBaselineMinutes)
      || !Number.isFinite(sample.label.reviewerTimeCascadeMinutes)) ? null
      : samples.reduce((sum, sample) => sum + (which === 'baseline' ? sample.label.reviewerTimeBaselineMinutes : sample.label.reviewerTimeCascadeMinutes), 0),
  });
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

function sumArm(samples: readonly IssueTriageEvaluationSample[], which: 'baseline' | 'cascade',
  key: 'costUsd'): number | null;
function sumArm(samples: readonly IssueTriageEvaluationSample[], which: 'baseline' | 'cascade',
  key: 'inputTokens', second: 'outputTokens'): number | null;
function sumArm(samples: readonly IssueTriageEvaluationSample[], which: 'baseline' | 'cascade',
  key: 'inputTokens' | 'outputTokens' | 'costUsd', second?: 'outputTokens'): number | null {
  const values = samples.flatMap(sample => second ? [sample[which].usage[key], sample[which].usage[second]] : [sample[which].usage[key]]);
  if (values.some(value => value === null)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

export function issueTriageArtifactDigest(value: unknown): `sha256:${string}` {
  return artifactDigest(value);
}
