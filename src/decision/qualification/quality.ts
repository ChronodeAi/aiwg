import { createHash } from 'node:crypto';

/** Frozen dataset memberships. Threshold selection may read tuning/calibration, never test. */
export interface QualificationSplit {
  name: 'tuning' | 'calibration' | 'test';
  ids: readonly string[];
  digest: `sha256:${string}`;
}

export interface FrozenBinaryBenchmarkPlan {
  schemaVersion: 'decision-binary-benchmark-plan/v1';
  splits: readonly QualificationSplit[];
  /** Hash of sorted (id, label, slice) triples across all splits, before any held-out predictions. */
  datasetDigest: `sha256:${string}`;
  minimumOverallN: number;
  minimumSliceN: number;
  maximumSelectiveRisk: number;
  maximumReviewRate: number;
  maximumBrier: number;
  digest: `sha256:${string}`;
}

export interface BinaryBenchmarkLabel { id: string; label: 0 | 1; slice: string }

const sha256 = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Freeze thresholds and all three label sets before acquiring test predictions. */
export function freezeBinaryBenchmarkPlan(
  splits: readonly QualificationSplit[], labels: readonly BinaryBenchmarkLabel[],
  limits: Pick<FrozenBinaryBenchmarkPlan, 'minimumOverallN' | 'minimumSliceN' | 'maximumSelectiveRisk' | 'maximumReviewRate' | 'maximumBrier'>,
): FrozenBinaryBenchmarkPlan {
  verifyQualificationSplits(splits);
  const ids = splits.flatMap(split => split.ids).sort();
  if (labels.length !== ids.length || new Set(labels.map(label => label.id)).size !== ids.length
    || labels.some(label => !ids.includes(label.id) || ![0, 1].includes(label.label) || !label.slice?.trim())
    || !Number.isSafeInteger(limits.minimumOverallN) || limits.minimumOverallN < 1
    || !Number.isSafeInteger(limits.minimumSliceN) || limits.minimumSliceN < 1
    || [limits.maximumSelectiveRisk, limits.maximumReviewRate, limits.maximumBrier]
      .some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('invalid preregistered benchmark plan');
  }
  const fields = {
    schemaVersion: 'decision-binary-benchmark-plan/v1' as const,
    splits: ['tuning', 'calibration', 'test'].map(name => splits.find(split => split.name === name)!),
    datasetDigest: sha256([...labels].sort((a, b) => a.id.localeCompare(b.id))),
    ...limits,
  };
  return { ...fields, digest: sha256(fields) };
}

/** A separately anchored digest is required: a caller-created plan cannot attest its own preregistration. */
export function evaluatePreregisteredBinaryBenchmark(
  plan: FrozenBinaryBenchmarkPlan, trustedPlanDigest: `sha256:${string}`,
  labels: readonly BinaryBenchmarkLabel[], samples: readonly BinaryQualificationSample[],
): { decision: 'pass' | 'fail' | 'insufficient-evidence'; reasons: string[]; metrics: ReturnType<typeof evaluateBinaryHeldout> } {
  const { digest, ...fields } = plan;
  if (digest !== trustedPlanDigest || digest !== sha256(fields)
    || freezeBinaryBenchmarkPlan(plan.splits, labels, {
      minimumOverallN: plan.minimumOverallN, minimumSliceN: plan.minimumSliceN,
      maximumSelectiveRisk: plan.maximumSelectiveRisk, maximumReviewRate: plan.maximumReviewRate,
      maximumBrier: plan.maximumBrier,
    }).digest !== digest) throw new Error('benchmark preregistration or dataset mismatch');
  const testLabels = new Map(labels.filter(label => plan.splits.find(split => split.name === 'test')!.ids.includes(label.id))
    .map(label => [label.id, label]));
  if (samples.some(sample => sample.label !== testLabels.get(sample.id)?.label || sample.slice !== testLabels.get(sample.id)?.slice)) {
    throw new Error('held-out label or slice mismatch');
  }
  const metrics = evaluateBinaryHeldout(plan.splits, samples);
  const insufficient = metrics.overall.sampleN < plan.minimumOverallN
    || Object.values(metrics.slices).some(slice => slice.sampleN < plan.minimumSliceN || slice.selectiveRisk === null);
  const reasons: string[] = [];
  if (insufficient) reasons.push('insufficient-heldout-evidence');
  if (metrics.overall.selectiveRisk === null) reasons.push('zero-accepted-samples');
  if (metrics.overall.selectiveRisk !== null && metrics.overall.selectiveRisk > plan.maximumSelectiveRisk) reasons.push('selective-risk');
  if (metrics.overall.reviewRate > plan.maximumReviewRate) reasons.push('review-rate');
  if (metrics.overall.brier > plan.maximumBrier) reasons.push('brier');
  const exceeded = reasons.some(reason => reason === 'selective-risk' || reason === 'review-rate' || reason === 'brier');
  return { decision: exceeded ? 'fail' : insufficient || metrics.overall.selectiveRisk === null ? 'insufficient-evidence'
    : 'pass', reasons, metrics };
}

