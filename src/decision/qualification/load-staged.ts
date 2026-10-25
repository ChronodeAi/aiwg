import { cpus, hostname, totalmem } from 'node:os';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionConfig } from '../../config/decision-config.js';
import { JevDecisionAdapter, compileJevQuestion } from '../adapters/jev.js';
import { DecisionAdmissionRegistry, type AdmissionBreakerTransitionRecord, type AdmissionProfileChangeRecord } from '../admission.js';
import { CanonicalJsonByteEstimator } from '../context-plan.js';
import { assertContextLiveSource } from '../context-live-qualification.js';
import { tokenCost } from '../pricing.js';
import type { AdapterObservation, DecisionAdmissionEvidence, DecisionAdmissionLimits, DecisionDefinition, DecisionUsage } from '../types.js';
import {
  admissionControllerLoadDriver, decisionLoadArrivals, compareDecisionLoadBounds, decisionLoadManifestDigest, decisionLoadPolicy,
  runDecisionLoadHarness, type DecisionLoadArrival, type DecisionLoadClock, type DecisionLoadManifestV2,
  type DecisionLoadObservations, type DecisionLoadResourceObservations,
} from './load.js';

export interface DecisionLoadManifestV3 extends Omit<DecisionLoadManifestV2, 'schema' | 'bounds'> {
  schema: 'decision-load-manifest/v3';
  mode: 'staged-provider';
  model: string;
  sampleIntervalMs: number;
  requestTimeoutMs: number;
  budget: { maxUsd: number; stopAtFraction: 0.8; maxCalls: number; maxTokens: number; maxWallClockSeconds: number };
  stopConditions: { maximumBreakerOpenMs: number; maximum429StormMs: number; maximumRetryAmplificationRatio: 1.25; maximumCrossPrincipalQuotaViolations: 0 };
  bounds: DecisionLoadManifestV2['bounds'] & { maximumResidentMemoryMiB: number; maximumSampleGapMs: number };
  rollout: { previousProfileVersion: string; workspace: DecisionAdmissionLimits; providers: Record<string, DecisionAdmissionLimits>;
    shadowSeconds: number; rollbackSeconds: number };
}
export type DecisionLoadPricing = NonNullable<NonNullable<DecisionConfig['ask']>['cost']>;
export type DecisionLoadPhase = 'shadow' | 'canary' | 'rollback';
export type DecisionLoadStopReason = 'budget-usd-80-percent' | 'max-calls' | 'max-tokens' | 'max-wall-clock'
  | 'breaker-open' | 'retry-amplification' | '429-storm' | 'cross-principal-quota' | 'source-drift'
  | 'usage-exceeds-reservation' | 'invalid-reservation' | 'driver-error';
