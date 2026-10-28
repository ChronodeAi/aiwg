// Context pruning pilot classification, decisions, receipts and deterministic baseline.
import { ContextBudgetManager, type BudgetConfig, type ContextItem } from '../metrics/context-budget.js';
import { admitEntry } from './entry.js';
import { ContextPruningError, SHA, contextPruningDigest, contextPruningRunId, requirePlain } from './context-pruning-common.js';
import {
  CONTEXT_PRUNING_PROTECTED_POLICY_VERSION,
  CONTEXT_PRUNING_CANDIDATE_SCHEMA,
  CONTEXT_PRUNING_RECEIPT_SCHEMA,
  type ContextPruningSourceKind,
  type ContextPruningAction,
  type ContextProtectedReason,
  type ContextPruningCandidate,
  type ContextProtectedClassification,
  type ContextPruningDecisionEvidence,
  type ContextTransformationReference,
  type ContextPruningPolicy,
  type ContextPruningReceipt,
  type ContextPruningRun,
  type ContextPruningActionDecision,
  type ContextPruningQuestion,
  type ContextPruningEvaluationJob,
  type ContextPruningEvaluationPlan,
  type ContextBudgetManagerBaseline
} from './context-pruning-types.js';

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
  'open-decision-evidence', 'protected-dependency', 'external-evaluation-denied', 'local-only',
  'restricted-data', 'legal-policy',
]);

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

export function classifyContextPruningCandidates(
  candidates: readonly ContextPruningCandidate[],
): Map<string, ContextProtectedClassification> {
  const byId = uniqueCandidates(candidates);
  const classifications = new Map<string, ContextProtectedClassification>();
  for (const candidate of candidates) classifications.set(candidate.itemId, classifyContextPruningCandidate(candidate));
  const protectedQueue = candidates.filter(candidate => classifications.get(candidate.itemId)!.protected)
    .map(candidate => candidate.itemId);
  for (let index = 0; index < protectedQueue.length; index++) {
    const item = byId.get(protectedQueue[index]!)!;
    for (const dependencyId of item.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new ContextPruningError(`unknown context dependency '${dependencyId}'`, 'semantic');
      const current = classifications.get(dependencyId)!;
      if (current.reasons.includes('protected-dependency')) continue;
      classifications.set(dependencyId, {
        ...current,
        protected: true,
        reasons: [...new Set([...current.reasons, 'protected-dependency' as const])].sort(),
      });
      protectedQueue.push(dependencyId);
    }
  }
  return classifications;
}

export function planContextPruningEvaluations(
  candidates: readonly ContextPruningCandidate[],
  questions: readonly ContextPruningQuestion[],
): ContextPruningEvaluationJob[] {
  return planContextPruningEvaluationRun(candidates, questions).jobs;
}

export function planContextPruningEvaluationRun(
  candidates: readonly ContextPruningCandidate[],
  questions: readonly ContextPruningQuestion[],
): ContextPruningEvaluationPlan {
  const byId = uniqueCandidates(candidates);
  const classifications = classifyContextPruningCandidates(candidates);
  const exclusions = [...classifications.values()]
    .filter(classification => classification.protected)
    .map(classification => ({ itemId: classification.itemId, reasons: [...classification.reasons].sort() }));
  const excluded = new Set(exclusions.map(item => item.itemId));
  const groups = new Map<string, ContextPruningQuestion[]>();
  for (const question of questions) {
    if (!question.id || !question.itemId || !question.subject || !['relevance', 'disposition', 'omission-risk'].includes(question.kind)) {
      throw new ContextPruningError('invalid context pruning question', 'schema');
    }
    const candidate = byId.get(question.itemId);
    if (!candidate) throw new ContextPruningError(`unknown context item '${question.itemId}'`, 'semantic');
    if (excluded.has(candidate.itemId)) continue;
    const subject = pruningSubject(candidate);
    if (question.subject !== subject) throw new ContextPruningError('question subject must be the context item subject', 'semantic');
    const key = `${question.itemId}\0${question.batchKey ?? 'default'}`;
    const group = groups.get(key) ?? [];
    group.push(question);
    groups.set(key, group);
  }
  const jobs = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
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
  return { jobs, exclusions };
}

