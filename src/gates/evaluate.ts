import { qualificationIntegrityAllowlistProblems, type QualificationIntegrityMetadata } from '../decision/qualification/release.js';
import { artifactDigest } from '../decision/validate.js';
import { evaluatePredicate } from '../decision/predicates.js';
import { clopperPearsonInterval } from './stats/clopper-pearson.js';
import { wilsonScoreInterval } from './stats/binomial.js';
import { pairedMeanDifferenceBootstrap } from './stats/bootstrap.js';
import { PairedDifferenceError } from './stats/error.js';
import { pairedBinaryDifferenceInterval, pairedNonInferiority } from './stats/paired.js';
import { GateRegistry, authoredGatePacksOf, gateProvidersOf, resolveGateBinding, type ResolvedBinding } from './registry.js';
import { qualifyGateParameter } from './types.js';
import type {
  GateBinding, GateDefinition, GateEvidence, GateHoldoutInputs, GateMetricsDocument, GateOutcome, GateReport,
  GateStatus, MetricObservation, MetricSeries, Sha256Digest, UpstreamCeiling,
} from './types.js';

export class GateEvaluationError extends Error {
  constructor(message: string) { super(message); this.name = 'GateEvaluationError'; }
}

const RANK: Record<GateOutcome, number> = { PROMOTE: 0, HOLD: 1, ROLLBACK: 2 };

/** Shared outcome lattice. The maximum never upgrades any component. */
export function maxOutcome(...outcomes: GateOutcome[]): GateOutcome {
  return outcomes.reduce((worst, outcome) => (RANK[outcome] > RANK[worst] ? outcome : worst), 'PROMOTE' as GateOutcome);
}

/**
 * Per-gate outcome from its own status: `pass` promotes, `fail` takes the
 * gate's `onFail`, `insufficient` takes `onInsufficient` (always HOLD by load
 * validation; ROLLBACK needs an observed blocking failure). Shortfalls never PROMOTE.
 */
export function gateStatusOutcome(status: GateStatus, gate: Pick<GateDefinition, 'onFail' | 'onInsufficient'>): GateOutcome {
  if (status === 'pass') return 'PROMOTE';
  if (status === 'fail') return gate.onFail;
  return gate.onInsufficient ?? 'HOLD';
}

export interface EvaluateGatesInput {
  /** The binding under evaluation. Resolved internally against `registry`; never trusted from the caller. */
  binding: GateBinding;
  /** Registry holding every pinned pack and provider. Resolution re-derives packs, digests and parameters. */
  registry: GateRegistry;
  trustedBindingDigest: Sha256Digest;
  /** Required trusted holdout record (first-access time + frozen-record digest). Absent refuses. */
  holdout: GateHoldoutInputs;
  metrics: GateMetricsDocument;
  upstream: UpstreamCeiling | null;
  /** Fake-clock timestamp (ISO date-time). Recorded as evaluatedAt, so identical inputs give identical bytes. */
  now: string;
  /**
   * Removed: caller-supplied resolution is never accepted (it let callers drop
   * packs, empty gates or loosen parameters under a pinned digest). Present only
   * so old call sites fail with a clear refusal instead of a type error.
   */
  resolved?: never;
}

/** Binds an integrity report for evaluation. The digest is re-derived on every use; a forged copy is refused. */
export function sealUpstream(metadata: QualificationIntegrityMetadata): UpstreamCeiling {
  return { metadata, digest: artifactDigest(metadata) };
}

/**
 * Seals trusted holdout inputs for evaluation. The seal covers
 * `{frozenDigest, firstAccessedAt}` and is re-derived by `evaluateGates` on
 * every use, following the HeldoutFrozen seal (`readHeldoutFrozen` checks
 * `frozen.digest === heldoutDigest(frozen.bundle)`): a spread-copied or edited
 * record is refused. The seal is an unkeyed integrity digest, not an
 * authenticity proof, so the holdout inputs are trusted caller inputs built from
 * verified HeldoutFrozen and access records (verification of the frozen record
 * itself is tracked in #2833). `frozenDigest` is the binding digest in the frozen record.
 */