export interface DecisionLoadResourceSample {
  atMs: number; residentMemoryMiB: number; heapUsedMiB: number; cpuPercentOneCore: number; active: number; queued: number;
}
export interface DecisionLoadAttemptReceipt {
  phase: DecisionLoadPhase; arrivalOrdinal: number; principalId: string; providerId: string; attempt: number;
  admittedAtMs: number; settledAtMs: number; tokens: number; costUsd: number;
  admission: DecisionAdmissionEvidence; status: AdapterObservation['status']; reason: AdapterObservation['reason'];
  usage: DecisionUsage; httpStatus?: number;
  servedModel?: string; requestId?: string;
}
export interface DecisionStagedLoadStage {
  phase: DecisionLoadPhase; profileVersion: string; windowSeconds: number;
  observations: DecisionLoadObservations; resources: DecisionLoadResourceObservations;
  scopes: Record<string, { active: number; queued: number }>;
}
export interface DecisionStagedLoadComparison { bound: string; limit: number; observed: number; pass: boolean }
export interface DecisionLoadReservedUsage { calls: number; tokens: number; usd: number }
export interface DecisionLoadReportedTotals {
  inputTokens: number | null; outputTokens: number | null; tokens: number | null; usd: number | null;
}
export interface DecisionLoadReportedUsage extends DecisionLoadReportedTotals {
  /** calls counts dispatched attempts, including those with unknown token usage. */
  calls: number;
  /** Calls missing either token dimension or applicable sourced pricing. */
  incompleteCalls: number;
  /** Sum of known reports only; never represents an unknown call as zero. */
  knownSubtotal: DecisionLoadReportedTotals;
}
export interface DecisionStagedLoadRecord {
  schemaVersion: 'decision-load-result/v2'; kind: 'load-manifest-qualified';
  manifest: DecisionLoadManifestV3; manifestBytes: string; manifestDigest: string;
  mode: 'staged-provider'; execution: 'live' | 'offline-fake-provider'; sourceCommit: string; dirty: boolean;
  host: { hostname: string; cpuClass: string; memoryGiB: number; networkPath: string; node: string; platform: string; arch: string };
  pricing: DecisionLoadPricing; stages: DecisionStagedLoadStage[]; receipts: DecisionLoadAttemptReceipt[];
  samples: DecisionLoadResourceSample[]; profileHistory: AdmissionProfileChangeRecord[]; breakerTransitions: AdmissionBreakerTransitionRecord[];
  reservedUsage: DecisionLoadReservedUsage;
  /** Each total is null if any attempt lacks the corresponding provider usage or applicable pricing. */
  reportedUsage: DecisionLoadReportedUsage;
  stop: { reason: DecisionLoadStopReason; atMs: number } | null;
  startedAtMs: number; elapsedMs: number; retries: number; queueWaitDistribution: { count: number; p50: number; p95: number; p99: number; maximum: number }; comparisons: DecisionStagedLoadComparison[]; passed: boolean; digest: string;
}
/** Original staged evidence is verified in its original shape and digest domain. */
export interface DecisionStagedLoadRecordV1 extends Omit<DecisionStagedLoadRecord, 'schemaVersion' | 'reservedUsage' | 'reportedUsage'> {
  schemaVersion: 'decision-load-result/v1'; usage: DecisionLoadReservedUsage;
}
export const DECISION_STAGED_LOAD_RESULT_VERSIONS = ['decision-load-result/v1', 'decision-load-result/v2'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const exactCommit = (value: string): boolean => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

/** Read historical manifests without rewriting them; v3 is the only staged runner input. */
export function readDecisionLoadManifest(bytes: string): DecisionLoadManifestV2 | DecisionLoadManifestV3 | { schema: 'decision-load-manifest/v1'; [key: string]: unknown } {
  const value = JSON.parse(bytes);
  if (value?.schema === 'decision-load-manifest/v1' && value.profile && value.bounds && value.duration) return value;
  if (value?.schema === 'decision-load-manifest/v2' && value.workspace && value.providers && value.principals && value.arrivalModel && value.bounds) return value;
  validateDecisionLoadManifestV3(value);
  return value;
}
export function validateDecisionLoadManifestV3(value: unknown): asserts value is DecisionLoadManifestV3 {
  const m = value as DecisionLoadManifestV3;
  if (!m || m.schema !== 'decision-load-manifest/v3' || m.mode !== 'staged-provider' || !m.version || !m.profileVersion
    || !/^jev-\d+\.\d+\.\d+$/.test(m.model) || !m.budget || !positive(m.budget.maxUsd) || m.budget.stopAtFraction !== 0.8
    || ![m.budget.maxCalls, m.budget.maxTokens, m.budget.maxWallClockSeconds, m.sampleIntervalMs, m.requestTimeoutMs].every(v => Number.isSafeInteger(v) && v > 0)
    || !m.stopConditions || m.stopConditions.maximumRetryAmplificationRatio !== 1.25 || m.stopConditions.maximumCrossPrincipalQuotaViolations !== 0
    || ![m.stopConditions.maximumBreakerOpenMs, m.stopConditions.maximum429StormMs].every(positive)
    || !m.rollout || !m.rollout.previousProfileVersion || m.rollout.previousProfileVersion === m.profileVersion
    || ![m.rollout.shadowSeconds, m.rollout.rollbackSeconds].every(positive)
    || !m.duration || ![m.duration.loadSeconds, m.duration.spikeSeconds, m.duration.soakSeconds, m.duration.evaluatorSampleSeconds].every(positive)
    || !m.principals?.length || !m.principals.some(p => p.class === 'noisy') || !m.principals.some(p => p.class === 'quiet')
    || new Set(m.principals.map(p => p.id)).size !== m.principals.length
    || !m.providers || Object.keys(m.providers).join() !== 'jev' || !m.rollout.providers || Object.keys(m.rollout.providers).join() !== 'jev') {
    throw new Error('Invalid staged v3 manifest: explicit maxUsd and complete budget, stop conditions and profiles required');
  }
  const scopes = [m.workspace, ...Object.values(m.providers), ...m.principals.map(p => p.limits), m.rollout.workspace, ...Object.values(m.rollout.providers)];
  for (const scope of scopes) {
    if (!scope || !Number.isSafeInteger(scope.concurrency) || scope.concurrency < 1 || scope.concurrency >= 8
      || ![scope.requestsPerMinute, scope.tokensPerSecond, scope.maxCostUsd, scope.maxRetainedWork, scope.maxQueueLength, scope.maxQueueWaitMs].every(positive)) {
      throw new Error('Every v3 scope requires rpm, tps, cost, retained-work and queue bounds; concurrency must be below 8');
    }
  }
  const knownBounds = ['maximumActiveCalls', 'maximumQueuedCalls', 'maximumHeapUsedMiB', 'maximumResidentMemoryMiB', 'maximumCpuPercentOneCore',
    'maximumEligibleLaneWaitMs', 'maximumRetryAmplificationRatio', 'maximumCancellationLatencyMs', 'minimumQuietPrincipalAdmissionRatio', 'maximumSampleGapMs'];
  if (!m.bounds || Object.keys(m.bounds).length !== knownBounds.length || !knownBounds.every(k => finite(m.bounds[k as keyof typeof m.bounds]))
    || m.bounds.maximumRetryAmplificationRatio > 1.25 || m.bounds.minimumQuietPrincipalAdmissionRatio > 1
    || m.bounds.maximumActiveCalls >= 8 || m.bounds.maximumSampleGapMs < m.sampleIntervalMs) throw new Error('Invalid v3 measurement bounds');
  const a = m.arrivalModel;
  if (!a || a.kind !== 'seeded-bursty-poisson' || !Number.isSafeInteger(a.seed)
    || ![a.averageRequestsPerSecond, a.spikeMultiplier, a.spikeDurationSeconds, a.smallTokens, a.hugeTokens,
      a.serviceTimeMs?.minimum, a.serviceTimeMs?.maximum, a.retryBackoffMs, a.cancelAfterMs].every(positive)
    || ![a.hugeTokenShare, a.retryableFailureRate, a.cancellationRate].every(v => finite(v) && v <= 1)
    || !Number.isSafeInteger(a.maxRetries) || a.maxRetries < 0 || a.maxRetries > 3
    || a.smallTokens < 2048 || a.hugeTokens > 32768 || a.hugeTokens < a.smallTokens || a.serviceTimeMs.maximum < a.serviceTimeMs.minimum
    || m.sampleIntervalMs > 1000 || m.sampleIntervalMs > m.budget.maxWallClockSeconds * 1000
    || !m.passFail?.allBoundsMustPass || !m.passFail.liveServiceRequired) throw new Error('Invalid v3 arrival model or sampling interval');
}
export function validateDecisionLoadPricing(pricing: DecisionLoadPricing, model: string): void {
  if (!pricing || !['typesafe-docs', 'typesafe-snapshot'].includes(pricing.source ?? '') || pricing.jev_model !== model
    || !pricing.checked_at || !Number.isFinite(Date.parse(pricing.checked_at))
    || !finite(pricing.jev_input_per_mtok) || !finite(pricing.jev_output_per_mtok)) throw new Error('Sourced split Jev cost config for the pinned model is required');
}
const price = (tokens: number, pricing: DecisionLoadPricing): number => tokens * Math.max(pricing.jev_input_per_mtok!, pricing.jev_output_per_mtok!) / 1e6;

/** Run-wide conservative reservations are never refunded on unknown provider outcomes. */
export class DecisionLoadBudgetGuard {
  readonly usage = { calls: 0, tokens: 0, usd: 0 };
  stop: DecisionStagedLoadRecord['stop'] = null;
  private readonly invocations = new Set<string>();
  private readonly open = new Map<string, number>();
  private readonly storm = new Map<string, number>();
  constructor(readonly manifest: DecisionLoadManifestV3, private readonly now: () => number, readonly start: number,
    private readonly stopped: () => void = () => {}) {}
  halt(reason: DecisionLoadStopReason): void {
    if (this.stop) return;
    this.stop = { reason, atMs: this.now() - this.start };
    this.stopped();
  }
  reserve(id: string, tokens: number, usd: number): boolean {
    this.tick();
    if (!Number.isSafeInteger(tokens) || tokens < 1 || !finite(usd)) this.halt('invalid-reservation');
    if (this.stop) return false;
    const b = this.manifest.budget;
    if (this.usage.usd + usd > b.maxUsd * b.stopAtFraction + 1e-12) this.halt('budget-usd-80-percent');
    else if (this.usage.calls + 1 > b.maxCalls) this.halt('max-calls');
    else if (this.usage.tokens + tokens > b.maxTokens) this.halt('max-tokens');
    if (this.stop) return false;
    const invocationCount = this.invocations.size + (this.invocations.has(id) ? 0 : 1);
    if ((this.usage.calls + 1) / invocationCount > this.manifest.stopConditions.maximumRetryAmplificationRatio) {
      this.halt('retry-amplification'); return false;
    }
    this.usage.calls++; this.usage.tokens += tokens; this.usage.usd += usd; this.invocations.add(id);
    return true;
  }
  observe(providerId: string, observation: AdapterObservation, tokens: number, usd: number): void {
    const u = observation.usage;
    if (((u.inputTokens ?? 0) + (u.outputTokens ?? 0) > tokens)
      || (u.costUsd !== null && u.costUsd > usd + 1e-12)) this.halt('usage-exceeds-reservation');
    if (observation.httpStatus === 429) {
      if (!this.storm.has(providerId)) this.storm.set(providerId, this.now());
    } else if (observation.status === 'success') this.storm.delete(providerId);
    if (this.usage.usd >= this.manifest.budget.maxUsd * 0.8) this.halt('budget-usd-80-percent');
    if (this.usage.calls >= this.manifest.budget.maxCalls) this.halt('max-calls');
    if (this.usage.tokens >= this.manifest.budget.maxTokens) this.halt('max-tokens');
    this.tick();
  }
  transition(transition: AdmissionBreakerTransitionRecord): void {
    if (transition.to === 'open') this.open.set(transition.providerId, transition.atEpochMs);
    else this.open.delete(transition.providerId);
    this.tick();
  }
  tick(): void {
    if (this.now() - this.start >= this.manifest.budget.maxWallClockSeconds * 1000) this.halt('max-wall-clock');
    if ([...this.open.values()].some(at => this.now() - at > this.manifest.stopConditions.maximumBreakerOpenMs)) this.halt('breaker-open');
    if ([...this.storm.values()].some(at => this.now() - at > this.manifest.stopConditions.maximum429StormMs)) this.halt('429-storm');
  }
  quotaViolation(): void { this.halt('cross-principal-quota'); }
}

/** Fixed synthetic payload; never accepts user/customer state. D06 estimator checks the reservation before dispatch. */
function syntheticRequest(arrival: DecisionLoadArrival): { definition: DecisionDefinition; input: { message: string } } {
  return {
    definition: { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition', metadata: { id: 'd05-synthetic', version: '1.0.0', description: 'Synthetic D05 staging fixture' },
      spec: { purpose: 'Synthetic staging load; no action.', inputSchema: { type: 'object' }, question: 'Select synthetic.',
        answer: { kind: 'choice', options: [{ id: 'synthetic', description: 'Synthetic fixture.' }, { id: 'other', description: 'Other.' }] }, requiredCapabilities: ['choice'] } },
    input: { message: 'fixture '.repeat(Math.floor((arrival.tokens - 1024) * 3 / 8)) },
  };
}
export const realDecisionLoadClock = (): DecisionLoadClock => ({ now: Date.now, advance: ms => new Promise(resolve => setTimeout(resolve, ms)) });

export async function runDecisionStagedLoad(options: {
  manifestBytes: string; live?: boolean; env?: NodeJS.ProcessEnv; credentialEnv?: string;
  sourceRoot: string; sourceCommit: string; networkPath: string;
  pricing: DecisionLoadPricing; clock?: DecisionLoadClock;
  /** Offline test seam. Live always uses the existing Jev adapter. */
  fakeBackend?: (arrival: DecisionLoadArrival, signal: AbortSignal) => Promise<AdapterObservation>;
  /** Read-only exact-source seam for injected-clock tests. */
  assertSource?: (root: string, commit: string) => Promise<void>;
  sampleResources?: () => { rss: number; heapUsed: number; userCPUTime: number; systemCPUTime: number };
}): Promise<DecisionStagedLoadRecord> {
  const manifest = readDecisionLoadManifest(options.manifestBytes);
  validateDecisionLoadManifestV3(manifest);
  const env = options.env ?? process.env;
  // Validate before constructing an adapter, reading a credential value or starting timers.
  if (options.live && !env[options.credentialEnv ?? 'AIWG_JEV_LOAD_API_KEY']?.trim()) throw new Error('--live requires the caller-supplied environment credential');
  if (options.live && options.fakeBackend) throw new Error('Live load cannot use a fake backend');
  if (options.live && env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== '1') throw new Error('TLS verification must remain enabled');
  validateDecisionLoadPricing(options.pricing, manifest.model);
  if (!exactCommit(options.sourceCommit) || !options.networkPath.trim()) throw new Error('Exact source commit and recorded network path required');
  const assertSource = options.assertSource ?? assertContextLiveSource;
  await assertSource(options.sourceRoot, options.sourceCommit);
  const clock = options.clock ?? realDecisionLoadClock();
  const start = clock.now();
  const abort = new AbortController();
  const guard = new DecisionLoadBudgetGuard(manifest, clock.now, start, () => abort.abort());
  const registry = new DecisionAdmissionRegistry();
  const stages: DecisionStagedLoadStage[] = [];
  const receipts: DecisionLoadAttemptReceipt[] = [];
  const samples: DecisionLoadResourceSample[] = [];
  const transitions: AdmissionBreakerTransitionRecord[] = [];
  registry.onBreakerTransition(t => { transitions.push(t); guard.transition(t); });
  const resource = options.sampleResources ?? (() => ({ ...process.memoryUsage(), ...process.resourceUsage() }));
  let previous = resource(); let previousAt = start;
  const sample = (): void => {
    const now = clock.now(); const current = resource(); const snapshot = registry.controller('load-harness')?.snapshot() ?? { active: 0, queued: 0 };
    samples.push({ atMs: now - start, residentMemoryMiB: current.rss / 1_048_576, heapUsedMiB: current.heapUsed / 1_048_576,
      cpuPercentOneCore: now === previousAt ? 0 : (current.userCPUTime + current.systemCPUTime - previous.userCPUTime - previous.systemCPUTime) / ((now - previousAt) * 10), ...snapshot });
    previous = current; previousAt = now; guard.tick();
  };
  let sampler: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const adapter = options.live ? new JevDecisionAdapter({ now: clock.now }) : null;
  const estimator = new CanonicalJsonByteEstimator();
  const previousManifest = { ...manifest, profileVersion: manifest.rollout.previousProfileVersion,
    workspace: manifest.rollout.workspace, providers: manifest.rollout.providers };
  let phase: DecisionLoadPhase = 'shadow';
  const inFlight = new Map<string, DecisionLoadAttemptReceipt>();
  try {
    for (const principal of manifest.principals) registry.register(decisionLoadPolicy(previousManifest, 'load-harness', principal.id), clock.now);
    sampler = setInterval(() => { try { sample(); } catch { guard.halt('driver-error'); } }, manifest.sampleIntervalMs);
    deadline = setTimeout(() => guard.halt('max-wall-clock'), manifest.budget.maxWallClockSeconds * 1000);
    sample();
    for (phase of ['shadow', 'canary', 'rollback'] as const) {
      const activeManifest = phase === 'rollback' ? previousManifest : manifest;
      const windowSeconds = phase === 'shadow' ? manifest.rollout.shadowSeconds : phase === 'rollback' ? manifest.rollout.rollbackSeconds
        : manifest.duration.loadSeconds + manifest.duration.spikeSeconds + manifest.duration.soakSeconds;
      // Roll back even after a budget or outage stop; no additional provider work follows a stop.
      const scopes: DecisionStagedLoadStage['scopes'] = {};
      const observeScopes = (): { active: number; queued: number } => {
        const controller = registry.controller('load-harness')!;
        const counts = { workspace: controller.snapshot(),
          ...Object.fromEntries(Object.keys(activeManifest.providers).map(id => [`provider.${id}`, controller.snapshot({ providerId: id })])),
          ...Object.fromEntries(activeManifest.principals.map(p => [`principal.${p.id}`, controller.snapshot({ principalId: p.id })])) };
        for (const [id, count] of Object.entries(counts)) scopes[id] = { active: Math.max(scopes[id]?.active ?? 0, count.active), queued: Math.max(scopes[id]?.queued ?? 0, count.queued) };
        return counts.workspace;
      };
      const path = admissionControllerLoadDriver(activeManifest, clock, registry, {
        onStateChange: () => { observeScopes(); },
        onDriverError: () => guard.halt('driver-error'),
        estimateCost: arrival => price(arrival.tokens, options.pricing),
        beforeDispatch: (arrival, attempt) => {
          const request = syntheticRequest(arrival);
          const estimated = estimator.estimate({ state: { untrusted: request.input }, question: compileJevQuestion(request.definition) } as never).tokens + 256;
          if (estimated > arrival.tokens) guard.halt('invalid-reservation');
          return !guard.stop && guard.reserve(`${phase}:${arrival.ordinal}`, arrival.tokens, price(arrival.tokens, options.pricing)) && attempt > 0;
        },
        onAdmission: (arrival, attempt, admission) => {
          const receipt: DecisionLoadAttemptReceipt = { phase, arrivalOrdinal: arrival.ordinal, principalId: arrival.principalId,
            providerId: arrival.providerId, attempt, admittedAtMs: clock.now(), settledAtMs: clock.now(), tokens: arrival.tokens,
            costUsd: price(arrival.tokens, options.pricing), admission: structuredClone(admission), status: 'error', reason: 'executor-unavailable',
            usage: { inputTokens: null, outputTokens: null, costUsd: null } };
          receipts.push(receipt); inFlight.set(`${arrival.ordinal}:${attempt}`, receipt);
          const ownActive = [...inFlight.values()].filter(r => r.principalId === arrival.principalId).length;
          const principal = manifest.principals.find(p => p.id === arrival.principalId)!;
          const provider = activeManifest.providers[arrival.providerId]!;
          const phaseReceipts = receipts.filter(r => r.phase === phase);
          const scoped: Array<[DecisionAdmissionLimits, DecisionLoadAttemptReceipt[], number]> = [
            [principal.limits, phaseReceipts.filter(r => r.principalId === arrival.principalId), ownActive],
            [activeManifest.workspace, phaseReceipts, inFlight.size],
            [provider, phaseReceipts.filter(r => r.providerId === arrival.providerId), [...inFlight.values()].filter(r => r.providerId === arrival.providerId).length],
          ];
          if (scoped.some(([limits, entries, active]) => active > limits.concurrency
            || bucketDebit(entries, limits.requestsPerMinute!, 60000, () => 1) > limits.requestsPerMinute! + 1e-9
            || bucketDebit(entries, limits.tokensPerSecond!, 1000, r => r.tokens) > limits.tokensPerSecond! + 1e-9
            || entries.filter(r => r.arrivalOrdinal === arrival.ordinal).reduce((sum, r) => sum + r.costUsd, 0) > limits.maxCostUsd!
            || (limits.maxPrincipalShare !== undefined && ownActive > Math.max(1, Math.floor(limits.concurrency * limits.maxPrincipalShare))))) guard.quotaViolation();
        },
        backend: async (arrival, signal, context, attempt) => {
          if (signal.aborted) return { status: 'cancelled', reason: 'cancelled', actualModel: null, uncertainty: null, requestId: null,
            usage: { inputTokens: null, outputTokens: null, costUsd: null } };
          if (adapter) {
            const request = syntheticRequest(arrival);
            return adapter.evaluate({ ...request, alias: 'synthetic', invocationId: `d05-${phase}-${arrival.ordinal}`,
              signal, deadlineEpochMs: clock.now() + manifest.requestTimeoutMs,
              target: { adapter: 'jev', adapterVersion: adapter.version, model: manifest.model, credentialRef: 'caller-env', requiredCapabilities: ['choice'],
                acceptance: { mode: 'typed-value' }, timeoutMs: manifest.requestTimeoutMs, retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 } },
              resolveCredential: async () => new TextEncoder().encode(env[options.credentialEnv ?? 'AIWG_JEV_LOAD_API_KEY']!) });
          }
          if (options.fakeBackend) return options.fakeBackend(arrival, signal);
          const status = await context.dispatch(arrival.serviceMs, signal);
          const failed = arrival.failsFirstAttempt && attempt === 1;
          return { status: status === 'aborted' ? 'cancelled' : failed ? 'error' : 'success', reason: status === 'aborted' ? 'cancelled' : failed ? 'service-error' : 'none',
            actualModel: manifest.model, uncertainty: null, requestId: null,
            usage: { inputTokens: arrival.tokens - 256, outputTokens: 1, costUsd: null } };
        },
        onObservation: (arrival, attempt, admission, observation) => {
          const receipt = inFlight.get(`${arrival.ordinal}:${attempt}`)!;
          Object.assign(receipt, { settledAtMs: clock.now(), admission: structuredClone(admission), status: observation.status, reason: observation.reason,
            usage: observation.usage, ...(observation.httpStatus === undefined ? {} : { httpStatus: observation.httpStatus }),
            ...(observation.actualModel ? { servedModel: observation.actualModel } : {}),
            ...(observation.requestId ? { requestId: observation.requestId } : {}) });
          inFlight.delete(`${arrival.ordinal}:${attempt}`);
          guard.observe(arrival.providerId, observation, receipt.tokens, receipt.costUsd);
        },
      });
      if (guard.stop) continue;
      const run = await runDecisionLoadHarness({ manifest: activeManifest, clock, ...path, sample: observeScopes, windowSeconds, signal: abort.signal, fullWindow: true });
      const dispatched = receipts.filter(r => r.phase === phase);
      run.observations.attempts = dispatched.length;
      run.observations.retryAmplificationRatio = run.observations.arrivals ? Number((dispatched.length / run.observations.arrivals).toFixed(6)) : 1;
      stages.push({ phase, profileVersion: activeManifest.profileVersion, windowSeconds, ...run, scopes });
    }
    try { await assertSource(options.sourceRoot, options.sourceCommit); } catch { guard.halt('source-drift'); }
  } catch { guard.halt('driver-error'); }
  finally {
    // Idempotent boundary restoration preserves the registry's rollback audit and all receipts.
    try {
      for (const principal of manifest.principals) registry.register(decisionLoadPolicy(previousManifest, 'load-harness', principal.id), clock.now);
    } catch { guard.halt('driver-error'); }
    clearInterval(sampler); clearTimeout(deadline);
    try { sample(); } catch { guard.halt('driver-error'); }
  }
  return decisionStagedLoadResultRecord({ manifestBytes: options.manifestBytes, mode: 'staged-provider', execution: options.live ? 'live' : 'offline-fake-provider',
    sourceCommit: options.sourceCommit, dirty: false,
    host: { hostname: hostname(), cpuClass: `${cpus().length} cores; ${cpus()[0]?.model ?? 'unknown'}`, memoryGiB: totalmem() / 2 ** 30,
      networkPath: options.networkPath, node: process.version, platform: process.platform, arch: process.arch },
    pricing: options.pricing, stages, receipts, samples, profileHistory: registry.profileHistory('load-harness'), breakerTransitions: transitions,
    reservedUsage: guard.usage, stop: guard.stop, startedAtMs: start, elapsedMs: samples.at(-1)?.atMs ?? clock.now() - start });
}

