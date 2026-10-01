import { describe, expect, it } from 'vitest';
import { D17_ANALYSIS, validateD17Analysis } from '../../../src/decision/ensemble-study/protocol.js';
import { d17Statistics, type D17ArmMeasurement, type D17Pair } from '../../../src/decision/ensemble-study/statistics.js';

const ids = Array.from({ length: 1200 }, (_, i) => `test-${i}`);
const arm = (): D17ArmMeasurement => ({ probability: 0.9, accepted: true, correct: true,
  brier: 0.01, latencyMs: 100, tokens: 1000, reservedCostMicros: 400 });
const pairs = (): D17Pair[] => ids.map((id, i) => ({ id, slice: D17_ANALYSIS.slices[i % 4]!, champion: arm(), challenger: arm() }));

describe('D17 frozen statistical protocol', () => {
  it('accepts the complete v1 design and rejects extra fields, changed intervals, support and caps', () => {
    expect(() => validateD17Analysis(D17_ANALYSIS)).not.toThrow();
    const changes = [
      { schemaVersion: 'decision-d17-protocol/v2' }, { extra: true }, { minimumPairs: 1199 }, { minimumPerSlice: 299 },
      { interval: { ...D17_ANALYSIS.interval, nonInferiorityMarginBps: -400 } },
      { interval: { ...D17_ANALYSIS.interval, method: 'wald' } },
      { interval: { ...D17_ANALYSIS.interval, levelBps: 9000 } },
      { interval: { ...D17_ANALYSIS.interval, benefitLowerExclusiveBps: -1 } },
      { brier: { ...D17_ANALYSIS.brier, maximumUpperBps: 201 } },
      { brier: { ...D17_ANALYSIS.brier, resamples: 100 } },
      { brier: { ...D17_ANALYSIS.brier, seed: 1 } },
      { risk: { ...D17_ANALYSIS.risk, maximumAcceptedErrorUpperBps: 501 } },
      { risk: { ...D17_ANALYSIS.risk, minimumCoverageLowerBps: 5999 } },
      { abstention: { ...D17_ANALYSIS.abstention, maximumUpperBps: 501 } },
      { maximumP95LatencyIncreaseMs: 15001 },
      { native: D17_ANALYSIS.native.map(row => ({ ...row, minimumPairs: 1199 })) },
      { economics: { ...D17_ANALYSIS.economics, separateTradeoffApprovalRequired: false } },
    ];
    for (const change of changes) expect(() => validateD17Analysis({ ...D17_ANALYSIS, ...change })).toThrow();
    expect(() => d17Statistics([], [], { ...D17_ANALYSIS, minimumPairs: 0 })).toThrow();
  });

  it('reports a non-inferior unchanged candidate without inventing a quality benefit or savings', () => {
    const rows = pairs();
    for (const row of rows) row.challenger.reservedCostMicros = 1200;
    const report = d17Statistics(rows, ids);
    expect(report.statisticalGate).toBe('pass');
    expect(report.findings).toEqual([]);
    expect(report.quality).toMatchObject({ estimateBps: 0, lowerBps: -32, upperBps: 32, n: 1200 });
    expect(report.quality!.lowerBps).toBeLessThan(0);
    expect(report.benefitSupported).toBe(false);
    expect(report.netSavingsMicros).toBe(-960000);
    expect(report.pairedDeltas.find(row => row.metric === 'cost')).toEqual({ metric: 'cost', pairs: 1200, delta: 800 });
    expect(report.slices.map(row => row.n)).toEqual([300, 300, 300, 300]);
  });

  it('withholds non-inferiority when the point estimate passes but the paired lower bound fails', () => {
    const rows = pairs();
    for (const row of rows.slice(0, 30)) row.challenger.correct = false;
    const report = d17Statistics(rows, ids);
    expect(report.quality!.estimateBps).toBe(-250);
    expect(report.quality!.lowerBps).toBeLessThan(-300);
    expect(report.findings).toContain('quality-ni');
    expect(report.findings).not.toContain('paired-delta-failed:quality');
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('requires a positive paired lower bound before reporting quality benefit', () => {
    const rows = pairs();
    for (const row of rows.slice(0, 120)) row.champion.correct = false;
    const report = d17Statistics(rows, ids);
    expect(report.quality!.estimateBps).toBe(1000);
    expect(report.quality!.lowerBps).toBeGreaterThan(0);
    expect(report.benefitSupported).toBe(true);
    expect(report.statisticalGate).toBe('pass');
  });

  it('enforces all native correctness and accepted-error point thresholds', () => {
    const rows = pairs();
    for (const row of rows.slice(0, 60)) row.challenger.correct = false;
    const report = d17Statistics(rows, ids);
    expect(report.pairedDeltas.find(row => row.metric === 'quality')!.delta).toBe(-0.05);
    expect(report.findings).toEqual(expect.arrayContaining(['paired-delta-failed:quality',
      'paired-delta-failed:slice', 'paired-delta-failed:risk-coverage']));
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('keeps slice support and harm visible even when aggregate quality is unchanged', () => {
    const rows = pairs();
    rows[0]!.slice = 'multi-fact';
    rows[4]!.challenger.correct = false;
    rows[5]!.champion.correct = false;
    const report = d17Statistics(rows, ids);
    expect(report.quality!.estimateBps).toBe(0);
    expect(report.findings).toContain('slice-insufficient:direct-facts');
    expect(report.slices.find(row => row.slice === 'direct-facts')).toMatchObject({ n: 299, descriptiveOnly: true, harm: true });
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('reports descriptive slice harm without inventing an unregistered per-slice inferiority gate', () => {
    const rows = pairs();
    rows[0]!.challenger.correct = false;
    rows[1]!.champion.correct = false;
    const report = d17Statistics(rows, ids);
    expect(report.slices.find(row => row.slice === 'direct-facts')).toMatchObject({ n: 300, harm: true, descriptiveOnly: true });
    expect(report.quality!.estimateBps).toBe(0);
    expect(report.statisticalGate).toBe('pass');
  });

  it('uses the accepted denominator and Wilson upper bound for risk rather than the point rate', () => {
    const rows = pairs();
    for (const row of rows.slice(0, 48)) row.champion.correct = row.challenger.correct = false;
    const report = d17Statistics(rows, ids);
    expect(report.acceptedErrors / report.acceptedN).toBe(0.04);
    expect(report.acceptedErrorUpperBps).toBeGreaterThan(500);
    expect(report.findings).toContain('accepted-risk-upper');
    expect(report.findings).not.toContain('paired-delta-failed:risk-coverage');
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('does not pass coverage by accepting exactly sixty percent with zero accepted errors', () => {
    const rows = pairs();
    for (const row of rows.slice(720)) {
      row.champion.accepted = row.challenger.accepted = false;
      row.champion.correct = row.challenger.correct = false;
    }
    const report = d17Statistics(rows, ids);
    expect(report.acceptedN).toBe(720);
    expect(report.acceptedErrors).toBe(0);
    expect(report.coverageLowerBps).toBeLessThan(6000);
    expect(report.findings).toContain('coverage-lower');
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('checks the paired abstention upper bound even when its point delta is below the cap', () => {
    const rows = pairs();
    for (const row of rows.slice(0, 48)) {
      row.champion.correct = row.challenger.correct = false;
      row.challenger.accepted = false;
    }
    const report = d17Statistics(rows, ids);
    expect(report.abstention!.estimateBps).toBe(400);
    expect(report.abstention!.upperBps).toBeGreaterThan(500);
    expect(report.findings).toContain('abstention-upper');
    expect(report.findings).not.toContain('paired-delta-failed:abstention');
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('uses the seeded paired Brier bootstrap upper bound rather than the mean tolerance', () => {
    const rows = pairs();
    for (const [i, row] of rows.entries()) {
      row.champion.brier = 0.25;
      row.challenger.brier = i < 690 ? 0.35 : 0.15;
    }
    const report = d17Statistics(rows, ids);
    expect(report.pairedDeltas.find(row => row.metric === 'calibration')!.delta).toBeCloseTo(0.015);
    expect(report.brier!.upperBps).toBeGreaterThan(200);
    expect(report.findings).toContain('brier-upper');
    expect(report.findings).not.toContain('paired-delta-failed:calibration');
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('checks the p95 latency cap even when mean latency is within its native tolerance', () => {
    const rows = pairs();
    for (const row of rows.slice(0, 72)) row.challenger.latencyMs += 15001;
    const report = d17Statistics(rows, ids);
    expect(report.p95LatencyIncreaseMs).toBe(15001);
    expect(report.latencyDifferencesMs.filter(value => value === 15001)).toHaveLength(72);
    expect(report.findings).toContain('latency-p95');
    expect(report.findings).not.toContain('paired-delta-failed:latency');
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('accepts the inclusive p95 and token caps', () => {
    const rows = pairs();
    for (const row of rows.slice(0, 72)) row.challenger.latencyMs += 15000;
    for (const row of rows) row.challenger.tokens = 9000;
    const report = d17Statistics(rows, ids);
    expect(report.p95LatencyIncreaseMs).toBe(15000);
    expect(report.pairedDeltas.find(row => row.metric === 'tokens')!.delta).toBe(8000);
    expect(report.statisticalGate).toBe('pass');
  });

  it.each([
    ['cost', 'reservedCostMicros', 1201], ['tokens', 'tokens', 9001],
    ['latency', 'latencyMs', 10101], ['calibration', 'brier', 0.031],
  ] as const)('holds a candidate exceeding the native %s threshold', (metric, field, value) => {
    const rows = pairs();
    for (const row of rows) row.challenger[field] = value;
    const report = d17Statistics(rows, ids);
    expect(report.findings).toContain(`paired-delta-failed:${metric}`);
    expect(report.statisticalGate).toBe('HOLD');
    if (metric === 'cost') expect(report.netSavingsMicros).toBe(-961200);
  });

  it('holds unknown token totals instead of interpreting them as zero', () => {
    const rows = pairs();
    rows[0]!.challenger.tokens = null;
    const report = d17Statistics(rows, ids);
    expect(report.pairedDeltas.find(row => row.metric === 'tokens')).toEqual({ metric: 'tokens', pairs: 1199, delta: 0 });
    expect(report.findings).toContain('paired-delta-insufficient:tokens');
    expect(report.statisticalGate).toBe('HOLD');
  });

  it('rejects unknown costs, invalid measurements, duplicate rows and foreign membership', () => {
    for (const value of [null, undefined, Number.NaN, Infinity, -1]) {
      const rows = pairs();
      rows[0]!.challenger.reservedCostMicros = value as number;
      expect(() => d17Statistics(rows, ids)).toThrow('measurement');
    }
    const invalid = pairs();
    invalid[0]!.challenger.accepted = false;
    expect(() => d17Statistics(invalid, ids)).toThrow('measurement');
    const duplicate = pairs();
    duplicate[1]!.id = duplicate[0]!.id;
    expect(() => d17Statistics(duplicate, ids)).toThrow('membership');
    expect(() => d17Statistics(pairs(), [...ids.slice(1), 'foreign'])).toThrow('membership');
    expect(() => d17Statistics(pairs(), [...ids, ids[0]!])).toThrow('membership');
  });

  it('retains completed observations and counts missing pairs as worst-case errors', () => {
    const report = d17Statistics(pairs().slice(1), ids);
    expect(report.sampleN).toBe(1199);
    expect(report.missingIds).toEqual(['test-0']);
    expect(report.worstCaseFailureAsError).toEqual({ n: 1200, championCorrect: 1199,
      challengerCorrect: 1199, missingPairsCountedAsErrors: 1 });
    expect(report.findings).toContain('incomplete-pairs');
    expect(report.statisticalGate).toBe('HOLD');
    const empty = d17Statistics([], ids);
    expect(empty.sampleN).toBe(0);
    expect(empty.acceptedErrorUpperBps).toBeNull();
    expect(empty.coverageLowerBps).toBeNull();
    expect(empty.statisticalGate).toBe('HOLD');
  });
});
