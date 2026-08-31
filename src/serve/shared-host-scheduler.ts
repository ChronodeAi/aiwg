/**
 * Cross-orchestrator scheduling and admission for shared execution hosts.
 *
 * The store is the global serialization boundary. Multiple AIWG processes must
 * use the same durable implementation; the in-memory store is for tests and
 * single-process embedding only. Executor substrates report capacity and run
 * admitted work, but do not own this policy.
 *
 * ADR-004: the admission lease is a measured contract, not a fixed guess —
 * TTL is sourced from config (`serve.admissionLease`) with a floor derived
 * from measured startup latency, renewal is anchored to live loop heartbeats
 * through an injected probe, and lease-expired requests are requeued a
 * bounded number of times when capacity exists.
 *
 * @implements #1566
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type AdmissionState =
  | 'queued'
  | 'admitted'
  | 'denied'
  | 'cancelled'
  | 'timed-out'
  | 'preempted';

export type RuntimeKind = 'host' | 'container' | 'vm' | 'microvm' | 'custom';

export interface AdmissionRequest {
  requestId: string;
  orchestratorId: string;
  environment: string;
  provider: string;
  runtimeKind: RuntimeKind;
  priority: number;
  submittedAt: string;
  queueTimeoutMs: number;
  preemptible?: boolean;
  metadata?: Record<string, string>;
}

export interface AdmissionRecord extends AdmissionRequest {
  state: AdmissionState;
  revision: number;
  reason: string;
  admittedAt?: string;
  leaseExpiresAt?: string;
  finishedAt?: string;
  preemptedBy?: string;
  /** ADR-004: how many times this request has been requeued after lease expiry. */
  requeueAttempts?: number;
}

export interface SharedHostPolicy {
  maxConcurrent: number;
  leaseTtlMs: number;
  agingIntervalMs: number;
  allowPreemption: boolean;
  environmentQuotas?: Record<string, number>;
  providerQuotas?: Record<string, number>;
  runtimeQuotas?: Partial<Record<RuntimeKind, number>>;
  /** Host execution is least isolated and defaults to one concurrent lease. */
  defaultHostQuota?: number;
  /** ADR-004: heartbeat freshness window; a heartbeat at most this old renews an expired lease. Default 90_000 (3 heartbeat intervals). */
  renewalGraceMs?: number;
  /** ADR-004: bounded requeue attempts for lease-expired requests. Default 2. */
  maxRequeueAttempts?: number;
  /** ADR-004: measured startup p95 (admission→first heartbeat); when set, a leaseTtlMs below it is a construction error. */
  startupP95Ms?: number | null;
}

export interface AdmissionSnapshot {
  revision: number;
  records: Record<string, AdmissionRecord>;
}

export interface AdmissionStore {
  transact<T>(mutate: (snapshot: AdmissionSnapshot) => T): T;
  read(): AdmissionSnapshot;
}

/** Liveness probe injected by the caller: age in ms of the freshest heartbeat
 * for a loop, or null when no live signal exists. */
export type HeartbeatProbe = (loopId: string) => number | null;

// ── ADR-004: shared admission-lease policy ───────────────────

/** Config surface under `serve.admissionLease` (ADR-004 §Specific Design). */
export interface AdmissionLeaseConfig {
  minTtlMs?: number;
  ttlMultiplier?: number;
  renewalGraceMs?: number;
  maxRequeueAttempts?: number;
}

export interface AdmissionLeasePolicy {
  leaseTtlMs: number;
  agingIntervalMs: number;
  renewalGraceMs: number;
  maxRequeueAttempts: number;
  startupP95Ms: number | null;
}

/** Defaults preserve today's behavior when no config or measurements exist. */
export const DEFAULT_ADMISSION_LEASE: AdmissionLeasePolicy = {
  leaseTtlMs: 300_000,
  agingIntervalMs: 30_000,
  renewalGraceMs: 90_000,
  maxRequeueAttempts: 2,
  startupP95Ms: null,
};

