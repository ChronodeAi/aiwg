import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';
import type { ContextQuestion } from './context-plan.js';
import type { QualificationIntegrityMetadata } from './qualification/release.js';

export const CONTEXT_PRUNING_PROTECTED_POLICY_VERSION = 'decision-context-protected/v1' as const;
export const CONTEXT_PRUNING_CANDIDATE_SCHEMA = 'decision-context-candidate/v1' as const;
export const CONTEXT_PRUNING_RECEIPT_SCHEMA = 'decision-context-pruning-receipt/v1' as const;
export const CONTEXT_PRUNING_PREREGISTRATION_SCHEMA = 'decision-context-pruning-preregistration/v1' as const;
export const CONTEXT_PRUNING_EVALUATION_REPORT_SCHEMA = 'decision-context-pruning-evaluation-report/v1' as const;

export type ContextPruningSourceKind =
  | 'system'
  | 'developer'
  | 'project'
  | 'security-policy'
  | 'user'
  | 'approval'
  | 'blocker'
  | 'provenance'
  | 'citation'
  | 'artifact'
  | 'test-evidence'
  | 'open-decision'
  | 'retrieved'
  | 'memory'
  | 'tool-output'
  | 'ordinary';
export type ContextTrust = 'verified' | 'untrusted';
export type ContextSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type ContextPruningAction = 'keep' | 'drop' | 'truncate' | 'summarize';
export type ContextPruningMode = 'disabled' | 'shadow' | 'advisory';
export type ContextProtectedReason =
  | 'system-rule'
  | 'developer-rule'
  | 'project-rule'
  | 'security-policy'
  | 'current-user-requirement'
  | 'explicit-mention'
  | 'unresolved-blocker'
  | 'action-approval'
  | 'artifact-pin'
  | 'version-pin'
  | 'digest-pin'
  | 'provenance-required'
  | 'citation-required'
  | 'test-gate-evidence'
  | 'open-decision-evidence'
  | 'external-evaluation-denied'
  | 'local-only'
  | 'restricted-data'
  | 'legal-policy';

export interface ContextPruningCandidate {
  schemaVersion: typeof CONTEXT_PRUNING_CANDIDATE_SCHEMA;
  itemId: string;
  locator: string;
  contentDigest: `sha256:${string}`;
  /** Optional host-owned body used only for prompt reconstruction tests. It never crosses model policy. */
  content?: string;
  source: { kind: ContextPruningSourceKind; addedAt: string };
  tokenEstimate: number;
  priority: number;
  trust: ContextTrust;
  sensitivity: ContextSensitivity;
  dependencies: string[];
  protectedHints: ContextProtectedReason[];
  taskSubject: string;
  dataPolicy: {
    externalEvaluation: 'allowed' | 'denied';
    localOnly: boolean;
    legalAction: 'none' | 'requires-review';
  };
  deterministicFallbackAction?: ContextPruningAction;
}

export interface ContextProtectedClassification {
  schemaVersion: typeof CONTEXT_PRUNING_PROTECTED_POLICY_VERSION;
  itemId: string;
  protected: boolean;
  reasons: ContextProtectedReason[];
  policyDigest: `sha256:${string}`;
}

export interface ContextPruningDecisionEvidence {
  itemId: string;
  subject: string;
  status: 'success' | 'invalid' | 'uncertain' | 'uncalibrated' | 'incomplete' | 'cancelled' | 'failed' | 'drifted';
  proposedAction?: ContextPruningAction;
  confidenceBps?: number;
  marginBps?: number;
  disagreement?: boolean;
  calibrated?: boolean;
  calibrationDigest?: `sha256:${string}`;
  decisionReceiptDigest?: `sha256:${string}`;
  modelIdentityDigest?: `sha256:${string}`;
  transformation?: ContextTransformationReference;
}

export interface ContextTransformationReference {
  action: 'truncate' | 'summarize';
  locator: string;
  digest: `sha256:${string}`;
  sourceDigest: `sha256:${string}`;
  qualityCheck: 'passed' | 'failed' | 'missing';
}

