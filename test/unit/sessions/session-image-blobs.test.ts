// Synthetic-image coverage for #3265: tool-output images are stored by
// content-hash reference with dedupe, never inline. All fixtures are tiny
// synthetic byte strings; no real transcripts or model output.
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireFeaturePackage } from '../../../src/features/runtime.js';
import {
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  extractEventImages,
  extractInlineImagesFromText,
  formatImageBytes,
  imagePlaceholder,
  sessionEventToAiwgFortemiRecord,
  sha256,
  stableSessionId,
  type ProviderRecord,
  type SessionEvent,
  type SessionSource,
  type SessionSourceAdapter,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';
// File-owned temp dirs are removed after the file, even when a test fails (#3018).
import { mkdtemp } from '../../helpers/temp-dir.js';

// 1x1 synthetic PNG (70 bytes) and 1x1 synthetic GIF (43 bytes).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const GIF_BASE64 =
  'R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const pngBytes = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));
const gifBytes = new Uint8Array(Buffer.from(GIF_BASE64, 'base64'));
const PNG_DIGEST = sha256(pngBytes);
const GIF_DIGEST = sha256(gifBytes);

function adapter(records: ProviderRecord[]): SessionSourceAdapter {
  return {
    provider: 'generic',
    adapterVersion: '1.0.0',
    disposition: 'implemented',
    supportedOperations: ['discover', 'inspect', 'stream'],
    acquisitionModes: ['jsonl'],
    async *discover() { /* explicit fixture has no ambient discovery */ },
    async inspect() {
      return { sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available' };
    },
    async *stream(_source, cursor) {
      const start = Number(cursor?.value ?? 0);
      for (const record of records.slice(start)) yield record;
    },
  };
}

const source: SessionSource = {
  contractVersion: SESSION_CONTRACT_VERSION,
  sourceId: 'source-image-fixture',
  provider: 'generic',
  providerProfile: 'fixture',
  locatorClass: 'synthetic-fixture',
  redactedLocator: '<fixture>',
  adapterVersion: '1.0.0',
  sourceSchemaVersion: '1.0.0',
  disposition: 'implemented',
  operationalState: 'available',
  consistency: 'complete',
  authorizedAt: '2026-07-26T00:00:00.000Z',
  extensions: { 'native.generic': {} },
};

function record(
  nativeEventId: string,
  sequence: number,
  text: string,
  extensions?: Record<string, unknown>,
): ProviderRecord {
  return {
    nativeSessionId: 'native-images',
    nativeEventId,
    sequence,
    kind: 'tool-result',
    role: 'tool',
    toolName: 'view_image',
    occurredAt: '2026-07-26T00:00:00.000Z',
    text,
    rawReference: { locatorClass: 'synthetic-fixture', offset: sequence },
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

async function importRecords(
  repository: SessionRepository,
  records: ProviderRecord[],
  workspaceId = 'workspace-1',
): Promise<void> {
  await new IncrementalSessionImporter(repository).import({
    source,
    selectedSource: {
      provider: 'generic',
      locator: '<fixture>',
      locatorClass: 'synthetic-fixture',
      sourceId: source.sourceId,
      authorizedScope: { workspaceId, allowedRoots: [] },
    },
    adapter: adapter(records),
    workspaceId,
    policyVersion: '1.0.0',
  });
}

function sessionId(): string {
  return stableSessionId('generic', source.sourceId, 'native-images');
}

describe('image placeholder formatting', () => {
  it('formats byte sizes and placeholders', () => {
    expect(formatImageBytes(70)).toBe('70 B');
    expect(formatImageBytes(2048)).toBe('2.0 KB');
    expect(formatImageBytes(3_250_000)).toBe('3.1 MB');
    expect(imagePlaceholder({ digest: PNG_DIGEST, mediaType: 'image/png', byteLength: pngBytes.length }))
      .toBe(`[image: ${PNG_DIGEST}, image/png, 70 B]`);
  });

  it('leaves non-image data URLs and remote URLs untouched', () => {
    const text = 'doc data:text/plain;base64,aGVsbG8gd29ybGQgdGV4dCBsb25nIE1TZw== and https://example.com/pic.png end';
    expect(extractInlineImagesFromText(text).images).toEqual([]);
    expect(extractInlineImagesFromText(text).text).toBe(text);
  });

  it('leaves short or malformed base64 payloads untouched', () => {
    const text = 'frag data:image/png;base64,abcd end';
    const extracted = extractInlineImagesFromText(text);
    expect(extracted.images).toEqual([]);
    expect(extracted.text).toBe(text);
  });
});

describeWithSqlite('session image blob storage', () => {
  it('stores inline base64 as a hash reference with a searchable placeholder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-image-ref-'));
    const repository = new SessionRepository(join(root, 'catalog.sqlite'));
    await importRecords(repository, [
      record('event-a', 0, `screenshot data:image/png;base64,${PNG_BASE64} done`),
    ]);
    const [event] = repository.listEvents(sessionId(), 'workspace-1');
    expect(event.searchableText).toBe(
      `screenshot ${imagePlaceholder({ digest: PNG_DIGEST, mediaType: 'image/png', byteLength: pngBytes.length })} done`,
    );
    expect(event.searchableText).not.toContain(PNG_BASE64);
    expect(event.imageRefs).toEqual([{
      digest: PNG_DIGEST,
      mediaType: 'image/png',
      byteLength: pngBytes.length,
      locatorClass: 'synthetic-fixture',
      offset: 0,
    }]);
    expect(repository.countImageBlobs()).toBe(1);
    const blob = repository.getImageBlob(PNG_DIGEST);
    expect(blob?.mediaType).toBe('image/png');
    expect(blob?.byteLength).toBe(pngBytes.length);
    expect(blob ? Buffer.from(blob.bytes).toString('base64') : null).toBe(PNG_BASE64);
    expect(repository.resolveEventImages(event)).toEqual([{
      digest: PNG_DIGEST,
      mediaType: 'image/png',
      byteLength: pngBytes.length,
      locatorClass: 'synthetic-fixture',
      offset: 0,
      status: 'available',
    }]);
  });

  it('stores duplicate images once across events and replays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-image-dedupe-'));
    const repository = new SessionRepository(join(root, 'catalog.sqlite'));
    const records = [
      record('event-a', 0, `first data:image/png;base64,${PNG_BASE64}`),
      // Same image replayed in a second record, plus a distinct image.
      record('event-b', 1, `replay data:image/png;base64,${PNG_BASE64} and data:image/gif;base64,${GIF_BASE64}`),
    ];
    await importRecords(repository, records);
    // Repeat import emulates a replayed source: events dedupe by identity.
    await importRecords(repository, records);
    expect(repository.countImageBlobs()).toBe(2);
    const events = repository.listEvents(sessionId(), 'workspace-1');
    expect(events).toHaveLength(2);
    expect(events[0].imageRefs?.map((ref) => ref.digest)).toEqual([PNG_DIGEST]);
    expect(events[1].imageRefs?.map((ref) => ref.digest)).toEqual([PNG_DIGEST, GIF_DIGEST]);
    expect(events[0].searchableText).not.toContain(PNG_BASE64);
    expect(events[1].searchableText).not.toContain(PNG_BASE64);
  });

  it('leaves provider image blocks in extensions to redaction and stores no blob for them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-image-blocks-'));
    const repository = new SessionRepository(join(root, 'catalog.sqlite'));
    await importRecords(repository, [
      record('event-a', 0, 'tool output with structured images', {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
          { type: 'image_url', image_url: { url: `data:image/gif;base64,${GIF_BASE64}` } },
          // Remote URLs are references already: left alone, never stored.
          { type: 'image_url', image_url: { url: 'https://example.com/remote.png' } },
        ],
      }),
    ]);
    const [event] = repository.listEvents(sessionId(), 'workspace-1');
    // Extension image blocks were never retained (redacted to markers); #3265
    // must not start retaining them.
    expect(event.imageRefs ?? []).toEqual([]);
    expect(repository.countImageBlobs()).toBe(0);
    expect(JSON.stringify(event.extensions)).not.toContain(PNG_BASE64);
    expect(JSON.stringify(event.extensions)).not.toContain(GIF_BASE64);
  });

  it('keeps image bytes out of FTS while the placeholder stays searchable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-image-fts-'));
    const repository = new SessionRepository(join(root, 'catalog.sqlite'));
    // A plain message stays in the default search scope (tool-control
    // origins are excluded from default search by design, unrelated here).
    await importRecords(repository, [{
      ...record('event-a', 0, `screenshot data:image/png;base64,${PNG_BASE64} done`),
      kind: 'message',
      role: 'user',
      toolName: undefined,
    }]);
    // A long alphanumeric run from the base64 payload is one FTS token;
    // it must not match once the bytes live in the blob store.
    const base64Token = PNG_BASE64.replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
    expect(base64Token.length).toBeGreaterThanOrEqual(24);
    expect(repository.search({ query: base64Token, workspaceId: 'workspace-1', limit: 50 }).items).toEqual([]);
    // Positive controls: the placeholder text and the digest are indexed.
    const [event] = repository.listEvents(sessionId(), 'workspace-1');
    expect(repository.search({ query: 'screenshot', workspaceId: 'workspace-1', limit: 50 }).items)
      .toHaveLength(1);
    expect(repository.search({ query: PNG_DIGEST.slice('sha256:'.length), workspaceId: 'workspace-1', limit: 50 })
      .items.map((hit) => hit.eventId)).toEqual([event.eventId]);
  });

  it('export resolves references and reports unavailable blobs explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-image-export-'));
    const repository = new SessionRepository(join(root, 'catalog.sqlite'));
    await importRecords(repository, [
      record('event-a', 0, `screenshot data:image/png;base64,${PNG_BASE64} done`),
    ]);
    const session = repository.getSession(sessionId(), 'workspace-1')!;
    const [event] = repository.listEvents(sessionId(), 'workspace-1');
    // Without a resolver the record carries no availability assertion.
    const unresolved = sessionEventToAiwgFortemiRecord(session, event);
    expect(unresolved.tags.some((tag) => tag.startsWith('image:'))).toBe(false);
    // Available: reference tag plus an available entry in attributes.
    const resolved = sessionEventToAiwgFortemiRecord(session, event, repository.resolveEventImages(event));
    expect(resolved.tags).toContain(`image:${PNG_DIGEST}`);
    expect(resolved.tags.some((tag) => tag.startsWith('image-unavailable:'))).toBe(false);
    const attributes = resolved.provenance_events[0].attributes as { images?: Array<{ status: string }> };
    expect(attributes.images).toEqual([{
      digest: PNG_DIGEST, mediaType: 'image/png', byteLength: pngBytes.length, status: 'available',
    }]);
    // Blob gone: the reference stays, flagged unavailable, bytes absent.
    const missing = sessionEventToAiwgFortemiRecord(session, event, [{
      digest: PNG_DIGEST, mediaType: 'image/png', byteLength: pngBytes.length, status: 'unavailable',
    }]);
    expect(missing.tags).toContain(`image:${PNG_DIGEST}`);
    expect(missing.tags).toContain(`image-unavailable:${PNG_DIGEST}`);
    expect((missing.provenance_events[0].attributes as { images: Array<{ status: string }> }).images)
      .toEqual([{
        digest: PNG_DIGEST, mediaType: 'image/png', byteLength: pngBytes.length, status: 'unavailable',
      }]);
    expect(JSON.stringify(missing)).not.toContain(PNG_BASE64);
    // Unknown digests resolve unavailable rather than failing the read.
    const ghost: SessionEvent = { ...event, imageRefs: [{ digest: sha256('ghost'), mediaType: 'image/png', byteLength: 1 }] };
    expect(repository.resolveEventImages(ghost)).toEqual([
      { digest: sha256('ghost'), mediaType: 'image/png', byteLength: 1, status: 'unavailable' },
    ]);
    expect(repository.getImageBlob('not-a-digest')).toBeNull();
  });

  it('reads pre-existing inline rows verbatim without references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-image-legacy-'));
    const path = join(root, 'catalog.sqlite');
    const repository = new SessionRepository(path);
    await importRecords(repository, [record('event-a', 0, 'plain text')]);
    const [seed] = repository.listEvents(sessionId(), 'workspace-1');
    // Emulate a pre-#3265 row: inline bytes, no imageRefs field at all.
    const legacy = {
      ...seed,
      eventId: 'event_legacy_inline',
      sequence: 99,
      searchableText: `old screenshot data:image/png;base64,${PNG_BASE64} inline`,
    };
    delete (legacy as Partial<SessionEvent>).imageRefs;
    const Database = requireFeaturePackage('better-sqlite3') as new (path: string) => {
      prepare(sql: string): {
        run(...params: unknown[]): unknown;
        get(...params: unknown[]): { value?: unknown } | undefined;
      };
    };
    const raw = new Database(path);
    raw.prepare(
      `INSERT INTO session_events
       (event_id, session_id, source_id, import_run_id, sequence_no, digest, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      legacy.eventId, legacy.sessionId, legacy.sourceId, legacy.importRunId,
      legacy.sequence, legacy.digest, JSON.stringify(legacy),
    );
    const rowid = Number(raw.prepare(
      'SELECT rowid AS value FROM session_events WHERE event_id=?',
    ).get(legacy.eventId)?.value);
    raw.prepare(
      'INSERT INTO session_event_fts(rowid, event_id, searchable_text) VALUES (?, ?, ?)',
    ).run(rowid, legacy.eventId, legacy.searchableText);
    const events = repository.listEvents(sessionId(), 'workspace-1');
    expect(events).toHaveLength(2);
    const loaded = events.find((candidate) => candidate.eventId === 'event_legacy_inline')!;
    expect(loaded.searchableText).toContain(PNG_BASE64);
    expect('imageRefs' in loaded).toBe(false);
    expect(repository.resolveEventImages(loaded)).toEqual([]);
    expect(repository.countImageBlobs()).toBe(0);
  });

  it('extracts images from raw event shapes with source locator and offset', () => {
    const extracted = extractEventImages({
      searchableText: `a data:image/png;base64,${PNG_BASE64} b`,
      extensions: {},
      rawReference: { locatorClass: 'codex-rollout-jsonl', offset: 1234 },
    });
    expect(extracted.searchableText).toBe(`a ${imagePlaceholder({
      digest: PNG_DIGEST, mediaType: 'image/png', byteLength: pngBytes.length,
    })} b`);
    expect(extracted.imageRefs).toEqual([{
      digest: PNG_DIGEST,
      mediaType: 'image/png',
      byteLength: pngBytes.length,
      locatorClass: 'codex-rollout-jsonl',
      offset: 1234,
    }]);
    expect(extracted.images).toHaveLength(1);
  });
});