export interface BinaryQualificationSample {
  id: string;
  slice: string;
  label: 0 | 1;
  probability: number;
  accepted: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  calls: number;
  retries: number;
  fallbacks: number;
}

export interface BinarySliceMetrics {
  sampleN: number;
  errorRate: number;
  brier: number;
  logLoss: number;
  expectedCalibrationError: number;
  coverage: number;
  selectiveRisk: number | null;
  reviewRate: number;
  errorWilson95: readonly [number, number];
  latencyMs: { p50: number; p95: number; p99: number };
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  calls: number;
  retries: number;
  fallbacks: number;
}

function digestIds(ids: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')}`;
}

/** Hash the exact membership set; duplicate, empty and overlapping IDs fail closed. */
export function freezeQualificationSplit(name: QualificationSplit['name'], ids: readonly string[]): QualificationSplit {
  if (!ids.length || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('qualification split requires unique nonempty IDs');
  }
  return { name, ids: [...ids].sort(), digest: digestIds(ids) };
}

export function verifyQualificationSplits(splits: readonly QualificationSplit[]): void {
  if (splits.length !== 3 || new Set(splits.map(split => split.name)).size !== 3
    || splits.some(split => !['tuning', 'calibration', 'test'].includes(split.name))) {
    throw new Error('qualification requires tuning, calibration and test splits');
  }
  const all = new Set<string>();
  for (const split of splits) {
    if (!split.ids.length || split.ids.some(id => typeof id !== 'string' || !id.trim())
      || new Set(split.ids).size !== split.ids.length || split.digest !== digestIds(split.ids)) {
      throw new Error('qualification split digest or membership mismatch');
    }
    for (const id of split.ids) {
      if (all.has(id)) throw new Error('qualification splits overlap');
      all.add(id);
    }
  }
}

/** Refuses to score unregistered or non-held-out samples. */
export function evaluateBinaryHeldout(
  splits: readonly QualificationSplit[],
  samples: readonly BinaryQualificationSample[],
): { overall: BinarySliceMetrics; slices: Record<string, BinarySliceMetrics> } {
  return evaluateBinarySplit(splits, samples, 'test');
}

/** Descriptive fit diagnostics; calibration observations are never held-out test evidence. */
export function evaluateBinaryCalibration(splits: readonly QualificationSplit[], samples: readonly BinaryQualificationSample[]) {
  return evaluateBinarySplit(splits, samples, 'calibration');
}