/** Token-bucket debit (burst plus refill), matching the admission controller's rate semantics. */
function bucketDebit(receipts: DecisionLoadAttemptReceipt[], capacity: number, periodMs: number, amount: (r: DecisionLoadAttemptReceipt) => number): number {
  let debit = 0; let maximum = 0; let at = receipts[0]?.admittedAtMs ?? 0;
  for (const receipt of receipts) {
    debit = Math.max(0, debit - Math.max(0, receipt.admittedAtMs - at) * capacity / periodMs) + amount(receipt);
    maximum = Math.max(maximum, debit); at = receipt.admittedAtMs;
  }
  return maximum;
}
function concurrency(receipts: DecisionLoadAttemptReceipt[]): number {
  let maximum = 0;
  for (const r of receipts) maximum = Math.max(maximum, receipts.filter(other => other.admittedAtMs <= r.admittedAtMs && other.settledAtMs > r.admittedAtMs).length, 1);
  return maximum;
}
const maximum = (values: number[]): number => Math.max(0, ...values);

/** Every measurement/stop/budget bound is recomputed from retained evidence, never the record's passed field. */
export function compareDecisionStagedLoad(record: Pick<DecisionStagedLoadRecord, 'manifest' | 'stages' | 'samples' | 'reservedUsage' | 'elapsedMs' | 'receipts' | 'breakerTransitions' | 'startedAtMs'>): DecisionStagedLoadComparison[] {
  const m = record.manifest; const out: DecisionStagedLoadComparison[] = [];
  const atMost = (bound: string, limit: number, observed: number): void => { out.push({ bound, limit, observed,
    pass: finite(observed) && observed <= limit + 1e-9 }); };
  for (const stage of record.stages) {
    const resources = { ...stage.resources, heapUsedMiB: maximum(record.samples.map(s => s.heapUsedMiB)),
      cpuSource: 'thread' as const, cpuPercentOneCore: maximum(record.samples.map(s => s.cpuPercentOneCore)) };
    out.push(...compareDecisionLoadBounds(m, { ...stage.observations,
      maximumActiveCalls: Math.max(stage.observations.maximumActiveCalls, stage.scopes?.workspace?.active ?? 0, maximum(record.samples.map(s => s.active))),
      maximumQueuedCalls: Math.max(stage.observations.maximumQueuedCalls, stage.scopes?.workspace?.queued ?? 0, maximum(record.samples.map(s => s.queued))),
    }, resources).map(c => ({ ...c, bound: `${stage.phase}.${c.bound}` })));
    atMost(`${stage.phase}.maximumResidentMemoryMiB`, m.bounds.maximumResidentMemoryMiB, maximum(record.samples.map(s => s.residentMemoryMiB)));
    const receipts = record.receipts.filter(r => r.phase === stage.phase).sort((a, b) => a.admittedAtMs - b.admittedAtMs);
    atMost(`${stage.phase}.quietPrincipalLaneWaitMs`, m.bounds.maximumEligibleLaneWaitMs,
      maximum(receipts.filter(r => m.principals.find(p => p.id === r.principalId)?.class === 'quiet').map(r => r.admission.queueDelayMs)));
    const workspace = stage.phase === 'rollback' ? m.rollout.workspace : m.workspace;
    const providers = stage.phase === 'rollback' ? m.rollout.providers : m.providers;
    const scopes: Array<[string, DecisionAdmissionLimits, DecisionLoadAttemptReceipt[]]> = [
      ['workspace', workspace, receipts],
      ...Object.entries(providers).map(([id, limits]) => [`provider.${id}`, limits, receipts.filter(r => r.providerId === id)] as [string, DecisionAdmissionLimits, DecisionLoadAttemptReceipt[]]),
      ...m.principals.map(p => [`principal.${p.id}`, p.limits, receipts.filter(r => r.principalId === p.id)] as [string, DecisionAdmissionLimits, DecisionLoadAttemptReceipt[]]),
    ];
    for (const [scope, limits, entries] of scopes) {
      const prefix = `${stage.phase}.${scope}`;
      atMost(`${prefix}.concurrency`, limits.concurrency, Math.max(concurrency(entries), stage.scopes[scope]?.active ?? 0));
      atMost(`${prefix}.maxQueueLength`, limits.maxQueueLength!, stage.scopes[scope]?.queued ?? Number.POSITIVE_INFINITY);
      atMost(`${prefix}.requestsPerMinute`, limits.requestsPerMinute!, bucketDebit(entries, limits.requestsPerMinute!, 60000, () => 1));
      atMost(`${prefix}.tokensPerSecond`, limits.tokensPerSecond!, bucketDebit(entries, limits.tokensPerSecond!, 1000, r => r.tokens));
      // Admission cost/retained-work limits are invocation-scoped, as in DecisionAdmissionController.
      const invocations = new Map<number, number>();
      for (const r of entries) invocations.set(r.arrivalOrdinal, (invocations.get(r.arrivalOrdinal) ?? 0) + r.costUsd);
      atMost(`${prefix}.maxCostUsd`, limits.maxCostUsd!, maximum([...invocations.values()]));
      atMost(`${prefix}.maxRetainedWork`, limits.maxRetainedWork!, entries.length ? 1 : 0);
      atMost(`${prefix}.maxQueueWaitMs`, limits.maxQueueWaitMs!, maximum(entries.map(r => r.admission.queueDelayMs)));
      if (limits.maxPrincipalShare !== undefined) for (const principal of m.principals) {
        atMost(`${prefix}.${principal.id}.shareConcurrency`, Math.max(1, Math.floor(limits.concurrency * limits.maxPrincipalShare)),
          concurrency(entries.filter(r => r.principalId === principal.id)));
      }
    }
  }
  atMost('budget.maxUsd.stopAtFraction', m.budget.maxUsd * m.budget.stopAtFraction, record.reservedUsage.usd);
  atMost('budget.maxCalls', m.budget.maxCalls, record.reservedUsage.calls);
  atMost('budget.maxTokens', m.budget.maxTokens, record.reservedUsage.tokens);
  atMost('budget.maxWallClockSeconds', m.budget.maxWallClockSeconds, record.elapsedMs / 1000);
  atMost('maximumSampleGapMs', m.bounds.maximumSampleGapMs, maximum(record.samples.slice(1).map((s, i) => s.atMs - record.samples[i]!.atMs)));
  const endingAt = record.startedAtMs + record.elapsedMs;
  const open = new Map<string, number>(); let openMs = 0;
  for (const t of record.breakerTransitions) {
    const prior = open.get(t.providerId);
    if (prior !== undefined) openMs = Math.max(openMs, t.atEpochMs - prior);
    if (t.to === 'open') open.set(t.providerId, t.atEpochMs); else open.delete(t.providerId);
  }
  for (const at of open.values()) openMs = Math.max(openMs, endingAt - at);
  let stormMs = 0; const storms = new Map<string, number>();
  for (const receipt of [...record.receipts].sort((a, b) => a.settledAtMs - b.settledAtMs)) {
    if (receipt.httpStatus === 429 && !storms.has(receipt.providerId)) storms.set(receipt.providerId, receipt.settledAtMs);
    const prior = storms.get(receipt.providerId);
    if (prior !== undefined) stormMs = Math.max(stormMs, receipt.settledAtMs - prior);
    if (receipt.status === 'success') storms.delete(receipt.providerId);
  }
  for (const at of storms.values()) stormMs = Math.max(stormMs, endingAt - at);
  atMost('stop.maximumBreakerOpenMs', m.stopConditions.maximumBreakerOpenMs, openMs);
  atMost('stop.maximum429StormMs', m.stopConditions.maximum429StormMs, stormMs);
  const ids = new Set(record.receipts.map(r => `${r.phase}:${r.arrivalOrdinal}`));
  atMost('stop.maximumRetryAmplificationRatio', m.stopConditions.maximumRetryAmplificationRatio, ids.size ? record.receipts.length / ids.size : 0);
  const violations = out.filter(c => /principal\..*\.concurrency|shareConcurrency/.test(c.bound) && !c.pass).length;
  atMost('stop.maximumCrossPrincipalQuotaViolations', 0, violations);
  return out;
}

