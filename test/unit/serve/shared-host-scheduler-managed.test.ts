import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  bindManagedAdmissionPolicy, FileAdmissionStore, InMemoryAdmissionStore,
  managedDimensionKeys, managedProjectAdmissionPolicy, projectAdmissionAuthority, SharedHostScheduler,
  type AdmissionRequest, type SharedHostPolicy,
} from '../../../src/serve/shared-host-scheduler.js';
import type { ParallelismConfig } from '../../../src/config/aiwg-config.js';

const now = Date.parse('2026-10-22T12:00:00Z');
const digest = `sha256:${'a'.repeat(64)}`;
const directories: string[] = [];
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-admission-'));
  directories.push(dir);
  return dir;
}
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function config(): ParallelismConfig {
  return {
    worker_dispatch: true, worker_mode: 'managed',
    clis: {
      first: { adapter: 'providers:codex', accountScope: 'account-one', quotaScope: 'pool/one' },
      second: { adapter: 'providers:codex', accountScope: 'account-one', quotaScope: 'pool/one' },
    },
    groups: {
      coding: { members: [{ id: 'spark', cli: 'first', model: 'model', roles: ['coding'] }] },
      review: { members: [{ id: 'spark', cli: 'second', model: 'model', roles: ['coding'] }] },
    },
  };
}
function policy(): SharedHostPolicy {
  return managedProjectAdmissionPolicy(temporary(), config(), digest, 4);
}
function request(id: string, overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    requestId: id, orchestratorId: 'synthetic-owner', environment: 'test', provider: 'codex',
    runtimeKind: 'host', priority: 10, submittedAt: new Date(now).toISOString(), queueTimeoutMs: 60_000,
    managed: { kind: 'external', group: 'coding', member: 'spark', cli: 'first', model: 'openai/a%2Fb%25c', quotaScope: 'pool/one' },
    ...overrides,
  };
}
function setup(value = policy(), clock = () => now) {
  const store = new InMemoryAdmissionStore();
  bindManagedAdmissionPolicy(store, value);
  return { store, scheduler: new SharedHostScheduler(store, value, clock), policy: value };
}

