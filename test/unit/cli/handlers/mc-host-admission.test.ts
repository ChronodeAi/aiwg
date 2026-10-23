import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as ui from '../../../../src/cli/ui.js';
import { createMcAdmissionScheduler } from '../../../../src/cli/handlers/mc.js';
import { resolveParallelism, workerActivationDigests, workerConfigDigest, type AiwgConfig } from '../../../../src/config/aiwg-config.js';
import {
  bindManagedAdmissionPolicy, bindTrustedHostAdmissionPolicy, FileAdmissionStore,
  hostProjectAdmissionPolicy, managedProjectAdmissionPolicy, migrateProjectAdmissionToHost, projectAdmissionAuthority,
  SharedHostScheduler, type AdmissionRequest, type SharedHostPolicy, type TrustedHostAdmissionBinding,
} from '../../../../src/serve/shared-host-scheduler.js';

let root: string;
let registry: typeof import('../../../../src/serve/executor-registry.js')['ExecutorRegistry']['prototype'];
let configs: AiwgConfig[], policies: SharedHostPolicy[], roots: string[];
let store: FileAdmissionStore;
const executor = { executor_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'synthetic', version: '1', spec_version: '1.0.0',
  transport_endpoints: { rest: 'http://127.0.0.1:8122', ws: 'ws://127.0.0.1:8121' },
  capabilities: ['x-admission-policy-revision:1', 'isolation:container'] };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mc-host-'));
  vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', join(root, 'identities.json'));
  registry = new (await import('../../../../src/serve/executor-registry.js')).ExecutorRegistry(join(root, 'trusted', 'executor-identities.json'));
  registry.shutdown();
  roots = [join(root, 'a'), join(root, 'b')];
  const { mkdirSync } = await import('node:fs'); roots.forEach(path => mkdirSync(path));
  configs = roots.map(() => {
    const cfg: AiwgConfig = { version: '1', providers: ['codex'], installed: {}, scripts: {},
      parallelism: { worker_dispatch: true, worker_mode: 'managed', max_parallel_subagents: 1,
        admission: { authorityRef: 'host:synthetic' }, clis: { first: { adapter: 'providers:codex', accountScope: 'local', quotaScope: 'local' } },
        groups: { coding: { members: [{ id: 'spark', cli: 'first', model: 'model', roles: ['coding'] }] } } } } as AiwgConfig;
    cfg.parallelism!.activation = { revision: 1, ...workerActivationDigests(cfg), snapshotRef: 'synthetic:activation' };
    return cfg;
  });
  policies = configs.map((cfg, index) => {
    const parallelism = resolveParallelism(cfg.parallelism, 'codex');
    return managedProjectAdmissionPolicy(roots[index]!, { ...parallelism, admission: { ...parallelism.admission, authorityRef: 'project' } },
      workerConfigDigest(parallelism.activation), parallelism.max_parallel_subagents);
  });
  const localPolicies = configs.map((hostConfig, index) => {
    const localConfig = structuredClone(hostConfig);
    localConfig.parallelism!.admission!.authorityRef = 'project';
    localConfig.parallelism!.activation = { revision: 1, ...workerActivationDigests(localConfig), snapshotRef: 'synthetic:prior-activation' };
    const local = resolveParallelism(localConfig.parallelism, 'codex');
    return managedProjectAdmissionPolicy(roots[index]!, local, workerConfigDigest(local.activation), local.max_parallel_subagents);
  });
  store = new FileAdmissionStore(join(root, 'host.json'));
  const binding: TrustedHostAdmissionBinding = { authorityRef: 'host:synthetic', hostId: hostname(), revision: 1,
    policy: { maxConcurrent: 1, defaultHostQuota: 1, leaseTtlMs: 60000, agingIntervalMs: 30000, allowPreemption: false },
    maxQueued: 16, dimensionCaps: {}, projects: Object.fromEntries(policies.map((policy, index) => [policy.managed!.projectId, { policy, migrationFrom: localPolicies[index],
      installations: { first: { accountScope: 'upstream', quotaScope: 'upstream', models: ['synthetic/model'] } } }])) };
  bindTrustedHostAdmissionPolicy(store, binding);
  policies.forEach((policy, index) => {
    const local = new FileAdmissionStore(projectAdmissionAuthority(roots[index]!).path); bindManagedAdmissionPolicy(local, localPolicies[index]!);
    migrateProjectAdmissionToHost(local, store, policy.managed!.projectId, { id: `synthetic-${index}`,
      expectedSourceRevision: local.read().revision, expectedTargetRevision: store.read().revision });
  });
});
afterEach(() => { registry?.shutdown(); vi.unstubAllEnvs(); rmSync(root, { force: true, recursive: true }); });
function request(id: string): AdmissionRequest {
  return { requestId: id, orchestratorId: 'synthetic', provider: 'synthetic', environment: 'synthetic', runtimeKind: 'host',
    priority: 1, submittedAt: new Date().toISOString(), queueTimeoutMs: 60000, managed: { kind: 'native' } };
}
function install() {
  const result = registry.register(executor);
  if ('status' in result) throw new Error(result.error);
  registry.installHostAdmissionAuthority(executor.executor_id, executor.version, store, roots);
  return result.token;
}

