/**
 * D12 live paired qualification (#2686): flat single-call FlowGraph baseline versus the
 * compiled dependent decision graph, on the preregistered synthetic workload.
 *
 * Collection-only. Dry-run planning never resolves a credential or opens a connection; a
 * live run additionally needs an operator approval bound to the workload and
 * preregistration digests, a clean exact source commit and the explicit
 * AIWG_DECISION_DAG_LIVE=1 gate. The result is evidence for a human promote-or-hold
 * decision; nothing here promotes the experimental graph runtime.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry, DEFAULT_ENTRY_LIMITS } from './entry.js';
import { CanonicalJsonByteEstimator } from './context-plan.js';
import { assertContextArtifactRoot, assertContextLiveSource } from './context-live-qualification.js';
import { compileJevQuestion, JevDecisionAdapter, JEV_ENDPOINT } from './adapters/jev.js';
import { evaluateDecisionRuleset } from './evaluate.js';
import { artifactPin, validateBinding, validateRuleset } from './validate.js';
import { DecisionGraphError, planDecisionGraph, type DecisionGraph } from './graph.js';
import { shortlistRerankTemplate, taxonomyBeamTemplate, extractorVerifierFallbackTemplate, type DecisionGraphTemplate } from './graph-templates.js';
import { decisionGraphToFlow } from './graph-flow.js';
import { graphBeamFlowInvoker } from './graph-beam.js';
import { GraphBudgetLedger } from './graph-budget.js';
import { admittedDecisionFlowAdapter, type GraphFlowRequest, type GraphFlowResponse } from './graph-flow-adapter.js';
import { assertDecisionFlowPins, decisionFlowNode, decisionFlowResponse } from './graph-decision-bridge.js';
import { finalizeDecisionGraphRun, type GraphFlowReport } from './graph-run.js';
import { pairedBinaryDifferenceInterval, pairedMeanDifferenceBootstrap, pairedNonInferiority, wilsonScoreInterval,
  type PairedDifferenceInterval } from './qualification/quality.js';
import { executeQualificationPlan, writeQualificationEvidenceManifest } from './qualification/runner.js';
import { loadManifestDigest, qualificationOutcomesDigest } from './qualification/gate-evidence.js';
import { DAG_LIVE_PATTERNS, DAG_LIVE_TASKS_PER_PATTERN, dagLiveDefinitions, dagLiveDigest, dagLivePreregistration, generateDagLiveWorkload,
  type DagLivePattern, type DagLivePreregistration, type DagLiveTask, type DagLiveWorkload } from './graph-live-workload.js';
import type { AdapterObservation, DecisionAdapter, DecisionAdapterRequest, DecisionBinding, DecisionDefinition, DecisionRuleset,
  ExecutionTarget } from './types.js';
import type { DecisionProjectionPolicy } from './projection.js';

export { dagLiveDigest };
/** Hard ceiling from the #2686 assessment; an approval cannot raise it. */
export const DAG_LIVE_HARD_CAP_USD = 2;
export const DAG_LIVE_ENV_GATE = 'AIWG_DECISION_DAG_LIVE';
/** Worst-case provider calls per task: flat baseline is always one. */
export const DAG_LIVE_MAX_CANDIDATE_CALLS: Record<DagLivePattern, number> = {
  'shortlist-rerank': 2, 'taxonomy-beam': 3, 'extractor-verifier-fallback': 3,
};
const HOST_LOCAL = new Set(['taxonomy', 'select']);
/** Hierarchical search keeps one branch: the caller ceiling narrows the authored beam width. */
const NARROW = [{ beamWidth: 1 }];
const estimator = new CanonicalJsonByteEstimator();
const REQUEST_ENVELOPE_TOKENS = 32;
const WORKLOAD_LIMITS = { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 8_388_608, properties: 100_000, entries: 200_000, memoryBytes: 67_108_864 };

export interface DagLiveBudgetLimits { usd: number; calls: number; tokens: number; wallClockMs: number }
export interface DagLiveApproval {
  schemaVersion: 'dag-live-approval/v1'; approved: true;
  /** Named D12 promotion owner who approved the digests and margin. */
  reviewer: string; stagingHost: string; runId: string; sourceCommit: string; exactHeadCi: string;
  model: string; apiRevision: 'v1'; region: string; secretServiceReference: string;
  credentialResolverDigest: `sha256:${string}`; workloadDigest: `sha256:${string}`; preregistrationDigest: `sha256:${string}`;
  budget: DagLiveBudgetLimits & { perPattern: DagLiveBudgetLimits };
  /** Conservative ceiling reserves every call; billable prices only feed reported economics. */
  price: { ceilingUsdPerMTok: number; inputUsdPerMTok: number; outputUsdPerMTok: number; source: string };
  taskDeadlineMs: number;
}
export interface DagLiveHost {
  /** Approved secret-service integration. Receives only the logical reference. */
  resolveCredential(reference: string): Promise<Uint8Array>;
}
export type FlowExecutor = (manifest: unknown, options: Record<string, unknown>) => Promise<GraphFlowReport>;

const APPROVAL_KEYS = ['schemaVersion', 'approved', 'reviewer', 'stagingHost', 'runId', 'sourceCommit', 'exactHeadCi', 'model', 'apiRevision',
  'region', 'secretServiceReference', 'credentialResolverDigest', 'workloadDigest', 'preregistrationDigest', 'budget', 'price', 'taskDeadlineMs'];
const LIMIT_KEYS = 'calls,tokens,usd,wallClockMs';
const validLimits = (limits: DagLiveBudgetLimits | undefined): boolean => !!limits && typeof limits === 'object'
  && Object.keys(limits).filter(key => key !== 'perPattern').sort().join(',') === LIMIT_KEYS
  && [limits.calls, limits.tokens, limits.wallClockMs].every(n => Number.isSafeInteger(n) && n > 0)
  && Number.isFinite(limits.usd) && limits.usd > 0 && limits.usd <= DAG_LIVE_HARD_CAP_USD;

/** Fails closed on any unknown field, missing value, digest mismatch or cap violation. */
export function validateDagLiveApproval(approval: DagLiveApproval, workload: DagLiveWorkload, preregistration: DagLivePreregistration): void {
  admitEntry(approval); admitEntry(workload, WORKLOAD_LIMITS); admitEntry(preregistration);
  const a = approval;
  if (!a || typeof a !== 'object' || Object.keys(a).some(key => !APPROVAL_KEYS.includes(key)) || APPROVAL_KEYS.some(key => !Object.hasOwn(a, key))
    || Object.keys(a.price ?? {}).sort().join(',') !== 'ceilingUsdPerMTok,inputUsdPerMTok,outputUsdPerMTok,source') {
    throw new Error('Unknown or missing D12 approval field');
  }
  const { price, budget } = a;
  if (a.schemaVersion !== 'dag-live-approval/v1' || a.approved !== true || a.apiRevision !== 'v1'
    || ![a.reviewer, a.stagingHost, a.runId, a.exactHeadCi, a.model, a.region, a.secretServiceReference, price.source].every(v => typeof v === 'string' && v.trim())
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(a.runId) || !/^[a-f0-9]{40}$/.test(a.sourceCommit)
    || !/^sha256:[a-f0-9]{64}$/.test(a.credentialResolverDigest) || /latest|unknown/i.test(a.model) || a.region === 'unknown'
    || !validLimits(budget) || !validLimits(budget.perPattern)
    || (['calls', 'tokens', 'usd', 'wallClockMs'] as const).some(key => budget.perPattern[key] > budget[key])
    || ![price.ceilingUsdPerMTok, price.inputUsdPerMTok, price.outputUsdPerMTok].every(n => Number.isFinite(n) && n >= 0)
    || price.ceilingUsdPerMTok <= 0 || price.ceilingUsdPerMTok < price.inputUsdPerMTok || price.ceilingUsdPerMTok < price.outputUsdPerMTok
    || !Number.isSafeInteger(a.taskDeadlineMs) || a.taskDeadlineMs < 1_000 || a.taskDeadlineMs > budget.perPattern.wallClockMs) {
    throw new Error('Incomplete or invalid D12 approval');
  }
  validateDagLiveInputs(workload, preregistration);
  if (a.workloadDigest !== dagLiveDigest(workload) || a.preregistrationDigest !== dagLiveDigest(preregistration)) {
    throw new Error('D12 approval does not bind this workload and preregistration');
  }
}

