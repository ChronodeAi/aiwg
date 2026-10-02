import base from './vitest.config.js';
import { d29SlowFiles } from './test-lanes.mjs';
// Heavy D29 study suites (multi-seed scans, positive controls, repeated audits)
// in their own CI job; see config/test-lanes.mjs.
export default {
  ...base,
  test: { ...base.test, include: d29SlowFiles, exclude: [], maxWorkers: 4, minWorkers: 1 },
};
