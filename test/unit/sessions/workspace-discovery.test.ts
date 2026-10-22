import { fork } from 'node:child_process';
import {
  copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../src/cli/handlers/sessions.js';
import {
  SessionRepository,
  CodexSessionAdapter,
  discoverWorkspaceHistories,
  importDiscoveryManifest,
  publicDiscoveryManifest,
  redactSourceLocator,
  importLeasePath,
  readDiscoveryManifest,
  sha256,
  writeDiscoveryManifest,
} from '../../../src/sessions/index.js';
import { itWithSqlite } from '../../helpers/sqlite.js';
import { writeMuseLog } from '../../helpers/muse-native.js';
import { createSessionWorktree } from '../../helpers/session-worktree.js';
import { claudeProjectKey } from '../../../src/sessions/workspace-discovery.js';
import { resolveImportLimits } from '../../../src/sessions/import-limits.js';
import * as readers from '../../../src/sessions/readers.js';
import { IncrementalSessionImporter } from '../../../src/sessions/importer.js';

const roots: string[] = [];

beforeEach(() => vi.stubEnv('CODEX_HOME', ''));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace session discovery and batch import', () => {
  it('maps Claude subfolder and worktree project keys through nearest workspace ownership', async () => {
    const fixture = await providerFixture();
    const subfolder = join(fixture.workspace, 'subfolder');
    const nested = join(fixture.workspace, 'nested');
    const worktree = join(fixture.root, 'linked-worktree');
    await mkdir(subfolder);
    await mkdir(join(nested, '.aiwg/sessions'), { recursive: true });
    await createSessionWorktree(fixture.workspace, worktree);
    const mappings = [subfolder, worktree, nested, join(fixture.root, 'unrelated')];
    const locators = [];
    for (const cwd of mappings) {
      const project = join(fixture.providerHome, '.claude/projects', claudeProjectKey(cwd));
      await mkdir(project, { recursive: true });
      const locator = join(project, 'session.jsonl');
      await writeFile(locator, JSON.stringify({ type: 'user', cwd, sessionId: cwd,
        uuid: cwd, message: { role: 'user', content: 'safe fixture' } }) + '\n');
      locators.push(locator);
    }
    const manifest = await discoverWorkspaceHistories({ workspace: fixture.workspace,
      providerHome: fixture.providerHome, expectedProviders: ['claude'] });
    expect(manifest.sources.map(source => source.locator).sort())
      .toEqual([join(fixture.providerHome, '.claude/projects', claudeProjectKey(fixture.workspace), 'claude.jsonl'),
        ...locators.slice(0, 2)].sort());
    expect(manifest.providers[0]).toMatchObject({ matchedBySubfolder: 1, matchedByWorktree: 1 });
  });

  itWithSqlite('rebuilds from a saved manifest and read-only catalog after a source disappears', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({ workspace: fixture.workspace,
      providerHome: fixture.providerHome, expectedProviders: ['claude', 'codex'] });
    const manifestPath = join(fixture.root, 'saved-manifest.json');
    await writeDiscoveryManifest(manifestPath, manifest);
    const oldPath = join(fixture.root, 'old.sqlite');
    const newPath = join(fixture.root, 'new.sqlite');
    const old = new SessionRepository(oldPath);
    await importDiscoveryManifest({ repository: old, manifest });
    const before = old.listSessions({ workspaceId: fixture.workspace, limit: 100 });
    const checkpoints = new Map(manifest.sources.map(source => [source.sourceId, old.getCheckpoint(source.sourceId, '1.0.0')]));
    old.close();
    const claude = manifest.sources.find(source => source.provider === 'claude')!;
    await rm(claude.locator);
    const oldBytes = await readFile(oldPath);
    const ctx = { cwd: fixture.workspace, rawArgs: [], frameworkRoot: fixture.root };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (let iteration = 0; iteration < 2; iteration++) {
      const result = await sessionsHandler.execute({ ...ctx, args: ['import-discovered', '--workspace', fixture.workspace,
        '--manifest', manifestPath, '--carry-forward', oldPath, '--db', newPath, '--confirm', '--json'] } as any);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(envelope.data.receipt.carryForward.byProvider).toMatchObject({
        claude: { carried: 1, reimported: 0, droppedAsDuplicate: 0, excluded: 0 },
        codex: { carried: 0, reimported: 1, droppedAsDuplicate: 0, excluded: 0 },
      });
      const rebuilt = new SessionRepository(newPath);
      try {
        expect(rebuilt.listSessions({ workspaceId: fixture.workspace, limit: 100 }).total).toBe(before.total);
        expect(rebuilt.getBatchImportRun(envelope.data.receipt.run.runId)?.carryForward)
          .toEqual(envelope.data.receipt.carryForward);
        const onDisk = manifest.sources.find(source => source.provider === 'codex')!;
        expect(rebuilt.getCheckpoint(onDisk.sourceId, '1.0.0')).toEqual(checkpoints.get(onDisk.sourceId));
      } finally { rebuilt.close(); }
    }
    const refused = await sessionsHandler.execute({ ...ctx, args: ['import-discovered', '--workspace', fixture.workspace,
      '--manifest', manifestPath, '--carry-forward', oldPath, '--db', oldPath, '--dry-run', '--json'] });
    expect(refused.exitCode).toBe(2);
    log.mockRestore();
    expect(await readFile(oldPath)).toEqual(oldBytes);
  });

  itWithSqlite('retains three large sessions, rereads changed sources, and excludes Lane B before reads', async () => {
    const fixture = await providerFixture();
    const sessions = join(fixture.root, 'large-sources');
    await mkdir(sessions);
    const ids = ['large-a', 'large-b', 'large-c', 'lane-b'];
    for (const id of ids) {
      await writeFile(join(sessions, `${id}.jsonl`), [
        JSON.stringify({ type: 'session_meta', payload: { id, cwd: fixture.workspace } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'safe history '.repeat(30_000) }] } }),
      ].join('\n') + '\n');
    }
    const manifest = await discoverWorkspaceHistories({ workspace: fixture.workspace,
      codexRoot: sessions, expectedProviders: ['codex'] });
    const previous = new SessionRepository();
    const rebuilt = new SessionRepository();
    const limited = new SessionRepository();
    try {
      await importDiscoveryManifest({ manifest, repository: previous });
      await rm(join(sessions, 'large-c.jsonl'));
      await writeFile(join(sessions, 'lane-b.jsonl'), 'invalid synthetic excluded content');
      const changed = join(sessions, 'large-a.jsonl');
      await writeFile(changed, await readFile(changed, 'utf8') + JSON.stringify({ type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'current-source-marker' }] } }) + '\n');
      const receipt = await importDiscoveryManifest({ manifest, repository: rebuilt,
        carryForward: previous, exclude: ['lane-b'] });
      expect(receipt.carryForward?.byProvider.codex).toEqual({
        reimported: 2, carried: 1, droppedAsDuplicate: 0, excluded: 1,
      });
      expect(receipt.totals.sessionsAccepted).toBe(3);
      expect(rebuilt.listSessions({ workspaceId: fixture.workspace, limit: 20 }).items
        .map(session => session.nativeSessionId).sort()).toEqual(ids.slice(0, 3));
      expect(rebuilt.search({ workspaceId: fixture.workspace, query: '"current-source-marker"', limit: 20 }).items).toHaveLength(1);
      const rejected = await importDiscoveryManifest({ manifest, repository: limited,
        carryForward: previous, exclude: ['lane-b'], limits: { maxRecordBytes: 1024 } });
      expect(rejected.totals.rejected).toBe(2);
      expect(limited.listSessions({ workspaceId: fixture.workspace, limit: 20 }).items
        .map(session => session.nativeSessionId)).toEqual(['large-c']);
    } finally { previous.close(); rebuilt.close(); limited.close(); }
  });

  itWithSqlite('excludes Codex IDs and globs before discovery reads and reports excluded counts in batch receipts', async () => {
    const fixture = await providerFixture();
    const authorized = join(fixture.root, 'excluded');
    const id = '12345678-1234-1234-1234-123456789abc';
    await mkdir(authorized);
    await writeFile(join(authorized, `rollout-2026-10-18T10-02-00-${id}.jsonl`), 'invalid synthetic data');
    await writeFile(join(authorized, 'other.jsonl'), 'invalid synthetic data');
    const exclude = [id, join(authorized, 'oth?r.*')];
    const stream = vi.spyOn(readers, 'streamJsonLines');
    const fingerprint = vi.spyOn(readers, 'fingerprintSourceFile');
    const inspect = vi.spyOn(CodexSessionAdapter.prototype, 'inspect');
    const repository = new SessionRepository(':memory:');
    try {
      const manifest = await discoverWorkspaceHistories({
        workspace: fixture.workspace, codexRoot: authorized, expectedProviders: ['codex'], exclude,
      });
      expect(manifest.sources).toHaveLength(2);
      expect(manifest.sources.map(source => source.status)).toEqual(['excluded', 'excluded']);
      expect(publicDiscoveryManifest(manifest)).toMatchObject({ totals: { excluded: 2 } });
      const file = join(fixture.root, 'manifest.json');
      await writeDiscoveryManifest(file, manifest);
      expect(await readDiscoveryManifest(file)).toEqual(manifest);
      const receipt = await importDiscoveryManifest({ manifest, repository });
      expect(receipt).toMatchObject({ run: { status: 'complete' },
        totals: { excluded: 2, rejected: 0, pending: 0, accepted: 0 },
        coverage: { acquisitionStatus: 'complete', rejectionCounts: {}, sources: { excluded: 2 } } });
      expect(receipt.run.sources.map(source => source.exclusion?.kind).sort()).toEqual(['path-glob', 'session-id']);
      expect(stream).not.toHaveBeenCalled();
      expect(fingerprint).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(repository.listSessions({ workspaceId: fixture.workspace, limit: 10 }).total).toBe(0);
    } finally { stream.mockRestore(); fingerprint.mockRestore(); inspect.mockRestore(); repository.close(); }
  });

  itWithSqlite('changes a previously rejected source to excluded before any import reads', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    const repository = new SessionRepository(':memory:');
    try {
      const rejected = await importDiscoveryManifest({ manifest, repository, limits: { maxTotalBytes: 1 } });
      expect(rejected.totals.rejected).toBe(1);
      const fingerprint = vi.spyOn(readers, 'fingerprintSourceFile');
      try {
        const receipt = await importDiscoveryManifest({ manifest, repository, exclude: [manifest.sources[0].nativeSessionId!] });
        expect(receipt).toMatchObject({ run: { status: 'complete' }, totals: { excluded: 1, rejected: 0, pending: 0 } });
        expect(receipt.run.sources[0]).toMatchObject({ status: 'excluded', errorCode: null, detail: null,
          exclusion: { entry: manifest.sources[0].nativeSessionId, kind: 'session-id' } });
        expect(repository.getBatchImportRun(receipt.run.runId)?.sources[0].status).toBe('excluded');
        expect(fingerprint).not.toHaveBeenCalled();
      } finally { fingerprint.mockRestore(); }
    } finally { repository.close(); }
  });

  it('uses previously discovered session_meta IDs before reading renamed Codex rollouts on refresh', async () => {
    const fixture = await providerFixture();
    const options = { workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'] };
    const prior = await discoverWorkspaceHistories(options);
    const source = prior.sources[0];
    await writeFile(source.locator, 'invalid synthetic data');
    const stream = vi.spyOn(readers, 'streamJsonLines');
    const fingerprint = vi.spyOn(readers, 'fingerprintSourceFile');
    try {
      const manifest = await discoverWorkspaceHistories({ ...options,
        authorizedRoots: { codex: [source.authorizedRoot] }, knownSources: prior.sources,
        exclude: [source.nativeSessionId!, join(source.authorizedRoot, '**/unrelated.jsonl')],
      });
      expect(manifest.sources.find(candidate => candidate.locator === source.locator))
        .toMatchObject({ status: 'excluded', nativeSessionId: source.nativeSessionId });
      expect(stream).not.toHaveBeenCalled();
      expect(fingerprint).not.toHaveBeenCalled();
    } finally { stream.mockRestore(); fingerprint.mockRestore(); }
  });

  itWithSqlite.each(['config', 'env'] as const)('passes %s limits through batch adapters and importers', async (origin) => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    const repository = new SessionRepository(':memory:');
    const importer = vi.spyOn(IncrementalSessionImporter.prototype, 'import');
    try {
      for (const setting of ['max_record_bytes', 'max_source_bytes'] as const) {
        if (origin === 'env') vi.stubEnv(`AIWG_SESSIONS_IMPORT_${setting.toUpperCase()}`, '1');
        const receipt = await importDiscoveryManifest({ manifest, repository,
          limits: origin === 'config' ? resolveImportLimits({ [setting]: 1 }) : undefined });
        expect(receipt.totals.rejected).toBe(1);
        expect(receipt.run.sources[0].detail).toMatchObject({
          setting: `sessions.import.${setting}`, configured: 1, origin,
        });
        expect(repository.getBatchImportRun(receipt.run.runId)?.sources[0].detail)
          .toEqual(receipt.run.sources[0].detail);
        vi.unstubAllEnvs();
      }
      if (origin === 'env') {
        vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', '65536');
        vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', '131072');
      }
      const expected = { maxRecordBytes: 65536, maxTotalBytes: 131072,
        limitOrigins: { maxRecordBytes: origin, maxTotalBytes: origin } };
      const receipt = await importDiscoveryManifest({ manifest, repository,
        limits: origin === 'config'
          ? resolveImportLimits({ max_record_bytes: 65536, max_source_bytes: 131072 }) : undefined });
      expect(receipt.totals.accepted).toBe(1);
      expect(importer).toHaveBeenCalledWith(expect.objectContaining({ limits: expected }));
    } finally { importer.mockRestore(); repository.close(); }
  });

  it('matches Codex workspace metadata with raw U+2028 and U+2029 and deduplicates rollout IDs', async () => {
    const fixture = await providerFixture('workspace\u2028a\u2029b');
    const first = join(fixture.root, 'first');
    const second = join(fixture.root, 'second');
    await writeCodexRollout(first, fixture.workspace, 'shared');
    await writeCodexRollout(second, fixture.workspace, 'shared', 'copy.jsonl');
    await writeFile(join(second, 'copy.jsonl'), '\r\n', { flag: 'a' });
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, codexRoots: [first, second], expectedProviders: ['codex'],
    });
    expect(manifest.sources.map((source) => source.locator)).toEqual([join(first, 'shared.jsonl')]);
    expect(manifest.providers[0].rootCounts?.reduce((sum, root) => sum + root.duplicateCount, 0)).toBe(1);
  });

  it('uses Claude cwd with raw U+2028 and U+2029 to reject a colliding project folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-claude-unicode-'));
    roots.push(root);
    const workspace = join(root, 'site\u2028a\u2029b');
    const otherWorkspace = join(root, 'site-a-b');
    const providerHome = join(root, 'home');
    const project = join(providerHome, '.claude/projects', claudeProjectKey(workspace));
    expect(claudeProjectKey(workspace)).toBe(claudeProjectKey(otherWorkspace));
    await Promise.all([workspace, otherWorkspace, project].map((path) => mkdir(path, { recursive: true })));
    const matching = join(project, 'matching.jsonl');
    await writeFile(matching, JSON.stringify({ type: 'user', cwd: workspace }) + '\r\n');
    await writeFile(join(project, 'other.jsonl'), JSON.stringify({
      type: 'user', cwd: otherWorkspace, text: 'a\u2028b\u2029c',
    }) + '\n');
    const manifest = await discoverWorkspaceHistories({
      workspace, providerHome, expectedProviders: ['claude'],
    });
    expect(manifest.sources.map((source) => source.locator)).toEqual([matching]);
  });

  it.each(['claude', 'cursor', 'factory', 'pi'] as const)(
    'discovers %s sessions under canonical and logical project keys with one workspace identity',
    async (provider) => {
      const fixture = await providerFixture();
      vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(fixture.providerHome, '.pi/agent/sessions'));
      const alias = join(fixture.root, 'logical');
      await symlink(fixture.workspace, alias);
      const providerRoot = (workspace: string): string => {
        const key = workspace.replace(/\\/g, '/').replace(/[/:]+/g, '-');
        const keyWithoutLeadingDash = key.replace(/^-/, '');
        if (provider === 'claude') return join(fixture.providerHome, '.claude/projects', claudeProjectKey(workspace));
        if (provider === 'cursor') return join(fixture.providerHome, '.cursor/projects', keyWithoutLeadingDash, 'agent-transcripts');
        if (provider === 'factory') return join(fixture.providerHome, '.factory/sessions', key);
        return join(fixture.providerHome, '.pi/agent/sessions', `--${keyWithoutLeadingDash}--`);
      };
      const canonicalRoot = providerRoot(fixture.workspace);
      const logicalRoot = providerRoot(alias);
      await mkdir(canonicalRoot, { recursive: true });
      await mkdir(logicalRoot, { recursive: true });
      const record = JSON.stringify({ type: 'user', sessionId: 'logical', cwd: alias });
      await writeFile(join(logicalRoot, 'logical.jsonl'), record + '\n');
      // Identical sources across the two keys still represent one source.
      await writeFile(join(canonicalRoot, 'duplicate.jsonl'), record + '\n');
      await writeFile(join(canonicalRoot, 'canonical.jsonl'), JSON.stringify({ type: 'user', sessionId: 'canonical', cwd: fixture.workspace }) + '\n');
      if (provider === 'claude') {
        await writeFile(join(logicalRoot, 'unrelated.jsonl'), JSON.stringify({ type: 'user', cwd: fixture.root }) + '\n');
      }
      const options = { providerHome: fixture.providerHome, expectedProviders: [provider] };
      const direct = await discoverWorkspaceHistories({ ...options, workspace: alias });
      const explicit = await discoverWorkspaceHistories({ ...options, workspace: fixture.workspace, workspaceAliases: [alias, alias] });
      // Existing fixtures contribute one additional source except for Pi.
      expect(direct.sources).toHaveLength(provider === 'pi' ? 2 : 3);
      expect(direct.workspaceId).toBe(fixture.workspace);
      expect(direct.workspacePath).toBe(fixture.workspace);
      expect(explicit.manifestId).toBe(direct.manifestId);
      expect(direct.authorizedRoots?.[provider]).toEqual(expect.arrayContaining([canonicalRoot, logicalRoot]));
      const restricted = await discoverWorkspaceHistories({
        ...options, workspace: alias, authorizedRoots: { [provider]: [canonicalRoot] },
      });
      expect(restricted.authorizedRoots?.[provider]).toEqual([canonicalRoot]);
      expect(restricted.sources.every(source => source.authorizedRoot === canonicalRoot)).toBe(true);
    },
  );

  it('rejects aliases that resolve to a different workspace', async () => {
    const fixture = await providerFixture();
    await expect(discoverWorkspaceHistories({
      workspace: fixture.workspace, workspaceAliases: [fixture.root], expectedProviders: ['claude'],
    })).rejects.toThrow('workspace alias resolves to a different workspace');
  });

  it('deduplicates canonical and logical project keys that share a provider directory', async () => {
    const fixture = await providerFixture();
    const alias = join(fixture.root, 'logical');
    await symlink(fixture.workspace, alias);
    const projects = join(fixture.providerHome, '.claude/projects');
    const canonicalRoot = join(projects, claudeProjectKey(fixture.workspace));
    await symlink(canonicalRoot, join(projects, claudeProjectKey(alias)));
    const manifest = await discoverWorkspaceHistories({
      workspace: alias, providerHome: fixture.providerHome, expectedProviders: ['claude'],
    });
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.authorizedRoots).toEqual({ claude: [canonicalRoot] });
  });

  it.each(['codex', 'muse', 'omp'] as const)(
    'discovers %s exact, subfolder, symlink, and worktree sessions without sibling-prefix matches',
    async (provider) => {
      const root = await mkdtemp(join(tmpdir(), 'session-matching-discovery-'));
      roots.push(root);
      const workspace = join(root, 'foo');
      const subfolder = join(workspace, 'sub');
      const sibling = join(root, 'foobar');
      const alias = join(root, 'alias');
      const worktree = join(root, 'worktree');
      const sessions = join(root, 'sessions');
      await Promise.all([subfolder, sibling, sessions].map((path) => mkdir(path, { recursive: true })));
      await createSessionWorktree(workspace, worktree);
      await mkdir(join(worktree, 'sub'));
      await symlink(workspace, alias);
      await symlink(sibling, join(workspace, 'escape'));
      const paths = [workspace, subfolder, join(alias, 'sub'), worktree, join(worktree, 'sub'), sibling, join(workspace, 'escape')];
      const locators = await Promise.all(paths.map((cwd, index) =>
        writeMatchingSession(provider, sessions, `session-${index}`, cwd)));
      // Counts describe selected sources, after content deduplication.
      const duplicate = provider === 'muse'
        ? await writeMuseLog(sessions, 'duplicate', 1) : join(sessions, 'duplicate.jsonl');
      await copyFile(locators[1], duplicate);
      const manifest = await discoverWorkspaceHistories({
        workspace, expectedProviders: [provider],
        codexRoot: sessions, museRoot: sessions, ompRoot: sessions,
      });
      expect(manifest.sources).toHaveLength(5);
      expect(manifest.providers[0]).toMatchObject({
        sourceCount: 5, matchedBySubfolder: 2, matchedByWorktree: 2,
      });
      expect(publicDiscoveryManifest(manifest).totals).toMatchObject({
        sources: 5, matchedBySubfolder: 2, matchedByWorktree: 2,
      });
      const path = join(root, 'manifest.json');
      await writeDiscoveryManifest(path, manifest);
      expect(await readDiscoveryManifest(path)).toEqual(manifest);
      manifest.providers[0].matchedByWorktree = 3;
      await writeDiscoveryManifest(path, manifest);
      await expect(readDiscoveryManifest(path)).rejects.toThrow('identity');
    },
  );

  it.each(['codex', 'muse', 'omp'] as const)(
    'assigns %s sessions only to the deepest enclosing catalog',
    async (provider) => {
      const root = await mkdtemp(join(tmpdir(), 'session-nearest-discovery-'));
      roots.push(root);
      const workspace = join(root, 'workspace');
      const nested = join(workspace, 'nested');
      const cwd = join(nested, 'sub');
      const sessions = join(root, 'sessions');
      for (const path of [workspace, nested]) {
        await mkdir(join(path, '.aiwg', 'sessions'), { recursive: true });
      }
      await mkdir(cwd);
      await mkdir(sessions);
      await writeMatchingSession(provider, sessions, 'nested-session', cwd);
      const options = { expectedProviders: [provider], codexRoot: sessions, museRoot: sessions, ompRoot: sessions };
      const parent = await discoverWorkspaceHistories({ ...options, workspace });
      const child = await discoverWorkspaceHistories({ ...options, workspace: nested });
      expect(parent.sources).toHaveLength(0);
      expect(parent.providers[0]).toMatchObject({ matchedBySubfolder: 0, matchedByWorktree: 0 });
      expect(child.sources).toHaveLength(1);
      expect(child.providers[0]).toMatchObject({ matchedBySubfolder: 1, matchedByWorktree: 0 });
    },
  );

  itWithSqlite.each(['codex', 'muse', 'omp'] as const)(
    'imports %s subfolder and external worktree sessions into the selected workspace',
    async (provider) => {
      const root = await mkdtemp(join(tmpdir(), 'session-workspace-import-'));
      roots.push(root);
      const workspace = join(root, 'workspace');
      const subfolder = join(workspace, 'sub');
      const worktree = join(root, 'worktree');
      const sessions = join(root, 'sessions');
      await mkdir(subfolder, { recursive: true });
      await mkdir(sessions);
      await createSessionWorktree(workspace, worktree);
      await writeMatchingSession(provider, sessions, 'subfolder-session', subfolder);
      await writeMatchingSession(provider, sessions, 'worktree-session', worktree);
      const manifest = await discoverWorkspaceHistories({
        workspace, expectedProviders: [provider],
        codexRoot: sessions, museRoot: sessions, ompRoot: sessions,
      });
      const repository = new SessionRepository(':memory:');
      try {
        const receipt = await importDiscoveryManifest({ manifest, repository });
        expect(receipt.totals).toMatchObject({ discovered: 2, accepted: 2, rejected: 0 });
        const imported = repository.listSessions({ workspaceId: manifest.workspaceId, limit: 20 });
        expect(imported.total).toBe(2);
        expect(imported.items.map((session) => session.nativeSessionId).sort())
          .toEqual(['subfolder-session', 'worktree-session']);
      } finally {
        repository.close();
      }
    },
  );

  it('discovers default, role-profile and CODEX_HOME roots with per-root counts', async () => {
    const fixture = await providerFixture();
    const roleRoot = join(fixture.providerHome, '.codex/roles-runtime/full/.codex/sessions');
    const emptyRoot = join(fixture.providerHome, '.codex/roles-runtime/empty/.codex/sessions');
    const missingRoot = join(fixture.providerHome, '.codex/roles-runtime/missing/.codex/sessions');
    const runtimeHome = join(fixture.root, 'runtime-codex');
    await writeCodexRollout(roleRoot, fixture.workspace, 'role');
    await writeCodexRollout(join(runtimeHome, 'sessions'), fixture.workspace, 'runtime');
    await mkdir(emptyRoot, { recursive: true });
    await mkdir(resolve(missingRoot, '..'), { recursive: true });
    vi.stubEnv('CODEX_HOME', runtimeHome);

    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    expect(manifest.sources).toHaveLength(3);
    expect(manifest.authorizedRoots?.codex).toEqual(expect.arrayContaining([roleRoot, emptyRoot, join(runtimeHome, 'sessions')]));
    expect(manifest.providers[0].rootCounts).toEqual(expect.arrayContaining([
      { ...rootIdentity(roleRoot), status: 'checked', sourceCount: 1, duplicateCount: 0 },
      { ...rootIdentity(join(runtimeHome, 'sessions')), status: 'checked', sourceCount: 1, duplicateCount: 0 },
      { ...rootIdentity(emptyRoot), status: 'checked', sourceCount: 0, duplicateCount: 0 },
      { ...rootIdentity(missingRoot), status: 'unavailable', sourceCount: 0, duplicateCount: 0 },
    ]));
    const output = publicDiscoveryManifest(manifest);
    expect(JSON.stringify(output.providers)).not.toContain(fixture.providerHome);
    expect(JSON.stringify(manifest.providers)).not.toContain(fixture.providerHome);
    expect(new Set(manifest.providers[0].rootCounts?.map((root) => root.rootId)).size).toBe(5);
    expect((output.providers as Array<{ rootCounts: unknown[] }>)[0].rootCounts).toHaveLength(5);
    const path = join(fixture.workspace, 'manifest.json');
    await writeDiscoveryManifest(path, manifest);
    await expect(readDiscoveryManifest(path)).resolves.toEqual(manifest);
    const altered = JSON.parse(await readFile(path, 'utf8'));
    altered.providers[0].rootCounts[0].sourceCount += 1;
    await writeFile(path, JSON.stringify(altered));
    await expect(readDiscoveryManifest(path)).rejects.toThrow('identity does not match');
  });

  it('keeps automatic Codex roots behind provider-home authorization', async () => {
    const fixture = await providerFixture();
    vi.stubEnv('CODEX_HOME', join(fixture.providerHome, '.codex'));
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, operatorHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    expect(manifest.sources).toEqual([]);
    expect(manifest.providers[0]).toMatchObject({
      reasonCode: 'SHARED_ROOT_AUTHORIZATION_REQUIRED', rootCounts: [],
    });
  });

  it('finds a role-only store once when CODEX_HOME names the same home', async () => {
    const fixture = await providerFixture();
    await rm(join(fixture.providerHome, '.codex/sessions'), { recursive: true });
    const roleHome = join(fixture.providerHome, '.codex/roles-runtime/full/.codex');
    await writeCodexRollout(join(roleHome, 'sessions'), fixture.workspace, 'role-only');
    vi.stubEnv('CODEX_HOME', roleHome);
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.authorizedRoots?.codex).toEqual([join(roleHome, 'sessions')]);
    expect(manifest.providers[0].rootCounts).toEqual([
      { ...rootIdentity(join(fixture.providerHome, '.codex/sessions')), status: 'unavailable', sourceCount: 0, duplicateCount: 0 },
      { ...rootIdentity(join(roleHome, 'sessions')), status: 'checked', sourceCount: 1, duplicateCount: 0 },
    ]);
  });

  it('reports zero per-root counts when every explicit Codex root is missing', async () => {
    const fixture = await providerFixture();
    const missing = join(fixture.root, 'missing');
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, codexRoots: [missing], expectedProviders: ['codex'],
    });
    expect(manifest.providers[0]).toMatchObject({
      status: 'unavailable', reasonCode: 'PROVIDER_ROOT_UNAVAILABLE',
      rootCounts: [{ ...rootIdentity(missing), status: 'unavailable', sourceCount: 0, duplicateCount: 0 }],
    });
  });

  it('deduplicates rollout IDs across explicit roots and canonical root aliases', async () => {
    const fixture = await providerFixture();
    const first = join(fixture.root, 'a');
    const second = join(fixture.root, 'b');
    const alias = join(fixture.root, 'alias');
    await writeCodexRollout(first, fixture.workspace, 'shared');
    await writeCodexRollout(second, fixture.workspace, 'shared', 'different-copy.jsonl');
    await writeFile(join(second, 'different-copy.jsonl'), '\n', { flag: 'a' });
    await writeCodexRollout(second, fixture.workspace, 'unique');
    await writeCodexRollout(second, join(fixture.root, 'other'), 'unrelated');
    await symlink(first, alias);
    vi.stubEnv('CODEX_HOME', join(fixture.providerHome, '.codex'));
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
      codexRoots: [first, second, alias, first],
    });
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.authorizedRoots?.codex).toEqual([first, second]);
    expect(manifest.providers[0].rootCounts).toEqual([
      { ...rootIdentity(first), status: 'checked', sourceCount: 1, duplicateCount: 0 },
      { ...rootIdentity(second), status: 'checked', sourceCount: 1, duplicateCount: 1 },
    ]);
  });

  it('deduplicates rollout filename IDs and retains digest fallback for unidentified exports', async () => {
    const fixture = await providerFixture();
    const first = join(fixture.root, 'a');
    const second = join(fixture.root, 'b');
    const id = '00000000-0000-4000-8000-000000000325';
    const record = JSON.stringify({ type: 'turn_context', payload: { cwd: fixture.workspace } });
    await Promise.all([first, second].map((root) => mkdir(root)));
    await writeFile(join(first, `rollout-${id}.jsonl`), record + '\n');
    await writeFile(join(second, `copy-${id}.jsonl`), record + '\n\n');
    await writeFile(join(first, 'export.jsonl'), record + '\n\n\n');
    await writeFile(join(second, 'export.jsonl'), record + '\n\n\n');
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, codexRoots: [first, second], expectedProviders: ['codex'],
    });
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.providers[0].rootCounts?.reduce((sum, root) => sum + root.duplicateCount, 0)).toBe(2);
  });

  it('restricts maintenance discovery to saved roots despite new role homes and CODEX_HOME', async () => {
    const fixture = await providerFixture();
    const initial = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
    });
    const roleHome = join(fixture.providerHome, '.codex/roles-runtime/new/.codex');
    await writeCodexRollout(join(roleHome, 'sessions'), fixture.workspace, 'new');
    vi.stubEnv('CODEX_HOME', roleHome);
    const refreshed = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders: ['codex'],
      authorizedRoots: initial.authorizedRoots,
    });
    expect(refreshed.authorizedRoots).toEqual(initial.authorizedRoots);
    expect(refreshed.sources).toEqual(initial.sources);
    expect((await discoverWorkspaceHistories({
      workspace: fixture.workspace, expectedProviders: ['codex'], authorizedRoots: {},
    })).sources).toEqual([]);
  });

  itWithSqlite.each(['inspect', 'stream'] as const)(
    'persists content-free resource details rejected during %s', async (stage) => {
      const fixture = await providerFixture();
      const manifest = await discoverWorkspaceHistories({ workspace: fixture.workspace, providerHome: fixture.providerHome });
      manifest.sources = manifest.sources.filter((source) => source.provider === 'codex');
      const repository = new SessionRepository(':memory:');
      const inspect = CodexSessionAdapter.prototype.inspect;
      const stream = CodexSessionAdapter.prototype.stream;
      const bounded = new CodexSessionAdapter({ maxTotalBytes: 1 });
      const spy = stage === 'inspect'
        ? vi.spyOn(CodexSessionAdapter.prototype, 'inspect').mockImplementation((source) => inspect.call(bounded, source))
        : vi.spyOn(CodexSessionAdapter.prototype, 'stream').mockImplementation((source, cursor) => stream.call(bounded, source, cursor));
      try {
        const receipt = await importDiscoveryManifest({ manifest, repository });
        expect(receipt.run.status).toBe('partial');
        const rejection = receipt.run.sources[0];
        expect(rejection).toMatchObject({ status: 'rejected', errorCode: 'RESOURCE_LIMIT_EXCEEDED',
          detail: { limit: 'maxTotalBytes', configured: 1, observed: expect.any(Number) } });
        expect(rejection.diagnostic).toContain('"limit":"maxTotalBytes"');
        expect(rejection.diagnostic).not.toContain('Synthetic Codex request.');
        expect(repository.getBatchImportRun(receipt.run.runId)?.sources[0]).toEqual(rejection);
      } finally { spy.mockRestore(); repository.close(); }
    },
  );

  itWithSqlite('persists validator paths and codes without transcript values in batch diagnostics', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({ workspace: fixture.workspace, providerHome: fixture.providerHome });
    manifest.sources = manifest.sources.filter((source) => source.provider === 'codex');
    const source = manifest.sources[0];
    const content = JSON.stringify({ type: 42, text: 'synthetic-transcript-marker' }) + '\n';
    await writeFile(source.locator, content);
    source.sizeBytes = Buffer.byteLength(content);
    source.modifiedAt = (await stat(source.locator)).mtime.toISOString();
    source.digest = sha256(content);
    const repository = new SessionRepository(':memory:');
    try {
      const receipt = await importDiscoveryManifest({ manifest, repository });
      const rejection = receipt.run.sources[0];
      expect(rejection).toMatchObject({ status: 'rejected', errorCode: 'MALFORMED_SOURCE',
        detail: { issues: [{ path: 'type', code: 'invalid_type' }] } });
      expect(rejection.diagnostic).toContain('"path":"type"');
      expect(JSON.stringify(rejection)).not.toContain('synthetic-transcript-marker');
      expect(repository.getBatchImportRun(receipt.run.runId)?.sources[0]).toEqual(rejection);
      expect((await importDiscoveryManifest({ manifest, repository })).run.sources[0].detail)
        .toEqual(rejection.detail);
    } finally { repository.close(); }
  });

  it.each([
    ['/tmp/x/site.example', '-tmp-x-site-example'],
    ['/tmp/x/site example', '-tmp-x-site-example'],
    ['/tmp/x/site_example', '-tmp-x-site-example'],
    ['/tmp/x/site..__ example', '-tmp-x-site-----example'],
    ['/tmp/aiwg-x.y_z with spaces/site.example', '-tmp-aiwg-x-y-z-with-spaces-site-example'],
    ['C:\\Users\\Test User\\site.example', 'C--Users-Test-User-site-example'],
    ['C:/Users/Test_User/site.example', 'C--Users-Test-User-site-example'],
    ['/tmp/café/😀', '-tmp-caf----'],
  ])('encodes the Claude project folder for %s', (workspace, expected) => {
    expect(claudeProjectKey(workspace)).toBe(expected);
  });

  it('caps long Claude project keys at 200 characters with the original path hash', () => {
    const boundary = `/${'a'.repeat(199)}`;
    expect(claudeProjectKey(boundary)).toBe(`-${'a'.repeat(199)}`);
    expect(claudeProjectKey(`/tmp/${'a'.repeat(210)}`))
      .toBe(`-tmp-${'a'.repeat(195)}-de6m7t`);
  });

  it.each(['site.example', 'site example', 'site_example', 'site..__ example'])(
    'discovers the Claude project folder for workspace %s', async (name) => {
      const root = await mkdtemp(join(tmpdir(), 'aiwg-claude.discovery with_spaces-'));
      roots.push(root);
      const workspace = join(root, name);
      const providerHome = join(root, 'home');
      const key = claudeProjectKey(workspace);
      const project = join(providerHome, '.claude', 'projects', key);
      await Promise.all([workspace, project].map((path) => mkdir(path, { recursive: true })));
      const locator = join(project, 'session.jsonl');
      await writeFile(locator, JSON.stringify({ type: 'user', cwd: workspace }) + '\n');

      const manifest = await discoverWorkspaceHistories({
        workspace, providerHome, expectedProviders: ['claude'],
      });
      expect(manifest.sources.map((source) => source.locator)).toEqual([locator]);
    },
  );

  it('uses transcript cwd to disambiguate colliding Claude project folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-claude-collision-'));
    roots.push(root);
    const workspace = join(root, 'site.example');
    const otherWorkspace = join(root, 'site-example');
    const providerHome = join(root, 'home');
    const project = join(providerHome, '.claude', 'projects', claudeProjectKey(workspace));
    await Promise.all([workspace, otherWorkspace, project].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(project, 'matching.jsonl'), [
      'not-json',
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: workspace }),
    ].join('\n') + '\n');
    await writeFile(join(project, 'other.jsonl'), JSON.stringify({ type: 'user', cwd: otherWorkspace }) + '\n');

    const manifest = await discoverWorkspaceHistories({
      workspace, providerHome, expectedProviders: ['claude'],
    });
    expect(manifest.sources.map((source) => source.locator)).toEqual([join(project, 'matching.jsonl')]);
  });

  it('keeps other provider folder encodings and legacy Claude transcripts without cwd', async () => {
    const fixture = await providerFixture('site.example');
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
      expectedProviders: ['claude', 'codex', 'cursor', 'factory'],
    });
    expect(manifest.sources.map((source) => source.provider))
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
  });

  it('inventories only matching known roots, persists the exact manifest, and exposes export gaps', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
      createdAt: '2026-07-28T00:00:00.000Z',
    });
    expect(manifest.sources.map((source) => source.provider))
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
    expect(manifest.sources.every((source) => source.locator.startsWith(fixture.providerHome)))
      .toBe(true);
    expect(manifest.providers.find((provider) => provider.provider === 'codex'))
      .toMatchObject({ status: 'checked', sourceCount: 1 });
    expect(manifest.providers.find((provider) => provider.provider === 'warp'))
      .toMatchObject({
        status: 'export-required',
        disposition: 'manual-export',
        reasonCode: 'EXPLICIT_EXPORT_REQUIRED',
      });
    expect(manifest.providers.find((provider) => provider.provider === 'generic'))
      .toMatchObject({ status: 'export-required' });

    const path = join(fixture.workspace, '.aiwg', 'sessions', 'manifest.json');
    await writeDiscoveryManifest(path, manifest);
    await expect(readDiscoveryManifest(path)).resolves.toEqual(manifest);
  });

  it('checks the account home when an isolated runtime HOME hides provider stores', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      operatorHome: fixture.providerHome,
      codexRoot: join(fixture.providerHome, '.codex', 'sessions'),
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(manifest.providers.filter((provider) => provider.status === 'checked')
      .map((provider) => provider.provider))
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
    expect(manifest.sources.map((source) => source.provider).sort())
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
  });

  it('discovers Muse native logs only when --muse-root evidence matches the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-discovery-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const museRoot = join(root, 'muse-sessions');
    const matching = join(museRoot, '2026', '09', '25', '00000000-0000-4000-8000-000000000002');
    const unrelated = join(museRoot, '2026', '09', '25', '00000000-0000-4000-8000-000000000003');
    await Promise.all([workspace, matching, unrelated].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(matching, 'session.jsonl'), JSON.stringify({
      schema_version: 1,
      id: 'matching',
      stream: { kind: 'session', id: '00000000-0000-4000-8000-000000000002' },
      sequence: 1,
      recorded_at: 1790349213957005,
      record_type: 'event',
      durability: 'durable',
      payload_type: 'runtime.session.metadata',
      payload_schema_version: 1,
      payload: { kind: 'metadata', record: { workspace_root: workspace } },
    }) + '\n');
    await writeFile(join(unrelated, 'session.jsonl'), JSON.stringify({
      schema_version: 1,
      id: 'unrelated',
      stream: { kind: 'session', id: '00000000-0000-4000-8000-000000000003' },
      sequence: 1,
      recorded_at: 1790349213957005,
      record_type: 'event',
      durability: 'durable',
      payload_type: 'runtime.session.metadata',
      payload_schema_version: 1,
      payload: { kind: 'metadata', record: { workspace_root: join(root, 'other-workspace') } },
    }) + '\n');

    const manifest = await discoverWorkspaceHistories({ workspace, museRoot });
    const museSources = manifest.sources.filter((source) => source.provider === 'muse');
    expect(museSources).toHaveLength(1);
    expect(museSources[0]).toMatchObject({
      locatorClass: 'muse-native-session-log',
      locator: join(matching, 'session.jsonl'),
    });
    expect((await discoverWorkspaceHistories({ workspace })).sources.filter(
      (source) => source.provider === 'muse',
    )).toHaveLength(0);
  });

  itWithSqlite('completes accepted default-scope imports while retaining unresolved provider coverage', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
      createdAt: new Date().toISOString(),
    });
    const repository = new SessionRepository(':memory:');
    try {
      const first = await importDiscoveryManifest({ manifest, repository });
      expect(first.totals).toMatchObject({
        discovered: 4,
        accepted: 4,
        rejected: 0,
        pending: 0,
      });
      expect(first.schemaVersion).toBe('2.0.0');
      expect(first.run).toMatchObject({ schemaVersion: '2.0.0', status: 'complete' });
      expect(first.coverage).toMatchObject({
        schemaVersion: '2.0.0',
        status: 'partial',
        acquisitionStatus: 'complete',
        unresolvedProviders: expect.arrayContaining(['warp', 'opencode']),
        providers: { exportRequired: expect.arrayContaining(['warp', 'opencode']) },
        sources: { discovered: 4, accepted: 4 },
      });
      repository.saveBatchImportRun({ ...first.run, schemaVersion: '1.0.0', status: 'partial' });
      const second = await importDiscoveryManifest({ manifest, repository });
      expect(second.run.schemaVersion).toBe('2.0.0');
      expect(second.run.sources.every(
        (source) => source.status === 'previously-committed',
      )).toBe(true);
      expect(second.run.sources.every((source) => source.attempts === 1)).toBe(true);
      expect(second.run.status).toBe('complete');
      expect(repository.getCoverage(manifest.workspaceId).acquisitionStatus).toBe('complete');
      expect(repository.doctor()).toMatchObject({
        integrity: 'ok',
        indexIntegrity: 'ok',
        sources: 4,
        sessions: 4,
      });
    } finally {
      repository.close();
    }
  });

  itWithSqlite('immediately resumes a SIGKILLed child import and reports the interrupted run', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome,
    });
    const manifestPath = join(fixture.root, 'manifest.json');
    const database = join(fixture.root, 'catalog.sqlite');
    await writeDiscoveryManifest(manifestPath, manifest);
    const child = fork(fileURLToPath(new URL('../../fixtures/sessions/import-kill-child.ts', import.meta.url)),
      [database, manifestPath], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        timeout: 15_000,
        killSignal: 'SIGKILL',
      });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', (message) => {
          if (message === 'source-staged') resolve();
          else reject(new Error(`unexpected child message: ${String(message)}`));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`child exited before staging: ${stderr}`)));
      });
      const before = new SessionRepository(database);
      const interrupted = before.getBatchImportRunForManifest(manifest.manifestId, manifest.workspaceId)!;
      try {
        expect(interrupted.status).toBe('running');
        expect(interrupted.sources.filter((source) => source.status === 'committed')).toHaveLength(1);
      } finally {
        before.close();
      }
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
      const owner = JSON.parse(await readFile(join(importLeasePath(database), 'owner.json'), 'utf8'));
      expect(Date.now() - Date.parse(owner.heartbeatAt)).toBeLessThan(30_000);
      if (process.platform === 'linux') expect(owner.processStartId).toMatch(/^[\w-]+:\d+$/);

      const args = ['import-discovered', '--workspace', fixture.workspace,
        '--manifest', manifestPath, '--db', database, '--resume', '--confirm',
        '--lock-wait-ms', '0', '--json'];
      const context = { args, rawArgs: ['sessions', ...args], cwd: fixture.root, frameworkRoot: process.cwd() };
      expect((await sessionsHandler.execute(context)).exitCode).toBe(0);
      const receipt = JSON.parse(String(log.mock.calls.at(-1)?.[0])).data.receipt;
      expect(receipt.interruptedRuns).toEqual([
        { runId: interrupted.runId, interruptedAt: expect.any(String) },
      ]);
      expect(receipt.run.interruptedAt).toBe(receipt.interruptedRuns[0].interruptedAt);
      expect(receipt.totals).toMatchObject({ accepted: 3, previouslyCommitted: 1, rejected: 0, pending: 0 });
      expect(receipt.run.sources.every((source: { attempts: number }) => source.attempts === 1)).toBe(true);
      const after = new SessionRepository(database);
      try {
        expect(after.getBatchImportRun(interrupted.runId)).toMatchObject({
          status: 'complete', interruptedAt: receipt.run.interruptedAt,
        });
        expect(after.listSessions({ workspaceId: manifest.workspaceId, limit: 20 }).total).toBe(4);
        expect(after.doctor()).toMatchObject({ integrity: 'ok', sessions: 4 });
      } finally {
        after.close();
      }
      expect((await sessionsHandler.execute(context)).exitCode).toBe(0);
      const replay = JSON.parse(String(log.mock.calls.at(-1)?.[0])).data.receipt;
      expect(replay.interruptedRuns).toEqual([]);
      expect(replay.run.interruptedAt).toBe(receipt.run.interruptedAt);
      expect(replay.totals).toMatchObject({ accepted: 0, previouslyCommitted: 4 });
    } finally {
      child.kill('SIGKILL');
      await exited;
      log.mockRestore();
    }
  });

  itWithSqlite.each([
    { expectedProviders: ['claude'], status: 'complete' },
    { expectedProviders: ['claude', 'warp'], status: 'partial' },
    { expectedProviders: ['claude', 'future-provider'], status: 'partial' },
  ])('uses explicit provider scope $expectedProviders for acquisition status', async ({ expectedProviders, status }) => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace, providerHome: fixture.providerHome, expectedProviders,
    });
    const repository = new SessionRepository(':memory:');
    try {
      const receipt = await importDiscoveryManifest({ manifest, repository });
      expect(receipt.totals).toMatchObject({ discovered: 1, accepted: 1, rejected: 0, pending: 0 });
      expect(receipt.run.status).toBe(status);
      expect(receipt.coverage.acquisitionStatus).toBe(status);
      expect(receipt.coverage.unresolvedProviders).toEqual(expectedProviders.filter((provider) => provider !== 'claude'));
    } finally { repository.close(); }
  });

  itWithSqlite('keeps rejected default-scope imports partial', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({ workspace: fixture.workspace, providerHome: fixture.providerHome });
    await writeFile(manifest.sources[0].locator, '{}\n');
    const repository = new SessionRepository(':memory:');
    try {
      const receipt = await importDiscoveryManifest({ manifest, repository });
      expect(receipt.run.status).toBe('partial');
      expect(receipt.totals).toMatchObject({ discovered: 4, accepted: 3, rejected: 1, pending: 0 });
      expect(receipt.coverage.acquisitionStatus).toBe('partial');
    } finally { repository.close(); }
  });

  itWithSqlite.each([
    { expectedProviders: undefined, status: 'complete' },
    { expectedProviders: ['claude'], status: 'partial' },
  ])('reports $status for empty acquisition with expectations $expectedProviders', async ({ expectedProviders, status }) => {
    const fixture = await providerFixture();
    const empty = join(fixture.root, 'empty');
    await mkdir(empty);
    const manifest = await discoverWorkspaceHistories({ workspace: empty, providerHome: empty, expectedProviders });
    const repository = new SessionRepository(':memory:');
    try {
      const receipt = await importDiscoveryManifest({ manifest, repository });
      expect(receipt.run.status).toBe(status);
      expect(receipt.totals).toMatchObject({ discovered: 0, rejected: 0, pending: 0 });
      expect(receipt.coverage).toMatchObject({ status: 'partial', acquisitionStatus: status, coverageRatio: null });
      expect(receipt.coverage.unresolvedProviders.length).toBeGreaterThan(0);
    } finally { repository.close(); }
  });

  itWithSqlite('reports the observed 304-discovered/35-accepted case without claiming completeness', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
    });
    const repository = new SessionRepository(':memory:');
    try {
      const run = {
        schemaVersion: '1.0.0' as const,
        runId: 'run-304',
        manifestId: 'manifest-304',
        manifestCreatedAt: new Date().toISOString(),
        workspaceId: manifest.workspaceId,
        status: 'partial' as const,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        providers: manifest.providers,
        sources: Array.from({ length: 304 }, (_, index) => ({
          sourceId: `source-${index}`,
          provider: 'codex',
          status: index < 35 ? 'committed' as const : 'rejected' as const,
          attempts: 1,
          sessionsAccepted: index < 35 ? 1 : 0,
          eventsAccepted: index < 35 ? 2 : 0,
          errorCode: index < 35 ? null : 'MALFORMED_SOURCE',
          diagnostic: index < 35 ? null : `source=source-${index} code=MALFORMED_SOURCE`,
          updatedAt: new Date().toISOString(),
        })),
      };
      repository.saveBatchImportRun(run);
      expect(repository.getCoverage(manifest.workspaceId)).toMatchObject({
        schemaVersion: '2.0.0',
        status: 'partial',
        sources: {
          discovered: 304,
          accepted: 35,
          rejected: 269,
        },
        sessionsAccepted: 35,
        eventsAccepted: 70,
        rejectionCounts: { MALFORMED_SOURCE: 269 },
        coverageRatio: 35 / 304,
      });
    } finally {
      repository.close();
    }
  });

  itWithSqlite.each([
    'run-saved',
    'source-staged',
    'before-publication',
    'after-publication',
  ] as const)('resumes idempotently after failure at the %s boundary', async (boundary) => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
    });
    const repository = new SessionRepository(':memory:');
    let injected = false;
    try {
      await expect(importDiscoveryManifest({
        manifest,
        repository,
        fault(candidate) {
          if (!injected && candidate === boundary) {
            injected = true;
            throw new Error(`injected:${boundary}`);
          }
        },
      })).rejects.toThrow(`injected:${boundary}`);
      expect(repository.listSessions({
        workspaceId: manifest.workspaceId,
        limit: 20,
      }).total).toBe(boundary === 'after-publication' ? 4 : 0);
      const interrupted = repository.getBatchImportRunForManifest(
        manifest.manifestId,
        manifest.workspaceId,
      );
      expect(interrupted?.status).toBe('interrupted');

      const resumed = await importDiscoveryManifest({ manifest, repository });
      expect(resumed.run.status).toBe('complete');
      expect(resumed.totals).toMatchObject({
        discovered: 4,
        rejected: 0,
        pending: 0,
      });
      expect(repository.listSessions({
        workspaceId: manifest.workspaceId,
        limit: 20,
      }).total).toBe(4);
      expect(repository.doctor()).toMatchObject({
        integrity: 'ok',
        indexIntegrity: 'ok',
        sessions: 4,
      });
    } finally {
      repository.close();
    }
  });
});