/** The preregistration must be exactly the one generated from this workload. */
export function validateDagLiveInputs(workload: DagLiveWorkload, preregistration: DagLivePreregistration): void {
  if (workload?.schemaVersion !== 'dag-live-workload/v1' || workload.syntheticOnly !== true || !Array.isArray(workload.tasks)
    || new Set(workload.tasks.map(task => task.id)).size !== workload.tasks.length
    || DAG_LIVE_PATTERNS.some(pattern => workload.tasks.filter(task => task.pattern === pattern).length !== workload.tasksPerPattern)
    || dagLiveDigest(generateDagLiveWorkload(workload.seed, workload.tasksPerPattern)) !== dagLiveDigest(workload)) {
    throw new Error('D12 workload is not the seeded synthetic workload');
  }
  if (dagLiveDigest(preregistration) !== dagLiveDigest(dagLivePreregistration(workload, preregistration?.promotionOwner))) {
    throw new Error('D12 preregistration does not match its workload');
  }
}

export class DagLiveStop extends Error {
  constructor(readonly reason: string) { super(`D12 live qualification stopped: ${reason}`); this.name = 'DagLiveStop'; }
}
type Totals = { calls: number; tokens: number; usdMicros: number };
/**
 * Pure accounting guard. Every call reserves the full per-call token bound at the price
 * ceiling before dispatch and is refused once any global or per-pattern dimension would
 * pass the stop fraction. Settlement lowers tokens to the reported actual; a call with
 * unknown usage keeps its full reservation. Calls are never refunded.
 */
export class DagLiveBudget {
  readonly total: Totals = { calls: 0, tokens: 0, usdMicros: 0 };
  private readonly patterns = new Map<DagLivePattern, Totals & { started: number }>();
  private readonly boundMicros: number;
  constructor(private readonly approval: Pick<DagLiveApproval, 'budget' | 'price'>, private readonly bound: number,
    private readonly stopFraction: number, readonly started: number, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(bound) || bound < 1 || !(stopFraction > 0 && stopFraction <= 1)) throw new Error('invalid D12 budget');
    this.boundMicros = Math.ceil(bound * approval.price.ceilingUsdPerMTok);
  }
  usd(totals: Totals = this.total): number { return totals.usdMicros / 1_000_000; }
  pattern(pattern: DagLivePattern): Totals { const { calls, tokens, usdMicros } = this.patterns.get(pattern) ?? { calls: 0, tokens: 0, usdMicros: 0 }; return { calls, tokens, usdMicros }; }
  private exceeds(spent: Totals, limits: DagLiveBudgetLimits, elapsed: number): string | null {
    const f = this.stopFraction;
    if (spent.calls + 1 > Math.floor(limits.calls * f)) return 'calls';
    if (spent.tokens + this.bound > Math.floor(limits.tokens * f)) return 'tokens';
    if (spent.usdMicros + this.boundMicros > Math.floor(limits.usd * 1_000_000 * f)) return 'usd';
    if (elapsed >= limits.wallClockMs * f) return 'wall-clock';
    return null;
  }
  reserve(pattern: DagLivePattern): (actualTokens: number | null) => void {
    const now = this.now();
    const current = this.patterns.get(pattern) ?? { calls: 0, tokens: 0, usdMicros: 0, started: now };
    const global = this.exceeds(this.total, this.approval.budget, now - this.started);
    const local = this.exceeds(current, this.approval.budget.perPattern, now - current.started);
    if (global || local) throw new DagLiveStop(`budget-${global ? 'run' : 'pattern'}-${global ?? local}`);
    for (const target of [this.total, current]) { target.calls++; target.tokens += this.bound; target.usdMicros += this.boundMicros; }
    this.patterns.set(pattern, current);
    let settled = false;
    return actualTokens => {
      if (settled) throw new Error('D12 reservation already settled');
      settled = true;
      if (actualTokens === null || !Number.isSafeInteger(actualTokens) || actualTokens < 0 || actualTokens > this.bound) return;
      const micros = Math.ceil(actualTokens * this.approval.price.ceilingUsdPerMTok);
      for (const target of [this.total, current]) { target.tokens -= this.bound - actualTokens; target.usdMicros -= this.boundMicros - micros; }
    };
  }
}

/** One metadata-only provider call record. Provider text and credentials never appear. */
export interface DagLiveCall {
  pattern: DagLivePattern; taskId: string; arm: 'baseline' | 'candidate'; node: string; ordinal: number;
  status: string; reason: string; requestId: string | null; servedModel: string | null;
  inputTokens: number | null; outputTokens: number | null; latencyMs: number;
}
interface CallContext { pattern: DagLivePattern; taskId: string; arm: 'baseline' | 'candidate'; node: string }
class RunControl {
  stopped: string | null = null;
  stop(reason: string): void { this.stopped ??= reason; }
}

/**
 * Budget and identity guard around the real Jev adapter. Reservation precedes credential
 * resolution and transport; any failure, missing usage or served-model mismatch stops the run.
 */
class MeteredJevAdapter implements DecisionAdapter {
  readonly id = 'jev';
  readonly version: string;
  context: CallContext | null = null;
  constructor(private readonly inner: JevDecisionAdapter, private readonly budget: DagLiveBudget, private readonly model: string,
    private readonly bound: number, private readonly control: RunControl, private readonly now: () => number,
    private readonly record: (call: DagLiveCall) => Promise<void>) { this.version = inner.version; }
  capabilities() { return this.inner.capabilities(); }
  compile(request: Parameters<NonNullable<DecisionAdapter['compile']>>[0]) { return this.inner.compile(request); }
  async evaluate(request: DecisionAdapterRequest): Promise<AdapterObservation> {
    const notSent = (reason: AdapterObservation['reason']): AdapterObservation => ({ status: 'error', reason, uncertainty: null, actualModel: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null, dispatchCertainty: 'not-sent' });
    const context = this.context;
    if (!context || this.control.stopped) { this.control.stop(this.control.stopped ?? 'unscoped-call'); return notSent('cancelled'); }
    if (request.target.model !== this.model) { this.control.stop('model-mismatch'); return notSent('invalid-request'); }
    let settle: (actual: number | null) => void;
    try { settle = this.budget.reserve(context.pattern); }
    catch (error) { this.control.stop(error instanceof DagLiveStop ? error.reason : 'budget'); return notSent('budget-exhausted'); }
    const started = this.now();
    let observation: AdapterObservation;
    try { observation = await this.inner.evaluate(request); }
    catch { settle(null); this.control.stop('adapter-exception'); throw new DecisionGraphError('D12 adapter failed'); }
    const { inputTokens, outputTokens } = observation.usage;
    const known = Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) && inputTokens! >= 0 && outputTokens! >= 0;
    const total = known ? inputTokens! + outputTokens! : null;
    settle(total);
    if (observation.status !== 'success') this.control.stop(`provider-${observation.reason}`);
    else if (observation.actualModel !== this.model) this.control.stop('served-model-mismatch');
    else if (!observation.requestId) this.control.stop('missing-request-id');
    else if (total === null) this.control.stop('unknown-usage');
    else if (total > this.bound) this.control.stop('usage-exceeded-reservation');
    await this.record({ ...context, ordinal: this.budget.total.calls, status: observation.status, reason: observation.reason,
      requestId: observation.requestId ?? null, servedModel: observation.actualModel === this.model ? this.model : null,
      inputTokens: known ? inputTokens : null, outputTokens: known ? outputTokens : null, latencyMs: Math.max(0, this.now() - started) });
    return observation;
  }
}