function evaluateBinarySplit(splits: readonly QualificationSplit[], samples: readonly BinaryQualificationSample[], name: 'test' | 'calibration') {
  verifyQualificationSplits(splits);
  const test = splits.find(split => split.name === name)!;
  if (samples.length !== test.ids.length || new Set(samples.map(sample => sample.id)).size !== samples.length
    || samples.some(sample => !test.ids.includes(sample.id))) {
    throw new Error('held-out sample membership mismatch');
  }
  for (const sample of samples) {
    if (typeof sample.slice !== 'string' || !sample.slice.trim() || typeof sample.accepted !== 'boolean'
      || ![0, 1].includes(sample.label)
      || !Number.isFinite(sample.probability) || sample.probability < 0 || sample.probability > 1
      || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0
      || [sample.calls, sample.retries, sample.fallbacks].some(n => !Number.isSafeInteger(n) || n < 0)
      || [sample.inputTokens, sample.outputTokens].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0))
      || (sample.costUsd !== null && (!Number.isFinite(sample.costUsd) || sample.costUsd < 0))) {
      throw new Error('invalid held-out sample');
    }
  }
  const groups = new Map<string, BinaryQualificationSample[]>();
  for (const sample of samples) groups.set(sample.slice, [...(groups.get(sample.slice) ?? []), sample]);
  return {
    overall: scoreBinary(samples),
    slices: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, scoreBinary(group)])),
  };
}

export interface OrdinalQualificationSample {
  id: string;
  trueLevel: number;
  predictedLevel: number;
  levels: number;
}

/** Mean absolute level error and exact match, scored on a frozen held-out split. */
export function evaluateOrdinalHeldout(
  splits: readonly QualificationSplit[], samples: readonly OrdinalQualificationSample[],
): { sampleN: number; exactRate: number; meanAbsoluteError: number; normalizedAbsoluteError: number } {
  verifyQualificationSplits(splits);
  const testIds = splits.find(split => split.name === 'test')!.ids;
  if (samples.length !== testIds.length || new Set(samples.map(s => s.id)).size !== samples.length
    || samples.some(s => !testIds.includes(s.id))) throw new Error('held-out ordinal membership mismatch');
  if (samples.some(s => !Number.isSafeInteger(s.levels) || s.levels < 2
    || !Number.isSafeInteger(s.trueLevel) || !Number.isSafeInteger(s.predictedLevel)
    || s.trueLevel < 0 || s.trueLevel >= s.levels || s.predictedLevel < 0 || s.predictedLevel >= s.levels)) {
    throw new Error('invalid held-out ordinal sample');
  }
  return {
    sampleN: samples.length,
    exactRate: samples.filter(s => s.trueLevel === s.predictedLevel).length / samples.length,
    meanAbsoluteError: samples.reduce((sum, s) => sum + Math.abs(s.trueLevel - s.predictedLevel), 0) / samples.length,
    normalizedAbsoluteError: samples.reduce((sum, s) => sum + Math.abs(s.trueLevel - s.predictedLevel) / (s.levels - 1), 0) / samples.length,
  };
}

export interface RankingQualificationSample {
  id: string;
  /** Higher score means preferred; scores must refer to the same stable option IDs. */
  gold: Readonly<Record<string, number>>;
  predicted: Readonly<Record<string, number>>;
}

/** Counts gold-comparable option pairs; ties in the prediction are errors, not wins. */
export function evaluateRankingHeldout(
  splits: readonly QualificationSplit[], samples: readonly RankingQualificationSample[],
): { sampleN: number; comparablePairs: number; concordance: number | null } {
  verifyQualificationSplits(splits);
  const testIds = splits.find(split => split.name === 'test')!.ids;
  if (samples.length !== testIds.length || new Set(samples.map(s => s.id)).size !== samples.length
    || samples.some(s => !testIds.includes(s.id))) throw new Error('held-out ranking membership mismatch');
  let pairs = 0;
  let correct = 0;
  for (const sample of samples) {
    const options = Object.keys(sample.gold).sort();
    if (options.length < 2 || options.length !== Object.keys(sample.predicted).length
      || options.some(option => !Object.hasOwn(sample.predicted, option))) {
      throw new Error('ranking option mismatch');
    }
    for (const option of options) {
      if (!Number.isFinite(sample.gold[option]) || !Number.isFinite(sample.predicted[option])) {
        throw new Error('invalid ranking score');
      }
    }
    for (let i = 0; i < options.length; i++) for (let j = i + 1; j < options.length; j++) {
      const goldDifference = sample.gold[options[i]!]! - sample.gold[options[j]!]!;
      if (goldDifference === 0) continue;
      pairs++;
      const predictedDifference = sample.predicted[options[i]!]! - sample.predicted[options[j]!]!;
      if (Math.sign(predictedDifference) === Math.sign(goldDifference)) correct++;
    }
  }
  return { sampleN: samples.length, comparablePairs: pairs, concordance: pairs ? correct / pairs : null };
}