export interface ApplyContextPruningInput {
  candidates: readonly ContextPruningCandidate[];
  policy: ContextPruningPolicy;
  evidence?: readonly ContextPruningDecisionEvidence[];
  now?: () => string;
  monitoringRegression?: boolean;
  /**
   * When set, the existing deterministic ContextBudgetManager selection under this budget is the prior
   * deterministic fallback, and every candidate must carry its host-owned content. When absent, the prior
   * behavior is "no pruning", so the fallback proposal is keep.
   */
  budget?: Partial<BudgetConfig>;
  /** The frozen evaluation pair this run serves; recorded on the run and every receipt. */
  pairId?: string;
}

export function applyContextPruningPilot(input: ApplyContextPruningInput): ContextPruningRun {
  validatePolicy(input.policy);
  if (input.pairId !== undefined && (typeof input.pairId !== 'string' || !input.pairId)) {
    throw new ContextPruningError('pairId must be a non-empty string', 'invalid-input');
  }
  const pairId = input.pairId ?? null;
  const now = input.now ?? (() => new Date().toISOString());
  const baseline = input.candidates.map(candidate => candidate.itemId);
  const evidence = new Map((input.evidence ?? []).map(item => [item.itemId, item]));
  const disabledReason = input.monitoringRegression ? 'drift-or-monitoring-regression'
    : input.policy.mode === 'disabled' ? 'configured-disabled' : null;
  const mode: ContextPruningRun['mode'] = disabledReason ? 'deterministic-fallback' : input.policy.mode;
  const classifications = classifyContextPruningCandidates(input.candidates);
  const runId = contextPruningRunId(pairId, input.candidates);
  const deterministicBaseline = input.budget === undefined ? null
    : computeContextBudgetManagerBaseline(input.candidates, input.budget);
  const deterministicDrops = new Set(deterministicBaseline?.droppedItemIds ?? []);
  const receipts = input.candidates.map(candidate => {
    validateContextPruningCandidate(candidate);
    const classification = classifications.get(candidate.itemId)!;
    const itemEvidence = evidence.get(candidate.itemId);
    const fallbackAction: ContextPruningAction = deterministicDrops.has(candidate.itemId) ? 'drop' : 'keep';
    const decision = decideContextAction(candidate, classification, input.policy, itemEvidence, disabledReason, fallbackAction);
    return buildContextPruningReceipt(candidate, classification, decision, now(), runId, pairId);
  });
  return {
    schemaVersion: 'decision-context-pruning-run/v1',
    runId,
    pairId,
    mode,
    baselineItemIds: baseline,
    // A distinct array: callers that mutate one list cannot silently alter the other.
    downstreamItemIds: [...baseline],
    receipts,
    disabledReason,
    deterministicBaseline,
  };
}

/**
 * Validates a receipt's shape and self-digest. When the run's candidate envelopes are supplied, it also
 * re-derives the run identity and the protected-item classification and refuses any mismatch, so a
 * relabelled receipt with a recomputed digest, or a receipt from another run, is rejected.
 */
