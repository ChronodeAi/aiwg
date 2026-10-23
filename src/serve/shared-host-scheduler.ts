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
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { advanceProgressWatermark, assertMissionWorkerHandoff, assertValidWorkerPayload, decideLeaseMapping, projectHealthTrace } from '../mission-protocol/codecs.js';
import { isCanonicalWorkerModelKey } from '../models/provider-policy.js';
import type { CanonicalMission, WorkerExecution, WorkerHealthSummary, WorkerUsage } from '../mission-protocol/types.js';
import type { ParallelismConfig } from '../config/aiwg-config.js';

export type AdmissionState =
  | 'queued'
  | 'admitted'
  | 'uncertain'
  | 'settled'
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

export type ManagedBudgets = NonNullable<CanonicalMission['spec']['budgets']>;

/** Stable parent identities are supplied by the existing workflow owner. */
export interface ManagedAllowance {
  runId: string;
  taskId: string;
  runBudgets?: ManagedBudgets;
  taskBudgets?: ManagedBudgets;
  reservation?: { tokens: number | null; costUsd: number | null };
  previousRequestId?: string;
  /** Opaque native loops reserve their bounded iteration count before launch. */
  attempts?: number;
  purpose?: 'initial' | 'retry' | 'fallback' | 'quality' | 'effort' | 'review';
}

/** Translate existing owner ceilings without creating another budget contract. */
export function managedAllowanceFromOwner(runId: string, taskId: string, owner:
  | { kind: 'mission'; budgets?: ManagedBudgets }
  | { kind: 'ralph'; maxIterations?: number; maxTotalTokens?: number; maxTotalCost?: number; maxWallClockMinutes?: number }
  | { kind: 'flow'; ceilings: { activations?: number; tokens?: number; costUsd?: number; timeMs?: number } },
): ManagedAllowance {
  const budgets = owner.kind === 'mission' ? owner.budgets : owner.kind === 'ralph' ? {
    maxAttempts: owner.maxIterations, maxTokens: owner.maxTotalTokens, maxCostUsd: owner.maxTotalCost,
    timeoutSeconds: owner.maxWallClockMinutes === undefined ? undefined : owner.maxWallClockMinutes * 60,
  } : {
    maxAttempts: owner.ceilings.activations, maxTokens: owner.ceilings.tokens, maxCostUsd: owner.ceilings.costUsd,
    timeoutSeconds: owner.ceilings.timeMs === undefined ? undefined : owner.ceilings.timeMs / 1000,
  };
  return owner.kind === 'ralph'
    ? { runId, taskId, taskBudgets: budgets, attempts: owner.maxIterations ?? 5 }
    : { runId, taskId, runBudgets: budgets };
}

export interface ManagedAllowanceScope {
  limits: ManagedBudgets;
  startedAt: string;
  deadlineAt?: string;
}

export type ManagedAttemptFailure = Pick<NonNullable<WorkerExecution['failure']>, 'class' | 'retryable' | 'resetAt'>;

export interface ManagedAttemptAccounting {
  runKey: string;
  taskKey: string;
  reservation: { tokens: number | null; costUsd: number | null };
  attemptNumber?: number;
  attemptCount: number;
  usage: WorkerUsage | null;
  notBefore?: string;
  failure?: ManagedAttemptFailure;
  stopEvidence?: WorkerHealthSummary;
}

export interface ManagedAdmissionPolicy {
  authorityRef: 'project' | `host:${string}`;
  hostPolicyRevision?: number;
  authorityGeneration?: number;
  upstream?: Record<string, { accountScope: string; quotaScope: string; models: string[] }>;
  projectId: string;
  policyDigest: string;
  maxQueued: number;
  dimensionCaps: Record<string, number>;
  installations: Record<string, { accountScope: string; quotaScope: string }>;
  members: Record<string, { cli: string }>;
  budgets?: ParallelismConfig['budgets'];
  retry?: ParallelismConfig['retry'];
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
  if ((admission?.authorityRef ?? 'project') !== 'project') throw new Error('only project admission authority is supported by the project policy builder');
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
      budgets: parallelism.budgets, retry: parallelism.retry,
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
  allowance?: ManagedAllowance;
}

export interface AdmissionRecord extends AdmissionRequest {
  /** Authority-owned namespace; never accepted from the request. */
  projectId?: string;
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
  accounting?: ManagedAttemptAccounting;
  /** Durable dispatch boundary: a claimed launch is never automatically replayed. */
  launchClaimedAt?: string;
  execution?: ManagedExecutionIdentity;
  health?: WorkerHealthSummary;
  lastProgressAt?: string | null;
  /** Final evidence is separate from supervisor stop evidence and task acceptance. */
  finalEvidence?: { health: WorkerHealthSummary; usage?: WorkerUsage };
}

export interface ManagedExecutionIdentity {
  pid: number;
  /** OS process birth identity, including host boot identity; never PID alone. */
  startedAt: string;
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
  allowances?: Record<string, ManagedAllowanceScope>;
  cooldowns?: Record<string, { until: string; failures: number }>;
  hostBinding?: TrustedHostAdmissionBinding;
  hostRegistrationRevoked?: boolean;
  projectGenerations?: Record<string, number>;
  migration?: AdmissionMigration;
  authorityRedirect?: { authorityRef: string; generation: number; migrationId: string };
}

/** Initialize a validated activation under the store lock. Policy replacement/migration
 * is deliberately not supported here; active or uncertain work must first be reconciled. */
