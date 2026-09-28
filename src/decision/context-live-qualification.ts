/** TV-12 collection-only composition. Never changes production rollout or promotes qualification. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry, DEFAULT_ENTRY_LIMITS } from './entry.js';
import { CanonicalJsonByteEstimator, ContextPlanError, planDecisionContext, type ContextPlanInput, type ContextProviderProfile } from './context-plan.js';
import { compareContextUsage } from './context-qualification.js';
import { compileJevQuestion, JevDecisionAdapter, JEV_ENDPOINT } from './adapters/jev.js';
import { projectDecisionState, partitionProjectedState, type DecisionProjectionPolicy } from './projection.js';
import { DecisionAdmissionRegistry } from './admission.js';
import { artifactPin, assertArtifactPin, validateDefinition, validateRuleset, validateBinding } from './validate.js';
import { executeQualificationPlan, writeQualificationEvidenceManifest } from './qualification/runner.js';
import type { DecisionDefinition, DecisionRuleset, DecisionBinding, DecisionAdapterRequest, DecisionSchedulerPolicy } from './types.js';

export const contextLiveDigest = (value: unknown): `sha256:${string}` => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const estimator = new CanonicalJsonByteEstimator();
const subject = 'synthetic-tv12';
const liveHosts = new WeakSet<ContextLiveHost>();
export interface ContextLiveApproval {
  schemaVersion: 'context-live-approval/v1'; approved: true; reviewer: string; stagingWorkspace: string;
  runId: string; sourceCommit: string; exactHeadCi: string; model: string; apiRevision: 'v1'; region: string;
  secretServiceReference: string; credentialResolverDigest: string; corpusDigest: string; preregistrationDigest: string;
  budget: { requests: number; tokens: number; usd: number; wallClockMs: number };
  /** Reviewer-approved upper bound, not a claimed provider price. All requests reserve the full bound. */
  perRequestBound: { totalTokens: number; usd: number; approvalReference: string };
  marginRule: { extraReserveBps: number; maximumMarginBps: number };
}
export interface ContextLiveCase { id: string; input: { payload: unknown }; definitions: DecisionDefinition[]; dimension: string }
export interface ContextLiveCorpus { schemaVersion: 'context-live-corpus/v1'; syntheticOnly: true; profile: ContextProviderProfile; cases: ContextLiveCase[] }
export interface ContextLiveHost {
  /** Approved secret service integration; receives only the logical reference. */
  resolveCredential(reference: string): Promise<Uint8Array>;
  /** Metadata-only durable sink called before the next partition. */
  record?(record: ContextLiveRecord): Promise<void>;
}
const schema = { type: 'object' as const, properties: { payload: {} }, required: ['payload'], additionalProperties: false };
function definition(id: string, kind: 'choice' | 'ordinal-score' = 'choice', count = 2): DecisionDefinition {
  return { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition', metadata: { id, version: '1.0.0', description: 'TV-12 synthetic collection' },
    spec: { purpose: 'Synthetic TV-12 collection only.', inputSchema: schema, question: 'Assess this synthetic entry.',
      answer: kind === 'choice' ? { kind, options: Array.from({ length: count }, (_, i) => ({ id: `option_${i}`, description: `Synthetic category ${i}.` })) }
        : { kind, levels: Array.from({ length: count }, (_, i) => `Synthetic level ${i}.`) }, requiredCapabilities: [kind] } };
}
function projection(model: string, region: string): DecisionProjectionPolicy {
  return { version: 'tv12-v1', provider: 'jev', model, region, origin: new URL(JEV_ENDPOINT).origin, purpose: 'tv12', allowIncompleteContext: false,
    fields: [{ pointer: '/payload', output: 'payload', source: 'synthetic-corpus', subject, trust: 'untrusted', sensitivity: 'public', purpose: 'tv12',
      retentionClass: 'qualification', accessScopes: ['tv12-reviewer'], exportPolicy: 'denied', deletionPolicy: 'erase', backupPolicy: 'not-persisted',
      allowedProviders: ['jev'], allowedModels: [model], allowedOrigins: [new URL(JEV_ENDPOINT).origin], allowedRegions: [region] }] };
}
async function compiled(item: ContextLiveCase, model: string, region: string) {
  item.definitions.forEach(validateDefinition);
  const policy = projection(model, region);
  const projected = await projectDecisionState(item.input, policy);
  const input: ContextPlanInput = { subject, authorizedState: partitionProjectedState(projected.state, projected.evidence) as ContextPlanInput['authorizedState'],
    authorizationDigest: contextLiveDigest(policy), incompleteContext: false,
    questions: item.definitions.map((d, i) => ({ id: `q${i}`, subject, entry: JSON.parse(compileJevQuestion(d).question) })) };
  return { input, projected, policy };
}
/** Builds targets from actual compiled question and trust-partitioned provider state shapes. */
export async function generateContextLiveCorpus(profile: ContextProviderProfile): Promise<ContextLiveCorpus> {
  admitEntry(profile);
  if (profile.limits.aggregateTokens !== 64_000 || profile.limits.stateAndLongestQuestionTokens !== 32_000) throw new Error('TV-12 requires documented limits');
  // Validate profile semantics before generating or writing any preparatory output.
  const probe = await compiled({ id: 'profile-probe', dimension: 'probe', input: { payload: '' }, definitions: [definition('probe')] }, 'preparation-model', 'preparation-region');
  planDecisionContext(probe.input, profile, estimator);
  const cases: ContextLiveCase[] = [];
  for (const dimension of ['longest', 'aggregate'] as const) for (const boundary of ['raw', 'effective'] as const) for (const offset of [-1, 0, 1]) {
    const limit = dimension === 'longest' ? profile.limits.stateAndLongestQuestionTokens : profile.limits.aggregateTokens;
    const target = Math.floor(limit * (boundary === 'raw' ? 1 : 1 - profile.safetyMarginBps / 10_000)) + offset;
    const item: ContextLiveCase = { id: `${dimension}-${boundary}-${offset + 1}`, dimension: `${dimension}-${boundary}`, input: { payload: '' },
      definitions: Array.from({ length: dimension === 'aggregate' ? 4 : 1 }, (_, i) => definition(`${dimension}-${boundary}-${offset + 1}-d${i}`)) };
    // Aggregate targets pad four independent question instructions; longest targets pad state.
    let low = 0, high = target * 3;
    const score = async (n: number) => {
      if (dimension === 'longest') item.input.payload = Array.from({ length: 4 }, (_, i) => 'x'.repeat(Math.floor(n / 4) + (i < n % 4 ? 1 : 0)));
      else item.definitions.forEach((d, i) => { d.spec.question = 'Assess. ' + 'x'.repeat(Math.floor(n / 4) + (i < n % 4 ? 1 : 0)); });
      const { input } = await compiled(item, 'preparation-model', 'preparation-region');
      return estimator.estimate(input.authorizedState).tokens + input.questions.reduce((sum, q) => sum + estimator.estimate(q.entry).tokens, 0) + profile.requestEnvelopeTokens;
    };
    while (low < high) { const mid = Math.floor((low + high) / 2); if (await score(mid) < target) low = mid + 1; else high = mid; }
    if (await score(low) !== target) throw new Error('Unreachable estimator target');
    cases.push(item);
  }
  cases.push({ id: 'unicode-nested', dimension: 'unicode-nested', input: { payload: { nested: [{ text: '合成 🙂 é'.repeat(100) }] } }, definitions: [definition('unicode')] },
    { id: 'choice-255', dimension: 'choice-255', input: { payload: 'synthetic' }, definitions: [definition('choice255', 'choice', 255)] },
    { id: 'score-10', dimension: 'score-10', input: { payload: 'synthetic' }, definitions: [definition('score10', 'ordinal-score', 10)] },
    { id: 'many-short', dimension: 'many-short', input: { payload: 'synthetic' }, definitions: Array.from({ length: 24 }, (_, i) => definition(`short${i}`)) });
  const dominant = definition('dominant'); dominant.spec.question += 'x'.repeat(30_000);
  cases.push({ id: 'dominant', dimension: 'dominant', input: { payload: 'synthetic' }, definitions: [dominant, definition('short')] });
  return { schemaVersion: 'context-live-corpus/v1', syntheticOnly: true, profile: structuredClone(profile), cases };
}
export function contextLivePreregistration(corpus: ContextLiveCorpus, marginRule: ContextLiveApproval['marginRule']) {
  return { schemaVersion: 'context-live-preregistration/v1', corpusDigest: contextLiveDigest(corpus), estimator: { id: estimator.id, version: estimator.version },
    metrics: ['absolute-error-tokens', 'undercount-bps'], marginRule, stopFraction: 0.8, retries: 0, automaticPromotion: false };
}
export function validateContextLiveApproval(approval: ContextLiveApproval, corpus: ContextLiveCorpus): void {
  admitEntry(approval); admitEntry(corpus, { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 8_388_608, properties: 100_000, entries: 200_000, memoryBytes: 67_108_864 });
  const keys = ['schemaVersion', 'approved', 'reviewer', 'stagingWorkspace', 'runId', 'sourceCommit', 'exactHeadCi', 'model', 'apiRevision', 'region',
    'secretServiceReference', 'credentialResolverDigest', 'corpusDigest', 'preregistrationDigest', 'budget', 'perRequestBound', 'marginRule'];
  if (Object.keys(approval).some(key => !keys.includes(key))
    || Object.keys(approval.perRequestBound ?? {}).sort().join(',') !== 'approvalReference,totalTokens,usd'
    || Object.keys(approval.marginRule ?? {}).sort().join(',') !== 'extraReserveBps,maximumMarginBps') throw new Error('Unknown TV-12 approval field');
  if (approval.schemaVersion !== 'context-live-approval/v1' || approval.approved !== true || corpus.schemaVersion !== 'context-live-corpus/v1' || corpus.syntheticOnly !== true
    || ![approval.reviewer, approval.stagingWorkspace, approval.runId, approval.exactHeadCi, approval.model, approval.region, approval.secretServiceReference,
      approval.perRequestBound?.approvalReference].every(v => typeof v === 'string' && v.trim()) || approval.apiRevision !== 'v1'
    || !/^sha256:[a-f0-9]{64}$/.test(approval.credentialResolverDigest) || !/^[a-f0-9]{40}$/.test(approval.sourceCommit) || !/^[a-zA-Z0-9_-]+$/.test(approval.runId)
    || /latest|unknown/i.test(approval.model) || approval.region === 'unknown'
    || !approval.budget || Object.keys(approval.budget).sort().join(',') !== 'requests,tokens,usd,wallClockMs' || Object.values(approval.budget).some(n => !Number.isFinite(n) || n <= 0)
    || approval.budget.usd > Number.MAX_SAFE_INTEGER / 1_000_000 || approval.perRequestBound.usd > Number.MAX_SAFE_INTEGER / 1_000_000
    || !Number.isSafeInteger(approval.budget.requests) || !Number.isSafeInteger(approval.budget.tokens) || !Number.isSafeInteger(approval.budget.wallClockMs)
    || !Number.isSafeInteger(approval.perRequestBound.totalTokens) || approval.perRequestBound.totalTokens < 1
    || !Number.isFinite(approval.perRequestBound.usd) || approval.perRequestBound.usd <= 0
    || !Number.isSafeInteger(approval.marginRule?.extraReserveBps) || approval.marginRule.extraReserveBps < 0
    || !Number.isSafeInteger(approval.marginRule?.maximumMarginBps) || approval.marginRule.maximumMarginBps < approval.marginRule.extraReserveBps
    || approval.marginRule.maximumMarginBps >= 10_000
    || approval.corpusDigest !== contextLiveDigest(corpus) || approval.preregistrationDigest !== contextLiveDigest(contextLivePreregistration(corpus, approval.marginRule))) {
    throw new Error('Incomplete or mismatched TV-12 approval');
  }
  if (corpus.profile.limits.aggregateTokens !== 64_000 || corpus.profile.limits.stateAndLongestQuestionTokens !== 32_000
    || corpus.profile.estimator.id !== estimator.id || corpus.profile.estimator.version !== estimator.version
    || !corpus.cases.length || new Set(corpus.cases.map(c => c.id)).size !== corpus.cases.length) throw new Error('Invalid TV-12 corpus');
}
export async function assertContextLiveSource(root: string, expected: string): Promise<void> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== expected || git('status', '--porcelain', '--untracked-files=all')) throw new Error('TV-12 requires clean exact source commit');
}
export interface ContextLiveRecord {
  source: 'provider' | 'synthetic'; estimator: { id: string; version: string }; wireDigest: string; wireBytes: number;
  caseId: string; partitionId: string; planDigest: string; profileDigest: string; servedModel: string; requestId: string;
  estimatedInputTokens: number; actualInputTokens: number; errorTokens: number; absoluteErrorTokens: number; undercountBps: number;
  usageRef: string; usageArtifactDigest: string; inputTokens: number; outputTokens: number; costUsd: number | null;
}
/** Pure accounting guard. Reservations are never refunded, including uncertain failed calls. */
export class ContextLiveBudget {
  requests = 0; tokens = 0; usd = 0;
  private usdMicros = 0;
  constructor(private readonly approval: ContextLiveApproval, readonly started: number, private readonly now: () => number = Date.now) {}
  reserve(): void {
    const { budget, perRequestBound: bound } = this.approval;
    if (this.requests + 1 > budget.requests * 0.8 || this.tokens + bound.totalTokens > budget.tokens * 0.8
      || this.usdMicros + Math.ceil(bound.usd * 1_000_000) > Math.floor(budget.usd * 800_000) || this.now() - this.started >= budget.wallClockMs * 0.8) throw new Error('TV-12 budget exhausted');
    this.requests++; this.tokens += bound.totalTokens; this.usdMicros += Math.ceil(bound.usd * 1_000_000); this.usd = this.usdMicros / 1_000_000;
  }
}
class CollectionStop extends Error {
  constructor(message: string, readonly evidence: { httpStatus: number | null; requestId: string | null; servedModel: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }) { super(message); }
}
/** Collection-only native request. Exposed for offline guard tests; mocks remain synthetic. */
export async function collectContextLiveCase(item: ContextLiveCase, corpus: ContextLiveCorpus, approval: ContextLiveApproval,
  host: ContextLiveHost, budget: ContextLiveBudget, signal: AbortSignal,
  offlineFetch?: typeof fetch): Promise<{ rejected: boolean; records: ContextLiveRecord[]; synthetic: boolean }> {
  validateContextLiveApproval(approval, corpus);
  if (!offlineFetch && !liveHosts.has(host)) throw new Error('Live collection requires the source-verified runner');
  admitEntry(item);
  if (!corpus.cases.some(candidate => contextLiveDigest(candidate) === contextLiveDigest(item))) throw new Error('Case is outside frozen corpus');
  admitEntry(item.input);
  const { input, projected, policy } = await compiled(item, approval.model, approval.region);
  let plan;
  try { plan = planDecisionContext(input, corpus.profile, estimator); }
  catch (error) { if (error instanceof ContextPlanError && ['oversized-state', 'oversized-question'].includes(error.reason)) return { rejected: true, records: [], synthetic: !!offlineFetch }; throw error; }
  const adapter = new JevDecisionAdapter({ region: approval.region, ...(offlineFetch ? { fetch: offlineFetch } : {}) });
  const capabilities = await adapter.capabilities();
  if (!capabilities.batch?.native || capabilities.batch.atomic !== true || capabilities.egress?.mode !== 'network' || capabilities.egress.origin !== policy.origin
    || capabilities.egress.region !== policy.region || adapter.version !== '1.0.0') throw new Error('TV-12 adapter destination mismatch');
  const registry = new DecisionAdmissionRegistry();
  const records: ContextLiveRecord[] = [];
  for (const partition of plan.partitions) {
    if (signal.aborted) throw new Error('TV-12 deadline reached');
    const selected = input.questions.filter(q => partition.questionIds.includes(q.id));
    const partitionInput = { ...input, questions: selected };
    const checked = planDecisionContext(partitionInput, corpus.profile, estimator);
    if (checked.partitions.length !== 1 || checked.partitions[0]!.questionIds.length !== selected.length) throw new Error('TV-12 partition is not one complete request');
    if (checked.partitions[0]!.estimate.aggregateTokens > approval.perRequestBound.totalTokens) throw new Error('TV-12 approved token bound below estimate');
    const definitions = selected.map(q => item.definitions[Number(q.id.slice(1))]!);
    const ruleset: DecisionRuleset = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionRuleset', metadata: { id: `tv12-${item.id}`, version: '1.0.0', description: 'TV-12 synthetic collection' },
      spec: { purpose: 'TV-12 collection without action execution.', inputSchema: schema,
        evaluations: selected.map((q, i) => ({ alias: q.id, decision: artifactPin(definitions[i]!), inputPointer: '' })),
        rules: [{ id: 'review', priority: 1, when: { op: 'eq', left: { source: 'decision', alias: selected[0]!.id, pointer: '/status' }, right: 'success' }, outcome: 'review' }],
        composition: 'first-match', conflict: 'review', defaultOutcome: 'review', failureOutcome: 'review', outputSchema: { enum: ['review'] } } };
    const timeoutMs = Math.max(1, Math.min(30_000, Math.floor(approval.budget.wallClockMs * 0.8 - (Date.now() - budget.started))));
    const target = { adapter: 'jev' as const, adapterVersion: adapter.version, model: approval.model, credentialRef: approval.secretServiceReference,
      requiredCapabilities: [] as string[], acceptance: { mode: 'typed-value' as const }, timeoutMs,
      retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 } };
    const binding: DecisionBinding = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionBinding', metadata: { id: 'tv12-binding', version: '1.0.0', description: 'TV-12 synthetic collection' },
      spec: { ruleset: artifactPin(ruleset), totalTimeoutMs: timeoutMs, maxAttempts: selected.length, concurrency: 1,
        evaluations: Object.fromEntries(selected.map(q => [q.id, { targets: [target], fallbackOn: [] }])) } };
    definitions.forEach(d => {
      if (!capabilities.answerKinds.includes(d.spec.answer.kind) || d.spec.answer.kind === 'choice' && d.spec.answer.options.length > capabilities.maxOptions!
        || d.spec.answer.kind === 'ordinal-score' && d.spec.answer.levels.length > capabilities.maxLevels!) throw new Error('TV-12 unsupported answer shape');
    });
    validateRuleset(ruleset); validateBinding(binding, ruleset); assertArtifactPin(ruleset, binding.spec.ruleset, 'tv12 ruleset');
    selected.forEach((q, i) => assertArtifactPin(definitions[i]!, ruleset.spec.evaluations[i]!.decision, q.id));
    const invocationId = `${approval.runId}:${item.id}:${partition.id}`;
    const limits = { concurrency: 1, maxTokens: approval.perRequestBound.totalTokens, maxCostUsd: approval.perRequestBound.usd, allowUnknownCost: false };
    const scheduler: DecisionSchedulerPolicy = { enabled: true, profileVersion: 'tv12-collection-v1', workspace: { id: approval.stagingWorkspace, limits },
      principal: { id: approval.reviewer, limits }, providers: { jev: limits } };
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const deadlineEpochMs = Date.now() + timeoutMs;
    const lease = await registry.controllerFor(scheduler, Date.now).acquire({ budgetId: invocationId, workspaceId: approval.stagingWorkspace,
      principalId: approval.reviewer, providerId: 'jev', estimate: { tokens: approval.perRequestBound.totalTokens, costUsd: approval.perRequestBound.usd,
        attempts: 1, batchSize: selected.length, items: selected.length }, deadlineEpochMs, signal: requestSignal });
    let success = false;
    try {
      // Reservation precedes adapter invocation, DNS, credential resolution and network.
      budget.reserve();
      const requests: DecisionAdapterRequest[] = selected.map((q, i) => ({ alias: q.id, questionId: q.id, definition: definitions[i]!,
        input: projected.state, projectionEvidence: projected.evidence, target, invocationId, deadlineEpochMs, signal: requestSignal,
        resolveCredential: async reference => {
          if (requestSignal.aborted || reference !== approval.secretServiceReference) throw new Error('TV-12 credential access denied');
          return host.resolveCredential(reference);
        }, compiledArtifact: compileJevQuestion(definitions[i]!) }));
      const wire = { state: input.authorizedState, model: approval.model, questions: Object.fromEntries(selected.map(q => [q.id, q.entry])) };
      const response = requests.length > 1 ? await adapter.evaluateMany({ requests, decisionSubject: subject })
        : await adapter.evaluate(requests[0]!).then(observation => ({ answers: [{ questionId: selected[0]!.id, observation }], sharedUsage: observation.usage }));
      const first = response.answers[0]?.observation;
      const stopEvidence = { httpStatus: first?.httpStatus ?? null, requestId: first?.requestId ?? null,
        servedModel: first?.actualModel === approval.model ? approval.model : null, ...response.sharedUsage };
      // All failures stop collection, including first limit-related 4xx. No provider text escapes.
      if (response.answers.length !== selected.length || response.answers.some(answer => answer.observation.status !== 'success'
        || answer.observation.actualModel !== approval.model || !answer.observation.requestId)) throw new CollectionStop('TV-12 provider identity or outcome failed', stopEvidence);
      const requestIds = new Set(response.answers.map(a => a.observation.requestId));
      if (requestIds.size !== 1) throw new Error('TV-12 inconsistent shared request identity');
      const usage = response.sharedUsage;
      if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens! < 0 || usage.outputTokens! < 0
        || usage.inputTokens! + usage.outputTokens! > approval.perRequestBound.totalTokens
        || (usage.costUsd !== null && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0 || usage.costUsd > approval.perRequestBound.usd))) {
        throw new CollectionStop('TV-12 usage missing or approved bound exceeded', stopEvidence);
      }
      const usageArtifact = { source: offlineFetch ? 'synthetic' : 'provider', servedModel: approval.model, requestId: [...requestIds][0]!, ...usage };
      const usageArtifactDigest = contextLiveDigest(usageArtifact);
      const usageRef = `usage:${usageArtifactDigest}`;
      const comparison = compareContextUsage([{ caseId: `${item.id}:${partition.id}`, input: partitionInput,
        actualInputTokens: usage.inputTokens!, source: offlineFetch ? 'synthetic' : 'provider', usageRef }], corpus.profile, estimator).cases[0]!;
      const record: ContextLiveRecord = { source: offlineFetch ? 'synthetic' : 'provider', estimator: { id: estimator.id, version: estimator.version },
        wireDigest: contextLiveDigest(wire), wireBytes: Buffer.byteLength(JSON.stringify(wire)), caseId: item.id, partitionId: partition.id, planDigest: checked.planDigest, profileDigest: checked.providerProfile.digest,
        servedModel: approval.model, requestId: [...requestIds][0]!, estimatedInputTokens: comparison.estimatedInputTokens,
        actualInputTokens: comparison.actualInputTokens, errorTokens: comparison.errorTokens, absoluteErrorTokens: Math.abs(comparison.errorTokens),
        undercountBps: comparison.undercountBps, usageRef, usageArtifactDigest, ...usage as { inputTokens: number; outputTokens: number; costUsd: number | null } };
      records.push(record);
      await host.record?.(structuredClone(record));
      success = true;
    } finally { lease.release({ success }); }
  }
  return { rejected: false, records, synthetic: !!offlineFetch };
}
export async function assertContextArtifactRoot(sourceRoot: string, artifactRoot: string): Promise<void> {
  const route = JSON.parse(execFileSync('aiwg', ['artifacts', 'path', '--json', '--check-write'], { cwd: sourceRoot, encoding: 'utf8' }));
  if (typeof route.artifact_root !== 'string') throw new Error('Canonical artifact root unavailable');
  const delta = relative(await realpath(route.artifact_root), await realpath(artifactRoot));
  if (delta === '..' || delta.startsWith('../') || isAbsolute(delta)) throw new Error('TV-12 evidence must use canonical artifact root');
}
/** Writes only sanitized evidence. The caller must resolve the canonical artifact root first. */
export async function runContextLiveCollection(options: { approval: ContextLiveApproval; corpus: ContextLiveCorpus; sourceRoot: string;
  artifactRoot: string; host: ContextLiveHost; offlineTransport?: typeof fetch }): Promise<unknown> {
  const { sourceRoot, artifactRoot, host, offlineTransport } = options;
  admitEntry(options.approval); admitEntry(options.corpus, { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 8_388_608, properties: 100_000, entries: 200_000, memoryBytes: 67_108_864 });
  const approval = structuredClone(options.approval), corpus = structuredClone(options.corpus);
  validateContextLiveApproval(approval, corpus);
  await assertContextLiveSource(sourceRoot, approval.sourceCommit);
  if (contextLiveDigest(await generateContextLiveCorpus(corpus.profile)) !== approval.corpusDigest) throw new Error('TV-12 requires complete generated synthetic corpus');
  // Immutable approval and corpus snapshots must exist before any credential or provider operation.
  await assertContextArtifactRoot(sourceRoot, artifactRoot);
  const directory = resolve(artifactRoot, approval.runId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await writeFile(join(directory, 'preregistration.json'), canonicalJson(contextLivePreregistration(corpus, approval.marginRule)), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'corpus.json'), canonicalJson(corpus), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'approval.json'), canonicalJson(approval), { flag: 'wx', mode: 0o600 });
  const started = Date.now();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), Math.min(2_147_483_647, Math.floor(approval.budget.wallClockMs * 0.8)));
  const signal = controller.signal;
  try {
    const budget = new ContextLiveBudget(approval, started);
    const expected = new Map<string, number>();
    for (const item of corpus.cases) {
      try { expected.set(item.id, planDecisionContext((await compiled(item, approval.model, approval.region)).input, corpus.profile, estimator).partitions.length); }
      catch (error) { if (error instanceof ContextPlanError && ['oversized-state', 'oversized-question'].includes(error.reason)) expected.set(item.id, 0); else throw error; }
    }
    const records: ContextLiveRecord[] = [];
    const rejected: string[] = [];
    let stopped = false;
    const frozenInputs = { corpus: { path: 'corpus.json', digest: approval.corpusDigest },
      preregistration: { path: 'preregistration.json', digest: approval.preregistrationDigest },
      approval: { path: 'approval.json', digest: contextLiveDigest(approval) } };
    const run = await executeQualificationPlan({ artifactRoot, timeoutMs: Math.min(600_000, Math.floor(approval.budget.wallClockMs)), concurrency: 1,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: offlineTransport ? 'offline' : 'live', runId: approval.runId, generatedAt: new Date().toISOString(),
        sourceCommit: approval.sourceCommit, dirty: false, cases: corpus.cases.map(item => ({ id: item.id, kind: 'baseline', mandatory: true, candidateTests: [], evidenceIds: ['CTX-TV12'] })) },
      executors: Object.fromEntries(corpus.cases.map(item => [item.id, async ({ signal: caseSignal }) => {
        if (stopped) return { outcome: 'fail' as const, details: { reason: 'prior-stop', frozenInputs } };
        try {
          const collectionHost: ContextLiveHost = { resolveCredential: reference => host.resolveCredential(reference), record: async record => {
            const usage = { source: record.source, servedModel: record.servedModel, requestId: record.requestId, inputTokens: record.inputTokens, outputTokens: record.outputTokens, costUsd: record.costUsd };
            if (contextLiveDigest(usage) !== record.usageArtifactDigest) throw new Error('TV-12 usage digest mismatch');
            await writeFile(join(directory, `usage-${record.usageArtifactDigest.slice(7)}.json`), canonicalJson(usage), { flag: 'wx', mode: 0o600 });
            await writeFile(join(directory, `${record.caseId}-${record.partitionId}-comparison.json`), canonicalJson(record), { flag: 'wx', mode: 0o600 });
            records.push(record);
            await host.record?.(structuredClone(record));
          } };
          if (!offlineTransport) liveHosts.add(collectionHost);
          const collected = await collectContextLiveCase(item, corpus, approval, collectionHost, budget, AbortSignal.any([signal, caseSignal]), offlineTransport);
          if (collected.rejected) rejected.push(item.id);
          return { outcome: 'pass' as const, details: { frozenInputs, rejectedBeforeDispatch: collected.rejected, records: collected.records } };
        } catch (error) { stopped = true; return { outcome: 'fail' as const, details: { reason: 'collection-stopped', frozenInputs, ...(error instanceof CollectionStop ? { provider: error.evidence } : {}), records: records.filter(row => row.caseId === item.id), reserved: { requests: budget.requests, tokens: budget.tokens, usd: budget.usd } } }; }
      }])), sanitizeDetails: details => details });
    await assertContextLiveSource(sourceRoot, approval.sourceCommit);
    const worst = Math.max(0, ...records.map(row => row.undercountBps));
    const collectionSuccess = !stopped && records.length > 0 && run.evidence.length === corpus.cases.length && run.evidence.every(row => row.outcome === 'pass')
      && corpus.cases.every(item => expected.get(item.id) === records.filter(row => row.caseId === item.id).length
        && (expected.get(item.id) !== 0 || rejected.includes(item.id)));
    const summary = { schemaVersion: 'context-live-collection/v1', sourceCommit: approval.sourceCommit, corpusDigest: approval.corpusDigest,
      preregistrationDigest: approval.preregistrationDigest, frozenInputs, source: offlineTransport ? 'synthetic' : 'provider', collectionSuccess, collected: records.length, rejected, stopped,
      candidateMarginBps: worst + approval.marginRule.extraReserveBps, withinApprovedMaximum: worst + approval.marginRule.extraReserveBps <= approval.marginRule.maximumMarginBps,
      qualifiedForEnforcement: false, pending: ['reviewer-margin-approval', 'versioned-profile-qualification', 'enforce-canary', 'rollback-evidence'],
      reserved: { requests: budget.requests, tokens: budget.tokens, usd: budget.usd }, elapsedMs: Date.now() - started };
    await writeFile(join(directory, 'summary.json'), canonicalJson(summary), { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'run-manifest.json'), canonicalJson(run), { flag: 'wx', mode: 0o600 });
    const manifest = await writeQualificationEvidenceManifest(run, artifactRoot, sourceRoot,
      Object.fromEntries(corpus.cases.map(item => [item.id, ['src/decision/context-live-qualification.ts', 'src/decision/context-plan.ts', 'src/decision/adapters/jev.ts']])));
    return { ...summary, evidenceManifest: manifest.artifact, evidenceDigest: manifest.digest };
  } finally { clearTimeout(deadlineTimer); }
}
