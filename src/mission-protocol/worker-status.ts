import type { WorkerEffectiveHealth, WorkerHealthSummary } from './types.js';

/** Internal bounded projection shared by Ralph and the attached worker bridge.
 * The monitor caps selection at 256 rows, sanitizes labels and omits raw captures.
 * No published schema family or managed-store authority is introduced here. */
export interface WorkerStatusObservation {
  invocationId: string;
  task: string | null;
  member: string | null;
  transport: 'shell' | 'mcp' | 'http';
  identity: {
    pid: number | null;
    pgid: number | null;
    requestId: string | null;
    source: 'kernel' | 'recorded';
  };
  health: WorkerHealthSummary;
  thresholds: WorkerEffectiveHealth | null;
  elapsedSeconds: number | null;
  remainingSeconds: number | null;
  ages: {
    observationSeconds: number | null;
    activitySeconds: number | null;
    progressSeconds: number | null;
  };
  counters: {
    stdoutBytes: number | null;
    stderrBytes: number | null;
    cpuTimeMs: number | null;
    exitCode: number | null;
    available: { stdout: boolean; stderr: boolean; cpu: boolean; exit: boolean };
  };
  nextAction: 'NONE' | 'CHECK_DEADLINE' | 'DIAGNOSE_WORKER' | 'RESTORE_OBSERVATION';
  terminal: boolean;
  termination: 'running' | 'confirmed' | 'uncertain';
  verification: null;
  evidence: 'recorded';
  observerOwnership?: 'unreserved' | 'active' | 'unavailable';
  findings: string[];
  error: null;
}

export interface WorkerStatusErrorRow {
  invocationId: null;
  task: null;
  member: null;
  transport: null;
  error: { code: string };
  nextAction: 'REPAIR_RUN_METADATA';
  terminal: false;
}

export type WorkerStatusRow = WorkerStatusObservation | WorkerStatusErrorRow;

export interface WorkerStatusSnapshot {
  version: 1;
  sampledAt: string;
  scope: 'direct-conductor' | 'project-managed' | 'host-managed';
  observerCoverage: WorkerHealthSummary['coverage'];
  workers: WorkerStatusRow[];
  /** Tier 0 has no shared breaker authority and always reports an empty array. */
  breakers: never[];
  nextCheckAt: string | null;
  complete: boolean;
  findings: string[];
  exitCode: 0 | 1 | 2;
  watch?: { remainingSeconds: number; expired: boolean } | null;
}
