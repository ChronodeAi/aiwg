import { createHash } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import { AdmissionError, DecisionAdmissionRegistry } from '../admission.js';
import type { AdapterObservation, DecisionAdmissionEvidence, DecisionAdmissionLimits, DecisionSchedulerPolicy } from '../types.js';

import { verifyDecisionStagedLoadRecord, type DecisionLoadManifestV3, type DecisionStagedLoadRecord, type DecisionStagedLoadRecordV1 } from './load-staged.js';
export * from './load-staged.js';

export type DecisionLoadManifest = DecisionLoadManifestV2 | DecisionLoadManifestV3;

/** Preregistered D05 load manifest. Bounds are inputs; a changed bound needs a new version. */
export interface DecisionLoadManifestV2 {
  schema: 'decision-load-manifest/v2';
  version: string;
  mode: 'offline-fake-provider' | 'staged-provider';
  profileVersion: string;
  workspace: DecisionAdmissionLimits;
  providers: Record<string, DecisionAdmissionLimits>;
  principals: Array<{ id: string; class: 'noisy' | 'quiet'; weight: number; limits: DecisionAdmissionLimits }>;
  arrivalModel: {
    kind: 'seeded-bursty-poisson';
    seed: number;
    averageRequestsPerSecond: number;
    spikeMultiplier: number;
    spikeDurationSeconds: number;
    smallTokens: number;
    hugeTokens: number;
    hugeTokenShare: number;
    serviceTimeMs: { minimum: number; maximum: number };
    retryableFailureRate: number;
    maxRetries: number;
    retryBackoffMs: number;
    cancellationRate: number;
    cancelAfterMs: number;
  };
  duration: { loadSeconds: number; spikeSeconds: number; soakSeconds: number; evaluatorSampleSeconds: number };
  bounds: {
    maximumActiveCalls: number;
    maximumQueuedCalls: number;
    /** Peak V8 heap of the harness isolate. Process RSS is recorded but shared with the test runner. */
    maximumHeapUsedMiB: number;
    maximumCpuPercentOneCore: number;
    maximumEligibleLaneWaitMs: number;
    maximumRetryAmplificationRatio: number;
    maximumCancellationLatencyMs: number;
    minimumQuietPrincipalAdmissionRatio: number;
  };
  passFail: { allBoundsMustPass: true; liveServiceRequired: boolean };
}

export interface DecisionLoadArrival {
  ordinal: number;
  atMs: number;
  principalId: string;
  principalClass: 'noisy' | 'quiet';
  providerId: string;
  tokens: number;
  serviceMs: number;
  failsFirstAttempt: boolean;
  cancelAtMs: number | null;
}

export interface DecisionLoadClock {
  now(): number;
  /** Advance virtual time and run every timer that falls due. */
  advance(ms: number): Promise<void>;
}

export interface DecisionLoadOutcome {
  attempts: number;
  outcome: 'completed' | 'failed' | 'shed' | 'cancelled';
  admissionReason?: DecisionAdmissionEvidence['reason'];
  queueDelaysMs: number[];
  settledAtMs: number;
}

export interface DecisionLoadDriverContext {
  clock: DecisionLoadClock;
  manifest: DecisionLoadManifest;
  /** Simulated provider call. Counts active calls and ends early when the signal aborts. */
  dispatch(serviceMs: number, signal: AbortSignal): Promise<'completed' | 'aborted'>;
}

export type DecisionLoadDriver = (arrival: DecisionLoadArrival, signal: AbortSignal, context: DecisionLoadDriverContext) => Promise<DecisionLoadOutcome>;

/** Deterministic observations: identical for a manifest and seed under fake time on any host. */
export interface DecisionLoadObservations {
  arrivals: number;
  attempts: number;
  completed: number;
  failed: number;
  shed: number;
  cancelled: number;
  shedReasons: Record<string, number>;
  maximumActiveCalls: number;
  maximumQueuedCalls: number;
  maximumEligibleLaneWaitMs: number;
  retryAmplificationRatio: number;
  maximumCancellationLatencyMs: number;
  quietPrincipalAdmissionRatio: number;
  noisyPrincipalAdmissionRatio: number;
  virtualDurationMs: number;
}

