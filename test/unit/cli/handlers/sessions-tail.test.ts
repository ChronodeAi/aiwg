// Verify CLI selection, redaction, import opt-in, and cancellation with temporary catalogs.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { describeWithSqlite } from '../../../helpers/sqlite.js';
import { sessionsHandler } from '../../../../src/cli/handlers/sessions.js';
import { IncrementalSessionImporter } from '../../../../src/sessions/importer.js';
import { SessionRepository } from '../../../../src/sessions/repository.js';
import { createSessionAdapterRegistry } from '../../../../src/sessions/adapter-registry.js';
import { HOST_CATALOG_WORKSPACE_ID } from '../../../../src/sessions/host-catalog.js';
import { discoverWorkspaceHistories, writeDiscoveryManifest,
  defaultDiscoveryManifestPath } from '../../../../src/sessions/workspace-discovery.js';
import { tailFixture } from '../../sessions/tail-fixtures.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const roots: string[] = [];
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(resolve(tmpdir(), 'aiwg-tail-cli-'));
  roots.push(root);
  const fixture = await tailFixture(root);
  const database = resolve(root, 'catalog.sqlite');
  const repository = new SessionRepository(database);
  try {
    await new IncrementalSessionImporter(repository).import({ ...fixture,
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0' });
    const session = repository.listSessions({ limit: 1 }).items[0];
    return { root, fixture, database, session };
  } finally { repository.close(); }
}

function context(root: string, args: string[], signal?: AbortSignal) {
  return { cwd: root, frameworkRoot: process.cwd(), rawArgs: ['sessions', ...args], args, signal };
}

function outputs() { return log.mock.calls.map(call => JSON.parse(String(call[0]))); }

describeWithSqlite('sessions tail CLI', () => {
  it('documents tail flags in the existing sessions help', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-tail-help-'));
    roots.push(root);
    expect((await sessionsHandler.execute(context(root, ['tail', '--help', '--json']))).exitCode).toBe(0);
    expect(outputs()[0].data.usage).toContain('tail <session-id> | --provider <p> --latest');
    expect(outputs()[0].data.usage).toContain('[--follow] [--json] [--import]');
  });

  it('follows native appends with JSON redaction and exits cleanly on abort', async () => {
    const { root, fixture, database, session } = await setup();
    const before = await readFile(database);
    const controller = new AbortController();
    const signalsBefore = process.listenerCount('SIGINT');
    const pending = sessionsHandler.execute(context(root, ['tail', session.sessionId,
      '--db', database, '--input', fixture.selectedSource.locator, '--follow', '--json'], controller.signal));
    try {
      await fixture.append();
      await vi.waitFor(() => expect(outputs().some(row => row.data?.event)).toBe(true), { timeout: 1900 });
      expect(outputs().filter(row => row.data?.event).every(row => row.status === 'ok')).toBe(true);
      expect(JSON.stringify(outputs())).not.toContain('tail-secret-canary');
      expect(JSON.stringify(outputs())).not.toContain('synthetic@example.test');
    } finally { controller.abort(); }
    expect((await pending).exitCode).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(signalsBefore);
    expect(await readFile(database)).toEqual(before);
  });

  it('selects the latest provider session in the requested workspace', async () => {
    const { root, fixture, database } = await setup();
    const newer = await tailFixture(resolve(root, 'newer'));
    newer.source.sourceId = newer.selectedSource.sourceId = 'newer-source';
    const text = (await readFile(newer.selectedSource.locator, 'utf8')).replaceAll('2026-07-27', '2026-10-27');
    await writeFile(newer.selectedSource.locator, text);
    const repository = new SessionRepository(database);
    let latest;
    try {
      await new IncrementalSessionImporter(repository).import({ ...newer, workspaceId: 'workspace-fixture', policyVersion: '1.0.0' });
      latest = repository.listSessions({ provider: 'claude', limit: 1 }).items[0];
    } finally { repository.close(); }
    await newer.append();
    expect((await sessionsHandler.execute(context(root, ['tail', '--provider', 'claude', '--latest',
      '--workspace', 'workspace-fixture', '--db', database, '--input', newer.selectedSource.locator, '--json']))).exitCode).toBe(0);
    expect(outputs().filter(row => row.data?.event).map(row => row.data.event.sessionId)).toEqual([latest!.sessionId, latest!.sessionId]);
    expect(outputs()[0].data.event.sourceId).not.toBe(fixture.source.sourceId);
  });

  it('imports when explicitly requested and renders human-readable events', async () => {
    const { root, fixture, database, session } = await setup();
    await fixture.append();
    expect((await sessionsHandler.execute(context(root, ['tail', session.nativeSessionId,
      '--db', database, '--input', fixture.selectedSource.locator, '--import']))).exitCode).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('claude message:');
    const repository = new SessionRepository(database, { readonly: true });
    try { expect(repository.listEvents(session.sessionId).length).toBeGreaterThan(1); }
    finally { repository.close(); }
  });

  it('resolves a native source from the saved default discovery manifest', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-tail-manifest-'));
    roots.push(root);
    const fixture = await tailFixture(root);
    fixture.selectedSource.authorizedScope.workspaceId = root;
    await writeFile(fixture.selectedSource.locator,
      (await readFile(fixture.selectedSource.locator, 'utf8')).replaceAll('/private/work/project', root));
    const manifest = await discoverWorkspaceHistories({ workspace: root, providerHome: root,
      operatorHome: root, expectedProviders: ['claude'], authorizedRoots: { claude: [root] } });
    expect(manifest.sources).toHaveLength(1);
    fixture.source.sourceId = fixture.selectedSource.sourceId = manifest.sources[0].sourceId;
    await writeDiscoveryManifest(defaultDiscoveryManifestPath(root), manifest);
    const database = resolve(root, 'catalog.sqlite');
    const repository = new SessionRepository(database);
    let id: string;
    try {
      await new IncrementalSessionImporter(repository).import({ ...fixture,
        workspaceId: root, policyVersion: '1.0.0' });
      id = repository.listSessions({ limit: 1 }).items[0].sessionId;
    } finally { repository.close(); }
    await fixture.append();
    expect((await sessionsHandler.execute(context(root, ['tail', id!, '--db', database, '--json']))).exitCode).toBe(0);
    expect(outputs().filter(row => row.data?.event)).toHaveLength(2);
  });

  it('follows account-scoped sessions through the workspace host reference', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-tail-host-'));
    roots.push(root);
    const fixture = await tailFixture(root, ['grokbot', 'grokbot-native-transcript-replica',
      `grokbot/native/${(await import('../../../../src/sessions/adapters/grokbot-locator.js'))
        .grokbotTranscriptReplicaFilename('synthtest01', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1')}`]);
    const hostPath = resolve(root, 'host.sqlite');
    const host = new SessionRepository(hostPath);
    const database = resolve(root, 'catalog.sqlite');
    const local = new SessionRepository(database);
    let id: string;
    try {
      fixture.selectedSource.authorizedScope.workspaceId = HOST_CATALOG_WORKSPACE_ID;
      await new IncrementalSessionImporter(host).import({ ...fixture,
        workspaceId: HOST_CATALOG_WORKSPACE_ID, policyVersion: '1.0.0' });
      const session = host.listSessions({ limit: 1 }).items[0];
      id = session.sessionId;
      local.recordHostSessionReference({ provider: session.provider, nativeSessionId: session.nativeSessionId,
        sessionId: id, sourceId: session.sourceId, hostCatalog: hostPath });
    } finally { host.close(); local.close(); }
    await fixture.append();
    expect((await sessionsHandler.execute(context(root, ['tail', '--provider', 'grokbot', '--latest',
      '--db', database, '--input', fixture.selectedSource.locator, '--json']))).exitCode).toBe(0);
    expect(outputs()[0].data.event.sessionId).toBe(id!);
  });

  it('returns a named UNSUPPORTED_PROVIDER when the selected adapter cannot stream', async () => {
    const { root, database } = await setup();
    // A manual-export-only adapter can expose inspection without a stream.
    const registry = await import('../../../../src/sessions/adapter-registry.js');
    const adapter = createSessionAdapterRegistry().get('claude');
    Object.defineProperty(adapter, 'supportedOperations', { value: ['inspect'] });
    vi.spyOn(registry, 'createSessionAdapterRegistry').mockReturnValue({ get: () => adapter } as any);
    const result = await sessionsHandler.execute(context(root, ['tail', '--provider', 'claude', '--latest', '--workspace', 'workspace-fixture', '--db', database, '--json']));
    expect(result.exitCode, JSON.stringify(outputs())).toBe(3);
    expect(outputs()[0].error).toMatchObject({ code: 'UNSUPPORTED_PROVIDER', message: expect.stringContaining('claude') });
  });

  it('preserves the existing workspace ambiguity diagnostic for latest selection', async () => {
    const { root, database } = await setup();
    const other = await tailFixture(resolve(root, 'other'));
    other.source.sourceId = other.selectedSource.sourceId = 'other-source';
    other.selectedSource.authorizedScope.workspaceId = 'other-workspace';
    const repository = new SessionRepository(database);
    try {
      await new IncrementalSessionImporter(repository).import({ ...other,
        workspaceId: 'other-workspace', policyVersion: '1.0.0' });
    } finally { repository.close(); }
    // Some hosts have a Git boundary at /tmp. This case specifically models
    // a standalone catalog with no containing project, using synthetic scope.
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation(path => String(path).endsWith('/.git')
      || String(path).endsWith('/.aiwg/aiwg.config') ? false : actual.existsSync(path));
    expect((await sessionsHandler.execute(context(root, ['tail', '--provider', 'claude', '--latest',
      '--db', database, '--json']))).exitCode).toBe(2);
    expect(outputs()[0].error.code).toBe('WORKSPACE_AMBIGUOUS');
  });

  it('stops on SIGINT and removes its listener', async () => {
    const { root, fixture, database, session } = await setup();
    const before = process.listenerCount('SIGINT');
    const pending = sessionsHandler.execute(context(root, ['tail', session.sessionId, '--db', database,
      '--input', fixture.selectedSource.locator, '--follow', '--json']));
    await vi.waitFor(() => expect(process.listenerCount('SIGINT')).toBe(before + 1));
    process.emit('SIGINT');
    expect((await pending).exitCode).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('requires a saved source authorization and does not create a missing catalog', async () => {
    const { root, database, session } = await setup();
    expect((await sessionsHandler.execute(context(root, ['tail', session.sessionId, '--db', database, '--json']))).exitCode).toBe(5);
    expect(outputs()[0].error.code).toBe('SOURCE_NOT_AUTHORIZED');
    log.mockClear();
    const missing = resolve(root, 'missing.sqlite');
    expect((await sessionsHandler.execute(context(root, ['tail', 'absent', '--db', missing, '--json']))).exitCode).toBe(6);
    await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([['tail'], ['tail', '--latest'], ['tail', 'id', '--provider', 'claude', '--latest']])(
    'rejects invalid selection %j', async (...argv) => {
      const root = await mkdtemp(resolve(tmpdir(), 'aiwg-tail-invalid-'));
      roots.push(root);
      expect((await sessionsHandler.execute(context(root, [...argv, '--json']))).exitCode).toBe(2);
    });
});
