import { PairedDifferenceError } from './error.js';
import { isCount, twoSidedZ } from './normal.js';

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

export function wilson95(errors: number, n: number): readonly [number, number] {
  // 95% normal quantile; finite-sample Wilson interval for binomial events.
  return wilsonScore(errors, n, 1.959963984540054);
}

export function wilsonScore(errors: number, n: number, z: number): readonly [number, number] {
  const rate = errors / n;
  const denominator = 1 + z * z / n;
  const center = (rate + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