/** Host-dependent measurements, recorded next to the deterministic observations. */
export interface DecisionLoadResourceObservations {
  heapUsedMiB: number;
  /** Informational: process-wide, so it includes the test runner and any sibling workers. */
  residentMemoryMiB: number;
  /** Harness CPU time divided by the manifest's virtual timeline: one-core utilization at the declared arrival rate. */
  cpuPercentOneCore: number;
  /** `thread` CPU time when the runtime exposes it; otherwise harness wall-clock time, an upper bound. */
  cpuSource: 'thread' | 'wall-clock-upper-bound';
}

export interface DecisionLoadComparison { bound: keyof DecisionLoadManifestV2['bounds']; limit: number; observed: number; pass: boolean }

export interface DecisionLoadResultRecord {
  schema: 'decision-load-result/v1';
  manifest: { schema: DecisionLoadManifest['schema']; version: string; digest: string };
  mode: DecisionLoadManifest['mode'];
  target: 'admission-controller' | 'evaluator';
  window: { seconds: number };
  environment: { node: string; platform: string; arch: string };
  observations: DecisionLoadObservations;
  resources: DecisionLoadResourceObservations;
  comparisons: DecisionLoadComparison[];
  passed: boolean;
  /** sha256 over the canonical record without this field. */
  digest: string;
}

export function decisionLoadManifestDigest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** mulberry32: small, seedable, and stable across Node versions. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Seeded bursty Poisson arrivals for the manifest's load, spike, and soak phases. */
export function decisionLoadArrivals(manifest: DecisionLoadManifest, windowSeconds?: number): DecisionLoadArrival[] {
  const model = manifest.arrivalModel;
  const random = seeded(model.seed);
  const total = manifest.duration.loadSeconds + manifest.duration.spikeSeconds + manifest.duration.soakSeconds;
  const endMs = Math.min(total, windowSeconds ?? total) * 1000;
  const spikeStart = manifest.duration.loadSeconds * 1000;
  const spikeEnd = spikeStart + model.spikeDurationSeconds * 1000;
  const weights = manifest.principals.reduce((sum, principal) => sum + principal.weight, 0);
  const providers = Object.keys(manifest.providers).sort();
  const arrivals: DecisionLoadArrival[] = [];
  let at = 0;
  for (;;) {
    const rate = (at >= spikeStart && at < spikeEnd ? model.spikeMultiplier : 1) * model.averageRequestsPerSecond / 1000;
    at += -Math.log(1 - random()) / rate;
    if (at >= endMs) break;
    let pick = random() * weights;
    const principal = manifest.principals.find(candidate => (pick -= candidate.weight) < 0) ?? manifest.principals.at(-1)!;
    const provider = providers[Math.floor(random() * providers.length)]!;
    const huge = random() < model.hugeTokenShare;
    const service = model.serviceTimeMs.minimum + Math.floor(random() * (model.serviceTimeMs.maximum - model.serviceTimeMs.minimum + 1));
    const fails = random() < model.retryableFailureRate;
    const cancels = random() < model.cancellationRate;
    const atMs = Math.round(at);
    arrivals.push({ ordinal: arrivals.length, atMs, principalId: principal.id, principalClass: principal.class,
      providerId: provider, tokens: huge ? model.hugeTokens : model.smallTokens, serviceMs: service,
      failsFirstAttempt: fails, cancelAtMs: cancels ? atMs + model.cancelAfterMs : null });
  }
  return arrivals;
}

/** Scheduler policy the manifest declares for one principal. */
export function decisionLoadPolicy(manifest: DecisionLoadManifest, workspaceId: string, principalId: string): DecisionSchedulerPolicy {
  const principal = manifest.principals.find(candidate => candidate.id === principalId)!;
  return {
    enabled: true, profileVersion: manifest.profileVersion,
    workspace: { id: workspaceId, limits: structuredClone(manifest.workspace) },
    principal: { id: principal.id, limits: structuredClone(principal.limits) },
    providers: structuredClone(manifest.providers),
  };
}

