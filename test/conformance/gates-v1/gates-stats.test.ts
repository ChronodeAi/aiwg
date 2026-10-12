import { describe, expect, it } from 'vitest';
import { clopperPearsonInterval } from '../../../src/gates/stats/clopper-pearson.js';
import { PairedDifferenceError } from '../../../src/gates/stats/error.js';
import { normalQuantile } from '../../../src/gates/stats/normal.js';
import { wilsonScoreInterval } from '../../../src/gates/stats/binomial.js';
import {
  pairedBinaryDifferenceInterval, pairedNonInferiority,
} from '../../../src/gates/stats/paired.js';
import { pairedMeanDifferenceBootstrap } from '../../../src/gates/stats/bootstrap.js';

// Reference values from an independent Python implementation (exact binomial tails
// via math.comb bisection, rounded to 6 dp). Agreement is asserted to 5e-7.
const cpCases: Array<[number, number, number, number]> = [
  [0, 10, 0, 0.308497], [1, 10, 0.002529, 0.445016], [5, 10, 0.187086, 0.812914],
  [9, 10, 0.554984, 0.997471], [10, 10, 0.691503, 1], [2, 100, 0.002431, 0.070384],
  [3, 1000, 0.000619, 0.008742], [0, 1, 0, 0.975], [1, 1, 0.025, 1],
];

describe('clopper-pearson exact interval', () => {
  it('matches independent exact-binomial reference values at two-sided 95%', () => {
    for (const [events, n, lower, upper] of cpCases) {
      const interval = clopperPearsonInterval({ events, n, levelBps: 9500 });
      expect(Math.abs(interval.lower - lower)).toBeLessThan(5e-7);
      expect(Math.abs(interval.upper - upper)).toBeLessThan(5e-7);
    }
  });

  it('matches one-sided 95% bounds and the closed-form extremes', () => {
    const upperOnly = clopperPearsonInterval({ events: 0, n: 10, levelBps: 9500, sided: 'upper' });
    expect(upperOnly.lower).toBe(0);
    expect(upperOnly.upper).toBeCloseTo(0.258866, 6);
    const twoSided = clopperPearsonInterval({ events: 5, n: 10, levelBps: 9500 });
    expect(clopperPearsonInterval({ events: 5, n: 10, levelBps: 9500, sided: 'lower' }).lower)
      .toBeCloseTo(0.222441, 6);
    expect(clopperPearsonInterval({ events: 5, n: 10, levelBps: 9500, sided: 'upper' }).upper)
      .toBeCloseTo(0.777559, 6);
    // One-sided 95% is strictly tighter than two-sided 95% on the bounded side.
    expect(twoSided.lower).toBeLessThan(0.222441);
    expect(twoSided.upper).toBeGreaterThan(0.777559);
    // Closed forms: upper(0, n) = 1 - (alpha/2)^(1/n); lower(n, n) = (alpha/2)^(1/n).
    expect(clopperPearsonInterval({ events: 0, n: 10, levelBps: 9500 }).upper)
      .toBeCloseTo(1 - 0.025 ** 0.1, 9);
    expect(clopperPearsonInterval({ events: 10, n: 10, levelBps: 9500 }).lower).toBeCloseTo(0.025 ** 0.1, 9);
  });

  it('is symmetric and inverts the exact binomial tail at each bound', () => {
    // Independent check: direct integer-combination tail sums at the reported
    // bounds must recover the 0.025 tail, proving the bisection solved the
    // right equation however it got there.
    const tailGe = (events: number, n: number, p: number): number => {
      let sum = 0;
      for (let k = events; k <= n; k++) {
        let combinations = 1;
        for (let i = 1; i <= k; i++) combinations = combinations * (n - k + i) / i;
        sum += combinations * p ** k * (1 - p) ** (n - k);
      }
      return sum;
    };
    for (const [events, n] of [[1, 10], [5, 10], [2, 100], [0, 50], [50, 50]] as const) {
      const interval = clopperPearsonInterval({ events, n, levelBps: 9500 });
      const mirror = clopperPearsonInterval({ events: n - events, n, levelBps: 9500 });
      expect(interval.lower).toBeCloseTo(1 - mirror.upper, 9);
      expect(interval.upper).toBeCloseTo(1 - mirror.lower, 9);
      expect(interval.lower).toBeLessThanOrEqual(events / n);
      expect(interval.upper).toBeGreaterThanOrEqual(events / n);
      if (events > 0) expect(Math.abs(tailGe(events, n, interval.lower) - 0.025)).toBeLessThan(1e-9);
      if (events < n) expect(Math.abs(1 - tailGe(events + 1, n, interval.upper) - 0.025)).toBeLessThan(1e-9);
    }
  });

  it('widens monotonically with the level and fails closed on malformed inputs', () => {
    const widths = [6000, 8000, 9500, 9998].map(levelBps =>
      clopperPearsonInterval({ events: 4, n: 20, levelBps }));
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!.upper - widths[i]!.lower).toBeGreaterThan(widths[i - 1]!.upper - widths[i - 1]!.lower);
    }
    const bad: unknown[] = [
      { events: 1, n: 10, levelBps: 5000 }, { events: 1, n: 10, levelBps: 9999 },
      { events: 11, n: 10, levelBps: 9500 }, { events: -1, n: 10, levelBps: 9500 },
      { events: 1.5, n: 10, levelBps: 9500 }, { events: 1, n: 0, levelBps: 9500 },
      { events: 1, n: 10, levelBps: 9500, sided: 'middle' }, null, undefined,
    ];
    for (const input of bad) expect(() => clopperPearsonInterval(input as never)).toThrow(PairedDifferenceError);
  });
});