export interface PairedQualificationSample {
  id: string;
  control: string;
  /** Same task after hostile-state perturbation or repeated invocation. */
  observed: string;
}

/** Measures categorical movement without claiming that either output is correct. */
export function measurePairedMovement(pairs: readonly PairedQualificationSample[]): {
  sampleN: number; changedN: number; changedRate: number; changedWilson95: readonly [number, number];
} {
  if (!pairs.length || new Set(pairs.map(pair => pair.id)).size !== pairs.length
    || pairs.some(pair => !pair.id.trim() || !pair.control.trim() || !pair.observed.trim())) {
    throw new Error('paired qualification requires unique nonempty IDs and outcomes');
  }
  const changedN = pairs.filter(pair => pair.control !== pair.observed).length;
  const [low, high] = wilson95(changedN, pairs.length);
  return { sampleN: pairs.length, changedN, changedRate: changedN / pairs.length, changedWilson95: [low, high] };
}

export class PairedDifferenceError extends Error {
  constructor(message: string) { super(message); this.name = 'PairedDifferenceError'; }
}

/**
 * Paired binary outcomes. `candidateOnly` pairs succeed for the candidate and fail for the baseline;
 * `baselineOnly` is the reverse. The discordant form `{ b, c, n }` uses b = candidateOnly and
 * c = baselineOnly; it carries no marginals, so only the Tango interval accepts it.
 */
export type PairedBinaryCounts =
  | { both: number; candidateOnly: number; baselineOnly: number; neither: number }
  | { b: number; c: number; n: number };

/** Two-sided interval for candidate minus baseline, in basis points (1 bps = 0.0001). */
export interface PairedDifferenceInterval {
  lowerBps: number;
  upperBps: number;
  estimateBps: number;
  n: number;
  method: 'newcombe-hybrid-score' | 'tango-score' | 'percentile-bootstrap';
}