/** Drives each arrival straight through a registry-owned `DecisionAdmissionController`. */
export function admissionControllerLoadDriver(manifest: DecisionLoadManifest, clock: DecisionLoadClock,
  registry = new DecisionAdmissionRegistry(), hooks: {
    onStateChange?: () => void;
    onDriverError?: () => void;
    estimateCost?: (arrival: DecisionLoadArrival) => number;
    backend?: (arrival: DecisionLoadArrival, signal: AbortSignal, context: DecisionLoadDriverContext, attempt: number) => Promise<AdapterObservation>;
    beforeDispatch?: (arrival: DecisionLoadArrival, attempt: number) => boolean;
    onAdmission?: (arrival: DecisionLoadArrival, attempt: number, evidence: DecisionAdmissionEvidence) => void;
    onObservation?: (arrival: DecisionLoadArrival, attempt: number, evidence: DecisionAdmissionEvidence, observation: AdapterObservation) => void;
  } = {}): { driver: DecisionLoadDriver; sample: () => { active: number; queued: number } } {
  const workspaceId = 'load-harness';
  for (const principal of manifest.principals) registry.register(decisionLoadPolicy(manifest, workspaceId, principal.id), clock.now);
  const controller = registry.controller(workspaceId)!;
  const driver: DecisionLoadDriver = async (arrival, signal, context) => {
    const queueDelaysMs: number[] = [];
    let attempts = 0;
    for (let retry = 0; retry <= manifest.arrivalModel.maxRetries; retry += 1) {
      attempts += 1;
      let lease;
      try {
        const pendingLease = controller.acquire({ budgetId: `load-${arrival.ordinal}`, principalId: arrival.principalId,
          workspaceId, providerId: arrival.providerId, signal,
          estimate: { tokens: arrival.tokens, attempts: 1, batchSize: 1, items: 1, costUsd: hooks.estimateCost?.(arrival) ?? 0, retainedWork: 1 },
          deadlineEpochMs: clock.now() + manifest.workspace.maxQueueWaitMs! + arrival.serviceMs });
        hooks.onStateChange?.();
        lease = await pendingLease;
      } catch (error) {
        if (!(error instanceof AdmissionError)) { hooks.onDriverError?.(); controller.releaseBudget(`load-${arrival.ordinal}`); throw error; }
        controller.releaseBudget(`load-${arrival.ordinal}`);
        return { attempts, outcome: error.evidence.reason === 'cancelled' ? 'cancelled' : 'shed',
          admissionReason: error.evidence.reason, queueDelaysMs, settledAtMs: clock.now() };
      }
      try {
        queueDelaysMs.push(lease.evidence.queueDelayMs);
        if (signal.aborted || hooks.beforeDispatch?.(arrival, retry + 1) === false) {
          lease.release();
          controller.releaseBudget(`load-${arrival.ordinal}`);
          return { attempts: retry, outcome: 'cancelled', queueDelaysMs, settledAtMs: clock.now() };
        }
        hooks.onAdmission?.(arrival, retry + 1, lease.evidence);
        let observation: AdapterObservation | undefined;
        let dispatched: 'completed' | 'aborted';
        try {
          if (hooks.backend) {
            observation = await hooks.backend(arrival, signal, context, retry + 1);
            dispatched = signal.aborted ? 'aborted' : 'completed';
          } else dispatched = await context.dispatch(arrival.serviceMs, signal);
        } catch {
          observation = { status: 'error', reason: 'executor-unavailable', actualModel: null, uncertainty: null,
            requestId: null, usage: { inputTokens: null, outputTokens: null, costUsd: null } };
          dispatched = signal.aborted ? 'aborted' : 'completed';
        }
        const failed = observation ? observation.status !== 'success' : arrival.failsFirstAttempt && retry === 0;
        lease.release({ success: dispatched === 'completed' && !failed, ...(observation?.retryAfterMs === undefined ? {} : { retryAfterMs: observation.retryAfterMs }) });
        if (observation) hooks.onObservation?.(arrival, retry + 1, lease.evidence, observation);
        if (dispatched === 'aborted') {
          controller.releaseBudget(`load-${arrival.ordinal}`);
          return { attempts, outcome: 'cancelled', queueDelaysMs, settledAtMs: clock.now() };
        }
        if (!failed) {
          controller.releaseBudget(`load-${arrival.ordinal}`);
          return { attempts, outcome: 'completed', queueDelaysMs, settledAtMs: clock.now() };
        }
        if (observation && !['service-error', 'rate-limited', 'network-transient', 'timeout'].includes(observation.reason)) break;
        if (signal.aborted) break;
        if (retry < manifest.arrivalModel.maxRetries) {
          await new Promise<void>(done => {
            const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
            const timer = setTimeout(finish, manifest.arrivalModel.retryBackoffMs);
            if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
          });
        }
      } catch (error) { hooks.onDriverError?.(); controller.releaseBudget(`load-${arrival.ordinal}`); throw error; }
      finally { lease.release(); hooks.onStateChange?.(); }
    }
    controller.releaseBudget(`load-${arrival.ordinal}`);
    return { attempts, outcome: 'failed', queueDelaysMs, settledAtMs: clock.now() };
  };
  return { driver, sample: () => controller.snapshot() };
}

