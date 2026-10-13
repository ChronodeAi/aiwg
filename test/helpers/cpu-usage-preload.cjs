'use strict';

// CPU-time reporter for the CLI perf gate (test/integration/cli-perf.test.ts,
// #3047 follow-up).
//
// `spawnSync` does not expose the child's own CPU usage (no rusage), so the
// child reports it itself: this module is preloaded via `node --require
// <this file>` into every process the perf gate spawns -- both the measured
// `aiwg` command and its paired bare-`node` baseline -- and writes
// `process.cpuUsage()` (the process's own user+system CPU time, in
// microseconds, since process start) to fd 3 when the process exits.
//
// CPU time is immune to the host-scheduling contention that made the wall-
// clock version of this gate false-positive under load (#3047): a process
// waiting for a CPU timeslice does not accumulate CPU time, only time it is
// actually running. `process.cpuUsage()` with no argument returns usage
// since process start, aggregated across every OS thread in the process
// (same semantics as `getrusage(RUSAGE_SELF)`), so it also captures work
// libuv's threadpool did on this process's behalf, not just the main
// thread's -- unlike `process.threadCpuUsage()`, which measures only the
// calling thread and is the wrong tool here (the measured unit is a whole
// child process, not a thread inside the measuring process).
process.on('exit', () => {
  const usage = process.cpuUsage();
  try {
    require('fs').writeSync(3, JSON.stringify({ userUs: usage.user, systemUs: usage.system }));
  } catch {
    // fd 3 is not open (e.g. this module loaded outside the perf harness,
    // or the measured command's own stdio wiring doesn't provide it) --
    // nothing to report, and the perf harness treats a missing report as a
    // measurement failure, not a silent zero.
  }
});