describe('T-OG-05/08/10 MC trusted host executor binding', () => {
  it('routes two projects through the existing shared store and protects local member/run IDs', async () => {
    install();
    const a = await createMcAdmissionScheduler(roots[0]!, configs[0]!, registry);
    const b = await createMcAdmissionScheduler(roots[1]!, configs[1]!, registry);
    expect(a.submit(request('same')).state).toBe('admitted');
    expect(b.submit(request('same')).state).toBe('queued');
    expect(a.snapshot().records.same!.projectId).not.toBe(b.snapshot().records.same!.projectId);
    expect(Object.values(store.read().records)).toHaveLength(2);
  });

  it('shares one trusted authority between two actual project processes with colliding local IDs', async () => {
    install();
    const script = join(root, 'caller.mts');
    writeFileSync(script, `import { createMcAdmissionScheduler } from ${JSON.stringify(resolve('src/cli/handlers/mc.ts'))};
import { ExecutorRegistry } from ${JSON.stringify(resolve('src/serve/executor-registry.ts'))};
const [trustedPath, config, project, request] = process.argv.slice(2);
const registry = new ExecutorRegistry(trustedPath);
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const scheduler = await createMcAdmissionScheduler(project, JSON.parse(config), registry);
    process.stdout.write(scheduler.submit(JSON.parse(request)).state);
    break;
  } catch (error) {
    if (!error.message.includes('store is busy') || attempt === 19) throw error;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
`);
    const child = (index: number) => promisify(execFile)(process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), script, join(root, 'trusted', 'executor-identities.json'),
        JSON.stringify(configs[index]), roots[index]!, JSON.stringify(request('same'))],
      { cwd: roots[index], timeout: 15000, maxBuffer: 32000 });
    const results = await Promise.all([child(0), child(1)]);
    expect(results.map(result => result.stdout.trim().split('\n').at(-1)).sort()).toEqual(['admitted', 'queued']);
    expect(Object.values(store.read().records)).toHaveLength(2);
  }, 40000);

  it('restores the trusted binding in a fresh caller registry without using project storage redirects', async () => {
    install();
    const { ExecutorRegistry } = await import('../../../../src/serve/executor-registry.js');
    const fresh = new ExecutorRegistry(join(root, 'trusted', 'executor-identities.json'));
    vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', join(root, 'untrusted-identities.json'));
    const scheduler = await createMcAdmissionScheduler(roots[0]!, configs[0]!, fresh);
    expect(scheduler.submit(request('restored')).state).toBe('admitted');
    registry.deregister(executor.executor_id);
    await expect(createMcAdmissionScheduler(roots[0]!, configs[0]!, fresh)).rejects.toThrow(/revoked/);
    expect(() => scheduler.renew('restored', 1)).toThrow(/revoked|revision/);
    fresh.shutdown();
  });

  it('warns that the identity-store override is ignored for host admission lookup', async () => {
    install();
    const warn = vi.spyOn(ui, 'warn').mockImplementation(() => {});
    const scheduler = await createMcAdmissionScheduler(roots[0]!, configs[0]!, registry);
    expect(scheduler.submit(request('diagnostic')).state).toBe('admitted');
    expect(warn).toHaveBeenCalledExactlyOnceWith('AIWG_EXECUTOR_IDENTITY_STORE is ignored for host admission authority lookup.');
    vi.unstubAllEnvs();
    await createMcAdmissionScheduler(roots[0]!, configs[0]!, registry);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fails without a trusted binding rather than reopening a migrated project file', async () => {
    await expect(createMcAdmissionScheduler(roots[0]!, configs[0]!, registry)).rejects.toThrow(/trusted host executor binding/);
  });

  it.each(['version', 'capability', 'deregister'] as const)('rejects a changed executor %s before dispatch', async vector => {
    const token = install();
    if (vector === 'deregister') registry.deregister(executor.executor_id);
    else registry.register({ ...executor, ...(vector === 'version' ? { version: '2' } : { capabilities: ['isolation:container'] }) }, token);
    await expect(createMcAdmissionScheduler(roots[0]!, configs[0]!, registry)).rejects.toThrow(/revision-aware|revoked|trusted host executor/);
  });

  it('keeps the host binding live after unauthenticated version changes', async () => {
    install();
    const scheduler = await createMcAdmissionScheduler(roots[0]!, configs[0]!, registry);
    const before = store.read();
    expect(registry.register({ ...executor, version: '2' })).toEqual({ error: 'Unauthorized', status: 401 });
    expect(store.read()).toEqual(before);
    expect(store.read().hostRegistrationRevoked).not.toBe(true);
    expect(scheduler.submit(request('still-live')).state).toBe('admitted');
    await expect(createMcAdmissionScheduler(roots[0]!, configs[0]!, registry)).resolves.toBeDefined();
  });

  it('does not grant host authority through public executor registration or project caps', async () => {
    registry.register(executor);
    await expect(createMcAdmissionScheduler(roots[0]!, configs[0]!, registry)).rejects.toThrow(/trusted host executor binding/);
    registry.installHostAdmissionAuthority(executor.executor_id, '1', store, roots);
    const loose = structuredClone(configs[0]!); loose.parallelism!.max_parallel_subagents = 50;
    loose.parallelism!.activation = { revision: 2, ...workerActivationDigests(loose), snapshotRef: 'synthetic:looser' };
    await expect(createMcAdmissionScheduler(roots[0]!, loose, registry)).rejects.toThrow(/not approved/);
  });

  it('fences an existing caller after an authority policy revision changes', async () => {
    install(); const scheduler = await createMcAdmissionScheduler(roots[0]!, configs[0]!, registry);
    scheduler.submit(request('a'));
    store.transact(snapshot => { snapshot.hostBinding!.revision++; snapshot.hostBinding!.policy.maxConcurrent = 2; });
    expect(() => scheduler.renew('a', 1)).toThrow(/revision/);
    const current = new SharedHostScheduler(store, hostProjectAdmissionPolicy(store.read(), policies[0]!.managed!.projectId));
    expect(current.renew('a', 1).state).toBe('admitted');
  });

  it('preserves private host metadata across compatible service registration and revokes changed versions', async () => {
    const token = install();
    const trustedPath = join(root, 'trusted', 'executor-identities.json');
    vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', trustedPath);
    const { ExecutorRegistry } = await import('../../../../src/serve/executor-registry.js');
    const service = new ExecutorRegistry(trustedPath);
    expect(service.register(executor, token)).not.toHaveProperty('status');
    const scheduler = await createMcAdmissionScheduler(roots[0]!, configs[0]!, service);
    expect(scheduler.submit(request('service')).state).toBe('admitted');
    expect(service.register({ ...executor, version: '2' }, token)).not.toHaveProperty('status');
    expect(() => scheduler.renew('service', 1)).toThrow(/revoked/);
    await expect(createMcAdmissionScheduler(roots[0]!, configs[0]!, service)).rejects.toThrow(/trusted host executor/);
    service.shutdown();
  });

  it('rejects nonprivate persisted host registration before resolving project authority', async () => {
    install();
    const filename = join(root, 'trusted', 'executor-identities.json');
    chmodSync(filename, 0o644);
    await expect(createMcAdmissionScheduler(roots[0]!, configs[0]!, registry)).rejects.toThrow(/private/);
    chmodSync(filename, 0o600);
  });

  it('requires a qualified registration and rejects an authority inside a worker writable mount', () => {
    expect(() => registry.installHostAdmissionAuthority(executor.executor_id, '1', store, roots)).toThrow(/qualified/);
    registry.register(executor);
    expect(() => registry.installHostAdmissionAuthority(executor.executor_id, '2', store, roots)).toThrow(/qualified/);
    expect(() => registry.installHostAdmissionAuthority(executor.executor_id, '1', store, [root])).toThrow(/writable mount/);
  });
});
