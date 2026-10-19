import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import * as indexBuilder from '../../../src/artifacts/index-builder.js';
import * as fortemiSync from '../../../src/artifacts/fortemi-core-sync.js';
import { acquireDirectoryLock } from '../../../src/artifacts/prebuilt-build-lock.js';
import { hostname } from 'node:os';
import { discoverCapability, showArtifact } from '../../../src/artifacts/query-engine.js';
import { refreshFrameworkCapabilities } from '../../../src/artifacts/framework-capabilities.js';
import { getFortemiCoreSyncStatus, syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { loadFortemiCoreMetadataEntries } from '../../../src/artifacts/fortemi-core-query-adapter.js';
import { getGraphIndexDir, type ArtifactIndex } from '../../../src/artifacts/types.js';
import { loadGraphIndexFile } from '../../../src/artifacts/index-reader.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const research = 'agentic/code/frameworks/research-complete';
const induction = `${research}/skills/induct-research/SKILL.md`;
let tmp: string;
let root: string;
let project: string;
let log: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function copySkill(name: string): void {
  const relative = `${research}/skills/${name}/SKILL.md`;
  write(relative, fs.readFileSync(path.join(repo, relative), 'utf8'));
}

function index(): ArtifactIndex {
  return JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(project, 'framework'), 'metadata.json'), 'utf8'));
}