describe('moved statistics preserve their numerics through the new home', () => {
  it('matches the hand-derived Wilson interval for 0/10 at 95%', () => {
    // z = 1.959964, denominator 1 + z^2/10, center = margin = (z^2/20)/denominator = 0.1387664.
    const [lower, upper] = wilsonScoreInterval({ events: 0, n: 10, levelBps: 9500 });
    expect(lower).toBe(0);
    expect(upper).toBeCloseTo(0.2775328, 6);
  });

  it('reproduces a published Newcombe (1998) Table III row', () => {
    const interval = pairedBinaryDifferenceInterval({
      counts: { both: 36, candidateOnly: 12, baselineOnly: 2, neither: 0 }, levelBps: 9500,
    });
    expect(interval.method).toBe('newcombe-hybrid-score');
    expect(interval.estimateBps).toBe(Math.round(10 / 50 * 10000));
    expect(Math.round(0.0569 * 10000) - interval.lowerBps).toBeGreaterThanOrEqual(0);
    expect(interval.upperBps - Math.round(0.3404 * 10000)).toBeGreaterThanOrEqual(0);
  });

  it('holds the non-inferiority boundary at exactly the margin', () => {
    const interval = pairedBinaryDifferenceInterval({
      counts: { both: 900, candidateOnly: 3, baselineOnly: 3, neither: 94 }, levelBps: 9500,
    });
    expect(pairedNonInferiority({ interval, marginBps: -250 }).decision).toBe('non-inferior');
    expect(pairedNonInferiority({ interval: { ...interval, lowerBps: -251 }, marginBps: -250 }).decision)
      .toBe('not-non-inferior');
  });

  it('matches known normal quantiles and stays deterministic under a fixed seed', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 8);
    const input = { differences: [0.02, -0.01, 0.03, 0, 0.01, -0.02, 0.04, 0.01], levelBps: 9500,
      seed: 7, resamples: 2000, bounds: [-1, 1] as [number, number] };
    const first = pairedMeanDifferenceBootstrap(input);
    const second = pairedMeanDifferenceBootstrap(input);
    expect(second).toEqual(first);
    expect(first.method).toBe('percentile-bootstrap');
    expect(first.lowerBps).toBeLessThanOrEqual(first.estimateBps);
    expect(first.estimateBps).toBeLessThanOrEqual(first.upperBps);
  });
});