const SKILL_TYPES = { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] };
function modelLabel(model: string): string {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(model) ? model : `m${dagLiveDigest(model).slice(7, 23)}`;
}
function policy(model: string, region: string): DecisionProjectionPolicy {
  const origin = new URL(JEV_ENDPOINT).origin;
  const field = (name: string, source: string) => ({ pointer: `/${name}`, output: name, source, subject: 'synthetic-d12', trust: 'untrusted' as const,
    sensitivity: 'public' as const, purpose: 'd12-qualification', retentionClass: 'qualification', accessScopes: ['d12-reviewer'],
    exportPolicy: 'denied' as const, deletionPolicy: 'erase' as const, backupPolicy: 'not-persisted' as const,
    allowedProviders: ['jev'], allowedModels: [model], allowedOrigins: [origin], allowedRegions: [region] });
  return { version: 'd12-live-v1', provider: 'jev', model, region, origin, purpose: 'd12-qualification', allowIncompleteContext: false,
    fields: [field('subject', 'synthetic-workload'), field('evidence', 'graph-predecessor-projection')] } as DecisionProjectionPolicy;
}
interface NodeArtifacts { ruleset: DecisionRuleset; binding: DecisionBinding; definitions: Record<string, DecisionDefinition> }
function nodeArtifacts(nodeId: string, definition: DecisionDefinition, target: ExecutionTarget, timeoutMs: number): NodeArtifacts {
  const ruleset: DecisionRuleset = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionRuleset',
    metadata: { id: `${definition.metadata.id}-${nodeId}`.slice(0, 100), version: '1.0.0', description: 'D12 live qualification node (#2686)' },
    spec: { purpose: 'Record one synthetic answer; no action is authorized.', inputSchema: definition.spec.inputSchema,
      evaluations: [{ alias: 'answer', decision: artifactPin(definition), inputPointer: '' }],
      rules: [{ id: 'answered', priority: 1, when: { op: 'eq', left: { source: 'decision', alias: 'answer', pointer: '/status' }, right: 'success' }, outcome: 'answered' }],
      composition: 'first-match', conflict: 'review', defaultOutcome: 'unanswered', failureOutcome: 'unanswered', outputSchema: { enum: ['answered', 'unanswered'] } } } as DecisionRuleset;
  const binding: DecisionBinding = { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionBinding',
    metadata: { id: `${ruleset.metadata.id}-binding`.slice(0, 100), version: '1.0.0', description: 'D12 live qualification binding (#2686)' },
    spec: { ruleset: artifactPin(ruleset), totalTimeoutMs: timeoutMs, maxAttempts: 1, concurrency: 1,
      evaluations: { answer: { targets: [target], fallbackOn: [] } } } } as DecisionBinding;
  validateRuleset(ruleset); validateBinding(binding, ruleset);
  return { ruleset, binding, definitions: { [definition.metadata.id]: definition } };
}
const HOST_LOCAL_PIN = artifactPin({ metadata: { id: 'dag-live-host-local', version: '1.0.0' },
  spec: { purpose: 'Deterministic host-local stage: fixed taxonomy expansion or beam selection. No inference.' } } as { metadata: { id: string; version: string } });

/** Deterministic host projectors. Model output only selects among host-declared options. */
function project(task: DagLiveTask, nodeId: string, value: string | number, input: Record<string, unknown>): Record<string, unknown> {
  const text = typeof value === 'string' ? value : null;
  if (nodeId === 'flat' || nodeId === 'fallback' || nodeId.startsWith('detail-')) return { result: text ?? fail() };
  if (nodeId === 'shortlist') {
    const sections = task.subject.sections as Array<{ id: string; name: string; items: Array<{ id: string; name: string }> }>;
    const index = sections.findIndex(section => section.id === text);
    if (text !== 'none' && index < 0) fail();
    return { 'has-candidates': index >= 0, candidates: index < 0 ? { sectionIndex: null, items: [] }
      : { sectionIndex: index, section: sections[index]!.name, items: sections[index]!.items.map(item => item.name) } };
  }
  if (nodeId === 'rerank') {
    const sections = task.subject.sections as Array<{ items: Array<{ id: string }> }>;
    const candidates = input.candidates as { sectionIndex: number };
    const position = /^position-([1-9])$/.exec(text ?? '');
    const item = position ? sections[candidates?.sectionIndex]?.items[Number(position[1]) - 1] : undefined;
    return { result: item?.id ?? fail() };
  }
  if (nodeId === 'branch-a' || nodeId === 'branch-b') return { score: typeof value === 'number' ? value : fail() };
  if (nodeId === 'extractor') return { evidence: { status: text ?? fail() } };
  if (nodeId === 'verifier') {
    const prior = (input.evidence as { status?: unknown })?.status;
    if (typeof prior !== 'string' || !['supported', 'not-supported'].includes(text ?? '')) fail();
    return { result: prior, 'needs-fallback': text === 'not-supported' };
  }
  return fail();
}
function fail(): never { throw new DecisionGraphError('D12 projection rejected an out-of-contract answer'); }