export interface ContextPruningPolicy {
  mode: ContextPruningMode;
  minimumConfidenceBps: number;
  minimumMarginBps: number;
  allowedDestructiveActions: ContextPruningAction[];
  /** The runtime disables advisory behavior when either digest changes. */
  calibrationDigest: `sha256:${string}` | null;
  modelIdentityDigest: `sha256:${string}` | null;
}

export interface ContextPruningReceipt {
  schemaVersion: typeof CONTEXT_PRUNING_RECEIPT_SCHEMA;
  itemId: string;
  locator: string;
  originalDigest: `sha256:${string}`;
  originalTokenEstimate: number;
  classification: ContextProtectedClassification;
  proposedAction: ContextPruningAction;
  appliedAction: ContextPruningAction;
  mode: ContextPruningMode | 'deterministic-fallback';
  reason:
    | 'protected-item'
    | 'disabled'
    | 'shadow-only'
    | 'accepted-evidence'
    | 'prior-deterministic-fallback'
    | 'invalid-evidence'
    | 'uncertain-evidence'
    | 'uncalibrated'
    | 'incomplete-state'
    | 'cancelled'
    | 'evaluation-failed'
    | 'drift-or-monitoring-regression'
    | 'unsupported-transformation'
    | 'policy-denied-action';
  decisionReceiptDigest: `sha256:${string}` | null;
  reversibleReference: {
    locator: string;
    originalDigest: `sha256:${string}`;
    restorationPath: string;
    transformation: ContextTransformationReference | null;
  };
  createdAt: string;
  receiptDigest: `sha256:${string}`;
}

export interface ContextPruningRun {
  schemaVersion: 'decision-context-pruning-run/v1';
  mode: ContextPruningMode | 'deterministic-fallback';
  baselineItemIds: string[];
  downstreamItemIds: string[];
  receipts: ContextPruningReceipt[];
  disabledReason: 'configured-disabled' | 'drift-or-monitoring-regression' | null;
}

interface ContextPruningActionDecision {
  proposedAction: ContextPruningAction;
  appliedAction: ContextPruningAction;
  mode: ContextPruningMode | 'deterministic-fallback';
  reason: ContextPruningReceipt['reason'];
  decisionReceiptDigest: `sha256:${string}` | null;
  transformation: ContextTransformationReference | null;
}

export interface ContextPruningQuestion {
  id: string;
  itemId: string;
  subject: string;
  kind: 'relevance' | 'disposition' | 'omission-risk';
  entry: ContextQuestion['entry'];
  batchKey?: string;
}

export interface ContextPruningEvaluationJob {
  subject: string;
  itemId: string;
  state: { candidateDigest: `sha256:${string}`; itemId: string; locator: string };
  questions: ContextPruningQuestion[];
  contextQuestion: ContextQuestion;
}

export interface ContextPruningPreregistration {
  schemaVersion: typeof CONTEXT_PRUNING_PREREGISTRATION_SCHEMA;
  id: string;
  registeredAt: string;
  holdoutAccessedAt: string | null;
  thresholds: {
    protectedRetentionBps: 10_000;
    confidenceInterval: { method: 'wilson' | 'bootstrap'; levelBps: number };
    minimumOverallN: number;
    minimumSliceN: number;
    powerRule: string | null;
    qualityNonInferiorityMarginBps: number;
    positiveTotalTokenTarget: number;
    positiveTotalCostTargetUsd: number;
  };
  digest: `sha256:${string}`;
}

export interface ContextPruningPairedMetrics {
  sampleN: number;
  sliceCounts: Record<string, number>;
  downstreamTaskSuccessDeltaBps: number | null;
  requirementCoverageDeltaBps: number | null;
  factualCoverageDeltaBps: number | null;
  citationAccuracyDeltaBps: number | null;
  humanPreferenceDeltaBps: number | null;
  protectedRetentionBps: number;
  providerUsage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  estimatorUsage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  totalCalls: number;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
  promptCache: { hits: number; misses: number; avoidedPromptTokens: number };
  sharedStateAccounting: 'request-owned-once' | 'not-applicable';
}

export interface ContextPruningEvaluationReport {
  schemaVersion: typeof CONTEXT_PRUNING_EVALUATION_REPORT_SCHEMA;
  preregistration: ContextPruningPreregistration;
  integrity: QualificationIntegrityMetadata;
  metrics: ContextPruningPairedMetrics;
  missingInputs: string[];
  findings: string[];
  upstreamDecision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  advisory: 'INSUFFICIENT EVIDENCE' | null;
  digest: `sha256:${string}`;
}