/**
 * Acklam's rational approximation to the standard normal quantile (relative error < 1.15e-9).
 * Throws for p outside the open interval (0, 1).
 */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new PairedDifferenceError('normal quantile requires 0 < p < 1');
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const tail = (q: number): number => (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
    / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Two-sided level in bps; only 5001..9998 are accepted so neither tail is empty or trivial. */
function twoSidedZ(levelBps: number): number {
  if (!Number.isSafeInteger(levelBps) || levelBps <= 5000 || levelBps >= 9999) {
    throw new PairedDifferenceError('levelBps must be an integer strictly between 5000 and 9999');
  }
  return normalQuantile((10000 + levelBps) / 20000);
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function pairedCells(counts: PairedBinaryCounts): { e: number | null; f: number; g: number; h: number | null; n: number } {
  if (!counts || typeof counts !== 'object') throw new PairedDifferenceError('paired counts are required');
  const full = ['both', 'candidateOnly', 'baselineOnly', 'neither'].some(key => Object.hasOwn(counts, key));
  const discordant = ['b', 'c', 'n'].some(key => Object.hasOwn(counts, key));
  if (full === discordant) throw new PairedDifferenceError('provide either the full paired table or discordant b, c and n');
  if ('both' in counts) {
    const { both, candidateOnly, baselineOnly, neither } = counts;
    if (![both, candidateOnly, baselineOnly, neither].every(isCount)) {
      throw new PairedDifferenceError('paired cell counts must be non-negative safe integers');
    }
    const n = both + candidateOnly + baselineOnly + neither;
    if (n === 0 || !Number.isSafeInteger(n)) throw new PairedDifferenceError('paired table requires n > 0');
    return { e: both, f: candidateOnly, g: baselineOnly, h: neither, n };
  }
  const { b, c, n } = counts;
  if (![b, c, n].every(isCount) || n === 0 || b + c > n) {
    throw new PairedDifferenceError('discordant counts require non-negative integers with b + c <= n and n > 0');
  }
  return { e: null, f: b, g: c, h: null, n };
}

// Outward rounding: a reported bound is never tighter than the computed one.
const toBpsInterval = (low: number, high: number, estimate: number, n: number,
  method: PairedDifferenceInterval['method']): PairedDifferenceInterval => {
  if (![low, high, estimate].every(Number.isFinite) || low > estimate || estimate > high) {
    throw new PairedDifferenceError('paired interval computation was not finite and ordered');
  }
  return {
    lowerBps: Math.max(-10000, Math.floor(low * 10000)), upperBps: Math.min(10000, Math.ceil(high * 10000)),
    estimateBps: Math.round(estimate * 10000), n, method,
  };
};

/**
 * Two-sided score interval for p_candidate - p_baseline from paired binary outcomes.
 * `newcombe-10` (default): Newcombe (1998) method 10, square-and-add of continuity-free Wilson
 * intervals for both marginals with phi numerator replaced by max(eh - fg - n/2, 0) when eh > fg.
 * `tango`: Tango (1998) asymptotic score interval, inverted by bisection; needs only b, c and n.
 */
export function pairedBinaryDifferenceInterval(input: {
  counts: PairedBinaryCounts; levelBps: number; method?: 'newcombe-10' | 'tango';
}): PairedDifferenceInterval {
  const z = twoSidedZ(input?.levelBps);
  const { e, f, g, h, n } = pairedCells(input.counts);
  const estimate = (f - g) / n;
  const method = input.method ?? 'newcombe-10';
  if (method === 'tango') {
    const [low, high] = tangoInterval(f, g, n, z);
    return toBpsInterval(low, high, estimate, n, 'tango-score');
  }
  if (method !== 'newcombe-10') throw new PairedDifferenceError('unknown paired interval method');
  if (e === null || h === null) throw new PairedDifferenceError('newcombe method 10 requires the full paired table');
  const p1 = (e + f) / n;
  const p2 = (e + g) / n;
  const [l1, u1] = wilsonScore(e + f, n, z);
  const [l2, u2] = wilsonScore(e + g, n, z);
  const denominator = Math.sqrt((e + f) * (g + h) * (e + g) * (f + h));
  const cross = e * h - f * g;
  const phi = denominator === 0 ? 0 : (cross > 0 ? Math.max(cross - n / 2, 0) : cross) / denominator;
  const delta = Math.sqrt(Math.max(0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2));
  const epsilon = Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2));
  return toBpsInterval(Math.max(-1, estimate - delta), Math.min(1, estimate + epsilon), estimate, n, 'newcombe-hybrid-score');
}

function tangoInterval(b: number, c: number, n: number, z: number): readonly [number, number] {
  // Tango's statistic decreases in delta; the restricted MLE of the baseline-only cell is closed form.
  const statistic = (delta: number): number => {
    const B = -b - c + (2 * n - b + c) * delta;
    const q21 = (Math.sqrt(Math.max(0, B * B + 8 * n * c * delta * (1 - delta))) - B) / (4 * n);
    const numerator = b - c - n * delta;
    const variance = n * (2 * q21 + delta * (1 - delta));
    if (numerator === 0) return 0;
    return variance > 0 ? numerator / Math.sqrt(variance) : numerator * Infinity;
  };
  const estimate = (b - c) / n;
  // Each search keeps `outer` outside the acceptance region and returns it, so rounding widens.
  const search = (outer: number, inner: number, rejects: (t: number) => boolean): number => {
    for (let i = 0; i < 200; i++) {
      const mid = (outer + inner) / 2;
      if (mid === outer || mid === inner) break;
      if (rejects(statistic(mid))) outer = mid; else inner = mid;
    }
    return outer;
  };
  return [
    estimate === -1 ? -1 : search(-1, estimate, t => t > z),
    estimate === 1 ? 1 : search(1, estimate, t => t < -z),
  ];
}

