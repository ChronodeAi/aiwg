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
  startupCorrection?: WorkerStartupCorrection;
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

export type RecoveryScopeState = 'closed' | 'open' | 'half-open' | 'canary-ready' | 'canary' | 'operator-intervention';

export interface RecoveryScopeStatus {
  owner?: string;
  scopeKey: string;
  scope: string;
  state: RecoveryScopeState;
  reasons: string[];
  nextEligibleAtMs: number | null;
  nextEligibleAt: string | null;
  canaryInFlight: boolean;
}

export interface RecoveryStatusTransition {
  owner?: string;
  scopeKey: string;
  scope: string;
  from: RecoveryScopeState;
  to: RecoveryScopeState;
  reasons: string[];
  atMs: number;
  at: string | null;
  nextEligibleAtMs: number | null;
  nextEligibleAt: string | null;
}

export interface WorkerRecoveryStatus {
  source: 'live' | 'recorded' | 'unavailable';
  observedAt: string | null;
  observedAtMs: number | null;
  scopes: RecoveryScopeStatus[];
  transitions: RecoveryStatusTransition[];
  omittedScopeCount: number;
  truncated: boolean;
}

const recoveryStates = new Set<unknown>(['closed', 'open', 'half-open', 'canary-ready', 'canary', 'operator-intervention']);
const recoveryScopes = new Set<unknown>(['invocation', 'model', 'installation', 'quota', 'provider', 'host']);
const recoveryReasons = new Set<unknown>(['NOT_FOUND', 'SPAWN_REFUSED', 'AUTH', 'RATE_LIMIT', 'NETWORK',
  'RESOURCE', 'SANDBOX', 'MODEL', 'UNKNOWN']);
const objectRecord = (value: unknown): Record<string, unknown> | null => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finiteClock = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value)
  && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;

/** Read-only projection of the existing breaker owner. Only fixed reason codes
 * and scope identities survive; worker captures, actions and diagnostics do not.
 * Clock values are converted with the owner's persisted wall-clock anchor,
 * never with the reader's clock (which may belong to another process/boot). */
export function projectRecoveryStatus(value: unknown, source: WorkerRecoveryStatus['source'] = 'recorded'): WorkerRecoveryStatus {
  const record = objectRecord(value);
  const observedAtMs = finiteClock(record?.observedAtMs);
  const wall = typeof record?.observedAt === 'string' ? Date.parse(record.observedAt) : NaN;
  const observedAt = Number.isFinite(wall) ? new Date(wall).toISOString() : null;
  const at = (clock: number | null): string | null => {
    if (clock === null || observedAtMs === null || observedAt === null) return null;
    const mapped = wall + clock - observedAtMs;
    return Number.isFinite(mapped) && Math.abs(mapped) <= 8.64e15 ? new Date(mapped).toISOString() : null;
  };
  const identity = (item: Record<string, unknown>): { scopeKey: string; scope: string } | null => {
    if (!recoveryScopes.has(item.scope) || typeof item.scopeKey !== 'string'
      || !/^[\p{L}\p{N}_.:/@+~%\-]{1,256}$/u.test(item.scopeKey)
      || !item.scopeKey.startsWith(`${String(item.scope)}:`)) return null;
    return { scopeKey: item.scopeKey, scope: item.scope as string };
  };
  const reasons = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.slice(0, 32).filter(reason => recoveryReasons.has(reason)))] as string[] : [];
  const rawScopes = Array.isArray(record?.scopes) ? record.scopes : [];
  const rawTransitions = Array.isArray(record?.transitions) ? record.transitions : [];
  const scopes: RecoveryScopeStatus[] = [];
  for (const raw of rawScopes.slice(0, 32)) {
    const item = objectRecord(raw), id = item && identity(item);
    if (!item || !id || !recoveryStates.has(item.state)) continue;
    const nextEligibleAtMs = finiteClock(item.nextEligibleAtMs);
    scopes.push({ ...id, state: item.state as RecoveryScopeState, reasons: reasons(item.reasons),
      nextEligibleAtMs, nextEligibleAt: at(nextEligibleAtMs), canaryInFlight: item.canaryInFlight === true });
  }
  const transitions: RecoveryStatusTransition[] = [];
  for (const raw of rawTransitions.slice(-32)) {
    const item = objectRecord(raw), id = item && identity(item);
    const clock = finiteClock(item?.atMs);
    if (!item || !id || clock === null || !recoveryStates.has(item.from) || !recoveryStates.has(item.to)) continue;
    const nextEligibleAtMs = finiteClock(item.nextEligibleAtMs);
    transitions.push({ ...id, from: item.from as RecoveryScopeState, to: item.to as RecoveryScopeState,
      reasons: reasons(item.reasons), atMs: clock, at: at(clock), nextEligibleAtMs, nextEligibleAt: at(nextEligibleAtMs) });
  }
  const omittedScopeCount = typeof record?.omittedScopeCount === 'number'
    && Number.isSafeInteger(record.omittedScopeCount) && record.omittedScopeCount >= 0 ? record.omittedScopeCount : 0;
  return { source: record ? source : 'unavailable', observedAt, observedAtMs, scopes, transitions,
    omittedScopeCount: omittedScopeCount + Math.max(0, rawScopes.length - 32),
    truncated: record?.truncated === true || omittedScopeCount > 0 || rawScopes.length > 32 || rawTransitions.length > 32 };
}