export class ContextPruningError extends Error {
  constructor(message: string, readonly reason: 'invalid-input' | 'schema' | 'semantic') {
    super(message);
    this.name = 'ContextPruningError';
  }
}

const SHA = /^sha256:[0-9a-f]{64}$/;
const SOURCE_TO_REASON: Partial<Record<ContextPruningSourceKind, ContextProtectedReason>> = {
  system: 'system-rule',
  developer: 'developer-rule',
  project: 'project-rule',
  'security-policy': 'security-policy',
  user: 'current-user-requirement',
  approval: 'action-approval',
  blocker: 'unresolved-blocker',
  provenance: 'provenance-required',
  citation: 'citation-required',
  artifact: 'artifact-pin',
  'test-evidence': 'test-gate-evidence',
  'open-decision': 'open-decision-evidence',
};
const VALID_SOURCE_KINDS = new Set<ContextPruningSourceKind>([
  'system', 'developer', 'project', 'security-policy', 'user', 'approval', 'blocker',
  'provenance', 'citation', 'artifact', 'test-evidence', 'open-decision', 'retrieved',
  'memory', 'tool-output', 'ordinary',
]);
const VALID_PROTECTED_REASONS = new Set<ContextProtectedReason>([
  'system-rule', 'developer-rule', 'project-rule', 'security-policy', 'current-user-requirement',
  'explicit-mention', 'unresolved-blocker', 'action-approval', 'artifact-pin', 'version-pin',
  'digest-pin', 'provenance-required', 'citation-required', 'test-gate-evidence',
  'open-decision-evidence', 'external-evaluation-denied', 'local-only', 'restricted-data', 'legal-policy',
]);

export function contextPruningDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function classifyContextPruningCandidate(candidate: ContextPruningCandidate): ContextProtectedClassification {
  validateContextPruningCandidate(candidate);
  const reasons = new Set<ContextProtectedReason>();
  const mapped = SOURCE_TO_REASON[candidate.source.kind];
  if (mapped) reasons.add(mapped);
  for (const hint of candidate.protectedHints) reasons.add(hint);
  if (candidate.dataPolicy.externalEvaluation === 'denied') reasons.add('external-evaluation-denied');
  if (candidate.dataPolicy.localOnly) reasons.add('local-only');
  if (candidate.dataPolicy.legalAction === 'requires-review') reasons.add('legal-policy');
  if (candidate.sensitivity === 'restricted') reasons.add('restricted-data');
  const sorted = [...reasons].sort();
  const policy = {
    version: CONTEXT_PRUNING_PROTECTED_POLICY_VERSION,
    sourceRules: SOURCE_TO_REASON,
    dataPolicy: ['externalEvaluation', 'localOnly', 'legalAction'],
    sensitivity: ['restricted'],
    protectedHints: [...VALID_PROTECTED_REASONS].sort(),
  };
  return {
    schemaVersion: CONTEXT_PRUNING_PROTECTED_POLICY_VERSION,
    itemId: candidate.itemId,
    protected: sorted.length > 0,
    reasons: sorted,
    policyDigest: contextPruningDigest(policy),
  };
}