export function bindManagedAdmissionPolicy(store: AdmissionStore, policy: SharedHostPolicy): void {
  if (!policy.managed || policy.managed.authorityRef !== 'project') throw new Error('managed project policy is required');
  new SharedHostScheduler(store, policy);
  store.transact(snapshot => {
    if (snapshot.hostBinding || snapshot.migration || snapshot.authorityRedirect) throw new Error('authority migration requires the trusted owner');
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
  private hostWritableRoots?: string[];
  private durableWrites = false;

  constructor(private readonly path: string) {}

  /** Migration checkpoints must survive a completed write on either authority. */
  useDurableWrites(): void { this.durableWrites = true; }

  /** Trusted executor bootstrap supplies the actual sandbox writable mounts.
   * Mode checks do not isolate an unsandboxed process running as the same uid. */
  protectHostAuthority(workerWritableRoots: string[]): void {
    if (!Array.isArray(workerWritableRoots) || workerWritableRoots.some(root => !isAbsolute(root))) throw new Error('absolute worker writable roots are required');
    this.hostWritableRoots = workerWritableRoots.map(root => realpathSync(root));
    this.assertHostPath();
  }

  /** Only the trusted registration owner persists this protected location. */
  hostAuthorityPath(): string {
    if (!this.hostWritableRoots) throw new Error('host authority path has not been protected');
    this.readUnsafe();
    return this.path;
  }

  private assertHostPath(): void {
    if (!this.hostWritableRoots) return;
    const parent = dirname(this.path);
    if (!isAbsolute(this.path) || realpathSync(parent) !== resolve(parent)) throw new Error('host authority path must be canonical without symlink parents');
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw new Error('host authority directory must be private to its owner');
    for (const root of this.hostWritableRoots) {
      const within = relative(root, resolve(this.path));
      if (!within || (!within.startsWith('../') && within !== '..' && !isAbsolute(within))) throw new Error('worker writable mount includes the host authority');
    }
  }

  transact<T>(mutate: (snapshot: AdmissionSnapshot) => T): T {
    this.assertHostPath();
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
      if (this.hostWritableRoots || this.durableWrites) {
        const file = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`); fsyncSync(file); }
        finally { closeSync(file); }
      } else writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      if (this.hostWritableRoots || this.durableWrites) {
        const directory = openSync(dirname(this.path), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
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
    this.assertHostPath();
    if (this.hostWritableRoots || this.durableWrites) {
      if (!this.hostWritableRoots && !existsSync(this.path)) return { revision: 0, records: {} };
      const file = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 16 * 1024 * 1024) throw new Error('host authority must be a private bounded regular file');
        return JSON.parse(readFileSync(file, 'utf8')) as AdmissionSnapshot;
      } finally { closeSync(file); }
    }
    if (!existsSync(this.path)) return { revision: 0, records: {} };
    return JSON.parse(readFileSync(this.path, 'utf8')) as AdmissionSnapshot;
  }
}

const terminalStates = new Set<AdmissionState>([
  'denied', 'cancelled', 'timed-out', 'preempted', 'settled',
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
      if (managed.authorityRef !== 'project' && !/^host:[a-z][a-z0-9-]{0,62}$/.test(managed.authorityRef)) throw new Error('invalid managed authority reference');
      if (!/^sha256:[a-f0-9]{64}$/.test(managed.policyDigest)) throw new Error('invalid activated policy digest');
      if (!Number.isSafeInteger(managed.maxQueued) || managed.maxQueued < 0) throw new Error('maxQueued must be a nonnegative integer');
      if (!Number.isSafeInteger(policy.maxConcurrent) || !Number.isFinite(policy.leaseTtlMs) || !Number.isFinite(policy.agingIntervalMs)) {
        throw new Error('managed capacity and lease intervals must be finite');
      }
      for (const [key, cap] of Object.entries(managed.dimensionCaps)) {
        if (!(managed.authorityRef === 'project' ? isCanonicalManagedDimension(managed.projectId, key) : isHostDimension(key))) throw new Error('invalid canonical admission dimension key');
        if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('dimension caps must be positive integers');
      }
      if (managed.budgets?.enforcement === 'hard') throw new Error('OG_BUDGET_UNMEASURABLE: no enforcing spend adapter is bound');
      validateBudgets(projectBudgets(managed.budgets?.perRun));
      validateBudgets(projectBudgets(managed.budgets?.perTask));
      for (const value of [managed.retry?.maxAttempts ?? 3, managed.retry?.baseDelaySeconds ?? 1, managed.retry?.maxDelaySeconds ?? 60]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('managed retry bounds must be positive integers');
      }
      if ((managed.retry?.baseDelaySeconds ?? 1) > (managed.retry?.maxDelaySeconds ?? 60)) throw new Error('invalid retry delay bounds');
      if (managed.budgets?.reservationUsd !== undefined && (!Number.isFinite(managed.budgets.reservationUsd) || managed.budgets.reservationUsd <= 0)) throw new Error('reservationUsd must be positive');
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
      this.assertSubmissionsOpen(snapshot);
      const requestKey = this.requestKey(request.requestId);
      const existing = snapshot.records[requestKey];
      if (existing) {
        if (!(this.policy.managed ? sameManagedRequest(existing, request) : sameRequest(existing, request))) {
          throw new Error(`request '${request.requestId}' conflicts with an existing admission`);
        }
        return this.policy.managed ? structuredClone(existing) : existing;
      }
      if (this.policy.managed) this.reconcile(snapshot);
      snapshot.records[requestKey] = {
        ...structuredClone(request),
        ...(snapshot.hostBinding ? { projectId: this.policy.managed!.projectId } : {}),
        state: 'queued',
        revision: 1,
        reason: 'awaiting shared-host capacity',
        ...(this.policy.managed ? {
          attemptGeneration: 1,
          leaseGeneration: 1,
          dimensions: this.reservationDimensions(request),
          reservedSlots: request.managed?.lowerBound ?? 1,
          accounting: this.bindAllowance(snapshot, request),
        } : {}),
      };
      this.reconcile(snapshot);
      if (this.policy.managed && snapshot.records[requestKey]!.state === 'queued'
        && (Object.values(snapshot.records).filter(record => record.state === 'queued' && (!snapshot.hostBinding || record.projectId === this.policy.managed!.projectId)).length > this.policy.managed.maxQueued
          || (snapshot.hostBinding && Object.values(snapshot.records).filter(record => record.state === 'queued').length > snapshot.hostBinding.maxQueued))) {
        const record = snapshot.records[requestKey]!;
        record.state = 'denied';
        record.reason = 'managed admission queue is full';
        record.finishedAt = new Date(this.clock()).toISOString();
        record.revision += 1;
      }
      return structuredClone(snapshot.records[requestKey]!);
    });
  }

  reconcileNow(): AdmissionSnapshot {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      this.reconcile(snapshot);
      return this.projectSnapshot(snapshot);
    });
  }

  renew(requestId: string, generation?: number): AdmissionRecord {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      if (this.policy.managed) {
        this.assertGeneration(record, generation);
        this.reconcile(snapshot);
        if (record.state === 'uncertain') return structuredClone(record);
      }
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

  cancel(requestId: string, generation?: number): AdmissionRecord {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      if (this.policy.managed) this.assertGeneration(record, generation);
      if (terminalStates.has(record.state)) return structuredClone(record);
      record.state = this.policy.managed && (record.state === 'admitted' || record.state === 'uncertain') ? 'uncertain' : 'cancelled';
      record.reason = 'cancelled by orchestrator';
      if (record.state !== 'uncertain') record.finishedAt = new Date(this.clock()).toISOString();
      record.revision += 1;
      this.reconcile(snapshot);
      return structuredClone(record);
    });
  }

  /** Persist before spawning. A crash on either side requires reconciliation. */
  claimLaunch(requestId: string, generation: number): AdmissionRecord {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      this.assertSubmissionsOpen(snapshot);
      const record = this.required(snapshot, requestId);
      this.assertGeneration(record, generation);
      if (record.state !== 'admitted' || Date.parse(record.leaseExpiresAt!) <= this.clock()) throw new Error('launch requires a current admitted lease');
      if (!record.accounting || [record.accounting.runKey, record.accounting.taskKey].some(key =>
        Date.parse(snapshot.allowances?.[key]?.deadlineAt ?? '') <= this.clock())) throw new Error('cumulative allowance deadline elapsed before launch');
      if (record.launchClaimedAt) throw new Error('launch already claimed; reconcile before dispatch');
      record.launchClaimedAt = new Date(this.clock()).toISOString();
      record.revision += 1;
      return structuredClone(record);
    });
  }

  bindExecution(requestId: string, generation: number, execution: ManagedExecutionIdentity): AdmissionRecord {
    if (!Number.isSafeInteger(execution.pid) || execution.pid <= 0 || typeof execution.startedAt !== 'string' || !execution.startedAt.trim()) {
      throw new Error('execution requires a PID and OS process birth identity');
    }
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      this.assertGeneration(record, generation);
      if (!record.launchClaimedAt || !['admitted', 'uncertain'].includes(record.state)) throw new Error('execution requires a claimed launch');
      if (record.execution) {
        if (canonical(record.execution) !== canonical(execution)) throw new Error('execution identity conflicts; possible PID reuse');
        return structuredClone(record);
      }
      record.execution = structuredClone(execution);
      record.revision += 1;
      return structuredClone(record);
    });
  }

  stop(requestId: string, generation: number, reason: 'cancel' | 'disconnect' | 'preempt' | 'observer-loss' = 'cancel'): AdmissionRecord {
    if (!['cancel', 'disconnect', 'preempt', 'observer-loss'].includes(reason)) throw new Error('invalid stop reason');
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      this.assertGeneration(record, generation);
      if (terminalStates.has(record.state)) return structuredClone(record);
      record.state = record.state === 'queued' ? 'cancelled' : 'uncertain';
      record.reason = `${reason}; termination is uncertain`;
      if (record.state === 'cancelled') record.finishedAt = new Date(this.clock()).toISOString();
      record.revision += 1;
      this.reconcile(snapshot);
      return structuredClone(record);
    });
  }

  disconnect(requestId: string, generation: number): AdmissionRecord {
    return this.stop(requestId, generation, 'disconnect');
  }

  /** Supervision observations may advance progress, but never release capacity. */
  observeHealth(requestId: string, generation: number, health: WorkerHealthSummary): AdmissionRecord {
    assertValidWorkerPayload('workerHealthSummary', health);
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      this.assertGeneration(record, generation);
      if (health.observerGeneration !== generation) throw new Error('stale health observer generation');
      if (!record.accounting?.attemptNumber) throw new Error('health requires an admitted attempt');
      if (record.state === 'settled') return structuredClone(record);
      this.reconcile(snapshot);
      const verdict = this.healthVerdict(record, generation, health);
      const trace = projectHealthTrace(health, record.health?.state, { lastProgressAt: record.lastProgressAt ?? null });
      record.lastProgressAt = advanceProgressWatermark({ lastProgressAt: record.lastProgressAt ?? null }, trace.progressCredit, health).lastProgressAt;
      if (!record.health || Date.parse(health.lastObservedAt ?? '') >= Date.parse(record.health.lastObservedAt ?? '') || record.health.lastObservedAt === null) {
        record.health = structuredClone(health);
      }
      if (verdict === 'retain-uncertain') {
        record.state = 'uncertain';
        record.reason = 'supervisor observation is uncertain; reservation retained';
      }
      record.revision += 1;
      return structuredClone(record);
    });
  }

  /** Ingest final evidence without conflating it with a supervisor stop proof. */
  acceptFinal(requestId: string, generation: number, health: WorkerHealthSummary, usage?: WorkerUsage): AdmissionRecord {
    assertValidWorkerPayload('workerHealthSummary', health);
    if (usage) assertValidWorkerPayload('workerUsage', usage);
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      const record = this.required(snapshot, requestId);
      this.assertGeneration(record, generation);
      if (health.observerGeneration !== generation) throw new Error('stale final observer generation');
      if (!record.accounting?.attemptNumber) throw new Error('final requires an admitted attempt');
      const evidence = { health, ...(usage ? { usage } : {}) };
      if (record.finalEvidence) {
        if (canonical(record.finalEvidence) !== canonical(evidence)) throw new Error('conflicting final evidence');
        return structuredClone(record);
      }
      this.reconcile(snapshot);
      record.finalEvidence = structuredClone(evidence);
      record.revision += 1;
      return structuredClone(record);
    });
  }

  private assertGeneration(record: AdmissionRecord, generation: number | undefined): void {
    if (!this.policy.managed) throw new Error('operation requires managed admission');
    if (!Number.isSafeInteger(generation) || generation! < 1 || generation !== record.leaseGeneration) throw new Error('stale admission generation');
  }

  private healthVerdict(record: AdmissionRecord, generation: number, health: WorkerHealthSummary | null) {
    return decideLeaseMapping({ leaseGeneration: record.leaseGeneration!, observedGeneration: generation,
      leaseState: record.state === 'uncertain' ? 'cancelled-disconnected' : 'admitted',
      settled: record.state === 'settled', health });
  }

  /** Called with trusted supervisor observations, never worker claims/status strings. */
  settle(requestId: string, generation: number, health: WorkerHealthSummary | null, usage: WorkerUsage, failure?: ManagedAttemptFailure, execution?: ManagedExecutionIdentity): AdmissionRecord {
    assertValidWorkerPayload('workerUsage', usage);
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      if (!this.policy.managed) throw new Error('settlement requires managed admission');
      const record = this.required(snapshot, requestId);
      this.assertGeneration(record, generation);
      const accounting = record.accounting;
      if (!accounting?.attemptNumber) throw new Error('cannot settle an unlaunched attempt');
      let verdict = this.healthVerdict(record, generation, health);
      if (verdict === 'deny-stale') throw new Error('stale settlement generation');
      if (record.execution && canonical(record.execution) !== canonical(execution)) throw new Error('stop proof execution identity mismatch; possible PID reuse');
      if (verdict === 'release-once' && record.launchClaimedAt && !record.execution) verdict = 'retain-uncertain';
      if (verdict === 'deny-already-settled') {
        if (canonical(accounting.usage) !== canonical(usage)) throw new Error('conflicting settled usage');
        return structuredClone(record);
      }
      if (failure) this.applyFailure(snapshot, record, failure);
      // An unconfirmed observation cannot erase a previous measured charge.
      if (accounting.usage && !canRefineUsage(accounting.usage, usage)) throw new Error('conflicting attempt usage');
      accounting.usage = structuredClone(usage);
      if (verdict === 'release-once') {
        record.state = 'settled';
        record.finishedAt = new Date(this.clock()).toISOString();
        accounting.stopEvidence = structuredClone(health!);
        record.reason = 'current-generation termination proof reconciled';
      } else {
        record.state = 'uncertain';
        record.reason = 'termination proof unavailable or not current; reservation retained';
      }
      record.revision += 1;
      this.reconcile(snapshot);
      return structuredClone(record);
    });
  }

  /** A 429 observation cools the authority-bound account even if stop is uncertain. */
  recordRateLimit(requestId: string, generation: number, failure: { resetAt?: string } = {}): AdmissionRecord {
    return this.recordFailure(requestId, generation, { class: 'rate-limit', retryable: true, ...failure });
  }

  recordFailure(requestId: string, generation: number, failure: ManagedAttemptFailure): AdmissionRecord {
    return this.store.transact(snapshot => {
      this.assertPolicyBinding(snapshot);
      if (!this.policy.managed) throw new Error('failure observation requires managed admission');
      const record = this.required(snapshot, requestId);
      if (record.leaseGeneration !== generation) throw new Error('stale failure observation generation');
      if (!record.accounting?.attemptNumber) throw new Error('failure observation requires an admitted attempt');
      this.applyFailure(snapshot, record, failure);
      return structuredClone(record);
    });
  }

  snapshot(): AdmissionSnapshot {
    const snapshot = this.store.read();
    if (this.policy.managed?.authorityRef.startsWith('host:')) this.assertPolicyBinding(snapshot);
    return this.projectSnapshot(snapshot);
  }

  private projectSnapshot(value: AdmissionSnapshot): AdmissionSnapshot {
    const snapshot = structuredClone(value);
    if (this.policy.managed?.authorityRef.startsWith('host:')) {
      const projectId = this.policy.managed.projectId;
      snapshot.records = Object.fromEntries(Object.values(snapshot.records)
        .filter(record => record.projectId === projectId).map(record => [record.requestId, record]));
      snapshot.allowances = Object.fromEntries(Object.entries(snapshot.allowances ?? {})
        .filter(([key]) => JSON.parse(key)[0] === projectId));
    }
    return snapshot;
  }

  private reconcile(snapshot: AdmissionSnapshot): void {
    const now = this.clock();
    for (const record of Object.values(snapshot.records)) {
      if (this.policy.managed && record.managed && !record.accounting) throw new Error('managed allowance migration required; reconcile pre-allowance reservations before dispatch');
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

    if (snapshot.migration || snapshot.authorityRedirect) return;
    let queued = Object.values(snapshot.records)
      .filter(record => record.state === 'queued')
      .sort((a, b) => this.compare(a, b, now));

    for (const candidate of queued) {
      if (this.policy.managed && !this.allowAttempt(snapshot, candidate, now)) continue;
      if (!this.hasCapacity(snapshot, candidate)) {
        if (this.policy.allowPreemption && !this.policy.managed) this.tryPreempt(snapshot, candidate, now);
      }
      if (!this.hasCapacity(snapshot, candidate)) continue;
      if (candidate.accounting) {
        candidate.accounting.attemptNumber = Object.values(snapshot.records).filter(record =>
          record.accounting?.taskKey === candidate.accounting!.taskKey && record.accounting.attemptNumber !== undefined)
          .reduce((sum, record) => sum + record.accounting!.attemptCount, 0) + 1;
      }
      candidate.state = 'admitted';
      candidate.reason = 'admitted by shared-host policy';
      candidate.admittedAt = new Date(now).toISOString();
      candidate.leaseExpiresAt = new Date(now + this.policyFor(snapshot, candidate).leaseTtlMs).toISOString();
      candidate.revision += 1;
    }
    queued = [];
  }

  private applyFailure(snapshot: AdmissionSnapshot, record: AdmissionRecord, failure: ManagedAttemptFailure): void {
    const accounting = record.accounting!;
    if (!['rate-limit', 'unavailable', 'timeout', 'auth', 'invalid-request', 'policy', 'parse', 'verification', 'unknown'].includes(failure.class)
      || typeof failure.retryable !== 'boolean' || (failure.resetAt !== undefined && (typeof failure.resetAt !== 'string' || failure.resetAt.length > 128))) {
      throw new Error('invalid attempt failure');
    }
    if (accounting.failure) {
      if (canonical(accounting.failure) !== canonical(failure)) throw new Error('conflicting failure observation');
      return;
    }
    const retry = this.policy.managed!.retry;
    const cooldowns = snapshot.cooldowns ??= {};
    const quota = record.managed?.cli ? (this.policy.managed!.upstream ?? this.policy.managed!.installations)[record.managed.cli]!.quotaScope : null;
    if (failure.class === 'rate-limit' && !quota) throw new Error('quota observation requires an admitted installation');
    const key = `quota/${encodeURIComponent(quota ?? '')}`;
    const failures = failure.class === 'rate-limit' ? (cooldowns[key]?.failures ?? 0) + 1
      : Object.values(snapshot.records).filter(previous => previous.accounting?.taskKey === accounting.taskKey && previous.accounting.failure).length + 1;
    const delay = Math.min(retry?.maxDelaySeconds ?? 60, (retry?.baseDelaySeconds ?? 1) * 2 ** Math.min(failures - 1, 30)) * 1000;
    const now = this.clock();
    const reset = Date.parse(failure.resetAt ?? '');
    const until = Math.max(now + delay, Number.isFinite(reset) ? reset : now,
      failure.class === 'rate-limit' ? Date.parse(cooldowns[key]?.until ?? '') || 0 : 0);
    if (!Number.isFinite(new Date(until).getTime())) throw new Error('retry backoff exceeds timestamp range');
    if (failure.class === 'rate-limit') cooldowns[key] = { until: new Date(until).toISOString(), failures };
    accounting.notBefore = new Date(until).toISOString();
    accounting.failure = structuredClone(failure);
    record.revision += 1;
  }

  private bindAllowance(snapshot: AdmissionSnapshot, request: AdmissionRequest): ManagedAttemptAccounting {
    const policy = this.policy.managed!;
    const allowance: ManagedAllowance = request.allowance ?? { runId: request.orchestratorId, taskId: request.metadata?.missionId ?? request.requestId };
    const runKey = this.allowanceKey(JSON.stringify(['run', allowance.runId]));
    const taskKey = this.allowanceKey(JSON.stringify(['task', allowance.runId, allowance.taskId]));
    const scopes = snapshot.allowances ??= {};
    const bind = (key: string, limits: ManagedBudgets): ManagedAllowanceScope => {
      const previous = scopes[key];
      const effective = intersectBudgets(previous?.limits, limits);
      const startedAt = previous?.startedAt ?? new Date(this.clock()).toISOString();
      const deadline = effective.timeoutSeconds === undefined ? undefined : Date.parse(startedAt) + effective.timeoutSeconds * 1000;
      if (deadline !== undefined && !Number.isFinite(new Date(deadline).getTime())) throw new Error('allowance deadline exceeds timestamp range');
      return scopes[key] = { limits: effective, startedAt,
        ...(deadline === undefined ? {} : { deadlineAt: new Date(deadline).toISOString() }) };
    };
    const run = bind(runKey, intersectBudgets(projectBudgets(policy.budgets?.perRun), allowance.runBudgets));
    const task = bind(taskKey, intersectBudgets(
      { maxAttempts: policy.retry?.maxAttempts ?? 3 }, projectBudgets(policy.budgets?.perTask), allowance.taskBudgets,
    ));
    const limits = intersectBudgets(run.limits, task.limits);
    // Missing observations reserve the entire bounded envelope unless the owner
    // supplied a smaller estimate; unbounded dimensions remain explicitly null.
    const reservation = allowance.reservation ?? {
      tokens: limits.maxTokens ?? null,
      costUsd: policy.budgets?.reservationUsd ?? limits.maxCostUsd ?? null,
    };
    return { runKey, taskKey, reservation: structuredClone(reservation), usage: null,
      attemptCount: Math.min(allowance.attempts ?? 1, limits.maxAttempts ?? Number.MAX_SAFE_INTEGER),
    };
  }

  private allowAttempt(snapshot: AdmissionSnapshot, candidate: AdmissionRecord, now: number): boolean {
    const accounting = candidate.accounting!;
    const deny = (reason: string): false => {
      candidate.state = 'denied'; candidate.reason = reason;
      candidate.finishedAt = new Date(now).toISOString(); candidate.revision += 1;
      return false;
    };
    const attempts = Object.values(snapshot.records).filter(record => record.accounting?.attemptNumber !== undefined);
    const taskAttempts = attempts.filter(record => record.accounting!.taskKey === accounting.taskKey);
    if (taskAttempts.length) {
      const previous = taskAttempts.sort((a, b) => a.accounting!.attemptNumber! - b.accounting!.attemptNumber!).at(-1)!;
      if (candidate.allowance?.previousRequestId !== previous.requestId) return deny('new attempt must reference the latest task attempt');
      if (previous.state !== 'settled') return deny('previous attempt requires proof-checked reconciliation before replacement');
      const failure = previous.accounting!.failure;
      const purpose = candidate.allowance?.purpose ?? 'retry';
      if (purpose === 'retry' || purpose === 'fallback' || failure?.class === 'rate-limit') {
        if (!failure || !failure.retryable || !['rate-limit', 'unavailable', 'timeout'].includes(failure.class)) return deny('previous failure does not permit automatic retry');
        if (!(this.policyFor(snapshot, candidate).managed!.retry?.on ?? ['rate-limit', 'unavailable', 'timeout']).includes(failure.class as 'rate-limit' | 'unavailable' | 'timeout')) return deny(`${failure.class} retries are disabled`);
      }
    } else if (candidate.allowance?.previousRequestId) return deny('unknown previous task attempt');
    for (const key of [accounting.runKey, accounting.taskKey]) {
      const scope = snapshot.allowances![key]!;
      if (Date.parse(scope.deadlineAt ?? '') <= now) return deny('cumulative allowance deadline elapsed');
      const prior = attempts.filter(record => record.accounting!.runKey === key || record.accounting!.taskKey === key);
      if (scope.limits.maxAttempts !== undefined && prior.reduce((sum, record) => sum + record.accounting!.attemptCount, 0) + accounting.attemptCount > scope.limits.maxAttempts) return deny('cumulative attempt allowance exhausted');
      for (const [dimension, limit] of [['tokens', scope.limits.maxTokens], ['costUsd', scope.limits.maxCostUsd]] as const) {
        if (limit === undefined) continue;
        let used = 0;
        for (const record of prior) {
          const value = chargedUsage(record, dimension);
          if (value === null) return deny(`unknown ${dimension} charge has no finite reservation`);
          used += value;
        }
        const reserved = accounting.reservation[dimension];
        if (reserved === null || reserved === 0 || used + reserved > limit) return deny(`cumulative ${dimension} reservation exceeds allowance`);
      }
    }
    if (taskAttempts.some(record => Date.parse(record.accounting!.notBefore ?? '') > now)) return false;
    if (this.policyFor(snapshot, candidate).managed!.budgets?.unknownCost === 'deny' && accounting.reservation.costUsd === null) return deny('unknown cost is denied by policy');
    const quotaScope = candidate.managed?.cli && snapshot.hostBinding
      ? this.policyFor(snapshot, candidate).managed!.upstream![candidate.managed.cli]!.quotaScope : candidate.managed?.quotaScope;
    const quotas = quotaScope ? [`quota/${encodeURIComponent(quotaScope)}`]
      : Object.keys(snapshot.cooldowns ?? {});
    if (quotas.some(key => Date.parse(snapshot.cooldowns?.[key]?.until ?? '') > now)) return false;
    return true;
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
    const policy = this.policyFor(snapshot, candidate);
    const active = Object.values(snapshot.records).filter(record => record.state === 'admitted' || (policy.managed && record.state === 'uncertain'));
    const slots = policy.managed ? candidate.reservedSlots ?? 1 : 1;
    if (active.reduce((sum, record) => sum + (policy.managed ? record.reservedSlots ?? 1 : 1), 0) + slots > policy.maxConcurrent) return false;
    if (policy.managed) {
      for (const key of candidate.dimensions ?? []) {
        const cap = policy.managed.dimensionCaps[key];
        if (cap === undefined) continue;
        const used = active.filter(record => !record.dimensions || record.dimensions.includes(key))
          .reduce((sum, record) => sum + (record.reservedSlots ?? 1), 0);
        if (used + slots > cap) return false;
      }
    }
    if (!belowQuota(active, 'environment', candidate.environment, policy.environmentQuotas, slots, !!policy.managed)) return false;
    if (!belowQuota(active, 'provider', candidate.provider, policy.providerQuotas, slots, !!policy.managed)) return false;
    const runtimeQuotas = {
      host: policy.defaultHostQuota ?? 1,
      ...policy.runtimeQuotas,
    };
    return belowQuota(active, 'runtimeKind', candidate.runtimeKind, runtimeQuotas, slots, !!policy.managed);
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
    const record = snapshot.records[this.requestKey(requestId)];
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
    if (!this.policy.managed && request.allowance) throw new Error('allowance requires managed admission');
    if (!this.policy.managed && request.managed) throw new Error('managed request requires an activated managed policy');
    if (this.policy.managed) {
      if ('projectId' in request) throw new Error('request cannot choose its authority project');
      if (request.allowance) {
        if (request.allowance.runId !== request.orchestratorId || !request.allowance.taskId?.trim()) throw new Error('stable allowance run/task identity is required');
        if (!Number.isSafeInteger(request.allowance.attempts ?? 1) || (request.allowance.attempts ?? 1) < 1
          || ((request.allowance.attempts ?? 1) !== 1 && request.managed?.kind !== 'native')) throw new Error('attempt count requires a bounded native loop');
        if (request.allowance.purpose !== undefined && !['initial', 'retry', 'fallback', 'quality', 'effort', 'review'].includes(request.allowance.purpose)) throw new Error('invalid attempt purpose');
        validateBudgets(request.allowance.runBudgets);
        validateBudgets(request.allowance.taskBudgets);
        const reservation = request.allowance.reservation;
        if (reservation !== undefined) {
          if (!reservation || Object.keys(reservation).some(key => key !== 'tokens' && key !== 'costUsd')) throw new Error('invalid allowance reservation');
          for (const dimension of ['tokens', 'costUsd'] as const) {
            const value = reservation[dimension];
            if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
              || (dimension === 'tokens' && !Number.isSafeInteger(value)))) throw new Error('invalid allowance reservation');
          }
        }
      }
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
        const upstream = this.policy.managed.upstream?.[worker.cli];
        if (upstream && worker.model && !upstream.models.includes(worker.model)) throw new Error('worker model is not approved by the host installation binding');
      } else if (worker.quotaScope) throw new Error('quota identity requires an installation binding');
      if (worker.group || worker.member) {
        const member = this.policy.managed.members[`${worker.group}/${worker.member}`];
        if (!member || member.cli !== worker.cli) throw new Error('worker does not match the activated group/member binding');
      }
    }
  }

  private assertPolicyBinding(snapshot: AdmissionSnapshot): void {
    if (snapshot.authorityRedirect) throw new Error('project authority migrated; use the trusted host binding');
    if (snapshot.hostBinding) {
      if (snapshot.hostRegistrationRevoked) throw new Error('trusted host executor registration is revoked');
      const managed = this.policy.managed;
      if (!managed || snapshot.hostBinding.hostId !== hostname()
        || canonical(hostProjectAdmissionPolicy(snapshot, managed.projectId)) !== canonical(this.policy)) {
        throw new Error('trusted host policy revision or project binding mismatch');
      }
    } else if (this.policy.managed || snapshot.policyBinding) {
      if (!snapshot.policyBinding || canonical(snapshot.policyBinding) !== canonical(this.policy)) {
        throw new Error('managed admission policy digest or policy binding mismatch');
      }
    }
  }

  private assertSubmissionsOpen(snapshot: AdmissionSnapshot): void {
    if (snapshot.migration || snapshot.authorityRedirect) throw new Error('admission authority is frozen for migration');
  }

  private requestKey(requestId: string): string {
    return this.policy.managed?.authorityRef.startsWith('host:')
      ? hostProjectKey(this.policy.managed.projectId, requestId) : requestId;
  }

  private allowanceKey(key: string): string {
    return this.policy.managed?.authorityRef.startsWith('host:') ? hostProjectKey(this.policy.managed.projectId, key) : key;
  }

  private policyFor(snapshot: AdmissionSnapshot, record: AdmissionRecord): SharedHostPolicy {
    return snapshot.hostBinding ? hostProjectAdmissionPolicy(snapshot, record.projectId!) : this.policy;
  }

  private reservationDimensions(request: AdmissionRequest): string[] {
    const managed = this.policy.managed!;
    const worker = request.managed!;
    let dimensions = managedDimensionKeys(managed.projectId, worker);
    if (managed.authorityRef.startsWith('host:')) dimensions = hostReservationDimensions(managed, worker, dimensions);
    // Native workers with incomplete identity conservatively occupy every unknown
    // dimension. Missing observations must never manufacture extra capacity.
    if (worker.kind === 'native') {
      for (const key of Object.keys(managed.dimensionCaps)) {
        if (managed.authorityRef.startsWith('host:') && key.startsWith('project/') && !key.startsWith(`project/${managed.projectId}/`)) continue;
        if ((!worker.group && key.includes('/group/')) || (!worker.cli && key.includes('/installation/'))
          || (!worker.model && (key.startsWith('model/') || key.includes('/model/'))) || (!worker.quotaScope && (key.startsWith('quota/') || key.includes('/quota/')))) dimensions.push(key);
      }
    }
    return [...new Set(dimensions)].sort();
  }
}

/** Installed only by the existing executor/service owner, never registration payloads
 * or project config. Store access and this binding must be outside worker writes. */
export interface TrustedHostAdmissionBinding {
  authorityRef: `host:${string}`;
  hostId: string;
  revision: number;
  policy: Omit<SharedHostPolicy, 'managed'>;
  maxQueued: number;
  dimensionCaps: Record<string, number>;
  budgets?: ParallelismConfig['budgets'];
  retry?: ParallelismConfig['retry'];
  projects: Record<string, {
    policy: SharedHostPolicy;
    /** Prior project activation when changing only the authority reference. */
    migrationFrom?: SharedHostPolicy;
    /** Qualified upstream identities, independent of project aliases. */
    installations: Record<string, { accountScope: string; quotaScope: string; models: string[] }>;
  }>;
}

export interface AdmissionMigration {
  id: string;
  projectId: string;
  bindingDigest: string;
  phase: 'frozen' | 'drained' | 'reconciled' | 'committed';
  sourceDigest?: string;
  targetDigest?: string;
}

function hostProjectKey(projectId: string, key: string): string {
  return JSON.stringify([projectId, key]);
}

function isHostDimension(key: string): boolean {
  const match = /^project\/([a-f0-9]{64})(?:\/(model\/.*|quota\/.*))?$/.exec(key);
  if (match) return !match[2] || isCanonicalManagedDimension(match[1]!, match[2]);
  const project = /^project\/([a-f0-9]{64})\//.exec(key)?.[1] ?? '0'.repeat(64);
  return isCanonicalManagedDimension(project, key);
}

function hostReservationDimensions(policy: ManagedAdmissionPolicy, worker: ManagedWorkerReservation, dimensions: string[]): string[] {
  const project = `project/${policy.projectId}`;
  const upstream = worker.cli ? policy.upstream![worker.cli] : undefined;
  const keys = [...dimensions.filter(key => !key.startsWith('quota/')),
    ...(worker.model ? [`${project}/model/${worker.model}`] : []),
    ...(worker.quotaScope ? [`${project}/quota/${encodeURIComponent(worker.quotaScope)}`] : []),
    ...(upstream ? [`quota/${encodeURIComponent(upstream.quotaScope)}`] : []),
  ];
  if (worker.kind === 'native') for (const key of Object.keys(policy.dimensionCaps)) {
    if (key.startsWith('project/') && !key.startsWith(`${project}/`)) continue;
    if ((!worker.group && key.includes('/group/')) || (!worker.cli && key.includes('/installation/'))
      || (!worker.model && (key.startsWith('model/') || key.includes('/model/')))
      || (!worker.quotaScope && (key.startsWith('quota/') || key.includes('/quota/')))) keys.push(key);
  }
  return [...new Set(keys)].sort();
}

/** Derive the exact per-project view of the persisted authority. No caller caps
 * enter this function; project ceilings are approved by the host owner first. */
export function hostProjectAdmissionPolicy(snapshot: AdmissionSnapshot, projectId: string): SharedHostPolicy {
  const host = snapshot.hostBinding;
  const project = host?.projects[projectId];
  const generation = snapshot.projectGenerations?.[projectId];
  if (!host || !project || !generation) throw new Error('missing approved host project binding or migration generation');
  const dimensions = { ...host.dimensionCaps };
  for (const [id, approved] of Object.entries(host.projects)) {
    dimensions[`project/${id}`] = approved.policy.maxConcurrent;
    for (const [key, cap] of Object.entries(approved.policy.managed!.dimensionCaps)) {
      const scoped = key.startsWith('model/') || key.startsWith('quota/') ? `project/${id}/${key}` : key;
      dimensions[scoped] = Math.min(dimensions[scoped] ?? cap, cap);
    }
  }
  const managed = project.policy.managed!;
  const budgets = host.budgets || managed.budgets ? {
    ...managed.budgets,
    enforcement: host.budgets?.enforcement === 'hard' || managed.budgets?.enforcement === 'hard' ? 'hard' as const : 'observed' as const,
    unknownCost: host.budgets?.unknownCost === 'deny' || managed.budgets?.unknownCost === 'deny' ? 'deny' as const : 'reserve' as const,
    reservationUsd: Math.max(host.budgets?.reservationUsd ?? 0, managed.budgets?.reservationUsd ?? 0) || undefined,
    ...Object.fromEntries((['perRun', 'perTask'] as const).map(scope => [scope, {
      ...Object.fromEntries((['tokens', 'costUsd', 'wallSeconds'] as const).flatMap(key => {
        const value = Math.min(host.budgets?.[scope]?.[key] ?? Infinity, managed.budgets?.[scope]?.[key] ?? Infinity);
        return Number.isFinite(value) ? [[key, value]] : [];
      })),
    }])),
  } : undefined;
  const retry = host.retry || managed.retry ? {
    maxAttempts: Math.min(host.retry?.maxAttempts ?? 3, managed.retry?.maxAttempts ?? 3),
    baseDelaySeconds: Math.max(host.retry?.baseDelaySeconds ?? 1, managed.retry?.baseDelaySeconds ?? 1),
    maxDelaySeconds: Math.max(host.retry?.maxDelaySeconds ?? 60, managed.retry?.maxDelaySeconds ?? 60),
    on: (managed.retry?.on ?? ['rate-limit', 'unavailable', 'timeout'] as const)
      .filter(value => (host.retry?.on ?? ['rate-limit', 'unavailable', 'timeout']).includes(value)),
  } : undefined;
  return {
    ...structuredClone(host.policy),
    leaseTtlMs: Math.min(host.policy.leaseTtlMs, project.policy.leaseTtlMs),
    managed: {
      ...structuredClone(managed), authorityRef: host.authorityRef, hostPolicyRevision: host.revision,
      authorityGeneration: generation, maxQueued: Math.min(host.maxQueued, managed.maxQueued),
      dimensionCaps: dimensions, budgets, retry, upstream: structuredClone(project.installations),
    },
  };
}

/** Owner-only activation. Approved projects stay closed until their local store
 * (including an empty store) has completed freeze/drain/reconcile migration. */
export function bindTrustedHostAdmissionPolicy(store: AdmissionStore, binding: TrustedHostAdmissionBinding): void {
  if (store instanceof FileAdmissionStore) store.useDurableWrites();
  const host = structuredClone(binding);
  if (!/^host:[a-z][a-z0-9-]{0,62}$/.test(host.authorityRef) || host.hostId !== hostname()) throw new Error('host authority must be local to this execution host');
  if (!Number.isSafeInteger(host.revision) || host.revision < 1 || !Number.isSafeInteger(host.maxQueued) || host.maxQueued < 0) throw new Error('invalid host policy revision or queue bound');
  if ('managed' in host.policy) throw new Error('host policy cannot supply a caller managed binding');
  for (const [key, cap] of Object.entries(host.dimensionCaps)) {
    if ((!key.startsWith('model/') && !key.startsWith('quota/')) || !isHostDimension(key) || !Number.isSafeInteger(cap) || cap < 1) throw new Error('invalid host model/quota cap');
  }
  const accounts = new Map<string, string>();
  for (const [id, approved] of Object.entries(host.projects)) {
    const policy = approved.policy;
    if (policy.managed?.authorityRef !== 'project' || policy.managed.projectId !== id) throw new Error('invalid approved project policy');
    new SharedHostScheduler(new InMemoryAdmissionStore(), policy);
    if (approved.migrationFrom) {
      new SharedHostScheduler(new InMemoryAdmissionStore(), approved.migrationFrom);
      const prior = structuredClone(approved.migrationFrom), current = structuredClone(policy);
      if (prior.managed?.authorityRef !== 'project' || prior.managed.projectId !== id) throw new Error('invalid prior project activation');
      prior.managed.policyDigest = current.managed!.policyDigest;
      if (canonical(prior) !== canonical(current)) throw new Error('authority migration cannot change unrelated project policy');
    }
    if (canonical(Object.keys(approved.installations).sort()) !== canonical(Object.keys(policy.managed.installations).sort())) throw new Error('host must approve every project installation');
    const localAccounts = new Map<string, string>();
    for (const [cli, upstream] of Object.entries(approved.installations)) {
      if (!upstream.accountScope?.trim() || !upstream.quotaScope?.trim() || !Array.isArray(upstream.models)
        || upstream.models.some(model => !isCanonicalWorkerModelKey(model))) throw new Error('invalid qualified upstream identity');
      const localAccount = policy.managed.installations[cli]!.accountScope;
      const identity = canonical([upstream.accountScope, upstream.quotaScope]);
      if (localAccounts.has(localAccount) && localAccounts.get(localAccount) !== identity) throw new Error('conflicting project account aliases in host binding');
      localAccounts.set(localAccount, identity);
      const previous = accounts.get(upstream.accountScope);
      if (previous && previous !== upstream.quotaScope) throw new Error('conflicting upstream account quota aliases');
      accounts.set(upstream.accountScope, upstream.quotaScope);
    }
    const view = hostProjectAdmissionPolicy({ revision: 0, records: {}, hostBinding: host, projectGenerations: { [id]: 1 } }, id);
    new SharedHostScheduler(new InMemoryAdmissionStore(), view);
  }
  store.transact(snapshot => {
    if (snapshot.migration || snapshot.authorityRedirect || snapshot.policyBinding || Object.keys(snapshot.records).length
      || Object.keys(snapshot.allowances ?? {}).length || Object.keys(snapshot.cooldowns ?? {}).length) throw new Error('host authority activation requires an empty unbound store');
    if (snapshot.hostBinding && canonical(snapshot.hostBinding) !== canonical(host)) throw new Error('host authority is already bound to another policy revision');
    snapshot.hostBinding = host;
    snapshot.projectGenerations ??= {};
  });
}

function migrationContentDigest(snapshot: AdmissionSnapshot): string {
  const { revision: _revision, migration: _migration, authorityRedirect: _redirect, ...content } = snapshot;
  return createHash('sha256').update(canonical(content)).digest('hex');
}

/** Trusted owner operation on the same AdmissionStore implementation. Interruptions
 * remain closed. Resume the same id/binding; no stale-lock deletion or blind rollback. */
export function migrateProjectAdmissionToHost(source: AdmissionStore, target: AdmissionStore, projectId: string, options: {
  id: string; expectedSourceRevision: number; expectedTargetRevision: number;
  onPhase?: (phase: AdmissionMigration['phase']) => void;
}): void {
  if (source instanceof FileAdmissionStore) source.useDurableWrites();
  if (target instanceof FileAdmissionStore) target.useDurableWrites();
  if (source === target || !options.id.trim()) throw new Error('migration requires distinct authorities and a stable id');
  let local = source.read();
  let host = target.read();
  if (host.hostBinding?.hostId !== hostname()) throw new Error('migration requires a local trusted host binding');
  const approved = host.hostBinding.projects[projectId];
  if (!approved || canonical(approved.migrationFrom ?? approved.policy) !== canonical(local.policyBinding)) throw new Error('migration project policy is not host-approved');
  const bindingDigest = createHash('sha256').update(canonical(host.hostBinding)).digest('hex');
  const matches = (marker: AdmissionMigration | undefined): boolean => !!marker && marker.id === options.id
    && marker.projectId === projectId && marker.bindingDigest === bindingDigest;
  if (local.authorityRedirect && !host.migration) {
    if (local.authorityRedirect.migrationId === options.id && local.authorityRedirect.authorityRef === host.hostBinding.authorityRef
      && host.projectGenerations?.[projectId] === local.authorityRedirect.generation) return;
    throw new Error('project authority has already migrated');
  }
  if ((local.migration && !matches(local.migration)) || (host.migration && !matches(host.migration))) throw new Error('conflicting migration id or binding digest');
  if (!local.migration && !host.migration) {
    if (local.revision !== options.expectedSourceRevision || host.revision !== options.expectedTargetRevision) throw new Error('migration authority revision mismatch');
    if (host.projectGenerations?.[projectId]) throw new Error('project already has an active host generation');
  }
  const write = (store: AdmissionStore, expected: AdmissionSnapshot, mutate: (snapshot: AdmissionSnapshot) => void): void => {
    store.transact(snapshot => {
      if (snapshot.revision !== expected.revision) throw new Error('migration authority revision changed; both authorities remain frozen');
      mutate(snapshot);
    });
  };
  const marker: AdmissionMigration = { id: options.id, projectId, bindingDigest, phase: 'frozen' };
  // Close the old route first. The new project route has no generation yet, so
  // a crash between these writes cannot expose two usable authorities.
  if (!local.migration) write(source, local, snapshot => { snapshot.migration = marker; });
  if (!host.migration) write(target, host, snapshot => { snapshot.migration = marker; });
  local = source.read(); host = target.read();
  let phase = host.migration!.phase;
  if (phase === 'frozen') {
    options.onPhase?.('frozen');
    if ([...Object.values(local.records), ...Object.values(host.records)].some(record => record.state === 'admitted' || record.state === 'uncertain')) {
      throw new Error('migration requires proof-drained leases; live or uncertain work remains frozen');
    }
    const drained: AdmissionMigration = { ...marker, phase: 'drained', sourceDigest: migrationContentDigest(local), targetDigest: migrationContentDigest(host) };
    write(source, local, snapshot => { snapshot.migration = drained; });
    write(target, host, snapshot => { snapshot.migration = drained; });
    local = source.read(); host = target.read(); phase = 'drained';
  }
  if (phase === 'drained') {
    options.onPhase?.('drained');
    if (migrationContentDigest(local) !== host.migration!.sourceDigest || migrationContentDigest(host) !== host.migration!.targetDigest) throw new Error('migration history digest changed; reconcile under the trusted owner');
    write(target, host, snapshot => {
      const view = hostProjectAdmissionPolicy({ ...snapshot, projectGenerations: { ...snapshot.projectGenerations, [projectId]: 1 } }, projectId);
      const scopes = snapshot.allowances ??= {};
      for (const [key, scope] of Object.entries(local.allowances ?? {})) {
        const scoped = hostProjectKey(projectId, key);
        if (scopes[scoped]) throw new Error('migration allowance history conflicts');
        const budget = JSON.parse(key)[0] === 'run' ? view.managed!.budgets?.perRun : view.managed!.budgets?.perTask;
        const limits = intersectBudgets(scope.limits, projectBudgets(budget),
          JSON.parse(key)[0] === 'task' ? { maxAttempts: view.managed!.retry?.maxAttempts ?? 3 } : undefined);
        const deadline = Math.min(Date.parse(scope.deadlineAt ?? '') || Infinity,
          limits.timeoutSeconds === undefined ? Infinity : Date.parse(scope.startedAt) + limits.timeoutSeconds * 1000);
        scopes[scoped] = { ...structuredClone(scope), limits, ...(Number.isFinite(deadline) ? { deadlineAt: new Date(deadline).toISOString() } : {}) };
      }
      for (const record of Object.values(local.records)) {
        if (!record.managed || !record.accounting || (record.accounting.attemptNumber !== undefined && (record.state !== 'settled' || !record.accounting.stopEvidence))) throw new Error('history requires proof-checked managed reconciliation');
        if (record.accounting.stopEvidence) {
          assertValidWorkerPayload('workerHealthSummary', record.accounting.stopEvidence);
          if (record.accounting.stopEvidence.observerGeneration !== record.leaseGeneration || decideLeaseMapping({ leaseGeneration: record.leaseGeneration!,
            observedGeneration: record.leaseGeneration!, leaseState: 'admitted', settled: false,
            health: record.accounting.stopEvidence }) !== 'release-once') throw new Error('migration requires current-generation confirmed stop evidence');
        }
        const key = hostProjectKey(projectId, record.requestId);
        if (snapshot.records[key]) throw new Error('migration idempotency history conflicts');
        const imported = structuredClone(record);
        imported.projectId = projectId;
        if (imported.accounting) {
          imported.accounting.runKey = hostProjectKey(projectId, imported.accounting.runKey);
          imported.accounting.taskKey = hostProjectKey(projectId, imported.accounting.taskKey);
        }
        if (imported.managed) imported.dimensions = hostReservationDimensions(view.managed!, imported.managed,
          managedDimensionKeys(projectId, imported.managed));
        snapshot.records[key] = imported;
      }
      const cooldowns = snapshot.cooldowns ??= {};
      for (const [key, cooldown] of Object.entries(local.cooldowns ?? {})) {
        if (!Number.isFinite(Date.parse(cooldown.until)) || !Number.isSafeInteger(cooldown.failures) || cooldown.failures < 0) throw new Error('invalid migration cooldown history');
        const aliases = Object.entries((approved.migrationFrom ?? approved.policy).managed!.installations).filter(([, entry]) => `quota/${encodeURIComponent(entry.quotaScope)}` === key);
        if (!aliases.length) throw new Error('unbound cooldown history requires explicit reconciliation');
        const upstreamKeys = new Set(aliases.map(([cli]) => `quota/${encodeURIComponent(approved.installations[cli]!.quotaScope)}`));
        for (const upstreamKey of upstreamKeys) {
          const previous = cooldowns[upstreamKey];
          cooldowns[upstreamKey] = { until: previous && Date.parse(previous.until) > Date.parse(cooldown.until) ? previous.until : cooldown.until,
            failures: (previous?.failures ?? 0) + cooldown.failures };
        }
      }
      snapshot.migration = { ...snapshot.migration!, phase: 'reconciled' };
      snapshot.migration.targetDigest = migrationContentDigest(snapshot);
    });
    host = target.read(); phase = 'reconciled';
  }
  if (phase === 'reconciled') {
    options.onPhase?.('reconciled');
    local = source.read();
    if (migrationContentDigest(local) !== host.migration!.sourceDigest || migrationContentDigest(host) !== host.migration!.targetDigest) throw new Error('migration history digest changed before commit');
    write(target, host, snapshot => {
      (snapshot.projectGenerations ??= {})[projectId] = 1;
      snapshot.migration = { ...snapshot.migration!, phase: 'committed' };
      snapshot.migration.targetDigest = migrationContentDigest(snapshot);
    });
    host = target.read(); phase = 'committed';
  }
  if (phase === 'committed') {
    options.onPhase?.('committed');
    local = source.read();
    if (migrationContentDigest(local) !== host.migration!.sourceDigest || migrationContentDigest(host) !== host.migration!.targetDigest) throw new Error('history changed after migration commit');
    write(source, local, snapshot => {
      snapshot.authorityRedirect = { authorityRef: host.hostBinding!.authorityRef, generation: host.projectGenerations![projectId]!, migrationId: options.id };
    });
    write(target, host, snapshot => { delete snapshot.migration; });
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
    projectId: _project, attemptGeneration: _attempt, leaseGeneration: _lease, dimensions: _dimensions, reservedSlots: _slots, accounting: _accounting,
    launchClaimedAt: _launch, execution: _execution, health: _health, lastProgressAt: _progress, finalEvidence: _final, ...original } = record;
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

function validateBudgets(budgets: ManagedBudgets | undefined): void {
  for (const [key, value] of Object.entries(budgets ?? {})) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || (key === 'maxAttempts' && (!Number.isSafeInteger(value) || value < 1))) {
      throw new Error('invalid managed allowance ceiling');
    }
  }
}

function projectBudgets(budgets: { tokens?: number; costUsd?: number; wallSeconds?: number } | undefined): ManagedBudgets {
  return { maxTokens: budgets?.tokens, maxCostUsd: budgets?.costUsd, timeoutSeconds: budgets?.wallSeconds };
}

function intersectBudgets(...budgets: Array<ManagedBudgets | undefined>): ManagedBudgets {
  const result: ManagedBudgets = {};
  for (const budget of budgets) for (const key of ['maxAttempts', 'maxTokens', 'maxCostUsd', 'timeoutSeconds'] as const) {
    const value = budget?.[key];
    if (value !== undefined) result[key] = Math.min(result[key] ?? value, value);
  }
  return result;
}

function chargedUsage(record: AdmissionRecord, dimension: 'tokens' | 'costUsd'): number | null {
  const accounting = record.accounting!;
  const usage = accounting.usage;
  const measured = !usage || usage.quality === 'unknown' ? null : dimension === 'costUsd' ? usage.costUsd
    : usage.inputTokens === null || usage.outputTokens === null || usage.cacheTokens === null || usage.reasoningTokens === null ? null
      : usage.inputTokens + usage.outputTokens + usage.cacheTokens + usage.reasoningTokens;
  const reservation = accounting.reservation[dimension];
  // Uncertain execution can still accrue spend; estimates never refund a reserve.
  if (record.state !== 'settled' || usage?.quality !== 'reported') {
    return reservation === null || measured === null ? reservation : Math.max(reservation, measured);
  }
  return measured ?? reservation;
}

function canRefineUsage(previous: WorkerUsage, next: WorkerUsage): boolean {
  const rank = { unknown: 0, estimated: 1, reported: 2 };
  if (rank[next.quality] < rank[previous.quality]) return false;
  if (previous.quality !== 'reported') return true;
  return (['inputTokens', 'outputTokens', 'cacheTokens', 'reasoningTokens', 'costUsd'] as const)
    .every(key => previous[key] === null || (next[key] !== null && next[key]! >= previous[key]!));
}
