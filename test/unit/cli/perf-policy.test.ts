import { describe, expect, it } from 'vitest';
import {
  median,
  parsePositiveInt,
  summarizePairedTimings,
} from '../../helpers/cli-perf-policy.js';

describe('CLI performance gate policy', () => {
  it('parses positive environment overrides and rejects invalid sample counts', () => {
    expect(parsePositiveInt('650', 500)).toBe(650);
    expect(parsePositiveInt(undefined, 500)).toBe(500);
    expect(parsePositiveInt('0', 500)).toBe(500);
    expect(parsePositiveInt('6', 7, { minimum: 3, odd: true })).toBe(7);
    expect(parsePositiveInt('9', 7, { minimum: 3, odd: true })).toBe(9);
  });

  it('calculates medians without mutating the samples', () => {
    const values = [9, 1, 5, 3];
    expect(median(values)).toBe(4);
    expect(values).toEqual([9, 1, 5, 3]);
  });

  it('subtracts a baseline paired around every command sample', () => {
    const summary = summarizePairedTimings([
      { baselineBeforeMs: 100, commandMs: 610, baselineAfterMs: 120 },
      { baselineBeforeMs: 200, commandMs: 650, baselineAfterMs: 220 },
      { baselineBeforeMs: 90, commandMs: 900, baselineAfterMs: 110 },
    ]);
    expect(summary.baselineMedianMs).toBe(110);
    expect(summary.commandMedianMs).toBe(650);
    expect(summary.overheadsMs).toEqual([500, 440, 800]);
    expect(summary.overheadMedianMs).toBe(500);
    expect(summary.overheadMinMs).toBe(440);
    expect(summary.overheadMaxMs).toBe(800);
  });

  it('keeps a hard failure boundary for sustained regressions', () => {
    const summary = summarizePairedTimings([
      { baselineBeforeMs: 100, commandMs: 880, baselineAfterMs: 100 },
      { baselineBeforeMs: 120, commandMs: 900, baselineAfterMs: 120 },
      { baselineBeforeMs: 90, commandMs: 860, baselineAfterMs: 90 },
    ]);
    expect(summary.overheadMedianMs).toBeGreaterThanOrEqual(750);
  });

  // #3047 follow-up security review: a statistic that asserts the *minimum*
  // paired overhead across samples is fooled by a single sample whose
  // baseline alone (not the command) was delayed by host contention -- that
  // delay cancels out of `max(0, command - baseline)` and reports 0ms
  // overhead for a sample that actually paid the full regression. Reproduces
  // the review's own numbers: 10 of 11 commands pay a genuine +500ms
  // regression; the 11th sample's `baselineBeforeMs` alone is delayed by
  // 1000ms, zeroing its own reported overhead. `overheadMedianMs` (what the
  // CLI perf gate asserts, test/integration/cli-perf.test.ts) is not fooled
  // by that one sample and still reports the regression.
  it('still fails a fixed regression even when one sample\'s baseline alone is delayed', () => {
    const regressed = { baselineBeforeMs: 30, commandMs: 530, baselineAfterMs: 30 };
    const samples = Array.from({ length: 10 }, () => regressed);
    samples.push({ baselineBeforeMs: 1030, commandMs: 530, baselineAfterMs: 30 });
    const summary = summarizePairedTimings(samples);
    // The minimum statistic would be fooled into reporting no regression.
    expect(summary.overheadMinMs).toBe(0);
    // The median statistic asserted by the CLI perf gate is not fooled.
    expect(summary.overheadMedianMs).toBeGreaterThanOrEqual(500);
  });
});