export function planContextPruningEvaluations(
  candidates: readonly ContextPruningCandidate[],
  questions: readonly ContextPruningQuestion[],
): ContextPruningEvaluationJob[] {
  const byId = new Map(candidates.map(candidate => [candidate.itemId, candidate]));
  if (byId.size !== candidates.length) throw new ContextPruningError('candidate item IDs must be unique', 'semantic');
  for (const candidate of candidates) validateContextPruningCandidate(candidate);
  const groups = new Map<string, ContextPruningQuestion[]>();
  for (const question of questions) {
    if (!question.id || !question.itemId || !question.subject || !['relevance', 'disposition', 'omission-risk'].includes(question.kind)) {
      throw new ContextPruningError('invalid context pruning question', 'schema');
    }
    const candidate = byId.get(question.itemId);
    if (!candidate) throw new ContextPruningError(`unknown context item '${question.itemId}'`, 'semantic');
    const subject = pruningSubject(candidate);
    if (question.subject !== subject) throw new ContextPruningError('question subject must be the context item subject', 'semantic');
    const key = `${question.itemId}\0${question.batchKey ?? 'default'}`;
    const group = groups.get(key) ?? [];
    group.push(question);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
    const candidate = byId.get(group[0]!.itemId)!;
    const subject = pruningSubject(candidate);
    if (group.some(question => question.itemId !== candidate.itemId || question.subject !== subject)) {
      throw new ContextPruningError('unrelated context chunks cannot share a native batch', 'semantic');
    }
    return {
      subject,
      itemId: candidate.itemId,
      state: { candidateDigest: contextPruningDigest(candidate), itemId: candidate.itemId, locator: candidate.locator },
      questions: [...group].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      contextQuestion: {
        id: `context-pruning:${candidate.itemId}:${group[0]!.batchKey ?? 'default'}`,
        subject,
        compatibilityKey: `context-pruning:${candidate.itemId}:${group[0]!.batchKey ?? 'default'}`,
        entry: { candidateDigest: contextPruningDigest(candidate), questions: group.map(question => question.kind).sort() },
      },
    };
  });
}

export interface ApplyContextPruningInput {
  candidates: readonly ContextPruningCandidate[];
  policy: ContextPruningPolicy;
  evidence?: readonly ContextPruningDecisionEvidence[];
  now?: () => string;
  monitoringRegression?: boolean;
}

export function applyContextPruningPilot(input: ApplyContextPruningInput): ContextPruningRun {
  validatePolicy(input.policy);
  const now = input.now ?? (() => new Date().toISOString());
  const baseline = input.candidates.map(candidate => candidate.itemId);
  const evidence = new Map((input.evidence ?? []).map(item => [item.itemId, item]));
  const disabledReason = input.monitoringRegression ? 'drift-or-monitoring-regression'
    : input.policy.mode === 'disabled' ? 'configured-disabled' : null;
  const mode: ContextPruningRun['mode'] = disabledReason ? 'deterministic-fallback' : input.policy.mode;
  const receipts = input.candidates.map(candidate => {
    validateContextPruningCandidate(candidate);
    const classification = classifyContextPruningCandidate(candidate);
    const itemEvidence = evidence.get(candidate.itemId);
    const decision = decideContextAction(candidate, classification, input.policy, itemEvidence, disabledReason);
    return buildContextPruningReceipt(candidate, classification, decision, mode, now());
  });
  return {
    schemaVersion: 'decision-context-pruning-run/v1',
    mode,
    baselineItemIds: baseline,
    downstreamItemIds: input.policy.mode === 'advisory' && !disabledReason
      ? receipts.filter(receipt => receipt.appliedAction !== 'drop').map(receipt => receipt.itemId)
      : baseline,
    receipts,
    disabledReason,
  };
}

export function renderContextPrompt(items: readonly ContextPruningCandidate[]): string {
  return items.map(item => {
    validateContextPruningCandidate(item);
    return `--- ${item.itemId} ${item.locator}\n${item.content ?? item.contentDigest}`;
  }).join('\n');
}

export function assertShadowPromptByteIdentical(baseline: string, shadow: ContextPruningRun, candidates: readonly ContextPruningCandidate[]): void {
  const byId = new Map(candidates.map(candidate => [candidate.itemId, candidate]));
  const rendered = renderContextPrompt(shadow.downstreamItemIds.map(id => {
    const item = byId.get(id);
    if (!item) throw new ContextPruningError(`missing item '${id}'`, 'semantic');
    return item;
  }));
  if (Buffer.compare(Buffer.from(baseline), Buffer.from(rendered)) !== 0) {
    throw new ContextPruningError('shadow mode changed the downstream prompt bytes', 'semantic');
  }
}

