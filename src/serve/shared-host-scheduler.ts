/**
 * Cross-orchestrator scheduling and admission for shared execution hosts.
 *
 * The store is the global serialization boundary. Multiple AIWG processes must
 * use the same durable implementation; the in-memory store is for tests and
 * single-process embedding only. Executor substrates report capacity and run
 * admitted work, but do not own this policy.
 *
 * @implements #1566
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertMissionWorkerHandoff } from '../mission-protocol/codecs.js';
import { isCanonicalWorkerModelKey } from '../models/provider-policy.js';
import type { ParallelismConfig } from '../config/aiwg-config.js';

export type AdmissionState =
  | 'queued'
  | 'admitted'
  | 'uncertain'
  | 'denied'
  | 'cancelled'
  | 'timed-out'
  | 'preempted';

export type RuntimeKind = 'host' | 'container' | 'vm' | 'microvm' | 'custom';

export interface ManagedWorkerReservation {
  kind: 'native' | 'external';
  group?: string;
  member?: string;
  cli?: string;
  model?: string;
  quotaScope?: string;
  /** Minimum worker slots required by this request. */
  lowerBound?: number;
}

export interface ManagedAdmissionPolicy {
  authorityRef: 'project';
  projectId: string;
  policyDigest: string;
  maxQueued: number;
  dimensionCaps: Record<string, number>;
  installations: Record<string, { accountScope: string; quotaScope: string }>;
  members: Record<string, { cli: string }>;
}

/** Canonical project identity and the existing MC authority, including symlink aliases. */
export function projectAdmissionAuthority(projectRoot: string): { projectId: string; path: string } {
  const root = realpathSync(projectRoot);
  return {
    projectId: createHash('sha256').update(root).digest('hex'),
    path: join(root, '.aiwg/ralph-external/mc/admission.json'),
  };
}

export function managedDimensionKeys(projectId: string, worker: ManagedWorkerReservation): string[] {
  if (!/^[a-f0-9]{64}$/.test(projectId)) throw new Error('invalid canonical project identity');
  for (const id of [worker.group, worker.member, worker.cli]) {
    if (id !== undefined && !/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw new Error('invalid canonical worker identity');
  }
  if (worker.member !== undefined && worker.group === undefined) throw new Error('member requires a group');
  if (worker.model !== undefined && !isCanonicalWorkerModelKey(worker.model)) throw new Error('invalid canonical model key');
  if (worker.quotaScope !== undefined && !worker.quotaScope.trim()) throw new Error('quotaScope must be nonempty');
  const project = `project/${projectId}`;
  return [project,
    ...(worker.group ? [`${project}/group/${worker.group}`] : []),
    ...(worker.member ? [`${project}/group/${worker.group}/member/${worker.member}`] : []),
    ...(worker.cli ? [`${project}/installation/${worker.cli}`] : []),
    ...(worker.model ? [`model/${worker.model}`] : []),
    ...(worker.quotaScope ? [`quota/${encodeURIComponent(worker.quotaScope)}`] : []),
  ];
}

/** Build the project policy for the existing config/activation owner. */
export function managedProjectAdmissionPolicy(
  projectRoot: string, parallelism: ParallelismConfig, policyDigest: string, maxConcurrent: number,
): SharedHostPolicy {
  const { projectId } = projectAdmissionAuthority(projectRoot);
  const admission = parallelism.admission;
  if ((admission?.authorityRef ?? 'project') !== 'project') throw new Error('only project admission authority is supported');
  if (parallelism.budgets?.enforcement === 'hard') throw new Error('OG_BUDGET_UNMEASURABLE: managed admission does not enforce hard spend budgets');
  const dimensions: Record<string, number> = {};
  const add = (worker: ManagedWorkerReservation, cap: number): void => {
    const key = managedDimensionKeys(projectId, worker).at(-1)!;
    dimensions[key] = Math.min(dimensions[key] ?? cap, cap);
  };
  for (const [group, definition] of Object.entries(parallelism.groups ?? {})) {
    if (definition.maxParallel !== undefined) add({ kind: 'native', group }, definition.maxParallel);
  }
  for (const [group, cap] of Object.entries(admission?.groupCaps ?? {})) add({ kind: 'native', group }, cap);
  for (const [key, cap] of Object.entries(admission?.memberCaps ?? {})) {
    const [group, member, extra] = key.split('/');
    if (!group || !member || extra !== undefined) throw new Error('invalid canonical group/member key');
    add({ kind: 'native', group, member }, cap);
  }
  for (const [cli, cap] of Object.entries(admission?.cliCaps ?? {})) add({ kind: 'native', cli }, cap);
  for (const [model, cap] of Object.entries(admission?.modelCaps ?? {})) add({ kind: 'native', model }, cap);
  for (const [quotaScope, cap] of Object.entries(admission?.quotaCaps ?? {})) add({ kind: 'native', quotaScope }, cap);
  return {
    maxConcurrent, leaseTtlMs: (admission?.leaseSeconds ?? 60) * 1000,
    agingIntervalMs: 30_000, allowPreemption: false, defaultHostQuota: maxConcurrent,
    managed: {
      authorityRef: 'project', projectId, policyDigest, maxQueued: admission?.maxQueued ?? 128,
      dimensionCaps: dimensions,
      installations: Object.fromEntries(Object.entries(parallelism.clis ?? {}).filter(([, cli]) => cli.enabled !== false)
        .map(([id, cli]) => [id, { accountScope: cli.accountScope, quotaScope: cli.quotaScope }])),
      members: Object.fromEntries(Object.entries(parallelism.groups ?? {}).flatMap(([group, definition]) =>
        definition.members.filter(member => member.enabled !== false && parallelism.clis?.[member.cli]?.enabled !== false)
          .map(member => [`${group}/${member.id}`, { cli: member.cli }]))),
    },
  };
}

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
  managed?: ManagedWorkerReservation;
}