async function writeMatchingSession(
  provider: 'codex' | 'muse' | 'omp',
  root: string,
  id: string,
  cwd: string,
): Promise<string> {
  if (provider === 'muse') return writeMuseLog(root, id, 1, cwd);
  const locator = join(root, `${id}.jsonl`);
  const timestamp = '2026-10-18T12:00:00Z';
  const header = provider === 'codex'
    ? { type: 'session_meta', timestamp, payload: { id, cwd } }
    : { type: 'session', version: 3, id, timestamp, cwd };
  const message = provider === 'codex'
    ? { type: 'response_item', timestamp, payload: {
      id: `${id}-message`, type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'Synthetic request.' }],
    } }
    : { type: 'message', id: `${id}-message`, parentId: null, timestamp,
      message: { role: 'user', content: 'Synthetic request.' } };
  await writeFile(locator, [header, message].map((record) => JSON.stringify(record)).join('\n') + '\n');
  return locator;
}

function rootIdentity(root: string): { root: string; rootId: string } {
  return { root: redactSourceLocator(root), rootId: sha256(root) };
}

async function writeCodexRollout(root: string, workspace: string, id: string, filename = `${id}.jsonl`): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace } }) + '\n');
}

async function providerFixture(name = 'workspace'): Promise<{ root: string; workspace: string; providerHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-session-discovery-'));
  roots.push(root);
  const workspace = join(root, name);
  const providerHome = join(root, 'home');
  await mkdir(workspace, { recursive: true });
  const key = workspace.replace(/\\/g, '/').replace(/[/:]+/g, '-');
  const cursorKey = workspace.replace(/\\/g, '/').replace(/^\/+/, '').replace(/[/:]+/g, '-');

  const claudeKey = claudeProjectKey(workspace);
  const claude = join(providerHome, '.claude', 'projects', claudeKey, 'claude.jsonl');
  const factory = join(providerHome, '.factory', 'sessions', key, 'factory.jsonl');
  const cursor = join(
    providerHome,
    '.cursor',
    'projects',
    cursorKey,
    'agent-transcripts',
    'cursor-session',
    'cursor-session.jsonl',
  );
  const codex = join(providerHome, '.codex', 'sessions', '2026', '07', 'rollout.jsonl');
  const unrelatedCodex = join(
    providerHome,
    '.codex',
    'sessions',
    '2026',
    '07',
    'unrelated.jsonl',
  );
  await Promise.all([claude, factory, cursor, codex, unrelatedCodex].map(
    (path) => mkdir(resolve(path, '..'), { recursive: true }),
  ));
  await writeFile(claude, [
    JSON.stringify({
      type: 'user',
      uuid: 'claude-user',
      sessionId: 'claude-session',
      timestamp: '2026-07-27T10:00:00.000Z',
      message: { role: 'user', content: 'Synthetic Claude request.' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'claude-assistant',
      parentUuid: 'claude-user',
      sessionId: 'claude-session',
      timestamp: '2026-07-27T10:00:01.000Z',
      message: { role: 'assistant', content: 'Synthetic Claude response.' },
    }),
  ].join('\n') + '\n');
  await writeFile(factory, [
    JSON.stringify({
      type: 'session_start',
      id: 'factory-session',
      version: 2,
      cwd: workspace,
    }),
    JSON.stringify({
      type: 'message',
      id: 'factory-message',
      timestamp: '2026-07-27T11:00:00.000Z',
      message: { role: 'user', content: 'Synthetic Factory request.' },
    }),
  ].join('\n') + '\n');
  await writeFile(cursor, [
    JSON.stringify({
      role: 'user',
      timestamp: '2026-07-27T12:00:00.000Z',
      message: { content: 'Synthetic Cursor request.' },
    }),
    JSON.stringify({
      type: 'turn_ended',
      status: 'success',
      timestamp: '2026-07-27T12:00:01.000Z',
    }),
  ].join('\n') + '\n');
  await writeFile(codex, [
    JSON.stringify({
      timestamp: '2026-07-27T13:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-session', cwd: workspace },
    }),
    JSON.stringify({
      timestamp: '2026-07-27T13:00:01.000Z',
      type: 'response_item',
      payload: {
        id: 'codex-message',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic Codex request.' }],
      },
    }),
  ].join('\n') + '\n');
  await writeFile(unrelatedCodex, JSON.stringify({
    timestamp: '2026-07-27T14:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'unrelated-session', cwd: join(root, 'other-workspace') },
  }) + '\n');
  return { root, workspace, providerHome };
}