/** Deterministic 32-bit mulberry32 stream. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Unbiased index in [0, n): reject draws in the incomplete top block of the 2^32 range. */
function uniformIndex(next: () => number, n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const draw = next();
    if (draw < limit) return draw % n;
  }
}

/**
 * Seeded percentile bootstrap for the mean of bounded per-pair differences (candidate minus
 * baseline) on the proportion scale, so 1.0 = 10000 bps. Bounds must lie within [-1, 1].
 * Order statistics are chosen outward and each tail must hold at least 5 resamples.
 */
export function pairedMeanDifferenceBootstrap(input: {
  differences: readonly number[]; levelBps: number; seed: number; resamples: number;
  bounds: readonly [number, number];
}): PairedDifferenceInterval {
  twoSidedZ(input?.levelBps);
  const { differences, levelBps, seed, resamples, bounds } = input;
  if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(Number.isFinite)
    || bounds[0] < -1 || bounds[1] > 1 || bounds[0] >= bounds[1]) {
    throw new PairedDifferenceError('bounds must be finite with -1 <= min < max <= 1');
  }
  if (!Array.isArray(differences) || differences.length < 2) {
    throw new PairedDifferenceError('bootstrap requires at least two paired differences');
  }
  if (differences.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < bounds[0] || value > bounds[1])) {
    throw new PairedDifferenceError('paired differences must be finite and within bounds');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new PairedDifferenceError('seed must be an unsigned 32-bit integer');
  }
  const tail = Number.isSafeInteger(resamples) ? Math.floor(resamples * (10000 - levelBps) / 20000) : 0;
  if (!Number.isSafeInteger(resamples) || resamples > 1_000_000 || tail < 5) {
    throw new PairedDifferenceError('resamples must be an integer <= 1000000 leaving at least 5 per tail');
  }
  const n = differences.length;
  const next = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += differences[uniformIndex(next, n)]!;
    means[r] = sum / n;
  }
  means.sort();
  const estimate = differences.reduce((sum, value) => sum + value, 0) / n;
  return toBpsInterval(Math.min(means[tail - 1]!, estimate), Math.max(means[resamples - tail]!, estimate), estimate, n,
    'percentile-bootstrap');
}

/**
 * One-sided non-inferiority read of a two-sided interval. `marginBps` is a non-positive integer:
 * -250 lets the candidate be at most 2.5 points worse than the baseline. Non-inferior only when
 * lowerBps >= marginBps; malformed intervals are 'insufficient', never a pass.
 */
export function pairedNonInferiority(input: { interval: PairedDifferenceInterval; marginBps: number }): {
  decision: 'non-inferior' | 'not-non-inferior' | 'insufficient'; reason: string;
} {
  const marginBps = input?.marginBps;
  if (!Number.isSafeInteger(marginBps) || marginBps > 0 || marginBps < -10000) {
    throw new PairedDifferenceError('marginBps must be an integer in [-10000, 0]');
  }
  const interval = input.interval;
  const valid = !!interval && typeof interval === 'object'
    && [interval.lowerBps, interval.upperBps, interval.estimateBps].every(value => Number.isSafeInteger(value)
      && value >= -10000 && value <= 10000)
    && Number.isSafeInteger(interval.n) && interval.n > 0
    && interval.lowerBps <= interval.estimateBps && interval.estimateBps <= interval.upperBps
    && ['newcombe-hybrid-score', 'tango-score', 'percentile-bootstrap'].includes(interval.method);
  if (!valid) return { decision: 'insufficient', reason: 'invalid-interval' };
  return interval.lowerBps >= marginBps
    ? { decision: 'non-inferior', reason: 'lower-bound-at-or-above-margin' }
    : { decision: 'not-non-inferior', reason: 'lower-bound-below-margin' };
}

