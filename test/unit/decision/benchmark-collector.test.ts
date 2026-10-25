import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectBenchmark, analyzeBenchmark, splitBenchmarkHoldout, validateBenchmarkCapture,
  type BenchmarkCase, type BenchmarkCapture, type BenchmarkObservation, type BenchmarkPrice, type CollectBenchmarkOptions } from '../../../src/decision/benchmark.js';
import * as askModule from '../../../src/decision/ask.js';
import { tokenCost } from '../../../src/decision/pricing.js';

const cases = JSON.parse(readFileSync('test/fixtures/decision/benchmark-smoke.json', 'utf8')) as BenchmarkCase[];
const split = splitBenchmarkHoldout(cases, 0.3);
const price: BenchmarkPrice = { model: 'fixture-llm-v1', source: 'https://example.com/pricing', checkedAt: '2026-10-25',
  inputPerMillionUsd: 2, outputPerMillionUsd: 4, cachedInputPerMillionUsd: 1 };
const expected = input => cases.find(c => c.input.question === input.question && c.input.context === input.context
  && JSON.stringify(c.input.mode) === JSON.stringify(input.mode))!.expected;
function harness() {
  let clock = Date.UTC(2026, 9, 25);
  const client = (baseline: boolean) => vi.fn(async (input): Promise<BenchmarkObservation> => {
    clock += baseline ? 7 : 3;
    return { answer: expected(input), status: 'answered', confidence: 0.9,
      model: baseline ? price.model : 'jev-1.13.0', usage: { inputTokens: 500, outputTokens: 20, cachedInputTokens: 0 }, latencyMs: 999 };
  });
  const baseline = client(true), jev = client(false);
  const options: CollectBenchmarkOptions = { live: true, maxCalls: cases.length * 4, maxUsd: 1, passes: 3,
    baselineLabel: 'fixture baseline', baselinePrices: [price], baseline, jev, now: () => clock, env: {} };
  return { baseline, jev, options };
}
const policy = [{ passes: 1, threshold: 0.8, agreement: 1 }];
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function directory() {
  const result = mkdtempSync(join(tmpdir(), 'aiwg-benchmark-collector-'));
  directories.push(result);
  return result;
}