const STARTUP_LATENCY_RELPATH = join('.aiwg', 'serve', 'startup-latency.json');

function readStartupP95Ms(root: string = process.cwd()): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, STARTUP_LATENCY_RELPATH), 'utf8')) as {
      startupP95Ms?: unknown;
    };
    const p95 = parsed.startupP95Ms;
    return typeof p95 === 'number' && Number.isFinite(p95) && p95 > 0 ? p95 : null;
  } catch {
    return null; // no measurements yet — minTtlMs applies
  }
}

function positiveOr<T>(value: T | undefined, fallback: number, isValid: (v: T) => boolean): number {
  return value !== undefined && isValid(value) ? (value as unknown as number) : fallback;
}

/**
 * One shared lease-lifecycle policy for every scheduler construction site.
 * TTL formula (ADR-004): `max(minTtlMs, ttlMultiplier × startupP95Ms)`; with
 * no startup measurements, `minTtlMs` (default 300_000) applies.
 */
export function loadAdmissionLeasePolicy(
  cfg: unknown,
  startupP95Ms: number | null = readStartupP95Ms(),
): AdmissionLeasePolicy {
  const section = (cfg as { serve?: { admissionLease?: AdmissionLeaseConfig } } | null | undefined)
    ?.serve?.admissionLease;
  const minTtlMs = positiveOr(section?.minTtlMs, DEFAULT_ADMISSION_LEASE.leaseTtlMs, v => v > 0);
  const ttlMultiplier = positiveOr(section?.ttlMultiplier, 3, v => v > 0);
  const renewalGraceMs = positiveOr(
    section?.renewalGraceMs,
    DEFAULT_ADMISSION_LEASE.renewalGraceMs,
    v => v > 0,
  );
  const maxRequeueAttempts = positiveOr(
    section?.maxRequeueAttempts,
    DEFAULT_ADMISSION_LEASE.maxRequeueAttempts,
    v => Number.isInteger(v) && v >= 0,
  );
  const measured =
    startupP95Ms !== null && Number.isFinite(startupP95Ms) && startupP95Ms > 0 ? startupP95Ms : null;
  const leaseTtlMs = Math.max(minTtlMs, ttlMultiplier * (measured ?? 0));
  return {
    leaseTtlMs,
    agingIntervalMs: DEFAULT_ADMISSION_LEASE.agingIntervalMs,
    renewalGraceMs,
    maxRequeueAttempts,
    startupP95Ms: measured,
  };
}

/**
 * Default heartbeat probe: stats `.aiwg/ralph/heartbeats/<loopId>` (written
 * every 30s by tools/ralph-external/process-monitor.mjs) and returns the file
 * age in ms, or null when no heartbeat exists. Callers with a different
 * liveness source inject their own probe instead.
 */
export function fileHeartbeatProbe(root: string): HeartbeatProbe {
  return (loopId: string): number | null => {
    try {
      const path = join(root, '.aiwg', 'ralph', 'heartbeats', loopId);
      if (!existsSync(path)) return null;
      return Date.now() - statSync(path).mtimeMs;
    } catch {
      return null;
    }
  };
}

export class InMemoryAdmissionStore implements AdmissionStore {
  private snapshot: AdmissionSnapshot = { revision: 0, records: {} };

  transact<T>(mutate: (snapshot: AdmissionSnapshot) => T): T {
    const draft = structuredClone(this.snapshot);
    const result = mutate(draft);
    draft.revision += 1;
    this.snapshot = draft;
    return result;
  }

  read(): AdmissionSnapshot {
    return structuredClone(this.snapshot);
  }
}

/** Durable cross-process store. The lock is deliberately non-blocking: a
 * concurrent writer receives a conflict and retries through its control loop. */
export class FileAdmissionStore implements AdmissionStore {
  constructor(private readonly path: string) {}

