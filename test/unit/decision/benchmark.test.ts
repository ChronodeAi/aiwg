import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { analyzeBenchmark, benchmarkDigest, benchmarkComparison, benchmarkDeviationComparison, benchmarkScoringDeviation,
  validateBenchmarkCases, validateBenchmarkCapture, splitBenchmarkHoldout, type BenchmarkCase, type BenchmarkCapture, type BenchmarkObservation } from '../../../src/decision/benchmark.js';
const cases = JSON.parse(readFileSync('test/fixtures/decision/benchmark-smoke.json', 'utf8')) as BenchmarkCase[];
const observation = (answer: BenchmarkCase['expected'], confidence = 0.9): BenchmarkObservation => ({ answer, confidence,
  status: 'answered', model: 'jev-1.13.0', usage: { inputTokens: 500, outputTokens: 20 }, latencyMs: 100 });
const capture = (): BenchmarkCapture => ({ schema: 'aiwg-decision-benchmark-capture/v1', datasetDigest: benchmarkDigest(cases),
  capturedAt: '2026-10-23T00:00:00.000Z', baselineLabel: 'saved baseline',
  rows: cases.map(c => ({ id: c.id, baseline: observation(c.expected), jev: Array.from({ length: 20 }, () => observation(c.expected)) })) });
