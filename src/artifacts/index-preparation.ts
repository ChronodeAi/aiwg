/** Bounded artifact-local preparation; ordered graph reduction stays in index-builder. */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { MetadataEntry } from './types.js';
export interface IndexPreparationJob { fullPath: string; relativePath: string; mtimeMs: number; birthtimeMs: number; sizeBytes: number; existingChecksum?: string }
export interface IndexPreparationResult { checksum: string; entry?: MetadataEntry }

export function indexPreparationWorkers(jobs: number, requested?: number,
  cores = os.availableParallelism(), memory = Math.min(os.freemem(), process.availableMemory?.() ?? Infinity), totalBytes = 0): number {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 0)) throw new Error('Index workers must be a nonnegative integer');
  if (jobs < 64 || cores < 3 || requested === 0 || requested === 1) return 0;
  // Thread startup costs dominate lightweight scans even at thousands of files.
  // Explicit thread requests bypass only this conservative automatic workload gate.
  if (requested === undefined && (jobs < 1000 || !Number.isFinite(totalBytes) || totalBytes < 16 * 1024 ** 2)) return 0;
  const byMemory = Math.floor((memory - 512 * 1024 ** 2) / (256 * 1024 ** 2));
  const bounded = Math.max(0, Math.min(requested ?? 4, 4, cores - 1, byMemory, jobs));
  return bounded >= 2 ? bounded : 0;
}

export async function runIndexPreparation(jobs: IndexPreparationJob[], serial: (job: IndexPreparationJob) => IndexPreparationResult,
  moduleUrl: string, requested?: number): Promise<{ results: IndexPreparationResult[]; workerCount: number }> {
  const workerCount = indexPreparationWorkers(jobs.length, requested, undefined, undefined,
    jobs.reduce((total, job) => total + job.sizeBytes, 0));
  if (!workerCount) return { results: jobs.map(serial), workerCount: 0 };
  const results: IndexPreparationResult[] = new Array(jobs.length), workers: Worker[] = [];
  let next = 0, completed = 0, stopped = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { stopped = true; reject(error); };
      const dispatch = (worker: Worker) => {
        if (!stopped && next < jobs.length) { const index = next++; worker.postMessage({ index, job: jobs[index] }); }
      };
      for (let index = 0; index < workerCount; index++) {
        const worker = new Worker(new URL('./index-worker.mjs', import.meta.url), {
          workerData: { moduleUrl }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        workers.push(worker);
        worker.on('error', fail);
        worker.on('exit', code => { if (!stopped && completed < jobs.length) fail(new Error(`Index preparation worker exited early (${code})`)); });
        worker.on('message', message => {
          if (stopped) return;
          if (message.error) { fail(new Error(message.error)); return; }
          results[message.index] = message.result; completed++;
          if (completed === jobs.length) { stopped = true; resolve(); } else dispatch(worker);
        });
        dispatch(worker);
      }
    });
    return { results, workerCount };
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}