/**
 * Two-sided Wilson score interval for a binomial proportion at `levelBps` (5001..9998), so each bound
 * is a one-sided (10000 - levelBps) / 20000 bound. Counts must satisfy 0 <= events <= n and n > 0.
 */
export function wilsonScoreInterval(input: { events: number; n: number; levelBps: number }): readonly [number, number] {
  const z = twoSidedZ(input?.levelBps);
  const { events, n } = input;
  if (!isCount(events) || !isCount(n) || n === 0 || events > n) {
    throw new PairedDifferenceError('wilson interval requires integer counts with 0 <= events <= n and n > 0');
  }
  return wilsonScore(events, n, z);
}

function wilson95(errors: number, n: number): readonly [number, number] {
  // 95% normal quantile; finite-sample Wilson interval for binomial events.
  return wilsonScore(errors, n, 1.959963984540054);
}

function wilsonScore(errors: number, n: number, z: number): readonly [number, number] {
  const rate = errors / n;
  const denominator = 1 + z * z / n;
  const center = (rate + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function scoreBinary(samples: readonly BinaryQualificationSample[]): BinarySliceMetrics {
  const n = samples.length;
  const errors = samples.filter(s => (s.probability >= 0.5 ? 1 : 0) !== s.label).length;
  const accepted = samples.filter(s => s.accepted);
  const acceptedErrors = accepted.filter(s => (s.probability >= 0.5 ? 1 : 0) !== s.label).length;
  const rate = errors / n;
  const sorted = samples.map(s => s.latencyMs).sort((a, b) => a - b);
  const quantile = (q: number): number => sorted[Math.ceil(q * n) - 1]!;
  // Deciles are a reporting convention, not a calibrated decision threshold.
  const buckets = Array.from({ length: 10 }, () => [] as BinaryQualificationSample[]);
  for (const sample of samples) buckets[Math.min(9, Math.floor(sample.probability * 10))]!.push(sample);
  const sumKnown = (key: 'inputTokens' | 'outputTokens' | 'costUsd'): number | null =>
    samples.some(s => s[key] === null) ? null : samples.reduce((sum, s) => sum + (s[key] ?? 0), 0);
  return {
    sampleN: n, errorRate: rate,
    brier: samples.reduce((sum, s) => sum + (s.probability - s.label) ** 2, 0) / n,
    logLoss: samples.reduce((sum, s) => sum - (s.label ? Math.log(Math.max(s.probability, Number.EPSILON))
      : Math.log(Math.max(1 - s.probability, Number.EPSILON))), 0) / n,
    expectedCalibrationError: buckets.reduce((sum, bucket) => bucket.length ? sum + bucket.length / n
      * Math.abs(bucket.reduce((a, s) => a + s.probability, 0) / bucket.length
        - bucket.reduce((a, s) => a + s.label, 0) / bucket.length) : sum, 0),
    coverage: accepted.length / n, selectiveRisk: accepted.length ? acceptedErrors / accepted.length : null,
    reviewRate: (n - accepted.length) / n,
    errorWilson95: wilson95(errors, n),
    latencyMs: { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) },
    inputTokens: sumKnown('inputTokens'), outputTokens: sumKnown('outputTokens'), costUsd: sumKnown('costUsd'),
    calls: samples.reduce((sum, s) => sum + s.calls, 0),
    retries: samples.reduce((sum, s) => sum + s.retries, 0),
    fallbacks: samples.reduce((sum, s) => sum + s.fallbacks, 0),
  };
}
