import { qualificationIntegrityAllowlistProblems, type QualificationIntegrityMetadata } from '../decision/qualification/release.js';
import { artifactDigest } from '../decision/validate.js';
import { evaluatePredicate } from '../decision/predicates.js';
import { clopperPearsonInterval } from './stats/clopper-pearson.js';
import { wilsonScoreInterval } from './stats/binomial.js';
import { pairedMeanDifferenceBootstrap } from './stats/bootstrap.js';
import { PairedDifferenceError } from './stats/error.js';
import { pairedBinaryDifferenceInterval, pairedNonInferiority } from './stats/paired.js';
import type { ResolvedBinding } from './registry.js';
import type {
  GateDefinition, GateEvidence, GateMetricsDocument, GateOutcome, GateReport, GateStatus,
  MetricObservation, MetricSeries, Sha256Digest, UpstreamCeiling,
} from './types.js';

export class GateEvaluationError extends Error {
  constructor(message: string) { super(message); this.name = 'GateEvaluationError'; }
}

const RANK: Record<GateOutcome, number> = { PROMOTE: 0, HOLD: 1, ROLLBACK: 2 };

/** Shared outcome lattice. The maximum never upgrades any component. */
export function maxOutcome(...outcomes: GateOutcome[]): GateOutcome {
  return outcomes.reduce((worst, outcome) => (RANK[outcome] > RANK[worst] ? outcome : worst), 'PROMOTE' as GateOutcome);
}

/** Severity floor: blocking gates ROLLBACK on breach or insufficient evidence, standard gates HOLD. */
export function severityOutcome(status: GateStatus, severity: GateDefinition['severity']): GateOutcome {
  if (status === 'pass') return 'PROMOTE';
  return severity === 'blocking' ? 'ROLLBACK' : 'HOLD';
}

export interface EvaluateGatesInput {
  resolved: ResolvedBinding;
  trustedBindingDigest: Sha256Digest;
  metrics: GateMetricsDocument;
  upstream: UpstreamCeiling | null;
  /** Fake-clock timestamp (ISO date-time). Recorded as evaluatedAt, so identical inputs give identical bytes. */
  now: string;
}

/** Binds an integrity report for evaluation. The digest is re-derived on every use; a forged copy is refused. */
export function sealUpstream(metadata: QualificationIntegrityMetadata): UpstreamCeiling {
  return { metadata, digest: artifactDigest(metadata) };
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

function evaluateObservation(gate: GateDefinition, observation: MetricObservation | null,
  context: { parameters: Record<string, number>; metrics: GateMetricsDocument; upstream: UpstreamCeiling | null;
    nowMs: number; slice: string | null; slices: string[] }): SliceEvaluation {
  const { parameters, metrics, upstream, nowMs, slice, slices } = context;
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
      const value = parameters[gate.threshold.param];
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
      const paired = observation?.paired;
      if (paired === null || paired === undefined) return { ...base, status: 'insufficient', reason: 'paired-unknown' };
      const method = gate.statistic?.method ?? 'newcombe';
      const levelBps = gate.statistic?.levelBps as number;
      let interval;
      try {
        interval = pairedBinaryDifferenceInterval({ counts: paired, levelBps, method: method === 'tango' ? 'tango' : 'newcombe-10' });
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
 * Pure, deterministic gate evaluation. Precondition violations (untrusted digests,
 * provider pin mismatches, frozen-after-holdout bindings) throw before any gate runs,
 * so failure paths never discard completed results. Per-gate shortfalls report
 * `insufficient`, which never promotes.
 */
export function evaluateGates(input: EvaluateGatesInput): GateReport {
  const { resolved, trustedBindingDigest, metrics, upstream, now } = input;
  const { binding, packs, parameters } = resolved;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) fail('evaluation timestamp is not a valid date-time');
  if (artifactDigest(binding) !== trustedBindingDigest) fail('binding digest does not match its trusted pin');
  for (const pack of packs) {
    const pin = binding.spec.packs.find(candidate => candidate.id === pack.authored.metadata.id);
    if (pin === undefined || pin.version !== pack.authored.metadata.version || pin.digest !== pack.digest) {
      fail(`pack pin mismatch for ${pack.authored.metadata.id}`);
    }
  }
  for (const pin of binding.spec.metricProviders) {
    const section = metrics.providers[pin.id];
    if (section === undefined || section.version !== pin.version || section.sourceDigest !== pin.sourceDigest) {
      fail(`metric provider pin mismatch for ${pin.id}`);
    }
  }
  if (upstream !== null && artifactDigest(upstream.metadata) !== upstream.digest) {
    fail('upstream integrity digest does not match its report');
  }
  const frozenAt = Date.parse(binding.spec.frozenAt);
  if (frozenAt > nowMs) fail('binding freezes after the evaluation timestamp');
  if (binding.spec.holdoutAccessedAt !== undefined && binding.spec.holdoutAccessedAt !== null) {
    const accessedAt = Date.parse(binding.spec.holdoutAccessedAt);
    if (!Number.isFinite(accessedAt)) fail('holdout access timestamp is not a valid date-time');
    if (frozenAt >= accessedAt) fail('binding froze at or after holdout access: evaluation refused');
  }
  const gateEvidence: GateEvidence[] = [];
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) {
      const kind = metricKindOf(gate, pack);
      const series = seriesFor(gate, pack, metrics);
      const targets = gate.kind === 'upstream-ceiling' || gate.kind === 'predicate'
        ? [{ slice: null as string | null, observation: null }]
        : expandScope(gate, kind, series, binding.spec.slices);
      for (const target of targets) {
        const evaluation = evaluateObservation(gate, target.observation,
          { parameters, metrics, upstream, nowMs, slice: target.slice, slices: binding.spec.slices });
        gateEvidence.push({
          gateId: gate.id, kind: gate.kind,
          scope: { mode: gate.scope.mode, ...(gate.scope.slices === undefined ? {} : { slices: [...gate.scope.slices] }) },
          slice: evaluation.slice, n: evaluation.n,
          ...(evaluation.events === undefined ? {} : { events: evaluation.events }),
          ...(evaluation.statistic === undefined ? {} : { statistic: evaluation.statistic }),
          ...(evaluation.threshold === undefined ? {} : { threshold: evaluation.threshold }),
          status: evaluation.status,
          outcome: gate.kind === 'upstream-ceiling' && evaluation.status === 'fail'
            ? upstreamFailOutcome(upstream, gate.severity)
            : severityOutcome(evaluation.status, gate.severity),
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
    packs: packs.map(pack => ({ id: pack.authored.metadata.id, version: pack.authored.metadata.version, digest: pack.digest })),
    metricProviders: binding.spec.metricProviders.map(pin => ({ ...pin })),
    metricsDigest: artifactDigest(metrics),
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

/** An upstream-ceiling breach mirrors the upstream verdict: compromise forces ROLLBACK, otherwise at least HOLD. */
function upstreamFailOutcome(upstream: UpstreamCeiling | null, severity: GateDefinition['severity']): GateOutcome {
  const floor = severityOutcome('fail', severity);
  if (upstream === null) return floor;
  const { ceiling } = upstreamOutcome(upstream);
  return maxOutcome(floor, ceiling);
}