export function validateContextPruningReceipt(
  receipt: ContextPruningReceipt,
  candidates?: readonly ContextPruningCandidate[],
): ContextPruningReceipt {
  requirePlain(receipt, 'receipt');
  if (receipt.schemaVersion !== CONTEXT_PRUNING_RECEIPT_SCHEMA || !receipt.itemId || !receipt.locator
    || typeof receipt.runId !== 'string' || !SHA.test(receipt.runId)
    || !(receipt.pairId === null || (typeof receipt.pairId === 'string' && receipt.pairId))
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
  if (candidates !== undefined) {
    const candidate = candidates.find(item => item.itemId === receipt.itemId);
    if (!candidate || receipt.runId !== contextPruningRunId(receipt.pairId, candidates)
      || receipt.originalDigest !== candidate.contentDigest || receipt.locator !== candidate.locator
      || receipt.originalTokenEstimate !== candidate.tokenEstimate) {
      throw new ContextPruningError('pruning receipt is not bound to the evaluated run', 'semantic');
    }
    const derived = classifyContextPruningCandidates(candidates).get(candidate.itemId)!;
    if (contextPruningDigest(derived) !== contextPruningDigest(receipt.classification)) {
      throw new ContextPruningError('pruning receipt classification does not match the candidate envelope', 'semantic');
    }
    // A protected item is never proposed for, or subjected to, a destructive action by this pilot.
    if (derived.protected && (receipt.proposedAction !== 'keep' || receipt.appliedAction !== 'keep')) {
      throw new ContextPruningError('pruning receipt classification does not match its protected action', 'semantic');
    }
  }
  return receipt;
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
  fallbackAction: ContextPruningAction,
): ContextPruningActionDecision {
  if (classification.protected) return { proposedAction: 'keep', appliedAction: 'keep',
    mode: disabledReason ? 'deterministic-fallback' : policy.mode,
    reason: 'protected-item', decisionReceiptDigest: null, transformation: null };
  const fallback = (reason: ContextPruningReceipt['reason']) => deterministicFallback(fallbackAction, reason);
  if (disabledReason) return fallback(disabledReason === 'configured-disabled' ? 'disabled' : 'drift-or-monitoring-regression');
  if (policy.mode === 'disabled') return fallback('disabled');
  if (!evidence || evidence.itemId !== candidate.itemId || evidence.subject !== pruningSubject(candidate)) return fallback('invalid-evidence');
  if (evidence.status === 'cancelled') return fallback('cancelled');
  if (evidence.status === 'incomplete') return fallback('incomplete-state');
  if (evidence.status === 'uncalibrated') return fallback('uncalibrated');
  if (evidence.status === 'drifted') return fallback('drift-or-monitoring-regression');
  if (evidence.status === 'failed') return fallback('evaluation-failed');
  if (policy.modelIdentityDigest === null || policy.calibrationDigest === null
    || evidence.modelIdentityDigest === undefined || evidence.calibrationDigest === undefined
    || evidence.modelIdentityDigest !== policy.modelIdentityDigest || evidence.calibrationDigest !== policy.calibrationDigest) {
    return fallback('drift-or-monitoring-regression');
  }
  const confidenceBps = evidence.confidenceBps;
  const marginBps = evidence.marginBps;
  if (evidence.status !== 'success' || evidence.disagreement || evidence.proposedAction === undefined
    || typeof confidenceBps !== 'number' || typeof marginBps !== 'number'
    || !Number.isSafeInteger(confidenceBps) || !Number.isSafeInteger(marginBps)
    || confidenceBps < policy.minimumConfidenceBps || marginBps < policy.minimumMarginBps
    || evidence.calibrated !== true || !evidence.decisionReceiptDigest || !SHA.test(evidence.decisionReceiptDigest)) {
    return fallback(evidence.status === 'uncertain' ? 'uncertain-evidence' : 'invalid-evidence');
  }
  const proposed = evidence.proposedAction;
  if (!policy.allowedDestructiveActions.includes(proposed) && proposed !== 'keep') return fallback('policy-denied-action');
  if ((proposed === 'truncate' || proposed === 'summarize') && !validTransformation(evidence.transformation, proposed, candidate.contentDigest)) {
    return fallback('unsupported-transformation');
  }
  return {
    proposedAction: proposed,
    appliedAction: 'keep',
    mode: policy.mode,
    reason: policy.mode === 'shadow' && proposed !== 'keep' ? 'shadow-only' : 'accepted-evidence',
    decisionReceiptDigest: evidence.decisionReceiptDigest,
    transformation: evidence.transformation ?? null,
  };
}

function deterministicFallback(action: ContextPruningAction, reason: ContextPruningReceipt['reason']) {
  return {
    proposedAction: action,
    appliedAction: 'keep' as const,
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
  createdAt: string,
  runId: `sha256:${string}`,
  pairId: string | null,
): ContextPruningReceipt {
  const transformation = decision.transformation ?? null;
  const payload = {
    schemaVersion: CONTEXT_PRUNING_RECEIPT_SCHEMA,
    runId,
    pairId,
    itemId: candidate.itemId,
    locator: candidate.locator,
    originalDigest: candidate.contentDigest,
    originalTokenEstimate: candidate.tokenEstimate,
    classification,
    proposedAction: decision.proposedAction,
    appliedAction: decision.appliedAction,
    mode: decision.mode,
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

export function computeContextBudgetManagerBaseline(
  candidates: readonly ContextPruningCandidate[],
  config?: Partial<BudgetConfig>,
): ContextBudgetManagerBaseline {
  const manager = new ContextBudgetManager(process.cwd(), config);
  for (const candidate of candidates) {
    validateContextPruningCandidate(candidate);
    // ContextBudgetManager sizes item text itself; sizing the digest string would understate real content.
    if (candidate.content === undefined) {
      throw new ContextPruningError(`ContextBudgetManager baseline requires host-owned content for '${candidate.itemId}'`, 'invalid-input');
    }
    // The envelope priority is passed as ContextBudgetManager similarity; the manager derives its own priority.
    manager.addItem(candidate.itemId, candidate.content, sourceTypeForBudget(candidate), candidate.priority);
  }
  const result = manager.degrade();
  // ContextBudgetManager spares only source type 'system'; protected (and dependency-protected) items are
  // retained here so the drop list can be applied as the fallback without removing protected context.
  const classifications = classifyContextPruningCandidates(candidates);
  const isProtected = (id: string) => classifications.get(id)!.protected;
  const byId = new Map([...result.kept, ...result.dropped].map(item => [item.id, item]));
  const droppedIds = new Set(result.dropped.filter(item => !isProtected(item.id)).map(item => item.id));
  // Re-adding protected items can exceed the manager's target, so continue its own rule (ascending priority,
  // never system items) over the remaining unprotected items until the target is met or none remain.
  const target = Math.floor(manager.contextBudget * manager.getConfig().warningThreshold);
  let current = candidates.reduce((sum, candidate) => sum + (droppedIds.has(candidate.itemId) ? 0 : byId.get(candidate.itemId)!.tokens), 0);
  const remaining = candidates.map(candidate => byId.get(candidate.itemId)!)
    .filter(item => !droppedIds.has(item.id) && !isProtected(item.id) && item.source.type !== 'system')
    .sort((a, b) => a.priority - b.priority);
  for (const item of remaining) {
    if (current <= target) break;
    droppedIds.add(item.id);
    current -= item.tokens;
  }
  const kept = candidates.map(candidate => byId.get(candidate.itemId)!).filter(item => !droppedIds.has(item.id));
  const dropped = candidates.map(candidate => byId.get(candidate.itemId)!).filter(item => droppedIds.has(item.id));
  return {
    source: 'ContextBudgetManager',
    usage: {
      inputTokens: kept.reduce((sum, item) => sum + item.tokens, 0),
      cachedInputTokens: null,
      outputTokens: 0,
      costUsd: null,
    },
    keptItemIds: kept.map(item => item.id).sort(),
    droppedItemIds: dropped.map(item => item.id).sort(),
    protectedRetainedItemIds: result.dropped.filter(item => isProtected(item.id)).map(item => item.id).sort(),
    tokensFreed: dropped.reduce((sum, item) => sum + item.tokens, 0),
    withinBudget: current <= target,
  };
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
    || !['none', 'requires-review'].includes(candidate.dataPolicy.legalAction)) {
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

function sourceTypeForBudget(candidate: ContextPruningCandidate): ContextItem['source']['type'] {
  if (candidate.source.kind === 'system' || candidate.source.kind === 'developer' || candidate.source.kind === 'project') return 'system';
  if (candidate.source.kind === 'user') return 'user';
  if (candidate.protectedHints.includes('explicit-mention')) return 'at-mention';
  return 'auto';
}

export function uniqueCandidates(candidates: readonly ContextPruningCandidate[]): Map<string, ContextPruningCandidate> {
  const byId = new Map(candidates.map(candidate => [candidate.itemId, candidate]));
  if (byId.size !== candidates.length) throw new ContextPruningError('candidate item IDs must be unique', 'semantic');
  for (const candidate of candidates) validateContextPruningCandidate(candidate);
  for (const candidate of candidates) {
    for (const dependencyId of candidate.dependencies) {
      if (!byId.has(dependencyId)) throw new ContextPruningError(`unknown context dependency '${dependencyId}'`, 'semantic');
    }
  }
  return byId;
}