export interface AdmissionRecord extends AdmissionRequest {
  state: AdmissionState;
  revision: number;
  reason: string;
  admittedAt?: string;
  leaseExpiresAt?: string;
  finishedAt?: string;
  preemptedBy?: string;
  attemptGeneration?: number;
  leaseGeneration?: number;
  dimensions?: string[];
  reservedSlots?: number;
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
  managed?: ManagedAdmissionPolicy;
}

export interface AdmissionSnapshot {
  revision: number;
  records: Record<string, AdmissionRecord>;
  /** Written by the config/authority owner, never selected by a transaction caller. */
  policyBinding?: SharedHostPolicy;
}

/** Initialize a validated activation under the store lock. Policy replacement/migration
 * is deliberately not supported here; active or uncertain work must first be reconciled. */
export function bindManagedAdmissionPolicy(store: AdmissionStore, policy: SharedHostPolicy): void {
  if (!policy.managed) throw new Error('managed policy is required');
  new SharedHostScheduler(store, policy);
  store.transact(snapshot => {
    if (snapshot.policyBinding && canonical(snapshot.policyBinding) !== canonical(policy)) {
      throw new Error('managed admission policy binding conflicts with the activated policy');
    }
    snapshot.policyBinding = structuredClone(policy);
  });
}

export interface AdmissionStore {
  transact<T>(mutate: (snapshot: AdmissionSnapshot) => T): T;
  read(): AdmissionSnapshot;
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
  constructor(
    private readonly store: AdmissionStore,
    private readonly policy: SharedHostPolicy,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isInteger(policy.maxConcurrent) || policy.maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    if (policy.leaseTtlMs < 1 || policy.agingIntervalMs < 1) {
      throw new Error('leaseTtlMs and agingIntervalMs must be positive');
    }
    if (policy.managed) this.policy = structuredClone(policy);
    const managed = this.policy.managed;
    if (managed) {
      managedDimensionKeys(managed.projectId, { kind: 'native' });
      if (managed.authorityRef !== 'project') throw new Error('managed admission requires authorityRef=project');
      if (!/^sha256:[a-f0-9]{64}$/.test(managed.policyDigest)) throw new Error('invalid activated policy digest');
      if (!Number.isSafeInteger(managed.maxQueued) || managed.maxQueued < 0) throw new Error('maxQueued must be a nonnegative integer');
      if (!Number.isSafeInteger(policy.maxConcurrent) || !Number.isFinite(policy.leaseTtlMs) || !Number.isFinite(policy.agingIntervalMs)) {
        throw new Error('managed capacity and lease intervals must be finite');
      }
      for (const [key, cap] of Object.entries(managed.dimensionCaps)) {
        if (!isCanonicalManagedDimension(managed.projectId, key)) throw new Error('invalid canonical admission dimension key');
        if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('dimension caps must be positive integers');
      }
      const aliases = new Map<string, string>();
      for (const [cli, binding] of Object.entries(managed.installations)) {
        managedDimensionKeys(managed.projectId, { kind: 'native', cli, quotaScope: binding.quotaScope });
        if (!binding.accountScope?.trim() || !binding.quotaScope?.trim()) throw new Error('managed installations require account and quota bindings');
        const quota = aliases.get(binding.accountScope);
        if (quota !== undefined && quota !== binding.quotaScope) throw new Error('ambiguous account aliases bind one account to different quota scopes');
        aliases.set(binding.accountScope, binding.quotaScope);
      }
    }
  }

