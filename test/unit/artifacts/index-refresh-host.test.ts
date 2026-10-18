import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshIndexes, runIndexRefresh } from '../../../src/artifacts/index-refresh.js';
import * as modelDiscovery from '../../../src/models/model-discovery.js';
import * as providerInventory from '../../../src/providers/provider-inventory.js';
import { RuntimeDiscovery } from '../../../src/smiths/toolsmith/runtime-discovery.mjs';
import { LocalIssueProviderCore } from '../../../src/issues/local.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, statfsSync: vi.fn(original.statfsSync) };
});

let root: string;
let workspaces: string[];
let state: string;
const admitted = { gate: async () => ({ ok: true }) };
const catalog = {
  version: '1.0', generated: '2026-10-18T00:00:00Z', inputFingerprint: 'host-tools',
  environment: { workingDir: '/host', os: 'linux' },
  resources: { diskFreeGb: 999, cpuCores: 8 },
  tools: [{ id: 'node', version: '24.0.0' }], unavailable: [],
};

function runtimePath(workspace: string, file = 'runtime.json'): string {
  return path.join(workspace, '.aiwg/smiths/toolsmith', file);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-refresh-host-'));
  state = path.join(root, 'state/aiwg');
  workspaces = ['a', 'b', 'c'].map(name => path.join(root, name));
  for (const workspace of workspaces) {
    fs.mkdirSync(path.join(workspace, '.aiwg/issues/items'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.aiwg/aiwg.config'), '{}');
  }
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_STATE_HOME', path.join(root, 'state'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  fs.mkdirSync(process.env.HOME!, { recursive: true });
  vi.spyOn(providerInventory, 'collectProviderInventory').mockImplementation(async projectDir => ({
    generatedAt: catalog.generated, projectDir, providers: [], activeProvider: null, activeSource: 'none',
  }));
  vi.spyOn(modelDiscovery, 'resolveDynamicModelCatalog').mockResolvedValue({ version: '1.0', providers: {} });
  vi.spyOn(RuntimeDiscovery.prototype, 'discover').mockImplementation(async function (this: RuntimeDiscovery) {
    fs.mkdirSync(this.basePath, { recursive: true });
    fs.writeFileSync(path.join(this.basePath, 'runtime.json'), JSON.stringify(catalog));
    fs.writeFileSync(path.join(this.basePath, 'runtime-info.md'), [
      '# Runtime Environment Summary',
      '- **Working Directory**: /host', '- **Disk Free**: 999 GB',
      `- **Catalog**: ${path.join(this.basePath, 'runtime.json')}`,
    ].join('\n'));
    return structuredClone(catalog);
  });
});

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('host discovery during index refresh', () => {
  it.each([false, true])('resolves models and probes runtime once for three workspaces (full: %s)', async full => {
    const issues = vi.spyOn(LocalIssueProviderCore.prototype, 'rebuildIssueIndex');
    const probe = vi.mocked(RuntimeDiscovery.prototype.discover);
    const resolve = vi.mocked(modelDiscovery.resolveDynamicModelCatalog);
    const gate = vi.fn(admitted.gate);
    const report = await refreshIndexes({ workspaces, full }, { gate });
    expect(probe).toHaveBeenCalledExactlyOnceWith({ force: full });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      forceRefresh: full, allowNetwork: true,
      omp: { cwd: process.env.HOME }, grokBuild: expect.objectContaining({ cwd: process.env.HOME }),
    }));
    expect(resolve.mock.calls[0][0].grokBuild?.env === process.env).toBe(true);
    expect(providerInventory.collectProviderInventory).toHaveBeenCalledExactlyOnceWith(process.env.HOME);
    expect(issues).toHaveBeenCalledTimes(3);
    expect(gate).toHaveBeenCalledTimes(report.jobs.length);
    expect(report).toMatchObject({ status: 'ok', totals: { jobs: 13, ok: 10, skipped: 3, errors: 0 } });
    const json = JSON.parse(JSON.stringify(report));
    expect(json.jobs.filter((job: { kind: string }) => job.kind === 'models')).toEqual([
      expect.objectContaining({ scope: 'host', status: 'ok' }),
    ]);
    expect(json.jobs.find((job: { kind: string }) => job.kind === 'models')).not.toHaveProperty('workspace');
    expect(json.jobs.filter((job: { kind: string }) => job.kind === 'runtime')
      .map((job: { workspace: string }) => job.workspace)).toEqual(workspaces);
  });

  it('writes shared tools with workspace-specific disk, working directory, and deltas', async () => {
    const statfs = vi.spyOn(fs, 'statfsSync').mockImplementation(directory => ({
      bavail: (workspaces.indexOf(String(directory)) + 1) * 1024, bsize: 1024 ** 2,
    } as fs.StatsFs));
    fs.mkdirSync(path.dirname(runtimePath(workspaces[1])), { recursive: true });
    fs.writeFileSync(runtimePath(workspaces[1]), JSON.stringify({ tools: [{ id: 'old-tool' }] }));
    const report = await refreshIndexes({ workspaces, only: 'runtime' }, admitted);
    expect(report.totals).toMatchObject({ jobs: 3, ok: 3, errors: 0 });
    expect(RuntimeDiscovery.prototype.discover).toHaveBeenCalledOnce();
    expect(modelDiscovery.resolveDynamicModelCatalog).not.toHaveBeenCalled();
    for (const [index, workspace] of workspaces.entries()) {
      expect(statfs).toHaveBeenCalledWith(workspace);
      const local = JSON.parse(fs.readFileSync(runtimePath(workspace), 'utf8'));
      expect(local.tools).toEqual(catalog.tools);
      expect(local.environment).toEqual({ ...catalog.environment, workingDir: workspace });
      expect(local.resources).toEqual({ ...catalog.resources, diskFreeGb: index + 1 });
      expect(local.delta).toEqual({ added: ['node'], removed: index === 1 ? ['old-tool'] : [] });
      const info = fs.readFileSync(runtimePath(workspace, 'runtime-info.md'), 'utf8');
      expect(info).toContain(`- **Working Directory**: ${workspace}`);
      expect(info).toContain(`- **Disk Free**: ${index + 1} GB`);
      expect(info).toContain(`- **Catalog**: ${runtimePath(workspace)}`);
    }
    expect(catalog.environment.workingDir).toBe('/host');
  });

  it('skips unchanged workspace outputs and forces publication on full refresh', async () => {
    const options = { workspaces, only: 'runtime' as const };
    await refreshIndexes(options, admitted);
    const before = workspaces.map(workspace => fs.statSync(runtimePath(workspace)).mtimeMs);
    const next = await refreshIndexes(options, admitted);
    expect(next.totals).toMatchObject({ jobs: 3, skipped: 3, ok: 0, errors: 0 });
    expect(next.jobs.every(job => job.reason === 'unchanged')).toBe(true);
    expect(workspaces.map(workspace => fs.statSync(runtimePath(workspace)).mtimeMs)).toEqual(before);
    const full = await refreshIndexes({ ...options, full: true }, admitted);
    expect(full.totals).toMatchObject({ jobs: 3, ok: 3, skipped: 0, errors: 0 });
    expect(RuntimeDiscovery.prototype.discover).toHaveBeenCalledTimes(3);
    expect(RuntimeDiscovery.prototype.discover).toHaveBeenLastCalledWith({ force: true });
  });

  it('republishes changed host tools and repairs a missing workspace summary', async () => {
    const options = { workspaces, only: 'runtime' as const };
    await refreshIndexes(options, admitted);
    fs.rmSync(runtimePath(workspaces[0], 'runtime-info.md'));
    const repaired = await refreshIndexes(options, admitted);
    expect(repaired.totals).toMatchObject({ ok: 1, skipped: 2, errors: 0 });
    expect(fs.existsSync(runtimePath(workspaces[0], 'runtime-info.md'))).toBe(true);
    vi.mocked(RuntimeDiscovery.prototype.discover).mockResolvedValue({
      ...catalog, generated: '2026-10-18T01:00:00Z', inputFingerprint: 'updated-host-tools', tools: [],
    });
    const changed = await refreshIndexes(options, admitted);
    expect(changed.totals).toMatchObject({ jobs: 3, ok: 3, errors: 0 });
    expect(RuntimeDiscovery.prototype.discover).toHaveBeenCalledTimes(3);
    for (const workspace of workspaces) {
      expect(JSON.parse(fs.readFileSync(runtimePath(workspace), 'utf8'))).toMatchObject({
        tools: [], delta: { added: [], removed: ['node'] }, inputFingerprint: 'updated-host-tools',
      });
    }
  });

  it('publishes runtime tools when workspace disk statistics are unavailable', async () => {
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => { throw new Error('unavailable'); });
    const report = await refreshIndexes({ workspaces, only: 'runtime' }, admitted);
    expect(report.totals).toMatchObject({ jobs: 3, ok: 3, errors: 0 });
    for (const workspace of workspaces) {
      expect(JSON.parse(fs.readFileSync(runtimePath(workspace), 'utf8')).resources.diskFreeGb).toBe(0);
    }
  });

  it('labels models as host-scoped in text output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runIndexRefresh(['--only', 'models', '--dry-run'], workspaces[0]);
    expect(log.mock.calls.map(call => call[0])).toContain('  planned: models [host]');
  });

  it.each(['models', 'runtime'] as const)('reports correct JSON totals for --only %s across workspaces', async only => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runIndexRefresh([
      '--only', only, '--dry-run', '--json', ...workspaces.flatMap(workspace => ['--workspace', workspace]),
    ]);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(report);
    expect(report.totals).toMatchObject({ jobs: only === 'models' ? 1 : 3, ok: 0, errors: 0 });
    expect(report.jobs.every(job => job.kind === only && job.status === 'planned')).toBe(true);
    expect(RuntimeDiscovery.prototype.discover).not.toHaveBeenCalled();
    expect(modelDiscovery.resolveDynamicModelCatalog).not.toHaveBeenCalled();
    expect(fs.existsSync(state)).toBe(false);
  });

  it.each(['models', 'runtime'] as const)('defers %s before discovery and resumes through the resource gate', async only => {
    const options = { workspaces, only };
    const gate = vi.fn(async () => ({ ok: false, reason: 'memory pressure' }));
    const deferred = await refreshIndexes(options, { gate });
    expect(deferred).toMatchObject({ status: 'deferred', totals: { deferred: 1, errors: 0 } });
    expect(gate).toHaveBeenCalledOnce();
    expect(RuntimeDiscovery.prototype.discover).not.toHaveBeenCalled();
    expect(modelDiscovery.resolveDynamicModelCatalog).not.toHaveBeenCalled();
    const resumed = await refreshIndexes(options, admitted);
    expect(resumed).toMatchObject({ status: 'ok', totals: { ok: only === 'models' ? 1 : 3, errors: 0 } });
    const discovery = only === 'models' ? modelDiscovery.resolveDynamicModelCatalog : RuntimeDiscovery.prototype.discover;
    expect(discovery).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
  });

  it('preserves workspace runtime checkpoint keys and probes once for remaining workspaces', async () => {
    const options = { workspaces, only: 'runtime' as const, full: true };
    await expect(refreshIndexes(options, {
      ...admitted, afterJob: () => { throw new Error('interrupted'); },
    })).rejects.toThrow('interrupted');
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(checkpoint.jobs).toEqual(workspaces.map(workspace => JSON.stringify(['runtime', workspace, null])));
    expect(checkpoint.completed).toEqual([checkpoint.jobs[0]]);
    vi.mocked(RuntimeDiscovery.prototype.discover).mockClear();
    const report = await refreshIndexes(options, admitted);
    expect(report.totals).toMatchObject({ jobs: 3, ok: 2, skipped: 1, errors: 0 });
    expect(report.jobs[0]).toMatchObject({ workspace: workspaces[0], reason: 'checkpoint' });
    expect(RuntimeDiscovery.prototype.discover).toHaveBeenCalledOnce();
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('resumes a completed host models job independently of workspace selections', async () => {
    await expect(refreshIndexes({ workspaces, only: 'models' }, {
      ...admitted, afterJob: () => { throw new Error('interrupted'); },
    })).rejects.toThrow('interrupted');
    const checkpoint = JSON.parse(fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8'));
    expect(checkpoint.jobs).toEqual([JSON.stringify(['models', 'host', null])]);
    expect(checkpoint.completed).toEqual(checkpoint.jobs);
    const report = await refreshIndexes({ workspaces: [workspaces[2]], only: 'models' }, admitted);
    expect(report.totals).toMatchObject({ jobs: 1, ok: 0, skipped: 1, errors: 0 });
    expect(report.jobs[0]).toMatchObject({ scope: 'host', reason: 'checkpoint' });
    expect(modelDiscovery.resolveDynamicModelCatalog).toHaveBeenCalledOnce();
  });

  it('shares a failed runtime probe without repeating it for each workspace', async () => {
    vi.mocked(RuntimeDiscovery.prototype.discover).mockRejectedValue(new Error('probe failed'));
    const report = await refreshIndexes({ workspaces, only: 'runtime' }, admitted);
    expect(report).toMatchObject({ status: 'error', totals: { jobs: 3, errors: 3, ok: 0 } });
    expect(report.jobs.every(job => job.error === 'probe failed')).toBe(true);
    expect(RuntimeDiscovery.prototype.discover).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
  });
});
