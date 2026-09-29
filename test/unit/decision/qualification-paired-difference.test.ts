import { describe, expect, it } from 'vitest';
import { normalQuantile, pairedBinaryDifferenceInterval, pairedMeanDifferenceBootstrap, pairedNonInferiority, PairedDifferenceError, wilsonScoreInterval, type PairedDifferenceInterval } from '../../../src/decision/qualification/quality.js';

const table = (both: number, candidateOnly: number, baselineOnly: number, neither: number) =>
  ({ both, candidateOnly, baselineOnly, neither });

// Published limits are rounded to 4 dp; bps limits are rounded outward, so each may sit 1 bps wider.
const expectOutward = (interval: PairedDifferenceInterval, lower: number, upper: number) => {
  expect(Math.round(lower * 10000) - interval.lowerBps).toBeGreaterThanOrEqual(0);
  expect(Math.round(lower * 10000) - interval.lowerBps).toBeLessThanOrEqual(1);
  expect(interval.upperBps - Math.round(upper * 10000)).toBeGreaterThanOrEqual(0);
  expect(interval.upperBps - Math.round(upper * 10000)).toBeLessThanOrEqual(1);
};

describe('normal quantile', () => {
  it('matches known standard normal quantiles within Acklam precision', () => {
    for (const [p, z] of [[0.5, 0], [0.9, 1.2815515655446004], [0.95, 1.6448536269514722],
      [0.975, 1.959963984540054], [0.995, 2.5758293035489004], [0.9999, 3.719016485455709],
      [0.01, -2.3263478740408408], [0.001, -3.090232306167813]] as const) {
      expect(Math.abs(normalQuantile(p) - z)).toBeLessThan(5e-9);
    }
    for (const p of [0, 1, Number.NaN, -0.1, Infinity]) expect(() => normalQuantile(p)).toThrow(PairedDifferenceError);
  });
});