function reportedUsage(receipts: DecisionLoadAttemptReceipt[], pricing: DecisionLoadPricing): DecisionLoadReportedUsage {
  const sum = (values: Array<number | null>): number | null => values.reduce<number | null>((total, value) =>
    total === null || value === null ? null : total + value, 0);
  const inputs = receipts.map(r => r.usage.inputTokens);
  const outputs = receipts.map(r => r.usage.outputTokens);
  const totals = receipts.map(r => r.usage.inputTokens === null || r.usage.outputTokens === null ? null : r.usage.inputTokens + r.usage.outputTokens);
  const inputTokens = sum(inputs);
  const outputTokens = sum(outputs);
  // The request is pinned to the priced model; an explicitly different served model has no applicable rate.
  const costs = receipts.map(r => r.usage.inputTokens === null || r.usage.outputTokens === null
    || (r.servedModel !== undefined && r.servedModel !== pricing.jev_model) ? null
    : tokenCost(r.usage, { inputPerMillionUsd: pricing.jev_input_per_mtok!, outputPerMillionUsd: pricing.jev_output_per_mtok! }));
  const knownSum = (values: Array<number | null>): number | null => values.length > 0 && values.every(v => v === null)
    ? null : sum(values.filter(v => v !== null));
  return { calls: receipts.length, inputTokens, outputTokens, tokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    usd: sum(costs), incompleteCalls: costs.filter(cost => cost === null).length,
    knownSubtotal: { inputTokens: knownSum(inputs), outputTokens: knownSum(outputs), tokens: knownSum(totals), usd: knownSum(costs) } };
}