  transact<T>(mutate: (snapshot: AdmissionSnapshot) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('shared-host admission store is busy; retry the request');
      }
      throw error;
    }
    try {
      const snapshot = this.readUnsafe();
      const result = mutate(snapshot);
      snapshot.revision += 1;
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      return result;
    } finally {
      closeSync(descriptor);
      try { unlinkSync(lockPath); } catch { /* best-effort lock cleanup */ }
    }
  }

  read(): AdmissionSnapshot {
    return structuredClone(this.readUnsafe());
  }

  private readUnsafe(): AdmissionSnapshot {
    if (!existsSync(this.path)) return { revision: 0, records: {} };
    return JSON.parse(readFileSync(this.path, 'utf8')) as AdmissionSnapshot;
  }
}

const terminalStates = new Set<AdmissionState>([
  'denied', 'cancelled', 'timed-out', 'preempted',
]);

export class SharedHostScheduler {
  private readonly renewalGraceMs: number;
  private readonly maxRequeueAttempts: number;
  private readonly heartbeatProbe: HeartbeatProbe;

  constructor(
    private readonly store: AdmissionStore,
    private readonly policy: SharedHostPolicy,
    private readonly clock: () => number = Date.now,
    options: { heartbeatProbe?: HeartbeatProbe } = {},
  ) {
    if (!Number.isInteger(policy.maxConcurrent) || policy.maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    if (policy.leaseTtlMs < 1 || policy.agingIntervalMs < 1) {
      throw new Error('leaseTtlMs and agingIntervalMs must be positive');
    }
    this.renewalGraceMs = policy.renewalGraceMs ?? DEFAULT_ADMISSION_LEASE.renewalGraceMs;
    this.maxRequeueAttempts = policy.maxRequeueAttempts ?? DEFAULT_ADMISSION_LEASE.maxRequeueAttempts;
    this.heartbeatProbe = options.heartbeatProbe ?? (() => null);
    if (policy.renewalGraceMs !== undefined && policy.renewalGraceMs < 1) {
      throw new Error('renewalGraceMs must be positive');
    }
    if (
      policy.maxRequeueAttempts !== undefined
      && (!Number.isInteger(policy.maxRequeueAttempts) || policy.maxRequeueAttempts < 0)
    ) {
      throw new Error('maxRequeueAttempts must be a non-negative integer');
    }
    // ADR-004 hardened validation: an operator TTL shorter than loops take to
    // start is a configuration error by evidence, not a positivity nit.
    if (
      policy.startupP95Ms != null
      && Number.isFinite(policy.startupP95Ms)
      && policy.leaseTtlMs < policy.startupP95Ms
    ) {
      throw new Error(
        `leaseTtlMs (${policy.leaseTtlMs} ms) is shorter than the measured startup p95 (${policy.startupP95Ms} ms); loops need at least ${policy.startupP95Ms} ms to start — raise serve.admissionLease.minTtlMs`,
      );
    }
  }

  submit(request: AdmissionRequest): AdmissionRecord {
    this.validateRequest(request);
    return this.store.transact(snapshot => {
      const existing = snapshot.records[request.requestId];
      if (existing) {
        if (!sameRequest(existing, request)) {
          throw new Error(`request '${request.requestId}' conflicts with an existing admission`);
        }
        return existing;
      }
      snapshot.records[request.requestId] = {
        ...structuredClone(request),
        state: 'queued',
        revision: 1,
        reason: 'awaiting shared-host capacity',
      };
      this.reconcile(snapshot);
      return structuredClone(snapshot.records[request.requestId]!);
    });
  }

  reconcileNow(): AdmissionSnapshot {
    return this.store.transact(snapshot => {
      this.reconcile(snapshot);
      return structuredClone(snapshot);
    });
  }

  renew(requestId: string): AdmissionRecord {
    return this.store.transact(snapshot => {
      const record = this.required(snapshot, requestId);
      if (record.state !== 'admitted') throw new Error(`cannot renew ${record.state} admission`);
      record.leaseExpiresAt = new Date(this.clock() + this.policy.leaseTtlMs).toISOString();
      record.revision += 1;
      record.reason = 'lease renewed';
      return structuredClone(record);
    });
  }

  /** ADR-004: record the launched loop id on the admission record so the
   * aging sweep can consult heartbeats for this dispatch. */
  attachLoopId(requestId: string, loopId: string): AdmissionRecord {
    return this.store.transact(snapshot => {
      const record = this.required(snapshot, requestId);
      record.metadata = { ...record.metadata, loopId };
      record.revision += 1;
      return structuredClone(record);
    });
  }

  release(requestId: string): AdmissionSnapshot {
    return this.store.transact(snapshot => {
      const record = this.required(snapshot, requestId);
      delete snapshot.records[requestId];
      if (record.state === 'admitted') this.reconcile(snapshot);
      return structuredClone(snapshot);
    });
  }

  cancel(requestId: string): AdmissionRecord {
    return this.store.transact(snapshot => {
      const record = this.required(snapshot, requestId);
      if (terminalStates.has(record.state)) return structuredClone(record);
      record.state = 'cancelled';
      record.reason = 'cancelled by orchestrator';
      record.finishedAt = new Date(this.clock()).toISOString();
      record.revision += 1;
      this.reconcile(snapshot);
      return structuredClone(record);
    });
  }

  snapshot(): AdmissionSnapshot {
    return this.store.read();
  }

  private reconcile(snapshot: AdmissionSnapshot): void {
    const now = this.clock();
    for (const record of Object.values(snapshot.records)) {
      if (record.state === 'admitted' && Date.parse(record.leaseExpiresAt ?? '') <= now) {
        // ADR-004 heartbeat-anchored renewal: a live loop (fresh heartbeat
        // inside the grace window) is renewed, not evicted. Liveness is
        // claimed only by evidence — a dead heartbeat writer still expires.
        const loopId = record.metadata?.loopId ?? record.requestId;
        const heartbeatAgeMs = this.heartbeatProbe(loopId);
        if (heartbeatAgeMs !== null && heartbeatAgeMs <= this.renewalGraceMs) {
          record.leaseExpiresAt = new Date(now + this.policy.leaseTtlMs).toISOString();
          record.reason = 'lease renewed';
          record.revision += 1;
          continue;
        }
        record.state = 'timed-out';
        record.finishedAt = new Date(now).toISOString();
        const attempts = record.requeueAttempts ?? 0;
        if (attempts < this.maxRequeueAttempts && this.hasCapacity(snapshot, record)) {
          // ADR-004 bounded requeue: capacity exists and attempts remain —
          // return to the queue for a fresh admission attempt.
          record.state = 'queued';
          record.reason = `lease expired; requeued (attempt ${attempts + 1}/${this.maxRequeueAttempts})`;
          record.requeueAttempts = attempts + 1;
          record.submittedAt = new Date(now).toISOString();
          delete record.leaseExpiresAt;
          delete record.admittedAt;
          delete record.finishedAt;
          record.revision += 1;
        } else {
          record.reason = 'admission lease expired; capacity recovered';
          record.revision += 1;
        }
      } else if (record.state === 'queued' && Date.parse(record.submittedAt) + record.queueTimeoutMs <= now) {
        record.state = 'timed-out';
        record.reason = 'queue deadline elapsed';
        record.finishedAt = new Date(now).toISOString();
        record.revision += 1;
      }
    }

    let queued = Object.values(snapshot.records)
      .filter(record => record.state === 'queued')
      .sort((a, b) => this.compare(a, b, now));

    for (const candidate of queued) {
      if (!this.hasCapacity(snapshot, candidate)) {
        if (this.policy.allowPreemption) this.tryPreempt(snapshot, candidate, now);
      }
      if (!this.hasCapacity(snapshot, candidate)) continue;
      candidate.state = 'admitted';
      candidate.reason = 'admitted by shared-host policy';
      candidate.admittedAt = new Date(now).toISOString();
      candidate.leaseExpiresAt = new Date(now + this.policy.leaseTtlMs).toISOString();
      candidate.revision += 1;
    }
    queued = [];
  }

  private tryPreempt(snapshot: AdmissionSnapshot, candidate: AdmissionRecord, now: number): void {
    const victims = Object.values(snapshot.records)
      .filter(record => record.state === 'admitted' && record.preemptible === true)
      .sort((a, b) => this.compare(b, a, now));
    const victim = victims.find(record => {
      if (this.effectivePriority(record, now) >= this.effectivePriority(candidate, now)) return false;
      const priorState = record.state;
      record.state = 'preempted';
      const freesRequiredCapacity = this.hasCapacity(snapshot, candidate);
      record.state = priorState;
      return freesRequiredCapacity;
    });
    if (!victim) return;
    victim.state = 'preempted';
    victim.reason = `preempted by higher-priority request '${candidate.requestId}'`;
    victim.preemptedBy = candidate.requestId;
    victim.finishedAt = new Date(now).toISOString();
    victim.revision += 1;
  }

  private hasCapacity(snapshot: AdmissionSnapshot, candidate: AdmissionRecord): boolean {
    const active = Object.values(snapshot.records).filter(record => record.state === 'admitted');
    if (active.length >= this.policy.maxConcurrent) return false;
    if (!belowQuota(active, 'environment', candidate.environment, this.policy.environmentQuotas)) return false;
    if (!belowQuota(active, 'provider', candidate.provider, this.policy.providerQuotas)) return false;
    const runtimeQuotas = {
      host: this.policy.defaultHostQuota ?? 1,
      ...this.policy.runtimeQuotas,
    };
    return belowQuota(active, 'runtimeKind', candidate.runtimeKind, runtimeQuotas);
  }

  private effectivePriority(record: AdmissionRecord, now: number): number {
    const waited = Math.max(0, now - Date.parse(record.submittedAt));
    return record.priority + Math.floor(waited / this.policy.agingIntervalMs);
  }

  private compare(a: AdmissionRecord, b: AdmissionRecord, now: number): number {
    return this.effectivePriority(b, now) - this.effectivePriority(a, now)
      || Date.parse(a.submittedAt) - Date.parse(b.submittedAt)
      || a.requestId.localeCompare(b.requestId);
  }

  private required(snapshot: AdmissionSnapshot, requestId: string): AdmissionRecord {
    const record = snapshot.records[requestId];
    if (!record) throw new Error(`unknown admission request '${requestId}'`);
    return record;
  }

  private validateRequest(request: AdmissionRequest): void {
    if (!request.requestId || !request.orchestratorId || !request.environment || !request.provider) {
      throw new Error('request identity, orchestrator, environment, and provider are required');
    }
    if (!Number.isFinite(request.priority)) throw new Error('priority must be finite');
    if (!Number.isFinite(Date.parse(request.submittedAt))) throw new Error('submittedAt must be a timestamp');
    if (request.queueTimeoutMs < 1) throw new Error('queueTimeoutMs must be positive');
  }
}

function belowQuota<K extends 'environment' | 'provider' | 'runtimeKind'>(
  active: AdmissionRecord[],
  field: K,
  value: AdmissionRecord[K],
  quotas: Partial<Record<string, number>> | undefined,
): boolean {
  const quota = quotas?.[String(value)];
  if (quota === undefined) return true;
  return active.filter(record => record[field] === value).length < quota;
}

function sameRequest(record: AdmissionRecord, request: AdmissionRequest): boolean {
  return record.orchestratorId === request.orchestratorId
    && record.environment === request.environment
    && record.provider === request.provider
    && record.runtimeKind === request.runtimeKind;
}