interface ArmSetup { graph: DecisionGraph; flow: any; requests: Map<string, NodeArtifacts>; template?: DecisionGraphTemplate }
export interface DagLiveArms { baseline: ArmSetup; candidate: ArmSetup & { template: DecisionGraphTemplate }; resolvedPins: Set<string> }
/** Builds both arms for one task. Pins are resolved from the frozen task before any dispatch. */
export function buildDagLiveArms(task: DagLiveTask, options: { model: string; secretServiceReference: string; skillId: `aiwg:skill:${string}`;
  perCallTokenBound: number; ceilingUsdPerMTok: number; taskDeadlineMs: number }): DagLiveArms {
  const definitions = dagLiveDefinitions(task);
  const timeoutMs = Math.min(30_000, options.taskDeadlineMs);
  const target: ExecutionTarget = { adapter: 'jev', adapterVersion: '1.0.0', model: options.model, credentialRef: options.secretServiceReference,
    requiredCapabilities: [], acceptance: { mode: 'typed-value' }, timeoutMs, retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 } };
  const requests = new Map(Object.entries(definitions).map(([node, definition]) => [node, nodeArtifacts(node, definition, target, timeoutMs)]));
  const resolvedPins = new Set<string>([HOST_LOCAL_PIN.digest]);
  for (const item of requests.values()) { resolvedPins.add(artifactPin(item.binding).digest); Object.values(item.definitions).forEach(d => resolvedPins.add(artifactPin(d).digest)); }
  const stateDigest = dagLiveDigest(task.subject);
  const label = modelLabel(options.model);
  const config = (node: string) => {
    const item = requests.get(node);
    return { subject: 'synthetic-d12', target: HOST_LOCAL.has(node) ? (node === 'select' ? 'beam' : 'host') : 'jev', model: label, egress: 'jev-network', stateDigest,
      definition: item ? artifactPin(Object.values(item.definitions)[0]!) : HOST_LOCAL_PIN, binding: item ? artifactPin(item.binding) : HOST_LOCAL_PIN };
  };
  const jevNodes = task.pattern === 'shortlist-rerank' ? 2 : 3;
  const localNodes = task.pattern === 'taxonomy-beam' ? 2 : 0;
  const boundMicros = Math.ceil(options.perCallTokenBound * options.ceilingUsdPerMTok);
  // One spare call of slack: Flow treats a realized resource equal to its ceiling as exceeded.
  const budget = { attempts: jevNodes + localNodes + 1, deadlineMs: options.taskDeadlineMs, tokens: (jevNodes + 1) * options.perCallTokenBound + localNodes,
    costMicros: (jevNodes + 1) * boundMicros + localNodes, fanOut: 2, beamWidth: 2, depth: 4, concurrency: 1 };
  const base = { id: `d12-${task.id}`, budget, resolvedPins };
  let template = task.pattern === 'shortlist-rerank' ? shortlistRerankTemplate({ ...base, shortlist: config('shortlist'), rerank: config('rerank') })
    : task.pattern === 'taxonomy-beam' ? taxonomyBeamTemplate({ ...base, taxonomy: config('taxonomy'),
      branches: [{ id: 'branch-a', config: config('branch-a') }, { id: 'branch-b', config: config('branch-b') }], select: config('select'),
      details: config('detail-branch-a') })
      : extractorVerifierFallbackTemplate({ ...base, extractor: config('extractor'), verifier: config('verifier'), fallback: config('fallback') });
  if (task.pattern === 'taxonomy-beam') {
    // Each detail node asks its own branch's leaves; the template shares one config, so pin per node and replan.
    for (const node of template.graph.nodes) if (node.id.startsWith('detail-')) Object.assign(node, { definition: config(node.id).definition, binding: config(node.id).binding });
    template = { graph: template.graph, plan: planDecisionGraph(template.graph, resolvedPins) };
  }
  const graph = template.graph;
  const flow = decisionGraphToFlow(graph, { resolvedPins, decisionSkillId: options.skillId, terminal: graph.terminals[0]!, ceilings: NARROW });
  const flatGraph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: `d12-flat-${task.id}`, pattern: 'custom', entry: 'flat', terminals: ['flat'],
    nodes: [{ id: 'flat', stage: 0, ...config('flat'), input: [], output: ['result'] }], edges: [],
    budget: { attempts: 2, deadlineMs: options.taskDeadlineMs, tokens: 2 * options.perCallTokenBound, costMicros: 2 * boundMicros, fanOut: 1, beamWidth: 1, depth: 1, concurrency: 1 } };
  return { resolvedPins, baseline: { graph: flatGraph, flow: flatBaselineFlow(options.skillId, options.perCallTokenBound, boundMicros, options.taskDeadlineMs), requests },
    candidate: { graph, flow, requests, template } };
}

/** Independently authored explicit FlowGraph: one skill node answers the whole task. */
function flatBaselineFlow(skill: string, bound: number, boundMicros: number, deadlineMs: number) {
  return { apiVersion: 'flow.aiwg.io/v1alpha1', kind: 'FlowGraph', metadata: { name: 'd12-flat-baseline' }, spec: {
    entry: ['flat'], candidates: [{ id: skill, kind: 'skill' }], state: { fields: [] }, permissions: [], capabilities: [],
    ceilings: { activations: 2, tokens: 2 * bound, costUsd: (2 * boundMicros) / 1_000_000, timeMs: deadlineMs, concurrency: 1 },
    nodes: [{ id: 'flat', kind: 'skill', ref: skill, phase: 'stage-0', inputs: [], outputs: [{ name: 'result', schema: SKILL_TYPES }],
      capabilities: [], permissions: [], sideEffectMode: 'none', retry: { limit: 0, backoff: 'none', on: ['failure'] } }],
    routes: [], joins: [], failure: { onNodeFailure: 'fail', maxFailures: 0 },
    output: { mode: 'final-only', from: 'flat.result', schema: SKILL_TYPES }, trace: { level: 'metadata', redact: [] } } };
}

/** Stop rule: no arm may contain a node able to request an action or permission. */
export function speculativeActionViolation(flow: { spec?: { permissions?: unknown[]; nodes?: Array<{ kind?: string; sideEffectMode?: string; permissions?: unknown[]; capabilities?: unknown[] }> } }): boolean {
  const spec = flow?.spec;
  return !spec || !Array.isArray(spec.nodes) || (spec.permissions?.length ?? 0) > 0 || spec.nodes.some(node => !['skill', 'gate'].includes(node.kind ?? '')
    || node.sideEffectMode !== 'none' || (node.permissions?.length ?? 0) > 0 || (node.capabilities?.length ?? 0) > 0);
}

/** Stop rule: a pattern's cumulative candidate calls exceed the multiple of its Flow baseline calls. */
export function patternCallRatioExceeded(pairs: readonly DagLivePair[], pattern: DagLivePattern, maxRatio: number): boolean {
  const rows = pairs.filter(row => row.pattern === pattern);
  const baseline = rows.reduce((sum, row) => sum + row.baseline.calls, 0), candidate = rows.reduce((sum, row) => sum + row.candidate.calls, 0);
  return candidate > maxRatio * baseline;
}

/** Operator-facing defaults for the dry run and approval template (USD 0.10/1M ceiling, USD 2.00 cap). */
export const DAG_LIVE_DEFAULT_LIMITS: Pick<DagLiveApproval, 'budget' | 'price' | 'taskDeadlineMs'> = {
  budget: { usd: 2, calls: 1_400, tokens: 6_000_000, wallClockMs: 14_400_000,
    perPattern: { usd: 0.25, calls: 500, tokens: 2_000_000, wallClockMs: 5_400_000 } },
  price: { ceilingUsdPerMTok: 0.1, inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, source: 'operator-stated Jev list price, #2686 assessment' },
  taskDeadlineMs: 120_000,
};
/** Unsigned approval skeleton: every `<...>` value must be filled in and reviewed by the promotion owner. */
export function dagLiveApprovalTemplate(workload: DagLiveWorkload, preregistration: DagLivePreregistration): Record<string, unknown> {
  return { schemaVersion: 'dag-live-approval/v1', approved: '<true once reviewed>', reviewer: preregistration.promotionOwner, stagingHost: 'titan',
    runId: '<unique-run-id>', sourceCommit: '<exact 40-hex commit>', exactHeadCi: '<green CI run URL for that commit>', model: '<pinned Jev model id>',
    apiRevision: 'v1', region: '<recorded deployment region>', secretServiceReference: 'openbao.typesafe.jev.api-key',
    credentialResolverDigest: '<sha256 of tools/decision/jev-openbao-credential.mjs>', workloadDigest: dagLiveDigest(workload),
    preregistrationDigest: dagLiveDigest(preregistration), ...structuredClone(DAG_LIVE_DEFAULT_LIMITS) };
}

export interface DagLiveArmResult {
  answer: string | null; correct: boolean; calls: number; inputTokens: number; outputTokens: number; latencyMs: number; requestIds: string[];
}
export interface DagLivePair {
  pattern: DagLivePattern; taskId: string; slice: string; index: number; order: 'baseline-first' | 'candidate-first'; label: string;
  baseline: DagLiveArmResult;
  candidate: DagLiveArmResult & { outcome: string; receiptDigest: string; unusedCalls: number; unusedTokens: number };
}

