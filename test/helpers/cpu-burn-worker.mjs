// Busy-loop worker for admission-time-budget tests (#3047 follow-up): burns
// real CPU on its own thread for `workerData.ms` milliseconds (a tight spin,
// not a sleep) so a parent-thread test can verify that `process.cpuUsage()`
// (process-wide) picks up this thread's CPU time while
// `process.threadCpuUsage()` (per-thread) does not.
import { parentPort, workerData } from 'node:worker_threads';

const ms = workerData?.ms ?? 1000;
const start = Date.now();
while (Date.now() - start < ms) {
  // eslint-disable-next-line no-empty -- deliberate CPU-burning spin, not a sleep
  for (let i = 0; i < 1e5; i += 1) { /* burn */ }
}
parentPort?.postMessage('done');
