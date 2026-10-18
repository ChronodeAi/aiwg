import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PiSessionAdapter, type SelectedSource,
  IncrementalSessionImporter, SessionRepository, SessionSourceSchema, stableSessionId,
  discoverWorkspaceHistories,
} from '../../../src/sessions/index.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

const roots: string[] = [];
const fixtures = resolve('test/fixtures/sessions/pi');
const selected = (name: string): SelectedSource => ({ provider: 'pi', locator: join(fixtures, name),
  locatorClass: 'pi-session-v3-jsonl', sourceId: `pi-${name}`,
  authorizedScope: { workspaceId: 'fixture', allowedRoots: [fixtures] } });
async function collect(source: SelectedSource, cursor?: string) { const rows = []; for await (const row of new PiSessionAdapter().stream(source, cursor === undefined ? undefined : { value: cursor })) rows.push(row); return rows; }
async function resumeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-session-resume-')); roots.push(root);
  const source: SelectedSource = { ...selected('valid.jsonl'), locator: join(root, 'resume.jsonl'),
    authorizedScope: { workspaceId: 'fixture', allowedRoots: [root] } };
  const header = JSON.stringify({ type: 'session', version: 3, id: 'pi-resume-session', timestamp: '2026-10-18T12:00:00Z', cwd: '/workspace' }) + '\n';
  const entries = ['one π', 'two', 'three'].map((content, index) => JSON.stringify({
    type: 'message', id: `m${index + 1}`, parentId: index === 0 ? null : `m${index}`,
    timestamp: `2026-10-18T12:00:0${index + 1}Z`, message: { role: 'user', content },
  }) + '\n');
  await writeFile(source.locator, header + entries.join(''));
  return { source, header, entries, root };
}
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('PiSessionAdapter', () => {
  it('discovers v3 JSONL and preserves tree provenance while redacting tool output', async () => {
    const adapter = new PiSessionAdapter();
    const discovered = []; for await (const item of adapter.discover({ workspaceId: 'fixture', allowedRoots: [fixtures] })) discovered.push(item);
    expect(discovered.some(item => item.locator.endsWith('valid.jsonl'))).toBe(true);
    expect(await adapter.inspect(selected('valid.jsonl'))).toMatchObject({ sourceSchemaVersion: '3.0.0' });
    const records = await collect(selected('valid.jsonl'));
    expect(records.map(record => record.nativeEventId)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(records[2]).toMatchObject({ text: '[redacted provider content]', toolName: 'read' });
    expect(records[3]).toMatchObject({ activityBoundary: 'continuation' });
    expect(records[4].extensions).toMatchObject({ opaque: true, parentId: 'm4' });
  });
  it('fails safely for malformed, unknown, truncated, oversized, and unauthorized sources', async () => {
    await expect(collect(selected('malformed.jsonl'))).rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
    await expect(collect(selected('unknown-major.jsonl'))).rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
    const root = await mkdtemp(join(tmpdir(), 'pi-session-')); roots.push(root);
    const truncated = join(root, 'truncated.jsonl');
    await writeFile(truncated, '{"type":"session","version":3,"id":"x","timestamp":"2026-09-04T12:00:00Z","cwd":"/x"}\n{"type":');
    await expect(collect({ ...selected('valid.jsonl'), locator: truncated, authorizedScope: { workspaceId: 'x', allowedRoots: [root] } }))
      .rejects.toMatchObject({ code: 'TRUNCATED_SOURCE' });
    await expect(new PiSessionAdapter({ maxRecordBytes: 8 }).inspect(selected('valid.jsonl')))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    await expect(new PiSessionAdapter().inspect({ ...selected('valid.jsonl'), authorizedScope: { workspaceId: 'x', allowedRoots: [root] } }))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });
});

describe('PiSessionAdapter persisted-session fixtures', () => {
  it('preserves branches, compaction, retry evidence, unknown entries, and parent provenance', async () => {
    const records = await collect(selected('branched-v3.jsonl'));
    expect(records.map(record => record.nativeEventId)).toEqual([
      'root-user', 'root-assistant', 'abandoned-branch', 'branch-summary', 'compact-1', 'retry-evidence', 'unknown-entry',
    ]);
    expect(records.every(record => record.nativeSessionId === 'pi-session-fixture')).toBe(true);
    expect(records.map(record => record.extensions?.parentId)).toEqual([
      null, 'root-user', 'root-user', 'root-assistant', 'branch-summary', 'compact-1', 'retry-evidence',
    ]);
    expect(records[1]).toMatchObject({ kind: 'message.assistant', role: 'assistant', text: 'Initial result' });
    expect(records[2]).toMatchObject({ kind: 'message.user', text: 'This branch is not the selected leaf.' });
    expect(records[3]).toMatchObject({ kind: 'pi.branch_summary', role: 'system',
      text: 'An alternate branch was explored and abandoned.', activityBoundary: undefined });
    expect(records[4]).toMatchObject({ kind: 'pi.compaction', role: 'system', text: 'Earlier provider inspection was compacted.',
      activityBoundary: 'continuation', activityBoundaryBasis: 'pi-session:compaction', activityBoundaryConfidence: 'high' });
    expect(records[5]).toMatchObject({ kind: 'pi.custom', text: '[redacted provider content]', toolName: undefined });
    expect(records[5].extensions).toMatchObject({ redacted: true, opaque: false, nativeType: 'custom' });
    expect(JSON.stringify(records[5])).not.toContain('attempts');
    expect(records[6]).toMatchObject({ kind: 'pi.future_entry', text: '' });
    expect(records[6].extensions).toMatchObject({ opaque: true, redacted: false, nativeType: 'future_entry' });
    expect(JSON.stringify(records[6])).not.toContain('preserve');
    expect(records.map(record => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('resumes from a byte cursor and preserves the header session id', async () => {
    const all = await collect(selected('branched-v3.jsonl'));
    const resumed = await collect(selected('branched-v3.jsonl'), all[3].sourceCursor);
    expect(resumed.map(record => record.nativeEventId)).toEqual(['compact-1', 'retry-evidence', 'unknown-entry']);
    expect(resumed).toEqual(all.slice(4));
    expect(resumed[0].rawReference).toEqual({ locatorClass: 'pi-session-v3-jsonl', offset: Number(all[3].sourceCursor?.slice(5)) });
  });
  it('keeps explicit redaction markers and never emits secret-shaped content', async () => {
    const records = await collect(selected('redaction-v3.jsonl'));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: 'message.user', text: 'Use OPENROUTER_API_KEY=[REDACTED] and password=[REDACTED].' });
    expect(records[1]).toMatchObject({ kind: 'pi.custom', text: '[redacted provider content]' });
    expect(records[1].extensions).toMatchObject({ redacted: true, nativeType: 'custom', parentId: 'redacted-user' });
    expect(JSON.stringify(records)).not.toMatch(/sk-or-v1-|Bearer\s+[A-Za-z0-9]|"fields"/);
    expect(await new PiSessionAdapter().inspect(selected('redaction-v3.jsonl'))).toMatchObject({ sourceSchemaVersion: '3.0.0', consistency: 'complete' });
  });
  it('rejects duplicate native ids and entries missing the tree contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-dup-')); roots.push(root);
    const header = '{"type":"session","version":3,"id":"dup","timestamp":"2026-09-04T12:00:00Z","cwd":"/x"}\n';
    const entry = (id: string, parentId: string | null) => `${JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-09-04T12:00:01Z', message: { role: 'user', content: 'x' } })}\n`;
    const duplicate = join(root, 'duplicate.jsonl');
    await writeFile(duplicate, header + entry('same', null) + entry('same', 'same'));
    const source = (locator: string) => ({ ...selected('valid.jsonl'), locator, authorizedScope: { workspaceId: 'x', allowedRoots: [root] } });
    await expect(collect(source(duplicate))).rejects.toMatchObject({ code: 'DUPLICATE_NATIVE_ID' });
    const orphan = join(root, 'orphan.jsonl');
    await writeFile(orphan, header + '{"type":"message","id":"no-parent-field","timestamp":"2026-09-04T12:00:01Z"}\n');
    await expect(collect(source(orphan))).rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });
});

