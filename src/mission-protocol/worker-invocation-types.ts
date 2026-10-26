/** Typed resolved invocation and its bounded execution-time artifact declarations. */
import type { WORKER_CONTRACT_REVISION, WorkerTuple, WorkerLimits, WorkerEffectiveHealth } from './types.js';

export interface WorkerResolvedInvocation {
  version: typeof WORKER_CONTRACT_REVISION;
  invocationId?: string;
  mode: 'direct' | 'managed';
  isolation?: 'systemd-unit' | 'native-sandbox';
  transport: 'shell' | 'mcp';
  selected: WorkerTuple;
  policyDigest: string;
  catalogDigest: string;
  profileDigest: string;
  expiresAt: string;
  argv?: string[];
  cwd?: string;
  stdin?: 'closed' | 'brief-text' | 'brief-json' | 'adapter-frame';
  artifacts?: Array<{ name: string; content: string; location?: 'run-directory' } | {
    name: string; content: string; location: 'workspace-relative'; prefix: string; relativePath: string;
  }>;
  briefPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  finalPath?: string;
  shellCommand?: string;
  envNames?: string[];
  mcp?: {
    serverRef: string;
    tool: string;
    arguments: Record<string, unknown>;
    inputSchemaDigest: string;
    timeoutSeconds: number;
    outputSchemaDigest: string;
    sessionIsolation: 'per-call' | 'per-instance' | 'serialized';
  };
  readiness: 'preparatory' | 'launchable';
  briefDigest: string | null;
  limits: WorkerLimits;
  maxOutputBytes: number;
  effectiveCaps: Record<string, number>;
  controlEvidence: string[];
  /** Legacy and preparatory payloads may omit health; runtime owners use defaults. */
  health?: WorkerEffectiveHealth;
}
