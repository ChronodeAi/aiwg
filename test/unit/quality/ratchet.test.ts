/**
 * @source @tools/quality/ratchet.mjs
 */
import { describe, expect, it } from 'vitest';
import { evaluateRatchet, matchFunctions, parseGrowthTrailers } from '../../../tools/quality/ratchet.mjs';

const bands = {
  function_nloc: { p70: 10, p80: 15, p90: 20 },
  function_ccn: { p70: 4, p80: 6, p90: 8 },
  file_loc: { p70: 50, p80: 80, p90: 100 },
};

type Fn = { file: string; name: string; startLine: number; endLine: number; nloc: number; ccn: number };

function fn(file: string, name: string, nloc: number, ccn: number, startLine = 1): Fn {
  return { file, name, startLine, endLine: startLine + nloc, nloc, ccn };
}

type Entry = {
  file: string;
  basePath: string;
  baseLoc: number | null;
  headLoc: number | null;
  baseFunctions: Fn[];
  headFunctions: Fn[];
  hunks: unknown[];
};

function entry(file: string, baseFunctions: Fn[], headFunctions: Fn[], baseLoc: number | null = 40, headLoc: number | null = 40): Entry {
  return { file, basePath: file, baseLoc, headLoc, baseFunctions, headFunctions, hunks: [] };
}

function run(changedSet: Entry[], growthTrailers = new Map<string, string>()) {
  return evaluateRatchet({ pairs: matchFunctions(changedSet), changedSet, bands, growthTrailers });
}

const codes = (result: { verdicts: { level: string; code: string }[] }) =>
  result.verdicts.map((v) => `${v.level} ${v.code}`);

describe('evaluateRatchet', () => {
  it('fails a new function past both p90 bands', () => {
    const result = run([entry('a.py', [], [fn('a.py', 'big', 30, 12)], null, 40)]);
    expect(codes(result)).toContain('FAIL function-worsened');
  });

  it('does not fail a new function past only one p90 band', () => {
    const result = run([entry('a.py', [], [fn('a.py', 'long', 30, 2)], null, 40)]);
    expect(codes(result)).not.toContain('FAIL function-worsened');
  });

  it('fails a matched function that worsened past one p90 band', () => {
    const result = run([entry('a.py', [fn('a.py', 'f', 5, 3)], [fn('a.py', 'f', 5, 9)])]);
    expect(codes(result)).toContain('FAIL function-worsened');
    expect(result.verdicts.find((v) => v.code === 'function-worsened')?.message).toContain('Do not edit .aiwg/quality/gate.json');
  });

  it('leaves an unchanged legacy above-band function alone', () => {
    const legacy = fn('a.py', 'legacy', 80, 30);
    const result = run([entry('a.py', [legacy, fn('a.py', 'g', 3, 1, 90)], [legacy, fn('a.py', 'g', 4, 1, 90)])]);
    expect(result.verdicts.filter((v) => v.level === 'FAIL')).toEqual([]);
  });

  it('pairs a function moved unchanged to another file with its origin', () => {
    const moved = fn('old.py', 'moved', 30, 12);
    const result = run([
      entry('old.py', [moved, fn('old.py', 'keep', 3, 1, 40)], [fn('old.py', 'keep', 3, 1, 1)]),
      entry('new.py', [], [{ ...moved, file: 'new.py' }], null, 35),
    ]);
    expect(result.verdicts.filter((v) => v.level === 'FAIL')).toEqual([]);
  });

  it('counts above-band functions over the whole changed set', () => {
    const result = run([
      entry('a.py', [fn('a.py', 'x', 25, 2)], [fn('a.py', 'x', 25, 2)]),
      entry('b.py', [], [fn('b.py', 'y', 21, 1)], null, 30),
    ]);
    expect(codes(result)).toContain('FAIL above-band-count-increased');
  });

  it('does not flag above-band count when the total is unchanged across files', () => {
    const big = fn('a.py', 'x', 25, 2);
    const result = run([
      entry('a.py', [big], []),
      entry('b.py', [], [{ ...big, file: 'b.py', name: 'x' }], null, 30),
    ]);
    expect(codes(result)).not.toContain('FAIL above-band-count-increased');
  });

  it('warns on a split mirage: more functions, sum_ccn not falling', () => {
    const base = [fn('a.py', 'f', 18, 6)];
    const head = [fn('a.py', 'f', 3, 3), fn('a.py', 'p1', 3, 2), fn('a.py', 'p2', 3, 1), fn('a.py', 'p3', 3, 1)];
    expect(codes(run([entry('a.py', base, head)]))).toContain('WARN split-mirage-candidate');
  });

  it('reports file growth past the band as advisory, justified by trailer', () => {
    const e = entry('a.py', [fn('a.py', 'f', 3, 1)], [fn('a.py', 'f', 3, 1)], 90, 130);
    const unjustified = run([e]).verdicts.find((v) => v.code === 'file-growth');
    expect(unjustified?.level).toBe('ADVISORY');
    expect(unjustified?.message).toMatch(/^NEEDS-JUSTIFICATION/);
    const justified = run([e], parseGrowthTrailers('fix\n\nFile-Growth: a.py — owns the parser table\n'));
    const verdict = justified.verdicts.find((v) => v.code === 'file-growth');
    expect(verdict?.message).toMatch(/^JUSTIFIED/);
    expect(justified.verdicts.some((v) => v.level === 'FAIL')).toBe(false);
  });

  it('emits a SHAPE record for every changed file', () => {
    const result = run([entry('a.py', [fn('a.py', 'f', 3, 2)], [fn('a.py', 'f', 3, 2), fn('a.py', 'g', 2, 3)], 10, 14)]);
    expect(result.shape).toEqual([{ file: 'a.py', base: { loc: 10, functions: 1, sum_ccn: 2, max_ccn: 2 }, head: { loc: 14, functions: 2, sum_ccn: 5, max_ccn: 3 } }]);
  });

  it('issues no band verdicts when bands are uncalibrated', () => {
    const zero = { function_nloc: { p70: 0, p80: 0, p90: 0 }, function_ccn: { p70: 0, p80: 0, p90: 0 }, file_loc: { p70: 0, p80: 0, p90: 0 } };
    const changedSet = [entry('a.py', [fn('a.py', 'f', 5, 3)], [fn('a.py', 'f', 50, 30)])];
    const result = evaluateRatchet({ pairs: matchFunctions(changedSet), changedSet, bands: zero });
    expect(result.verdicts).toEqual([]);
  });
});

describe('matchFunctions', () => {
  it('breaks same-name ties by mapped line overlap', () => {
    const base = [fn('a.py', 'h', 5, 1, 1), fn('a.py', 'h', 5, 7, 20)];
    const head = [fn('a.py', 'h', 5, 7, 30), fn('a.py', 'h', 5, 1, 1)];
    const hunks = [{ oldStart: 10, oldCount: 0, newStart: 11, newCount: 10, removed: [], added: [] }];
    const pairs = matchFunctions([{ ...entry('a.py', base, head), hunks }]);
    const second = pairs.find((p) => p.head?.startLine === 30);
    expect(second?.base?.startLine).toBe(20);
  });
});
