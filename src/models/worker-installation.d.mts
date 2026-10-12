import type { ProviderModelCapabilityRegistry } from './provider-policy.js';
import type { WorkerSelectionPolicy } from './types.js';
import type { WorkerResolutionBinding } from './resolver.js';
import type { WorkerInvocationDriver } from '../serve/worker-invocation.js';
export function loadRecordedWorkerInstallations(input: {
  registry: ProviderModelCapabilityRegistry;
  cwd: string;
  policy?: WorkerSelectionPolicy;
  storePath?: string;
  storeDigest?: string;
}): Promise<{ registry: ProviderModelCapabilityRegistry; installations: Record<string, WorkerResolutionBinding>; drivers: Record<string, WorkerInvocationDriver> }>;

export function hasProvider(name: string): boolean;

export function compileWorkerVersionPattern(pattern: string): RegExp;
export function normalizeWorkerVersionBanner(banner: string, pattern?: string): string;
