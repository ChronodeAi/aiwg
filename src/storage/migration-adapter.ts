// Bridges text storage adapters to protocol records and single-record commits.
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFrontmatter } from '../artifacts/index-builder.js';
import type { StorageAdapter } from './types.js';
import type { MigrationEndpointIdentity } from './migration-types.js';
import type { MigrationCopyEndpoint } from './migration-copy.js';
import { digestRecords, sha256 } from './migration-records.js';

export function migrationEndpoint(adapter: StorageAdapter, identity: MigrationEndpointIdentity): MigrationCopyEndpoint {
  const readRecord: MigrationCopyEndpoint['readRecord'] = async path => {
    const value = await adapter.read(path);
    if (value === null) return null;
    const digest = sha256(value);
    return { identity: { tenant: identity.tenant, subsystem: identity.subsystem, path }, value, digest, sourceRevision: digest };
  };
  const readAll = async () => {
    const records = [];
    for (const { path } of await adapter.list('')) {
      const record = await readRecord(path);
      if (record === null) throw new Error(`source changed during enumeration: ${path} (read returned null)`);
      records.push(record);
    }
    return records;
  };
  return {
    identity, readRecord, readAll,
    async snapshot() {
      const records = await readAll();
      return { id: randomUUID(), highWaterMark: digestRecords(records), records };
    },
    async commitBatch(mutations) {
      // Baseline adapters provide single-path idempotent writes, not multi-path transactions.
      if (mutations.length !== 1) throw new Error('storage adapter copy requires single-record batches');
      const mutation = mutations[0];
      const path = mutation.record.identity.path;
      if ((await readRecord(path))?.sourceRevision !== mutation.expectedRevision) {
        throw new Error(`destination changed before commit: ${path}`);
      }
      if (mutation.operation === 'delete') await adapter.delete(path);
      else await adapter.write(path, mutation.record.value!, migrationMetadata(path, mutation.record.value!));
      const committed = await readRecord(path);
      if (mutation.operation === 'delete' && committed !== null) throw new Error(`delete not applied: ${path}`);
      if (mutation.operation === 'upsert' && committed === null) throw new Error(`write not applied: ${path}`);
      return {
        batchId: randomUUID(), committed: true, highWaterMark: mutation.record.sourceRevision,
        recordReceipts: [{ identity: mutation.record.identity, digest: mutation.record.digest,
          sourceRevision: committed?.sourceRevision ?? mutation.record.sourceRevision }],
      };
    },
  };
}

const TEXT_CORPUS_EXTENSIONS = new Set([
  '.bib',
  '.csv',
  '.htm',
  '.html',
  '.json',
  '.md',
  '.ris',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export function isTextCorpusEntry(entryPath: string): boolean {
  return TEXT_CORPUS_EXTENSIONS.has(extname(entryPath).toLowerCase());
}

export function migrationMetadata(entryPath: string, content: string) {
  const extension = extname(entryPath).toLowerCase();
  const contentType = extension === '.md' ? 'text/markdown' : 'text/plain';
  if (extension !== '.md') return { contentType };
  return { contentType, frontmatter: parseFrontmatter(content).data };
}
