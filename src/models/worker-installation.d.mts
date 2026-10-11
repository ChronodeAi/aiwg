import type { ProviderModelCapabilityRegistry } from './provider-policy.js';
import type { WorkerSelectionPolicy } from './types.js';
import type { WorkerResolutionBinding } from './resolver.js';
import type { WorkerInvocationDriver } from '../serve/worker-invocation.js';
export function loadRecordedWorkerInstallations(input: {
  registry: ProviderModelCapabilityRegistry;
  cwd: string;
  policy?: WorkerSelectionPolicy;
}): Promise<{ registry: ProviderModelCapabilityRegistry; installations: Record<string, WorkerResolutionBinding>; drivers: Record<string, WorkerInvocationDriver> }>;

export function hasProvider(name: string): boolean;
