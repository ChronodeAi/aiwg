import base from './vitest.config.js';
import { d17SlowFiles, d29SlowFiles } from './test-lanes.mjs';
// Heavy D29 study suites (multi-seed scans, positive controls, repeated audits)
// and the heavy D17 staged-calibration suite, in their own CI job; see config/test-lanes.mjs.
export default {
  ...base,
  test: { ...base.test, include: [...d29SlowFiles, ...d17SlowFiles], exclude: [], maxWorkers: 4, minWorkers: 1 },
};
