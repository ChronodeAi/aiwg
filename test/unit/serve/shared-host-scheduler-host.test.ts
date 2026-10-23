import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindManagedAdmissionPolicy, bindTrustedHostAdmissionPolicy, FileAdmissionStore,
  hostProjectAdmissionPolicy, InMemoryAdmissionStore, managedProjectAdmissionPolicy,
  migrateProjectAdmissionToHost, SharedHostScheduler,
  type AdmissionRequest, type AdmissionStore, type SharedHostPolicy, type TrustedHostAdmissionBinding,
} from '../../../src/serve/shared-host-scheduler.js';
import type { WorkerHealthSummary, WorkerUsage } from '../../../src/mission-protocol/types.js';

const epoch = Date.parse('2026-10-22T12:00:00Z');
const directories: string[] = [];
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'host-admission-'));
  directories.push(root);
  return root;
}
afterEach(() => directories.splice(0).forEach(root => rmSync(root, { force: true, recursive: true })));
function project(cap: number, quota: string): SharedHostPolicy {
  return managedProjectAdmissionPolicy(temporary(), {
    worker_mode: 'managed', worker_dispatch: true,
    admission: { memberCaps: { 'coding/spark': cap }, modelCaps: { 'synthetic/model': cap }, quotaCaps: { [quota]: cap } },
    clis: { first: { adapter: 'providers:codex', accountScope: quota, quotaScope: quota } },
    groups: { coding: { members: [{ id: 'spark', cli: 'first', model: 'model', roles: ['coding'] }] } },
  }, `sha256:${'a'.repeat(64)}`, cap);
}
function request(id: string, policy: SharedHostPolicy, overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return { requestId: id, orchestratorId: 'same-run', environment: 'synthetic', provider: 'synthetic', runtimeKind: 'host',
    priority: 1, submittedAt: new Date(epoch).toISOString(), queueTimeoutMs: 120_000,
    managed: { kind: 'external', group: 'coding', member: 'spark', cli: 'first', model: 'synthetic/model',
      quotaScope: policy.managed!.installations.first!.quotaScope },
    allowance: { runId: 'same-run', taskId: id, reservation: { tokens: 10, costUsd: 1 } }, ...overrides };
}
function proof(): WorkerHealthSummary {
  return { version: 1, state: 'completed', termination: 'confirmed', coverage: 'full', handshake: 'semantic',
    lastObservedAt: new Date(epoch).toISOString(), lastActivityAt: null, lastProgressAt: null,
    reasonCode: 'FINAL', transitionCount: 1, restartCount: 0, unavailableSignals: [], transitionRefs: [],
    observerGeneration: 1, startupDeadlineAt: null, hardDeadlineAt: null, maxCheckGapSeconds: 1,
    confidence: 'observed', handshakeAt: null, stalledAt: null };
}
const unknown: WorkerUsage = { quality: 'unknown', inputTokens: null, outputTokens: null, cacheTokens: null,
  reasoningTokens: null, costUsd: null, reservedTokens: 10, reservedUsd: 1 };
function setup(file = false) {
  const a = project(1, 'local-a'), b = project(3, 'local-b');
  const idA = a.managed!.projectId, idB = b.managed!.projectId;
  const root = temporary();
  const target: AdmissionStore = file ? new FileAdmissionStore(join(root, 'host.json')) : new InMemoryAdmissionStore();
  const sourceA = new InMemoryAdmissionStore(), sourceB = new InMemoryAdmissionStore();
  bindManagedAdmissionPolicy(sourceA, a); bindManagedAdmissionPolicy(sourceB, b);
  const binding: TrustedHostAdmissionBinding = { authorityRef: 'host:synthetic', hostId: hostname(), revision: 1,
    policy: { maxConcurrent: 4, defaultHostQuota: 4, leaseTtlMs: 60_000, agingIntervalMs: 30_000, allowPreemption: false },
    maxQueued: 16, dimensionCaps: { 'model/synthetic/model': 3, 'quota/upstream': 3 },
    projects: Object.fromEntries([a, b].map(policy => [policy.managed!.projectId, { policy,
      installations: { first: { accountScope: 'canonical-account', quotaScope: 'upstream', models: ['synthetic/model'] } } }])) };
  bindTrustedHostAdmissionPolicy(target, binding);
  const migrate = (source: AdmissionStore, id: string, onPhase?: Parameters<typeof migrateProjectAdmissionToHost>[3]['onPhase']) =>
    migrateProjectAdmissionToHost(source, target, id, { id: `migration-${id}`, expectedSourceRevision: source.read().revision,
      expectedTargetRevision: target.read().revision, onPhase });
  const activate = () => { migrate(sourceA, idA); migrate(sourceB, idB); };
  const scheduler = (id: string) => new SharedHostScheduler(target, hostProjectAdmissionPolicy(target.read(), id), () => epoch);
  return { a, b, idA, idB, binding, root, sourceA, sourceB, target, migrate, activate, scheduler };
}

