import { expect, it, vi } from 'vitest';
import { IncrementalSessionImporter } from '../../../src/sessions/importer.js';
import { sha256, stableEventId, type ProviderRecord, type SessionSourceAdapter, type SessionSource } from '../../../src/sessions/contracts.js';
import type { SessionRepositoryPort } from '../../../src/sessions/ports.js';

it('serializes records only at admission and flush while preserving mutable-adapter identities and byte metrics', async () => {
  const records: ProviderRecord[] = [0, 1, 2].map(sequence => ({
    nativeSessionId: 'session', sequence, kind: 'message', text: `Unicode café 😀 ${sequence}`,
    rawReference: { locatorClass: 'fixture', sequence }, extensions: { status: 'original' },
  }));
  const serialized = records.map(record => JSON.stringify(record));
  // Batch size two flushes before the second yield resumes; the first and
  // final records have been mutated by the adapter when their batch commits.
  const finalRecords = serialized.map((text, index) => {
    const record = JSON.parse(text) as ProviderRecord;
    if (index !== 1) {
      record.text = 'adapter mutated after yield';
      record.extensions!.status = 'mutated';
      record.rawReference.sequence = 999;
    }
    return record;
  });
  const committed = finalRecords.map(record => JSON.stringify(record));
  const digests = committed.map(text => sha256(text));
  const source: SessionSource = {
    contractVersion: '1.0.0', sourceId: 'source', provider: 'generic', providerProfile: 'fixture',
    locatorClass: 'fixture', redactedLocator: '<fixture>', adapterVersion: '1.0.0',
    sourceSchemaVersion: '1.0.0', disposition: 'implemented', operationalState: 'available',
    consistency: 'complete', authorizedAt: '2026-10-19T00:00:00.000Z', extensions: {},
  };
  const adapter: SessionSourceAdapter = {
    provider: 'generic', adapterVersion: '1.0.0', disposition: 'implemented',
    supportedOperations: ['stream'], acquisitionModes: ['jsonl'],
    async *discover() {},
    async inspect() { return { sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available' }; },
    async *stream() {
      for (const record of records) {
        yield record;
        // A legal custom adapter may reuse/mutate objects after the consumer resumes it.
        record.text = 'adapter mutated after yield';
        record.extensions!.status = 'mutated';
        record.rawReference.sequence = 999;
      }
    },
  };
  const applyImport = vi.fn<SessionRepositoryPort['applyImport']>((batch, checkpoint) => ({
    operationId: batch.run.importRunId, outcome: 'committed', sessionsInserted: batch.sessions.length,
    eventsInserted: batch.events.length, checkpoint: { ...checkpoint },
  }));
  const repository: SessionRepositoryPort = {
    getCheckpoint: () => null, getBatchCheckpoint: () => null, commitStagedImports: () => 0, applyImport,
  };
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    const receipts = await new IncrementalSessionImporter(repository).import({
      source, selectedSource: { sourceId: source.sourceId, provider: 'generic', locator: '<fixture>',
        locatorClass: 'fixture', authorizedScope: { workspaceId: 'workspace', allowedRoots: [] } },
      adapter, workspaceId: 'workspace', policyVersion: '1.0.0', limits: { batchSize: 2 },
    });
    expect(records.map(record => stringify.mock.calls.filter(call => call[0] === record).length)).toEqual([2, 2, 2]);
    for (const [batchIndex, [start, end]] of [[0, 2], [2, 3]].entries()) {
      const expectedRun = sha256([source.sourceId, adapter.adapterVersion, start, end, ...digests.slice(start, end)].join('\0'));
      const batch = applyImport.mock.calls[batchIndex][0];
      expect(batch.run.importRunId).toBe(expectedRun);
      expect(batch.events.map(event => event.digest)).toEqual(digests.slice(start, end));
      expect(batch.events.map(event => event.searchableText)).toEqual(finalRecords.slice(start, end).map(record => record.text));
      expect(batch.events.map(event => event.eventId)).toEqual(finalRecords.slice(start, end).map((record, i) => stableEventId('generic', source.sourceId, record, digests[start + i])));
      expect(batch.events.map(event => (event.extensions['native.generic'] as { status: string }).status)).toEqual(finalRecords.slice(start, end).map(record => record.extensions!.status));
      expect(receipts[batchIndex].checkpoint).toMatchObject({ recordsRead: end, bytesRead: serialized.slice(0, end).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) });
      expect(receipts[batchIndex].metrics?.normalizedBytes).toBe(committed.slice(start, end).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0));
    }
  } finally { stringify.mockRestore(); }
});