export function decisionStagedLoadResultRecord(input: Omit<DecisionStagedLoadRecord,
  'schemaVersion' | 'kind' | 'manifestDigest' | 'manifest' | 'digest' | 'comparisons' | 'passed' | 'queueWaitDistribution' | 'retries' | 'reportedUsage'> & { manifestBytes: string }): DecisionStagedLoadRecord {
  const manifest = readDecisionLoadManifest(input.manifestBytes);
  validateDecisionLoadManifestV3(manifest);
  validateDecisionLoadPricing(input.pricing, manifest.model);
  const payload = { ...input, schemaVersion: 'decision-load-result/v2' as const, kind: 'load-manifest-qualified' as const,
    reportedUsage: reportedUsage(input.receipts, input.pricing),
    manifest, manifestDigest: decisionLoadManifestDigest(input.manifestBytes) };
  for (const key of ['digest', 'comparisons', 'passed', 'queueWaitDistribution', 'retries']) delete (payload as unknown as Record<string, unknown>)[key];
  const comparisons = compareDecisionStagedLoad(payload);
  const complete = ['shadow', 'canary', 'rollback'].every(phase => input.stages.some(s => s.phase === phase))
    && input.stages.every(s => s.observations.virtualDurationMs >= s.windowSeconds * 1000 && s.observations.arrivals > 0)
    && input.samples.length > 1 && input.profileHistory.some(h => h.kind === 'rollback');
  const waits = input.receipts.map(r => r.admission.queueDelayMs).sort((a, b) => a - b);
  const percentile = (fraction: number): number => waits[Math.max(0, Math.ceil(waits.length * fraction) - 1)] ?? 0;
  const body = { ...payload, comparisons, retries: input.receipts.filter(receipt => receipt.attempt > 1).length, queueWaitDistribution: { count: waits.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), maximum: maximum(waits) },
    passed: !input.stop && complete && comparisons.length > 0 && comparisons.every(c => c.pass) };
  return { ...body, digest: decisionLoadManifestDigest(canonicalJson(body)) };
}