describe('T-OG-05 S4 trusted participating-project authority', () => {
  it('keeps conflicting project caps and identical local member/request/run IDs independent', () => {
    const s = setup(); s.activate();
    const a = s.scheduler(s.idA), b = s.scheduler(s.idB);
    expect(a.submit(request('same', s.a)).state).toBe('admitted');
    expect(a.submit(request('waiting', s.a)).state).toBe('queued');
    expect(b.submit(request('same', s.b)).state).toBe('admitted');
    expect(b.submit(request('second', s.b)).state).toBe('admitted');
    expect(b.submit(request('third', s.b)).state).toBe('queued');
    expect(a.snapshot().records.same!.dimensions).toContain(`project/${s.idA}/group/coding/member/spark`);
    expect(b.snapshot().records.same!.dimensions).toContain(`project/${s.idB}/group/coding/member/spark`);
    expect(a.snapshot().records.same!.accounting!.runKey).not.toBe(b.snapshot().records.same!.accounting!.runKey);
    expect(a.submit(request('same', s.a)).state).toBe('admitted');
    expect(() => a.submit(request('same', s.a, { priority: 2 }))).toThrow(/conflicts/);
    expect(() => a.cancel('second', 1)).toThrow(/unknown/);
    expect(Object.values(s.target.read().records).filter(record => record.state === 'admitted')).toHaveLength(3);
  });

  it.each(['model', 'quota'] as const)('aggregates the canonical upstream %s across project aliases and durable reopen', dimension => {
    const s = setup(true);
    s.target.transact(snapshot => { snapshot.hostBinding!.dimensionCaps[dimension === 'model' ? 'model/synthetic/model' : 'quota/upstream'] = 1; });
    s.activate();
    const a = s.scheduler(s.idA), b = s.scheduler(s.idB);
    a.submit(request('a', s.a));
    expect(b.submit(request('b', s.b)).state).toBe('queued');
    const reopened = new SharedHostScheduler(new FileAdmissionStore(join(s.root, 'host.json')), hostProjectAdmissionPolicy(s.target.read(), s.idB), () => epoch);
    expect(Object.keys(reopened.reconcileNow().records)).toEqual(['b']);
    a.settle('a', 1, proof(), unknown);
    expect(reopened.snapshot().records.b!.state).toBe('admitted');
  });

  it('reconciles a queued sibling against its own budget, cooldown and lease policy', () => {
    const s = setup();
    s.target.transact(snapshot => {
      snapshot.hostBinding!.projects[s.idB]!.policy.managed!.budgets = { unknownCost: 'deny' };
      snapshot.hostBinding!.projects[s.idB]!.policy.leaseTtlMs = 1500;
      snapshot.hostBinding!.policy.maxConcurrent = 1;
    });
    // The migration must use the exact newly approved project input.
    s.sourceB.transact(snapshot => { snapshot.policyBinding = structuredClone(s.target.read().hostBinding!.projects[s.idB]!.policy); });
    s.activate();
    const a = s.scheduler(s.idA), b = s.scheduler(s.idB);
    a.submit(request('a', s.a)); b.submit(request('b', s.b));
    a.settle('a', 1, proof(), unknown);
    expect(b.snapshot().records.b!.leaseExpiresAt).toBe(new Date(epoch + 1500).toISOString());
  });

  it.each(['looser-cap', 'stale-revision', 'stale-generation', 'legacy', 'foreign-project'] as const)('rejects %s writers without changing history', vector => {
    const s = setup(); s.activate();
    const policy = hostProjectAdmissionPolicy(s.target.read(), s.idA);
    if (vector === 'looser-cap') policy.maxConcurrent++;
    if (vector === 'stale-revision') policy.managed!.hostPolicyRevision = 0;
    if (vector === 'stale-generation') policy.managed!.authorityGeneration = 0;
    if (vector === 'foreign-project') policy.managed!.projectId = 'f'.repeat(64);
    if (vector === 'legacy') delete policy.managed;
    const stale = new SharedHostScheduler(s.target, policy, () => epoch);
    const before = s.target.read();
    expect(() => stale.reconcileNow()).toThrow(/binding/);
    expect(s.target.read()).toEqual(before);
  });

  it.each(['renew', 'stop', 'settle', 'acceptFinal'] as const)('fences stale host %s operations without changing current stop proof', operation => {
    const s = setup(); s.activate(); const scheduler = s.scheduler(s.idA);
    scheduler.submit(request('a', s.a));
    s.target.transact(snapshot => { snapshot.hostBinding!.revision++; });
    const before = s.target.read();
    expect(() => {
      if (operation === 'renew') scheduler.renew('a', 1);
      if (operation === 'stop') scheduler.stop('a', 1);
      if (operation === 'settle') scheduler.settle('a', 1, proof(), unknown);
      if (operation === 'acceptFinal') scheduler.acceptFinal('a', 1, proof());
    }).toThrow(/revision/);
    expect(s.target.read()).toEqual(before);
  });

  it('retains cross-project capacity after cancellation and late finals until confirmed settlement', () => {
    const s = setup(); s.target.transact(snapshot => { snapshot.hostBinding!.policy.maxConcurrent = 1; });
    s.activate(); const a = s.scheduler(s.idA), b = s.scheduler(s.idB);
    a.submit(request('a', s.a)); b.submit(request('b', s.b));
    a.cancel('a', 1); a.acceptFinal('a', 1, proof(), unknown);
    expect(b.reconcileNow().records.b!.state).toBe('queued');
    a.settle('a', 1, { ...proof(), termination: 'uncertain' }, unknown);
    expect(b.snapshot().records.b!.state).toBe('queued');
    a.settle('a', 1, proof(), unknown);
    expect(b.snapshot().records.b!.state).toBe('admitted');
  });

  it('enforces the host queue bound while retaining each project queue ceiling', () => {
    const s = setup(); s.target.transact(snapshot => {
      snapshot.hostBinding!.policy.maxConcurrent = 1; snapshot.hostBinding!.maxQueued = 2;
      snapshot.hostBinding!.projects[s.idA]!.policy.managed!.maxQueued = 1;
    });
    s.sourceA.transact(snapshot => { snapshot.policyBinding = structuredClone(s.target.read().hostBinding!.projects[s.idA]!.policy); });
    s.activate(); const a = s.scheduler(s.idA), b = s.scheduler(s.idB);
    a.submit(request('running', s.a));
    expect(a.submit(request('waiting', s.a)).state).toBe('queued');
    expect(a.submit(request('project-full', s.a)).state).toBe('denied');
    expect(b.submit(request('waiting', s.b)).state).toBe('queued');
    expect(b.submit(request('host-full', s.b)).state).toBe('denied');
  });

  it('requires approved installation models and rejects forged project namespaces', () => {
    const s = setup(); s.activate(); const scheduler = s.scheduler(s.idA);
    const value = request('a', s.a);
    expect(() => scheduler.submit({ ...value, managed: { ...value.managed!, model: 'synthetic/other' } })).toThrow(/approved/);
    expect(() => scheduler.submit({ ...value, projectId: s.idB } as AdmissionRequest)).toThrow(/cannot choose/);
    expect(Object.keys(s.target.read().records)).toHaveLength(0);
  });

  it('counts unknown native workers without consuming another project local members', () => {
    const s = setup(); s.activate();
    expect(s.scheduler(s.idA).submit(request('native', s.a, { managed: { kind: 'native' } })).state).toBe('admitted');
    expect(s.scheduler(s.idB).submit(request('b', s.b)).state).toBe('admitted');
  });

  it.each(['cross-host', 'account-alias', 'unapproved-installation', 'invalid-model', 'hard-budget', 'looser-prior-policy', 'local-account-alias'] as const)('rejects %s activation', vector => {
    const s = setup(); const binding = structuredClone(s.binding);
    if (vector === 'cross-host') binding.hostId += '-other';
    if (vector === 'account-alias') binding.projects[s.idB]!.installations.first!.quotaScope = 'another';
    if (vector === 'unapproved-installation') delete binding.projects[s.idB]!.installations.first;
    if (vector === 'invalid-model') binding.projects[s.idB]!.installations.first!.models = ['synthetic/%6Dodel'];
    if (vector === 'local-account-alias') {
      binding.projects[s.idB]!.policy.managed!.installations.second = { ...binding.projects[s.idB]!.policy.managed!.installations.first! };
      binding.projects[s.idB]!.installations.second = { accountScope: 'different-account', quotaScope: 'different-quota', models: ['synthetic/model'] };
    }
    if (vector === 'hard-budget') binding.budgets = { enforcement: 'hard' };
    if (vector === 'looser-prior-policy') {
      binding.projects[s.idB]!.migrationFrom = structuredClone(s.b);
      binding.projects[s.idB]!.migrationFrom!.maxConcurrent++;
    }
    expect(() => bindTrustedHostAdmissionPolicy(new InMemoryAdmissionStore(), binding)).toThrow();
  });

  it('shares upstream cooldowns without allowing a second project to shorten them', () => {
    const s = setup(); s.activate(); const a = s.scheduler(s.idA), b = s.scheduler(s.idB);
    a.submit(request('a', s.a));
    a.recordRateLimit('a', 1, { resetAt: new Date(epoch + 60_000).toISOString() });
    expect(b.submit(request('b', s.b)).state).toBe('queued');
    expect(s.target.read().cooldowns!['quota/upstream']!.until).toBe(new Date(epoch + 60_000).toISOString());
    a.settle('a', 1, proof(), unknown);
    expect(b.snapshot().records.b!.state).toBe('queued');
  });
});

