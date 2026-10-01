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
