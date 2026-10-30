import base from './vitest.config.js';
import { artifactIndexFiles } from './test-lanes.mjs';

export default {
  ...base,
  test: {
    ...base.test,
    include: artifactIndexFiles,
    globalSetup: ['./test/helpers/prebuilt-relations-setup.mjs'],
    exclude: ['node_modules/**', 'dist/**'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
};