describe('PiSessionAdapter resume cursors', () => {
  it('emits byte-prefixed UTF-8 offsets and resumes without replaying entries', async () => {
    const { source, header, entries } = await resumeFixture();
    const all = await collect(source);
    expect(all.map(record => record.sourceCursor)).toEqual(entries.map((_, index) =>
      `byte:${Buffer.byteLength(header + entries.slice(0, index + 1).join(''))}`));
    expect(await collect(source, all[0].sourceCursor)).toEqual(all.slice(1));
    expect(await collect(source, all[2].sourceCursor)).toEqual([]);
    expect(await collect(source, 'byte:0')).toEqual(all);
  });

  it.each([0, 1, 3])('resumes from legacy record index %i after the header', async (index) => {
    const { source } = await resumeFixture();
    const all = await collect(source);
    expect(await collect(source, String(index))).toEqual(all.slice(index));
  });

  it.each(['byte:1', 'byte:999999', 'byte:invalid', '-1'])(
    'rejects invalid cursor %s', async (cursor) => {
      const { source } = await resumeFixture();
      await expect(collect(source, cursor)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    },
  );

  for (const legacy of [false, true]) {
    itWithSqlite(`resumes persisted ${legacy ? 'legacy record-index' : 'byte-offset'} checkpoints across refresh and append without duplicate events`, async () => {
      const { source: selection, header, entries, root } = await resumeFixture();
      await writeFile(selection.locator, header + entries.slice(0, 2).join(''));
      const source = SessionSourceSchema.parse({
        contractVersion: '1.0.0', sourceId: selection.sourceId, provider: 'pi', providerProfile: 'native-v3',
        locatorClass: selection.locatorClass, redactedLocator: '<pi>', adapterVersion: '1.0.0',
        sourceSchemaVersion: '3.0.0', disposition: 'implemented', operationalState: 'available',
        consistency: 'complete', authorizedAt: '2026-10-18T12:00:00Z',
      });
      class LegacyPiSessionAdapter extends PiSessionAdapter {
        async *stream(source: SelectedSource) {
          for await (const record of super.stream(source)) {
            yield { ...record, sourceCursor: record.sourceCursor?.replace(/^byte:/, '') };
          }
        }
      }
      const db = join(root, 'sessions.db');
      let repository = new SessionRepository(db);
      const request = { source, selectedSource: selection, adapter: new PiSessionAdapter(), workspaceId: 'fixture', policyVersion: '1.0.0' };
      const id = stableSessionId('pi', selection.sourceId, 'pi-resume-session');
      try {
        await new IncrementalSessionImporter(repository).import({ ...request,
          adapter: legacy ? new LegacyPiSessionAdapter() : request.adapter });
        expect(repository.getCheckpoint(source.sourceId, '1.0.0')).toMatchObject({
          cursor: legacy ? '2' : `byte:${Buffer.byteLength(header + entries.slice(0, 2).join(''))}`,
          positionKind: legacy ? 'record-index' : 'byte-offset', recordsRead: 2,
        });
        repository.close();
        repository = new SessionRepository(db);
        const importer = new IncrementalSessionImporter(repository);
        expect(await importer.import(request)).toEqual([]);
        await appendFile(selection.locator, entries[2]);
        const receipts = await importer.import(request);
        expect(receipts).toHaveLength(1);
        expect(receipts[0].eventsInserted).toBe(1);
        expect(repository.getCheckpoint(source.sourceId, '1.0.0')).toMatchObject({
          cursor: `byte:${Buffer.byteLength(header + entries.join(''))}`,
          positionKind: 'byte-offset', recordsRead: 3,
        });
        expect(await importer.import(request)).toEqual([]);
        expect(repository.listEvents(id).map(event => event.nativeId)).toEqual(['m1', 'm2', 'm3']);
        expect(repository.listSessions({ workspaceId: 'fixture', limit: 10 }).items).toHaveLength(1);
      } finally {
        repository.close();
      }
    });
  }
});

// #2656: PiSessionAdapter declared no sourceSchemaMajor, so the importer's
// gate (src/sessions/importer.ts) fell back to its `?? 1` default and
// rejected every v3 Pi source with UNKNOWN_SCHEMA_MAJOR. Fixing only that
// gate would have started importing *other* workspaces' sessions, because
// workspace-discovery.ts scanned the entire `.pi/agent/sessions` tree
// instead of Pi's own per-workspace `--<path>--` subdirectory. Both must be
// fixed together.
describe('PiSessionAdapter schema-major gate (#2656)', () => {
  it('declares sourceSchemaMajor 3, matching its v3 JSONL sources', () => {
    expect(new PiSessionAdapter().sourceSchemaMajor).toBe(3);
  });

  itWithSqlite('imports a v3 Pi source through IncrementalSessionImporter instead of rejecting it as an unknown schema major', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-import-')); roots.push(root);
    const selection = { ...selected('valid.jsonl'), locator: join(root, 'valid.jsonl'), authorizedScope: { workspaceId: '/workspace', allowedRoots: [root] } };
    await writeFile(selection.locator, await (await import('node:fs/promises')).readFile(join(fixtures, 'valid.jsonl'), 'utf8'));
    const source = SessionSourceSchema.parse({
      contractVersion: '1.0.0', sourceId: selection.sourceId, provider: 'pi', providerProfile: 'native-v3',
      locatorClass: selection.locatorClass, redactedLocator: '<pi>', adapterVersion: '1.0.0',
      sourceSchemaVersion: '3.0.0', disposition: 'implemented', operationalState: 'available',
      consistency: 'complete', authorizedAt: '2026-09-04T12:00:00Z',
    });
    const db = join(root, 'sessions.db');
    const repository = new SessionRepository(db);
    try {
      const request = { source, selectedSource: selection, adapter: new PiSessionAdapter(), workspaceId: '/workspace', policyVersion: '1.0.0' };
      await new IncrementalSessionImporter(repository).import(request);
      const id = stableSessionId('pi', selection.sourceId, 'pi-session');
      expect(repository.listEvents(id)).toHaveLength(5);
    } finally {
      repository.close();
    }
  });

  it('discovers only the current workspace\'s Pi sessions, scoped to its --<path>-- subdirectory', async () => {
    const homeRoot = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-home-')));
    roots.push(homeRoot);
    const rootA = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-ws-a-')));
    const rootB = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-ws-b-')));
    roots.push(rootA, rootB);
    // Discovery canonicalizes the workspace path (resolves symlinks) before
    // deriving its key, so the fixture keys off the same canonical path the
    // code will compute, not an arbitrary literal path.
    const workspaceA = join(rootA, 'project-a');
    const workspaceB = join(rootB, 'project-b');
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });

    const keyFor = (workspace: string) => workspace.replace(/\\/g, '/').replace(/^\/+/, '').replace(/[/:]+/g, '-');
    const sessionsRoot = join(homeRoot, '.pi', 'agent', 'sessions');
    const dirA = join(sessionsRoot, `--${keyFor(workspaceA)}--`);
    const dirB = join(sessionsRoot, `--${keyFor(workspaceB)}--`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    const sessionFor = (id: string, cwd: string) => [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-09-04T12:00:00Z', cwd }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-04T12:00:01Z', message: { role: 'user', content: 'hi' } }),
    ].join('\n') + '\n';
    await writeFile(join(dirA, 'a-session.jsonl'), sessionFor('session-a', workspaceA));
    await writeFile(join(dirB, 'b-session.jsonl'), sessionFor('session-b', workspaceB));

    const manifest = await discoverWorkspaceHistories({
      workspace: workspaceA,
      providerHome: homeRoot,
      expectedProviders: ['pi'],
    });
    const piSources = manifest.sources.filter((source) => source.provider === 'pi');
    expect(piSources).toHaveLength(1);
    expect(piSources[0].locator).toContain(`--${keyFor(workspaceA)}--`);
    expect(piSources[0].locator).not.toContain(`--${keyFor(workspaceB)}--`);
  });
});
