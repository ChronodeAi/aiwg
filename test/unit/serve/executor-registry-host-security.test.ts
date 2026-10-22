import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstatSync } from 'fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutorRegistry, type ExecutorRegisterRequest } from '../../../src/serve/executor-registry.js';
import { bindTrustedHostAdmissionPolicy, FileAdmissionStore, InMemoryAdmissionStore } from '../../../src/serve/shared-host-scheduler.js';

const filesystem = vi.hoisted(() => ({ lstatSync: undefined as undefined | typeof import('fs')['lstatSync'] }));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  filesystem.lstatSync = actual.lstatSync;
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const executor: ExecutorRegisterRequest = {
  executor_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'synthetic', version: '1', spec_version: '1.0.0',
  transport_endpoints: { rest: 'http://127.0.0.1:8122', ws: 'ws://127.0.0.1:8121' },
  capabilities: ['x-admission-policy-revision:1'],
};
let root: string, hostPath: string, overridePath: string, token: string;
let registry: ExecutorRegistry, store: FileAdmissionStore;
const registries: ExecutorRegistry[] = [];
function fresh() {
  const instance = new ExecutorRegistry(hostPath);
  registries.push(instance);
  return instance;
}
function bind(store: FileAdmissionStore | InMemoryAdmissionStore) {
  bindTrustedHostAdmissionPolicy(store, { authorityRef: 'host:synthetic', hostId: hostname(), revision: 1,
    policy: { maxConcurrent: 1, defaultHostQuota: 1, leaseTtlMs: 60000, agingIntervalMs: 30000, allowPreemption: false },
    maxQueued: 16, dimensionCaps: {}, projects: {} });
}

