import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluateBinaryHeldout, evaluatePreregisteredBinaryBenchmark, freezeBinaryBenchmarkPlan,
  freezeQualificationSplit, verifyBinaryBenchmarkPlanDigest,
} from '../../../src/decision/qualification/quality.js';
import {
  buildQualificationReleaseRecord, verifyQualificationReleaseDigest,
} from '../../../src/decision/qualification/release.js';
import { legacySha256 } from '../../../src/gates/stats/digest.js';
import { syntheticReleaseInput } from './digest-helper.js';

const splits = () => [
  freezeQualificationSplit('tuning', ['train-1']),
  freezeQualificationSplit('calibration', ['cal-1']),
  freezeQualificationSplit('test', ['test-1', 'test-2']),
];
const labels = ['train-1', 'cal-1', 'test-1', 'test-2'].map(id => ({ id, label: 1 as const, slice: 'a' }));
const limits = { minimumOverallN: 2, minimumSliceN: 1, maximumSelectiveRisk: 0.1, maximumReviewRate: 0.5, maximumBrier: 0.2 };
const sample = (id: string) => ({
  id, slice: 'a', label: 1 as const, probability: 0.8, accepted: true, latencyMs: 10,
  inputTokens: 3, outputTokens: 2, costUsd: 0.01, calls: 1, retries: 0, fallbacks: 0,
});

/** A pre-migration plan: identical fields, JSON.stringify digest, original key order. */
const legacyPlan = () => {
  const plan = freezeBinaryBenchmarkPlan(splits(), labels, limits);
  const { digest: _dropped, ...fields } = plan;
  void _dropped;
  return { ...fields, digest: legacySha256(fields) };
};

describe('qualification digest migration', () => {
  it('writes canonical digests for new benchmark plans', () => {
    const plan = freezeBinaryBenchmarkPlan(splits(), labels, limits);
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels)).toBe('canonical');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['canonical'] })).toBe('canonical');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['legacy'] })).toBeNull();
    // Canonical bytes differ from the legacy encoding for the same plan.
    expect(plan.digest).not.toBe(legacyPlan().digest);
    // Membership digests over sorted string arrays are byte-identical in both modes.
    expect(plan.splits[2]!.digest).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(['test-1', 'test-2'])).digest('hex')}`);
  });

  it('still verifies legacy plans by default and rejects them in canonical-only mode', () => {
    const plan = legacyPlan();
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels)).toBe('legacy');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['legacy'] })).toBe('legacy');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['canonical'] })).toBeNull();
    const rows = [sample('test-1'), sample('test-2')];
    expect(evaluatePreregisteredBinaryBenchmark(plan, plan.digest, labels, rows).decision).toBe('pass');
    expect(() => evaluatePreregisteredBinaryBenchmark(plan, plan.digest, labels, rows, { digestModes: ['canonical'] }))
      .toThrow('preregistration');
    expect(verifyBinaryBenchmarkPlanDigest({ ...plan, minimumOverallN: 99 }, labels)).toBeNull();
  });

  it('scores held-out samples identically before and after the move', () => {
    const rows = [sample('test-1'), sample('test-2')];
    const plan = freezeBinaryBenchmarkPlan(splits(), labels, limits);
    expect(evaluatePreregisteredBinaryBenchmark(plan, plan.digest, labels, rows)).toMatchObject({
      decision: 'pass', reasons: [],
    });
    const metrics = evaluateBinaryHeldout(splits(), rows);
    expect(metrics.overall).toMatchObject({ sampleN: 2, coverage: 1, selectiveRisk: 0, reviewRate: 0 });
    expect(metrics.overall.brier).toBeCloseTo(0.04);
  });

  it('writes canonical release digests and verifies both modes', () => {
    const { executed, input } = syntheticReleaseInput();
    const record = buildQualificationReleaseRecord(executed, input);
    expect(verifyQualificationReleaseDigest(record)).toBe('canonical');
    expect(verifyQualificationReleaseDigest(record, { digestModes: ['canonical'] })).toBe('canonical');
    const { digest: _dropped, ...fields } = record;
    void _dropped;
    const legacy = { ...fields, digest: legacySha256(fields) };
    expect(verifyQualificationReleaseDigest(legacy)).toBe('legacy');
    expect(verifyQualificationReleaseDigest(legacy, { digestModes: ['canonical'] })).toBeNull();
    expect(verifyQualificationReleaseDigest({ ...legacy, decision: 'PROMOTE' as const })).toBeNull();
  });
});
