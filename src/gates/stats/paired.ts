import { wilsonScore } from './binomial.js';
import { PairedDifferenceError } from './error.js';
import { isCount, twoSidedZ } from './normal.js';

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
export const toBpsInterval = (low: number, high: number, estimate: number, n: number,
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