export function sealGateHoldout(input: {
  frozenDigest: Sha256Digest; firstAccessedAt: string | null;
}): import('./types.js').GateHoldoutInputs {
  const payload = { frozenDigest: input.frozenDigest, firstAccessedAt: input.firstAccessedAt };
  return { ...payload, digest: artifactDigest(payload) as Sha256Digest };
}

const fail = (message: string): never => { throw new GateEvaluationError(message); };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function supportOf(observation: MetricObservation | null | undefined): number | null {
  const n = observation?.n;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function poolObservations(kind: string, observations: MetricObservation[]): MetricObservation | null {
  if (!observations.length) return null;
  if (kind === 'proportion') {
    let n = 0;
    let events = 0;
    for (const observation of observations) {
      if (supportOf(observation) === null || typeof observation.events !== 'number'
        || !Number.isSafeInteger(observation.events) || observation.events < 0) return null;
      if ((observation.events as number) > (observation.n as number)) return null;
      n += observation.n as number;
      events += observation.events;
    }
    return { n, events };
  }
  if (kind === 'paired') {
    const total = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
    let n = 0;
    for (const observation of observations) {
      const cells = isRecord(observation?.paired)
        ? ['both', 'candidateOnly', 'baselineOnly', 'neither'].map(key =>
          (observation.paired as Record<string, unknown>)[key])
        : [];
      if (supportOf(observation) === null || cells.length !== 4
        || cells.some(cell => !Number.isSafeInteger(cell) || (cell as number) < 0)) {
        return null;
      }
      const [both, candidateOnly, baselineOnly, neither] = cells as [number, number, number, number];
      // The counted support must equal the cell sums; a disagreement is unknown, fail closed.
      if ((observation.n as number) !== both + candidateOnly + baselineOnly + neither) return null;
      n += observation.n as number;
      total.both += both;
      total.candidateOnly += candidateOnly;
      total.baselineOnly += baselineOnly;
      total.neither += neither;
    }
    return { n, paired: total };
  }
  if (kind === 'scalar') {
    let n = 0;
    let weighted = 0;
    for (const observation of observations) {
      if (supportOf(observation) === null || typeof observation.value !== 'number' || !Number.isFinite(observation.value)) return null;
      n += observation.n as number;
      weighted += (observation.n as number) * (observation.value as number);
    }
    return n === 0 ? null : { n, value: weighted / n };
  }
  if (kind === 'differences') {
    const differences: number[] = [];
    let n = 0;
    for (const observation of observations) {
      if (supportOf(observation) === null || !Array.isArray(observation.differences)
        || observation.differences.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
      if ((observation.n as number) !== (observation.differences as number[]).length) return null;
      n += observation.n as number;
      differences.push(...(observation.differences as number[]));
    }
    return { n, differences };
  }
  if (kind === 'evidence') {
    const available = observations.flatMap(observation => observation?.available ?? []);
    if (observations.some(observation => !Array.isArray(observation?.available))) return null;
    return { available };
  }
  return null;
}

interface SliceEvaluation {
  slice: string | null;
  status: GateStatus;
  reason: string;
  n: number | null;
  events?: number | null;
  statistic?: GateEvidence['statistic'];
  threshold?: GateEvidence['threshold'];
}

function seriesFor(gate: GateDefinition, pack: ResolvedBinding['packs'][number],
  metrics: GateMetricsDocument): MetricSeries | null {
  if (gate.metric === undefined) return null;
  const declared = pack.resolved.spec.metrics[gate.metric.name];
  if (declared === undefined || declared.provider !== gate.metric.provider) return null;
  return metrics.providers[gate.metric.provider]?.metrics[gate.metric.name] ?? null;
}

function metricKindOf(gate: GateDefinition, pack: ResolvedBinding['packs'][number]): string {
  if (gate.metric === undefined) return '';
  return pack.resolved.spec.metrics[gate.metric.name]?.kind ?? '';
}

function expandScope(gate: GateDefinition, kind: string, series: MetricSeries | null,
  slices: string[]): { slice: string | null; observation: MetricObservation | null }[] {
  const mode = gate.scope.mode;
  if (mode === 'all') return [{ slice: null, observation: series?.pooled ?? null }];
  if (mode === 'pooled') {
    const observations = (gate.scope.slices ?? []).map(slice => series?.bySlice[slice] ?? null);
    if (observations.some(observation => observation === null)) {
      return [{ slice: null, observation: null }];
    }
    return [{ slice: null, observation: poolObservations(kind, observations as MetricObservation[]) }];
  }
  const excluded = new Set(gate.scope.except ?? []);
  const names = mode === 'each' ? slices.filter(slice => !excluded.has(slice)) : (gate.scope.slices ?? []);
  return names.map(slice => ({ slice, observation: series?.bySlice[slice] ?? null }));
}

function pairedCells(observation: MetricObservation | null | undefined): {
  both: number; candidateOnly: number; baselineOnly: number; neither: number;
} | null {
  if (!isRecord(observation?.paired)) return null;
  const cells = ['both', 'candidateOnly', 'baselineOnly', 'neither'].map(key =>
    (observation.paired as Record<string, unknown>)[key]);
  if (cells.some(cell => !Number.isSafeInteger(cell) || (cell as number) < 0)) return null;
  const [both, candidateOnly, baselineOnly, neither] = cells as [number, number, number, number];
  return { both, candidateOnly, baselineOnly, neither };
}

function evaluateObservation(gate: GateDefinition, observation: MetricObservation | null,
  context: { packId: string; parameters: Record<string, number>; metrics: GateMetricsDocument;
    upstream: UpstreamCeiling | null; nowMs: number; slice: string | null; slices: string[] }): SliceEvaluation {
  const { packId, parameters, metrics, upstream, nowMs, slice, slices } = context;
  const base = { slice, n: supportOf(observation) };
  const minimumN = gate.minimumN ?? 0;
  // Evidence gates observe attestations, not counted support; upstream and predicate
  // gates read the ceiling and the whole document. None of them take an n.
  if (gate.kind !== 'upstream-ceiling' && gate.kind !== 'predicate' && gate.kind !== 'evidence') {
    if (observation === null || observation === undefined) return { ...base, status: 'insufficient', reason: 'metric-missing' };
    if (base.n === null) return { ...base, status: 'insufficient', reason: 'support-unknown' };
    if (base.n < minimumN) return { ...base, status: 'insufficient', reason: 'below-minimum-n' };
  }
  const thresholdValue = (): number | null => {
    if (gate.threshold?.value !== undefined) return gate.threshold.value;
    if (gate.threshold?.param !== undefined) {
      const value = parameters[qualifyGateParameter(packId, gate.threshold.param)];
      return typeof value === 'number' ? value : null;
    }
    return null;
  };
  switch (gate.kind) {
    case 'minimum-n': {
      const passed = (base.n as number) >= (gate.minimumN as number);
      return { ...base, status: passed ? 'pass' : 'insufficient', reason: passed ? 'support-met' : 'below-minimum-n',
        statistic: { method: 'support-count' } };
    }
    case 'interval-bound': {
      const events = observation?.events;
      if (typeof events !== 'number' || !Number.isSafeInteger(events) || events < 0) {
        return { ...base, status: 'insufficient', reason: 'events-unknown', events: null };
      }
      if (events > (base.n as number)) return { ...base, status: 'insufficient', reason: 'events-exceed-n', events };
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing', events };
      const method = gate.statistic?.method ?? 'wilson';
      const levelBps = gate.statistic?.levelBps as number;
      let lower: number;
      let upper: number;
      try {
        if (method === 'clopper-pearson') {
          ({ lower, upper } = clopperPearsonInterval({ events, n: base.n as number, levelBps }));
        } else {
          [lower, upper] = wilsonScoreInterval({ events, n: base.n as number, levelBps });
        }
      } catch (error) {
        if (error instanceof PairedDifferenceError) {
          return { ...base, status: 'insufficient', reason: 'statistic-invalid', events };
        }
        throw error;
      }
      const lowerBps = Math.max(0, Math.floor(lower * 10000));
      const upperBps = Math.min(10000, Math.ceil(upper * 10000));
      const estimateBps = Math.round(events / (base.n as number) * 10000);
      const passed = gate.statistic?.bound === 'upper' ? upperBps <= target : lowerBps >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'bound-within-threshold' : 'bound-breaches-threshold',
        events, statistic: { method, levelBps, lowerBps, upperBps, estimateBps },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'paired-difference': {
      const cells = pairedCells(observation);
      if (cells === null) return { ...base, status: 'insufficient', reason: 'paired-unknown' };
      if ((base.n as number) !== cells.both + cells.candidateOnly + cells.baselineOnly + cells.neither) {
        return { ...base, status: 'insufficient', reason: 'observation-mismatch' };
      }
      const method = gate.statistic?.method ?? 'newcombe';
      const levelBps = gate.statistic?.levelBps as number;
      let interval;
      try {
        interval = pairedBinaryDifferenceInterval({ counts: cells, levelBps, method: method === 'tango' ? 'tango' : 'newcombe-10' });
      } catch (error) {
        if (error instanceof PairedDifferenceError) return { ...base, status: 'insufficient', reason: 'paired-invalid' };
        throw error;
      }
      const mode = gate.statistic?.mode ?? 'non-inferiority';
      const margin = gate.statistic?.marginBps ?? 0;
      const statistic = { method, levelBps, lowerBps: interval.lowerBps, upperBps: interval.upperBps,
        estimateBps: interval.estimateBps };
      const threshold = { op: 'gte' as const, resolved: margin };
      if (mode === 'non-inferiority') {
        const verdict = pairedNonInferiority({ interval, marginBps: margin });
        if (verdict.decision === 'insufficient') return { ...base, status: 'insufficient', reason: 'paired-invalid', statistic, threshold };
        const passed = verdict.decision === 'non-inferior';
        return { ...base, status: passed ? 'pass' : 'fail',
          reason: passed ? 'lower-bound-at-or-above-margin' : 'lower-bound-below-margin', statistic, threshold };
      }
      const passed = interval.lowerBps > margin;
      return { ...base, status: passed ? 'pass' : 'fail',
        reason: passed ? 'lower-bound-above-margin' : 'lower-bound-at-or-below-margin', statistic, threshold };
    }
    case 'bootstrap-bound': {
      const differences = observation?.differences;
      if (!Array.isArray(differences)) return { ...base, status: 'insufficient', reason: 'differences-unknown' };
      if (differences.length !== base.n) return { ...base, status: 'insufficient', reason: 'observation-mismatch' };
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
      let interval;
      try {
        interval = pairedMeanDifferenceBootstrap({ differences, levelBps: gate.statistic?.levelBps as number,
          seed: gate.statistic?.seed as number, resamples: gate.statistic?.resamples as number,
          bounds: gate.statistic?.bounds as [number, number] });
      } catch (error) {
        if (error instanceof PairedDifferenceError) return { ...base, status: 'insufficient', reason: 'statistic-invalid' };
        throw error;
      }
      const passed = gate.statistic?.bound === 'upper' ? interval.upperBps <= target : interval.lowerBps >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'bound-within-threshold' : 'bound-breaches-threshold',
        statistic: { method: 'bootstrap', levelBps: gate.statistic?.levelBps, lowerBps: interval.lowerBps,
          upperBps: interval.upperBps, estimateBps: interval.estimateBps },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'count-max':
    case 'count-min': {
      const events = observation?.events;
      if (typeof events !== 'number' || !Number.isSafeInteger(events) || events < 0) {
        return { ...base, status: 'insufficient', reason: 'events-unknown', events: null };
      }
      if (events > (base.n as number)) return { ...base, status: 'insufficient', reason: 'events-exceed-n', events };
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing', events };
      const passed = gate.kind === 'count-max' ? events <= target : events >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'count-within-threshold' : 'count-breaches-threshold',
        events, statistic: { method: 'exact-count' },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'value-threshold': {
      const value = observation?.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ...base, status: 'insufficient', reason: 'value-unknown' };
      }
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
      const passed = gate.threshold?.op === 'lte' ? value <= target : value >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'value-within-threshold' : 'value-breaches-threshold',
        statistic: { method: 'exact-value' },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'evidence': {
      const available = observation?.available;
      if (!Array.isArray(available)) return { ...base, status: 'insufficient', reason: 'evidence-unknown' };
      for (const id of gate.evidence?.required ?? []) {
        const entry = available.find(candidate => candidate?.id === id);
        if (entry === undefined) return { ...base, status: 'insufficient', reason: 'evidence-missing', statistic: { method: 'evidence-present' } };
        if (entry.passed !== true) {
          return { ...base, status: 'fail', reason: 'evidence-failed', statistic: { method: 'evidence-present' } };
        }
        if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
          const expiry = Date.parse(entry.expiresAt);
          if (!Number.isFinite(expiry) || expiry <= nowMs) {
            return { ...base, status: 'fail', reason: 'evidence-expired', statistic: { method: 'evidence-present' } };
          }
        }
      }
      return { ...base, status: 'pass', reason: 'evidence-present', statistic: { method: 'evidence-present' } };
    }
    case 'predicate': {
      let value: unknown = 'unknown';
      try {
        value = evaluatePredicate(gate.predicate!, { metrics, parameters, slices }, {});
      } catch {
        value = 'unknown';
      }
      if (value === true) return { ...base, status: 'pass', reason: 'predicate-true', statistic: { method: 'predicate' } };
      if (value === false) return { ...base, status: 'fail', reason: 'predicate-false', statistic: { method: 'predicate' } };
      return { ...base, status: 'insufficient', reason: 'predicate-unknown', statistic: { method: 'predicate' } };
    }
    case 'upstream-ceiling': {
      if (upstream === null) return { ...base, status: 'insufficient', reason: 'upstream-missing',
        statistic: { method: 'upstream-integrity' } };
      const problems = qualificationIntegrityAllowlistProblems(upstream.metadata);
      if (!problems.length) {
        return { ...base, status: 'pass', reason: 'upstream-clean', statistic: { method: 'upstream-integrity' } };
      }
      const compromised = problems.includes('compromised')
        || (upstream.metadata as { release_gate?: { decision?: string } }).release_gate?.decision === 'ROLLBACK'
        || (upstream.metadata as { integrity_state?: string }).integrity_state === 'compromised';
      return { ...base, status: 'fail', reason: compromised ? 'upstream-compromised' : 'upstream-allowlist',
        statistic: { method: 'upstream-integrity' } };
    }
  }
}

function upstreamOutcome(upstream: UpstreamCeiling | null): { ceiling: GateOutcome; problems: string[] } {
  if (upstream === null) return { ceiling: 'HOLD', problems: ['upstream-ceiling-missing'] };
  const problems = qualificationIntegrityAllowlistProblems(upstream.metadata);
  const release = (upstream.metadata as { release_gate?: { decision?: GateOutcome } }).release_gate?.decision;
  const compromised = problems.includes('compromised')
    || release === 'ROLLBACK'
    || (upstream.metadata as { integrity_state?: string }).integrity_state === 'compromised';
  if (compromised) return { ceiling: 'ROLLBACK', problems };
  if (problems.length || release === 'HOLD') return { ceiling: 'HOLD', problems };
  return { ceiling: 'PROMOTE', problems };
}

/**
 * Pure, deterministic gate evaluation. The binding is resolved internally
 * against the registry: pack pins (authored + composed digests), provider pins
 * and parameters are re-derived, so no caller-supplied resolution is accepted.
 * Precondition violations (untrusted digests, provider pin mismatches,
 * missing trusted holdout inputs, frozen-after-holdout bindings) throw before
 * any gate runs, so failure paths never discard completed results. Per-gate
 * shortfalls report `insufficient`, which never promotes.
 *
 * Interval levels are two-sided confidence levels applied to one-sided bounds:
 * the reported bound is the one-sided edge of a two-sided interval, which is
 * conservative (wider) relative to a one-sided interval at the same level.
 */
export function evaluateGates(input: EvaluateGatesInput): GateReport {
  const { binding, registry, trustedBindingDigest, holdout, metrics, upstream, now } = input;
  if ('resolved' in (input as unknown as Record<string, unknown>)
    && (input as unknown as Record<string, unknown>).resolved !== undefined) {
    fail('caller-supplied gate resolution is not accepted: pass the binding and registry');
  }
  if (!(registry instanceof GateRegistry)) fail('a GateRegistry is required for internal resolution');
  // Reserve before dispatch: resolve and fully validate the binding (pins,
  // providers, parameters, slices) before any gate observes any metric. The
  // resolution runs through the pure `resolveGateBinding` over a standalone
  // snapshot of the registry's authored packs: no overridable `GateRegistry`
  // instance method is called for anything security-relevant, so a subclass
  // that overrides `resolveBinding` (or a duck-typed `{resolveBinding}`)
  // cannot empty gates, loosen parameters or forge digests.
  const resolved = resolveGateBinding(binding, authoredGatePacksOf(registry), gateProvidersOf(registry));
  const { packs, parameters } = resolved;
  // 1:1 pins<->packs: the pin list and the resolved packs must match exactly.
  if (packs.length !== binding.spec.packs.length) fail('binding pins do not match resolved packs 1:1');
  for (const pack of packs) {
    // Recompute the authored digest: the stored pin is never trusted on its own.
    if ((artifactDigest(pack.authored) as Sha256Digest) !== pack.digest) {
      fail(`pack digest mismatch for ${pack.authored.metadata.id}`);
    }
    // Recompute the composed digest from the evaluator's own pure composition
    // (`resolveGateBinding` above): registry-provided resolved bytes and
    // digests are never trusted.
    if ((artifactDigest(pack.resolved) as Sha256Digest) !== pack.resolvedDigest) {
      fail(`composed pack digest mismatch for ${pack.authored.metadata.id}`);
    }
    const pin = binding.spec.packs.find(candidate => candidate.id === pack.authored.metadata.id);
    if (pin === undefined || pin.version !== pack.authored.metadata.version
      || pin.digest !== pack.digest || pin.resolvedDigest !== pack.resolvedDigest) {
      fail(`pack pin mismatch for ${pack.authored.metadata.id}`);
    }
  }
  // Every metric section consumed must be pinned; an unpinned section is
  // refused rather than evaluated. Null version/digests never match.
  for (const pin of binding.spec.metricProviders) {
    const section = metrics.providers[pin.id];
    if (section === undefined || section.version !== pin.version || section.sourceDigest !== pin.sourceDigest) {
      fail(`metric provider pin mismatch for ${pin.id}`);
    }
  }
  for (const id of Object.keys(metrics.providers)) {
    if (!binding.spec.metricProviders.some(pin => pin.id === id)) {
      fail(`metric provider ${id} is not pinned by the binding`);
    }
  }
  if (upstream !== null && artifactDigest(upstream.metadata) !== upstream.digest) {
    fail('upstream integrity digest does not match its report');
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) fail('evaluation timestamp is not a valid date-time');
  if (artifactDigest(binding) !== trustedBindingDigest) fail('binding digest does not match its trusted pin');
  // Holdout freeze is enforced from the REQUIRED sealed holdout record, never
  // from binding fields (which the study author controls). The seal is
  // re-derived here: `frozenDigest` and `firstAccessedAt` come only from a
  // `sealGateHoldout` record whose digest matches its content.
  if (holdout === undefined || holdout === null) fail('trusted holdout inputs are required for evaluation');
  const sealed = holdout as { frozenDigest?: unknown; firstAccessedAt?: unknown; digest?: unknown };
  if (typeof sealed.digest !== 'string'
    || artifactDigest({ frozenDigest: sealed.frozenDigest, firstAccessedAt: sealed.firstAccessedAt }) !== sealed.digest) {
    fail('holdout record seal does not match its content');
  }
  if (sealed.frozenDigest !== trustedBindingDigest) fail('binding digest does not match the frozen record digest');
  const frozenDigest = sealed.frozenDigest as Sha256Digest;
  const firstAccessedAt = sealed.firstAccessedAt as string | null;
  if (firstAccessedAt !== null && typeof firstAccessedAt !== 'string') {
    fail('trusted holdout first-access time must be a date-time or null');
  }
  // Null access is allowed only when the binding declares no held-out split:
  // a split binding with a null record would disable the freeze check.
  const declaresSplit = binding.spec.splitDigest !== undefined
    || binding.spec.corpusDigest !== undefined || binding.spec.goldDigest !== undefined;
  if (firstAccessedAt === null && declaresSplit) {
    fail('holdout record reports no access but the binding declares held-out data');
  }
  const frozenAt = Date.parse(binding.spec.frozenAt);
  if (!Number.isFinite(frozenAt)) fail('binding freeze timestamp is not a valid date-time');
  if (frozenAt > nowMs) fail('binding freezes after the evaluation timestamp');
  if (firstAccessedAt !== null) {
    const accessedAt = Date.parse(firstAccessedAt);
    if (!Number.isFinite(accessedAt)) fail('holdout access timestamp is not a valid date-time');
    if (frozenAt >= accessedAt) fail('binding froze at or after holdout access: evaluation refused');
    if (accessedAt > nowMs) fail('holdout access timestamp is after the evaluation timestamp');
  }
  const gateEvidence: GateEvidence[] = [];
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) {
      const kind = metricKindOf(gate, pack);
      const series = seriesFor(gate, pack, metrics);
      const targets = gate.kind === 'upstream-ceiling' || gate.kind === 'predicate'
        ? [{ slice: null as string | null, observation: null }]
        : expandScope(gate, kind, series, binding.spec.slices);
      if (!targets.length) {
        // Unreachable through resolveBinding (vacuous scopes are load errors),
        // but a zero-target gate must never PROMOTE vacuously.
        gateEvidence.push({
          gateId: gate.id, kind: gate.kind,
          scope: { mode: gate.scope.mode, ...(gate.scope.slices === undefined ? {} : { slices: [...gate.scope.slices] }) },
          slice: null, n: null, status: 'insufficient', outcome: gate.onInsufficient ?? 'HOLD',
          reasons: [`${gate.id}:no-evaluation-targets`],
        });
        continue;
      }
      for (const target of targets) {
        const evaluation = evaluateObservation(gate, target.observation,
          { packId: pack.authored.metadata.id, parameters, metrics, upstream, nowMs,
            slice: target.slice, slices: binding.spec.slices });
        // Upstream-ceiling gates mirror the upstream verdict exactly: compromise
        // rolls back, allowlist problems hold, clean promotes. The gate's own
        // onFail never escalates (or softens) the trusted verdict.
        const outcome = gate.kind === 'upstream-ceiling' && evaluation.status === 'fail'
          ? upstreamOutcome(upstream).ceiling
          : gateStatusOutcome(evaluation.status, gate);
        gateEvidence.push({
          gateId: gate.id, kind: gate.kind,
          scope: { mode: gate.scope.mode, ...(gate.scope.slices === undefined ? {} : { slices: [...gate.scope.slices] }) },
          slice: evaluation.slice, n: evaluation.n,
          ...(evaluation.events === undefined ? {} : { events: evaluation.events }),
          ...(evaluation.statistic === undefined ? {} : { statistic: evaluation.statistic }),
          ...(evaluation.threshold === undefined ? {} : { threshold: evaluation.threshold }),
          status: evaluation.status,
          outcome,
          reasons: [`${gate.id}:${evaluation.reason}`],
        });
      }
    }
  }
  const packOutcome = maxOutcome(...gateEvidence.map(entry => entry.outcome));
  const { ceiling: upstreamCeiling, problems: upstreamProblems } = upstreamOutcome(upstream);
  const bindingCeiling = binding.spec.ceiling ?? 'PROMOTE';
  const decision = maxOutcome(packOutcome, upstreamCeiling, bindingCeiling);
  const body = {
    apiVersion: binding.apiVersion,
    kind: 'GateReport' as const,
    metadata: { id: binding.metadata.id, version: binding.metadata.version,
      description: `GateReport for ${binding.metadata.id}` },
    binding: { id: binding.metadata.id, version: binding.metadata.version, digest: trustedBindingDigest },
    packs: packs.map(pack => ({ id: pack.authored.metadata.id, version: pack.authored.metadata.version,
      digest: pack.digest, resolvedDigest: pack.resolvedDigest })),
    metricProviders: binding.spec.metricProviders.map(pin => ({ ...pin })),
    metricsDigest: artifactDigest(metrics),
    holdout: { digest: sealed.digest as Sha256Digest, frozenDigest, firstAccessedAt },
    gateEvidence,
    references: binding.spec.references.map(reference => ({
      name: reference.name, kind: reference.kind, observed: metrics.references?.[reference.name] !== undefined,
    })),
    upstream: upstream === null ? null : {
      decision: upstreamCeiling,
      reasons: upstreamProblems.map(problem => `upstream:${problem}`),
      digest: upstream.digest,
    },
    ceilings: { packOutcome, upstreamCeiling, bindingCeiling },
    decision,
    evaluatedAt: now,
  };
  return { ...body, digest: artifactDigest(body) };
}