export function validateContextPruningReceipt(receipt: ContextPruningReceipt): ContextPruningReceipt {
  requirePlain(receipt, 'receipt');
  if (receipt.schemaVersion !== CONTEXT_PRUNING_RECEIPT_SCHEMA || !receipt.itemId || !receipt.locator
    || !SHA.test(receipt.originalDigest) || !Number.isSafeInteger(receipt.originalTokenEstimate) || receipt.originalTokenEstimate < 0
    || !['keep', 'drop', 'truncate', 'summarize'].includes(receipt.proposedAction)
    || !['keep', 'drop', 'truncate', 'summarize'].includes(receipt.appliedAction)
    || !(receipt.decisionReceiptDigest === null || SHA.test(receipt.decisionReceiptDigest))
    || !receipt.reversibleReference || receipt.reversibleReference.originalDigest !== receipt.originalDigest
    || !receipt.reversibleReference.locator || !receipt.reversibleReference.restorationPath
    || !SHA.test(receipt.receiptDigest)) {
    throw new ContextPruningError('invalid pruning receipt', 'schema');
  }
  if ((receipt.proposedAction === 'truncate' || receipt.proposedAction === 'summarize')
    && receipt.reason === 'accepted-evidence' && receipt.reversibleReference.transformation === null) {
    throw new ContextPruningError('transformed receipts require a reversible artifact reference', 'semantic');
  }
  if (receipt.reversibleReference.transformation !== null
    && receipt.reversibleReference.transformation.sourceDigest !== receipt.originalDigest) {
    throw new ContextPruningError('transformation source digest must match the original context item', 'semantic');
  }
  const { receiptDigest, ...payload } = receipt;
  if (receiptDigest !== contextPruningDigest(payload)) throw new ContextPruningError('pruning receipt digest mismatch', 'semantic');
  return receipt;
}

export function createContextPruningPreregistration(
  input: Omit<ContextPruningPreregistration, 'schemaVersion' | 'digest'>,
): ContextPruningPreregistration {
  const payload = { schemaVersion: CONTEXT_PRUNING_PREREGISTRATION_SCHEMA, ...input } satisfies Omit<ContextPruningPreregistration, 'digest'>;
  return validateContextPruningPreregistration({ ...payload, digest: contextPruningDigest(payload) });
}

export function validateContextPruningPreregistration(value: ContextPruningPreregistration): ContextPruningPreregistration {
  requirePlain(value, 'preregistration');
  const t = value.thresholds;
  if (value.schemaVersion !== CONTEXT_PRUNING_PREREGISTRATION_SCHEMA || !value.id
    || !Number.isFinite(Date.parse(value.registeredAt))
    || (value.holdoutAccessedAt !== null && (!Number.isFinite(Date.parse(value.holdoutAccessedAt))
      || Date.parse(value.holdoutAccessedAt) <= Date.parse(value.registeredAt)))
    || t.protectedRetentionBps !== 10_000
    || !['wilson', 'bootstrap'].includes(t.confidenceInterval.method)
    || !Number.isSafeInteger(t.confidenceInterval.levelBps) || t.confidenceInterval.levelBps < 5_000 || t.confidenceInterval.levelBps > 9_999
    || !Number.isSafeInteger(t.minimumOverallN) || t.minimumOverallN < 1
    || !Number.isSafeInteger(t.minimumSliceN) || t.minimumSliceN < 1
    || (t.powerRule !== null && !t.powerRule.trim())
    || !Number.isFinite(t.qualityNonInferiorityMarginBps) || t.qualityNonInferiorityMarginBps > 0
    || !Number.isSafeInteger(t.positiveTotalTokenTarget) || t.positiveTotalTokenTarget <= 0
    || !Number.isFinite(t.positiveTotalCostTargetUsd) || t.positiveTotalCostTargetUsd <= 0) {
    throw new ContextPruningError('invalid context pruning preregistration', 'schema');
  }
  const { digest, ...payload } = value;
  if (digest !== contextPruningDigest(payload)) throw new ContextPruningError('preregistration digest mismatch', 'semantic');
  return value;
}

