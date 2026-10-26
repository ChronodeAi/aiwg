// Rechecks the persistent apply block at managed admission, including already-created schedulers.
import { normalizeAiwgConfigCandidate } from './config-normalization.js';
import { readFileSync } from 'node:fs';
import { getConfigPath, workerActivationDigests, workerConfigDigest, type WorkerActivation } from './aiwg-config.js';
import { workerDispatchBlocked } from './worker-write.js';

export function assertWorkerActivationCurrent(project: string, expected?: WorkerActivation): void {
  if (workerDispatchBlocked(project)) throw new Error('Managed dispatch is closed for worker policy apply/recovery');
  if (expected) {
    const config = normalizeAiwgConfigCandidate(JSON.parse(readFileSync(getConfigPath(project), 'utf8')));
    if (workerConfigDigest(config.parallelism?.activation) !== workerConfigDigest(expected)
      || workerActivationDigests(config).configDigest !== expected.configDigest) throw new Error('Managed activation changed; reload the current config and admission binding');
  }
}