describe('paired binary difference interval', () => {
  it('reproduces Newcombe (1998) Table III method 10 limits (e, f, g, h; theta = (f - g) / n)', () => {
    const rows: Array<[number, number, number, number, number, number]> = [
      [36, 12, 2, 0, 0.0569, 0.3404], [20, 12, 2, 16, 0.0562, 0.3292], [18, 12, 2, 18, 0.0562, 0.3290],
      [36, 14, 0, 0, 0.1528, 0.4167], [35, 14, 0, 1, 0.1461, 0.4175], [18, 14, 0, 18, 0.1441, 0.3963],
      [2, 97, 1, 0, 0.8721, 0.9854], [1, 97, 1, 1, 0.8736, 0.9850], [0, 29, 1, 0, 0.6666, 0.9882],
      [2, 98, 0, 0, 0.9178, 0.9945], [1, 98, 0, 1, 0.9171, 0.9916], [0, 30, 0, 0, 0.8395, 1],
      [54, 0, 0, 0, -0.0664, 0.0664], [53, 0, 0, 1, -0.0729, 0.0729], [30, 0, 0, 24, -0.0358, 0.0358],
      [29, 0, 0, 25, -0.0354, 0.0354], [28, 0, 0, 26, -0.0352, 0.0352], [27, 0, 0, 27, -0.0351, 0.0351],
    ];
    for (const [e, f, g, h, lower, upper] of rows) {
      const interval = pairedBinaryDifferenceInterval({ counts: table(e, f, g, h), levelBps: 9500 });
      expect(interval.method).toBe('newcombe-hybrid-score');
      expect(interval.n).toBe(e + f + g + h);
      expect(interval.estimateBps).toBe(Math.round((f - g) / (e + f + g + h) * 10000));
      expectOutward(interval, lower, upper);
    }
  });

  it('matches independent square-and-add and Tango implementations', () => {
    // contingencytables (Fagerland et al.) test-ch8.R: cavo_2012 = rbind(c(59, 6), c(16, 80)).
    expectOutward(pairedBinaryDifferenceInterval({ counts: table(59, 6, 16, 80), levelBps: 9500 }), -0.1186, -0.0046);
    expectOutward(pairedBinaryDifferenceInterval({ counts: table(1, 0, 0, 1), levelBps: 9500 }), -0.5734, 0.5734);
    expectOutward(pairedBinaryDifferenceInterval({ counts: table(59, 6, 16, 80), levelBps: 9500, method: 'tango' }),
      -0.1240, -0.0054);
    const allCandidate = pairedBinaryDifferenceInterval({ counts: { b: 3, c: 0, n: 3 }, levelBps: 9500, method: 'tango' });
    expectOutward(allCandidate, -0.1230, 1);
    expect(allCandidate.method).toBe('tango-score');
    // Chang et al., continuity-corrected paired score CI (PMC10763857) Table 3, published to 3 dp: MOVER 0.133-0.318, Tango 0.139-0.321.
    const mover = pairedBinaryDifferenceInterval({ counts: table(7, 25, 2, 68), levelBps: 9500 });
    const tango = pairedBinaryDifferenceInterval({ counts: table(7, 25, 2, 68), levelBps: 9500, method: 'tango' });
    // A 3 dp limit spans +/-5 bps; outward rounding adds at most 1 bps.
    for (const [interval, lower, upper] of [[mover, 1330, 3180], [tango, 1390, 3210]] as const) {
      expect(Math.abs(interval.lowerBps - lower)).toBeLessThanOrEqual(6);
      expect(Math.abs(interval.upperBps - upper)).toBeLessThanOrEqual(6);
    }
  });

  it('agrees with the uncorrected McNemar test at every 95% Tango boundary', () => {
    for (let b = 0; b <= 12; b++) for (let c = 0; c <= 12; c++) {
      if (b + c === 0) continue;
      const interval = pairedBinaryDifferenceInterval({ counts: { b, c, n: 30 }, levelBps: 9500, method: 'tango' });
      const mcnemar = (b - c) ** 2 / (b + c) > 1.959963984540054 ** 2;
      const excludesZero = interval.lowerBps > 0 || interval.upperBps < 0;
      if (Math.abs((b - c) ** 2 / (b + c) - 1.959963984540054 ** 2) > 1e-3) expect(excludesZero).toBe(mcnemar);
    }
  });

  it('treats the level as a parameter and widens monotonically with it', () => {
    const widths = [6000, 8000, 9000, 9500, 9900, 9998].map(levelBps => {
      const interval = pairedBinaryDifferenceInterval({ counts: table(40, 9, 4, 47), levelBps });
      return interval.upperBps - interval.lowerBps;
    });
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });

  it('fails closed on NaN, out-of-range, inconsistent and empty inputs', () => {
    const good = table(10, 2, 1, 7);
    const bad: unknown[] = [
      { counts: good, levelBps: Number.NaN }, { counts: good, levelBps: 5000 }, { counts: good, levelBps: 9999 },
      { counts: good, levelBps: 95 }, { counts: good, levelBps: 9500.5 }, { counts: good, levelBps: Infinity },
      { counts: table(0, 0, 0, 0), levelBps: 9500 }, { counts: table(Number.NaN, 1, 1, 1), levelBps: 9500 },
      { counts: table(1, -1, 1, 1), levelBps: 9500 }, { counts: table(1, 1.5, 1, 1), levelBps: 9500 },
      { counts: table(1, Infinity, 1, 1), levelBps: 9500 }, { counts: { both: 1, candidateOnly: 1 }, levelBps: 9500 },
      { counts: { b: 3, c: 3, n: 5 }, levelBps: 9500, method: 'tango' },
      { counts: { b: 0, c: 0, n: 0 }, levelBps: 9500, method: 'tango' },
      { counts: { b: Number.NaN, c: 0, n: 5 }, levelBps: 9500, method: 'tango' },
      { counts: { ...good, b: 2, c: 1, n: 20 }, levelBps: 9500 },
      { counts: { b: 2, c: 1, n: 20 }, levelBps: 9500 },
      { counts: good, levelBps: 9500, method: 'wald' }, { levelBps: 9500 }, undefined,
    ];
    for (const input of bad) {
      expect(() => pairedBinaryDifferenceInterval(input as never)).toThrow(PairedDifferenceError);
    }
    expect(pairedBinaryDifferenceInterval({ counts: good, levelBps: 5001 }).n).toBe(20);
    expect(pairedBinaryDifferenceInterval({ counts: good, levelBps: 9998 }).n).toBe(20);
  });
});

