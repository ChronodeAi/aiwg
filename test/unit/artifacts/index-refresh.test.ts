import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planIndexRefresh, refreshIndexes, refreshResourceGate, runIndexRefresh } from '../../../src/artifacts/index-refresh.js';
import { acquireDirectoryLock } from '../../../src/artifacts/prebuilt-build-lock.js';
import { getGraphIndexDir, loadUserGraphConfigs } from '../../../src/artifacts/types.js';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import * as resourcePreflight from '../../../tools/scripts/resource-preflight.mjs';
import * as boundedProcess from '../../../src/process/bounded-child-process.mjs';
import * as providerInventory from '../../../src/providers/provider-inventory.js';
import * as modelDiscovery from '../../../src/models/model-discovery.js';
import { LocalIssueProviderCore } from '../../../src/issues/local.js';
import { RuntimeDiscovery } from '../../../src/smiths/toolsmith/runtime-discovery.mjs';
import { discoverWorkspaceHistories, readDiscoveryManifest, writeDiscoveryManifest } from '../../../src/sessions/workspace-discovery.js';
import { SessionRepository } from '../../../src/sessions/repository.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

let root: string;
let workspace: string;
let state: string;
const admitted = { gate: async () => ({ ok: true }) };

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function config(ws: string, graphs: Record<string, unknown> = {}): void {
  write(path.join(ws, '.aiwg/aiwg.config'), JSON.stringify({ index: { graphs } }));
}

