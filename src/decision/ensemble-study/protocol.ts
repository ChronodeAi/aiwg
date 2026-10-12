import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { admitEntry } from '../entry.js';
import type { PairedMetricThreshold } from '../ensemble/types.js';

/** Frozen synthetic-population protocol. A changed threshold requires a new preregistration. */
export const D17_ANALYSIS = {
  schemaVersion: 'decision-d17-protocol/v1',
  minimumPairs: 1200,
  slices: ['direct-facts', 'multi-fact', 'negation', 'authority'],
  minimumPerSlice: 300,
  interval: { method: 'newcombe-10', levelBps: 9500, nonInferiorityMarginBps: -300, benefitLowerExclusiveBps: 0 },
  brier: { method: 'percentile-bootstrap', levelBps: 9500, seed: 2611, resamples: 20000, maximumUpperBps: 200 },
  risk: { method: 'wilson', levelBps: 9500, maximumAcceptedErrorUpperBps: 500, minimumCoverageLowerBps: 6000 },
  abstention: { method: 'newcombe-10', levelBps: 9500, maximumUpperBps: 500 },
  maximumP95LatencyIncreaseMs: 15000,
  acceptance: { tieRule: 'defer', disagreementMetric: 'jensen-shannon-v1', maximumDisagreementBps: 1000,
    minimumSuccessfulMembers: 3, highAgreementWarningBps: 100 },
  economics: { kind: 'additional-cost-tolerance', positiveNetSavingsRequired: false, separateTradeoffApprovalRequired: true },
  native: [
    { metric: 'quality', comparison: 'delta-at-least', bound: -0.03, minimumPairs: 1200 },
    { metric: 'calibration', comparison: 'delta-at-most', bound: 0.02, minimumPairs: 1200 },
    { metric: 'risk-coverage', comparison: 'delta-at-most', bound: 0.01, minimumPairs: 1200 },
    { metric: 'abstention', comparison: 'delta-at-most', bound: 0.05, minimumPairs: 1200 },
    { metric: 'latency', comparison: 'delta-at-most', bound: 10000, minimumPairs: 1200 },
    { metric: 'tokens', comparison: 'delta-at-most', bound: 8000, minimumPairs: 1200 },
    { metric: 'cost', comparison: 'delta-at-most', bound: 800, minimumPairs: 1200 },
    { metric: 'slice', comparison: 'delta-at-least', bound: -0.03, minimumPairs: 1200 },
  ] satisfies PairedMetricThreshold[],
} as const;

const here = dirname(fileURLToPath(import.meta.url));
const schema = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
  .map(directory => resolve(directory, 'D17StudyProtocol.v1.schema.json')).find(existsSync);
if (!schema) throw new Error('D17 protocol schema is unavailable');
const validator = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(schema, 'utf8')));
export function validateD17Analysis(value: unknown): asserts value is typeof D17_ANALYSIS {
  admitEntry(value);
  if (!validator(value)) throw new Error('D17 protocol differs from the frozen v1 design');
}

/**
 * Frozen staged D09 calibration protocol (#2611). It is preregistered through the v2 analysis and
 * applies only to a `calibrated`/`staged` preregistration; the v1 diagnostic protocol is unchanged.
 * The member calibrator maps one fresh call's native P(yes); the aggregate calibrator maps the raw
 * mean P(yes) of the three ensemble members. Both are fitted on calibration-split rows only.
 */
export const D17_CALIBRATION = {
  schemaVersion: 'decision-d17-calibration-protocol/v1',
  phaseSplits: ['tuning', 'calibration'],
  fitSplit: 'calibration',
  method: 'isotonic-pav-laplace-v1',
  smoothing: 'laplace-1',
  minimumBlockN: 10,
  calibrators: {
    member: { id: 'd17-single-call-isotonic', version: '1', input: 'single-call-yes-probability',
      requests: ['champion', 'member_1', 'member_2', 'member_3'] },
    aggregate: { id: 'd17-three-sample-mean-isotonic', version: '1', input: 'three-sample-mean-yes-probability',
      requests: ['member_1', 'member_2', 'member_3'] },
  },
  application: { champion: 'member', challenger: 'aggregate', tie: 'defer',
    acceptance: 'calibrated-yes-probability-not-0.5-and-native-aggregate-accept' },
  metricsArm: { member: 'champion', aggregate: 'challenger' },
  // Qualification metrics are out-of-fold: each calibration row is scored by calibrators fitted without it.
  qualificationMetrics: { method: 'slice-stratified-k-fold-out-of-fold', folds: 5,
    assignment: 'row-id-order-within-slice-modulo-folds', finalMapping: 'full-calibration-split' },
  profile: { minimumTotalSamples: 380, minimumPerSliceSamples: 95, powerRule: null,
    confidenceInterval: { method: 'wilson', level: 0.95 }, maximumCalibrationError: 0.1, maximumSelectiveRisk: 0.1, expiresAfterDays: 30 },
  developmentReview: { stage: 'development', assessments: 40,
    requiredFor: ['phase-bundle', 'calibration-fit', 'calibration-registration', 'test-scoring'],
    approvalBinding: 'calibration-phase approvalReference cites the development review digest' },
  promotion: { studyDecision: 'HOLD-or-ROLLBACK', route: 'D09 PromotionEligibility + promoteChampionChallenger',
    requires: ['locked-snapshot integrity gate PROMOTE', 'statistical gate pass', 'positive quality lower bound',
      'anchored extra-cost tradeoff approval', 'D09 promotion eligibility'] },
  calibrationSetBinding: 'approval.calibration.calibrationArtifactDigest = heldoutDigest(decision-d17-calibration-set/v1)',
} as const;
