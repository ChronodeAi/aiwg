import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { discoverInventory, DISCOVERY_EXCLUSIONS } from '../../../src/discovery/index.js';
import { knownWorkerCliExecutables } from '../../../src/models/worker-dispatch-offer.js';

// Keep real filesystem behavior while allowing deterministic I/O faults. Native
// ESM namespace exports themselves cannot be replaced with spies on Node 24.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

let scratch: string;
let workspace: string;
beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'aiwg-discovery-'));
  workspace = join(scratch, 'workspace');
  await fs.mkdir(workspace);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(scratch, { recursive: true, force: true });
});

async function file(path: string, text = '{}'): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text);
}
const scan = (options: Parameters<typeof discoverInventory>[0] = {}) => discoverInventory({
  workspaceRoot: workspace, registrySeeds: false, pathEnv: '', timeBudgetMs: 10_000, ...options,
});
const codes = (inventory: Awaited<ReturnType<typeof scan>>) => inventory.diagnostics.map(d => d.code);

async function snapshot(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function walk(path: string): Promise<void> {
    const info = await fs.lstat(path);
    const key = relative(root, path);
    result[key] = { mode: info.mode, size: info.size, mtime: info.mtimeMs,
      value: info.isFile() ? (await fs.readFile(path)).toString('base64') : info.isSymbolicLink() ? await fs.readlink(path) : null };
    if (info.isDirectory()) for (const name of await fs.readdir(path)) await walk(join(path, name));
  }
  await walk(root);
  return result;
}

