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
export const workerVersionProbeEnvAllowlist: readonly string[];
export function workerVersionProbeEnvironment(source?: Record<string, string | undefined>): Record<string, string>;
export const workerVersionProbeDefaults: { readonly timeoutMs: number; readonly maxBytes: number };
export function workerVersionRangeMismatch(version: string, ranges: string[]): string | null;
export function boundedVersionProbe(
  executable: string,
  argv: string[],
  environment: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  versionPattern: string | undefined,
): Promise<{ rawBanner: string; version: string }>;

export interface WorkerRecoveryCapabilities {
  canVerifyAttempt?: boolean;
  parseWorkerAttemptFinal?(output: string | Uint8Array, options: Record<string, unknown>): Promise<unknown>;
}
export function registerWorkerRecoveryCapabilities<T extends object>(driver: T, capabilities: WorkerRecoveryCapabilities): T;
export function getWorkerRecoveryCapabilities(driver: object | undefined | null): Readonly<WorkerRecoveryCapabilities> | null;