const policies = [1, 3, 5, 10, 15, 20].map(passes => ({ passes, threshold: 0.8, agreement: 0.67 }));
const rates = { llm_per_mtok: 2, jev_input_per_mtok: 0.042, jev_output_per_mtok: 0, jev_model: 'jev-1.13.0' };
describe('offline benchmark', () => {
  it('analyzes smoke fixture and sweeps nested prefixes without mutating data', () => {
    const saved = capture(); const before = JSON.stringify(saved);
    const report = analyzeBenchmark(cases, saved, policies, rates);
    expect(report.measurements).toHaveLength(6);
    expect(report.measurements.every(m => m.holdout.routedAccuracy === 1)).toBe(true);
    expect(report.recommended?.passes).toBe(1);
    expect(report.scoringDeviation.map(d => d.passes)).toEqual([1, 3, 5, 10, 15, 20]);
    expect(benchmarkDeviationComparison(report)).toContain('One pass cannot estimate SD');
    expect(benchmarkComparison(saved, rates)).toContain('$0.00012600');
    expect(JSON.stringify(saved)).toBe(before);
  });
  it('keeps costs unknown without rates or usage, including Jev totals', () => {
    for (const cost of [undefined, {}, { llm_per_mtok: 2 }]) {
      const m = analyzeBenchmark(cases, capture(), policies, cost).measurements[0].tuning;
      expect(m.estimatedJevUsd).toBeNull(); expect(m.routedUsd).toBeNull(); expect(m.savingsUsd).toBeNull();
    }
    const saved = capture(); saved.rows[0].jev[0].usage = null;
    expect(analyzeBenchmark(cases, saved, policies, rates).measurements[0].tuning.estimatedJevUsd).toBeNull();
    expect(benchmarkComparison(capture())).toContain('Costs unknown');
    expect(analyzeBenchmark(cases, capture(), policies, { ...rates, jev_model: 'jev-9.0.0' }).measurements[0].tuning.estimatedJevUsd).toBeNull();
  });
  it('prices explicit zero and fallback expense through current savings rates', () => {
    const saved = capture(); saved.rows.forEach(r => r.jev.forEach(o => { o.confidence = 0.6; }));
    const m = analyzeBenchmark(cases, saved, [policies[0]], rates).measurements[0].tuning;
    expect(m.baselineUsd).toBeCloseTo(3 * 520 * 2 / 1e6);
    expect(m.routedUsd).toBeCloseTo(m.baselineUsd! + 3 * 500 * 0.042 / 1e6);
    expect(m.savingsUsd).toBeCloseTo(-3 * 500 * 0.042 / 1e6);
    expect(m.fallbackRate).toBe(1);
    expect(analyzeBenchmark(cases, saved, [policies[0]], { llm_per_mtok: 0, jev_per_mtok: 0 }).measurements[0].tuning.routedUsd).toBe(0);
  });
  it('preserves free output pricing with unknown output usage and blended fallback', () => {
    const saved = capture(); saved.rows.forEach(r => r.jev.forEach(o => { o.usage!.outputTokens = null; }));
    expect(analyzeBenchmark(cases, saved, [policies[0]], rates).measurements[0].tuning.estimatedJevUsd).toBeCloseTo(3 * 500 * 0.042 / 1e6);
    expect(analyzeBenchmark(cases, saved, [policies[0]], { jev_per_mtok: 0.2 }).measurements[0].tuning.estimatedJevUsd).toBeNull();
    expect(analyzeBenchmark(cases, capture(), [policies[0]], { jev_per_mtok: 0.2, jev_input_per_mtok: 0.042 }).measurements[0].tuning.estimatedJevUsd).toBeCloseTo(3 * 520 * 0.2 / 1e6);
  });
  it('uses one latency ordering when any eligible policy has unknown cost', () => {
    const saved = capture(); saved.rows.forEach(r => { r.jev[2].usage = null; });
    expect(analyzeBenchmark(cases, saved, [policies[1], policies[0]], { ...rates, jev_input_per_mtok: 1_000_000 }).recommended?.passes).toBe(1);
  });
  it('selects only on tuning even when holdout labels change', () => {
    const saved = capture(); saved.rows.filter(r => cases.find(c => c.id === r.id)?.split === 'holdout').forEach(r => r.jev.forEach(o => { o.status = 'fallback'; o.answer = null; }));
    expect(analyzeBenchmark(cases, saved, policies, rates).recommended).toEqual(analyzeBenchmark(cases, capture(), policies, rates).recommended);
  });
  it('splits deterministically by seed and ID independent of ordering or outcomes', () => {
    const split = splitBenchmarkHoldout(cases, 0.5, 'fixed');
    expect(splitBenchmarkHoldout([...cases].reverse(), 0.5, 'fixed').reverse()).toEqual(split);
    expect(split.filter(c => c.split === 'holdout')).toHaveLength(3);
    expect(splitBenchmarkHoldout(cases, 0.5, 'fixed')).toEqual(split);
    expect(() => splitBenchmarkHoldout(cases, 1)).toThrow();
  });
  it.each([
    (c: any) => { c.schema = 'wrong'; }, (c: any) => { c.datasetDigest = 'wrong'; },
    (c: any) => { c.rows[0].id = c.rows[1].id; }, (c: any) => { c.rows[0].jev = []; },
    (c: any) => { c.rows[0].jev.push(...c.rows[0].jev); },
    (c: any) => { c.rows[0].baseline.answer = 'true'; }, (c: any) => { c.rows[0].jev[0].confidence = 2; },
    (c: any) => { c.rows[0].jev[0].usage.inputTokens = -1; },
    (c: any) => { c.rows[0].jev[0].usage.cachedInputTokens = 501; },
    (c: any) => { c.path = '../execute.sh'; }, (c: any) => { c.capturedAt = 'invalid'; },
    (c: any) => { c.rows[0].jev[0].command = 'echo unsafe'; },
  ])('rejects malformed capture %#', mutate => {
    const saved = capture(); mutate(saved); expect(() => validateBenchmarkCapture(cases, saved)).toThrow();
  });
  it('rejects malformed cases, grids and rates', () => {
    expect(() => validateBenchmarkCases(null)).toThrow();
    expect(() => validateBenchmarkCases([{ ...cases[0], id: '../x' }, cases[3]])).toThrow();
    expect(() => validateBenchmarkCases([{ ...cases[1], input: { question: 'x', mode: { kind: 'choices', choices: ['a', 'a'] } } }, cases[3]])).toThrow();
    expect(() => analyzeBenchmark(cases, capture(), [{ ...policies[0], passes: 21 }])).toThrow();
    expect(() => analyzeBenchmark(cases, capture(), policies, { jev_per_mtok: NaN })).toThrow();
  });
  it('retains sample SD and ordinal MAE without numeric category scores', () => {
    const saved = capture(); const row = saved.rows[2]; row.jev[0].answer = 1; row.jev[1].answer = 2; row.jev[2].answer = 3;
    const d = benchmarkScoringDeviation(cases, saved, 3);
    expect(d.cases[2].scaleScoreStdDev).toBe(1);
    expect(d.cases[2].scaleMaeGold).toBe(1);
    expect(d.cases[0].scaleScoreStdDev).toBeNull();
    expect(benchmarkScoringDeviation(cases, saved, 1).meanWithinCaseScaleScoreStdDev).toBeNull();
  });
  it('preserves the draft ordinal, confidence and disagreement analysis checks', () => {
    const numeric: BenchmarkCase[] = [
      { id: 'a', split: 'tuning', expected: 2, input: { question: 'Score?', mode: { kind: 'scale', low: 1, high: 5 } } },
      { id: 'b', split: 'holdout', expected: 4, input: { question: 'Score?', mode: { kind: 'scale', low: 1, high: 5 } } },
    ];
    const obs = (answer: number, confidence: number) => observation(answer, confidence);
    const saved: BenchmarkCapture = { ...capture(), datasetDigest: benchmarkDigest(numeric), rows: [
      { id: 'a', baseline: obs(2, 1), jev: [obs(1, 0.8), obs(2, 0.9), obs(3, 1)] },
      { id: 'b', baseline: obs(4, 1), jev: [obs(4, 0.9), obs(4, 0.9), obs(4, 0.9)] },
    ] };
    const d = benchmarkScoringDeviation(numeric, saved, 3);
    expect(d.meanWithinCaseScaleScoreStdDev).toBeCloseTo(0.5);
    expect(d.meanWithinCaseConfidenceStdDev).toBeCloseTo(0.05);
    expect(d.meanScaleMaeGold).toBeCloseTo(1 / 3);
    expect(d.meanScaleMaeBaseline).toBeCloseTo(1 / 3);
    expect(d.answerDisagreementRate).toBeCloseTo(1 / 3);
    expect(d.rawAccuracy).toBeCloseTo(4 / 6);
    const single = benchmarkScoringDeviation(numeric, saved, 1);
    expect(single.meanWithinCaseScaleScoreStdDev).toBeNull();
    expect(single.meanWithinCaseConfidenceStdDev).toBeNull();
  });
  it('runs headlessly and rejects traversal, symlink escapes, oversize and live flags', async () => {
    const directory = mkdtempSync(resolve('.benchmark-test-'));
    const outside = mkdtempSync(`${tmpdir()}/benchmark-outside-`);
    const tool = resolve('tools/decision/benchmark.mjs');
    let launches = 0;
    const run = (...args: string[]) => new Promise<{ stdout: string; stderr: string; status: string | number }>(done => {
      // Files preserve child output on hosts that restrict pipe visibility.
      const prefix = `${directory}/run-${launches++}`;
      const stdout = openSync(`${prefix}.out`, 'w'); const stderr = openSync(`${prefix}.err`, 'w');
      const child = spawn(process.execPath, [tool, ...args], { stdio: ['ignore', stdout, stderr], timeout: 10000 });
      let launchError: string | undefined;
      child.once('error', error => { launchError = error.message; });
      child.once('close', (code, signal) => {
        closeSync(stdout); closeSync(stderr);
        done({ stdout: readFileSync(`${prefix}.out`, 'utf8'), stderr: readFileSync(`${prefix}.err`, 'utf8'),
          status: launchError ?? code ?? signal ?? 'missing exit code' });
      });
    });
    try {
      const path = `${directory}/capture.json`; writeFileSync(path, JSON.stringify({ cases, capture: capture() }));
      const output = await run('analyze', '--capture', path, '--holdout', '0.5', '--json');
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout).measurements).toHaveLength(24);
      writeFileSync(`${directory}/cases.json`, JSON.stringify(cases));
      writeFileSync(`${directory}/observations.json`, JSON.stringify(capture()));
      const replay = await run('replay', '--capture', `${directory}/observations.json`, '--dataset', `${directory}/cases.json`, '--agreement', '0.67,1', '--json');
      expect(replay.status).toBe(0);
      expect(JSON.parse(replay.stdout).measurements).toHaveLength(48);
      expect((await run('plan', '--capture', path)).status).toBe(0);
      expect((await run('analyze', '--capture', '../bad.json')).stderr).toContain('traversal');
      writeFileSync(`${outside}/capture.json`, '{}'); symlinkSync(`${outside}/capture.json`, `${directory}/escape.json`);
      expect((await run('analyze', '--capture', `${directory}/escape.json`)).stderr).toContain('inside');
      writeFileSync(`${directory}/large.json`, ' '.repeat(4 * 1024 * 1024 + 1));
      expect((await run('analyze', '--capture', `${directory}/large.json`)).stderr).toContain('size limit');
      expect((await run('analyze', '--capture', path, '--live')).status).toBe(2);
      expect((await run('analyze', '--capture')).status).toBe(2);
    } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});