describe('paired benchmark collector', () => {
  it('round-trips real observations, served models, costs, latency and deterministic split through the analyzer', async () => {
    const { baseline, jev, options } = harness();
    const checkpoints: unknown[] = [];
    const saved = await collectBenchmark(cases, { ...options, onCheckpoint: async capture => {
      validateBenchmarkCapture(split, capture); checkpoints.push(capture);
    } });
    expect(saved.collection).toMatchObject({ stopReason: 'complete', calls: 24 });
    expect(baseline).toHaveBeenCalledTimes(6); expect(jev).toHaveBeenCalledTimes(18);
    const roundTrip = JSON.parse(JSON.stringify(saved));
    validateBenchmarkCapture(split, roundTrip);
    const report = analyzeBenchmark(split, roundTrip, policy);
    expect(report.measurements[0].tuning).toMatchObject({ routedAccuracy: 1, fallbackRate: 0 });
    expect(report.measurements[0].tuning.baselineUsd).toBeCloseTo(4 * 0.00108);
    expect(report.measurements[0].holdout.estimatedJevUsd).toBeCloseTo(2 * 0.000021);
    expect(saved.rows[0].baseline.latencyMs).toBe(7);
    expect(saved.rows[0].jev[0]).toMatchObject({ model: 'jev-1.13.0', latencyMs: 3,
      cost: { usd: 0.000021, price: { source: 'https://docs.typesafe.ai/models.md', checkedAt: '2026-10-18T00:00:00.000Z' } } });
    expect(jev.mock.calls[0][0]).toEqual(baseline.mock.calls[0][0]);
    expect(jev.mock.calls[0][0]).toMatchObject({ passes: 1, escalationPasses: 1, threshold: 0 });
    expect(Object.keys(jev.mock.calls[0][0])).not.toContain('expected');
    expect(checkpoints.length).toBeGreaterThan(18);
    expect((checkpoints[0] as any).rows[0].jev).toHaveLength(0);
  });
  it.each([
    { live: false }, { maxCalls: 23 }, { maxCalls: NaN }, { maxCalls: -1 },
    { maxUsd: 0 }, { maxUsd: NaN }, { passes: 0 }, { passes: 21 },
    { baselinePrices: [{ ...price, source: 'unverified' }] },
  ])('refuses invalid opt-in, call caps, spend caps and rates before dispatch: %j', async change => {
    const h = harness();
    await expect(collectBenchmark(cases, { ...h.options, ...change })).rejects.toThrow();
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).not.toHaveBeenCalled();
  });
  it('stops before the next call at exactly 80%, saves real partial observations and resumes without repeating the baseline', async () => {
    const h = harness();
    h.baseline.mockImplementation(async input => ({ status: 'answered', confidence: 1,
      answer: expected(input),
      model: price.model, usage: { inputTokens: 1, outputTokens: 0 }, latencyMs: 0 }));
    const options = { ...h.options, baselinePrices: [{ ...price, inputPerMillionUsd: 1_000_000, cachedInputPerMillionUsd: undefined }] };
    const partial = await collectBenchmark(cases, { ...options, maxUsd: 1.25 });
    expect(partial.collection).toMatchObject({ stopReason: 'usd-limit', calls: 1, knownUsd: 1 });
    expect(h.jev).not.toHaveBeenCalled(); expect(partial.rows).toHaveLength(1); expect(partial.rows[0].jev).toHaveLength(0);
    validateBenchmarkCapture(split, partial);
    expect(() => analyzeBenchmark(split, partial, policy)).toThrow(/Incomplete/);
    const onCheckpoint = vi.fn(async () => {});
    const noSpend = await collectBenchmark(cases, { ...options, maxUsd: 1.25, extendCapture: partial, onCheckpoint });
    expect(onCheckpoint).toHaveBeenCalledWith(noSpend);
    expect(noSpend.collection).toMatchObject({ calls: 0, knownUsd: 1, stopReason: 'usd-limit' });
    const resumed = await collectBenchmark(cases, { ...options, maxUsd: 100, maxCalls: 23, extendCapture: partial });
    expect(resumed.collection).toMatchObject({ stopReason: 'complete', calls: 23 });
    expect(h.baseline).toHaveBeenCalledTimes(6); expect(h.jev).toHaveBeenCalledTimes(18);
    expect(resumed.rows[0].baseline).toEqual(partial.rows[0].baseline);
    expect(resumed.collection!.knownUsd).toBeGreaterThan(6);
    expect(analyzeBenchmark(split, resumed, policy).measurements[0].holdout.routedAccuracy).toBe(1);
  });
  it('extends only the missing Jev suffix and refuses changed data, seed, labels and shrinking passes', async () => {
    const h = harness();
    const prior = await collectBenchmark(cases, { ...h.options, passes: 1, maxCalls: 12 });
    h.baseline.mockClear(); h.jev.mockClear();
    const extended = await collectBenchmark(cases, { ...h.options, maxCalls: 12, extendCapture: prior });
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).toHaveBeenCalledTimes(12);
    expect(extended.rows[0].baseline).toEqual(prior.rows[0].baseline);
    expect(extended.rows[0].jev[0]).toEqual(prior.rows[0].jev[0]);
    const same = await collectBenchmark(cases, { ...h.options, maxCalls: 0, extendCapture: extended });
    expect(same.collection!.calls).toBe(0);
    for (const change of [{ baselineLabel: 'changed' }, { seed: 'changed' }, { passes: 1 }, { maxCalls: 11 }]) {
      await expect(collectBenchmark(cases, { ...h.options, extendCapture: change.passes ? extended : prior, ...change })).rejects.toThrow();
    }
    const changed = structuredClone(cases); changed[0].expected = false;
    await expect(collectBenchmark(changed, { ...h.options, extendCapture: prior })).rejects.toThrow();
    expect(h.jev).toHaveBeenCalledTimes(12);
  });
  it('reuses saved Jev responses and prices unchanged while budgeting only a new baseline, then round-trips through analysis', async () => {
    const h = harness();
    const prior = await collectBenchmark(cases, { ...h.options, maxUsd: 100_000, jevPrices: [{ ...price,
      model: 'jev-1.13.0', inputPerMillionUsd: 1_000_000, outputPerMillionUsd: 0 }] });
    const before = JSON.stringify(prior);
    h.baseline.mockClear(); h.jev.mockClear();
    const nextPrice = { ...price, model: 'fixture-llm-v2' };
    const baseline = vi.fn(async input => ({ ...await h.baseline(input), model: nextPrice.model }));
    const saved = await collectBenchmark(cases, { ...h.options, baseline, baselinePrices: [nextPrice],
      baselineLabel: 'new baseline', jevCapture: prior, maxCalls: cases.length, maxUsd: 0.01, jevPrices: [] });
    expect(saved.collection).toMatchObject({ calls: 6, stopReason: 'complete' });
    expect(saved.collection!.knownUsd).toBeCloseTo(6 * 0.00108);
    expect(baseline).toHaveBeenCalledTimes(6); expect(h.jev).not.toHaveBeenCalled();
    expect(saved.baselineLabel).toBe('new baseline');
    expect(saved.rows.map(r => r.baseline.model)).toEqual(cases.map(() => nextPrice.model));
    expect(saved.rows.map(r => r.jev)).toEqual(prior.rows.map(r => r.jev));
    const roundTrip = JSON.parse(JSON.stringify(saved));
    validateBenchmarkCapture(split, roundTrip);
    const report = analyzeBenchmark(split, roundTrip, policy).measurements[0];
    expect(report.tuning.routedAccuracy).toBe(1); expect(report.holdout.routedAccuracy).toBe(1);
    expect(report.tuning.estimatedJevUsd).toBe(4 * 500);
    saved.rows[0].jev[0].confidence = 0;
    expect(JSON.stringify(prior)).toBe(before);
  });
  it.each([
    ['schema', (c: BenchmarkCapture) => { (c as any).schema = 'unsupported'; }],
    ['digest', (c: BenchmarkCapture) => { c.datasetDigest = 'changed'; }],
    ['fewer passes', (c: BenchmarkCapture) => { c.rows[0].jev.pop(); }],
    ['more passes', (c: BenchmarkCapture) => { c.rows[0].jev.push(c.rows[0].jev[0]); }],
    ['missing case', (c: BenchmarkCapture) => { c.rows.pop(); c.collection!.stopReason = 'incomplete'; }],
    ['invalid observation', (c: BenchmarkCapture) => { c.rows[0].jev[0].confidence = 2; }],
    ['tampered price', (c: BenchmarkCapture) => { c.rows[0].jev[0].cost!.usd = 1; }],
  ] as const)('refuses reused %s before any provider call', async (_name, mutate) => {
    const h = harness();
    const prior = await collectBenchmark(cases, h.options);
    mutate(prior); h.baseline.mockClear(); h.jev.mockClear();
    await expect(collectBenchmark(cases, { ...h.options, jevCapture: prior })).rejects.toThrow();
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).not.toHaveBeenCalled();
  });
  it('refuses conflicting reuse, changed split and insufficient baseline call budgets before dispatch', async () => {
    const h = harness();
    const prior = await collectBenchmark(cases, h.options);
    h.baseline.mockClear(); h.jev.mockClear();
    for (const change of [{ extendCapture: prior }, { seed: 'changed' }, { maxCalls: cases.length - 1 }]) {
      await expect(collectBenchmark(cases, { ...h.options, jevCapture: prior, ...change })).rejects.toThrow();
    }
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).not.toHaveBeenCalled();
  });
  it.each(['usd-limit', 'unknown-cost'] as const)('checkpoints reused Jev rows when new baseline collection hits %s', async reason => {
    const h = harness();
    const prior = await collectBenchmark(cases, h.options);
    h.baseline.mockClear(); h.jev.mockClear();
    const onCheckpoint = vi.fn(async capture => { validateBenchmarkCapture(split, capture); });
    const saved = await collectBenchmark(cases, { ...h.options, jevCapture: prior, maxCalls: cases.length,
      maxUsd: reason === 'usd-limit' ? 0.001 : 1, baselinePrices: reason === 'unknown-cost' ? [] : [price], onCheckpoint });
    expect(saved.collection).toMatchObject({ stopReason: reason, calls: 1 });
    expect(saved.rows).toHaveLength(1); expect(saved.rows[0].jev).toEqual(prior.rows[0].jev);
    expect(h.baseline).toHaveBeenCalledTimes(1); expect(h.jev).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenLastCalledWith(saved);
  });
  it('reuses unpriced legacy Jev observations without requiring Jev credentials or changing their costs', async () => {
    const h = harness();
    const prior = await collectBenchmark(cases, h.options);
    for (const row of prior.rows) for (const sample of [row.baseline, ...row.jev]) delete sample.cost;
    h.baseline.mockClear(); h.jev.mockClear();
    const ask = vi.spyOn(askModule, 'askDecision').mockRejectedValue(new Error('Unexpected Jev call'));
    const saved = await collectBenchmark(cases, { ...h.options, jevCapture: prior, maxCalls: cases.length, jev: undefined });
    expect(saved.collection).toMatchObject({ stopReason: 'complete', calls: 6 });
    expect(saved.rows.map(r => r.jev)).toEqual(prior.rows.map(r => r.jev));
    expect(h.baseline).toHaveBeenCalledTimes(6); expect(ask).not.toHaveBeenCalled();
    expect(analyzeBenchmark(split, saved, policy).measurements[0].tuning.estimatedJevUsd).toBeNull();
  });
  it('extends legacy observations using supplied sourced rates and stops immediately after a Jev call crosses the cap', async () => {
    const h = harness();
    const prior = await collectBenchmark(cases, { ...h.options, passes: 1 });
    for (const row of prior.rows) for (const sample of [row.baseline, ...row.jev]) delete sample.cost;
    h.baseline.mockClear(); h.jev.mockClear();
    const extended = await collectBenchmark(cases, { ...h.options, extendCapture: prior, maxCalls: 12 });
    expect(extended.rows[0].baseline.answer).toBe(prior.rows[0].baseline.answer);
    expect(prior.rows[0].baseline.cost).toBeUndefined();
    expect(extended.rows[0].baseline.cost!.usd).toBeCloseTo(0.00108);
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).toHaveBeenCalledTimes(12);
    h.jev.mockClear();
    const stopped = await collectBenchmark(cases, { ...h.options, maxUsd: 0.00109 / 0.8 });
    expect(stopped.collection).toMatchObject({ stopReason: 'usd-limit', calls: 2 });
    expect(h.baseline).toHaveBeenCalledTimes(1); expect(h.jev).toHaveBeenCalledTimes(1);
    expect(stopped.rows[0].jev).toHaveLength(1);
  });
  it.each(['usage', 'model', 'cache', 'error', 'rates'] as const)('keeps unknown %s cost null and stops without retries', async kind => {
    const h = harness();
    if (kind === 'error') h.baseline.mockRejectedValue(new Error('fixture failure'));
    else if (kind === 'rates') h.options.baselinePrices = [];
    else {
      const original = h.baseline.getMockImplementation()!;
      h.baseline.mockImplementation(async input => {
        const sample = await original(input);
        if (kind === 'usage') sample.usage = null;
        if (kind === 'model') sample.model = 'unknown-served-version';
        if (kind === 'cache') delete sample.usage!.cachedInputTokens;
        return sample;
      });
    }
    const partial = await collectBenchmark(cases, h.options);
    expect(partial.collection).toMatchObject({ stopReason: 'unknown-cost', calls: 1 });
    expect(partial.rows[0].baseline.cost!.usd).toBeNull();
    expect(h.jev).not.toHaveBeenCalled(); expect(h.baseline).toHaveBeenCalledTimes(1);
    await expect(collectBenchmark(cases, { ...h.options, extendCapture: partial })).rejects.toThrow(/unpriced/);
  });
  it('prices fallback observations and routed baseline expense; rejects tampered historical costs', async () => {
    const h = harness();
    const original = h.jev.getMockImplementation()!;
    h.jev.mockImplementation(async input => ({ ...await original(input), status: 'fallback', answer: null, confidence: null }));
    const saved = await collectBenchmark(cases, h.options);
    const report = analyzeBenchmark(split, saved, policy).measurements[0].tuning;
    expect(report.fallbackRate).toBe(1);
    expect(report.routedUsd).toBeCloseTo(report.baselineUsd! + report.estimatedJevUsd!);
    saved.rows[0].baseline.cost!.usd = 0;
    expect(() => validateBenchmarkCapture(split, saved)).toThrow(/Invalid captured/);
  });
  it('uses the existing ask path with one pass and forced environment-only credentials', async () => {
    const h = harness();
    const ask = vi.spyOn(askModule, 'askDecision').mockImplementation(async input => ({ schema: 'aiwg-decision-ask/v1',
      status: 'answered', answer: expected(input), confidence: 0.99, fallback: null, reason: 'none',
      model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: null }, latencyMs: 0 }));
    await collectBenchmark(cases, { ...h.options, jev: undefined, env: { JEV_API_KEY: 'synthetic-token' } });
    expect(ask).toHaveBeenCalledTimes(18);
    expect(ask.mock.calls[0][0]).toMatchObject({ passes: 1, escalationPasses: 1, threshold: 0 });
    expect(ask.mock.calls[0][1]).toMatchObject({ env: { JEV_API_KEY: 'synthetic-token', AIWG_DECISION_ENABLED: '1' } });
    ask.mockClear(); h.baseline.mockClear();
    await expect(collectBenchmark(cases, { ...h.options, jev: undefined, env: {} })).rejects.toThrow(/caller environment/);
    expect(ask).not.toHaveBeenCalled(); expect(h.baseline).not.toHaveBeenCalled();
  });
  it('retains exact zero prices, free output and cache-aware billing without guessing missing usage', () => {
    expect(tokenCost({ inputTokens: 100, outputTokens: null }, { inputPerMillionUsd: 0.042, outputPerMillionUsd: 0 })).toBeCloseTo(0.0000042);
    expect(tokenCost({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 }, price)).toBeCloseTo(0.00024);
    expect(tokenCost({ inputTokens: 100, outputTokens: 20 }, price)).toBeNull();
    expect(tokenCost(null, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 })).toBeNull();
    expect(tokenCost({ inputTokens: 100, outputTokens: 20 }, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 })).toBe(0);
  });
});