describe('bounded project discovery', () => {
  it('inspects the workspace and registry seeds shallowly by default', async () => {
    const seed = join(scratch, 'registered');
    await file(join(seed, 'package.json'));
    await file(join(seed, 'nested', 'package.json'));
    await file(join(workspace, 'nested', 'package.json'));
    const inventory = await scan({ registrySeeds: [seed] });
    expect(inventory.projects.map(p => p.root).sort()).toEqual([seed, workspace].sort());
    expect(inventory.projects.find(p => p.root === seed)?.sources).toEqual(['registry']);
  });

  it('reads registry seeds through the existing registry location without writing it', async () => {
    const registryHome = join(scratch, 'registry');
    const seed = join(scratch, 'registered');
    await fs.mkdir(seed);
    await file(join(registryHome, 'manifest.json'), JSON.stringify({ version: 1, projects: [{ workspaceRoots: [seed], memoryRoot: join(scratch, 'unread-memory') }] }));
    vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', registryHome);
    const before = await snapshot(scratch);
    const inventory = await scan({ registrySeeds: undefined });
    expect(inventory.projects.map(p => p.root)).toContain(seed);
    expect(await snapshot(scratch)).toEqual(before);
  });

  it('reports stale and malformed registry entries and continues with valid seeds', async () => {
    const registryHome = join(scratch, 'registry');
    await file(join(registryHome, 'manifest.json'), JSON.stringify({ version: 1, projects: [null, { workspaceRoots: [join(scratch, 'missing')] }] }));
    vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', registryHome);
    const inventory = await scan({ registrySeeds: undefined });
    expect(codes(inventory)).toEqual(expect.arrayContaining(['invalid-metadata', 'inaccessible']));
    expect(inventory.projects).toHaveLength(1);
  });

  it('deduplicates canonical roots and overlapping recursive roots, preserving seed sources', async () => {
    const alias = join(scratch, 'alias');
    await fs.symlink(workspace, alias, 'dir');
    await file(join(workspace, 'child', 'package.json'));
    const inventory = await scan({ registrySeeds: [alias, workspace], roots: [alias, workspace, join(workspace, 'child')] });
    expect(inventory.projects.map(p => p.root)).toEqual([workspace, join(workspace, 'child')]);
    expect(inventory.projects[0].sources).toEqual(['workspace', 'registry', 'selected']);
    expect(inventory.projects[1].sources).toEqual(['selected']);
  });

  it('detects Git, worktrees and non-Git projects without executing Git', async () => {
    await fs.mkdir(join(workspace, '.git'));
    const worktree = join(workspace, 'linked');
    await file(join(worktree, '.git'), 'gitdir: /not-readable/external/.git/worktrees/linked\n');
    await file(join(workspace, 'plain', 'pyproject.toml'), '[project]\nname="plain"');
    const inventory = await scan({ roots: [workspace] });
    expect(inventory.projects.map(p => [p.root, p.vcs])).toEqual([
      [workspace, 'git'], [worktree, 'worktree'], [join(workspace, 'plain'), 'none'],
    ]);
    expect(inventory.diagnostics.some(d => d.path.startsWith('/not-readable'))).toBe(false);
  });

  it('reports invalid Git markers and invalid package metadata', async () => {
    await file(join(workspace, '.git'), 'not a gitdir');
    await file(join(workspace, 'package.json'), '{broken');
    const inventory = await scan();
    expect(inventory.projects[0].vcs).toBe('unknown');
    expect(codes(inventory).filter(c => c === 'invalid-metadata')).toHaveLength(2);
  });

  it.each([
    { workspaces: ['packages/*'] },
    { workspaces: { packages: ['packages/*'] } },
  ])('detects workspace layout and preserves ambiguous root/package selection: %j', async manifest => {
    await file(join(workspace, 'package.json'), JSON.stringify(manifest));
    await file(join(workspace, 'packages', 'one', 'package.json'));
    await file(join(workspace, 'packages', 'two', 'package.json'));
    const inventory = await scan({ roots: [workspace] });
    const root = inventory.projects.find(p => p.root === workspace)!;
    expect(root.layout).toBe('monorepo');
    expect(root.workspacePatterns).toEqual(['packages/*']);
    expect(root.packageRoots).toEqual([join(workspace, 'packages', 'one'), join(workspace, 'packages', 'two')]);
    expect(inventory.projects.filter(p => p.layout === 'package')).toHaveLength(2);
    expect(codes(inventory)).toContain('ambiguous');
  });

  it('reports undeclared nested packages and malformed workspace declarations as ambiguous', async () => {
    await file(join(workspace, 'package.json'), JSON.stringify({ workspaces: { nope: true } }));
    await file(join(workspace, 'nested', 'package.json'));
    const inventory = await scan({ roots: [workspace] });
    expect(inventory.projects[0].layout).toBe('ambiguous');
    expect(codes(inventory)).toContain('ambiguous');
    await file(join(workspace, 'package.json'));
    expect((await scan({ roots: [workspace] })).projects[0].layout).toBe('ambiguous');
  });

  it.each(['pnpm-workspace.yaml', 'lerna.json'])('detects monorepo marker %s', async marker => {
    await file(join(workspace, marker));
    expect((await scan()).projects[0].layout).toBe('monorepo');
  });

  it('excludes dependency, VCS, build and cache trees plus caller additions', async () => {
    for (const name of [...DISCOVERY_EXCLUSIONS, 'custom-skip']) await file(join(workspace, name, 'buried', 'package.json'));
    await file(join(workspace, 'kept', 'package.json'));
    const inventory = await scan({ roots: [workspace], excludeNames: ['custom-skip'] });
    expect(inventory.projects.map(p => p.root)).toEqual([workspace, join(workspace, 'kept')]);
    expect(inventory.diagnostics.filter(d => d.code === 'excluded')).toHaveLength(DISCOVERY_EXCLUSIONS.length + 1);
    const excluded = await scan({ roots: [join(workspace, 'node_modules')] });
    expect(excluded.projects).toHaveLength(1);
    expect(codes(excluded)).toContain('excluded');
  });

  it('refuses escaped, in-root, cyclic and provider-directory symlinks', async () => {
    const outside = join(scratch, 'outside');
    await file(join(outside, 'package.json'));
    await file(join(outside, 'aiwg.config'), JSON.stringify({ providers: ['codex'] }));
    await fs.symlink(outside, join(workspace, 'escape'), 'dir');
    await fs.symlink(outside, join(workspace, '.aiwg'), 'dir');
    await fs.symlink(outside, join(workspace, '.codex'), 'dir');
    await fs.symlink(workspace, join(workspace, 'cycle'), 'dir');
    await file(join(workspace, 'real', 'package.json'));
    await fs.symlink(join(workspace, 'real'), join(workspace, 'alias'), 'dir');
    const inventory = await scan({ roots: [workspace] });
    expect(inventory.projects.map(p => p.root)).toEqual([workspace, join(workspace, 'real')]);
    expect(inventory.projects[0].aiwg.configFile).toBeNull();
    expect(inventory.projects[0].providerFiles.every(p => !p.path.includes('.codex'))).toBe(true);
    expect(codes(inventory)).toContain('symlink-skipped');
    expect(inventory.diagnostics.some(d => d.path.startsWith(outside))).toBe(false);
  });

  it('respects depth bounds and reports incomplete traversal', async () => {
    await file(join(workspace, 'one', 'package.json'));
    await file(join(workspace, 'one', 'two', 'package.json'));
    const inventory = await scan({ roots: [workspace], maxDepth: 1 });
    expect(inventory.projects.map(p => p.root)).toEqual([workspace, join(workspace, 'one')]);
    expect(codes(inventory)).toContain('depth-limit');
    expect(inventory.stats.truncated).toBe(true);
  });

  it('enforces a global entry budget including registry and tool metadata', async () => {
    for (let i = 0; i < 50; i++) await file(join(workspace, `project-${i}`, 'package.json'));
    const inventory = await scan({ roots: [workspace], maxEntries: 160 });
    expect(inventory.stats.entriesInspected).toBe(160);
    expect(codes(inventory)).toContain('entry-limit');
    expect(inventory.projects.length).toBeLessThan(51);
    expect(inventory.tools.every(t => t.installed === 'unknown')).toBe(true);
  });

  it('handles zero entry and time budgets without any filesystem inspection', async () => {
    const zeroEntries = await scan({ maxEntries: 0 });
    expect(zeroEntries.stats.entriesInspected).toBe(0);
    expect(codes(zeroEntries)).toContain('entry-limit');
    const zeroTime = await scan({ timeBudgetMs: 0 });
    expect(zeroTime.stats.entriesInspected).toBe(0);
    expect(codes(zeroTime)).toContain('time-limit');
  });

  it('stops on the monotonic time budget deterministically', async () => {
    let tick = 0;
    const inventory = await scan({ roots: [workspace], timeBudgetMs: 20, now: () => tick++ });
    expect(codes(inventory)).toContain('time-limit');
    expect(inventory.stats.truncated).toBe(true);
    expect(inventory.stats.entriesInspected).toBeLessThan(20);
  });

  it('bounds waiting for stalled filesystem I/O', async () => {
    vi.spyOn(fs, 'realpath').mockImplementation(() => new Promise(() => {}));
    const inventory = await scan({ timeBudgetMs: 15 });
    expect(codes(inventory)).toContain('time-limit');
    expect(inventory.stats.entriesInspected).toBe(1);
  });

  it('does not let stalled directory reads or cleanup extend the deadline', async () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    vi.spyOn(fs, 'opendir').mockResolvedValue({
      read: () => new Promise(() => {}), close,
    } as unknown as Awaited<ReturnType<typeof fs.opendir>>);
    const inventory = await scan({ roots: [workspace], timeBudgetMs: 100 });
    expect(codes(inventory)).toContain('time-limit');
    expect(close).toHaveBeenCalled();
  });

  it('caps metadata reads without dropping the project', async () => {
    await file(join(workspace, 'package.json'), ' '.repeat(400));
    const inventory = await scan({ maxFileBytes: 100 });
    expect(codes(inventory)).toContain('file-limit');
    expect(inventory.projects[0].packageManifest).toBe(join(workspace, 'package.json'));
  });

  it('reports inaccessible directories without aborting sibling discovery', async () => {
    const denied = join(workspace, 'denied');
    await fs.mkdir(denied);
    await file(join(workspace, 'good', 'package.json'));
    const original = fs.opendir;
    vi.spyOn(fs, 'opendir').mockImplementation(((path: string, options: unknown) => {
      if (path === denied) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
      return original(path, options as Parameters<typeof fs.opendir>[1]);
    }) as typeof fs.opendir);
    const inventory = await scan({ roots: [workspace] });
    expect(inventory.projects.map(p => p.root)).toContain(join(workspace, 'good'));
    expect(inventory.diagnostics).toContainEqual(expect.objectContaining({ code: 'inaccessible', path: denied }));
  });

  it('refuses recursive home/filesystem-root scans', async () => {
    const inventory = await scan({ roots: [homedir(), '/'] });
    expect(codes(inventory).filter(c => c === 'home-scan-refused')).toHaveLength(2);
    expect(inventory.projects.map(p => p.root)).toEqual([workspace]);
  });

  it('inventories existing AIWG and provider files without reading secrets or writing', async () => {
    await file(join(workspace, '.aiwg', 'aiwg.config'), JSON.stringify({ providers: ['codex'] }));
    await file(join(workspace, 'AIWG.md'), 'context');
    await file(join(workspace, 'AGENTS.md'), 'provider context');
    await file(join(workspace, '.codex', 'auth.json'), 'DO NOT READ');
    await fs.mkdir(join(workspace, '.claude', 'agents'), { recursive: true });
    const before = await snapshot(scratch);
    const read = vi.spyOn(fs, 'open');
    const inventory = await scan({ roots: [workspace] });
    expect(read.mock.calls.some(([path]) => String(path).includes('auth.json'))).toBe(false);
    expect(inventory.projects[0].aiwg).toEqual({ directory: true, configFile: join(workspace, '.aiwg', 'aiwg.config'), contextFile: join(workspace, 'AIWG.md') });
    expect(inventory.projects[0].providerFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'codex', path: join(workspace, 'AGENTS.md') }),
      expect.objectContaining({ provider: 'claude', path: join(workspace, '.claude', 'agents'), kind: 'artifacts' }),
    ]));
    expect(inventory.tools.find(t => t.executable === 'codex')?.configured).toBe('yes');
    expect(await snapshot(scratch)).toEqual(before);
  });

  it('reuses the worker mapping, distinguishes all readiness states, and never executes binaries', async () => {
    const bin = join(scratch, 'bin');
    const executable = knownWorkerCliExecutables()[0];
    const poison = join(scratch, 'executed');
    await file(join(bin, executable), `#!/bin/sh\ntouch '${poison}'\n`);
    await fs.chmod(join(bin, executable), 0o755);
    await fs.mkdir(join(bin, 'codex'));
    const inventory = await scan({ pathEnv: bin, toolEvidence: {
      [executable]: { configured: 'no', authenticated: 'yes', qualified: 'unknown', version: '1.2.3', evidence: ['prior local status'] },
    } });
    expect(inventory.tools.map(t => t.executable)).toEqual(knownWorkerCliExecutables());
    expect(inventory.tools[0]).toMatchObject({ installed: 'yes', configured: 'no', authenticated: 'yes', qualified: 'unknown', version: '1.2.3' });
    expect(inventory.tools.find(t => t.executable === 'codex')?.installed).toBe('no');
    await expect(fs.access(poison, constants.F_OK)).rejects.toThrow();
    expect(inventory.tools.slice(1).every(t => t.version === null && t.authenticated === 'unknown')).toBe(true);
    expect((await scan({ toolEvidence: { [executable]: { qualified: 'yes' } } })).tools[0].qualified).toBe('yes');
  });

  it('rejects non-executable files, accepts executable shims, and bounds PATH lookups', async () => {
    const bin = join(scratch, 'bin');
    const target = join(scratch, 'target');
    await file(target, '#!/bin/sh\nexit 0');
    await fs.mkdir(bin);
    const executable = knownWorkerCliExecutables()[0];
    await fs.symlink(target, join(bin, executable));
    expect((await scan({ pathEnv: bin })).tools[0].installed).toBe('no');
    await fs.chmod(target, 0o755);
    expect((await scan({ pathEnv: bin })).tools[0].installed).toBe('yes');
    const inventory = await scan({ pathEnv: Array.from({ length: 100 }, (_, i) => join(scratch, `missing-${i}`)).join(delimiter), maxEntries: 160 });
    expect(inventory.stats.entriesInspected).toBe(160);
    expect(codes(inventory)).toContain('entry-limit');
  });

  it('leaves installation unknown when PATH metadata is inaccessible', async () => {
    const bin = join(scratch, 'bin');
    const executable = knownWorkerCliExecutables()[0];
    const original = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(((path: string) => {
      if (path === join(bin, executable)) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
      return original(path);
    }) as typeof fs.stat);
    const inventory = await scan({ pathEnv: bin });
    expect(inventory.tools[0].installed).toBe('unknown');
    expect(codes(inventory)).toContain('inaccessible');
  });

  it('does not mutate supplied tool evidence', async () => {
    const executable = knownWorkerCliExecutables()[0];
    const evidence = Object.freeze(['prior local status']);
    const toolEvidence = { [executable]: { evidence: evidence as unknown as string[] } };
    await file(join(workspace, '.aiwg', 'aiwg.config'), JSON.stringify({ providers: ['claude', 'codex'] }));
    await scan({ toolEvidence });
    expect(evidence).toEqual(['prior local status']);
  });

  it.each(['maxDepth', 'maxEntries', 'timeBudgetMs', 'maxFileBytes'] as const)('rejects invalid %s bounds', async key => {
    await expect(scan({ [key]: -1 })).rejects.toThrow(RangeError);
    await expect(scan({ [key]: Infinity })).rejects.toThrow(RangeError);
  });
});