/** Merge independently owned observations without letting one owner's close
 * hide another owner's active scope. Callers first select the latest record
 * for each owner; owner labels are supplied from validated launcher identity. */
export function mergeRecoveryStatuses(statuses: WorkerRecoveryStatus[]): WorkerRecoveryStatus {
  const available = statuses.filter(status => status.source !== 'unavailable');
  const latest = available.reduce<WorkerRecoveryStatus | null>((last, status) => !last
    || Date.parse(status.observedAt ?? '') >= Date.parse(last.observedAt ?? '') ? status : last, null);
  if (!latest) return projectRecoveryStatus(null);
  const allScopes = available.flatMap(status => status.scopes);
  const scopes = allScopes.filter(scope => scope.state !== 'closed').concat(allScopes.filter(scope => scope.state === 'closed'));
  const transitions = available.flatMap(status => status.transitions).sort((a, b) =>
    (a.at ? Date.parse(a.at) : a.atMs) - (b.at ? Date.parse(b.at) : b.atMs));
  const omittedScopeCount = available.reduce((count, status) => count + status.omittedScopeCount, 0) + Math.max(0, scopes.length - 32);
  return { source: latest.source, observedAt: latest.observedAt, observedAtMs: latest.observedAtMs,
    scopes: scopes.slice(0, 32), transitions: transitions.slice(-32), omittedScopeCount,
    truncated: available.some(status => status.truncated) || omittedScopeCount > 0 || transitions.length > 32 };
}

export interface WorkerStartupCorrection {
  action: 'refresh-executable-binding';
  reasonCode: 'NOT_FOUND';
  state: 'applied' | 'stopped';
  stopCode?: string;
  previousInvocationId: string;
  retryInvocationId?: string;
}

/** Mechanical correction records carry fixed codes and invocation identities. */
export function projectStartupCorrection(value: unknown): WorkerStartupCorrection | null {
  const record = objectRecord(value);
  const safeId = (value: unknown): value is string => typeof value === 'string'
    && /^[\p{L}\p{N}_.:/@+~%\-]{1,256}$/u.test(value);
  if (!record || record.action !== 'refresh-executable-binding' || record.reasonCode !== 'NOT_FOUND'
    || !['applied', 'stopped'].includes(String(record.state)) || !safeId(record.previousInvocationId)) return null;
  const stopCodes = new Set(['ATTEMPT_LIMIT', 'CANCELLED', 'DEADLINE', 'UNCHANGED_EXECUTABLE', 'QUALIFICATION_REFUSED',
    'BINDING_CHANGED', 'RETRY_REFUSED', 'RETRY_FAILED']);
  return { action: 'refresh-executable-binding', reasonCode: 'NOT_FOUND', state: record.state as 'applied' | 'stopped',
    previousInvocationId: record.previousInvocationId,
    ...(typeof record.stopCode === 'string' && stopCodes.has(record.stopCode) ? { stopCode: record.stopCode } : {}),
    ...(safeId(record.retryInvocationId) ? { retryInvocationId: record.retryInvocationId } : {}) };
}

export interface WorkerStatusSnapshot {
  version: 1;
  sampledAt: string;
  scope: 'direct-conductor' | 'project-managed' | 'host-managed';
  observerCoverage: WorkerHealthSummary['coverage'];
  workers: WorkerStatusRow[];
  /** Tier 0 has no shared breaker authority and always reports an empty array. */
  breakers: never[];
  /** Owner observations grant no recovery admission or process-control authority. */
  recovery?: WorkerRecoveryStatus;
  nextCheckAt: string | null;
  complete: boolean;
  findings: string[];
  exitCode: 0 | 1 | 2;
  watch?: { remainingSeconds: number; expired: boolean } | null;
}