/**
 * Offline load harness. Arrivals are released on a virtual timeline supplied by
 * the caller's fake clock. Deterministic observations are separated from
 * host-dependent memory and CPU measurements.
 */
export async function runDecisionLoadHarness(options: {
  manifest: DecisionLoadManifest;
  clock: DecisionLoadClock;
  driver: DecisionLoadDriver;
  sample: () => { active: number; queued: number };
  windowSeconds?: number;
  signal?: AbortSignal;
  /** Preserve the entire declared window, even after the last arrival settles. */
  fullWindow?: boolean;
}): Promise<{ observations: DecisionLoadObservations; resources: DecisionLoadResourceObservations }> {
  const { manifest, clock, driver, sample } = options;
  const arrivals = decisionLoadArrivals(manifest, options.windowSeconds);
  const start = clock.now();
  const cpuStart = process.threadCpuUsage();
  let rss = process.memoryUsage().rss;
  let heap = process.memoryUsage().heapUsed;
  const sampleMemory = (): void => {
    const usage = process.memoryUsage();
    rss = Math.max(rss, usage.rss);
    heap = Math.max(heap, usage.heapUsed);
  };
  let active = 0;
  let maximumActive = 0;
  let maximumQueued = 0;
  const observe = (): void => {
    const snapshot = sample();
    maximumQueued = Math.max(maximumQueued, snapshot.queued);
    maximumActive = Math.max(maximumActive, snapshot.active, active);
  };
  const context: DecisionLoadDriverContext = {
    clock, manifest,
    dispatch: (serviceMs, signal) => new Promise(resolve => {
      active += 1;
      observe();
      const finish = (result: 'completed' | 'aborted'): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        active -= 1;
        resolve(result);
      };
      const aborted = (): void => finish('aborted');
      const timer = setTimeout(() => finish('completed'), serviceMs);
      if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
    }),
  };
  const advance = async (ms: number): Promise<void> => {
    if (!options.signal) { await clock.advance(ms); return; }
    const end = clock.now() + ms;
    while (clock.now() < end && !options.signal.aborted) await clock.advance(Math.min(1000, end - clock.now()));
  };
  const outcomes: Array<Promise<{ arrival: DecisionLoadArrival; result: DecisionLoadOutcome; abortedAtMs: number | null }>> = [];
  for (const arrival of arrivals) {
    if (options.signal?.aborted) break;
    const due = start + arrival.atMs - clock.now();
    if (due > 0) await advance(due);
    if (options.signal?.aborted) break;
    const controller = new AbortController();
    const cancellation = { abortedAtMs: null as number | null };
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    if (arrival.cancelAtMs !== null) {
      cancellationTimer = setTimeout(() => { cancellation.abortedAtMs = clock.now(); controller.abort(); }, arrival.cancelAtMs - arrival.atMs);
    }
    const combined = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const pending = driver(arrival, combined, context)
      .then(result => ({ arrival, result, abortedAtMs: cancellation.abortedAtMs }))
      .finally(() => clearTimeout(cancellationTimer));
    // Observe rejection immediately; allSettled below retains it for the caller.
    void pending.catch(() => {});
    outcomes.push(pending);
    observe();
    if (arrival.ordinal % 500 === 0) sampleMemory();
  }
  let settled = false;
  const all = Promise.allSettled(outcomes).then(values => { settled = true; return values; });
  const drainStep = manifest.arrivalModel.serviceTimeMs.maximum + manifest.arrivalModel.retryBackoffMs;
  while (!settled) await clock.advance(drainStep);
  const settledResults = await all;
  const failure = settledResults.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const results = settledResults.map(result => (result as PromiseFulfilledResult<{ arrival: DecisionLoadArrival; result: DecisionLoadOutcome; abortedAtMs: number | null }>).value);
  if (options.fullWindow && !options.signal?.aborted) {
    const windowMs = (options.windowSeconds ?? manifest.duration.loadSeconds + manifest.duration.spikeSeconds + manifest.duration.soakSeconds) * 1000;
    if (start + windowMs > clock.now()) await advance(start + windowMs - clock.now());
  }
  sampleMemory();
  const threadUsage = process.threadCpuUsage(cpuStart);
  const cpuMicros = threadUsage.user + threadUsage.system;
  const virtualDurationMs = Math.max(1, clock.now() - start);

  const shedReasons: Record<string, number> = {};
  let attempts = 0; let completed = 0; let failed = 0; let shed = 0; let cancelled = 0;
  let laneWait = 0; let cancellationLatency = 0;
  const admitted = { quiet: 0, noisy: 0 };
  const submitted = { quiet: 0, noisy: 0 };
  for (const { arrival, result, abortedAtMs } of results) {
    attempts += result.attempts;
    submitted[arrival.principalClass] += 1;
    if (result.queueDelaysMs.length) admitted[arrival.principalClass] += 1;
    for (const delay of result.queueDelaysMs) laneWait = Math.max(laneWait, delay);
    if (result.outcome === 'completed') completed += 1;
    else if (result.outcome === 'failed') failed += 1;
    else if (result.outcome === 'cancelled') cancelled += 1;
    else { shed += 1; shedReasons[result.admissionReason ?? 'unknown'] = (shedReasons[result.admissionReason ?? 'unknown'] ?? 0) + 1; }
    if (result.outcome === 'cancelled' && abortedAtMs !== null) {
      cancellationLatency = Math.max(cancellationLatency, result.settledAtMs - abortedAtMs);
    }
  }
  const ratio = (value: number, total: number): number => total ? Number((value / total).toFixed(6)) : 1;
  return {
    observations: {
      arrivals: results.length, attempts, completed, failed, shed, cancelled,
      shedReasons: Object.fromEntries(Object.entries(shedReasons).sort(([left], [right]) => left.localeCompare(right))),
      maximumActiveCalls: maximumActive, maximumQueuedCalls: maximumQueued, maximumEligibleLaneWaitMs: laneWait,
      retryAmplificationRatio: ratio(attempts, results.length), maximumCancellationLatencyMs: cancellationLatency,
      quietPrincipalAdmissionRatio: ratio(admitted.quiet, submitted.quiet),
      noisyPrincipalAdmissionRatio: ratio(admitted.noisy, submitted.noisy),
      virtualDurationMs,
    },
    resources: {
      heapUsedMiB: Number((heap / 1_048_576).toFixed(1)),
      residentMemoryMiB: Number((rss / 1_048_576).toFixed(1)),
      cpuPercentOneCore: Number(((cpuMicros / 1000) / virtualDurationMs * 100).toFixed(3)),
      cpuSource: 'thread',
    },
  };
}