describe('T-OG-05 managed admission dimensions', () => {
  it('canonicalizes project aliases and namespaces group-local members while sharing model/quota keys', () => {
    const root = temporary();
    const alias = join(temporary(), 'alias');
    symlinkSync(root, alias);
    expect(projectAdmissionAuthority(alias)).toEqual(projectAdmissionAuthority(root));
    const id = projectAdmissionAuthority(root).projectId;
    const coding = managedDimensionKeys(id, request('a').managed!);
    const review = managedDimensionKeys(id, { ...request('a').managed!, group: 'review', cli: 'second' });
    expect(coding).toContain(`project/${id}/group/coding/member/spark`);
    expect(review).toContain(`project/${id}/group/review/member/spark`);
    expect(coding.slice(-2)).toEqual(['model/openai/a%2Fb%25c', 'quota/pool%2Fone']);
    expect(review.slice(-2)).toEqual(coding.slice(-2));
    for (const model of ['openai/a/b', 'openai/a%2fb', 'openai/%61']) {
      expect(() => managedDimensionKeys(id, { kind: 'native', model })).toThrow(/canonical model/);
    }
    expect(() => managedDimensionKeys(id, { kind: 'native', group: 'coding/review' })).toThrow(/canonical worker/);
  });

  it.each(['global', 'group', 'member', 'cli', 'model', 'quota'])('reserves the lower bound atomically against the %s dimension', dimension => {
    const value = policy();
    const keys = managedDimensionKeys(value.managed!.projectId, request('a').managed!);
    const index = ['global', 'group', 'member', 'cli', 'model', 'quota'].indexOf(dimension);
    if (dimension === 'global') value.maxConcurrent = 3;
    else value.managed!.dimensionCaps[keys[index]!] = 3;
    const { scheduler } = setup(value);
    expect(scheduler.submit(request('a', { managed: { ...request('a').managed!, lowerBound: 2 } }))).toMatchObject({
      state: 'admitted', reservedSlots: 2, attemptGeneration: 1, leaseGeneration: 1,
    });
    expect(scheduler.submit(request('b', { managed: { ...request('b').managed!, lowerBound: 2 } })).state).toBe('queued');
    expect(scheduler.submit(request('c')).state).toBe('admitted');
    expect(Object.values(scheduler.snapshot().records).filter(row => row.state === 'admitted').map(row => row.requestId)).toEqual(['a', 'c']);
  });

  it('uses the minimum of group ceilings and admission caps', () => {
    const cfg = config();
    cfg.groups!.coding!.maxParallel = 1;
    cfg.admission = { groupCaps: { coding: 3 } };
    const value = managedProjectAdmissionPolicy(temporary(), cfg, digest, 4);
    const { scheduler } = setup(value);
    expect(scheduler.submit(request('a')).state).toBe('admitted');
    expect(scheduler.submit(request('b')).state).toBe('queued');
  });

  it('keeps identical member IDs independent across groups', () => {
    const value = policy();
    value.managed!.dimensionCaps[managedDimensionKeys(value.managed!.projectId, request('a').managed!)[2]!] = 1;
    const { scheduler } = setup(value);
    scheduler.submit(request('a'));
    expect(scheduler.submit(request('b')).state).toBe('queued');
    expect(scheduler.submit(request('c', { managed: { ...request('c').managed!, group: 'review', cli: 'second' } })).state).toBe('admitted');
  });

  it.each(['environment', 'provider', 'runtime'])('applies the lower bound to the existing %s quota', dimension => {
    const value = policy();
    if (dimension === 'environment') value.environmentQuotas = { test: 2 };
    if (dimension === 'provider') value.providerQuotas = { codex: 2 };
    if (dimension === 'runtime') value.runtimeQuotas = { host: 2 };
    const { scheduler } = setup(value);
    scheduler.submit(request('a', { managed: { ...request('a').managed!, lowerBound: 2 } }));
    expect(scheduler.submit(request('b')).state).toBe('queued');
  });

  it.each(['model', 'quota'])('shares the %s cap between installations and groups', dimension => {
    const value = policy();
    const keys = managedDimensionKeys(value.managed!.projectId, request('a').managed!);
    value.managed!.dimensionCaps[keys[dimension === 'model' ? 4 : 5]!] = 1;
    const { scheduler } = setup(value);
    scheduler.submit(request('a'));
    expect(scheduler.submit(request('b', { managed: { ...request('b').managed!, group: 'review', cli: 'second' } })).state).toBe('queued');
  });

  it('counts native workers with unknown dimensions conservatively', () => {
    const value = policy();
    value.managed!.dimensionCaps['model/openai/a%2Fb%25c'] = 1;
    const { scheduler } = setup(value);
    expect(scheduler.submit(request('native', { managed: { kind: 'native' } })).state).toBe('admitted');
    expect(scheduler.submit(request('external')).state).toBe('queued');
  });

  it('counts pre-existing native leases when the project authority is bound', () => {
    const store = new InMemoryAdmissionStore();
    const value = policy();
    const { managed: _managed, ...legacy } = value;
    const native = new SharedHostScheduler(store, legacy, () => now);
    native.submit(request('native', { managed: undefined }));
    value.managed!.dimensionCaps['model/openai/a%2Fb%25c'] = 1;
    bindManagedAdmissionPolicy(store, value);
    expect(new SharedHostScheduler(store, value, () => now).submit(request('external')).state).toBe('queued');
  });

  it('rejects ambiguous account aliases, unbound installation quotas and unenforceable hard budgets', () => {
    const value = policy();
    value.managed!.installations.second!.quotaScope = 'different-pool';
    expect(() => setup(value)).toThrow(/ambiguous account aliases/);
    const { scheduler } = setup();
    expect(() => scheduler.submit(request('wrong-quota', { managed: { ...request('a').managed!, quotaScope: 'different-pool' } }))).toThrow(/binding/);
    expect(() => scheduler.submit(request('wrong-member', { managed: { ...request('a').managed!, group: 'review' } }))).toThrow(/binding/);
    expect(() => scheduler.submit(request('missing', { managed: undefined }))).toThrow(/identity/);
    expect(() => scheduler.submit(request('bad-bound', { managed: { ...request('a').managed!, lowerBound: 0 } }))).toThrow(/lowerBound/);
    const cfg = config();
    cfg.budgets = { enforcement: 'hard', perTask: { costUsd: 1 } };
    expect(() => managedProjectAdmissionPolicy(temporary(), cfg, digest, 4)).toThrow(/OG_BUDGET_UNMEASURABLE/);
    cfg.admission = { authorityRef: 'host:elsewhere' };
    expect(() => managedProjectAdmissionPolicy(temporary(), cfg, digest, 4)).toThrow(/project admission authority/);
  });

  it.each(['model/openai/a%2fb', 'quota/pool%2fone', 'project/elsewhere/group/coding'])('rejects noncanonical policy dimension %s', key => {
    const value = policy();
    value.managed!.dimensionCaps[key] = 1;
    expect(() => setup(value)).toThrow(/canonical admission dimension/);
  });

  it('shares the existing MC store between two actual processes and rejects stale policy', async () => {
    const root = temporary();
    const authority = projectAdmissionAuthority(root);
    const value = managedProjectAdmissionPolicy(root, config(), digest, 1);
    bindManagedAdmissionPolicy(new FileAdmissionStore(authority.path), value);
    const script = join(root, 'caller.mts');
    writeFileSync(script, `import { FileAdmissionStore, SharedHostScheduler } from ${JSON.stringify(resolve('src/serve/shared-host-scheduler.ts'))};
const [path, policy, request] = process.argv.slice(2);
const scheduler = new SharedHostScheduler(new FileAdmissionStore(path), JSON.parse(policy), () => ${now});
process.stdout.write(scheduler.submit(JSON.parse(request)).state);\n`);
    const child = (id: string, active = value) => promisify(execFile)(process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), script, authority.path, JSON.stringify(active), JSON.stringify(request(id))],
      { timeout: 15_000, maxBuffer: 32_000 });
    expect((await child('first')).stdout).toBe('admitted');
    expect((await child('second')).stdout).toBe('queued');
    const stale = structuredClone(value);
    stale.managed!.policyDigest = `sha256:${'b'.repeat(64)}`;
    await expect(child('stale', stale)).rejects.toThrow(/policy digest or policy binding mismatch/);
    expect(Object.keys(new FileAdmissionStore(authority.path).read().records)).toEqual(['first', 'second']);
  }, 45_000);
});

