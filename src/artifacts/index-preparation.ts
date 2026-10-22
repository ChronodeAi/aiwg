/** Bounded artifact-local preparation; ordered graph reduction stays in index-builder. */
import os from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { signalChild } from '../process/signal-child.mjs';
import type { MetadataEntry } from './types.js';
export interface IndexPreparationJob { fullPath: string; relativePath: string; mtimeMs: number; birthtimeMs: number; sizeBytes: number; existingChecksum?: string }
export interface IndexPreparationResult { checksum: string; entry?: MetadataEntry }

const MIB = 1024 ** 2;
const WORKER_HEAP_MB = 256;
// Leave room for V8's young generation, executable code, IPC and native allocations.
const WORKER_BUDGET_BYTES = 512 * MIB;
// Parsing and metadata extraction amplify input size; do large files only after the pool exits.
const MAX_WORKER_ARTIFACT_BYTES = MIB;

export function resolveIndexWorkers(requested?: number | string, env = process.env): number | undefined {
  const value = requested ?? env.AIWG_INDEX_WORKERS;
  if (requested === undefined && (value === undefined || value === '')) return undefined;
  if ((typeof value === 'string' && !/^\d+$/.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    throw new Error(`${requested === undefined ? 'AIWG_INDEX_WORKERS' : '--index-workers'} must be a nonnegative safe integer (0 = serial)`);
  }
  return Number(value);
}

export function indexPreparationWorkers(jobs: number, requested?: number,
  cores = os.availableParallelism(), memory = Math.min(os.freemem(), process.availableMemory?.() ?? Infinity), totalBytes = 0): number {
  requested = resolveIndexWorkers(requested);
  if (jobs < 64 || cores < 3 || requested === 0 || requested === 1) return 0;
  // Process startup costs dominate lightweight scans even at thousands of files.
  // Explicit requests bypass only this conservative automatic workload gate.
  if (requested === undefined && (jobs < 1000 || !Number.isFinite(totalBytes) || totalBytes < 16 * MIB)) return 0;
  const byMemory = Math.floor((memory - 512 * MIB) / WORKER_BUDGET_BYTES);
  const bounded = Math.max(0, Math.min(requested ?? 4, 4, cores - 1, byMemory, jobs));
  return bounded >= 2 ? bounded : 0;
}

export async function runIndexPreparation(jobs: IndexPreparationJob[], serial: (job: IndexPreparationJob) => IndexPreparationResult,
  moduleUrl: string, requested?: number, onDiagnostic?: (message: string) => void,
): Promise<{ results: IndexPreparationResult[]; workerCount: number; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const diagnose = (message: string) => { diagnostics.push(message); onDiagnostic?.(message); };
  const eligible = jobs.map((job, index) => ({ job, index })).filter(({ job }) =>
    Number.isFinite(job.sizeBytes) && job.sizeBytes >= 0 && job.sizeBytes <= MAX_WORKER_ARTIFACT_BYTES);
  const workerCount = indexPreparationWorkers(eligible.length, requested, undefined, undefined,
    eligible.reduce((total, { job }) => total + job.sizeBytes, 0));
  if (!workerCount) return { results: jobs.map(serial), workerCount: 0, diagnostics };
  const results: IndexPreparationResult[] = new Array(jobs.length), workers: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  let next = 0, completed = 0, stopped = false;
  try {
    await new Promise<void>((resolve, reject) => {
      // Stop dispatch on a process failure. Reap the entire pool before retrying
      // unfinished work in the main isolate, avoiding overlapping memory peaks.
      const recover = (message: string) => {
        if (stopped) return;
        stopped = true;
        diagnose(`${message}; retrying unfinished preparation serially`);
        resolve();
      };
      const dispatch = (worker: ChildProcess) => {
        if (stopped || next >= eligible.length) return;
        const { index, job } = eligible[next++];
        try {
          worker.send({ index, job }, error => { if (error) recover(`Index preparation IPC failed for ${job.relativePath}: ${error.message}`); });
        } catch (error) {
          recover(`Index preparation IPC failed for ${job.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      for (let index = 0; index < workerCount && !stopped; index++) {
        // A worker_threads resourceLimit is not a process boundary: V8 can abort
        // Node during allocation before its isolate-limit error is delivered.
        // A child heap fatal/SIGABRT is instead an ordinary, recoverable exit.
        const worker = fork(new URL('./index-worker.mjs', import.meta.url), [moduleUrl], {
          execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`, '--max-semi-space-size=16'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
        });
        workers.push(worker);
        closed.push(new Promise(done => worker.once('close', () => done())));
        let stderr = '';
        let activePath = '<startup>';
        worker.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
        worker.on('error', error => recover(`Index preparation worker failed for ${activePath}: ${error.message}`));
        worker.on('exit', (code, signal) => {
          const oom = /heap out of memory|ERR_WORKER_OUT_OF_MEMORY/i.test(stderr) ? ' (heap out of memory)' : '';
          recover(`Index preparation worker exited early for ${activePath} (${signal ?? code})${oom}`);
        });
        worker.on('message', (message: { index: number; result: IndexPreparationResult; error?: string }) => {
          if (stopped) return;
          if (message.error) { stopped = true; reject(new Error(message.error)); return; }
          results[message.index] = message.result; completed++;
          if (completed === eligible.length) { stopped = true; resolve(); }
          else {
            activePath = eligible[next]?.job.relativePath ?? '<idle>';
            dispatch(worker);
          }
        });
        activePath = eligible[next]?.job.relativePath ?? '<idle>';
        dispatch(worker);
      }
    });
  } finally {
    stopped = true;
    for (const worker of workers) if (worker.exitCode === null && worker.signalCode === null) signalChild(worker, 'SIGKILL');
    await Promise.all(closed);
  }
  const largeCount = jobs.length - eligible.length;
  if (largeCount) diagnose(`${largeCount} artifact(s) above the worker size threshold prepared serially`);
  for (let index = 0; index < jobs.length; index++) {
    if (!results[index]) {
      try { results[index] = serial(jobs[index]); }
      catch (error) { throw new Error(`${jobs[index].relativePath}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return { results, workerCount, diagnostics };
}
