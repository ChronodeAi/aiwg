/**
 * TV-12 promotion steps after collection (#2681): record the reviewer-approved profile and margin chosen
 * by the preregistered rule, then run an enforce-mode canary with an exercised rollback to single calls.
 * Neither step changes a default: enforcement still needs a caller to pass the recorded qualification.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';
import { CanonicalJsonByteEstimator, ContextPlanError, planDecisionContext, type ContextProviderProfile, type ContextActualUsageEvidence } from './context-plan.js';
import { assertContextQualified, compareContextUsage, type ContextComparison, type ContextQualification } from './context-qualification.js';
import {
  assertContextArtifactRoot, assertContextLiveSource, compileContextLiveCase, contextLiveBinding, contextLiveDigest, contextLiveRequestCapacity,
  contextLiveRuleset, contextLiveTarget, ContextLiveBudget, validateContextLiveApproval, withContextLiveSpendLedger, TV12_ISSUE_USD_CAP,
  type ContextLiveApproval, type ContextLiveCorpus, type ContextLiveHost, type ContextLiveRecord,
} from './context-live-qualification.js';
import { JevDecisionAdapter } from './adapters/jev.js';
import { decisionBatchQuestionId } from './batch.js';
import { evaluateDecisionRuleset } from './evaluate.js';
import type { DecisionDefinition } from './types.js';

const estimator = new CanonicalJsonByteEstimator();
const subject = 'synthetic-tv12';
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sha256 = /^sha256:[a-f0-9]{64}$/;
const closed = (value: unknown, keys: string[]): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** The reviewer's signed choice. It must equal the preregistered rule's output, not a free choice. */
export interface ContextMarginReview {
  schemaVersion: 'context-margin-review/v1'; approved: true; reviewer: string; approvalReference: string;
  runId: string; recordsDigest: string; selectedMarginBps: number; qualifiedProfile: { id: string; version: string };
}
export interface ContextQualificationRecord {
  schemaVersion: 'context-qualification-record/v1'; runId: string; sourceCommit: string; model: string; region: string;
  corpusDigest: string; preregistrationDigest: string; approvalDigest: string; recordsDigest: string;
  collectionProfileDigest: string; marginRule: ContextLiveApproval['marginRule'];
  selection: { worstUndercountBps: number; extraReserveBps: number; candidateMarginBps: number; maximumMarginBps: number };
  review: ContextMarginReview; profile: ContextProviderProfile; profileDigest: string; qualification: ContextQualification;
}

export const contextLiveRecordsDigest = (records: readonly ContextLiveRecord[]) => contextLiveDigest([...records]
  .sort((a, b) => `${a.caseId}\0${a.partitionId}`.localeCompare(`${b.caseId}\0${b.partitionId}`, 'en')));

/** Rebinds every retained comparison to the frozen corpus and returns exactly one complete provider request per partition. */
async function boundComparisons(approval: ContextLiveApproval, corpus: ContextLiveCorpus, records: readonly ContextLiveRecord[]): Promise<ContextComparison[]> {
  const samples: ContextComparison[] = [];
  const used = new Set<ContextLiveRecord>();
  for (const item of corpus.cases) {
    const { input } = await compileContextLiveCase(item, approval.model, approval.region);
    let plan;
    try { plan = planDecisionContext(input, corpus.profile, estimator); }
    catch (error) { if (error instanceof ContextPlanError && ['oversized-state', 'oversized-question'].includes(error.reason)) continue; throw error; }
    for (const partition of plan.partitions) {
      const partitionInput = { ...input, questions: input.questions.filter(q => partition.questionIds.includes(q.id)) };
      const checked = planDecisionContext(partitionInput, corpus.profile, estimator);
      const matches = records.filter(r => r.caseId === item.id && r.partitionId === partition.id);
      const record = matches[0];
      const usage = record && { source: record.source, servedModel: record.servedModel, requestId: record.requestId,
        inputTokens: record.inputTokens, outputTokens: record.outputTokens, costUsd: record.costUsd };
      if (matches.length !== 1 || !record || checked.partitions.length !== 1 || record.source !== 'provider' || record.servedModel !== approval.model
        || record.planDigest !== checked.planDigest || record.profileDigest !== checked.providerProfile.digest
        || record.estimator.id !== estimator.id || record.estimator.version !== estimator.version
        || record.estimatedInputTokens !== checked.partitions[0]!.estimate.aggregateTokens
        || record.actualInputTokens !== record.inputTokens || record.usageArtifactDigest !== contextLiveDigest(usage)
        || record.usageRef !== `usage:${record.usageArtifactDigest}`) {
        throw new ContextPlanError('invalid-input', 'retained comparison does not bind to the frozen corpus partition');
      }
      used.add(record);
      samples.push({ caseId: `${item.id}:${partition.id}`, input: partitionInput, actualInputTokens: record.actualInputTokens, source: 'provider', usageRef: record.usageRef });
    }
  }
  if (!samples.length || used.size !== records.length) throw new ContextPlanError('invalid-input', 'retained comparisons must cover exactly the planned partitions');
  return samples;
}

