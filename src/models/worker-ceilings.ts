// Resolves existing worker ceilings and records the restrictions that actually bind.
import type { ParallelismConfig } from '../config/aiwg-config.js';
import { workerConfigDigest } from '../config/worker-config-digest.js';
import type { WorkerPolicyDiagnostic, WorkerPolicyOrigin } from './types.js';
import type { WorkerResolutionCeilings } from './worker-plan.js';

export const WORKER_CEILING_KEYS = ['tokens', 'costUsd', 'wallSeconds', 'maxAttempts'] as const;

/** Parent/brief restrictions intersect; they never replace a stricter restriction. */
export function intersectWorkerCeilings(...layers: Array<WorkerResolutionCeilings | undefined>): WorkerResolutionCeilings {
  const result: WorkerResolutionCeilings = {};
  for (const key of WORKER_CEILING_KEYS) {
    const values = layers.map(layer => layer?.[key]).filter((value): value is number => value !== undefined);
    if (values.length) result[key] = Math.min(...values);
  }
  return result;
}

export function resolveWorkerCeilings(parallelism: ParallelismConfig, constraints?: WorkerResolutionCeilings,
  request?: WorkerResolutionCeilings, defaults: WorkerResolutionCeilings = {}): {
    ceilings: WorkerResolutionCeilings; origins: Record<string, WorkerPolicyOrigin[]>; diagnostics: WorkerPolicyDiagnostic[];
  } {
  const layers: Array<{ values: WorkerResolutionCeilings; pointer: string; source: string; authority: WorkerPolicyOrigin['authority'] }> = [
    { values: defaults, pointer: 'defaults/invocation', source: 'builtin', authority: 'builtin' },
    { values: parallelism.budgets?.perRun ?? {}, pointer: '/parallelism/budgets/perRun', source: 'config', authority: 'project' },
    { values: parallelism.budgets?.perTask ?? {}, pointer: '/parallelism/budgets/perTask', source: 'config', authority: 'project' },
    { values: { maxAttempts: parallelism.retry?.maxAttempts ?? 3 },
      pointer: parallelism.retry?.maxAttempts === undefined ? 'defaults/parallelism/retry' : '/parallelism/retry',
      source: parallelism.retry?.maxAttempts === undefined ? 'builtin' : 'config',
      authority: parallelism.retry?.maxAttempts === undefined ? 'builtin' : 'project' },
    { values: constraints ?? {}, pointer: '/constraints/ceilings', source: 'constraints', authority: 'project' },
  ];
  const ceilings: WorkerResolutionCeilings = {};
  const origins: Record<string, WorkerPolicyOrigin[]> = {};
  const diagnostics: WorkerPolicyDiagnostic[] = [];
  for (const key of WORKER_CEILING_KEYS) {
    const entries = layers.map(layer => ({ ...layer, value: layer.values[key], pointer: `${layer.pointer}/${key}` }));
    if (key === 'wallSeconds' && parallelism.health?.hardTimeoutSeconds !== undefined) entries.push({
      values: { wallSeconds: parallelism.health.hardTimeoutSeconds }, value: parallelism.health.hardTimeoutSeconds,
      pointer: '/parallelism/health/hardTimeoutSeconds', source: 'config', authority: 'project',
    });
    const caller = request?.[key];
    const values = [...entries.map(entry => entry.value), caller].filter((value): value is number => value !== undefined);
    const pointer = `/request/ceilings/${key}`;
    if (values.some(value => !Number.isFinite(value) || value < 0 || key !== 'costUsd' && !Number.isSafeInteger(value))) {
      diagnostics.push({ code: 'OG_CONFIG_REFERENCE', pointer,
        message: 'Ceilings must be finite nonnegative values; counts and seconds must be integers' });
      continue;
    }
    const resolved = Math.min(...entries.map(entry => entry.value ?? Infinity));
    if (caller !== undefined && caller > resolved) diagnostics.push({ code: 'OG_POLICY_RELAXATION', pointer,
      message: `Requested ${key} ceiling ${caller} exceeds resolved policy ceiling ${resolved}.` });
    if (!values.length) continue;
    ceilings[key] = Math.min(...values);
    if (caller !== undefined) entries.push({ values: request!, value: caller, pointer,
      source: 'request', authority: 'project' });
    origins[`/ceilings/${key}`] = entries.filter(entry => entry.value === ceilings[key]).map(entry => ({
      source: entry.source, authority: entry.authority, pointer: entry.pointer,
      digest: workerConfigDigest(entry.values), contribution: entry.value,
    }));
  }
  return { ceilings, origins, diagnostics };
}
