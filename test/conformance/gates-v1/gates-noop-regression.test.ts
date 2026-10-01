import { describe, expect, it } from 'vitest';
import * as quality from '../../../src/decision/qualification/quality.js';
import * as release from '../../../src/decision/qualification/release.js';
import * as gates from '../../../src/gates/index.js';

/**
 * The gates evaluator is disabled by default: no decision-runtime path evaluates
 * gate packs, so existing behavior must be byte-identical. The decision runtime
 * reuses only the moved statistics and digest helpers from `src/gates/stats`
 * (quality.ts, release.ts, gate-evidence.ts); the evaluator, registry and report
 * modules have no decision-runtime importers. This locks the decision surface
 * the migration touched (exact export sets, so consumer churn is always
 * deliberate) and spot-checks benchmark behavior through the canonical digest
 * path.
 */
describe('gates disabled-by-default regression', () => {
  it('keeps the exact pre-move export surface, plus the two migration additions', () => {
    expect(new Set(Object.keys(quality))).toEqual(new Set([
      'freezeBinaryBenchmarkPlan', 'verifyBinaryBenchmarkPlanDigest', 'evaluatePreregisteredBinaryBenchmark',
      'evaluateBinaryHeldout', 'evaluateOrdinalHeldout', 'evaluateRankingHeldout', 'measurePairedMovement',
      'freezeQualificationSplit', 'verifyQualificationSplits', 'PairedDifferenceError', 'normalQuantile',
      'pairedBinaryDifferenceInterval', 'pairedMeanDifferenceBootstrap', 'pairedNonInferiority',
      'wilsonScoreInterval', 'clopperPearsonInterval',
    ]));
    expect(new Set(Object.keys(release))).toEqual(new Set([
      'VERIFIED_QUALIFICATION_INTEGRITY_SOURCES', 'qualificationIntegrityAllowlistProblems',
      'QUALIFICATION_CACHE_LAYERS', 'deriveCacheLayerPins', 'buildQualificationReleaseRecord',
      'verifyQualificationReleaseDigest', 'qualificationReleaseSummary',
    ]));
  });

  it('re-exports the moved statistics by reference from their new home', async () => {
    const stats = await import('../../../src/gates/stats/index.js');
    for (const name of ['PairedDifferenceError', 'normalQuantile', 'pairedBinaryDifferenceInterval',
      'pairedMeanDifferenceBootstrap', 'pairedNonInferiority', 'wilsonScoreInterval',
      'freezeQualificationSplit', 'verifyQualificationSplits'] as const) {
      expect((quality as Record<string, unknown>)[name]).toBe((stats as Record<string, unknown>)[name]);
    }
    expect(quality.clopperPearsonInterval).toBe(stats.clopperPearsonInterval);
  });

  it('reaches the same benchmark verdicts through canonical digests', () => {
    const splits = [
      quality.freezeQualificationSplit('tuning', ['train-1']),
      quality.freezeQualificationSplit('calibration', ['cal-1']),
      quality.freezeQualificationSplit('test', ['test-1', 'test-2']),
    ];
    const labels = ['train-1', 'cal-1', 'test-1', 'test-2'].map(id => ({ id, label: 1 as const, slice: 'a' }));
    const limits = { minimumOverallN: 2, minimumSliceN: 1, maximumSelectiveRisk: 0.1, maximumReviewRate: 0.5, maximumBrier: 0.2 };
    const rows = ['test-1', 'test-2'].map(id => ({
      id, slice: 'a', label: 1 as const, probability: 0.8, accepted: true, latencyMs: 10,
      inputTokens: 3, outputTokens: 2, costUsd: 0.01, calls: 1, retries: 0, fallbacks: 0,
    }));
    const plan = quality.freezeBinaryBenchmarkPlan(splits, labels, limits);
    expect(quality.evaluatePreregisteredBinaryBenchmark(plan, plan.digest, labels, rows).decision).toBe('pass');
    const strict = quality.freezeBinaryBenchmarkPlan(splits, labels, { ...limits, maximumBrier: 0.01 });
    expect(quality.evaluatePreregisteredBinaryBenchmark(strict, strict.digest, labels, rows)).toMatchObject({
      decision: 'fail', reasons: expect.arrayContaining(['brier']),
    });
    expect(Object.keys(gates)).toContain('evaluateGates');
  });
});