interface PairContext {
  task: DagLiveTask; index: number; approval: DagLiveApproval; adapter: MeteredJevAdapter; control: RunControl; calls: DagLiveCall[];
  host: DagLiveHost; executeFlow: FlowExecutor; skillId: `aiwg:skill:${string}`; perCallTokenBound: number; now: () => number; signal: AbortSignal;
}
function invoker(context: PairContext, arm: 'baseline' | 'candidate', setup: ArmSetup): (request: GraphFlowRequest) => Promise<GraphFlowResponse> {
  const { task, approval, adapter, control } = context;
  const unknownCostBoundUsd = Math.ceil(context.perCallTokenBound * approval.price.ceilingUsdPerMTok) / 1_000_000;
  const projection = policy(approval.model, approval.region);
  return async flow => {
    if (control.stopped || context.signal.aborted) { control.stop(control.stopped ?? 'deadline'); throw new DecisionGraphError('D12 run stopped'); }
    const { node, input } = decisionFlowNode(setup.graph, flow);
    if (HOST_LOCAL.has(node.id)) {
      if (node.id !== 'taxonomy') throw new DecisionGraphError('unexpected host-local node');
      // Caller-authored fixed children: no model can create or rename a branch.
      return { outputs: { children: ['branch-a', 'branch-b'] }, attempts: 1, usage: { tokens: 0, costUsd: 0, timeMs: 0 } };
    }
    const resolved = setup.requests.get(node.id);
    if (!resolved) throw new DecisionGraphError('unresolved D12 node');
    assertDecisionFlowPins(node, resolved.binding, Object.values(resolved.definitions));
    adapter.context = { pattern: task.pattern, taskId: task.id, arm, node: node.id };
    let result;
    try {
      result = await evaluateDecisionRuleset({ ...resolved, input: { subject: structuredClone(task.subject), evidence: input },
        runId: flow.runId, invocationId: flow.invocationKey, adapters: { jev: adapter },
        resolveCredential: async reference => {
          if (reference !== approval.secretServiceReference || control.stopped) throw new Error('D12 credential access denied');
          return context.host.resolveCredential(reference);
        },
        projection: { resolve: () => structuredClone(projection) }, signal: context.signal });
    } finally { adapter.context = null; }
    const evaluation = result.spec.evaluations.answer;
    if (!evaluation || evaluation.spec.status !== 'success' || evaluation.spec.value === undefined) {
      control.stop(control.stopped ?? `evaluation-${evaluation?.spec.reason ?? result.spec.reason}`);
      throw new DecisionGraphError('D12 evaluation failed');
    }
    const value = evaluation.spec.value;
    return decisionFlowResponse(setup.graph, node, result, { unknownCostBoundUsd, project: () => {
      try { return project(task, node.id, value, input); } catch (error) { control.stop('out-of-contract-answer'); throw error; }
    } });
  };
}
function armCalls(calls: DagLiveCall[], taskId: string, arm: 'baseline' | 'candidate') {
  const rows = calls.filter(call => call.taskId === taskId && call.arm === arm);
  return { calls: rows.length, inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0), requestIds: rows.flatMap(row => row.requestId ? [row.requestId] : []), rows };
}

async function runBaseline(context: PairContext, arms: DagLiveArms): Promise<DagLiveArmResult> {
  const started = context.now();
  const report = await context.executeFlow(arms.baseline.flow, { validation: { catalogIds: new Set([context.skillId]) },
    invokeNode: invoker(context, 'baseline', arms.baseline), runId: `d12-flat-${context.task.id}` });
  const latencyMs = Math.max(0, context.now() - started);
  const usage = armCalls(context.calls, context.task.id, 'baseline');
  const raw = report.status === 'completed' ? report.results.flat?.outputs.result : undefined;
  if (typeof raw !== 'string') context.control.stop(context.control.stopped ?? `baseline-${report.status}`);
  const answer = typeof raw === 'string' ? raw : null;
  const { rows: _rows, ...totals } = usage;
  return { answer, correct: answer === context.task.label, ...totals, latencyMs };
}
async function runCandidate(context: PairContext, arms: DagLiveArms): Promise<DagLivePair['candidate']> {
  const { graph, template, flow } = arms.candidate;
  const records: Array<{ request: GraphFlowRequest; response: GraphFlowResponse }> = [];
  const perCallMicros = Math.ceil(context.perCallTokenBound * context.approval.price.ceilingUsdPerMTok);
  const started = context.now();
  const adapter = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, template.plan, NARROW),
    request => HOST_LOCAL.has(request.node.id) ? { attempts: 1, tokens: 1, costMicros: 1 } : { attempts: 1, tokens: context.perCallTokenBound, costMicros: perCallMicros },
    graphBeamFlowInvoker(graph, invoker(context, 'candidate', arms.candidate), NARROW), context.signal, record => records.push(structuredClone(record)));
  const report = await context.executeFlow(flow, { validation: { catalogIds: new Set([context.skillId]) }, invokeNode: adapter, runId: `d12-dag-${context.task.id}` });
  const latencyMs = Math.max(0, context.now() - started);
  const usage = armCalls(context.calls, context.task.id, 'candidate');
  const { rows, ...totals } = usage;
  let outcome = 'error'; let receiptDigest = ''; let answer: string | null = null; let unusedCalls = 0; let unusedTokens = 0;
  if (!context.control.stopped) {
    const receipt = finalizeDecisionGraphRun(graph, template.plan, report, records, NARROW);
    outcome = receipt.outcome; receiptDigest = receipt.receiptDigest;
    const unused = new Set(receipt.evidence.stages.flatMap(stage => stage.nodes.filter(node => node.status === 'ok' && !node.used).map(node => node.id)));
    // Speculative work outside the selected evidence stays in the totals and is reported here.
    for (const row of rows) if (unused.has(row.node)) { unusedCalls++; unusedTokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0); }
    if (outcome === 'complete' && receipt.value && typeof (receipt.value as { result?: unknown }).result === 'string') answer = (receipt.value as { result: string }).result;
    else if (outcome === 'empty-shortlist' && context.task.pattern === 'shortlist-rerank') answer = 'none';
    else context.control.stop(`candidate-outcome-${outcome}`);
  }
  return { answer, correct: answer !== null && answer === context.task.label, ...totals, latencyMs, outcome, receiptDigest, unusedCalls, unusedTokens };
}

const quantile = (values: number[], q: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
};
export interface DagLivePatternAnalysis {
  pattern: DagLivePattern; n: number; complete: boolean;
  quality: { baselineCorrect: number; candidateCorrect: number; table: { both: number; candidateOnly: number; baselineOnly: number; neither: number };
    baselineAccuracyInterval: readonly [number, number] | null; candidateAccuracyInterval: readonly [number, number] | null;
    difference: PairedDifferenceInterval | null; nonInferiority: { decision: string; reason: string };
    slices: Record<string, { n: number; baselineCorrect: number; candidateCorrect: number }> };
  economics: {
    baseline: { calls: number; inputTokens: number; outputTokens: number; billableUsd: number; p50LatencyMs: number | null; p95LatencyMs: number | null };
    candidate: { calls: number; inputTokens: number; outputTokens: number; billableUsd: number; p50LatencyMs: number | null; p95LatencyMs: number | null };
    net: { calls: number; tokens: number; billableUsd: number };
    callRatio: number | null; p95LatencyRatio: number | null; extraTokensPerTask: PairedDifferenceInterval | null; extraTokensPerTaskUpper: number | null;
    speculative: { unusedCalls: number; unusedTokens: number }; outcomes: Record<string, number>;
    checks: { callRatio: boolean; p95LatencyRatio: boolean; extraTokensPerTask: boolean }; pass: boolean };
  eligible: boolean;
}
/**
 * Paired analysis with the shared helpers at the preregistered level and margin. A pattern is
 * eligible for the reviewer only with complete pairs, a non-inferior lower bound and every
 * preregistered economics bound met. Unknown values fail closed.
 */