export function compareDecisionLoadBounds(manifest: DecisionLoadManifest, observations: DecisionLoadObservations,
  resources: DecisionLoadResourceObservations): DecisionLoadComparison[] {
  const bounds = manifest.bounds;
  const atMost = (bound: keyof typeof bounds, observed: number): DecisionLoadComparison =>
    ({ bound, limit: bounds[bound], observed, pass: observed <= bounds[bound] });
  // The wall-clock fallback is process-wide (runner plus sibling workers), so it
  // cannot bound harness CPU: it fails conforming code on shared runners. The
  // manifest CPU bound only gates isolated thread-CPU measurement. The observed
  // value stays in resources for informational use.
  const cpu = resources.cpuSource === 'thread'
    ? [atMost('maximumCpuPercentOneCore', resources.cpuPercentOneCore)]
    : [];
  return [
    atMost('maximumActiveCalls', observations.maximumActiveCalls),
    atMost('maximumQueuedCalls', observations.maximumQueuedCalls),
    atMost('maximumHeapUsedMiB', resources.heapUsedMiB),
    ...cpu,
    atMost('maximumEligibleLaneWaitMs', observations.maximumEligibleLaneWaitMs),
    atMost('maximumRetryAmplificationRatio', observations.retryAmplificationRatio),
    atMost('maximumCancellationLatencyMs', observations.maximumCancellationLatencyMs),
    { bound: 'minimumQuietPrincipalAdmissionRatio', limit: bounds.minimumQuietPrincipalAdmissionRatio,
      observed: observations.quietPrincipalAdmissionRatio,
      pass: observations.quietPrincipalAdmissionRatio >= bounds.minimumQuietPrincipalAdmissionRatio },
  ];
}