/**
 * Applies the preregistered rule (worst observed undercount plus the frozen reserve, capped by the frozen
 * maximum) and records the reviewer's matching approval. Synthetic, partial or unbound evidence throws.
 */
export async function recordContextQualification(options: { approval: ContextLiveApproval; corpus: ContextLiveCorpus;
  records: readonly ContextLiveRecord[]; review: ContextMarginReview }): Promise<ContextQualificationRecord> {
  const approval = structuredClone(options.approval), corpus = structuredClone(options.corpus);
  const records = structuredClone(options.records), review = structuredClone(options.review);
  validateContextLiveApproval(approval, corpus);
  admitEntry(review);
  const { marginRule } = approval;
  // A selected margin above the collection margin could split a request that was collected whole.
  if (corpus.profile.safetyMarginBps < marginRule.maximumMarginBps) throw new ContextPlanError('invalid-profile', 'collection margin must cover the preregistered maximum');
  const samples = await boundComparisons(approval, corpus, records);
  const observed = compareContextUsage(samples, corpus.profile, estimator);
  for (const row of observed.cases) {
    const [caseId, partitionId] = row.caseId.split(':');
    if (records.find(r => r.caseId === caseId && r.partitionId === partitionId)!.undercountBps !== row.undercountBps) {
      throw new ContextPlanError('invalid-input', 'retained undercount differs from recomputation');
    }
  }
  const candidateMarginBps = observed.worstUndercountBps + marginRule.extraReserveBps;
  if (candidateMarginBps > marginRule.maximumMarginBps) {
    throw new ContextPlanError('rollout-unqualified', 'observed undercount exceeds the preregistered maximum margin');
  }
  const recordsDigest = contextLiveRecordsDigest(records);
  if (!closed(review, ['schemaVersion', 'approved', 'reviewer', 'approvalReference', 'runId', 'recordsDigest', 'selectedMarginBps', 'qualifiedProfile'])
    || !closed(review.qualifiedProfile, ['id', 'version']) || review.schemaVersion !== 'context-margin-review/v1' || review.approved !== true
    || !nonblank(review.reviewer) || !nonblank(review.approvalReference) || review.runId !== approval.runId || review.recordsDigest !== recordsDigest
    || review.selectedMarginBps !== candidateMarginBps || !nonblank(review.qualifiedProfile.id) || !nonblank(review.qualifiedProfile.version)
    || review.qualifiedProfile.id === corpus.profile.id && review.qualifiedProfile.version === corpus.profile.version) {
    throw new ContextPlanError('rollout-unqualified', 'margin review does not approve the preregistered selection for these records');
  }
  const profile: ContextProviderProfile = { ...structuredClone(corpus.profile), id: review.qualifiedProfile.id,
    version: review.qualifiedProfile.version, safetyMarginBps: candidateMarginBps };
  const qualification = compareContextUsage(samples, profile, estimator);
  assertContextQualified(qualification, profile, estimator);
  return { schemaVersion: 'context-qualification-record/v1', runId: approval.runId, sourceCommit: approval.sourceCommit,
    model: approval.model, region: approval.region, corpusDigest: approval.corpusDigest, preregistrationDigest: approval.preregistrationDigest,
    approvalDigest: contextLiveDigest(approval), recordsDigest, collectionProfileDigest: contextLiveDigest(corpus.profile), marginRule,
    selection: { worstUndercountBps: observed.worstUndercountBps, extraReserveBps: marginRule.extraReserveBps, candidateMarginBps,
      maximumMarginBps: marginRule.maximumMarginBps }, review, profile, profileDigest: contextLiveDigest(profile), qualification };
}