describe('paired non-inferiority', () => {
  it('rejects a regressed candidate at a -250 bps margin', () => {
    // 5 candidate-only vs 40 baseline-only discordant pairs out of 200: about 17.5 points worse.
    for (const method of ['newcombe-10', 'tango'] as const) {
      const interval = pairedBinaryDifferenceInterval({ counts: table(150, 5, 40, 5), levelBps: 9500, method });
      expect(interval.upperBps).toBeLessThan(0);
      expect(pairedNonInferiority({ interval, marginBps: -250 })).toEqual({
        decision: 'not-non-inferior', reason: 'lower-bound-below-margin' });
    }
    const equal = pairedBinaryDifferenceInterval({ counts: table(900, 3, 3, 94), levelBps: 9500 });
    expect(pairedNonInferiority({ interval: equal, marginBps: -250 }).decision).toBe('non-inferior');
    expect(pairedNonInferiority({ interval: { ...equal, lowerBps: -250 }, marginBps: -250 }).decision).toBe('non-inferior');
    expect(pairedNonInferiority({ interval: { ...equal, lowerBps: -251 }, marginBps: -250 }).decision)
      .toBe('not-non-inferior');
  });

  it('never flips non-inferior to not-non-inferior as the margin grows more lenient', () => {
    for (const [e, f, g, h] of [[40, 5, 9, 46], [150, 5, 40, 5], [90, 1, 1, 8], [10, 0, 6, 4], [3, 7, 0, 1]] as const) {
      for (const method of ['newcombe-10', 'tango'] as const) {
        const interval = pairedBinaryDifferenceInterval({ counts: table(e, f, g, h), levelBps: 9500, method });
        let seenNonInferior = false;
        for (let marginBps = 0; marginBps >= -10000; marginBps -= 25) {
          const { decision } = pairedNonInferiority({ interval, marginBps });
          if (seenNonInferior) expect(decision).toBe('non-inferior');
          seenNonInferior ||= decision === 'non-inferior';
        }
        expect(seenNonInferior).toBe(true);
      }
    }
  });

  it('validates the margin sign and returns insufficient for malformed intervals', () => {
    const interval = pairedBinaryDifferenceInterval({ counts: table(40, 5, 3, 52), levelBps: 9500 });
    for (const marginBps of [250, 1, Number.NaN, -10001, -2.5, Infinity, -Infinity]) {
      expect(() => pairedNonInferiority({ interval, marginBps })).toThrow(PairedDifferenceError);
    }
    const malformed: unknown[] = [
      { ...interval, lowerBps: Number.NaN }, { ...interval, upperBps: Number.NaN }, { ...interval, estimateBps: Number.NaN },
      { ...interval, lowerBps: -Infinity }, { ...interval, lowerBps: -20000 }, { ...interval, n: 0 },
      { ...interval, lowerBps: interval.estimateBps + 1 }, { ...interval, lowerBps: 1.5 },
      { ...interval, method: 'wald' }, null,
    ];
    for (const candidate of malformed) {
      expect(pairedNonInferiority({ interval: candidate as PairedDifferenceInterval, marginBps: -10000 }))
        .toEqual({ decision: 'insufficient', reason: 'invalid-interval' });
    }
  });
});