describe('T-OG-05/06 S4 freeze/drain/reconcile migration', () => {
  it.each(['frozen', 'drained', 'reconciled', 'committed'] as const)('blocks both routes after a fault at %s and resumes exactly once after durable reopen', phase => {
    const s = setup(true);
    const sourcePath = join(temporary(), 'project.json');
    const source = new FileAdmissionStore(sourcePath);
    bindManagedAdmissionPolicy(source, s.a);
    const local = new SharedHostScheduler(source, s.a, () => epoch);
    const original = request('spent', s.a);
    local.submit(original); local.recordRateLimit('spent', 1, { resetAt: new Date(epoch + 90_000).toISOString() });
    local.settle('spent', 1, proof(), unknown);
    expect(() => s.migrate(source, s.idA, at => { if (at === phase) throw new Error(`fault-${phase}`); })).toThrow(`fault-${phase}`);
    expect(() => local.submit(request('new', s.a))).toThrow(/frozen|migrated/);
    expect(s.target.read().migration).toBeDefined();
    if (s.target.read().projectGenerations?.[s.idA]) expect(() => s.scheduler(s.idA).submit(request('new', s.a))).toThrow(/frozen/);
    const reopenedSource = new FileAdmissionStore(sourcePath), reopenedTarget = new FileAdmissionStore(join(s.root, 'host.json'));
    const resume = () => migrateProjectAdmissionToHost(reopenedSource, reopenedTarget, s.idA,
      { id: `migration-${s.idA}`, expectedSourceRevision: 0, expectedTargetRevision: 0 });
    resume(); const after = reopenedTarget.read(); resume();
    expect(reopenedTarget.read()).toEqual(after);
    expect(Object.values(after.records)).toHaveLength(1);
    expect(after.migration).toBeUndefined();
    const host = s.scheduler(s.idA);
    expect(host.submit(original).state).toBe('settled');
    expect(host.snapshot().records.spent!.accounting!.usage).toEqual(unknown);
    expect(after.cooldowns!['quota/upstream']!.until).toBe(new Date(epoch + 90_000).toISOString());
    expect(() => local.renew('spent', 1)).toThrow(/migrated/);
  });

  it.each(['admitted', 'uncertain'] as const)('refuses migration while a lease is %s and permits proof settlement while frozen', state => {
    const s = setup(); const local = new SharedHostScheduler(s.sourceA, s.a, () => epoch);
    local.submit(request('a', s.a));
    if (state === 'uncertain') local.disconnect('a', 1);
    expect(() => s.migrate(s.sourceA, s.idA)).toThrow(/live or uncertain/);
    expect(s.sourceA.read().migration).toBeDefined(); expect(s.target.read().migration).toBeDefined();
    expect(() => local.claimLaunch('a', 1)).toThrow(/frozen/);
    local.settle('a', 1, proof(), unknown);
    s.migrate(s.sourceA, s.idA);
    expect(s.scheduler(s.idA).snapshot().records.a!.state).toBe('settled');
  });

  it('refuses migration while another participating project has an uncertain host lease', () => {
    const s = setup(); s.migrate(s.sourceA, s.idA); const a = s.scheduler(s.idA);
    a.submit(request('a', s.a)); a.disconnect('a', 1);
    expect(() => s.migrate(s.sourceB, s.idB)).toThrow(/live or uncertain/);
    expect(s.sourceB.read().migration).toBeDefined(); expect(s.target.read().migration).toBeDefined();
    a.settle('a', 1, proof(), unknown); s.migrate(s.sourceB, s.idB);
    expect(s.scheduler(s.idB).submit(request('b', s.b)).state).toBe('admitted');
  });

  it('transfers original deadlines and unknown spend and intersects tighter host ceilings', () => {
    const s = setup();
    s.target.transact(snapshot => { snapshot.hostBinding!.budgets = { perRun: { tokens: 15, wallSeconds: 30 } }; });
    const local = new SharedHostScheduler(s.sourceA, s.a, () => epoch);
    const spent = request('spent', s.a, { allowance: { runId: 'same-run', taskId: 'task', runBudgets: { maxTokens: 20, timeoutSeconds: 60 }, reservation: { tokens: 10, costUsd: 1 } } });
    local.submit(spent); local.settle('spent', 1, proof(), unknown);
    s.migrate(s.sourceA, s.idA);
    const host = s.scheduler(s.idA), record = host.snapshot().records.spent!;
    expect(host.snapshot().allowances![record.accounting!.runKey]).toMatchObject({ limits: { maxTokens: 15 },
      startedAt: new Date(epoch).toISOString(), deadlineAt: new Date(epoch + 30_000).toISOString() });
    expect(host.submit(request('new', s.a)).state).toBe('denied');
  });

  it('keeps both authorities closed when the transfer transaction fails before its marker is written', () => {
    const s = setup(); const local = new SharedHostScheduler(s.sourceA, s.a, () => epoch);
    local.submit(request('spent', s.a)); local.settle('spent', 1, proof(), unknown);
    const faulting: AdmissionStore = { read: () => s.target.read(), transact: mutate => s.target.transact(snapshot => {
      const result = mutate(snapshot);
      if (snapshot.migration?.phase === 'reconciled') throw new Error('synthetic disk pressure');
      return result;
    }) };
    expect(() => migrateProjectAdmissionToHost(s.sourceA, faulting, s.idA, { id: `migration-${s.idA}`,
      expectedSourceRevision: s.sourceA.read().revision, expectedTargetRevision: s.target.read().revision })).toThrow(/disk pressure/);
    expect(s.target.read().migration!.phase).toBe('drained');
    expect(Object.keys(s.target.read().records)).toHaveLength(0);
    expect(() => local.submit(request('new', s.a))).toThrow(/frozen/);
    s.migrate(s.sourceA, s.idA);
    expect(s.scheduler(s.idA).snapshot().records.spent!.state).toBe('settled');
  });

  it('merges two projects history without colliding IDs or shortening shared cooldowns', () => {
    const s = setup();
    for (const [policy, source, id, seconds] of [[s.a, s.sourceA, s.idA, 90], [s.b, s.sourceB, s.idB, 30]] as const) {
      const local = new SharedHostScheduler(source, policy, () => epoch);
      local.submit(request('same', policy));
      local.recordRateLimit('same', 1, { resetAt: new Date(epoch + seconds * 1000).toISOString() });
      local.settle('same', 1, proof(), unknown); s.migrate(source, id);
    }
    expect(Object.values(s.target.read().records)).toHaveLength(2);
    expect(s.target.read().cooldowns!['quota/upstream']!.until).toBe(new Date(epoch + 90_000).toISOString());
    expect(s.target.read().cooldowns!['quota/upstream']!.failures).toBe(2);
    expect(s.scheduler(s.idA).snapshot().records.same!.accounting!.runKey).not.toBe(s.scheduler(s.idB).snapshot().records.same!.accounting!.runKey);
  });

  it('transfers one local quota history once when multiple installations share its canonical alias', () => {
    const s = setup(); const policy = structuredClone(s.a);
    policy.managed!.installations.second = { ...policy.managed!.installations.first! };
    s.sourceA.transact(snapshot => { snapshot.policyBinding = policy; });
    s.target.transact(snapshot => {
      snapshot.hostBinding!.projects[s.idA]!.policy = policy;
      snapshot.hostBinding!.projects[s.idA]!.installations.second = { ...snapshot.hostBinding!.projects[s.idA]!.installations.first! };
    });
    const local = new SharedHostScheduler(s.sourceA, policy, () => epoch);
    local.submit(request('spent', policy)); local.recordRateLimit('spent', 1); local.settle('spent', 1, proof(), unknown);
    s.migrate(s.sourceA, s.idA);
    expect(s.target.read().cooldowns!['quota/upstream']!.failures).toBe(1);
  });

  it.each(['stale-proof', 'uncertain-proof', 'malformed-cooldown'] as const)('blocks corrupt %s history instead of importing it as settled', vector => {
    const s = setup(); const local = new SharedHostScheduler(s.sourceA, s.a, () => epoch);
    local.submit(request('spent', s.a)); local.settle('spent', 1, proof(), unknown);
    s.sourceA.transact(snapshot => {
      if (vector === 'stale-proof') snapshot.records.spent!.accounting!.stopEvidence!.observerGeneration = 0;
      if (vector === 'uncertain-proof') snapshot.records.spent!.accounting!.stopEvidence!.termination = 'uncertain';
      if (vector === 'malformed-cooldown') snapshot.cooldowns = { 'quota/local-a': { until: 'invalid', failures: 1 } };
    });
    expect(() => s.migrate(s.sourceA, s.idA)).toThrow(/evidence|cooldown/);
    expect(Object.values(s.target.read().records)).toHaveLength(0);
    expect(s.target.read().migration).toBeDefined();
  });

  it('compares authority revisions before freezing and rejects changed history or binding on recovery', () => {
    const s = setup();
    expect(() => migrateProjectAdmissionToHost(s.sourceA, s.target, s.idA, { id: 'stale', expectedSourceRevision: 0, expectedTargetRevision: 0 })).toThrow(/revision/);
    expect(s.sourceA.read().migration).toBeUndefined();
    expect(() => s.migrate(s.sourceA, s.idA, phase => { if (phase === 'drained') throw new Error('fault'); })).toThrow('fault');
    s.sourceA.transact(snapshot => { snapshot.cooldowns = { 'quota/local-a': { until: new Date(epoch + 1000).toISOString(), failures: 1 } }; });
    expect(() => s.migrate(s.sourceA, s.idA)).toThrow(/digest changed/);
    s.target.transact(snapshot => { snapshot.hostBinding!.revision++; });
    expect(() => s.migrate(s.sourceA, s.idA)).toThrow(/conflicting migration/);
    expect(s.target.read().migration).toBeDefined();
  });
});

