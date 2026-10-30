// Rechecks the persistent apply block at managed admission, including already-created schedulers.
import { normalizeAiwgConfigCandidate } from './config-normalization.js';
import { readFileSync } from 'node:fs';
import { getConfigPath, workerActivationDigests, workerConfigDigest, type WorkerActivation } from './aiwg-config.js';
import { workerDispatchBlocked } from './worker-write.js';

export function assertWorkerActivationCurrent(project: string, expected?: WorkerActivation): void {
  if (workerDispatchBlocked(project)) throw new Error('Managed dispatch is closed for worker policy apply/recovery');
  if (expected) {
    let raw: string;
    try { raw = readFileSync(getConfigPath(project), 'utf8'); } catch (error) {
      // Fail closed: an admission bound to an activation cannot be verified without the project config.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Managed activation cannot be verified: ${getConfigPath(project)} is missing`);
      throw error;
    }
    const config = normalizeAiwgConfigCandidate(JSON.parse(raw));
    if (workerConfigDigest(config.parallelism?.activation) !== workerConfigDigest(expected)
      || workerActivationDigests(config).configDigest !== expected.configDigest) throw new Error('Managed activation changed; reload the current config and admission binding');
  }
}
