import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for the WD-001 fake-worker-CLI UAT lane (#3045's
 * `doctor --probe-workers` readiness matrix).
 *
 * Modeled on `config/vitest.uat-live.config.js`: NOT included in CI by
 * default — run on demand:
 *   npm run uat:workers-live
 *
 * Unlike the other "-live" lanes, nothing here spends a model call or talks
 * to a real worker CLI account: every CLI is a fixture script this suite
 * writes itself (present-in-range, absent, out-of-range banners). It is
 * opt-in rather than part of the stub lane because it spawns the real
 * `aiwg doctor --probe-workers` subprocess probes against those fixtures —
 * heavier and slower than the rest of the stub lane, and kept separate so a
 * flake in process-probe timing never blocks the fast default `npm run uat`.
 *
 * Gate: set AIWG_UAT_WORKERS_LIVE_REQUIRED=1 to run for real (the npm script
 * below does this). Without it, the suite still runs (nothing here needs an
 * external dependency to skip around) — the variable exists for parity with
 * the other opt-in lanes and as an explicit, greppable "this ran on
 * purpose" marker in CI logs.
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, '..'),
  test: {
    include: ['test/uat/worker-probe-fake-clis.uat.ts'],
    environment: 'node',
    globals: false,
    clearMocks: false,
    mockReset: false,
    restoreMocks: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '../src'),
    },
    extensions: ['.ts', '.js', '.json'],
  },
});
