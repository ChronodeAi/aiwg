// Builds the existing MC admission owner with a live worker-activation gate.
import { join } from 'node:path';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { assertWorkerActivationCurrent } from '../../config/worker-activation-gate.js';
import * as ui from '../ui.js';
const MC_ROOT = '.aiwg/ralph-external/mc';
/** Shared binding used by MC and the managed Mission/Flow/Ralph caller paths. */
export async function createMcAdmissionScheduler(projectRoot: string, cfg: AiwgConfig | null,
  hostRegistry?: Pick<import('../../serve/executor-registry.js').ExecutorRegistry, 'resolveHostAdmissionAuthority'>) {
  const { resolveParallelism, workerActivationDigests, workerConfigDigest } = await import('../../config/aiwg-config.js');
  const { FileAdmissionStore, SharedHostScheduler } = await import('../../serve/shared-host-scheduler.js');
  const provider = cfg?.providers[0] ?? 'unknown';
  const parallelism = resolveParallelism(cfg?.parallelism, provider);
  if (parallelism.worker_mode === 'managed') {
    const { managedProjectAdmissionPolicy, projectAdmissionAuthority } = await import('../../serve/shared-host-scheduler.js');
    const activation = parallelism.activation;
    if (!cfg || !activation || activation.configDigest !== workerActivationDigests(cfg).configDigest) {
      throw new Error('managed admission requires a current activated policy');
    }
    const authority = projectAdmissionAuthority(projectRoot);
    const authorityRef = parallelism.admission?.authorityRef ?? 'project';
    if (authorityRef.startsWith('host:') && process.env['AIWG_EXECUTOR_IDENTITY_STORE']) {
      ui.warn('AIWG_EXECUTOR_IDENTITY_STORE is ignored for host admission authority lookup.');
    }
    const policy = managedProjectAdmissionPolicy(projectRoot, { ...parallelism,
      admission: { ...parallelism.admission, authorityRef: 'project' },
    }, workerConfigDigest(activation), parallelism.max_parallel_subagents);
    const binding = authorityRef === 'project' ? { store: new FileAdmissionStore(authority.path), policy }
      : (hostRegistry ?? (await import('../../serve/executor-registry.js')).executorRegistry).resolveHostAdmissionAuthority(authorityRef, policy);
    const check = () => assertWorkerActivationCurrent(projectRoot, activation);
    check();
    const scheduler = new SharedHostScheduler(binding.store, binding.policy, Date.now, check);
    scheduler.reconcileNow();
    return scheduler;
  }
  const maxConcurrent = parallelism.max_parallel_mc_missions;
  return new SharedHostScheduler(new FileAdmissionStore(join(projectRoot, MC_ROOT, 'admission.json')), {
    maxConcurrent, leaseTtlMs: 5 * 60_000, agingIntervalMs: 30_000, allowPreemption: false, defaultHostQuota: maxConcurrent,
  });
}

