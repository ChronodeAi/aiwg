import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..'),
  test: {
    include: ['test/evidence/s2-scheduler-traces.test.ts'],
    environment: 'node',
    // MC session paths are relative to cwd. A single fork keeps them isolated.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10000,
    hookTimeout: 10000,
    restoreMocks: true,
  },
});