export function buildContextPruningEvaluationReport(input: {
  preregistration: ContextPruningPreregistration;
  integrity: QualificationIntegrityMetadata;
  metrics: ContextPruningPairedMetrics;
  missingInputs?: readonly string[];
}): ContextPruningEvaluationReport {
  const preregistration = validateContextPruningPreregistration(input.preregistration);
  validateMetrics(input.metrics);
  const findings = new Set<string>();
  const missing = new Set(input.missingInputs ?? []);
  if (input.metrics.sampleN < preregistration.thresholds.minimumOverallN) findings.add('insufficient-overall-sample');
  for (const [slice, count] of Object.entries(input.metrics.sliceCounts)) {
    if (count < preregistration.thresholds.minimumSliceN) findings.add(`insufficient-slice:${slice}`);
  }
  if (input.metrics.protectedRetentionBps < 10_000) findings.add('protected-retention-breach');
  const qualityDeltas = [
    input.metrics.downstreamTaskSuccessDeltaBps,
    input.metrics.requirementCoverageDeltaBps,
    input.metrics.factualCoverageDeltaBps,
    input.metrics.citationAccuracyDeltaBps,
    input.metrics.humanPreferenceDeltaBps,
  ];
  if (qualityDeltas.some(value => value === null)) findings.add('quality-metric-missing');
  if (qualityDeltas.some(value => value !== null && value < preregistration.thresholds.qualityNonInferiorityMarginBps)) findings.add('quality-non-inferiority-failed');
  const providerNetTokens = input.metrics.providerUsage.inputTokens + input.metrics.providerUsage.outputTokens;
  const estimatorNetTokens = input.metrics.estimatorUsage.inputTokens + input.metrics.estimatorUsage.outputTokens;
  if (providerNetTokens < preregistration.thresholds.positiveTotalTokenTarget) findings.add('provider-token-target-not-met');
  if (estimatorNetTokens < preregistration.thresholds.positiveTotalTokenTarget) findings.add('estimator-token-target-not-met');
  if (input.metrics.providerUsage.costUsd === null || input.metrics.providerUsage.costUsd < preregistration.thresholds.positiveTotalCostTargetUsd) {
    findings.add('provider-cost-target-not-met');
  }
  if (input.integrity.integrity_state !== 'verified') findings.add('integrity-not-verified');
  if (input.integrity.release_gate.decision === 'ROLLBACK') findings.add('upstream-rollback');
  if (input.integrity.release_gate.decision === 'HOLD') findings.add('upstream-hold');
  for (const name of missing) findings.add(`missing-input:${name}`);
  const upstreamDecision = input.integrity.release_gate.decision;
  const decision = upstreamDecision === 'ROLLBACK' || input.metrics.protectedRetentionBps < 10_000 ? 'ROLLBACK'
    : upstreamDecision === 'HOLD' || findings.size > 0 ? 'HOLD' : 'PROMOTE';
  const advisory = [...findings].some(item => item.startsWith('insufficient-') || item === 'quality-metric-missing' || item.startsWith('missing-input:'))
    ? 'INSUFFICIENT EVIDENCE' : null;
  const payload: Omit<ContextPruningEvaluationReport, 'digest'> = {
    schemaVersion: CONTEXT_PRUNING_EVALUATION_REPORT_SCHEMA,
    preregistration,
    integrity: input.integrity,
    metrics: input.metrics,
    missingInputs: [...missing].sort(),
    findings: [...findings].sort(),
    upstreamDecision,
    decision,
    advisory,
  };
  return { ...payload, digest: contextPruningDigest(payload) };
}

function pruningSubject(candidate: ContextPruningCandidate): string {
  return `context-item:${candidate.itemId}`;
}