describe('benchmark CLI with injected clients', () => {
  async function cli() { return import('../../../tools/decision/benchmark.mjs'); }
  it('collects, replays without constructing a client, extends in place and preserves saved observations', async () => {
    const { runBenchmark } = await cli();
    const cwd = directory(), h = harness();
    writeFileSync(join(cwd, 'cases.json'), JSON.stringify(cases));
    writeFileSync(join(cwd, 'price.json'), JSON.stringify(price));
    const print = vi.fn();
    const deps = { cwd, baseline: h.baseline, jev: h.jev, now: h.options.now, env: {}, print };
    const live = ['--live', '--max-calls', '12', '--max-usd', '1', '--passes', '1', '--dataset', 'cases.json',
      '--capture', 'capture.json', '--baseline-price', 'price.json', '--json'];
    const result = await runBenchmark(live, deps);
    expect(result.collection).toMatchObject({ calls: 12, stopReason: 'complete' });
    const prior = JSON.parse(readFileSync(join(cwd, 'capture.json'), 'utf8'));
    h.baseline.mockClear(); h.jev.mockClear();
    const replay = await runBenchmark(['--replay', 'capture.json', '--json'], { cwd, env: {}, print });
    expect(replay.measurements).toEqual(result.measurements);
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).not.toHaveBeenCalled();
    await runBenchmark(['--live', '--max-calls', '12', '--max-usd', '1', '--extend', 'capture.json', '--passes', '3', '--json'], deps);
    const extended = JSON.parse(readFileSync(join(cwd, 'capture.json'), 'utf8'));
    expect(extended.capture.rows[0].jev).toHaveLength(3);
    expect(extended.capture.rows[0].baseline).toEqual(prior.capture.rows[0].baseline);
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).toHaveBeenCalledTimes(12);
    expect(readdirSync(cwd).some(f => f.endsWith('.tmp'))).toBe(false);
  });
  it.each([
    ['--live'], ['--live', '--max-calls', '12'], ['--live', '--max-usd', '1'],
    ['--live', '--max-calls', '12', '--max-usd', '0'],
    ['--live', '--max-calls', '12', '--max-usd', '1', '--replay', 'x'], ['--extend', 'x'],
    ['--jev-capture', 'x'], ['--replay', 'x', '--jev-capture', 'y'],
    ['--live', '--max-calls', '6', '--max-usd', '1', '--extend', 'x', '--jev-capture', 'y'],
  ].map(args => [args]))('refuses missing safety flags and conflicting modes before reading files: %j', async args => {
    const { runBenchmark } = await cli(), h = harness();
    await expect(runBenchmark(args, { baseline: h.baseline, jev: h.jev, env: {}, print: vi.fn() })).rejects.toThrow();
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).not.toHaveBeenCalled();
  });
  it.each(['envelope', 'standalone'] as const)('reuses a %s Jev capture for a new baseline and replays the result offline', async format => {
    const { runBenchmark } = await cli(), h = harness(), cwd = directory();
    const prior = await collectBenchmark(cases, h.options);
    const source = format === 'envelope' ? { cases: split, capture: prior } : prior;
    const sourceBody = JSON.stringify(source);
    writeFileSync(join(cwd, 'prior.json'), sourceBody);
    writeFileSync(join(cwd, 'cases.json'), JSON.stringify(cases));
    writeFileSync(join(cwd, 'price.json'), JSON.stringify(price));
    h.baseline.mockClear(); h.jev.mockClear();
    const ask = vi.spyOn(askModule, 'askDecision').mockRejectedValue(new Error('Unexpected Jev call'));
    const args = ['--live', '--max-calls', '6', '--max-usd', '0.01', '--jev-capture', 'prior.json', '--passes', '3',
      '--capture', 'new.json', '--baseline-model', 'new-model', '--baseline-price', 'price.json', '--json',
      ...(format === 'standalone' ? ['--dataset', 'cases.json'] : [])];
    const deps = { cwd, baseline: h.baseline, now: h.options.now, env: {}, print: vi.fn() };
    const result = await runBenchmark(args, deps);
    expect(result.collection).toMatchObject({ stopReason: 'complete', calls: 6 });
    expect(h.baseline).toHaveBeenCalledTimes(6); expect(ask).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(join(cwd, 'new.json'), 'utf8'));
    expect(saved.capture.baselineLabel).toBe('new-model/low');
    expect(saved.capture.rows.map(r => r.jev)).toEqual(prior.rows.map(r => r.jev));
    const replay = await runBenchmark(['--replay', 'new.json', '--json'], { cwd, env: {}, print: vi.fn() });
    expect(replay.measurements).toEqual(result.measurements);
    expect(readFileSync(join(cwd, 'prior.json'), 'utf8')).toBe(sourceBody);
    expect(readdirSync(cwd).some(f => f.endsWith('.tmp'))).toBe(false);
  });
  it('refuses reused schema, digest and pass mismatches before dispatch or writing output', async () => {
    const { runBenchmark } = await cli(), h = harness(), cwd = directory();
    const prior = await collectBenchmark(cases, h.options);
    h.baseline.mockClear(); h.jev.mockClear();
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected network call'));
    for (const change of [{ schema: 'unsupported' }, { datasetDigest: 'changed' },
      { rows: prior.rows.map(r => ({ ...r, jev: r.jev.slice(0, 1) })) }]) {
      writeFileSync(join(cwd, 'prior.json'), JSON.stringify({ cases: split, capture: { ...prior, ...change } }));
      await expect(runBenchmark(['--live', '--max-calls', '6', '--max-usd', '1', '--jev-capture', 'prior.json',
        '--capture', 'new.json', '--passes', '3', '--baseline-model', 'fixture'],
        { cwd, env: { OPENAI_API_KEY: 'synthetic-token' }, fetch, print: vi.fn() }))
        .rejects.toThrow(/schema|pass count/);
    }
    expect(fetch).not.toHaveBeenCalled(); expect(readdirSync(cwd)).toEqual(['prior.json']);
  });
  it('validates sweep, output and call cap before dispatch; saves a resumable USD-stop envelope', async () => {
    const { runBenchmark } = await cli(), h = harness(), cwd = directory();
    writeFileSync(join(cwd, 'cases.json'), JSON.stringify(cases));
    writeFileSync(join(cwd, 'price.json'), JSON.stringify(price));
    const args = ['--live', '--max-calls', '12', '--max-usd', '1', '--passes', '1', '--dataset', 'cases.json', '--capture', 'saved.json', '--baseline-price', 'price.json'];
    const deps = { cwd, baseline: h.baseline, jev: h.jev, env: {}, now: h.options.now, print: vi.fn() };
    for (const extra of [['--thresholds', 'NaN'], ['--max-calls', '11'], ['--capture', '../escape.json'], ['--passes', '21']]) {
      await expect(runBenchmark([...args, ...extra], deps)).rejects.toThrow();
    }
    expect(h.baseline).not.toHaveBeenCalled(); expect(h.jev).not.toHaveBeenCalled();
    const stopped = await runBenchmark([...args, '--max-usd', '0.001'], deps);
    expect(stopped.report).toBeNull(); expect(stopped.collection.stopReason).toBe('usd-limit');
    const saved = JSON.parse(readFileSync(join(cwd, 'saved.json'), 'utf8'));
    validateBenchmarkCapture(saved.cases, saved.capture);
    expect(h.baseline).toHaveBeenCalledTimes(1); expect(h.jev).not.toHaveBeenCalled();
  });
  it('retains usage for baseline refusal and never retries HTTP failure', async () => {
    const { createBaselineClient } = await cli();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', model: price.model,
      usage: { input_tokens: 100, output_tokens: 20 }, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'fixture refusal' }] }] })));
    const client = createBaselineClient({ env: { OPENAI_API_KEY: 'synthetic-token' }, model: 'fixture', fetch });
    expect(await client(cases[0].input)).toMatchObject({ status: 'fallback', answer: null, model: price.model,
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null } });
    fetch.mockImplementation(async () => new Response('', { status: 429 }));
    await expect(client(cases[0].input)).rejects.toThrow(/429/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses runtime env credentials, captures the served baseline version and cache tokens, and never sends gold or tools', async () => {
    const { createBaselineClient } = await cli();
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.tools).toEqual([]); expect(body.store).toBe(false);
      expect(JSON.parse(body.input)).toEqual(cases[0].input);
      return new Response(JSON.stringify({ status: 'completed', model: 'served-model-version',
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":true,"confidence":0.9}' }] }] }));
    });
    const client = createBaselineClient({ env: { OPENAI_API_KEY: 'synthetic-token' }, model: 'requested-alias', fetch });
    const sample = await client(cases[0].input);
    expect(sample).toMatchObject({ model: 'served-model-version', answer: true, usage: { cachedInputTokens: 40 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => createBaselineClient({ env: {}, model: 'fixture', fetch })).toThrow(/OPENAI_API_KEY/);
    expect(() => createBaselineClient({ env: { OPENAI_API_KEY: 'synthetic' }, fetch })).toThrow(/baseline-model/);
  });
});
