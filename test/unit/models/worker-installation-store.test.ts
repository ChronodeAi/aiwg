import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRecordedWorkerInstallations, prepareWorkerInstallationStore } from '../../../src/models/worker-installation.mjs';
import { loadProviderModelCapabilities, WorkerRoleEffortError } from '../../../src/models/provider-policy.js';

vi.mock('node:fs/promises', { spy: true });
// Node's native homedir ignores thread-local env changes in Vitest's pool.
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.HOME || os.homedir() };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('qualification store permission repair', () => {
  it('requires recorded approvals before policy prechecks, then checks policy before record validation', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-policy-order-')); roots.push(root);
    const cwd = path.join(root, 'project'); const store = path.join(root, 'store');
    await Promise.all([fs.mkdir(cwd), fs.mkdir(store, { mode: 0o700 })]);
    vi.stubEnv('AIWG_CONFIG', store);
    const policyError = new WorkerRoleEffortError('coding');
    const precheckPolicy = vi.fn(() => { throw policyError; });
    const input = { registry: loadProviderModelCapabilities(), cwd, precheckPolicy };
    await expect(loadRecordedWorkerInstallations(input)).rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED',
      details: { rejections: [{ registration: null, reason: 'no-records' }] } });
    expect(precheckPolicy).not.toHaveBeenCalled();
    // Invalid record content must not mask the actionable policy error.
    await fs.writeFile(path.join(store, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [{}] }), { mode: 0o600 });
    await expect(loadRecordedWorkerInstallations(input)).rejects.toBe(policyError);
    expect(precheckPolicy).toHaveBeenCalledOnce();
  });

  it('selects the exact canonical workspace before validating its approval, without falling back to a peer', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-workspace-approvals-')); roots.push(root);
    const first = path.join(root, 'first'); const second = path.join(root, 'second');
    const alias = path.join(root, 'alias'); const store = path.join(root, 'store');
    await Promise.all([fs.mkdir(first), fs.mkdir(second), fs.mkdir(store, { mode: 0o700 })]);
    await fs.symlink(first, alias);
    vi.stubEnv('AIWG_CONFIG', store);
    vi.stubEnv('AIWG_3475_ABSENT', undefined);
    // Deliberately invalid proofs distinguish which workspace's record the
    // owner checked, without importing a driver or running a version probe.
    const registrations = [
      { cli: 'codex', binding: {}, adapter: {}, installation: { cwd: first, environmentNames: ['AIWG_3475_ABSENT'] } },
      { cli: 'codex', binding: { profile: 'changed' }, adapter: {}, installation: { cwd: second, profile: 'original' } },
    ];
    const filename = path.join(store, 'worker-installations.json');
    await fs.writeFile(filename, JSON.stringify({ version: 1, registrations }), { mode: 0o600 });
    for (const cwd of [first, alias]) {
      await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd }))
        .rejects.toMatchObject({ details: { rejections: [{ registration: 0, reason: 'environment-name' }] } });
    }
    await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd: second }))
      .rejects.toMatchObject({ details: { rejections: [{ registration: 1, reason: 'binding-mismatch' }] } });
    registrations.push({ ...registrations[0], installation: { ...registrations[0].installation, cwd: alias } });
    await fs.writeFile(filename, JSON.stringify({ version: 1, registrations }));
    await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd: first }))
      .rejects.toMatchObject({ details: { rejections: [
        { registration: 0, reason: 'record-identity' }, { registration: 2, reason: 'record-identity' },
      ] } });
  });

  it.each([128, 129])('bounds secret-free registration diagnostics for %s records', async count => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-diagnostics-'));
    roots.push(root);
    const cwd = path.join(root, 'project');
    const store = path.join(root, 'store');
    await fs.mkdir(cwd); await fs.mkdir(store, { mode: 0o700 });
    vi.stubEnv('AIWG_CONFIG', store);
    const privateText = 'synthetic-private-content!';
    await fs.writeFile(path.join(store, 'worker-installations.json'), JSON.stringify({ version: 1,
      registrations: Array.from({ length: count }, () => ({ cli: privateText })) }), { mode: 0o600 });
    const error = await loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd }).catch(error => error);
    const rejections = count === 128
      ? Array.from({ length: count }, (_, registration) => ({ registration, reason: 'record-identity' }))
      : [{ registration: null, reason: 'store-record' }];
    expect(error).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections } });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(privateText);
  });

  it.each([0o775, 0o777])('refuses repair beneath a writable ancestor (%s)', async mode => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-ancestor-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    const ancestor = path.join(home, 'config');
    const store = path.join(ancestor, 'aiwg');
    await fs.mkdir(store, { recursive: true });
    await fs.chmod(ancestor, mode);
    await fs.chmod(store, 0o775);
    vi.stubEnv('AIWG_CONFIG', store);
    const open = vi.spyOn(fs, 'open');
    for (const apply of [false, true]) {
      await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply }))
        .rejects.toThrow(`Untrusted installation store ancestor: ${ancestor}`);
    }
    expect(open).not.toHaveBeenCalled();
    expect((await fs.stat(store)).mode & 0o777).toBe(0o775);
  });

  it.each([0o755, 0o700])('repairs beneath trusted ancestors (%s)', async mode => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-trusted-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    const ancestor = path.join(home, 'config');
    const store = path.join(ancestor, 'aiwg');
    await fs.mkdir(store, { recursive: true });
    await fs.chmod(ancestor, mode);
    await fs.chmod(store, 0o775);
    vi.stubEnv('AIWG_CONFIG', store);
    const options = { workerWritableRoots: [] };
    await expect(prepareWorkerInstallationStore(options)).resolves.toEqual([{ path: store, action: 'chmod go-w' }]);
    expect((await fs.stat(store)).mode & 0o777).toBe(0o775);
    await prepareWorkerInstallationStore({ ...options, apply: true });
    expect((await fs.stat(store)).mode & 0o777).toBe(0o755);
  });

  it('refuses another owner with the path and never chmods it', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-owner-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const { lstat: original } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      return args[0] === root ? Object.assign(Object.create(stat), { uid: process.getuid!() + 1 }) : stat;
    });
    const open = vi.spyOn(fs, 'open');
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Installation store path is owned by another user: ${root}`);
    expect(open).not.toHaveBeenCalled();
  });

  it('never repairs a writable store file or a symlinked directory', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-path-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const filename = path.join(root, 'worker-installations.json');
    await fs.writeFile(filename, '{}');
    await fs.chmod(filename, 0o666);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Untrusted installation store permissions: ${filename}`);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o666);
    const link = `${root}-link`;
    roots.push(link);
    await fs.symlink(root, link);
    vi.stubEnv('AIWG_CONFIG', link);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow('Symlinked installation store');
  });
});