function decideContextAction(
  candidate: ContextPruningCandidate,
  classification: ContextProtectedClassification,
  policy: ContextPruningPolicy,
  evidence: ContextPruningDecisionEvidence | undefined,
  disabledReason: ContextPruningRun['disabledReason'],
): ContextPruningActionDecision {
  if (classification.protected) return { proposedAction: 'keep', appliedAction: 'keep', mode: policy.mode,
    reason: 'protected-item', decisionReceiptDigest: null, transformation: null };
  if (disabledReason) return fallback(candidate, disabledReason === 'configured-disabled' ? 'disabled' : 'drift-or-monitoring-regression');
  if (policy.mode === 'disabled') return fallback(candidate, 'disabled');
  if (!evidence || evidence.itemId !== candidate.itemId || evidence.subject !== pruningSubject(candidate)) return fallback(candidate, 'invalid-evidence');
  if (evidence.status === 'cancelled') return fallback(candidate, 'cancelled');
  if (evidence.status === 'incomplete') return fallback(candidate, 'incomplete-state');
  if (evidence.status === 'uncalibrated') return fallback(candidate, 'uncalibrated');
  if (evidence.status === 'drifted') return fallback(candidate, 'drift-or-monitoring-regression');
  if (evidence.status === 'failed') return fallback(candidate, 'evaluation-failed');
  if ((policy.modelIdentityDigest !== null && evidence.modelIdentityDigest !== policy.modelIdentityDigest)
    || (policy.calibrationDigest !== null && evidence.calibrationDigest !== policy.calibrationDigest)) {
    return fallback(candidate, 'drift-or-monitoring-regression');
  }
  const confidenceBps = evidence.confidenceBps;
  const marginBps = evidence.marginBps;
  if (evidence.status !== 'success' || evidence.disagreement || evidence.proposedAction === undefined
    || typeof confidenceBps !== 'number' || typeof marginBps !== 'number'
    || !Number.isSafeInteger(confidenceBps) || !Number.isSafeInteger(marginBps)
    || confidenceBps < policy.minimumConfidenceBps || marginBps < policy.minimumMarginBps
    || evidence.calibrated !== true || !evidence.decisionReceiptDigest || !SHA.test(evidence.decisionReceiptDigest)) {
    return fallback(candidate, evidence.status === 'uncertain' ? 'uncertain-evidence' : 'invalid-evidence');
  }
  const proposed = evidence.proposedAction;
  if (!policy.allowedDestructiveActions.includes(proposed) && proposed !== 'keep') return fallback(candidate, 'policy-denied-action');
  if ((proposed === 'truncate' || proposed === 'summarize') && !validTransformation(evidence.transformation, proposed, candidate.contentDigest)) {
    return fallback(candidate, 'unsupported-transformation');
  }
  return {
    proposedAction: proposed,
    appliedAction: policy.mode === 'shadow' ? 'keep' : proposed,
    mode: policy.mode,
    reason: policy.mode === 'shadow' && proposed !== 'keep' ? 'shadow-only' : 'accepted-evidence',
    decisionReceiptDigest: evidence.decisionReceiptDigest,
    transformation: evidence.transformation ?? null,
  };
}

function fallback(candidate: ContextPruningCandidate, reason: ContextPruningReceipt['reason']) {
  const action = candidate.deterministicFallbackAction ?? 'keep';
  return {
    proposedAction: action,
    appliedAction: action,
    mode: 'deterministic-fallback' as const,
    reason: reason === 'disabled' ? 'disabled' as const
      : ['invalid-evidence', 'uncertain-evidence', 'uncalibrated', 'incomplete-state', 'cancelled', 'evaluation-failed',
        'drift-or-monitoring-regression', 'unsupported-transformation', 'policy-denied-action'].includes(reason)
        ? reason : 'prior-deterministic-fallback' as const,
    decisionReceiptDigest: null,
    transformation: null,
  };
}

function buildContextPruningReceipt(
  candidate: ContextPruningCandidate,
  classification: ContextProtectedClassification,
  decision: ContextPruningActionDecision,
  runMode: ContextPruningRun['mode'],
  createdAt: string,
): ContextPruningReceipt {
  const transformation = decision.transformation ?? null;
  const payload = {
    schemaVersion: CONTEXT_PRUNING_RECEIPT_SCHEMA,
    itemId: candidate.itemId,
    locator: candidate.locator,
    originalDigest: candidate.contentDigest,
    originalTokenEstimate: candidate.tokenEstimate,
    classification,
    proposedAction: decision.proposedAction,
    appliedAction: decision.appliedAction,
    mode: runMode,
    reason: decision.reason,
    decisionReceiptDigest: decision.decisionReceiptDigest,
    reversibleReference: {
      locator: candidate.locator,
      originalDigest: candidate.contentDigest,
      restorationPath: candidate.locator,
      transformation,
    },
    createdAt,
  } satisfies Omit<ContextPruningReceipt, 'receiptDigest'>;
  return validateContextPruningReceipt({ ...payload, receiptDigest: contextPruningDigest(payload) });
}

function validTransformation(value: ContextTransformationReference | undefined, action: 'truncate' | 'summarize', sourceDigest: string): boolean {
  return Boolean(value && value.action === action && value.qualityCheck === 'passed'
    && value.sourceDigest === sourceDigest && value.locator && SHA.test(value.digest));
}

