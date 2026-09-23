/**
 * @source @tools/quality/calibrate.mjs
 */
import { describe, expect, it } from 'vitest';
import { computeBands } from '../../../tools/quality/calibrate.mjs';

describe('computeBands', () => {
  it('computes LOC-weighted percentiles', () => {
    // NLOC sorted 15,15,20,20,30 → cumulative 15,30,50,70,100: p70 reached at 20, p80/p90 at 30.
    // CCN sorted 1,2,3,4,8 with weights 15,15,20,30,20 → cumulative 15,30,50,80,100.
    const functions = [
      { nloc: 15, ccn: 1 },
      { nloc: 15, ccn: 2 },
      { nloc: 20, ccn: 3 },
      { nloc: 20, ccn: 8 },
      { nloc: 30, ccn: 4 },
    ];
    // File LOC 10..100 (total 550): 70% = 385 → 90, 80% = 440 → 90, 90% = 495 → 100.
    const fileLocs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const result = computeBands(functions, fileLocs);
    expect(result.bands).toEqual({
      function_nloc: { p70: 20, p80: 30, p90: 30 },
      function_ccn: { p70: 4, p80: 4, p90: 8 },
      file_loc: { p70: 90, p80: 90, p90: 100 },
    });
    expect(result.functions).toBe(5);
    expect(result.files).toBe(10);
    expect(result.provisional).toBe(true);
  });

  it('marks an empty distribution provisional with zero bands', () => {
    const result = computeBands([], []);
    expect(result.provisional).toBe(true);
    expect(result.functions).toBe(0);
    expect(result.bands.function_ccn).toEqual({ p70: 0, p80: 0, p90: 0 });
  });

  it('is not provisional at 200 functions', () => {
    const functions = Array.from({ length: 200 }, (_, i) => ({ nloc: 1 + (i % 10), ccn: 1 }));
    expect(computeBands(functions, [100]).provisional).toBe(false);
  });
});
