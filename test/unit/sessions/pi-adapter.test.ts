import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiSessionAdapter, type SelectedSource } from '../../../src/sessions/index.js';

const roots: string[] = [];
const fixtures = resolve('test/fixtures/sessions/pi');
const selected = (name: string): SelectedSource => ({ provider: 'pi', locator: join(fixtures, name),
  locatorClass: 'pi-session-v3-jsonl', sourceId: `pi-${name}`,
  authorizedScope: { workspaceId: 'fixture', allowedRoots: [fixtures] } });
async function collect(source: SelectedSource) { const rows = []; for await (const row of new PiSessionAdapter().stream(source)) rows.push(row); return rows; }
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
  it('resumes from a record cursor without re-reading the header', async () => {
    const all = await collect(selected('branched-v3.jsonl'));
    const resumed = [];
    for await (const row of new PiSessionAdapter().stream(selected('branched-v3.jsonl'), { value: all[3].sourceCursor } as any)) resumed.push(row);
    expect(resumed.map(record => record.nativeEventId)).toEqual(['compact-1', 'retry-evidence', 'unknown-entry']);
    expect(resumed[0].nativeSessionId).toBe('branched-v3');
    expect(resumed[0].rawReference).toEqual({ locatorClass: 'pi-session-v3-jsonl', offset: Number(all[3].sourceCursor) });
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