  submit(request: AdmissionRequest): AdmissionRecord {
    assertMissionWorkerHandoff(request, 'managed-admission');
    this.validateRequest(request);
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const existing = snapshot.records[request.requestId];
      if (existing) {
        if (!(this.policy.managed ? sameManagedRequest(existing, request) : sameRequest(existing, request))) {
          throw new Error(`request '${request.requestId}' conflicts with an existing admission`);
        }
        return this.policy.managed ? structuredClone(existing) : existing;
      }
      if (this.policy.managed) this.reconcile(snapshot);
      snapshot.records[request.requestId] = {
        ...structuredClone(request),
        state: 'queued',
        revision: 1,
        reason: 'awaiting shared-host capacity',
        ...(this.policy.managed ? {
          attemptGeneration: 1,
          leaseGeneration: 1,
          dimensions: this.reservationDimensions(request),
          reservedSlots: request.managed?.lowerBound ?? 1,
        } : {}),
      };
      this.reconcile(snapshot);
      if (this.policy.managed && snapshot.records[request.requestId]!.state === 'queued'
        && Object.values(snapshot.records).filter(record => record.state === 'queued').length > this.policy.managed.maxQueued) {
        const record = snapshot.records[request.requestId]!;
        record.state = 'denied';
        record.reason = 'managed admission queue is full';
        record.finishedAt = new Date(this.clock()).toISOString();
        record.revision += 1;
      }
      return structuredClone(snapshot.records[request.requestId]!);
    });
  }

  reconcileNow(): AdmissionSnapshot {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      this.reconcile(snapshot);
      return structuredClone(snapshot);
    });
  }

  renew(requestId: string): AdmissionRecord {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      if (record.state !== 'admitted') throw new Error(`cannot renew ${record.state} admission`);
      record.leaseExpiresAt = new Date(this.clock() + this.policy.leaseTtlMs).toISOString();
      record.revision += 1;
      record.reason = 'lease renewed';
      return structuredClone(record);
    });
  }

  release(requestId: string): AdmissionSnapshot {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      if (this.policy.managed) {
        throw new Error('managed capacity requires proof-checked settlement');
      }
      delete snapshot.records[requestId];
      if (record.state === 'admitted') this.reconcile(snapshot);
      return structuredClone(snapshot);
    });
  }

  cancel(requestId: string): AdmissionRecord {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      if (terminalStates.has(record.state)) return structuredClone(record);
      record.state = this.policy.managed && (record.state === 'admitted' || record.state === 'uncertain') ? 'uncertain' : 'cancelled';
      record.reason = 'cancelled by orchestrator';
      if (record.state !== 'uncertain') record.finishedAt = new Date(this.clock()).toISOString();
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
        record.state = this.policy.managed ? 'uncertain' : 'timed-out';
        record.reason = this.policy.managed ? 'admission lease expired; termination is uncertain' : 'admission lease expired; capacity recovered';
        if (!this.policy.managed) record.finishedAt = new Date(now).toISOString();
        record.revision += 1;
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
        if (this.policy.allowPreemption && !this.policy.managed) this.tryPreempt(snapshot, candidate, now);
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
    const active = Object.values(snapshot.records).filter(record => record.state === 'admitted' || (this.policy.managed && record.state === 'uncertain'));
    const slots = this.policy.managed ? candidate.reservedSlots ?? 1 : 1;
    if (active.reduce((sum, record) => sum + (this.policy.managed ? record.reservedSlots ?? 1 : 1), 0) + slots > this.policy.maxConcurrent) return false;
    if (this.policy.managed) {
      for (const key of candidate.dimensions ?? []) {
        const cap = this.policy.managed.dimensionCaps[key];
        if (cap === undefined) continue;
        const used = active.filter(record => !record.dimensions || record.dimensions.includes(key))
          .reduce((sum, record) => sum + (record.reservedSlots ?? 1), 0);
        if (used + slots > cap) return false;
      }
    }
    if (!belowQuota(active, 'environment', candidate.environment, this.policy.environmentQuotas, slots, !!this.policy.managed)) return false;
    if (!belowQuota(active, 'provider', candidate.provider, this.policy.providerQuotas, slots, !!this.policy.managed)) return false;
    const runtimeQuotas = {
      host: this.policy.defaultHostQuota ?? 1,
      ...this.policy.runtimeQuotas,
    };
    return belowQuota(active, 'runtimeKind', candidate.runtimeKind, runtimeQuotas, slots, !!this.policy.managed);
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
    if (!this.policy.managed && request.managed) throw new Error('managed request requires an activated managed policy');
    if (this.policy.managed) {
      const worker = request.managed;
      if (!worker || !['native', 'external'].includes(worker.kind)) throw new Error('managed worker identity is required');
      if (!Number.isSafeInteger(worker.lowerBound ?? 1) || (worker.lowerBound ?? 1) < 1) throw new Error('lowerBound must be a positive integer');
      if (!Number.isFinite(request.queueTimeoutMs)) throw new Error('queueTimeoutMs must be finite');
      managedDimensionKeys(this.policy.managed.projectId, worker);
      if (worker.kind === 'external' && (!worker.group || !worker.member || !worker.cli || !worker.model || !worker.quotaScope)) {
        throw new Error('external managed workers require group, member, installation, model and quota identities');
      }
      if (worker.cli) {
        const binding = this.policy.managed.installations[worker.cli];
        if (!binding || worker.quotaScope !== binding.quotaScope) throw new Error('worker quota does not match the activated installation binding');
      } else if (worker.quotaScope) throw new Error('quota identity requires an installation binding');
      if (worker.group || worker.member) {
        const member = this.policy.managed.members[`${worker.group}/${worker.member}`];
        if (!member || member.cli !== worker.cli) throw new Error('worker does not match the activated group/member binding');
      }
    }
  }

  private assertPolicyBinding(snapshot: AdmissionSnapshot): void {
    if (this.policy.managed || snapshot.policyBinding) {
      if (!snapshot.policyBinding || canonical(snapshot.policyBinding) !== canonical(this.policy)) {
        throw new Error('managed admission policy digest or policy binding mismatch');
      }
    }
  }

  private reservationDimensions(request: AdmissionRequest): string[] {
    const managed = this.policy.managed!;
    const worker = request.managed!;
    const dimensions = managedDimensionKeys(managed.projectId, worker);
    // Native workers with incomplete identity conservatively occupy every unknown
    // dimension. Missing observations must never manufacture extra capacity.
    if (worker.kind === 'native') {
      for (const key of Object.keys(managed.dimensionCaps)) {
        if ((!worker.group && key.includes('/group/')) || (!worker.cli && key.includes('/installation/'))
          || (!worker.model && key.startsWith('model/')) || (!worker.quotaScope && key.startsWith('quota/'))) dimensions.push(key);
      }
    }
    return [...new Set(dimensions)].sort();
  }
}