/** Self digest + exact manifest bytes + recomputed measurements + complete rollout + clean exact commit. */
export function verifyDecisionStagedLoadRecord(value: unknown, sourceCommit?: string): boolean {
  try {
    const r = value as DecisionStagedLoadRecord | DecisionStagedLoadRecordV1;
    if (!r || !(DECISION_STAGED_LOAD_RESULT_VERSIONS as readonly string[]).includes(r.schemaVersion) || r.kind !== 'load-manifest-qualified' || r.mode !== 'staged-provider'
      || r.execution !== 'live' || r.dirty !== false || !exactCommit(r.sourceCommit) || (sourceCommit !== undefined && sourceCommit !== r.sourceCommit)
      || r.stop !== null || !r.passed || !finite(r.startedAtMs) || !r.host.networkPath || !r.host.cpuClass || !positive(r.host.memoryGiB)) return false;
    const manifest = readDecisionLoadManifest(r.manifestBytes);
    validateDecisionLoadManifestV3(manifest);
    validateDecisionLoadPricing(r.pricing, manifest.model);
    if (canonicalJson(manifest) !== canonicalJson(r.manifest) || r.manifestDigest !== decisionLoadManifestDigest(r.manifestBytes)
      || manifest.duration.soakSeconds !== 900 || r.stages.length !== 3 || !r.receipts.length || r.samples.length < 2) return false;
    const { digest, ...body } = r;
    if (digest !== decisionLoadManifestDigest(canonicalJson(body))) return false;
    const expectedPhases = ['shadow', 'canary', 'rollback'];
    for (const [index, stage] of r.stages.entries()) {
      const window = index === 0 ? manifest.rollout.shadowSeconds : index === 2 ? manifest.rollout.rollbackSeconds
        : manifest.duration.loadSeconds + manifest.duration.spikeSeconds + manifest.duration.soakSeconds;
      if (stage.phase !== expectedPhases[index] || stage.windowSeconds !== window
        || stage.profileVersion !== (index === 2 ? manifest.rollout.previousProfileVersion : manifest.profileVersion)
        || stage.observations.virtualDurationMs < window * 1000 || stage.observations.arrivals <= 0) return false;
      const receipts = r.receipts.filter(receipt => receipt.phase === stage.phase);
      const expectedArrivals = decisionLoadArrivals(manifest, window);
      const obs = stage.observations;
      if (obs.arrivals !== expectedArrivals.length || obs.attempts !== receipts.length
        || obs.completed + obs.failed + obs.shed + obs.cancelled !== obs.arrivals
        || obs.maximumEligibleLaneWaitMs !== maximum(receipts.map(receipt => receipt.admission.queueDelayMs))) return false;
      for (const cls of ['quiet', 'noisy'] as const) {
        const expected = expectedArrivals.filter(arrival => arrival.principalClass === cls).length;
        const admitted = new Set(receipts.filter(receipt => manifest.principals.find(p => p.id === receipt.principalId)?.class === cls).map(receipt => receipt.arrivalOrdinal)).size;
        const ratio = expected ? Number((admitted / expected).toFixed(6)) : 1;
        if (obs[cls === 'quiet' ? 'quietPrincipalAdmissionRatio' : 'noisyPrincipalAdmissionRatio'] !== ratio) return false;
      }
      if (receipts.some(receipt => {
        const expected = expectedArrivals[receipt.arrivalOrdinal];
        return !expected || expected.principalId !== receipt.principalId || expected.providerId !== receipt.providerId || expected.tokens !== receipt.tokens;
      })) return false;
      const scopedKeys = ['workspace', ...Object.keys(manifest.providers).map(id => `provider.${id}`), ...manifest.principals.map(p => `principal.${p.id}`)];
      if (!stage.scopes || !scopedKeys.every(key => stage.scopes[key] && finite(stage.scopes[key]!.active) && finite(stage.scopes[key]!.queued))) return false;
      if (!receipts.some(receipt => manifest.principals.find(p => p.id === receipt.principalId)?.class === 'quiet')
        || !receipts.some(receipt => manifest.principals.find(p => p.id === receipt.principalId)?.class === 'noisy')) return false;
    }
    if (r.receipts.some(receipt => !manifest.principals.some(p => p.id === receipt.principalId) || !(receipt.providerId in manifest.providers)
      || !positive(receipt.tokens) || !finite(receipt.costUsd) || !finite(receipt.admittedAtMs) || receipt.settledAtMs < receipt.admittedAtMs
      || receipt.admission.decision !== 'admit' || receipt.costUsd !== price(receipt.tokens, r.pricing))) return false;
    const reservedUsage = r.schemaVersion === 'decision-load-result/v1' ? r.usage : r.reservedUsage;
    if (!reservedUsage || ![reservedUsage.calls, reservedUsage.tokens, reservedUsage.usd].every(finite)
      || reservedUsage.calls !== r.receipts.length || reservedUsage.tokens !== r.receipts.reduce((sum, receipt) => sum + receipt.tokens, 0)
      || Math.abs(reservedUsage.usd - r.receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0)) > 1e-9) return false;
    if (r.schemaVersion === 'decision-load-result/v2' && r.receipts.some(receipt => !receipt.usage
      || ![receipt.usage.inputTokens, receipt.usage.outputTokens].every(v => v === null || (Number.isSafeInteger(v) && v >= 0))
      || (receipt.usage.inputTokens ?? 0) + (receipt.usage.outputTokens ?? 0) > receipt.tokens
      || (receipt.usage.costUsd !== null && (!finite(receipt.usage.costUsd) || receipt.usage.costUsd > receipt.costUsd + 1e-12))
      || (receipt.servedModel !== undefined && (typeof receipt.servedModel !== 'string' || !receipt.servedModel))
      || (receipt.requestId !== undefined && (typeof receipt.requestId !== 'string' || !receipt.requestId)))) return false;
    if (!r.samples.every((sample, index) => finite(sample.atMs) && finite(sample.residentMemoryMiB) && finite(sample.heapUsedMiB)
      && finite(sample.cpuPercentOneCore) && finite(sample.active) && finite(sample.queued) && (index === 0 ? sample.atMs === 0 : sample.atMs >= r.samples[index - 1]!.atMs
        && sample.atMs - r.samples[index - 1]!.atMs <= manifest.bounds.maximumSampleGapMs))) return false;
    if (r.samples.at(-1)!.atMs !== r.elapsedMs
      || r.elapsedMs < r.stages.reduce((sum, stage) => sum + stage.windowSeconds * 1000, 0)) return false;
    const [initial, change, rollback] = r.profileHistory;
    const profileDigest = (workspace: DecisionAdmissionLimits, providers: Record<string, DecisionAdmissionLimits>): string =>
      decisionLoadManifestDigest(canonicalJson({ workspace, providers }));
    if (r.profileHistory.length !== 3 || initial?.kind !== 'initial' || initial.profileVersion !== manifest.rollout.previousProfileVersion
      || initial.digest !== profileDigest(manifest.rollout.workspace, manifest.rollout.providers)
      || change?.kind !== 'change' || change.profileVersion !== manifest.profileVersion || change.digest !== profileDigest(manifest.workspace, manifest.providers)
      || rollback?.kind !== 'rollback' || rollback.profileVersion !== initial.profileVersion || rollback.digest !== initial.digest) return false;
    const rebuilt = decisionStagedLoadResultRecord({ ...r, reservedUsage });
    if (r.schemaVersion === 'decision-load-result/v1') {
      const { reservedUsage: _, reportedUsage: __, digest: ___, ...legacy } = rebuilt;
      const legacyBody = { ...legacy, schemaVersion: r.schemaVersion };
      return rebuilt.passed && canonicalJson({ ...legacyBody, digest: decisionLoadManifestDigest(canonicalJson(legacyBody)) }) === canonicalJson(r);
    }
    return rebuilt.passed && canonicalJson(rebuilt) === canonicalJson(r);
  } catch { return false; }
}