describe('T-OG-10 protected host file authority', () => {
  it('rejects writable mounts, permissive modes, symlinks and hardlinks and preserves protected writes', () => {
    const s = setup(true); const store = s.target as FileAdmissionStore;
    expect(() => store.protectHostAuthority([s.root])).toThrow(/writable mount/);
    store.protectHostAuthority([]);
    s.activate();
    expect(s.scheduler(s.idA).submit(request('a', s.a)).state).toBe('admitted');
    const filename = join(s.root, 'host.json');
    chmodSync(filename, 0o644); expect(() => store.read()).toThrow(/private/); chmodSync(filename, 0o600);
    const alias = join(s.root, 'alias'); linkSync(filename, alias); expect(() => store.read()).toThrow(/private/); rmSync(alias);
    renameSync(filename, alias); symlinkSync(alias, filename); expect(() => store.read()).toThrow();
  });

  it('rejects noncanonical and nonprivate host directories', () => {
    const s = setup(true);
    chmodSync(s.root, 0o755); expect(() => (s.target as FileAdmissionStore).protectHostAuthority([])).toThrow(/private/);
    chmodSync(s.root, 0o700);
    const parent = temporary(); const alias = join(parent, 'alias'); symlinkSync(s.root, alias);
    expect(() => new FileAdmissionStore(join(alias, 'host.json')).protectHostAuthority([])).toThrow(/canonical/);
    mkdirSync(join(parent, 'worker'));
  });
});