function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(file));
    else files[file] = `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, 'base64')}`;
  }
  return files;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-refresh-'));
  workspace = path.join(root, 'workspace');
  state = path.join(root, 'state/aiwg');
  config(workspace);
  write(path.join(workspace, '.aiwg/requirements/UC-001.md'), '# Example\n\nAn indexed requirement.\n');
  write(path.join(workspace, 'src/example.ts'), 'export const example = 1;\n');
  for (const [key, value] of Object.entries({
    HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'),
  })) vi.stubEnv(key, value);
  fs.mkdirSync(process.env.HOME!, { recursive: true });
  vi.stubEnv('AIWG_MODEL_CATALOG_URL', '');
  vi.spyOn(boundedProcess, 'boundedExecFileSync').mockImplementation(() => { throw new Error('not installed'); });
  vi.spyOn(providerInventory, 'collectProviderInventory').mockImplementation(async projectDir => ({
    generatedAt: new Date().toISOString(), projectDir, providers: [], activeProvider: null, activeSource: 'none',
  }));
});

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('index refresh', () => {
  it('imports multiple configured manifests into the catalog and skips completed batches on the next refresh', async () => {
    const database = path.join(workspace, '.aiwg/sessions/catalog.sqlite');
    fs.mkdirSync(path.dirname(database), { recursive: true });
    new SessionRepository(database).close();
    const files = ['first.json', 'second.json'];
    for (const [index, file] of files.entries()) {
      const authorized = path.join(root, `authorized-${index}`);
      write(path.join(authorized, 'one.jsonl'), JSON.stringify({
        type: 'user', sessionId: `one-${index}`, cwd: workspace, message: { role: 'user', content: 'hello' },
      }) + '\n');
      const manifest = await discoverWorkspaceHistories({
        workspace, expectedProviders: ['claude'], authorizedRoots: { claude: [authorized] },
      });
      await writeDiscoveryManifest(path.join(workspace, file), manifest);
    }
    write(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({ sessions: { discovery_manifests: files } }));
    const first = await refreshIndexes({ cwd: workspace, only: 'sessions' }, admitted);
    expect(first).toMatchObject({ status: 'ok', totals: { ok: 1, noManifest: 0, errors: 0 } });
    expect(first.jobs[0].sessionImport).toBeUndefined();
    expect(first.jobs[0].sessionImports).toHaveLength(2);
    for (const [index, receipt] of first.jobs[0].sessionImports!.entries()) {
      const manifest = await readDiscoveryManifest(path.join(workspace, files[index]));
      expect(receipt).toMatchObject({ run: { manifestId: manifest.manifestId, status: 'complete' },
        totals: { discovered: 1, accepted: 1, rejected: 0, pending: 0, sessionsAccepted: 1 } });
    }
    const repository = new SessionRepository(database);
    try {
      expect(repository.listSessions({ workspaceId: workspace, limit: 10 }).total).toBe(2);
    } finally { repository.close(); }
    const second = await refreshIndexes({ cwd: workspace, only: 'sessions' }, admitted);
    expect(second.jobs).toEqual([expect.objectContaining({ status: 'skipped', reason: 'unchanged', noManifest: 0 })]);
    expect(second.messages).toEqual([]);
    expect(fs.existsSync(path.join(workspace, '.aiwg/sessions/discovery-manifest.json'))).toBe(false);
  });

  itWithSqlite('reports all receipts from mixed complete and partial manifests and retries only unfinished batches', async () => {
    const database = path.join(workspace, '.aiwg/sessions/catalog.sqlite');
    fs.mkdirSync(path.dirname(database), { recursive: true });
    new SessionRepository(database).close();
    const files = ['first.json', 'second.json', 'third.json'];
    for (const [index, file] of files.entries()) {
      const authorized = path.join(root, `authorized-${index}`);
      write(path.join(authorized, 'valid.jsonl'), JSON.stringify({
        type: 'user', sessionId: `valid-${index}`, cwd: workspace, message: { role: 'user', content: 'hello' },
      }) + '\n');
      if (index < 2) write(path.join(authorized, 'invalid.jsonl'), JSON.stringify({ type: 42, cwd: workspace }) + '\n');
      const manifest = await discoverWorkspaceHistories({
        workspace, expectedProviders: ['claude'], authorizedRoots: { claude: [authorized] },
      });
      await writeDiscoveryManifest(path.join(workspace, file), manifest);
    }
    write(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({ sessions: { discovery_manifests: files } }));
    const options = { cwd: workspace, only: 'sessions' as const };
    const first = await refreshIndexes(options, admitted);
    expect(first).toMatchObject({ status: 'partial', totals: { ok: 1, errors: 0, noManifest: 0 } });
    expect(first.jobs[0]).toMatchObject({ status: 'ok', reason: 'session import partial: 2 rejected, 0 pending' });
    expect(first.jobs[0].sessionImport).toBeUndefined();
    const receipts = first.jobs[0].sessionImports!;
    expect(JSON.parse(JSON.stringify(first)).jobs[0].sessionImports).toEqual(receipts);
    expect(receipts).toHaveLength(3);
    expect(receipts.map(receipt => receipt.run.status)).toEqual(['partial', 'partial', 'complete']);
    for (const [index, receipt] of receipts.entries()) {
      const manifest = await readDiscoveryManifest(path.join(workspace, files[index]));
      expect(receipt.run.manifestId).toBe(manifest.manifestId);
      expect(receipt.totals).toMatchObject({ discovered: index < 2 ? 2 : 1, accepted: 1,
        rejected: index < 2 ? 1 : 0, pending: 0, sessionsAccepted: 1 });
      if (index < 2) expect(receipt.run.sources.find(source => source.status === 'rejected')).toMatchObject({
        errorCode: 'MALFORMED_SOURCE', detail: { issues: [{ path: 'type', code: 'invalid_type' }] },
      });
    }
    expect(process.exitCode ?? 0).toBe(0);
    const next = await refreshIndexes(options, admitted);
    expect(next).toMatchObject({ status: 'partial', totals: { ok: 1, errors: 0 } });
    expect(next.jobs[0].sessionImports?.map(receipt => receipt.run.manifestId))
      .toEqual(receipts.slice(0, 2).map(receipt => receipt.run.manifestId));
    expect(next.jobs[0].sessionImports?.every(receipt => receipt.run.sources
      .find(source => source.status === 'rejected')?.attempts === 2)).toBe(true);
    const repository = new SessionRepository(database);
    try {
      expect(repository.listSessions({ workspaceId: workspace, limit: 10 }).total).toBe(3);
    } finally { repository.close(); }
  });

  it('keeps missing-manifest warnings visible when resuming after another workspace fails', async () => {
    const other = path.join(root, 'zz-other');
    config(other);
    for (const ws of [workspace, other]) {
      const database = path.join(ws, '.aiwg/sessions/catalog.sqlite');
      fs.mkdirSync(path.dirname(database), { recursive: true });
      new SessionRepository(database).close();
    }
    write(path.join(other, '.aiwg/sessions/discovery-manifest.json'), '{}');
    await expect(refreshIndexes({ workspaces: [workspace, other], only: 'sessions' }, {
      ...admitted, afterJob: job => { if (job.status === 'error') throw new Error('simulated interruption'); },
    })).rejects.toThrow('simulated interruption');
    expect(JSON.parse(fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8')).completed).toEqual([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await refreshIndexes({ workspaces: [workspace, other], only: 'sessions' }, admitted);
      expect(report).toMatchObject({ status: 'partial', totals: { noManifest: 1, errors: 1 } });
      expect(report.messages).toHaveLength(1);
      expect(report.messages[0]).toContain(`aiwg sessions discover --workspace '${workspace}'`);
      expect(report.jobs[0]).toMatchObject({ workspace, noManifest: 1, reason: 'no authorized discovery manifest' });
      expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
    }
  });

  it('plans ordered default, configured, built, cache, and existing session jobs without writes', async () => {
    config(workspace, {
      refs: { scanDirs: ['refs'], defaultBuild: false, buildTier: 'lightweight' },
    });
    write(path.join(workspace, '.aiwg/.index/source/metadata.json'), JSON.stringify({ builtAt: '2026-01-01', entries: {} }));
    write(path.join(workspace, '.aiwg/.index/fortemi-core/project/manifest.json'), '{}');
    write(path.join(workspace, '.aiwg/sessions/catalog.sqlite'), 'existing catalog');
    const before = snapshot(root);
    const report = await refreshIndexes({ cwd: workspace, dryRun: true });
    expect(report.jobs.map(job => [job.kind, job.graph])).toEqual([
      ['graph', 'refs'], ['graph', 'project'], ['graph', 'codebase'], ['graph', 'source'],
      ['cache', 'project'], ['sessions', undefined], ['runtime', undefined], ['models', undefined],
    ]);
    expect(report.jobs.every(job => job.status === 'planned')).toBe(true);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(state)).toBe(false);
  });

  it('finds the current project from a subdirectory and stops at repository boundaries', () => {
    const jobs = planIndexRefresh({ cwd: path.join(workspace, 'src') });
    expect(jobs.every(job => job.workspace === workspace)).toBe(true);
    const nested = path.join(workspace, 'nested');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(planIndexRefresh({ cwd: nested }).every(job => job.workspace === nested)).toBe(true);
  });

  it('keeps the physical project boundary when cwd is a symlink into a subdirectory', () => {
    const alias = path.join(root, 'logical-src');
    fs.symlinkSync(path.join(workspace, 'src'), alias, 'dir');
    const jobs = planIndexRefresh({ cwd: alias });
    expect(jobs.map(job => [job.kind, job.graph])).toEqual([
      ['graph', 'project'], ['graph', 'codebase'], ['runtime', undefined], ['models', undefined],
    ]);
    expect(jobs.every(job => job.workspace === workspace)).toBe(true);
  });

  it('uses the dispatch gate with 8 GiB memory and 0.8 load per core, including stricter configured limits', async () => {
    const live = { supported: true, availMemGb: 8, loadRatio: 0.8, memPsiAvg10: 0, memPsiAvg60: 0, freeDiskGb: 100 };
    expect(await refreshResourceGate(workspace, live)).toEqual({ ok: true, reason: undefined });
    expect(await refreshResourceGate(workspace, { ...live, availMemGb: 7.9 })).toMatchObject({ ok: false });
    expect(await refreshResourceGate(workspace, { ...live, loadRatio: 0.81 })).toMatchObject({ ok: false });
    expect(await refreshResourceGate(workspace, { ...live, memPsiAvg10: 31 })).toMatchObject({ ok: false });
    write(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({
      build: { resource_preflight: { dispatch: { min_avail_mem_gb: 10 } } },
    }));
    expect(await refreshResourceGate(workspace, live)).toMatchObject({ ok: false });
    write(path.join(workspace, '.aiwg/aiwg.config'), '{invalid');
    await expect(refreshResourceGate(workspace, live)).rejects.toThrow();
  });

  it('builds incrementally, then skips unchanged graphs and caches without rewriting outputs', async () => {
    await refreshIndexes({ cwd: workspace, only: 'runtime' }, admitted);
    const first = await refreshIndexes({ cwd: workspace }, admitted);
    expect(first.totals).toMatchObject({ ok: 3, skipped: 1, errors: 0 });
    loadUserGraphConfigs(workspace);
    syncFortemiCoreIndex(workspace, { graph: 'project' });
    const before = snapshot(path.join(workspace, '.aiwg/.index'));
    const second = await refreshIndexes({ cwd: workspace }, admitted);
    expect(second.status).toBe('ok');
    expect(second.jobs).toHaveLength(5);
    expect(second.jobs.every(job => job.status === 'skipped' && job.reason === 'unchanged')).toBe(true);
    expect(snapshot(path.join(workspace, '.aiwg/.index'))).toEqual(before);
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);

    write(path.join(workspace, '.aiwg/requirements/UC-002.md'), '# Added requirement\n');
    const changed = await refreshIndexes({ cwd: workspace }, admitted);
    expect(changed.jobs.find(job => job.graph === 'project' && job.kind === 'graph')?.status).toBe('ok');
    expect(changed.jobs.find(job => job.kind === 'cache')?.status).toBe('ok');
    fs.unlinkSync(path.join(workspace, '.aiwg/requirements/UC-002.md'));
    const deleted = await refreshIndexes({ cwd: workspace }, admitted);
    expect(deleted.jobs[0].status).toBe('ok');
    expect(JSON.parse(fs.readFileSync(path.join(workspace, '.aiwg/.index/project/metadata.json'), 'utf8')).entries)
      .not.toHaveProperty('.aiwg/requirements/UC-002.md');
    const full = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(full.mode).toBe('full');
    expect(full.jobs.every(job => job.status === 'ok')).toBe(true);
  });

  it('skips a concurrent invocation with locked status and leaves the checkpoint alone', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const first = refreshIndexes({ cwd: workspace }, { gate: async () => { entered(); await blocked; return { ok: true }; } });
    await started;
    const checkpoint = fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8');
    try {
      const second = await refreshIndexes({ cwd: workspace }, admitted);
      expect(second).toMatchObject({ status: 'skipped', reason: 'locked', totals: { errors: 0 } });
      expect(fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8')).toBe(checkpoint);
    } finally {
      unblock();
      await first;
    }
  });

  it('reclaims a same-host dead PID lease and preserves live and foreign-host leases', async () => {
    const lock = path.join(state, 'index-refresh.lock');
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 123456789) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      return true;
    });
    write(path.join(lock, 'owner'), `123456789:old:${os.hostname()}\n`);
    expect((await refreshIndexes({ cwd: workspace }, admitted)).status).toBe('ok');
    expect(fs.existsSync(lock)).toBe(false);
    const release = await acquireDirectoryLock(lock);
    try {
      expect((await refreshIndexes({ cwd: workspace }, admitted)).reason).toBe('locked');
    } finally { await release(); }
    write(path.join(lock, 'owner'), '123456789:old:another-host\n');
    expect((await refreshIndexes({ cwd: workspace }, admitted)).reason).toBe('locked');
    expect(kill).toHaveBeenCalledWith(123456789, 0);
  });

  it('resumes after interruption and skips completed jobs from the matching checkpoint', async () => {
    await expect(refreshIndexes({ cwd: workspace, full: true }, {
      ...admitted,
      afterJob: (_job, count) => { if (count === 1) throw new Error('simulated interruption'); },
    })).rejects.toThrow('simulated interruption');
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(checkpoint).toMatchObject({ mode: 'full', completed: [checkpoint.jobs[0]] });
    expect(checkpoint.runId).toBeTypeOf('string');
    const graphDirectory = getGraphIndexDir(workspace, 'project');
    const before = snapshot(graphDirectory);
    const report = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(report.jobs[0]).toMatchObject({ status: 'skipped', reason: 'checkpoint' });
    expect(report.jobs[1].status).toBe('ok');
    expect(snapshot(graphDirectory)).toEqual(before);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('does not reuse a checkpoint for another mode or job list', async () => {
    const interrupt = { ...admitted, afterJob: () => { throw new Error('stop'); } };
    await expect(refreshIndexes({ cwd: workspace }, interrupt)).rejects.toThrow('stop');
    const full = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(full.jobs.every(job => job.reason !== 'checkpoint')).toBe(true);
    await expect(refreshIndexes({ cwd: workspace, full: true }, interrupt)).rejects.toThrow('stop');
    config(workspace, { extra: { scanDirs: ['src'], defaultBuild: false } });
    const changedPlan = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(changedPlan.jobs.every(job => job.reason !== 'checkpoint')).toBe(true);
  });

  it('checks the gate before every job and keeps progress on deferral', async () => {
    const gate = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'memory pressure' });
    const report = await refreshIndexes({ cwd: workspace }, { gate });
    expect(report).toMatchObject({ status: 'deferred', reason: 'memory pressure', totals: { ok: 1, deferred: 1, errors: 0 } });
    expect(gate).toHaveBeenCalledTimes(2);
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    expect(JSON.parse(fs.readFileSync(checkpointPath, 'utf8')).completed).toHaveLength(1);
    const next = await refreshIndexes({ cwd: workspace }, admitted);
    expect(next.jobs[0].reason).toBe('checkpoint');
    expect(next.jobs[1].status).toBe('ok');
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('skips all session jobs with one sqlite remedy while completing graph jobs', async () => {
    const other = path.join(root, 'other');
    config(other);
    for (const ws of [workspace, other]) write(path.join(ws, '.aiwg/sessions/catalog.sqlite'), 'catalog');
    const available = vi.fn(async () => false);
    const report = await refreshIndexes({ workspaces: [workspace, other] }, { ...admitted, sessionsAvailable: available });
    expect(report.status).toBe('partial');
    expect(report.totals.errors).toBe(0);
    expect(report.jobs.filter(job => job.kind === 'sessions').every(job => job.reason === 'sqlite unavailable')).toBe(true);
    expect(report.jobs.filter(job => job.kind === 'graph' && job.workspace === workspace).every(job => job.status === 'ok')).toBe(true);
    expect(report.messages).toEqual(['Session refresh skipped: run `aiwg features install sqlite`.']);
    expect(available).toHaveBeenCalledTimes(1);
  });

  it('scans to depth four, excludes caches, and deduplicates repeated workspaces', () => {
    const tree = path.join(root, 'dev');
    for (const relative of ['a', 'a/b/c/d', 'a/b/c/d/e', 'node_modules/ignored', '.git/ignored', '.worktrees/ignored', 'aiwg-wt/ignored']) config(path.join(tree, relative));
    fs.symlinkSync(workspace, path.join(tree, 'link'), 'dir');
    const jobs = planIndexRefresh({ root: tree, workspaces: [workspace, workspace], only: 'graphs' });
    expect([...new Set(jobs.map(job => job.workspace))]).toEqual([path.join(tree, 'a'), path.join(tree, 'a/b/c/d'), workspace].sort());
  });

  it('scans two roots and follows symlinked workspaces once across roots and explicit selections', () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const other = path.join(second, 'other');
    fs.mkdirSync(first);
    config(other);
    fs.symlinkSync(workspace, path.join(first, 'linked-workspace'), 'dir');
    const jobs = planIndexRefresh({ cwd: root, root: ['first', 'second', 'first'], workspaces: [other], only: 'graphs' });
    expect(jobs.map(job => job.workspace)).toEqual([other, other, workspace, workspace].sort());
  });

  it('stops symlink cycles and ignores dangling links and links to files', () => {
    const tree = path.join(root, 'tree');
    config(path.join(tree, 'project'));
    fs.symlinkSync(tree, path.join(tree, 'project', 'cycle'), 'dir');
    fs.symlinkSync(path.join(root, 'missing'), path.join(tree, 'dangling'), 'dir');
    fs.symlinkSync(path.join(workspace, 'src/example.ts'), path.join(tree, 'file'));
    fs.symlinkSync('self', path.join(tree, 'self'), 'dir');
    const jobs = planIndexRefresh({ root: tree, only: 'graphs' });
    expect(jobs.map(job => job.workspace)).toEqual([path.join(tree, 'project'), path.join(tree, 'project')]);
  });

  it('preserves the depth limit through directory symlinks', () => {
    const tree = path.join(root, 'tree');
    const target = path.join(root, 'target');
    fs.mkdirSync(tree);
    config(path.join(target, 'a/b/c'));
    config(path.join(target, 'a/b/c/d'));
    fs.symlinkSync(target, path.join(tree, 'link'), 'dir');
    const jobs = planIndexRefresh({ root: tree, only: 'graphs' });
    expect(jobs.map(job => job.workspace)).toEqual([path.join(target, 'a/b/c'), path.join(target, 'a/b/c')]);
  });

  it('accepts repeated root and workspace CLI flags together', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const explicit = path.join(root, 'explicit');
    config(path.join(first, 'one'));
    config(path.join(second, 'two'));
    config(explicit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runIndexRefresh([
      '--root', first, '--root', second, '--workspace', workspace, '--workspace', explicit,
      '--dry-run', '--only', 'graphs', '--json',
    ]);
    expect(report.status).toBe('ok');
    expect([...new Set(report.jobs.map(job => job.workspace))]).toEqual([
      explicit, path.join(first, 'one'), path.join(second, 'two'), workspace,
    ].sort());
    expect(report.jobs).toHaveLength(8);
  });

  itWithSqlite('imports Claude sessions recorded under a logical path reached through a symlinked scan root', async () => {
    const tree = path.join(root, 'physical');
    const project = path.join(tree, 'project');
    config(project);
    const logicalTree = path.join(root, 'logical');
    fs.symlinkSync(tree, logicalTree, 'dir');
    const logicalProject = path.join(logicalTree, 'project');
    const home = path.join(root, 'provider-home');
    const projectKey = (ws: string) => ws.replace(/[^A-Za-z0-9-]/g, '-');
    for (const [id, cwd] of [['canonical', project], ['logical', logicalProject]]) {
      write(path.join(home, '.claude/projects', projectKey(cwd), `${id}.jsonl`), JSON.stringify({
        type: 'user', sessionId: id, uuid: `${id}-message`, cwd,
        message: { role: 'user', content: 'Synthetic request.' },
      }) + '\n');
    }
    const manifest = await discoverWorkspaceHistories({
      workspace: logicalProject, providerHome: home, expectedProviders: ['claude'],
    });
    expect(manifest.sources).toHaveLength(2);
    await writeDiscoveryManifest(path.join(project, '.aiwg/sessions/discovery-manifest.json'), manifest);
    const database = path.join(project, '.aiwg/sessions/catalog.sqlite');
    new SessionRepository(database).close();
    const options = { root: [tree, logicalTree], only: 'sessions' as const };
    const report = await refreshIndexes(options, admitted);
    expect(report.totals).toMatchObject({ jobs: 1, ok: 1, errors: 0 });
    expect(report.jobs[0].workspace).toBe(project);
    const repository = new SessionRepository(database);
    try {
      const imported = repository.listSessions({ workspaceId: project, limit: 20 });
      expect(imported.total).toBe(2);
      expect(imported.items.map(session => session.nativeSessionId).sort()).toEqual(['canonical', 'logical']);
    } finally { repository.close(); }
    await expect(refreshIndexes({ root: tree, only: 'sessions' }, {
      ...admitted, afterJob: () => { throw new Error('simulated interruption'); },
    })).rejects.toThrow('simulated interruption');
    // A completed job for the canonical route must not suppress a new logical route.
    expect((await refreshIndexes(options, admitted)).jobs[0].reason).toBe('unchanged');
  });

  it('isolates graph registrations with the same name across workspaces and honors --only', async () => {
    const other = path.join(root, 'other');
    config(other, { custom: { scanDirs: ['other-docs'], defaultBuild: false } });
    config(workspace, { custom: { scanDirs: ['docs'], defaultBuild: false } });
    write(path.join(workspace, 'docs/a.md'), '# First\n');
    write(path.join(other, 'other-docs/b.md'), '# Second\n');
    const report = await refreshIndexes({ workspaces: [workspace, other], only: 'graphs' }, admitted);
    expect(report.totals.errors).toBe(0);
    for (const [ws, expected] of [[workspace, 'docs/a.md'], [other, 'other-docs/b.md']]) {
      const index = JSON.parse(fs.readFileSync(path.join(ws, '.aiwg/.index/custom/metadata.json'), 'utf8'));
      expect(Object.keys(index.entries)).toEqual([expected]);
    }
    expect(planIndexRefresh({ cwd: workspace, only: 'sessions' })).toEqual([]);
    expect(planIndexRefresh({ cwd: workspace, only: 'caches' })).toEqual([]);
  });

  it('keeps shared global graphs idempotent across workspaces with different package files', async () => {
    const other = path.join(root, 'other');
    config(other);
    write(path.join(workspace, 'package.json'), '{"name":"first"}');
    write(path.join(other, 'package.json'), '{"name":"second"}');
    const shared = path.join(root, 'shared-docs');
    write(path.join(shared, 'a.md'), '# Shared note\n');
    write(path.join(process.env.HOME!, '.aiwg/aiwg.config'), JSON.stringify({
      index: { graphs: { notes: { scanDirs: [shared], defaultBuild: false } } },
    }));
    const options = { workspaces: [workspace, other], only: 'graphs' as const };
    expect((await refreshIndexes(options, admitted)).totals.errors).toBe(0);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'aiwg/index/notes');
    const before = snapshot(directory);
    const report = await refreshIndexes(options, admitted);
    expect(report.jobs.filter(job => job.graph === 'notes').every(job => job.reason === 'unchanged')).toBe(true);
    expect(snapshot(directory)).toEqual(before);
  });

  itWithSqlite('reports rejected sources as partial without job errors and executes every job on the next run', async () => {
    fs.mkdirSync(path.join(workspace, '.aiwg/sessions'), { recursive: true });
    const repository = new SessionRepository(path.join(workspace, '.aiwg/sessions/catalog.sqlite'));
    repository.close();
    const authorized = path.join(root, 'authorized-claude');
    write(path.join(authorized, 'valid.jsonl'), JSON.stringify({ type: 'user', sessionId: 'valid', cwd: workspace,
      message: { role: 'user', content: 'hello' } }) + '\n');
    write(path.join(authorized, 'invalid.jsonl'), JSON.stringify({ type: 42, cwd: workspace }) + '\n');
    const manifest = await discoverWorkspaceHistories({
      workspace, expectedProviders: ['claude'], authorizedRoots: { claude: [authorized] },
    });
    await writeDiscoveryManifest(path.join(workspace, '.aiwg/sessions/discovery-manifest.json'), manifest);
    write(path.join(workspace, '.aiwg/.index/fortemi-core/project/manifest.json'), '{}');
    const other = path.join(root, 'other');
    config(other);
    write(path.join(other, '.aiwg/requirements/UC-001.md'), '# Other requirement\n');
    write(path.join(other, 'src/example.ts'), 'export const other = 1;\n');
    const gate = vi.fn(admitted.gate);
    const options = { workspaces: [workspace, other] };
    const first = await refreshIndexes(options, { gate });
    expect(first).toMatchObject({ status: 'partial', totals: { errors: 0, ok: first.jobs.length } });
    const session = first.jobs.find(job => job.kind === 'sessions')!;
    expect(session).toMatchObject({ status: 'ok', sessionImport: {
      run: { status: 'partial' }, totals: { discovered: 2, rejected: 1, pending: 0, accepted: 1 },
    } });
    expect(session.error).toBeUndefined();
    expect(session.sessionImport?.run.sources.find(source => source.status === 'rejected')).toMatchObject({
      errorCode: 'MALFORMED_SOURCE', detail: { issues: [{ path: 'type', code: 'invalid_type' }] },
    });
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    expect(fs.existsSync(checkpointPath)).toBe(false);
    gate.mockClear();
    const next = await refreshIndexes(options, { gate });
    expect(next).toMatchObject({ status: 'partial', totals: { errors: 0 } });
    expect(gate).toHaveBeenCalledTimes(next.jobs.length);
    expect(next.jobs.every(job => job.reason !== 'checkpoint')).toBe(true);
    expect(next.jobs.find(job => job.kind === 'sessions')?.sessionImport?.run.sources
      .find(source => source.status === 'rejected')?.attempts).toBe(2);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it.each([false, true])('clears the checkpoint after a completed run with operational errors (all jobs fail: %s)', async (allFail) => {
    const gate = vi.fn().mockRejectedValueOnce(new Error('operational failure'));
    if (allFail) gate.mockRejectedValue(new Error('operational failure'));
    else gate.mockResolvedValue({ ok: true });
    const report = await refreshIndexes({ cwd: workspace, full: true }, { gate });
    expect(report).toMatchObject({ status: allFail ? 'error' : 'partial',
      totals: { jobs: 4, errors: allFail ? 4 : 1, ok: allFail ? 0 : 3, skipped: 0, deferred: 0 } });
    expect(gate).toHaveBeenCalledTimes(4);
    expect(report.jobs[0].error).toBe('operational failure');
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
    const nextGate = vi.fn(admitted.gate);
    const next = await refreshIndexes({ cwd: workspace, full: true }, { gate: nextGate });
    expect(next).toMatchObject({ status: 'ok', totals: { jobs: 4, ok: 4, errors: 0 } });
    expect(nextGate).toHaveBeenCalledTimes(4);
    expect(next.jobs.every(job => job.status === 'ok')).toBe(true);
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
  });

  it('keeps a deferred checkpoint even after an operational error', async () => {
    const gate = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('operational failure'))
      .mockResolvedValue({ ok: false, reason: 'memory pressure' });
    const report = await refreshIndexes({ cwd: workspace }, { gate });
    expect(report.totals).toMatchObject({ jobs: 4, ok: 1, errors: 1, deferred: 1 });
    expect(report.jobs.map(job => job.status)).toEqual(['ok', 'error', 'deferred', 'planned']);
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(checkpoint.completed).toEqual([checkpoint.jobs[0]]);
    const nextGate = vi.fn(admitted.gate);
    const next = await refreshIndexes({ cwd: workspace }, { gate: nextGate });
    expect(next).toMatchObject({ status: 'ok', totals: { jobs: 4, ok: 3, skipped: 1, errors: 0, deferred: 0 } });
    expect(next.jobs[0]).toMatchObject({ status: 'skipped', reason: 'checkpoint' });
    expect(next.jobs.slice(1).every(job => job.status === 'ok')).toBe(true);
    expect(nextGate).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('resumes a run aborted during its last job', async () => {
    const controller = new AbortController();
    const jobs = planIndexRefresh({ cwd: workspace, full: true });
    const gate = vi.fn(async () => {
      if (gate.mock.calls.length === jobs.length) {
        controller.abort();
        controller.signal.throwIfAborted();
      }
      return { ok: true };
    });
    await expect(refreshIndexes({ cwd: workspace, full: true, signal: controller.signal }, {
      gate,
    })).rejects.toThrow();
    expect(gate).toHaveBeenCalledTimes(jobs.length);
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    expect(JSON.parse(fs.readFileSync(checkpointPath, 'utf8')).completed).toHaveLength(jobs.length - 1);
    const next = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(next.jobs.slice(0, -1).every(job => job.reason === 'checkpoint')).toBe(true);
    expect(next.jobs.at(-1)?.status).toBe('ok');
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('records graph failures and emits the versioned JSON contract with a failing exit code', async () => {
    write(path.join(workspace, '.aiwg/.index/project'), 'blocks graph output');
    const report = await refreshIndexes({ cwd: workspace }, admitted);
    expect(report).toMatchObject({ status: 'partial', totals: { errors: 1, ok: 3 } });
    expect(report.jobs[0].error).toBeTypeOf('string');
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = await runIndexRefresh(['--only', 'invalid', '--json'], workspace);
    expect(cli.status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ contractVersion: '1.0.0', command: 'index.refresh', status: 'error' });
    process.exitCode = 0;
    log.mockClear();
    await runIndexRefresh(['--workspace', workspace, '--dry-run', '--json']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ status: 'ok', mode: 'incremental' });
    expect(process.exitCode).toBe(0);
  });

  it('plans runtime, models, and existing local issues in dry runs without writes', async () => {
    fs.mkdirSync(path.join(workspace, '.aiwg/issues/items'), { recursive: true });
    const before = snapshot(root);
    const jobs = planIndexRefresh({ cwd: workspace });
    const report = await refreshIndexes({ cwd: workspace, dryRun: true });
    expect(report.jobs).toEqual(jobs);
    expect(jobs.slice(-3).map(job => job.kind)).toEqual(['runtime', 'models', 'issues']);
    expect(jobs.slice(-3).every(job => job.status === 'planned')).toBe(true);
    expect(snapshot(root)).toEqual(before);
    expect(providerInventory.collectProviderInventory).not.toHaveBeenCalled();
  });

  it('leaves workspaces without local issue storage out of the issues plan', () => {
    expect(planIndexRefresh({ cwd: workspace, only: 'issues' })).toEqual([]);
  });

  it.each(['runtime', 'models', 'issues'] as const)('accepts --only %s in the JSON CLI contract', async only => {
    fs.mkdirSync(path.join(workspace, '.aiwg/issues/items'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runIndexRefresh(['--only', only, '--dry-run', '--json'], workspace);
    expect(report.jobs).toEqual([{ kind: only, workspace, status: 'planned', wallMs: 0 }]);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(report);
    expect(process.exitCode).toBe(0);
  });

  it('executes --only runtime with one JSON report and no discovery chatter', async () => {
    vi.spyOn(resourcePreflight, 'readLiveHostResources').mockReturnValue({
      supported: true, availMemGb: 16, loadRatio: 0, memPsiAvg10: 0, memPsiAvg60: 0, freeDiskGb: 100,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runIndexRefresh(['--only', 'runtime', '--json'], workspace);
    expect(report).toMatchObject({ status: 'ok', totals: { jobs: 1, ok: 1, errors: 0 } });
    expect(report.jobs[0]).toMatchObject({ kind: 'runtime', workspace, status: 'ok' });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(report);
    expect(process.exitCode).toBe(0);
  });

  it('runs only runtime for the selected workspace and keeps output quiet', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await refreshIndexes({ cwd: workspace, only: 'runtime' }, admitted);
    expect(report).toMatchObject({ status: 'ok', totals: { jobs: 1, ok: 1, errors: 0 } });
    expect(report.jobs[0]).toMatchObject({ kind: 'runtime', workspace, status: 'ok' });
    const catalog = JSON.parse(fs.readFileSync(path.join(workspace, '.aiwg/smiths/toolsmith/runtime.json'), 'utf8'));
    expect(catalog.environment.workingDir).toBe(workspace);
    expect(providerInventory.collectProviderInventory).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspace, '.aiwg/.index'))).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['runtime', 'models', 'issues'] as const)('uses the %s shortcut and forces a full refresh', async only => {
    fs.mkdirSync(path.join(workspace, '.aiwg/issues/items'), { recursive: true });
    const first = await refreshIndexes({ cwd: workspace, only }, admitted);
    expect(first.jobs[0].status).toBe('ok');
    const before = snapshot(root);
    const second = await refreshIndexes({ cwd: workspace, only }, admitted);
    expect(second.jobs[0]).toMatchObject({ kind: only, status: 'skipped', reason: 'unchanged' });
    expect(snapshot(root)).toEqual(before);
    const full = await refreshIndexes({ cwd: workspace, only, full: true }, admitted);
    expect(full).toMatchObject({ mode: 'full', totals: { jobs: 1, ok: 1, errors: 0 } });
    expect(full.jobs[0].status).toBe('ok');
  });

  it.each(['runtime', 'models', 'issues'] as const)('isolates a %s failure and clears the finished run checkpoint', async kind => {
    fs.mkdirSync(path.join(workspace, '.aiwg/issues/items'), { recursive: true });
    const failed = kind === 'runtime'
      ? vi.spyOn(RuntimeDiscovery.prototype, 'discover').mockRejectedValue(new Error('runtime failed'))
      : kind === 'models'
        ? vi.spyOn(modelDiscovery, 'resolveDynamicModelCatalog').mockRejectedValue(new Error('models failed'))
        : vi.spyOn(LocalIssueProviderCore.prototype, 'rebuildIssueIndex').mockRejectedValue(new Error('issues failed'));
    const gate = vi.fn(admitted.gate);
    const report = await refreshIndexes({ cwd: workspace }, { gate });
    expect(report).toMatchObject({ status: 'partial', totals: { jobs: 5, ok: 4, errors: 1 } });
    expect(report.jobs.find(job => job.kind === kind)).toMatchObject({ status: 'error', error: `${kind} failed` });
    expect(report.jobs.filter(job => job.kind !== kind).every(job => job.status === 'ok')).toBe(true);
    expect(gate).toHaveBeenCalledTimes(5);
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
    failed.mockRestore();
    gate.mockClear();
    const next = await refreshIndexes({ cwd: workspace }, { gate });
    expect(next).toMatchObject({ status: 'ok', totals: { jobs: 5, ok: 2, errors: 0, skipped: 3 } });
    expect(next.jobs.find(job => job.kind === kind)?.status).toBe('ok');
    // Runtime discovery and issue indexing add project inputs after the graph job.
    expect(next.jobs.find(job => job.kind === 'graph' && job.graph === 'project')?.status).toBe('ok');
    expect(next.jobs.filter(job => job.kind !== kind && job.graph !== 'project')
      .every(job => job.status === 'skipped' && job.reason === 'unchanged')).toBe(true);
    expect(gate).toHaveBeenCalledTimes(5);
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
  });

  it.each(['runtime', 'models', 'issues'] as const)('resumes only the failed %s job after interruption', async kind => {
    fs.mkdirSync(path.join(workspace, '.aiwg/issues/items'), { recursive: true });
    const failed = kind === 'runtime'
      ? vi.spyOn(RuntimeDiscovery.prototype, 'discover').mockRejectedValueOnce(new Error('runtime failed'))
      : kind === 'models'
        ? vi.spyOn(modelDiscovery, 'resolveDynamicModelCatalog').mockRejectedValueOnce(new Error('models failed'))
        : vi.spyOn(LocalIssueProviderCore.prototype, 'rebuildIssueIndex').mockRejectedValueOnce(new Error('issues failed'));
    const attempted: string[] = [];
    await expect(refreshIndexes({ cwd: workspace, full: true }, {
      ...admitted,
      afterJob: (job) => {
        attempted.push(job.status);
        if (attempted.length === 5) throw new Error('simulated interruption');
      },
    })).rejects.toThrow('simulated interruption');
    expect(attempted.filter(status => status === 'ok')).toHaveLength(4);
    expect(attempted.filter(status => status === 'error')).toHaveLength(1);
    expect(failed).toHaveBeenCalledOnce();
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(checkpoint.jobs).toHaveLength(5);
    expect(checkpoint.completed).toEqual(checkpoint.jobs.filter((key: string) => JSON.parse(key)[0] !== kind));
    const gate = vi.fn(admitted.gate);
    const next = await refreshIndexes({ cwd: workspace, full: true }, { gate });
    expect(next).toMatchObject({ status: 'ok', totals: { jobs: 5, ok: 1, skipped: 4, errors: 0 } });
    expect(next.jobs.find(job => job.kind === kind)?.status).toBe('ok');
    expect(next.jobs.filter(job => job.kind !== kind).every(job => job.status === 'skipped' && job.reason === 'checkpoint')).toBe(true);
    expect(gate).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);
  });

  it.each(['runtime', 'models', 'issues'] as const)('applies the host lock and resource gate to %s jobs', async only => {
    fs.mkdirSync(path.join(workspace, '.aiwg/issues/items'), { recursive: true });
    const release = await acquireDirectoryLock(path.join(state, 'index-refresh.lock'));
    const gate = vi.fn(async () => ({ ok: false, reason: 'memory pressure' }));
    try {
      const locked = await refreshIndexes({ cwd: workspace, only }, { gate });
      expect(locked.jobs[0]).toMatchObject({ kind: only, status: 'skipped', reason: 'locked' });
      expect(gate).not.toHaveBeenCalled();
    } finally { await release(); }
    const deferred = await refreshIndexes({ cwd: workspace, only }, { gate });
    expect(deferred).toMatchObject({ status: 'deferred', totals: { jobs: 1, deferred: 1, errors: 0 } });
    expect(deferred.jobs[0]).toMatchObject({ kind: only, reason: 'memory pressure' });
    expect(gate).toHaveBeenCalledOnce();
    const checkpoint = JSON.parse(fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8'));
    expect(checkpoint.completed).toEqual([]);
    expect((await refreshIndexes({ cwd: workspace, only }, admitted)).jobs[0].status).toBe('ok');
  });

  it('never discovers a provider root that was not already authorized', async () => {
    const authorized = path.join(root, 'authorized-claude');
    write(path.join(authorized, 'one.jsonl'), JSON.stringify({ type: 'user', sessionId: 'one', cwd: workspace, message: { role: 'user', content: 'hello' } }) + '\n');
    const hiddenCodex = path.join(root, 'unauthorized-codex');
    write(path.join(hiddenCodex, 'two.jsonl'), '{}\n');
    const manifest = await discoverWorkspaceHistories({
      workspace, expectedProviders: ['claude', 'codex'],
      authorizedRoots: { claude: [authorized] }, codexRoot: hiddenCodex,
    });
    expect(manifest.authorizedRoots).toEqual({ claude: [authorized] });
    expect(manifest.sources.map(source => source.provider)).toEqual(['claude']);
    const saved = path.join(workspace, '.aiwg/sessions/discovery-manifest.json');
    await writeDiscoveryManifest(saved, manifest);
    expect((await readDiscoveryManifest(saved)).authorizedRoots).toEqual({ claude: [authorized] });
  });

});
