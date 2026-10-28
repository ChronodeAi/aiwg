import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requireFeaturePackage } from '../../../src/features/runtime.js';
import {
  HERMES_ADAPTER_VERSION,
  HermesSessionAdapter,
  HERMES_SNAPSHOT_LOCATOR_CLASS,
  discoverWorkspaceHistories,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  snapshotHermesStateDb,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/hermes');
const roots: string[] = [];
const writers: Array<{ close(): void }> = [];

afterEach(async () => {
  while (writers.length) {
    try {
      writers.pop()?.close();
    } catch { /* already closed */ }
  }
  await Promise.all(roots.splice(0).map(async (root) => {
    try {
      await chmod(root, 0o700);
    } catch { /* already removed */ }
    await rm(root, { recursive: true, force: true });
  }));
});

function sqlite(): any {
  return requireFeaturePackage('better-sqlite3');
}

async function materializeStateDb(home: string, workspace: string, other: string): Promise<string> {
  const Database = sqlite();
  const seed = (await readFile(resolve(fixturesRoot, 'state-db-seed.sql'), 'utf8'))
    .split('__WORKSPACE__').join(workspace)
    .split('__OTHER_WORKSPACE__').join(other);
  const database = new Database(join(home, 'state.db'));
  try {
    database.exec(seed);
  } finally {
    database.close();
  }
  return join(home, 'state.db');
}

async function freshHome(): Promise<{ home: string; workspace: string; other: string }> {
  const base = await mkdtemp(join(tmpdir(), 'aiwg-hermes-native-'));
  roots.push(base);
  const home = join(base, 'hermes-home');
  const workspace = join(base, 'workspace');
  const other = join(base, 'other');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(other, { recursive: true });
  await materializeStateDb(home, workspace, other);
  return { home, workspace, other };
}

/**
 * Simulate a running Hermes: an open connection holds the WAL sidecars so a
 * read-only backup can reuse them without creating files in the provider tree.
 */
async function runningHome(): Promise<{ home: string; workspace: string; other: string }> {
  const setup = await freshHome();
  const Database = sqlite();
  const writer = new Database(join(setup.home, 'state.db'));
  writer.prepare('SELECT count(*) AS n FROM sessions').get();
  writers.push(writer);
  return setup;
}

async function dirSnapshot(directory: string): Promise<Array<{ name: string; size: number }>> {
  const entries = await readdir(directory);
  const rows: Array<{ name: string; size: number }> = [];
  for (const name of entries.sort()) {
    rows.push({ name, size: (await stat(join(directory, name))).size });
  }
  return rows;
}

function selected(locator: string, allowedRoots: string[]): SelectedSource {
  return {
    provider: 'hermes',
    locator,
    locatorClass: HERMES_SNAPSHOT_LOCATOR_CLASS,
    sourceId: `hermes-snapshot-${locator}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('Hermes adapter capability', () => {
  it('advertises native discovery alongside export ingest', () => {
    const adapter = new HermesSessionAdapter();
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('hermes', {
      state: 'available',
      evidence: {
        adapterVersion: HERMES_ADAPTER_VERSION,
        sourceSchemaVersion: '1.0.0',
        verifiedAt: '2026-07-27',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'hermes',
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['jsonl', 'api', 'sqlite-snapshot'],
    });
  });

  it('requires an explicitly authorized Hermes home for discovery', async () => {
    const adapter = new HermesSessionAdapter();
    await expect(collect(adapter.discover({ workspaceId: 'ws', allowedRoots: [] })))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });

  it('keeps refusing raw state.db copies for direct import', async () => {
    const adapter = new HermesSessionAdapter();
    await expect(adapter.inspect({
      provider: 'hermes',
      locator: resolve(fixturesRoot, 'complete.jsonl'),
      locatorClass: 'hermes-state-db',
      sourceId: 'hermes-raw',
      authorizedScope: { workspaceId: 'ws', allowedRoots: [fixturesRoot] },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

describeWithSqlite('Hermes state.db snapshot discovery', () => {
  it('projects only workspace-matching sessions through a consistent backup', async () => {
    const { home, workspace } = await freshHome();
    const staging = join(workspace, '.aiwg', 'sessions', 'staging', 'hermes');
    // A committed row still sitting in the WAL (no checkpoint) proves the
    // backup API — not a main-file copy — produces the snapshot.
    const Database = sqlite();
    const writer = new Database(join(home, 'state.db'));
    writer.exec(`INSERT INTO sessions(id, started_at, cwd) VALUES ('hermes-wal-1', 1785153900, '${workspace}');
      INSERT INTO messages(session_id, seq, id, role, content) VALUES ('hermes-wal-1', 0, 'm1', 'user', '"wal evidence"');`);
    const before = await dirSnapshot(home);
    expect(before.map((entry) => entry.name)).toContain('state.db-wal');
    let snapshot;
    let after;
    try {
      snapshot = await snapshotHermesStateDb({
        hermesRoot: home,
        stagingDir: staging,
        allowedRoots: [home, staging],
        workspaceId: workspace,
      });
      // Compare while the test's own writer is still open: closing the last
      // connection checkpoints and removes the WAL sidecars, which is the
      // test's doing, not the snapshot's.
      after = await dirSnapshot(home);
    } finally {
      writer.close();
    }
    expect(snapshot?.matched).toBe(2);
    expect(snapshot?.excluded).toBe(2);
    expect(snapshot?.projectionPath.startsWith(`${staging}/`)).toBe(true);
    const lines = (await readFile(snapshot!.projectionPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const projected = JSON.parse(lines[0]);
    expect(projected).toMatchObject({
      id: 'hermes-ws-1',
      cwd: workspace,
      snapshotConsistency: 'sqlite-backup',
    });
    expect(projected.messages.map((message: { id: unknown }) => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(JSON.parse(lines[1])).toMatchObject({ id: 'hermes-wal-1', snapshotConsistency: 'sqlite-backup' });
    // The live database is untouched: same files, same sizes, no residue staged beside it.
    expect(after).toEqual(before);
    const adapter = new HermesSessionAdapter();
    const source = selected(snapshot!.projectionPath, [staging]);
    // The WAL-row session is still active, so the mixed projection is provisional.
    await expect(adapter.inspect(source)).resolves.toMatchObject({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(source));
    expect(records[0]).toMatchObject({ nativeSessionId: 'hermes-ws-1', kind: 'hermes.session' });
    expect(records.filter((record) => record.nativeSessionId === 'hermes-ws-1').map((record) => record.kind)).toEqual([
      'hermes.session', 'message', 'message', 'tool-call', 'tool-result',
    ]);
  });

  it('snapshots a running provider from a read-only tree without writing to it', async () => {
    const { home, workspace } = await runningHome();
    const staging = join(workspace, '.aiwg', 'sessions', 'staging', 'hermes');
    const before = await dirSnapshot(home);
    expect(before.map((entry) => entry.name)).toContain('state.db-shm');
    await chmod(home, 0o500);
    for (const entry of before) await chmod(join(home, entry.name), 0o400);
    try {
      const snapshot = await snapshotHermesStateDb({
        hermesRoot: home,
        stagingDir: staging,
        allowedRoots: [home, staging],
        workspaceId: workspace,
      });
      expect(snapshot?.matched).toBe(1);
      expect(await dirSnapshot(home)).toEqual(before);
    } finally {
      await chmod(home, 0o700);
      for (const entry of before) {
        try {
          await chmod(join(home, entry.name), 0o600);
        } catch { /* removed by close */ }
      }
    }
  });

  it('fails closed instead of writing sidecars for a stopped provider', async () => {
    const { home, workspace } = await freshHome();
    const staging = join(workspace, '.aiwg', 'sessions', 'staging', 'hermes');
    // Clean close removes the WAL sidecars: no first read may create them.
    expect((await dirSnapshot(home)).map((entry) => entry.name)).toEqual(['state.db']);
    await expect(snapshotHermesStateDb({
      hermesRoot: home,
      stagingDir: staging,
      allowedRoots: [home, staging],
      workspaceId: workspace,
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('state.db-shm'),
    });
    // Refusal happens before any SQLite contact: the tree gains nothing.
    expect((await dirSnapshot(home)).map((entry) => entry.name)).toEqual(['state.db']);
  });

  it('returns no source when nothing matches the workspace', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aiwg-hermes-nomatch-'));
    roots.push(base);
    const { mkdir } = await import('node:fs/promises');
    const home = join(base, 'home');
    const workspace = join(base, 'ws');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const Database = sqlite();
    const database = new Database(join(home, 'state.db'));
    // Held open until afterEach: closing the last connection would remove the
    // WAL sidecars the snapshot reuses without creating files.
    writers.push(database);
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('native_schema', 'hermes-synthetic-v1');
        CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'cli',
          user_id TEXT, model TEXT, model_config TEXT, parent_session_id TEXT,
          compressed_from_session_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
          end_reason TEXT, archived INTEGER NOT NULL DEFAULT 0, inactive INTEGER NOT NULL DEFAULT 0,
          cwd TEXT, git_branch TEXT, routing_key TEXT, input_tokens INTEGER,
          output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
          reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, billing_provider TEXT,
          export_deleted_at INTEGER, provider_deleted_at INTEGER);
        CREATE TABLE messages(session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
          tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp INTEGER, token_count INTEGER,
          finish_reason TEXT, reasoning TEXT, reasoning_content TEXT,
          reasoning_details TEXT, codex_reasoning_items TEXT,
          PRIMARY KEY(session_id, seq));
        INSERT INTO sessions(id, started_at, cwd) VALUES ('elsewhere', 1785153600, '/synthetic/elsewhere');
        INSERT INTO messages(session_id, seq, id, role, content) VALUES ('elsewhere', 0, 'm1', 'user', '"x"');`);
    database.prepare('SELECT count(*) AS n FROM sessions').get();
    const adapter = new HermesSessionAdapter();
    const found = await collect(adapter.discover({ workspaceId: workspace, allowedRoots: [home] }));
    expect(found).toEqual([]);
  });

  it('fails closed on unqualified physical schemas', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aiwg-hermes-drift-'));
    roots.push(base);
    const { mkdir } = await import('node:fs/promises');
    const home = join(base, 'home');
    const workspace = join(base, 'ws');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const Database = sqlite();
    const database = new Database(join(home, 'state.db'));
    // Held open with WAL sidecars present so the physical schema gate runs.
    writers.push(database);
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY);');
    database.prepare('SELECT count(*) AS n FROM sessions').get();
    await expect(snapshotHermesStateDb({
      hermesRoot: home,
      stagingDir: join(base, 'staging'),
      allowedRoots: [home, join(base, 'staging')],
      workspaceId: workspace,
    })).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('discovers the workspace staging snapshot and refuses unauthorized homes', async () => {
    const { home, workspace } = await runningHome();
    const manifest = await discoverWorkspaceHistories({
      workspace,
      providerHome: workspace,
      expectedProviders: ['hermes'],
      hermesRoot: home,
    });
    expect(manifest.providers.find((entry) => entry.provider === 'hermes')).toMatchObject({
      status: 'checked',
      disposition: 'discoverable',
      sourceCount: 1,
    });
    const [source] = manifest.sources.filter((item) => item.provider === 'hermes');
    expect(source?.locatorClass).toBe(HERMES_SNAPSHOT_LOCATOR_CLASS);
    expect(source?.locator.startsWith(join(workspace, '.aiwg', 'sessions', 'staging', 'hermes'))).toBe(true);
    expect(manifest.authorizedRoots?.hermes).toHaveLength(2);
    // No grant, no reads: the provider stays manual-export with a flag remediation.
    const denied = await discoverWorkspaceHistories({
      workspace,
      providerHome: workspace,
      expectedProviders: ['hermes'],
    });
    expect(denied.providers.find((entry) => entry.provider === 'hermes')).toMatchObject({
      status: 'export-required',
      disposition: 'manual-export',
      reasonCode: 'SHARED_ROOT_AUTHORIZATION_REQUIRED',
      remediation: expect.stringContaining('--hermes-root'),
    });
    expect(denied.sources.some((item) => item.provider === 'hermes')).toBe(false);
  });

  it('imports the staged snapshot with stable identity and idempotent replay', async () => {
    const { home, workspace } = await runningHome();
    const manifest = await discoverWorkspaceHistories({
      workspace,
      providerHome: workspace,
      expectedProviders: ['hermes'],
      hermesRoot: home,
    });
    const [manifestSource] = manifest.sources.filter((item) => item.provider === 'hermes');
    const adapter = new HermesSessionAdapter();
    const selectedSource: SelectedSource = {
      provider: 'hermes',
      locator: manifestSource!.locator,
      locatorClass: manifestSource!.locatorClass,
      sourceId: manifestSource!.sourceId,
      authorizedScope: { workspaceId: manifest.workspaceId, allowedRoots: [manifestSource!.authorizedRoot] },
    };
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'hermes',
      providerProfile: 'native-state-db-backup-snapshot-v1',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/snapshot.jsonl',
      adapterVersion: HERMES_ADAPTER_VERSION,
      sourceSchemaVersion: '1.0.0',
      disposition: 'implemented', operationalState: 'available', consistency: 'complete',
      authorizedAt: '2026-10-18T00:00:00.000Z',
      extensions: { 'native.hermes': { acquisition: HERMES_SNAPSHOT_LOCATOR_CLASS } },
    };
    const repository = new SessionRepository();
    try {
      const importer = new IncrementalSessionImporter(repository);
      const request = {
        source, selectedSource, adapter, workspaceId: manifest.workspaceId, policyVersion: '1.0.0',
      };
      const receipts = await importer.import(request);
      expect(receipts.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(5);
      expect(await importer.import(request)).toEqual([]);
      const sessions = repository.listSessions({ workspaceId: manifest.workspaceId, limit: 10 });
      expect(sessions.total).toBe(1);
      expect(sessions.items[0]).toMatchObject({ nativeSessionId: 'hermes-ws-1' });
      const search = repository.search({ workspaceId: manifest.workspaceId, query: 'synthetic', limit: 20 });
      expect(search.items.length).toBeGreaterThan(0);
    } finally {
      repository.close();
    }
  });

  it('refuses a live database outside the explicit authorization', async () => {
    const { home, workspace } = await freshHome();
    await expect(snapshotHermesStateDb({
      hermesRoot: home,
      stagingDir: join(workspace, '.aiwg', 'sessions', 'staging', 'hermes'),
      allowedRoots: [join(workspace, 'elsewhere')],
      workspaceId: workspace,
    })).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ALLOWED_ROOT' });
  });
});
