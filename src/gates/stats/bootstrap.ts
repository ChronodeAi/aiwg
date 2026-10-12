import { PairedDifferenceError } from './error.js';
import { twoSidedZ } from './normal.js';
import { toBpsInterval, type PairedDifferenceInterval } from './paired.js';

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