beforeEach(() => {
  vi.mocked(lstatSync).mockImplementation(filesystem.lstatSync!);
  root = mkdtempSync(join(tmpdir(), 'executor-host-security-'));
  hostPath = join(root, 'trusted', 'executor-identities.json');
  overridePath = join(root, 'identities.json');
  vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', overridePath);
  registry = fresh();
  const registration = registry.register(executor);
  if ('status' in registration) throw new Error(registration.error);
  token = registration.token;
  store = new FileAdmissionStore(join(root, 'host.json'));
  bind(store);
  registry.installHostAdmissionAuthority(executor.executor_id, executor.version, store, []);
});
afterEach(() => {
  registries.splice(0).forEach(instance => instance.shutdown());
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const changes = [
  { label: 'version', payload: { ...executor, version: '2' } },
  { label: 'capability', payload: { ...executor, capabilities: [] } },
];

describe('host executor registration security', () => {
  for (const restored of [false, true]) {
    for (const bearer of ['', 'synthetic-wrong-token']) {
      it.each(changes)(`rejects $label changes with ${bearer ? 'wrong' : 'missing'} authentication on ${restored ? 'stored' : 'installed'} authority without mutation`, ({ payload }) => {
        const service = restored ? fresh() : registry;
        const before = store.read();
        const hostBefore = readFileSync(hostPath, 'utf8');
        const overrideBefore = readFileSync(overridePath, 'utf8');
        const registered = vi.fn(); service.on('executor:registered', registered);
        expect(service.register(payload, bearer)).toEqual({ error: 'Unauthorized', status: 401 });
        expect(store.read()).toEqual(before);
        expect(store.read().hostRegistrationRevoked).not.toBe(true);
        expect(readFileSync(hostPath, 'utf8')).toBe(hostBefore);
        expect(readFileSync(overridePath, 'utf8')).toBe(overrideBefore);
        expect(service.get(executor.executor_id)?.version).toBe(restored ? undefined : '1');
        expect(registered).not.toHaveBeenCalled();
      });
    }
    it.each(changes)(`revokes ${restored ? 'stored' : 'installed'} authority on authenticated $label changes`, ({ payload }) => {
      const service = restored ? fresh() : registry;
      const revision = store.read().hostBinding!.revision;
      expect(service.register(payload, token)).not.toHaveProperty('status');
      expect(store.read().hostRegistrationRevoked).toBe(true);
      expect(store.read().hostBinding!.revision).toBe(revision + 1);
      expect(JSON.parse(readFileSync(hostPath, 'utf8'))[0]).not.toHaveProperty('hostAdmission');
    });
  }

  it('requires authentication for compatible host registration and preserves metadata only in the host store', () => {
    const before = readFileSync(hostPath, 'utf8');
    expect(registry.register(executor)).toEqual({ error: 'Unauthorized', status: 401 });
    expect(registry.register(executor, token)).not.toHaveProperty('status');
    expect(readFileSync(hostPath, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(overridePath, 'utf8'))[0]).not.toHaveProperty('hostAdmission');
    vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', hostPath);
    const service = fresh();
    const admission = JSON.parse(before)[0].hostAdmission;
    expect(service.register(executor, token)).not.toHaveProperty('status');
    expect(JSON.parse(readFileSync(hostPath, 'utf8'))[0].hostAdmission).toEqual(admission);
    expect(service.register({ ...executor, version: '2' }, token)).not.toHaveProperty('status');
    expect(JSON.parse(readFileSync(hostPath, 'utf8'))[0]).not.toHaveProperty('hostAdmission');
  });

  it('rejects a token planted in the override identity store for a host-bound id after restart', () => {
    writeFileSync(overridePath, JSON.stringify([{ executorId: executor.executor_id, token: 'synthetic-planted-token',
      lastSeenAt: '2026-10-22T12:00:00Z' }]));
    const service = fresh();
    const before = store.read();
    expect(service.register({ ...executor, version: '2' }, 'synthetic-planted-token')).toEqual({ error: 'Unauthorized', status: 401 });
    expect(store.read()).toEqual(before);
    expect(JSON.parse(readFileSync(hostPath, 'utf8'))[0]).toHaveProperty('hostAdmission');
    expect(service.register(executor, token)).not.toHaveProperty('status');
  });

  it('creates a private shared identity store while preserving ordinary re-registration', () => {
    const sharedPath = join(root, 'shared', 'executor-identities.json');
    vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', sharedPath);
    const service = new ExecutorRegistry(sharedPath); registries.push(service);
    const first = service.register(executor);
    if ('status' in first) throw new Error(first.error);
    expect(filesystem.lstatSync!(sharedPath).mode & 0o077).toBe(0);
    expect(filesystem.lstatSync!(join(root, 'shared')).mode & 0o077).toBe(0);
    const second = service.register({ ...executor, version: '2' });
    if ('status' in second) throw new Error(second.error);
    expect(second.token === first.token).toBe(true);
    service.installHostAdmissionAuthority(executor.executor_id, '2', store, []);
    expect(service.register({ ...executor, version: '2' })).toHaveProperty('status', 401);
    expect(service.register({ ...executor, version: '2' }, first.token)).not.toHaveProperty('status');
  });

  it.each(['register', 'deregister'] as const)('ignores forged override metadata during %s without touching its admission file', action => {
    const victimPath = join(root, 'victim.json');
    const victim = new FileAdmissionStore(victimPath); bind(victim);
    const before = readFileSync(victimPath, 'utf8');
    const forged = { executorId: executor.executor_id, token, lastSeenAt: '2026-10-22T12:00:00Z', hostAdmission: {
      authorityRef: 'host:synthetic', path: victimPath, version: '1', workerWritableRoots: [], revisionSupport: 1,
    } };
    writeFileSync(overridePath, JSON.stringify([forged]));
    // No host binding for this registry: the override must not create one.
    const unbound = new ExecutorRegistry(join(root, 'absent', 'executor-identities.json'));
    registries.push(unbound);
    expect(unbound.register({ ...executor, version: '2' })).not.toHaveProperty('status');
    expect(unbound.deregister(executor.executor_id)).toBe(true);
    expect(readFileSync(victimPath, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(overridePath, 'utf8'))[0]).not.toHaveProperty('hostAdmission');
    // A fresh registry must revoke the fixed host store rather than the forgery.
    writeFileSync(overridePath, JSON.stringify([forged]));
    const service = fresh();
    expect(service.register(executor, token)).not.toHaveProperty('status');
    if (action === 'register') expect(service.register({ ...executor, version: '2' }, token)).not.toHaveProperty('status');
    else expect(service.deregister(executor.executor_id)).toBe(true);
    expect(store.read().hostRegistrationRevoked).toBe(true);
    expect(readFileSync(victimPath, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(hostPath, 'utf8'))[0]).not.toHaveProperty('hostAdmission');
    expect(JSON.parse(readFileSync(overridePath, 'utf8'))[0]).not.toHaveProperty('hostAdmission');
  });

  it('protects installed in-memory authority from unauthenticated re-registration', () => {
    const service = new ExecutorRegistry(join(root, 'memory', 'executor-identities.json')); registries.push(service);
    const result = service.register(executor);
    if ('status' in result) throw new Error(result.error);
    const memory = new InMemoryAdmissionStore(); bind(memory);
    service.installHostAdmissionAuthority(executor.executor_id, executor.version, memory, []);
    expect(service.register({ ...executor, version: '2' })).toHaveProperty('status', 401);
    expect(memory.read().hostRegistrationRevoked).not.toBe(true);
    expect(service.register({ ...executor, version: '2' }, result.token)).not.toHaveProperty('status');
    expect(memory.read().hostRegistrationRevoked).toBe(true);
  });

  it('rejects a symlinked host registration file', () => {
    const target = join(root, 'registration-target.json');
    renameSync(hostPath, target); symlinkSync(target, hostPath);
    expect(() => registry.register(executor, token)).toThrow(/private bounded regular file/);
  });

  it('rejects a symlink swapped in after the registration lstat check', () => {
    const target = join(root, 'registration-target.json');
    vi.mocked(lstatSync).mockImplementation(path => {
      const stat = filesystem.lstatSync!(path);
      if (path === hostPath) { renameSync(hostPath, target); symlinkSync(target, hostPath); }
      return stat;
    });
    expect(() => registry.register(executor, token)).toThrow(/ELOOP|symbolic link/);
    expect(store.read().hostRegistrationRevoked).not.toBe(true);
  });

  it('checks the opened registration inode permissions after lstat', () => {
    vi.mocked(lstatSync).mockImplementation(path => {
      const stat = filesystem.lstatSync!(path);
      if (path === hostPath) chmodSync(hostPath, 0o644);
      return stat;
    });
    expect(() => registry.register(executor, token)).toThrow(/private bounded regular file/);
    expect(store.read().hostRegistrationRevoked).not.toBe(true);
  });
});
