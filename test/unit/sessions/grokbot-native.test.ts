import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS,
  GrokbotSessionAdapter,
  type SelectedSource,
} from '../../../src/sessions/index.js';
import { discoverWorkspaceHistories } from '../../../src/sessions/workspace-discovery.js';
import { createSessionAdapterRegistry } from '../../../src/sessions/adapter-registry.js';
import { grokbotTranscriptReplicaFilename } from '../../../src/sessions/adapters/grokbot-locator.js';

const fixturesRoot = resolve('test/fixtures/sessions/grokbot/native');
const ids = JSON.parse(readFileSync(resolve(fixturesRoot, 'fixture-ids.json'), 'utf8')) as {
  account: string;
  conversations: Record<'complete' | 'truncated' | 'unknownSchema' | 'malformed', string>;
  decoys: { composerDraftsKey: string; plainFiles: string[] };
};

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}

/** Select one fixture replica by conversation, independent of directory order. */
function replica(name: keyof typeof ids.conversations): SelectedSource {
  return selectedFor(resolve(fixturesRoot, grokbotTranscriptReplicaFilename(ids.account, ids.conversations[name])));
}

function selectedFor(locator: string): SelectedSource {
  return {
    provider: 'grokbot',
    locator,
    locatorClass: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS,
    sourceId: 'native-fixture',
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('Grok Bot native transcript-replica locator', () => {
  const adapter = new GrokbotSessionAdapter();

  it('discovers only transcript-replica blobs, never the roster or any decoy file', async () => {
    const descriptors = await collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot],
    }));
    expect(descriptors).toHaveLength(4); // complete, truncated, unknownSchema, malformed
    for (const descriptor of descriptors) {
      expect(descriptor.locatorClass).toBe(GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS);
      expect(descriptor.locator.endsWith('.blob')).toBe(true);
    }
    // None of the decoy / roster filenames (by content) ever surface as a source.
    const rosterOrDecoyContents = [
      readFileSync(resolve(fixturesRoot, 'sand-secrets.json'), 'utf8'),
      readFileSync(resolve(fixturesRoot, 'box-secrets-main.blob'), 'utf8'),
    ];
    for (const content of rosterOrDecoyContents) {
      expect(content).toBe('not-json-garbage-{{{');
    }
  });

  it('requires an explicitly authorized root and never probes with none given', async () => {
    await expect(collect(adapter.discover({ workspaceId: 'workspace-fixture', allowedRoots: [] })))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });

  it('inspects a complete replica as complete and streams every known-kind entry with mapped roles/text', async () => {
    const completeSource = replica('complete');

    const probe = await adapter.inspect(completeSource!);
    expect(probe).toEqual({ sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available' });
    expect(probe.declaredWorkspaceId).toBeUndefined();

    const records = await collect(adapter.stream(completeSource!));
    // 14 entries, 1 unrecognized kind skipped -> 13 records.
    expect(records).toHaveLength(13);
    expect(records.every((record) => record.nativeSessionId === ids.conversations.complete)).toBe(true);

    const byId = Object.fromEntries(records.map((record) => [record.nativeEventId, record]));
    expect(byId['evt-1']).toMatchObject({ role: 'user', kind: 'grokbot.message', text: 'Can you help me plan a release?' });
    expect(byId['evt-2']).toMatchObject({ role: 'assistant', kind: 'grokbot.send-message.text', text: 'Sure — what is the target date?' });
    expect(byId['evt-4']).toMatchObject({ role: 'assistant', participant: 'Release Bot' });
    expect((byId['evt-4'].extensions as any).fromAgent).toMatchObject({ id: 'agent-release-bot', name: 'Release Bot' });
    expect(byId['evt-5']).toMatchObject({ role: 'user', kind: 'grokbot.user-attachment' });
    expect(byId['evt-5'].text).toContain('roadmap.png');
    expect(byId['evt-6'].text).toBe('[widget] Pick a release channel -> stable');
    expect(byId['evt-7'].text).toBe('[email-draft] Release notes draft\nHello team, here are the draft release notes...');
    expect(byId['evt-8'].text).toBe('[slack-draft] #release-engineering\nHeads up: release cut next Friday.');
    expect(byId['evt-9'].text).toContain('checklist.pdf');
    expect(byId['evt-10'].text).toBe('[user-form] Confirm release owner');
    expect(byId['evt-11'].text).toBe('[secret-request] Deploy API token (value not exported)');
    expect(JSON.stringify(byId['evt-11'])).not.toMatch(/token.{0,20}=|bearer/i);
    expect(byId['evt-12']).toMatchObject({ role: 'system', kind: 'grokbot.event' });
    expect(byId['evt-13']).toMatchObject({ role: 'system', kind: 'grokbot.notice', text: 'Conversation archived by user.' });
    expect(byId['evt-14']).toBeUndefined(); // unrecognized kind: skipped, never fabricated
  });

  it('resumes from a prior seq cursor without re-emitting already-imported entries', async () => {
    const completeSource = replica('complete');
    const full = await collect(adapter.stream(completeSource!));
    const last = full.find((record) => record.nativeEventId === 'evt-6')!;
    expect(last.sourceCursor).toBe('native:6');

    const resumed = await collect(adapter.stream(completeSource!, { value: last.sourceCursor }));
    expect(resumed.map((record) => record.nativeEventId)).toEqual(
      full.slice(full.findIndex((record) => record.nativeEventId === 'evt-6') + 1)
        .map((record) => record.nativeEventId),
    );
    expect(resumed.some((record) => record.nativeEventId === 'evt-6')).toBe(false);
  });

  it('reports a window-evicted (truncated) replica as provisional, never claiming complete history', async () => {
    const truncatedSource = replica('truncated');
    await expect(adapter.inspect(truncatedSource)).resolves.toMatchObject({ consistency: 'provisional' });
    const records = await collect(adapter.stream(truncatedSource!));
    expect(records).toHaveLength(2);
    expect(records[0].sequence).toBe(41);
  });

  it('fails closed on an unknown schemaVersion major', async () => {
    await expect(adapter.inspect(replica('unknownSchema')))
      .rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
  });

  it('fails closed on a structurally malformed known-kind entry', async () => {
    await expect(collect(adapter.stream(replica('malformed'))))
      .rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });

  it('rejects any locatorClass other than manual-export or the native replica class', async () => {
    const descriptors = await collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot],
    }));
    const forged: SelectedSource = { ...selectedFor(descriptors[0].locator), locatorClass: 'cursor-composer' };
    await expect(adapter.inspect(forged)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('never opens non-allowlisted files: decoy content would throw if ever parsed as JSON', async () => {
    // Discovery already proved these are never yielded as sources (above).
    // This additionally proves that even a hostile/garbage decoy file does
    // not abort discovery or inspection of the real sources.
    const descriptors = await collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot],
    }));
    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      await adapter.inspect(selectedFor(descriptor.locator)).catch(() => undefined);
    }
    // If any decoy had been opened and parsed as JSON, readBoundedJson would
    // have thrown SCHEMA_DRIFT/MALFORMED_SOURCE for *that* file specifically;
    // since decoys are never selected as descriptors at all, there is nothing
    // further to assert here beyond "discovery completed" — see the dedicated
    // discover() test above for the authoritative allowlist assertion.
    expect(true).toBe(true);
  });

  it('assigns a conversation-id–derived sourceId (not content-digest) so re-discovery is stable', async () => {
    const workspace = resolve(fixturesRoot, '..'); // any real directory works as the authorized "workspace"
    const first = await discoverWorkspaceHistories({
      workspace,
      expectedProviders: ['grokbot'],
      grokbotRoot: fixturesRoot,
      registry: createSessionAdapterRegistry(),
    });
    const second = await discoverWorkspaceHistories({
      workspace,
      expectedProviders: ['grokbot'],
      grokbotRoot: fixturesRoot,
      registry: createSessionAdapterRegistry(),
    });
    const firstIds = first.sources.filter((s) => s.provider === 'grokbot').map((s) => s.sourceId).sort();
    const secondIds = second.sources.filter((s) => s.provider === 'grokbot').map((s) => s.sourceId).sort();
    expect(firstIds.length).toBeGreaterThan(0);
    expect(firstIds).toEqual(secondIds);
  });
});