export function analyzeDagLivePattern(pattern: DagLivePattern, pairs: readonly DagLivePair[], preregistration: DagLivePreregistration,
  price: DagLiveApproval['price']): DagLivePatternAnalysis {
  const { nonInferiority: ni, economics: econ } = preregistration.analysis;
  const rows = pairs.filter(pair => pair.pattern === pattern);
  const n = rows.length;
  const table = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
  const slices: DagLivePatternAnalysis['quality']['slices'] = {};
  for (const row of rows) {
    const key = row.candidate.correct ? (row.baseline.correct ? 'both' : 'candidateOnly') : (row.baseline.correct ? 'baselineOnly' : 'neither');
    table[key]++;
    const slice = slices[row.slice] ??= { n: 0, baselineCorrect: 0, candidateCorrect: 0 };
    slice.n++; slice.baselineCorrect += row.baseline.correct ? 1 : 0; slice.candidateCorrect += row.candidate.correct ? 1 : 0;
  }
  const baselineCorrect = table.both + table.baselineOnly, candidateCorrect = table.both + table.candidateOnly;
  const difference = n ? pairedBinaryDifferenceInterval({ counts: table, levelBps: ni.levelBps, method: ni.method }) : null;
  const decision = difference ? pairedNonInferiority({ interval: difference, marginBps: ni.marginBps }) : { decision: 'insufficient', reason: 'no-pairs' };
  const arm = (key: 'baseline' | 'candidate') => {
    const inputTokens = rows.reduce((sum, row) => sum + row[key].inputTokens, 0), outputTokens = rows.reduce((sum, row) => sum + row[key].outputTokens, 0);
    return { calls: rows.reduce((sum, row) => sum + row[key].calls, 0), inputTokens, outputTokens,
      billableUsd: (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000,
      p50LatencyMs: quantile(rows.map(row => row[key].latencyMs), 0.5), p95LatencyMs: quantile(rows.map(row => row[key].latencyMs), 0.95) };
  };
  const baseline = arm('baseline'), candidate = arm('candidate');
  const callRatio = baseline.calls > 0 ? candidate.calls / baseline.calls : null;
  const p95LatencyRatio = baseline.p95LatencyMs && candidate.p95LatencyMs !== null ? candidate.p95LatencyMs / baseline.p95LatencyMs : null;
  // Per-task extra tokens scaled into [-1, 1] by the worst-case candidate tokens per task.
  const scale = DAG_LIVE_MAX_CANDIDATE_CALLS[pattern] * preregistration.analysis.perCallTokenBound;
  const differences = rows.map(row => (row.candidate.inputTokens + row.candidate.outputTokens - row.baseline.inputTokens - row.baseline.outputTokens) / scale);
  let extraTokensPerTask: PairedDifferenceInterval | null = null;
  if (differences.length >= 2 && differences.every(d => d >= -1 && d <= 1)) {
    extraTokensPerTask = pairedMeanDifferenceBootstrap({ differences, levelBps: econ.bootstrap.levelBps, seed: econ.bootstrap.seed,
      resamples: econ.bootstrap.resamples, bounds: [-1, 1] });
  }
  const extraTokensPerTaskUpper = extraTokensPerTask ? Math.ceil(extraTokensPerTask.upperBps / 10_000 * scale) : null;
  const checks = { callRatio: callRatio !== null && callRatio <= econ.maxCallRatio,
    p95LatencyRatio: p95LatencyRatio !== null && Number.isFinite(p95LatencyRatio) && p95LatencyRatio <= econ.maxP95LatencyRatio,
    extraTokensPerTask: extraTokensPerTaskUpper !== null && extraTokensPerTaskUpper <= econ.maxExtraTokensPerTaskUpper };
  const outcomes: Record<string, number> = {};
  for (const row of rows) outcomes[row.candidate.outcome] = (outcomes[row.candidate.outcome] ?? 0) + 1;
  const complete = n === preregistration.tasksPerPattern && new Set(rows.map(row => row.taskId)).size === n;
  const economicsPass = checks.callRatio && checks.p95LatencyRatio && checks.extraTokensPerTask;
  return { pattern, n, complete,
    quality: { baselineCorrect, candidateCorrect, table,
      baselineAccuracyInterval: n ? wilsonScoreInterval({ events: baselineCorrect, n, levelBps: ni.levelBps }) : null,
      candidateAccuracyInterval: n ? wilsonScoreInterval({ events: candidateCorrect, n, levelBps: ni.levelBps }) : null,
      difference, nonInferiority: decision, slices },
    economics: { baseline, candidate, net: { calls: candidate.calls - baseline.calls,
      tokens: candidate.inputTokens + candidate.outputTokens - baseline.inputTokens - baseline.outputTokens,
      billableUsd: candidate.billableUsd - baseline.billableUsd },
      callRatio, p95LatencyRatio, extraTokensPerTask, extraTokensPerTaskUpper,
      speculative: { unusedCalls: rows.reduce((sum, row) => sum + row.candidate.unusedCalls, 0), unusedTokens: rows.reduce((sum, row) => sum + row.candidate.unusedTokens, 0) },
      outcomes, checks, pass: economicsPass },
    eligible: complete && decision.decision === 'non-inferior' && economicsPass };
}

/** Offline, credential-free worst-case plan against the approval limits. */
export function planDagLiveQualification(workload: DagLiveWorkload, preregistration: DagLivePreregistration,
  limits: Pick<DagLiveApproval, 'budget' | 'price'>) {
  validateDagLiveInputs(workload, preregistration);
  const bound = preregistration.analysis.perCallTokenBound;
  const fraction = preregistration.analysis.stopRules.budgetStopFraction;
  const patterns = DAG_LIVE_PATTERNS.map(pattern => {
    const tasks = workload.tasks.filter(task => task.pattern === pattern);
    let expectedTokens = 0; let largestCall = 0;
    for (const task of tasks) {
      for (const [node, definition] of Object.entries(dagLiveDefinitions(task))) {
        const evidence = node === 'rerank' ? { candidates: { sectionIndex: 0, section: 'x'.repeat(24), items: Array(4).fill('x'.repeat(24)) } }
          : node === 'verifier' || node === 'fallback' ? { evidence: { status: 'awaiting-pickup' } } : node.startsWith('branch-') ? { children: ['branch-a', 'branch-b'] } : {};
        const tokens = estimator.estimate({ state: { untrusted: { subject: task.subject, evidence } }, question: JSON.parse(compileJevQuestion(definition).question) } as never).tokens + REQUEST_ENVELOPE_TOKENS;
        largestCall = Math.max(largestCall, tokens);
        expectedTokens += tokens;
      }
    }
    const baselineCalls = tasks.length, candidateCalls = tasks.length * DAG_LIVE_MAX_CANDIDATE_CALLS[pattern];
    const calls = baselineCalls + candidateCalls;
    return { pattern, tasks: tasks.length, worstCase: { baselineCalls, candidateCalls, calls, tokens: calls * bound,
      reservedUsd: calls * Math.ceil(bound * limits.price.ceilingUsdPerMTok) / 1_000_000 },
    estimatedVisibleTokens: expectedTokens, largestEstimatedCallTokens: largestCall,
    withinPatternStop: calls <= Math.floor(limits.budget.perPattern.calls * fraction) && calls * bound <= Math.floor(limits.budget.perPattern.tokens * fraction)
      && calls * Math.ceil(bound * limits.price.ceilingUsdPerMTok) <= Math.floor(limits.budget.perPattern.usd * 1_000_000 * fraction) };
  });
  const calls = patterns.reduce((sum, p) => sum + p.worstCase.calls, 0);
  const reservedUsd = patterns.reduce((sum, p) => sum + p.worstCase.reservedUsd, 0);
  const visible = patterns.reduce((sum, p) => sum + p.estimatedVisibleTokens, 0);
  return { schemaVersion: 'dag-live-plan/v1', providerCalls: 0, workloadDigest: dagLiveDigest(workload), preregistrationDigest: dagLiveDigest(preregistration),
    perCallTokenBound: bound, stopFraction: fraction, patterns,
    totals: { worstCaseCalls: calls, worstCaseTokens: calls * bound, worstCaseReservedUsd: Math.round(reservedUsd * 1e6) / 1e6,
      estimatedVisibleTokens: visible, estimatedBillableUsdAtInputPrice: Math.round(visible * limits.price.inputUsdPerMTok) / 1e6,
      hardCapUsd: DAG_LIVE_HARD_CAP_USD },
    boundCoversLargestEstimate: patterns.every(p => p.largestEstimatedCallTokens <= bound),
    withinBudget: patterns.every(p => p.withinPatternStop) && calls <= Math.floor(limits.budget.calls * fraction)
      && calls * bound <= Math.floor(limits.budget.tokens * fraction) && reservedUsd <= limits.budget.usd * fraction };
}

const write = (path: string, value: unknown) => writeFile(path, canonicalJson(value), { flag: 'wx', mode: 0o600 });
const fileDigest = async (path: string) => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
const liveGateOpen = () => process.env[DAG_LIVE_ENV_GATE] === '1';

/**
 * Runs the approved paired collection and writes digest-bound evidence under
 * `<artifactRoot>/<runId>/`. With `transport` the run is labelled synthetic and never
 * counts as live evidence. Without it the explicit env gate and the full preregistered
 * workload are required.
 */
export async function runDagLiveQualification(options: {
  approval: DagLiveApproval; workload: DagLiveWorkload; preregistration: DagLivePreregistration; sourceRoot: string; artifactRoot: string;
  host: DagLiveHost; executeFlow: FlowExecutor; skillId: `aiwg:skill:${string}`; transport?: typeof fetch; now?: () => number;
  sourceGoldens?: readonly string[];
}): Promise<Record<string, unknown>> {
  const approval = structuredClone(options.approval), workload = structuredClone(options.workload), preregistration = structuredClone(options.preregistration);
  validateDagLiveApproval(approval, workload, preregistration);
  const synthetic = options.transport !== undefined;
  if (!synthetic && (!liveGateOpen() || workload.tasksPerPattern !== DAG_LIVE_TASKS_PER_PATTERN)) throw new Error('D12 live run requires the env gate and the full preregistered workload');
  await assertContextLiveSource(options.sourceRoot, approval.sourceCommit);
  await assertContextArtifactRoot(options.sourceRoot, options.artifactRoot);
  const now = options.now ?? Date.now;
  const directory = resolve(options.artifactRoot, approval.runId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  // Frozen inputs are persisted before any credential or provider operation.
  await write(join(directory, 'preregistration.json'), preregistration);
  await write(join(directory, 'workload.json'), workload);
  await write(join(directory, 'approval.json'), approval);
  const callsPath = join(directory, 'calls.jsonl'), pairsPath = join(directory, 'pairs.jsonl');
  await writeFile(callsPath, '', { flag: 'wx', mode: 0o600 }); await writeFile(pairsPath, '', { flag: 'wx', mode: 0o600 });
  const { analysis } = preregistration;
  const started = now();
  const budget = new DagLiveBudget(approval, analysis.perCallTokenBound, analysis.stopRules.budgetStopFraction, started, now);
  const control = new RunControl();
  const calls: DagLiveCall[] = [];
  const adapter = new MeteredJevAdapter(new JevDecisionAdapter({ region: approval.region, ...(synthetic ? { fetch: options.transport } : {}) }),
    budget, approval.model, analysis.perCallTokenBound, control, now, async call => { calls.push(call); await appendFile(callsPath, `${canonicalJson(call)}\n`); });
  const controller = new AbortController();
  const timer = setTimeout(() => { control.stop('budget-run-wall-clock'); controller.abort(); },
    Math.min(2_147_483_647, Math.floor(approval.budget.wallClockMs * analysis.stopRules.budgetStopFraction)));
  const pairs: DagLivePair[] = [];
  // One secret-service read per run; each call gets a copy the adapter zeroes after use.
  const vault: { secret: Uint8Array | null } = { secret: null };
  const host: DagLiveHost = { resolveCredential: async reference => {
    vault.secret ??= new Uint8Array(await options.host.resolveCredential(reference));
    return new Uint8Array(vault.secret);
  } };
  try {
    for (const pattern of DAG_LIVE_PATTERNS) {
      const tasks = workload.tasks.filter(task => task.pattern === pattern);
      for (const [index, task] of tasks.entries()) {
        if (control.stopped) break;
        const arms = buildDagLiveArms(task, { model: approval.model, secretServiceReference: approval.secretServiceReference, skillId: options.skillId,
          perCallTokenBound: analysis.perCallTokenBound, ceilingUsdPerMTok: approval.price.ceilingUsdPerMTok, taskDeadlineMs: approval.taskDeadlineMs });
        if (speculativeActionViolation(arms.baseline.flow) || speculativeActionViolation(arms.candidate.flow)) { control.stop('speculative-action'); break; }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(approval.taskDeadlineMs)]);
        const context: PairContext = { task, index, approval, adapter, control, calls, host, executeFlow: options.executeFlow,
          skillId: options.skillId, perCallTokenBound: analysis.perCallTokenBound, now, signal };
        const order = index % 2 === 0 ? 'baseline-first' as const : 'candidate-first' as const;
        let baseline: DagLiveArmResult | undefined, candidate: DagLivePair['candidate'] | undefined;
        try {
          if (order === 'baseline-first') { baseline = await runBaseline(context, arms); if (!control.stopped) candidate = await runCandidate(context, arms); }
          else { candidate = await runCandidate(context, arms); if (!control.stopped) baseline = await runBaseline(context, arms); }
        } catch { control.stop(control.stopped ?? 'pair-exception'); }
        // A pair counts only when both arms finished without a stop.
        if (control.stopped || !baseline || !candidate) break;
        const pair: DagLivePair = { pattern, taskId: task.id, slice: task.slice, index, order, label: task.label, baseline, candidate };
        pairs.push(pair);
        await appendFile(pairsPath, `${canonicalJson(pair)}\n`);
        if (patternCallRatioExceeded(pairs, pattern, analysis.stopRules.maxPatternCallRatio)) control.stop('pattern-call-ratio');
      }
      if (control.stopped) break;
    }
  } finally { clearTimeout(timer); vault.secret?.fill(0); }
  await assertContextLiveSource(options.sourceRoot, approval.sourceCommit);
  const analyses = DAG_LIVE_PATTERNS.map(pattern => analyzeDagLivePattern(pattern, pairs, preregistration, approval.price));
  const stopped = control.stopped;
  const recommendation = !stopped && !synthetic && analyses.every(item => item.eligible) ? 'eligible-for-promotion-review' : 'hold';
  const elapsedMs = Math.max(0, now() - started);
  const summary = { schemaVersion: 'dag-live-summary/v1', issue: '#2686', runId: approval.runId, sourceCommit: approval.sourceCommit,
    source: synthetic ? 'synthetic' : 'provider', liveEvidence: !synthetic, stagingHost: approval.stagingHost, model: approval.model,
    workloadDigest: approval.workloadDigest, preregistrationDigest: approval.preregistrationDigest, approvalDigest: dagLiveDigest(approval),
    callsDigest: await fileDigest(callsPath), pairsDigest: await fileDigest(pairsPath), stopped, pairs: pairs.length, providerCalls: calls.length,
    reserved: { calls: budget.total.calls, tokens: budget.total.tokens, usd: budget.usd() }, elapsedMs,
    analyses, recommendation, promotionDecision: 'pending-reviewer', reviewer: approval.reviewer, automaticPromotion: false };
  await write(join(directory, 'summary.json'), summary);
  // G5 input: observed resources against the approved bounds, pinned by manifest digest.
  const loadManifest = { schema: 'decision-load-manifest/v1', mode: synthetic ? 'synthetic-transport' : 'staged-provider', bounds: {
    calls: approval.budget.calls, tokens: approval.budget.tokens, reservedUsdMicros: Math.round(approval.budget.usd * 1_000_000), wallClockMs: approval.budget.wallClockMs,
    ...Object.fromEntries(DAG_LIVE_PATTERNS.map(p => [`${p}-call-ratio-milli`, analysis.stopRules.maxPatternCallRatio * 1000])) } };
  const loadPath = join(directory, 'g5-load-result.json');
  await write(loadPath, { schemaVersion: 'decision-load-result/v1', manifestDigest: loadManifestDigest(loadManifest), manifest: loadManifest, mode: loadManifest.mode,
    observations: { calls: budget.total.calls, tokens: budget.total.tokens, reservedUsdMicros: budget.total.usdMicros, wallClockMs: elapsedMs,
      ...Object.fromEntries(analyses.map(item => [`${item.pattern}-call-ratio-milli`, item.economics.callRatio === null ? -1 : Math.ceil(item.economics.callRatio * 1000)])) },
    recordedAt: new Date().toISOString() });
  const summaryDigest = await fileDigest(join(directory, 'summary.json'));
  // D11 replays the recorded collection: each case re-reads the digest-bound pairs and recomputes its analysis.
  const run = await executeQualificationPlan({ artifactRoot: options.artifactRoot, concurrency: 1, timeoutMs: 600_000,
    manifest: { schemaVersion: 'decision-qualification-run/v1', mode: synthetic ? 'offline' : 'recorded', runId: approval.runId,
      generatedAt: new Date().toISOString(), sourceCommit: approval.sourceCommit, dirty: false,
      cases: DAG_LIVE_PATTERNS.map(pattern => ({ id: `d12-${pattern}`, kind: 'baseline', mandatory: true, candidateTests: [],
        evidenceIds: [`BCH-D12-${pattern.toUpperCase()}`] })) } as never,
    executors: Object.fromEntries(DAG_LIVE_PATTERNS.map(pattern => [`d12-${pattern}`, async () => {
      if (await fileDigest(pairsPath) !== summary.pairsDigest) return { outcome: 'fail' as const, details: { reason: 'pairs-digest-mismatch' } };
      const text = await readFile(pairsPath, 'utf8');
      const recorded = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as DagLivePair);
      const replay = analyzeDagLivePattern(pattern, recorded, preregistration, approval.price);
      const matches = canonicalJson(replay) === canonicalJson(analyses.find(item => item.pattern === pattern));
      return { outcome: matches && replay.eligible && !stopped && !synthetic ? 'pass' as const : 'fail' as const,
        details: { summaryDigest, pairsDigest: summary.pairsDigest, replayMatches: matches, stopped, source: summary.source, analysis: replay } };
    }])),
    // Only an unstopped live run may offer its load result as the G5 gate artifact.
    ...(!synthetic && !stopped ? { gateArtifacts: { 'load-manifest-qualified': loadPath } } : {}), sanitizeDetails: details => details });
  await write(join(directory, 'run-manifest.json'), run);
  const sources = options.sourceGoldens ?? DAG_LIVE_SOURCE_GOLDENS;
  const evidence = await writeQualificationEvidenceManifest(run, options.artifactRoot, options.sourceRoot,
    Object.fromEntries(DAG_LIVE_PATTERNS.map(pattern => [`d12-${pattern}`, [...sources]])));
  // G6 input: the reviewer signs this outcome digest with --record-decision.
  await write(join(directory, 'g6-review-request.json'), { schemaVersion: 'dag-live-review-request/v1', runId: approval.runId, sourceCommit: approval.sourceCommit,
    outcomesDigest: qualificationOutcomesDigest(run), summaryDigest, evidenceManifestDigest: evidence.digest, recommendation, reviewer: approval.reviewer });
  return { ...summary, summaryDigest, evidenceManifest: evidence.artifact, evidenceDigest: evidence.digest,
    g5LoadResult: `${approval.runId}/g5-load-result.json`, g6ReviewRequest: `${approval.runId}/g6-review-request.json` };
}
export const DAG_LIVE_SOURCE_GOLDENS = ['src/decision/graph-live-qualification.ts', 'src/decision/graph-live-workload.ts',
  'docs/decision/evidence/dag-live-v1/workload.json', 'docs/decision/evidence/dag-live-v1/preregistration.json'] as const;