/** Enforcement gate for a stored record. Any profile change, including only its version, invalidates it. */
export function verifyContextQualificationRecord(record: ContextQualificationRecord, profile: ContextProviderProfile = record?.profile): void {
  const s = record?.selection;
  if (record?.schemaVersion !== 'context-qualification-record/v1' || !s || s.candidateMarginBps !== s.worstUndercountBps + s.extraReserveBps
    || s.candidateMarginBps > s.maximumMarginBps || record.qualification?.worstUndercountBps !== s.worstUndercountBps
    || record.review?.approved !== true || !nonblank(record.review.reviewer) || record.review.selectedMarginBps !== s.candidateMarginBps
    || record.review.qualifiedProfile?.id !== profile?.id || record.review.qualifiedProfile?.version !== profile?.version
    || profile.safetyMarginBps !== s.candidateMarginBps || record.profileDigest !== contextLiveDigest(profile)) {
    throw new ContextPlanError('rollout-unqualified', 'qualification record does not match the enforced profile');
  }
  assertContextQualified(record.qualification, profile, estimator);
}

/** Frozen before collection; the later canary approval embeds it unchanged. */
export interface ContextCanaryPlan {
  schemaVersion: 'context-canary-plan/v1'; caseIds: string[]; rollback: 'observe-only';
  budget: ContextLiveApproval['budget']; perRequestBound: ContextLiveApproval['perRequestBound'];
}
export interface ContextCanaryApproval {
  schemaVersion: 'context-canary-approval/v1'; approved: true; reviewer: string; stagingWorkspace: string; runId: string;
  sourceCommit: string; exactHeadCi: string; model: string; apiRevision: 'v1'; region: string; secretServiceReference: string;
  credentialResolverDigest: string; corpusDigest: string; qualificationRecordDigest: string; canaryPlanDigest: string; plan: ContextCanaryPlan;
}
export interface ContextCanaryCase {
  caseId: string; phase: 'enforce' | 'rollback'; expectedDispatches: number; dispatches: number; rejectedBeforeDispatch: boolean;
  planDigest: string | null; profileDigest: string | null; requestIds: string[];
  partitions: Array<{ partitionId: string; questions: number; estimatedInputTokens: number; actualInputTokens: number; withinEffectiveLimits: boolean; withinDocumentedLimits: boolean }>;
  oversizedDispatches: number; nativeDispatches: number; pass: boolean;
}

/**
 * Canary cases stay small: a context-planned invocation with many aliases (the 24-question `many-short`
 * case) produces a result document above the default entry limits, and that error surfaces after dispatch.
 */
