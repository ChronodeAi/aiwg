import { PairedDifferenceError } from './error.js';
import { isCount } from './normal.js';

/**
 * Exact binomial tail P(X >= events) at proportion p, summed in log space with
 * precomputed log factorials: linear in n and free of underflow for large n.
 */
function upperTail(events: number, n: number, p: number): number {
  if (p <= 0) return events <= 0 ? 1 : 0;
  if (p >= 1) return events <= n ? 1 : 0;
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  const logFact: number[] = [0];
  for (let i = 1; i <= n; i++) logFact.push((logFact[i - 1] as number) + Math.log(i));
  let peak = -Infinity;
  const terms: number[] = [];
  for (let k = events; k <= n; k++) {
    const term = (logFact[n] as number) - (logFact[k] as number) - (logFact[n - k] as number)
      + k * logP + (n - k) * logQ;
    terms.push(term);
    if (term > peak) peak = term;
  }
  let sum = 0;
  for (const term of terms) sum += Math.exp(term - peak);
  return Math.min(1, sum * Math.exp(peak));
}

/**
 * Exact Clopper-Pearson interval for a binomial proportion. `levelBps` (5001..9998) is the
 * two-sided level; each tail holds (10000 - levelBps) / 20000. `sided` selects a one-sided
 * bound at the same level instead: 'lower' returns [bound, 1] and 'upper' returns [0, bound].
 * Counts must satisfy 0 <= events <= n and n > 0. Bounds are inverted by bisection on the
 * exact binomial tail, so the coverage is at least the nominal level by construction.
 */
export function clopperPearsonInterval(input: {
  events: number; n: number; levelBps: number; sided?: 'two-sided' | 'lower' | 'upper';
}): { lower: number; upper: number } {
  if (!input || typeof input !== 'object') throw new PairedDifferenceError('clopper-pearson interval input is required');
  const { events, n, levelBps, sided } = input as { events: unknown; n: unknown; levelBps: unknown; sided?: unknown };
  if (!isCount(events) || !isCount(n) || n === 0 || events > n) {
    throw new PairedDifferenceError('clopper-pearson interval requires integer counts with 0 <= events <= n and n > 0');
  }
  if (!Number.isSafeInteger(levelBps) || (levelBps as number) <= 5000 || (levelBps as number) >= 9999) {
    throw new PairedDifferenceError('levelBps must be an integer strictly between 5000 and 9999');
  }
  const side = sided ?? 'two-sided';
  if (side !== 'two-sided' && side !== 'lower' && side !== 'upper') {
    throw new PairedDifferenceError('clopper-pearson sided must be two-sided, lower or upper');
  }
  const level = levelBps as number;
  const tail = (side === 'two-sided' ? (10000 - level) / 20000 : (10000 - level) / 10000);
  // P(X >= events | p) rises from 0 at p=0 to 1 at p=1. Each loop keeps `below`
  // under the root and returns it, so the lower bound rounds outward (down).
  const solveTail = (target: number): number => {
    let below = 0;
    let above = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (below + above) / 2;
      if (mid === below || mid === above) break;
      if (upperTail(events, n, mid) > target) above = mid; else below = mid;
    }
    return below;
  };
  // P(X <= events | p) = 1 - P(X >= events + 1 | p) falls from 1 to 0. Each loop
  // keeps `above` over the root and returns it, so the upper bound rounds outward (up).
  const solveLowerTail = (target: number): number => {
    let below = 0;
    let above = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (below + above) / 2;
      if (mid === below || mid === above) break;
      if (1 - upperTail(events + 1, n, mid) > target) below = mid; else above = mid;
    }
    return above;
  };
  if (side === 'lower') return { lower: events === 0 ? 0 : solveTail(tail), upper: 1 };
  if (side === 'upper') return { lower: 0, upper: events === n ? 1 : solveLowerTail(tail) };
  return {
    lower: events === 0 ? 0 : solveTail(tail),
    upper: events === n ? 1 : solveLowerTail(tail),
  };
}