/**
 * Records the named reviewer's promote-or-hold decision against a finished run directory.
 * Promotion is refused unless the recorded run was live, unstopped and eligible for every pattern.
 */
export async function recordDagLiveDecision(runDirectory: string, decision: 'promote' | 'hold', reviewer: string, rationale: string, at = new Date()) {
  if (!['promote', 'hold'].includes(decision) || !reviewer?.trim() || !rationale?.trim()) throw new Error('D12 decision requires promote|hold, reviewer and rationale');
  const summaryPath = join(runDirectory, 'summary.json'), requestPath = join(runDirectory, 'g6-review-request.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as { runId: string; sourceCommit: string; recommendation: string; liveEvidence: boolean; stopped: string | null; reviewer: string };
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as { summaryDigest: string; outcomesDigest: `sha256:${string}`; runId: string };
  if (request.summaryDigest !== await fileDigest(summaryPath) || request.runId !== summary.runId) throw new Error('D12 review request does not bind this summary');
  if (reviewer !== summary.reviewer) throw new Error('D12 decision must come from the approved promotion owner');
  if (decision === 'promote' && (summary.recommendation !== 'eligible-for-promotion-review' || !summary.liveEvidence || summary.stopped)) {
    throw new Error('D12 promotion refused: evidence is not live, complete and eligible');
  }
  const recordedAt = at.toISOString();
  const review = { schemaVersion: 'decision-qualification-review/v1', runId: summary.runId, sourceCommit: summary.sourceCommit,
    outcomesDigest: request.outcomesDigest, reviewer, decision: decision === 'promote' ? 'approve' : 'reject', recordedAt };
  const record = { schemaVersion: 'dag-live-promotion-decision/v1', issue: '#2686', runId: summary.runId, sourceCommit: summary.sourceCommit,
    summaryDigest: request.summaryDigest, decision, reviewer, rationale, recordedAt, reviewRecordDigest: dagLiveDigest(review) };
  await write(join(runDirectory, 'g6-review-record.json'), review);
  await write(join(runDirectory, 'promotion-decision.json'), record);
  return record;
}