describe('T-OG-05/06 managed queue and retained uncertainty', () => {
  it('bounds queueing and never admits cancelled, expired or denied requests on replay', () => {
    let current = now;
    const value = policy();
    value.maxConcurrent = 1;
    value.managed!.maxQueued = 2;
    const { scheduler } = setup(value, () => current);
    scheduler.submit(request('running'));
    scheduler.submit(request('cancelled'));
    scheduler.submit(request('expired', { queueTimeoutMs: 10 }));
    expect(scheduler.submit(request('full')).state).toBe('denied');
    expect(scheduler.cancel('cancelled', 1).state).toBe('cancelled');
    current += 11;
    scheduler.reconcileNow();
    expect(scheduler.submit(request('cancelled')).state).toBe('cancelled');
    expect(scheduler.submit(request('expired', { queueTimeoutMs: 10 })).state).toBe('timed-out');
    expect(scheduler.submit(request('full')).state).toBe('denied');
  });

  it('allows immediate admission with a zero queue bound and rejects waiting work', () => {
    const value = policy();
    value.maxConcurrent = 1;
    value.managed!.maxQueued = 0;
    const { scheduler } = setup(value);
    expect(scheduler.submit(request('running')).state).toBe('admitted');
    expect(scheduler.submit(request('waiting')).state).toBe('denied');
  });

  it.each(['expiry', 'cancel', 'preemption'])('retains uncertain or active capacity after %s and forbids unproved release', trigger => {
    let current = now;
    const value = policy();
    value.maxConcurrent = 1;
    value.allowPreemption = true;
    const { scheduler } = setup(value, () => current);
    scheduler.submit(request('running', { preemptible: true, priority: 0 }));
    if (trigger === 'expiry') current += value.leaseTtlMs + 1;
    if (trigger === 'cancel') scheduler.cancel('running', 1);
    expect(scheduler.submit(request('replacement', { priority: 100, submittedAt: new Date(current).toISOString() })).state).toBe('queued');
    expect(scheduler.snapshot().records.running!.state).toBe(trigger === 'preemption' ? 'admitted' : 'uncertain');
    expect(() => scheduler.release('running')).toThrow(/proof-checked settlement/);
    expect(scheduler.snapshot().records.running!.finishedAt).toBeUndefined();
  });

  it('requires the exact bound policy on every transaction, including legacy callers', () => {
    const value = policy();
    const { store, scheduler } = setup(value);
    scheduler.submit(request('running'));
    const stale = structuredClone(value);
    stale.managed!.policyDigest = `sha256:${'b'.repeat(64)}`;
    const loose = structuredClone(value);
    loose.maxConcurrent += 1;
    const { managed: _managed, ...legacy } = value;
    for (const candidate of [stale, loose, legacy]) {
      const other = new SharedHostScheduler(store, candidate, () => now);
      const before = store.read();
      for (const operation of [() => other.reconcileNow(), () => other.renew('running'),
        () => other.cancel('running'), () => other.release('running')]) expect(operation).toThrow(/policy.*mismatch/);
      expect(store.read()).toEqual(before);
    }
    expect(() => new SharedHostScheduler(store, stale).submit(request('stale'))).toThrow(/policy.*mismatch/);
    expect(() => bindManagedAdmissionPolicy(store, loose)).toThrow(/conflicts/);
    expect(() => new SharedHostScheduler(new InMemoryAdmissionStore(), value).submit(request('unbound'))).toThrow(/binding mismatch/);
  });

  it('keeps exact replay idempotent and rejects changed payloads without partial writes', () => {
    const { scheduler, store } = setup();
    const first = scheduler.submit(request('same'));
    expect(scheduler.submit(request('same'))).toEqual(first);
    const before = store.read();
    for (const changed of [request('same', { priority: 100 }), request('same', { queueTimeoutMs: 1 }),
      request('same', { managed: { ...request('same').managed!, model: 'openai/other' } })]) {
      expect(() => scheduler.submit(changed)).toThrow(/conflicts/);
    }
    expect(store.read()).toEqual(before);
  });
});
