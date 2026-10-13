// Synthetic fixture for the CLI perf measurement regression test
// (test/integration/cli-perf.test.ts, #3047 follow-up). Not part of the real
// CLI -- a throwaway script that optionally burns real CPU for
// `AIWG_PERF_TEST_CPU_BURN_MS` milliseconds before exiting, so the test can
// prove the CPU-time measurement pipeline (spawn + cpu-usage-preload.cjs +
// summarizePairedTimings) catches an injected regression end to end, not
// just that its pure math does (see test/unit/cli/perf-policy.test.ts).
const burnMs = Number(process.env.AIWG_PERF_TEST_CPU_BURN_MS ?? 0);
if (burnMs > 0) {
  const start = Date.now();
  // A tight spin, not a sleep: sleeping would cost wall time, not CPU time,
  // and this fixture exists specifically to cost real CPU.
  while (Date.now() - start < burnMs) {
    // eslint-disable-next-line no-empty -- deliberate CPU-burning spin
    for (let i = 0; i < 1e5; i += 1) { /* burn */ }
  }
}
