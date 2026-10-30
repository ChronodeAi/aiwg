import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { refreshIndexes, planIndexRefresh, runIndexRefresh } from '../../../src/artifacts/index-refresh.js';
import { collectIndexStatus, probeIndexStatus, showIndexStatus } from '../../../src/artifacts/index-status.js';
import { indexAdapterRegistry, selectIndexAdapters } from '../../../src/artifacts/index-adapters.js';
import { GRAPH_CONFIGS, BUILTIN_GRAPH_CONFIGS, loadUserGraphConfigs } from '../../../src/artifacts/types.js';
import * as backends from '../../../src/artifacts/graph-backend.js';
import { syncFortemiCoreIndex, getFortemiCoreIndexDir } from '../../../src/artifacts/fortemi-core-sync.js';
import { validateIndexConfig } from '../../../src/config/aiwg-config.js';

let root: string;
const admitted = { gate: async () => ({ ok: true }) };
function put(file: string, text: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}
function config(value: object = {}) { put('.aiwg/aiwg.config', JSON.stringify({ index: value })); }
function snapshot() {
  return Object.fromEntries(['metadata.json', 'tags.json', 'dependencies.json', 'stats.json', 'checksum-manifest.json']
    .map(file => [file, fs.readFileSync(path.join(root, '.aiwg/.index/project', file), 'utf8')]));
}
async function project(nowMs?: number) {
  return (await probeIndexStatus(root, 'project', nowMs)).indices[0];
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-b4-adapters-'));
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) vi.stubEnv(key, path.join(root, key));
  fs.mkdirSync(process.env.HOME!, { recursive: true });
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  for (const key of Object.keys(GRAPH_CONFIGS)) delete GRAPH_CONFIGS[key];
  Object.assign(GRAPH_CONFIGS, structuredClone(BUILTIN_GRAPH_CONFIGS));
  config();
  put('.aiwg/requirements/one.md', '# Original\n');
});
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of Object.keys(GRAPH_CONFIGS)) delete GRAPH_CONFIGS[key];
  Object.assign(GRAPH_CONFIGS, structuredClone(BUILTIN_GRAPH_CONFIGS));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('per-index adapters and freshness', () => {
  it('declares bounded owner identities and lists unsupported remote owners', () => {
    put('unregistered/secret.md', 'outside registered roots');
    const adapters = indexAdapterRegistry(root);
    expect(selectIndexAdapters(adapters, 'all')).toEqual(adapters);
    expect(selectIndexAdapters(adapters, 'project')).toHaveLength(1);
    expect(adapters.find(adapter => adapter.name === 'project')).toMatchObject({
      identity: path.join(root, '.aiwg/.index/project'), backend: 'json', operation: 'buildIndex',
      outputPaths: expect.arrayContaining([path.join(root, '.aiwg/.index/project/metadata.json')]),
    });
    const indices = collectIndexStatus(root).indices;
    expect(indices.find(index => index.name === 'datasets')?.status).toBe('unsupported');
    expect(indices.find(index => index.name === 'models')?.status).toBe('unsupported');
    expect(indices.some(index => index.roots.includes(path.join(root, 'unregistered')))).toBe(false);
    expect(() => planIndexRefresh({ cwd: root, only: 'unregistered' })).toThrow('Unknown index');
  });

  it('picks up a graph registered between all runs without scanning other workspaces', async () => {
    const before = planIndexRefresh({ cwd: root, only: 'all' });
    config({ graphs: { custom: { scanDirs: ['refs'], defaultBuild: false } } });
    put('refs/new.md', '# Newly registered');
    put('other/.aiwg/aiwg.config', '{}');
    const after = planIndexRefresh({ cwd: root, only: 'all' });
    expect(before.some(job => job.graph === 'custom')).toBe(false);
    expect(after.filter(job => job.graph === 'custom')).toHaveLength(1);
    expect(after.every(job => job.workspace === undefined || job.workspace === root)).toBe(true);
    const report = await refreshIndexes({ cwd: root, only: 'custom' }, admitted);
    expect(report.indices).toEqual([expect.objectContaining({ name: 'custom', status: 'fresh' })]);
  });

  it('drops removed registrations between status runs in a long-lived process', () => {
    config({ graphs: { retired: { scanDirs: ['retired'] } } });
    expect(collectIndexStatus(root).indices.some(index => index.name === 'retired')).toBe(true);
    config();
    expect(collectIndexStatus(root).indices.some(index => index.name === 'retired')).toBe(false);
  });

  it.each(['add', 'edit', 'remove', 'rename', 'atomic-save'])('converges after one reconcile following %s', async operation => {
    await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect((await project()).status).toBe('fresh');
    const file = path.join(root, '.aiwg/requirements/one.md');
    if (operation === 'add') put('.aiwg/requirements/two.md', '# Added');
    if (operation === 'edit') fs.writeFileSync(file, '# Edited content');
    if (operation === 'remove') fs.rmSync(file);
    if (operation === 'rename') fs.renameSync(file, path.join(path.dirname(file), 'renamed.md'));
    if (operation === 'atomic-save') fs.renameSync(put('.aiwg/requirements/save.tmp', '# Saved content'), file);
    const dirty = await project();
    expect(dirty.status).toBe('stale');
    expect(dirty.pendingWork).toBeGreaterThan(0);
    const report = await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect(report.status).toBe('ok');
    const fresh = await project();
    expect(fresh).toMatchObject({ status: 'fresh', dirtySince: null, dirtyAgeMs: null, pendingWork: 0,
      lastError: null, convergence: { converged: true, residualJobs: 0 } });
    expect(fresh.lastVerifiedDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves every published file and last valid verification after backend failure', async () => {
    await buildIndex(root, { graph: 'project', quiet: true });
    const before = snapshot();
    const verified = await project();
    put('.aiwg/requirements/one.md', '# Edited before failed update');
    vi.spyOn(backends, 'createGraphBackend').mockRejectedValueOnce(new Error('synthetic backend failure'));
    const failed = await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect(failed.totals.errors).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(await project()).toMatchObject({ status: 'degraded', lastVerifiedDigest: verified.lastVerifiedDigest,
      lastVerifiedAt: verified.lastVerifiedAt, lastError: 'synthetic backend failure', pendingWork: 1 });
    await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect((await project()).status).toBe('fresh');
  });

  it('serializes manual and background graph writers through the same owner lock', async () => {
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { resume = resolve; });
    const real = backends.createGraphBackend;
    vi.spyOn(backends, 'createGraphBackend').mockImplementationOnce(async (...args) => {
      entered();
      await proceed;
      return real(...args);
    });
    const manual = buildIndex(root, { graph: 'project', quiet: true });
    await started;
    try {
      const background = await refreshIndexes({ cwd: root, only: 'project' }, admitted);
      expect(background.status).toBe('deferred');
      expect(background.jobs[0].reason).toBe('lock-held');
    } finally { resume(); await manual; }
    const report = await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect(report.jobs[0].freshness?.status).toBe('fresh');
    expect((await project()).pendingWork).toBe(0);
  });

  it('rolls back a failed staged publication without advancing verification', async () => {
    await buildIndex(root, { graph: 'project', quiet: true });
    const before = snapshot();
    const verified = await project();
    put('.aiwg/requirements/one.md', '# Edited before publication failure');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(source).includes('/.build-') && String(source).endsWith('/metadata.json')
        && !String(source).includes('/.previous/')) throw new Error('synthetic publication failure');
      return rename(source, target);
    });
    await expect(buildIndex(root, { graph: 'project', quiet: true })).rejects.toThrow('synthetic publication failure');
    expect(snapshot()).toEqual(before);
    expect(await project()).toMatchObject({ status: 'degraded', lastVerifiedDigest: verified.lastVerifiedDigest,
      lastVerifiedAt: verified.lastVerifiedAt, pendingWork: 1 });
  });

  it('renews no-op freshness from the receipt scan and detects subsequent changes', async () => {
    await buildIndex(root, { graph: 'project', quiet: true });
    const before = snapshot();
    const verified = await project();
    const now = Date.parse(verified.lastVerifiedAt!) + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const copies = vi.spyOn(fs, 'copyFileSync');
    await buildIndex(root, { graph: 'project', quiet: true });
    expect(copies).not.toHaveBeenCalled();
    expect(snapshot()['metadata.json']).toBe(before['metadata.json']);
    expect(await project()).toMatchObject({ status: 'fresh', lastVerifiedDigest: verified.lastVerifiedDigest,
      lastVerifiedAt: new Date(now).toISOString(), pendingWork: 0 });
    put('.aiwg/requirements/one.md', '# Changed after the no-op verification');
    expect(await project()).toMatchObject({ status: 'stale', pendingWork: 1 });
  });

  it('leaves changes during a build pending and reconciles them on the next run', async () => {
    const real = backends.createGraphBackend;
    vi.spyOn(backends, 'createGraphBackend').mockImplementationOnce(async (...args) => {
      put('.aiwg/requirements/late.md', '# Changed while preparing');
      return real(...args);
    });
    const report = await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect(report.status).toBe('deferred');
    expect(report.jobs[0].freshness).toMatchObject({ status: 'stale', pendingWork: 1,
      convergence: { converged: false, residualJobs: 1 } });
    const next = await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect(next.jobs[0].freshness?.status).toBe('fresh');
    expect(JSON.parse(snapshot()['metadata.json']).entries['.aiwg/requirements/late.md']).toBeDefined();
  });

  it('applies independent age targets and renews an unchanged verification', async () => {
    config({ freshness: { graphs: { targetStaleAfterMs: 100000 }, project: { targetStaleAfterMs: 10000 } } });
    put('src/one.ts', 'export const one = 1;');
    await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    await refreshIndexes({ cwd: root, only: 'codebase' }, admitted);
    const report = { indices: [await project(), (await probeIndexStatus(root, 'codebase')).indices[0]] };
    const latest = Math.max(...report.indices.map(index => Date.parse(index.lastVerifiedAt ?? ''))
      .filter(Number.isFinite));
    const aged = { indices: [await project(latest + 20000), (await probeIndexStatus(root, 'codebase', latest + 20000)).indices[0]] };
    expect(aged.indices.find(index => index.name === 'project')?.status).toBe('stale');
    expect(aged.indices.find(index => index.name === 'codebase')?.status).toBe('fresh');
    const before = snapshot()['metadata.json'];
    await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect(snapshot()['metadata.json']).toBe(before);
    expect((await project()).status).toBe('fresh');
  });

  it('preserves the first measured dirty time across repeated probes', async () => {
    await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    const verifiedAt = Date.parse((await project()).lastVerifiedAt!);
    put('.aiwg/requirements/one.md', '# Dirty');
    const first = await project(verifiedAt + 100);
    const second = await project(verifiedAt + 600);
    expect(second.dirtySince).toBe(first.dirtySince);
    expect(second.dirtyAgeMs).toBe(500);
  });

  it('retains the cache snapshot if preparing its new manifest fails', async () => {
    await buildIndex(root, { graph: 'project', quiet: true });
    syncFortemiCoreIndex(root);
    const directory = getFortemiCoreIndexDir(root, 'project');
    const before = ['manifest.json', 'aiwg-fortemi-index-v2.json'].map(file => fs.readFileSync(path.join(directory, file), 'utf8'));
    put('.aiwg/requirements/two.md', '# Added after cache snapshot');
    await buildIndex(root, { graph: 'project', quiet: true });
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file).includes('/.sync-') && String(file).endsWith('/manifest.json')) throw new Error('synthetic manifest failure');
      return (write as Function)(file, ...args);
    }) as typeof fs.writeFileSync);
    expect(() => syncFortemiCoreIndex(root)).toThrow('synthetic manifest failure');
    expect(['manifest.json', 'aiwg-fortemi-index-v2.json'].map(file => fs.readFileSync(path.join(directory, file), 'utf8'))).toEqual(before);
  });

  it('keeps the existing JSON status fields and adds only the selected freshness entries', async () => {
    await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await showIndexStatus(root, { json: true, only: 'project' });
    const report = JSON.parse(String(output.mock.calls[0][0]));
    expect(report).toMatchObject({ graphs: expect.any(Array), summary: expect.objectContaining({ total: 5 }),
      warnings: [], orphanIndexDirs: [], indices: [expect.objectContaining({ name: 'project', status: 'fresh',
        operation: 'buildIndex', backend: 'json' })] });
  });

  it('allows convergence measurement to be disabled for one index', async () => {
    config({ freshness: { project: { measureConvergence: false } } });
    await refreshIndexes({ cwd: root, only: 'project' }, admitted);
    expect((await project()).convergence).toBeUndefined();
  });

  it('validates freshness policies through the existing index config surface', () => {
    expect(validateIndexConfig({ freshness: { project: { targetStaleAfterMs: 0, maxRetriesPerDay: -1,
      measureConvergence: 'yes' } } })).toHaveLength(3);
    expect(validateIndexConfig({ freshness: { project: { targetStaleAfterMs: 1, maxRetriesPerDay: 0,
      measureConvergence: false } } })).toEqual([]);
  });

  it('selects all and registered names through the existing refresh argument parser', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runIndexRefresh(['--only', 'project', '--dry-run', '--json'], root);
    expect(report.jobs).toEqual([expect.objectContaining({ graph: 'project', status: 'planned' })]);
    const all = await runIndexRefresh(['--only', 'all', '--dry-run', '--json'], root);
    expect(all.indices?.some(index => index.status === 'unsupported')).toBe(true);
    loadUserGraphConfigs(root);
    const adapter = indexAdapterRegistry(root).find(index => index.name === 'project')!;
    expect(adapter.convergence(report)).toMatchObject({ converged: false, residualJobs: 1 });
  });
});