function validateContextPruningCandidate(candidate: ContextPruningCandidate): void {
  requirePlain(candidate, 'candidate');
  if (candidate.schemaVersion !== CONTEXT_PRUNING_CANDIDATE_SCHEMA || !candidate.itemId || !candidate.locator
    || !SHA.test(candidate.contentDigest) || !candidate.source || !VALID_SOURCE_KINDS.has(candidate.source.kind) || !candidate.source.addedAt
    || !Number.isFinite(Date.parse(candidate.source.addedAt))
    || (candidate.content !== undefined && contextPruningDigest(candidate.content) !== candidate.contentDigest)
    || !Number.isSafeInteger(candidate.tokenEstimate) || candidate.tokenEstimate < 0
    || !Number.isFinite(candidate.priority) || candidate.priority < 0 || candidate.priority > 1
    || !['verified', 'untrusted'].includes(candidate.trust)
    || !['public', 'internal', 'confidential', 'restricted'].includes(candidate.sensitivity)
    || !Array.isArray(candidate.dependencies) || new Set(candidate.dependencies).size !== candidate.dependencies.length
    || candidate.dependencies.some(value => typeof value !== 'string' || !value)
    || !Array.isArray(candidate.protectedHints) || new Set(candidate.protectedHints).size !== candidate.protectedHints.length
    || candidate.protectedHints.some(reason => !VALID_PROTECTED_REASONS.has(reason))
    || !candidate.taskSubject || !candidate.dataPolicy
    || !['allowed', 'denied'].includes(candidate.dataPolicy.externalEvaluation)
    || typeof candidate.dataPolicy.localOnly !== 'boolean'
    || !['none', 'requires-review'].includes(candidate.dataPolicy.legalAction)
    || (candidate.deterministicFallbackAction !== undefined && !['keep', 'drop', 'truncate', 'summarize'].includes(candidate.deterministicFallbackAction))) {
    throw new ContextPruningError('invalid context candidate', 'schema');
  }
  try { admitEntry(candidate); } catch {
    throw new ContextPruningError('context candidate failed admission', 'schema');
  }
}

function validatePolicy(policy: ContextPruningPolicy): void {
  if (!['disabled', 'shadow', 'advisory'].includes(policy.mode)
    || !Number.isSafeInteger(policy.minimumConfidenceBps) || policy.minimumConfidenceBps < 0 || policy.minimumConfidenceBps > 10_000
    || !Number.isSafeInteger(policy.minimumMarginBps) || policy.minimumMarginBps < 0 || policy.minimumMarginBps > 10_000
    || !Array.isArray(policy.allowedDestructiveActions)
    || policy.allowedDestructiveActions.some(action => !['keep', 'drop', 'truncate', 'summarize'].includes(action))
    || (policy.calibrationDigest !== null && !SHA.test(policy.calibrationDigest))
    || (policy.modelIdentityDigest !== null && !SHA.test(policy.modelIdentityDigest))) {
    throw new ContextPruningError('invalid context pruning policy', 'schema');
  }
}

function validateMetrics(metrics: ContextPruningPairedMetrics): void {
  if (!Number.isSafeInteger(metrics.sampleN) || metrics.sampleN < 0
    || Object.values(metrics.sliceCounts).some(value => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(metrics.protectedRetentionBps) || metrics.protectedRetentionBps < 0 || metrics.protectedRetentionBps > 10_000
    || metrics.sharedStateAccounting !== 'request-owned-once' && metrics.sharedStateAccounting !== 'not-applicable'
    || !usage(metrics.providerUsage) || !usage(metrics.estimatorUsage)
    || !Number.isSafeInteger(metrics.totalCalls) || metrics.totalCalls < 0
    || !Number.isSafeInteger(metrics.promptCache.hits) || !Number.isSafeInteger(metrics.promptCache.misses)
    || !Number.isSafeInteger(metrics.promptCache.avoidedPromptTokens)) {
    throw new ContextPruningError('invalid context pruning metrics', 'schema');
  }
}

function usage(value: ContextPruningPairedMetrics['providerUsage']): boolean {
  return Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0
    && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0
    && (value.costUsd === null || Number.isFinite(value.costUsd));
}

function requirePlain(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ContextPruningError(`${label} must be a plain object`, 'schema');
  }
}