/** Build a digest-bound result record. The manifest digest must be computed from its exact bytes. */
export function decisionLoadResultRecord(input: {
  manifest: DecisionLoadManifest; manifestDigest: string; target: DecisionLoadResultRecord['target']; windowSeconds: number;
  observations: DecisionLoadObservations; resources: DecisionLoadResourceObservations;
}): DecisionLoadResultRecord {
  const comparisons = compareDecisionLoadBounds(input.manifest, input.observations, input.resources);
  const body: Omit<DecisionLoadResultRecord, 'digest'> = {
    schema: 'decision-load-result/v1',
    manifest: { schema: input.manifest.schema, version: input.manifest.version, digest: input.manifestDigest },
    mode: input.manifest.mode, target: input.target, window: { seconds: input.windowSeconds },
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    observations: input.observations, resources: input.resources, comparisons,
    passed: comparisons.every(comparison => comparison.pass),
  };
  return { ...body, digest: decisionLoadManifestDigest(canonicalJson(body)) };
}

export function verifyDecisionLoadResultRecord(record: DecisionLoadResultRecord, manifestDigest: string): boolean {
  const { digest, ...body } = record;
  return record.schema === 'decision-load-result/v1' && record.manifest.digest === manifestDigest
    && digest === decisionLoadManifestDigest(canonicalJson(body));
}

/** Historical offline evidence stays separate from verified, exact-commit v3 G5 artifacts. */
export function decisionLoadEvidenceFlags(records: readonly (DecisionLoadResultRecord | DecisionStagedLoadRecord | DecisionStagedLoadRecordV1)[], manifestDigest: string,
  sourceCommit?: string): Record<string, boolean> {
  const legacy = records.filter((record): record is DecisionLoadResultRecord => 'schema' in record);
  const bound = legacy.filter(record => verifyDecisionLoadResultRecord(record, manifestDigest));
  const offline = bound.filter(record => record.mode === 'offline-fake-provider');
  return {
    'load-manifest-offline-passed': offline.length > 0 && offline.length === legacy.filter(record => record.mode === 'offline-fake-provider').length
      && offline.every(record => record.passed),
    'load-manifest-qualified': records.length > 0 && records.every(record => 'schemaVersion' in record
      && record.manifestDigest === manifestDigest && verifyDecisionStagedLoadRecord(record, sourceCommit)),
  };
}