describe('paired mean difference bootstrap', () => {
  const differences = [0.1, -0.05, 0, 0.2, 0.15, -0.1, 0.05, 0.3, 0, 0.1, -0.2, 0.05];

  it('is deterministic for a seed and changes with the seed', () => {
    const run = (seed: number) => pairedMeanDifferenceBootstrap({
      differences, levelBps: 9500, seed, resamples: 2000, bounds: [-1, 1] });
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
    const interval = run(7);
    expect(interval.method).toBe('percentile-bootstrap');
    expect(interval.n).toBe(differences.length);
    expect(interval.estimateBps).toBe(500);
    expect(interval.lowerBps).toBeLessThanOrEqual(interval.estimateBps);
    expect(interval.upperBps).toBeGreaterThanOrEqual(interval.estimateBps);
  });

  it('approximately attains nominal coverage on a seeded simulation', () => {
    // Paired differences take -1, 0 or 1 with probabilities 0.2, 0.5, 0.3: true mean 0.1 (1000 bps).
    let state = 12345;
    const uniform = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    let covered = 0;
    const trials = 200;
    for (let trial = 0; trial < trials; trial++) {
      const sample = Array.from({ length: 40 }, () => { const u = uniform(); return u < 0.2 ? -1 : u < 0.7 ? 0 : 1; });
      const interval = pairedMeanDifferenceBootstrap({
        differences: sample, levelBps: 9000, seed: trial, resamples: 1000, bounds: [-1, 1] });
      if (interval.lowerBps <= 1000 && interval.upperBps >= 1000) covered++;
    }
    expect(covered / trials).toBeGreaterThan(0.82);
    expect(covered / trials).toBeLessThan(0.97);
  });

  it('fails closed on NaN, out-of-bounds, tiny samples and inadequate resampling', () => {
    const base = { differences, levelBps: 9500, seed: 1, resamples: 2000, bounds: [-1, 1] as const };
    const bad: unknown[] = [
      { ...base, differences: [] }, { ...base, differences: [0.1] }, { ...base, differences: [0.1, Number.NaN] },
      { ...base, differences: [0.1, Infinity] }, { ...base, differences: [0.1, 0.6], bounds: [-0.5, 0.5] },
      { ...base, bounds: [1, -1] }, { ...base, bounds: [-2, 2] }, { ...base, bounds: [Number.NaN, 1] },
      { ...base, levelBps: Number.NaN }, { ...base, levelBps: 10000 }, { ...base, seed: -1 },
      { ...base, seed: 2 ** 32 }, { ...base, seed: 1.5 }, { ...base, resamples: 100 },
      { ...base, resamples: Number.NaN }, { ...base, resamples: 2_000_000 },
      { ...base, levelBps: 9990, resamples: 5000 }, { ...base, differences: ['0.1', 0.2] },
    ];
    for (const input of bad) {
      expect(() => pairedMeanDifferenceBootstrap(input as never)).toThrow(PairedDifferenceError);
    }
  });
});

describe('wilson score interval at a preregistered level', () => {
  it('matches the closed form for zero events and widens with the level', () => {
    const z = normalQuantile(0.975);
    const [lower, upper] = wilsonScoreInterval({ events: 0, n: 20, levelBps: 9500 });
    expect(lower).toBe(0);
    expect(upper).toBeCloseTo(z * z / (20 + z * z), 10);
    const [lower90, upper90] = wilsonScoreInterval({ events: 10, n: 50, levelBps: 9000 });
    const [lower99, upper99] = wilsonScoreInterval({ events: 10, n: 50, levelBps: 9900 });
    expect(lower99).toBeLessThan(lower90);
    expect(upper99).toBeGreaterThan(upper90);
    expect(lower90).toBeLessThan(0.2);
    expect(upper90).toBeGreaterThan(0.2);
    for (const bad of [{ events: 3, n: 2, levelBps: 9500 }, { events: 0, n: 0, levelBps: 9500 }, { events: 1.5, n: 4, levelBps: 9500 },
      { events: 1, n: 4, levelBps: 10000 }, { events: -1, n: 4, levelBps: 9500 }]) {
      expect(() => wilsonScoreInterval(bad)).toThrow(PairedDifferenceError);
    }
  });
});