function canonical(value: unknown): string {
  const sorted = (node: any): any => Array.isArray(node) ? node.map(sorted)
    : node !== null && typeof node === 'object'
      ? Object.fromEntries(Object.keys(node).sort().filter(key => node[key] !== undefined).map(key => [key, sorted(node[key])])) : node;
  return JSON.stringify(sorted(value));
}

function isCanonicalManagedDimension(projectId: string, key: string): boolean {
  const project = `project/${projectId}`;
  if (key === project) return true;
  if (key.startsWith(`${project}/`)) {
    return /^(group\/[a-z][a-z0-9-]{0,62}(\/member\/[a-z][a-z0-9-]{0,62})?|installation\/[a-z][a-z0-9-]{0,62})$/.test(key.slice(project.length + 1));
  }
  if (key.startsWith('model/')) return isCanonicalWorkerModelKey(key.slice(6));
  if (key.startsWith('quota/')) {
    try {
      return managedDimensionKeys(projectId, { kind: 'native', quotaScope: decodeURIComponent(key.slice(6)) }).at(-1) === key;
    } catch { return false; }
  }
  return false;
}

function sameManagedRequest(record: AdmissionRecord, request: AdmissionRequest): boolean {
  const { state: _state, revision: _revision, reason: _reason, admittedAt: _admittedAt,
    leaseExpiresAt: _leaseExpiresAt, finishedAt: _finishedAt, preemptedBy: _preemptedBy,
    attemptGeneration: _attempt, leaseGeneration: _lease, dimensions: _dimensions, reservedSlots: _slots, ...original } = record;
  return canonical(original) === canonical(request);
}

function belowQuota<K extends 'environment' | 'provider' | 'runtimeKind'>(
  active: AdmissionRecord[],
  field: K,
  value: AdmissionRecord[K],
  quotas: Partial<Record<string, number>> | undefined,
  slots = 1,
  managed = false,
): boolean {
  const quota = quotas?.[String(value)];
  if (quota === undefined) return true;
  if (!managed) return active.filter(record => record[field] === value).length < quota;
  return active.filter(record => record[field] === value)
    .reduce((sum, record) => sum + (record.reservedSlots ?? 1), 0) + slots <= quota;
}

function sameRequest(record: AdmissionRecord, request: AdmissionRequest): boolean {
  return record.orchestratorId === request.orchestratorId
    && record.environment === request.environment
    && record.provider === request.provider
    && record.runtimeKind === request.runtimeKind;
}