export const CONTEXT_CANARY_MAX_QUESTIONS = 8;
export function validateContextCanaryApproval(approval: ContextCanaryApproval, corpus: ContextLiveCorpus, record: ContextQualificationRecord): void {
  admitEntry(approval);
  const plan = approval?.plan;
  if (!closed(approval, ['schemaVersion', 'approved', 'reviewer', 'stagingWorkspace', 'runId', 'sourceCommit', 'exactHeadCi', 'model', 'apiRevision', 'region',
    'secretServiceReference', 'credentialResolverDigest', 'corpusDigest', 'qualificationRecordDigest', 'canaryPlanDigest', 'plan'])
    || !closed(plan, ['schemaVersion', 'caseIds', 'rollback', 'budget', 'perRequestBound']) || !closed(plan.budget, ['requests', 'tokens', 'usd', 'wallClockMs'])
    || !closed(plan.perRequestBound, ['totalTokens', 'usd', 'approvalReference'])
    || approval.schemaVersion !== 'context-canary-approval/v1' || approval.approved !== true || plan.schemaVersion !== 'context-canary-plan/v1' || plan.rollback !== 'observe-only'
    || ![approval.reviewer, approval.stagingWorkspace, approval.exactHeadCi, approval.model, approval.region, approval.secretServiceReference, plan.perRequestBound.approvalReference].every(nonblank)
    || !/^[a-zA-Z0-9_-]+$/.test(approval.runId) || !/^[a-f0-9]{40}$/.test(approval.sourceCommit) || approval.apiRevision !== 'v1' || /latest|unknown/i.test(approval.model)
    || ![approval.credentialResolverDigest, approval.corpusDigest, approval.qualificationRecordDigest, approval.canaryPlanDigest].every(d => sha256.test(d))
    || approval.canaryPlanDigest !== contextLiveDigest(plan) || approval.corpusDigest !== contextLiveDigest(corpus) || approval.corpusDigest !== record.corpusDigest
    || approval.qualificationRecordDigest !== contextLiveDigest(record) || approval.model !== record.model || approval.region !== record.region
    || !Array.isArray(plan.caseIds) || !plan.caseIds.length || new Set(plan.caseIds).size !== plan.caseIds.length
    || plan.caseIds.some(id => !corpus.cases.some(c => c.id === id && c.definitions.length <= CONTEXT_CANARY_MAX_QUESTIONS))
    || plan.budget.usd > TV12_ISSUE_USD_CAP
    || [plan.budget.requests, plan.budget.tokens, plan.budget.wallClockMs, plan.perRequestBound.totalTokens].some(n => !Number.isSafeInteger(n) || n < 1)
    || [plan.budget.usd, plan.perRequestBound.usd].some(n => !Number.isFinite(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER / 1_000_000)) {
    throw new Error('Incomplete or mismatched TV-12 canary approval');
  }
  verifyContextQualificationRecord(record);
}

/** Dispatches each phase would need, derived from the qualified plan; oversized cases need none. */
export async function contextCanaryDispatches(caseIds: readonly string[], corpus: ContextLiveCorpus, record: ContextQualificationRecord) {
  const rows = [];
  for (const id of caseIds) {
    const item = corpus.cases.find(c => c.id === id)!;
    const { input } = await compileContextLiveCase(item, record.model, record.region);
    let enforce = 0, rollback = 0;
    try { enforce = planDecisionContext(input, record.profile, estimator).partitions.length; rollback = input.questions.length; }
    catch (error) { if (!(error instanceof ContextPlanError && ['oversized-state', 'oversized-question'].includes(error.reason))) throw error; }
    rows.push({ caseId: id, enforce, rollback });
  }
  return rows;
}

function inspect(caseId: string, phase: ContextCanaryCase['phase'], expected: number, result: Awaited<ReturnType<typeof evaluateDecisionRuleset>>,
  aliases: string[], model: string, bound: number): ContextCanaryCase {
  const plan = result.spec.context?.plan ?? null;
  const usage: readonly ContextActualUsageEvidence[] = result.spec.context?.actualUsage ?? [];
  const evaluations = Object.values(result.spec.evaluations ?? {});
  const attempts = evaluations.flatMap(e => e.spec.attempts ?? []);
  const partitions = usage.map(u => {
    const partition = plan?.partitions.find(p => p.id === u.partitionId);
    const withinEffectiveLimits = !!plan && !!partition && u.questionIds.every(id => partition.questionIds.includes(id))
      && partition.estimate.aggregateTokens <= plan.limits.effectiveAggregateTokens
      && partition.estimate.stateAndLongestQuestionTokens <= plan.limits.effectiveStateAndLongestQuestionTokens;
    const withinDocumentedLimits = !!plan && Number.isSafeInteger(u.actualInputTokens) && u.actualInputTokens <= plan.limits.documentedAggregateTokens && u.actualInputTokens <= bound;
    return { partitionId: u.partitionId, questions: u.questionIds.length, estimatedInputTokens: u.estimatedInputTokens, actualInputTokens: u.actualInputTokens, withinEffectiveLimits, withinDocumentedLimits };
  });
  const oversizedDispatches = partitions.filter(p => !p.withinEffectiveLimits || !p.withinDocumentedLimits).length;
  const nativeDispatches = new Set(attempts.filter(a => a.batch?.mode === 'native').map(a => a.batch!.groupId)).size;
  const requestIds = [...new Set(attempts.map(a => a.requestId).filter((id): id is string => typeof id === 'string'))].sort();
  const rejected = expected === 0;
  const covered = new Set(usage.flatMap(u => u.questionIds));
  const pass = rejected
    ? usage.length === 0 && attempts.length === 0 && ['oversized-state', 'oversized-question'].includes(result.spec.contextFailure?.reason ?? '')
    : oversizedDispatches === 0 && usage.length === expected && covered.size === aliases.length
      && aliases.every(alias => covered.has(decisionBatchQuestionId(alias))) && evaluations.length === aliases.length
      && evaluations.every(e => e.spec.status === 'success') && attempts.every(a => a.status === 'success' && a.actualModel === model)
      && (phase === 'rollback' ? nativeDispatches === 0 && usage.every(u => u.questionIds.length === 1) : true);
  return { caseId, phase, expectedDispatches: expected, dispatches: usage.length, rejectedBeforeDispatch: rejected && usage.length === 0,
    planDigest: plan?.planDigest ?? null, profileDigest: plan?.providerProfile.digest ?? null, requestIds, partitions, oversizedDispatches, nativeDispatches, pass };
}

/**
 * Enforce-mode canary. Each case runs once with the recorded qualification (native batching split by the
 * qualified plan), then once rolled back to `observe-only`, which evaluates every question singly. All
 * dispatches of a phase are reserved against the approved bound before it starts; the first failure stops.
 */
export async function runContextEnforceCanary(options: { approval: ContextCanaryApproval; corpus: ContextLiveCorpus;
  record: ContextQualificationRecord; sourceRoot: string; artifactRoot: string; host: ContextLiveHost; offlineTransport?: typeof fetch }) {
  const { sourceRoot, artifactRoot, host, offlineTransport } = options;
  const approval = structuredClone(options.approval), corpus = structuredClone(options.corpus), record = structuredClone(options.record);
  validateContextCanaryApproval(approval, corpus, record);
  await assertContextLiveSource(sourceRoot, approval.sourceCommit);
  await assertContextArtifactRoot(sourceRoot, artifactRoot);
  try {
    return await withContextLiveSpendLedger(artifactRoot, approval.plan.budget.usd, (runsRoot, issueSpend) =>
      canaryWithinLedger(approval, corpus, record, sourceRoot, runsRoot, issueSpend, host, offlineTransport));
  } finally { host.dispose?.(); }
}
async function canaryWithinLedger(approval: ContextCanaryApproval, corpus: ContextLiveCorpus, record: ContextQualificationRecord, sourceRoot: string,
  runsRoot: string, issueSpend: { capUsd: number; priorUsd: number; runUsdCeiling: number }, host: ContextLiveHost, offlineTransport?: typeof fetch) {
  const directory = resolve(runsRoot, approval.runId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await writeFile(join(directory, 'canary-approval.json'), canonicalJson(approval), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'qualification-record.json'), canonicalJson(record), { flag: 'wx', mode: 0o600 });
  const { plan } = approval;
  const started = Date.now();
  const budget = new ContextLiveBudget({ ...plan, budget: { ...plan.budget, usd: issueSpend.runUsdCeiling } }, started);
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), Math.min(2_147_483_647, Math.floor(plan.budget.wallClockMs * 0.8)));
  const results: ContextCanaryCase[] = [];
  let stopped: string | null = null;
  try {
    for (const { caseId, enforce, rollback } of await contextCanaryDispatches(plan.caseIds, corpus, record)) {
      const item = corpus.cases.find(c => c.id === caseId)!;
      for (const [phase, expected] of [['enforce', enforce], ['rollback', rollback]] as const) {
        try {
          for (let i = 0; i < expected; i++) budget.reserve();
        } catch { stopped = 'budget-exhausted'; break; }
        const { input, policy } = await compileContextLiveCase(item, approval.model, approval.region);
        const aliases = item.definitions.map((_, i) => `q${i}`);
        const definitions: Record<string, DecisionDefinition> = Object.fromEntries(aliases.map((alias, i) => [alias, item.definitions[i]!]));
        const adapter = new JevDecisionAdapter({ region: approval.region, ...(offlineTransport ? { fetch: offlineTransport } : {}) });
        const remaining = Math.floor(plan.budget.wallClockMs * 0.8 - (Date.now() - started));
        if (remaining < 1 || controller.signal.aborted) { stopped = 'deadline'; break; }
        const target = contextLiveTarget(approval, adapter.version, Math.min(30_000, remaining));
        const ruleset = contextLiveRuleset(`canary-${item.id}`, aliases, item.definitions);
        const binding = contextLiveBinding(ruleset, aliases, target, Math.min(remaining, 30_000 * aliases.length));
        let result;
        try {
          result = await evaluateDecisionRuleset({ ruleset, binding, definitions, input: item.input, runId: approval.runId,
            invocationId: `${approval.runId}:${item.id}:${phase}`, adapters: { jev: adapter }, signal: controller.signal,
            resolveCredential: async reference => {
              if (reference !== approval.secretServiceReference) throw new Error('TV-12 credential access denied');
              return host.resolveCredential(reference);
            },
            projection: { resolve: () => structuredClone(policy) },
            batching: { enabled: true, evaluations: Object.fromEntries(aliases.map(alias => [alias, { decisionSubject: subject, independent: true,
              egressPolicy: contextLiveDigest(policy), hostPolicy: 'tv12-canary-v1' }])) },
            context: { input: { ...input, questions: input.questions.map(q => ({ ...q, id: decisionBatchQuestionId(q.id) })) }, profile: record.profile, estimator,
              rollout: phase === 'enforce' ? { mode: 'enforce', qualification: record.qualification } : { mode: 'observe-only' } } });
        } catch { stopped = 'evaluation-error'; break; }
        const row = inspect(item.id, phase, expected, result, aliases, approval.model, plan.perRequestBound.totalTokens);
        results.push(row);
        await writeFile(join(directory, `${item.id}-${phase}.json`), canonicalJson(row), { flag: 'wx', mode: 0o600 });
        if (!row.pass) { stopped = 'canary-check-failed'; break; }
      }
      if (stopped) break;
    }
  } finally { clearTimeout(deadlineTimer); }
  const complete = !stopped && results.length === plan.caseIds.length * 2;
  const summary = { schemaVersion: 'context-enforce-canary/v1', source: offlineTransport ? 'synthetic' : 'provider', runId: approval.runId,
    sourceCommit: approval.sourceCommit, qualificationRecordDigest: approval.qualificationRecordDigest, canaryPlanDigest: approval.canaryPlanDigest,
    profile: { id: record.profile.id, version: record.profile.version, digest: record.profileDigest },
    canaryPassed: complete && results.every(r => r.pass), stopped,
    oversizedDispatches: results.reduce((n, r) => n + r.oversizedDispatches, 0),
    enforceDispatches: results.filter(r => r.phase === 'enforce').reduce((n, r) => n + r.dispatches, 0),
    rollbackExercised: complete && results.filter(r => r.phase === 'rollback').every(r => r.pass),
    rollbackNativeDispatches: results.filter(r => r.phase === 'rollback').reduce((n, r) => n + r.nativeDispatches, 0),
    cases: results.length, reserved: { requests: budget.requests, tokens: budget.tokens, usd: budget.usd }, issueSpend,
    requestCapacityAtStop: contextLiveRequestCapacity({ ...plan, budget: { ...plan.budget, usd: issueSpend.runUsdCeiling } }), elapsedMs: Date.now() - started };
  await writeFile(join(directory, 'summary.json'), canonicalJson(summary), { flag: 'wx', mode: 0o600 });
  await assertContextLiveSource(sourceRoot, approval.sourceCommit);
  return summary;
}
