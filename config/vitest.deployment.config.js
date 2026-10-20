import base from './vitest.config.js';
import { deploymentFiles } from './test-lanes.mjs';

// Full-corpus provider deployment is a required, deterministic offline lane.
// Keep both files in one process-wide run so they share the reviewed immutable
// source caches without competing with the general test worker pool.
export default {
  ...base,
  test: {
    ...base.test,
    include: deploymentFiles,
    exclude: ['node_modules/**', 'dist/**'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    isolate: true,
  },
};
