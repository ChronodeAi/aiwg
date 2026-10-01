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

/** A pre-migration v1 plan: v1 fields with a JSON.stringify digest. */
const legacyPlan = () => {
  const plan = freezeBinaryBenchmarkPlan(splits(), labels, limits);
  const { digest: _dropped, ...fields } = plan;
  void _dropped;
  const v1fields = { ...fields, schemaVersion: 'decision-binary-benchmark-plan/v1' as const };
  return { ...v1fields, digest: legacySha256(v1fields) };
};

/** A freshly built (v2) plan with a legacy digest: must never verify. */
const freshLegacyPlan = () => {
  const plan = freezeBinaryBenchmarkPlan(splits(), labels, limits);
  const { digest: _dropped, ...fields } = plan;
  void _dropped;
  return { ...fields, digest: legacySha256(fields) };
};

describe('qualification digest migration', () => {
  it('writes canonical v2 digests for new benchmark plans', () => {
    const plan = freezeBinaryBenchmarkPlan(splits(), labels, limits);
    expect(plan.schemaVersion).toBe('decision-binary-benchmark-plan/v2');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels)).toBe('canonical');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['canonical'] })).toBe('canonical');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['legacy'] })).toBeNull();
    // A legacy digest on freshly built v2 fields never verifies, even allowlisted.
    expect(verifyBinaryBenchmarkPlanDigest(freshLegacyPlan() as never, labels, { digestModes: ['canonical', 'legacy'] })).toBeNull();
    // Canonical bytes differ from the legacy encoding for the same plan.
    expect(plan.digest).not.toBe(legacyPlan().digest);
    // Membership digests over sorted string arrays are byte-identical in both modes.
    expect(plan.splits[2]!.digest).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(['test-1', 'test-2'])).digest('hex')}`);
  });

  it('rejects v1 legacy plans by default and verifies them only under an explicit allowlist', () => {
    const plan = legacyPlan();
    expect(plan.schemaVersion).toBe('decision-binary-benchmark-plan/v1');
    // Fail closed: a legacy digest on plan fields never verifies by default.
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels)).toBeNull();
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['canonical'] })).toBeNull();
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['legacy'] })).toBe('legacy');
    expect(verifyBinaryBenchmarkPlanDigest(plan, labels, { digestModes: ['canonical', 'legacy'] })).toBe('legacy');
    const rows = [sample('test-1'), sample('test-2')];
    expect(() => evaluatePreregisteredBinaryBenchmark(plan, plan.digest, labels, rows))
      .toThrow('preregistration');
    expect(evaluatePreregisteredBinaryBenchmark(plan, plan.digest, labels, rows, { digestModes: ['canonical', 'legacy'] }).decision)
      .toBe('pass');
    expect(verifyBinaryBenchmarkPlanDigest({ ...plan, minimumOverallN: 99 }, labels, { digestModes: ['canonical', 'legacy'] }))
      .toBeNull();
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

  it('writes canonical v2 release digests and rejects legacy digests by default', () => {
    const { executed, input } = syntheticReleaseInput();
    const record = buildQualificationReleaseRecord(executed, input);
    expect(record.schemaVersion).toBe('decision-qualification-release/v2');
    expect(verifyQualificationReleaseDigest(record)).toBe('canonical');
    expect(verifyQualificationReleaseDigest(record, { digestModes: ['canonical'] })).toBe('canonical');
    const { digest: _dropped, ...fields } = record;
    void _dropped;
    // A legacy digest on freshly built v2 fields never verifies, even allowlisted.
    const freshLegacy = { ...fields, digest: legacySha256(fields) };
    expect(verifyQualificationReleaseDigest(freshLegacy)).toBeNull();
    expect(verifyQualificationReleaseDigest(freshLegacy, { digestModes: ['canonical'] })).toBeNull();
    expect(verifyQualificationReleaseDigest(freshLegacy, { digestModes: ['canonical', 'legacy'] })).toBeNull();
    // Pre-migration v1 records with a legacy digest still verify under allowlist.
    const v1fields = { ...fields, schemaVersion: 'decision-qualification-release/v1' as const };
    const legacy = { ...v1fields, digest: legacySha256(v1fields) };
    expect(verifyQualificationReleaseDigest(legacy)).toBeNull();
    expect(verifyQualificationReleaseDigest(legacy, { digestModes: ['canonical'] })).toBeNull();
    expect(verifyQualificationReleaseDigest(legacy, { digestModes: ['canonical', 'legacy'] })).toBe('legacy');
    expect(verifyQualificationReleaseDigest({ ...legacy, decision: 'PROMOTE' as const }, { digestModes: ['canonical', 'legacy'] }))
      .toBeNull();
  });
});