function json(): any {
  return JSON.parse(log.mock.calls.map(call => call[0]).join(''));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-3304-'));
  root = path.join(tmp, 'runtime');
  project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(project, '.aiwg'));
  fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({
    installed: { research: { deployedTo: { claude: { skills: 29 } } } },
  }));
  for (const [key, value] of Object.entries({
    HOME: path.join(tmp, 'home'), XDG_DATA_HOME: path.join(tmp, 'data'),
    XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_CACHE_HOME: path.join(tmp, 'cache'),
    AIWG_ROOT: root, AIWG_ARTIFACTS_PATH: '', AIWG_PROJECT_ARTIFACTS_PATH: '', AIWG_PROJECT_AIWG_DIR: '',
  })) vi.stubEnv(key, value);
  write('package.json', JSON.stringify({ name: 'aiwg', version: '1.0.0' }));
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    fs.mkdirSync(path.join(root, 'agentic/code', kind), { recursive: true });
  }
  write(`${research}/manifest.json`, JSON.stringify({ id: 'research-complete', modeAliases: ['research'] }));
  write(`${research}/skills/corpus-health-audit/SKILL.md`, '---\nname: corpus-health-audit\ndescription: Audit paper corpus health.\n---\n# Corpus Health Audit\n');
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('framework capabilities outside provider directories (#3304)', () => {
  it.each(['show', 'discover'] as const)('does not replace the shared runtime graph from a partial project corpus (%s)', async query => {
    copySkill('induct-research');
    await refreshFrameworkCapabilities(root);
    const metadata = path.join(getGraphIndexDir(root, 'framework'), 'metadata.json');
    const before = fs.readFileSync(metadata, 'utf8');
    const partial = path.join(project, 'agentic/code/addons/local/skills/local-only/SKILL.md');
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(partial, '---\nname: local-only\n---\n# Local only\n');
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    if (query === 'show') {
      await showArtifact(project, { name: 'induct-research', typeFilter: ['skill'], backend: 'local', json: true });
    } else {
      await discoverCapability(project, { phrase: 'induct this paper', backend: 'local', json: true });
    }
    expect(builder).not.toHaveBeenCalled();
    expect(fs.readFileSync(metadata, 'utf8')).toBe(before);
  });

  it.each([false, true])('ignores partial roots without publishing a receipt (package marker: %s)', async packageMarker => {
    const partial = path.join(project, 'agentic/code/frameworks/local/skills/probe/SKILL.md');
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(partial, '# Probe\n');
    if (packageMarker) {
      // Even an aiwg package with frameworks/addons can be a partial checkout.
      fs.writeFileSync(path.join(project, 'package.json'), '{"name":"aiwg"}');
      fs.mkdirSync(path.join(project, 'agentic/code/addons'), { recursive: true });
    }
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    await refreshFrameworkCapabilities(project, true, { force: true });
    expect(builder).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(getGraphIndexDir(project, 'framework'), 'capability-sources.json'))).toBe(false);
  });

  it('resolves a bundled addon directory to the owning runtime before rebuilding', async () => {
    copySkill('induct-research');
    const addon = path.join(root, 'agentic/code/addons/probe');
    fs.mkdirSync(addon, { recursive: true });
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    await refreshFrameworkCapabilities(addon);
    expect(builder).toHaveBeenCalledWith(root, expect.objectContaining({ graph: 'framework' }));
    expect(index().entries[induction]?.type).toBe('skill');
  });

  it('indexes all canonical research skills, including induction and quality audit', async () => {
    for (const name of fs.readdirSync(path.join(repo, research, 'skills'))) {
      if (fs.existsSync(path.join(repo, research, 'skills', name, 'SKILL.md'))) copySkill(name);
    }
    await buildIndex(root, { graph: 'framework', quiet: true });
    const entries = index().entries;
    for (const name of fs.readdirSync(path.join(root, research, 'skills'))) {
      expect(entries[`${research}/skills/${name}/SKILL.md`]?.type, name).toBe('skill');
    }
    expect(entries[induction].triggers).toContain('induct this paper');
    expect(entries[`${research}/skills/research-quality-audit/SKILL.md`].name).toBe('research-quality-audit');
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);
  });

  it('includes every canonical framework skill in a fresh runtime index', async () => {
    await buildIndex(repo, { graph: 'framework', quiet: true });
    const entries = loadGraphIndexFile<ArtifactIndex>(repo, 'metadata.json', 'framework')!.entries;
    const frameworks = 'agentic/code/frameworks';
    for (const framework of fs.readdirSync(path.join(repo, frameworks))) {
      const skills = path.join(frameworks, framework, 'skills');
      if (!fs.existsSync(path.join(repo, skills))) continue;
      for (const name of fs.readdirSync(path.join(repo, skills))) {
        const relative = `${skills}/${name}/SKILL.md`;
        if (fs.existsSync(path.join(repo, relative))) expect(entries[relative]?.type, relative).toBe('skill');
      }
    }
  });

  it.each(['local', 'fortemi-core'] as const)('repairs an existing incomplete index before show (%s)', async backend => {
    await buildIndex(root, { graph: 'framework', quiet: true });
    syncFortemiCoreIndex(root, { graph: 'framework' });
    expect(index().entries[induction]).toBeUndefined();
    copySkill('induct-research');
    log.mockClear();
    await showArtifact(project, { name: 'induct-research', typeFilter: ['skill'], backend, json: true });
    expect(json().content).toContain('# Induct Research');
    expect(json().uninstalled).not.toBe(true);
    expect(index().entries[induction]?.type).toBe('skill');
    if (backend === 'fortemi-core') {
      expect(loadFortemiCoreMetadataEntries(project, 'framework').entries.some(e => e.name === 'induct-research')).toBe(true);
      expect(getFortemiCoreSyncStatus(project, 'framework').stale).toBe(false);
    }
  });

  it.each(['local', 'fortemi-core'] as const)('refreshes before discovery and ranks natural phrases in top three (%s)', async backend => {
    await buildIndex(root, { graph: 'framework', quiet: true });
    syncFortemiCoreIndex(root, { graph: 'framework' });
    copySkill('induct-research');
    copySkill('research-quality-audit');
    for (const phrase of ['induct this paper', 'induct a research paper', 'add a paper to the corpus', 'research-quality-audit']) {
      log.mockClear();
      await discoverCapability(project, { phrase, backend, json: true, limit: 3 });
      const names = json().results.map((result: any) => result.name);
      expect(names).toContain(phrase === 'research-quality-audit' ? phrase : 'induct-research');
      if (phrase === 'induct this paper') expect(names[0]).toBe('induct-research');
    }
  });

  it.each(['research', 'research-complete', 'all', 'absent'])('checks configured installation separately from selected index (%s)', async installed => {
    copySkill('induct-research');
    const control = path.join(project, '.aiwg');
    fs.mkdirSync(control, { recursive: true });
    fs.writeFileSync(path.join(control, 'aiwg.config'), JSON.stringify({
      installed: installed === 'absent' ? {} : { [installed]: { deployedTo: { claude: { skills: 29 } } } },
    }));
    fs.writeFileSync(path.join(control, 'note.md'), '# Project note');
    await buildIndex(project, { graph: 'project', quiet: true });
    log.mockClear();
    await showArtifact(project, { name: 'induct-research', typeFilter: ['skill'], graph: 'project', backend: 'local', json: true });
    expect(json().uninstalled).toBe(installed === 'absent');
    if (installed !== 'absent') expect(json().hint).not.toContain('aiwg use');
    await showArtifact(project, { name: 'induct-research', typeFilter: ['skill'], graph: 'project', backend: 'local' });
    const text = stdout.mock.calls.map(call => String(call[0])).join('');
    expect(text.includes('corpus-only')).toBe(installed === 'absent');
  });

  it.each(['local', 'fortemi-core'] as const)('keeps warm show/discover out of the builder (%s)', async backend => {
    copySkill('induct-research');
    await refreshFrameworkCapabilities(root);
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    const status = vi.spyOn(fortemiSync, 'getFortemiCoreSyncStatus');
    for (let run = 0; run < 3; run++) {
      await showArtifact(project, { name: 'induct-research', typeFilter: ['skill'], backend, json: true });
      await discoverCapability(project, { phrase: 'induct this paper', backend, json: true });
    }
    expect(builder).not.toHaveBeenCalled();
    // Query adapters retain their own validation; reconciliation must not add any.
    expect(status.mock.calls.filter(([cwd]) => cwd === root)).toHaveLength(0);
  });

  it('uses only shallow manifest reads and stat checks on an unchanged receipt', async () => {
    await refreshFrameworkCapabilities(root);
    const read = vi.spyOn(fs, 'readFileSync');
    const list = vi.spyOn(fs, 'readdirSync');
    await refreshFrameworkCapabilities(root);
    expect(read.mock.calls.some(([file]) => /metadata\.json|aiwg-fortemi-index/.test(String(file)))).toBe(false);
    expect(list.mock.calls.map(([dir]) => String(dir))).toEqual([
      path.join(root, 'agentic/code/frameworks'),
      path.join(root, 'agentic/code/addons'),
      path.join(root, 'agentic/code/extensions'),
      path.join(root, 'agentic/code/agents'),
      path.join(root, 'agentic/code/behaviors'),
    ]);
  });

  it('serializes concurrent cold starts into one rebuild', async () => {
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    await Promise.all(Array.from({ length: 4 }, () => refreshFrameworkCapabilities(root)));
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('rebuilds exactly once for a changed manifest across concurrent callers', async () => {
    await refreshFrameworkCapabilities(root);
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    const sync = vi.spyOn(fortemiSync, 'syncFortemiCoreIndex');
    copySkill('induct-research');
    write(`${research}/manifest.json`, JSON.stringify({ id: 'research-complete', version: 'changed' }));
    await Promise.all(Array.from({ length: 4 }, () => refreshFrameworkCapabilities(root)));
    expect(builder).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(index().entries[induction]?.type).toBe('skill');
    await refreshFrameworkCapabilities(root);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('serves the existing index briefly under contention and retries after release', async () => {
    await refreshFrameworkCapabilities(root);
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    write(`${research}/manifest.json`, '{"id":"changed"}');
    const release = await acquireDirectoryLock(path.join(getGraphIndexDir(root, 'framework'), 'capability-refresh.lock'));
    try {
      await refreshFrameworkCapabilities(root);
      expect(builder).not.toHaveBeenCalled();
    } finally { await release(); }
    await refreshFrameworkCapabilities(root);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('recovers a dead builder and retries a failed rebuild without advancing the receipt', async () => {
    await refreshFrameworkCapabilities(root);
    const dir = getGraphIndexDir(root, 'framework');
    const receipt = fs.readFileSync(path.join(dir, 'capability-sources.json'), 'utf8');
    const lock = path.join(dir, 'capability-refresh.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `2147483647:abandoned:${hostname()}\n`);
    write(`${research}/manifest.json`, '{"id":"changed"}');
    const builder = vi.spyOn(indexBuilder, 'buildIndex').mockRejectedValueOnce(new Error('build failed'));
    await expect(refreshFrameworkCapabilities(root)).rejects.toThrow('build failed');
    expect(fs.readFileSync(path.join(dir, 'capability-sources.json'), 'utf8')).toBe(receipt);
    await refreshFrameworkCapabilities(root);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it('invalidates receipts for runtime version, worktree HEAD, and manual index changes', async () => {
    write('package.json', '{"name":"aiwg","version":"1.0.0"}');
    write('.git', 'gitdir: git-worktree');
    write('git-worktree/HEAD', 'ref: refs/heads/main');
    write('git-worktree/commondir', '../git-common');
    write('git-common/packed-refs', 'aaaa refs/heads/main\n');
    await refreshFrameworkCapabilities(root, false);
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    write('package.json', '{"name":"aiwg","version":"1.0.1"}');
    await refreshFrameworkCapabilities(root, false);
    write('git-common/refs/heads/main', 'bbbb');
    await refreshFrameworkCapabilities(root, false);
    fs.appendFileSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'), ' ');
    await refreshFrameworkCapabilities(root, false);
    expect(builder).toHaveBeenCalledTimes(3);
  });

  it('repairs only a stale Fortemi cache without rebuilding unchanged sources', async () => {
    await refreshFrameworkCapabilities(root);
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    const sync = vi.spyOn(fortemiSync, 'syncFortemiCoreIndex');
    fs.unlinkSync(getFortemiCoreSyncStatus(root, 'framework').exportPath);
    await refreshFrameworkCapabilities(root);
    expect(builder).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('refreshes the derived cache after a runtime update and preserves unchanged cache generation', async () => {
    await refreshFrameworkCapabilities(root);
    const before = getFortemiCoreSyncStatus(project, 'framework');
    copySkill('induct-research');
    write('agentic/code/frameworks/another/skills/new-capability/SKILL.md', '---\nname: new-capability\n---\n# New Capability\n');
    await refreshFrameworkCapabilities(root, true, { force: true });
    const loaded = loadFortemiCoreMetadataEntries(project, 'framework');
    expect(loaded.reason).toBeUndefined();
    expect(loaded.entries.map(e => e.name)).toEqual(expect.arrayContaining(['induct-research', 'new-capability']));
    const after = getFortemiCoreSyncStatus(project, 'framework');
    expect(after.stale).toBe(false);
    expect(after.exportChecksum).not.toBe(before.exportChecksum);
    await refreshFrameworkCapabilities(root);
    expect(getFortemiCoreSyncStatus(project, 'framework').generatedAt).toBe(after.generatedAt);
  });
});

describe('root-isolated framework indexes (#3308)', () => {
  function secondRoot(): string {
    const other = path.join(tmp, 'edge');
    fs.cpSync(root, other, { recursive: true });
    fs.writeFileSync(path.join(other, `${research}/skills/corpus-health-audit/SKILL.md`),
      '---\nname: corpus-health-audit\ndescription: Audit paper corpus health.\n---\n# Edge health audit\n');
    return other;
  }

  it('keeps indexes, caches, receipts, and graph sidecars separate across alternating roots', async () => {
    const other = secondRoot();
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    const sync = vi.spyOn(fortemiSync, 'syncFortemiCoreIndex');
    const snapshots = new Map<string, string>();
    for (const selected of [root, other, root, other, root]) {
      vi.stubEnv('AIWG_ROOT', selected);
      await refreshFrameworkCapabilities(selected);
      const dir = getGraphIndexDir(project, 'framework');
      expect(dir).toBe(getGraphIndexDir(selected, 'framework'));
      const receipt = fs.readFileSync(path.join(dir, 'capability-sources.json'), 'utf8');
      if (snapshots.has(selected)) expect(receipt).toBe(snapshots.get(selected));
      else snapshots.set(selected, receipt);
      // Relationship and other graph sidecars use the graph directory too.
      fs.writeFileSync(path.join(dir, 'relationships.json'), JSON.stringify({ root: selected }));
      expect(loadGraphIndexFile(project, 'relationships.json', 'framework')).toEqual({ root: selected });
      expect(getFortemiCoreSyncStatus(project, 'framework').location).toContain(path.dirname(dir));
      log.mockClear();
      await showArtifact(project, { name: 'corpus-health-audit', typeFilter: ['skill'], backend: 'fortemi-core', json: true });
      expect(json().path).toBe(path.join(selected, `${research}/skills/corpus-health-audit/SKILL.md`));
      expect(json().content).toContain(selected === other ? 'Edge health audit' : 'Corpus Health Audit');
    }
    expect(builder).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(getGraphIndexDir(root, 'framework')).not.toBe(getGraphIndexDir(other, 'framework'));
    expect(loadGraphIndexFile(root, 'relationships.json', 'framework')).toEqual({ root });
  });

  it('canonicalizes symlinked roots and bundled subdirectories without another rebuild', async () => {
    const alias = path.join(tmp, 'runtime-alias');
    fs.symlinkSync(root, alias, 'dir');
    const bundle = path.join(alias, research);
    await refreshFrameworkCapabilities(root);
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    vi.stubEnv('AIWG_ROOT', alias);
    for (const candidate of [alias, bundle, project]) {
      expect(getGraphIndexDir(candidate, 'framework')).toBe(getGraphIndexDir(root, 'framework'));
      expect(getFortemiCoreSyncStatus(candidate, 'framework').location)
        .toBe(getFortemiCoreSyncStatus(root, 'framework').location);
      await refreshFrameworkCapabilities(candidate);
    }
    vi.stubEnv('AIWG_ROOT', bundle);
    expect(getGraphIndexDir(project, 'framework')).toBe(getGraphIndexDir(root, 'framework'));
    log.mockClear();
    await showArtifact(project, { name: 'corpus-health-audit', typeFilter: ['skill'], json: true });
    expect(json().path).toBe(path.join(root, `${research}/skills/corpus-health-audit/SKILL.md`));
    expect(builder).not.toHaveBeenCalled();
  });

  it('selects the executing package from a project without AIWG_ROOT and honors explicit corpus roots', async () => {
    vi.stubEnv('AIWG_ROOT', undefined);
    expect(getGraphIndexDir(project, 'framework')).toBe(getGraphIndexDir(repo, 'framework'));
    expect(getGraphIndexDir(root, 'framework')).not.toBe(getGraphIndexDir(project, 'framework'));
    const other = secondRoot();
    for (const selected of [root, other, root, other]) {
      log.mockClear();
      await showArtifact(selected, { name: 'corpus-health-audit', typeFilter: ['skill'], json: true });
      expect(json().path).toBe(path.join(selected, `${research}/skills/corpus-health-audit/SKILL.md`));
      log.mockClear();
      await discoverCapability(selected, { phrase: 'corpus health audit', json: true });
      expect(json().results).toHaveLength(1);
      expect(json().results[0].path).toBe(path.join(selected, `${research}/skills/corpus-health-audit/SKILL.md`));
    }
  });

  it('does not block another root on an existing root lock, even on a cold start', async () => {
    const other = secondRoot();
    const release = await acquireDirectoryLock(path.join(getGraphIndexDir(root, 'framework'), 'capability-refresh.lock'));
    try {
      await refreshFrameworkCapabilities(other);
      expect(loadGraphIndexFile<ArtifactIndex>(other, 'metadata.json', 'framework')?.entries).toBeDefined();
      expect(loadGraphIndexFile(root, 'metadata.json', 'framework')).toBeNull();
    } finally { await release(); }
  });

  it('migrates a legacy shared index once without reading or replacing its foreign paths', async () => {
    const legacy = path.join(process.env.XDG_DATA_HOME!, 'aiwg/index/framework');
    const legacyCache = path.join(process.env.XDG_DATA_HOME!, 'aiwg/index/fortemi-core/framework');
    for (const dir of [legacy, legacyCache]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'metadata.json'), '{"foreign":"/previous/root"}');
      fs.writeFileSync(path.join(dir, 'capability-sources.json'), '{"source":"legacy"}');
    }
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    const sync = vi.spyOn(fortemiSync, 'syncFortemiCoreIndex');
    for (let i = 0; i < 3; i++) {
      await refreshFrameworkCapabilities(root);
      await showArtifact(project, { name: 'corpus-health-audit', typeFilter: ['skill'], json: true });
      await discoverCapability(project, { phrase: 'corpus health audit', json: true });
    }
    expect(builder).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(legacy, 'metadata.json'), 'utf8')).toBe('{"foreign":"/previous/root"}');
    expect(fs.readFileSync(path.join(legacyCache, 'capability-sources.json'), 'utf8')).toBe('{"source":"legacy"}');
  });

  it('updates one root fingerprint without rebuilding the other root', async () => {
    const other = secondRoot();
    await Promise.all([refreshFrameworkCapabilities(root), refreshFrameworkCapabilities(other)]);
    const before = getGraphIndexDir(root, 'framework');
    const otherReceipt = fs.readFileSync(path.join(getGraphIndexDir(other, 'framework'), 'capability-sources.json'), 'utf8');
    const builder = vi.spyOn(indexBuilder, 'buildIndex');
    write('package.json', '{"name":"aiwg","version":"1.0.1"}');
    await refreshFrameworkCapabilities(root);
    await refreshFrameworkCapabilities(other);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(getGraphIndexDir(root, 'framework')).toBe(before);
    expect(fs.readFileSync(path.join(getGraphIndexDir(other, 'framework'), 'capability-sources.json'), 'utf8')).toBe(otherReceipt);
  });
});
