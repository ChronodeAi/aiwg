// Record digests, validation and retry helpers for storage migration.
import { createHash } from 'node:crypto';
import type { AtomicMutation, BatchReceipt, LogicalRecordIdentity, VersionedRecord } from './backend-contract.js';
import {
  STORAGE_MIGRATION_PROTOCOL, MigrationProtocolError, type MigrationManifest,
  type MigrationEndpointIdentity, type MigrationBoundaryReceipt, type MigrationBoundaryState,
  type MigrationRecordReceipt, type MigrationVerification, type MigrationSemanticVerification,
} from './migration-types.js';

export function digestRecords<T>(records: readonly VersionedRecord<T>[]): string {
  const normalized = [...records]
    .map(record => ({
      identity: record.identity,
      sourceRevision: record.sourceRevision,
      digest: record.digest,
      tombstone: record.tombstone ?? null,
    }))
    .sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
  return sha256(stableStringify(normalized));
}

export function digestRecordChunks<T>(records: readonly VersionedRecord<T>[], chunkSize: number): string[] {
  const sorted = [...records].sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
  return chunk(sorted, chunkSize).map(recordsInChunk => digestRecords(recordsInChunk));
}

export function approvalDigest(manifest: MigrationManifest): string {
  const copy = structuredClone(manifest);
  delete copy.digests.approval;
  return sha256(stableStringify(copy));
}

export function validateManifest(
  manifest: MigrationManifest,
  source?: MigrationEndpointIdentity,
  destination?: MigrationEndpointIdentity,
): void {
  if (manifest.protocol !== STORAGE_MIGRATION_PROTOCOL) {
    throw new MigrationProtocolError('AIWG_MIGRATION_PROTOCOL_UNSUPPORTED', `unsupported migration protocol ${String(manifest.protocol)}`);
  }
  if (!manifest.migrationId || !manifest.snapshot?.id || !manifest.digests?.source) {
    throw new MigrationProtocolError('AIWG_MIGRATION_MANIFEST_CORRUPT', 'migration manifest is missing required identity or digest fields');
  }
  if (!manifest.boundaries?.initial) {
    throw new MigrationProtocolError('AIWG_MIGRATION_BOUNDARY_MISSING', 'migration manifest has no durable source boundary receipt');
  }
  assertBoundaryState(
    manifest.boundaries.initial,
    manifest.mode === 'offline' ? 'quiesced' : 'tracking',
    'initial',
  );
  if (source && stableStringify(manifest.source) !== stableStringify(source)) {
    throw new MigrationProtocolError('AIWG_MIGRATION_SOURCE_MISMATCH', 'manifest source does not match the active source');
  }
  if (destination && stableStringify(manifest.destination) !== stableStringify(destination)) {
    throw new MigrationProtocolError('AIWG_MIGRATION_DESTINATION_MISMATCH', 'manifest destination does not match the active destination');
  }
}

export function assertBoundaryState(
  boundary: MigrationBoundaryReceipt,
  expected: MigrationBoundaryState,
  stage: 'initial' | 'final',
): void {
  if (!boundary.boundaryId || !boundary.establishedAt || boundary.state !== expected) {
    throw new MigrationProtocolError(
      'AIWG_MIGRATION_BOUNDARY_INVALID',
      `${stage} source boundary must provide a durable ${expected} receipt`,
    );
  }
}

export function mutationFor<T>(migrationId: string, record: VersionedRecord<T>, expectedRevision?: string): AtomicMutation<T> {
  return {
    operation: record.tombstone ? 'delete' : 'upsert',
    record,
    idempotencyKey: sha256(`${migrationId}\0${recordKey(record)}`),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

export function revisionConflict(identity: string, revision: string): MigrationProtocolError {
  return new MigrationProtocolError(
    'AIWG_MIGRATION_REVISION_CONFLICT',
    `source revision ${revision} has conflicting content for ${identity}`,
  );
}

export function compareRevisions(comparator: (left: string, right: string) => number, left: string, right: string): number {
  const result = comparator(left, right);
  if (!Number.isFinite(result)) {
    throw new MigrationProtocolError('AIWG_MIGRATION_REVISION_ORDER_INVALID', 'source-revision comparator returned a non-finite result');
  }
  return Math.sign(result);
}

export function recordMap<T>(records: readonly VersionedRecord<T>[]): Map<string, VersionedRecord<T>> {
  return new Map(records.map(record => [identityKey(record.identity), record]));
}

export function identityKey(identity: LogicalRecordIdentity): string {
  return `${identity.tenant}\0${identity.subsystem}\0${identity.path}`;
}

export function recordKey<T>(record: VersionedRecord<T>): string {
  return `${identityKey(record.identity)}\0${record.sourceRevision}\0${record.digest}`;
}

export function receiptKey(receipt: MigrationRecordReceipt): string {
  return `${identityKey(receipt.identity)}\0${receipt.sourceRevision}\0${receipt.contentDigest}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function boundedInteger(raw: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const value = raw ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MigrationProtocolError('AIWG_MIGRATION_INVALID_OPTION', `${label} must be an integer from ${min} through ${max}`);
  }
  return value;
}

export function summarizeVerificationFailure(verification: MigrationVerification): string {
  const semanticFailures = Object.values(verification.semantic).filter(check => !check.valid).length;
  return `migration parity failed: missing=${verification.missing.length} unexpected=${verification.unexpected.length} corrupt=${verification.corrupt.length} chunks=${verification.chunks.valid ? 'valid' : 'invalid'} semantic=${semanticFailures} lag=${verification.lag}`;
}

export function validateSemanticVerification(verification: MigrationSemanticVerification): void {
  for (const dimension of [
    'schema', 'constraints', 'countsByType', 'edgeIntegrity', 'queryParity', 'traversalParity',
  ] as const) {
    const check = verification?.[dimension];
    if (!check || typeof check.valid !== 'boolean' || !Number.isInteger(check.declared) || check.declared < 0 ||
      !Number.isInteger(check.checked) || check.checked < 0 || check.checked !== check.declared || !Array.isArray(check.failures)) {
      throw new MigrationProtocolError(
        'AIWG_MIGRATION_SEMANTIC_VERIFICATION_INVALID',
        `semantic verification is incomplete for ${dimension}`,
      );
    }
    if (check.valid !== (check.failures.length === 0)) {
      throw new MigrationProtocolError(
        'AIWG_MIGRATION_SEMANTIC_VERIFICATION_INVALID',
        `semantic verification validity disagrees with failures for ${dimension}`,
      );
    }
    if (check.evidenceDigest !== undefined && !/^[0-9A-Za-z._:-]+$/.test(check.evidenceDigest)) {
      throw new MigrationProtocolError(
        'AIWG_MIGRATION_SEMANTIC_VERIFICATION_INVALID',
        `semantic verification evidence digest is invalid for ${dimension}`,
      );
    }
    if (['schema', 'constraints', 'queryParity'].includes(dimension) && check.declared < 1) {
      throw new MigrationProtocolError(
        'AIWG_MIGRATION_SEMANTIC_VERIFICATION_INVALID',
        `semantic verification must exercise at least one ${dimension} check`,
      );
    }
    if (dimension === 'countsByType') {
      if (!isCountMap(check.sourceCounts) || !isCountMap(check.destinationCounts)) {
        throw new MigrationProtocolError(
          'AIWG_MIGRATION_SEMANTIC_VERIFICATION_INVALID',
          'countsByType must include non-negative integer source and destination maps',
        );
      }
      const declaredTypes = new Set([...Object.keys(check.sourceCounts), ...Object.keys(check.destinationCounts)]).size;
      if (check.declared !== declaredTypes || (check.valid && stableStringify(check.sourceCounts) !== stableStringify(check.destinationCounts))) {
        throw new MigrationProtocolError(
          'AIWG_MIGRATION_SEMANTIC_VERIFICATION_INVALID',
          'countsByType scope or validity does not match its declared maps',
        );
      }
    }
  }
}

export function semanticIsValid(verification: MigrationSemanticVerification): boolean {
  return Object.values(verification).every(check => check.valid);
}

export function isCountMap(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every(count => Number.isInteger(count) && count >= 0);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise(resolve => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new MigrationProtocolError('AIWG_MIGRATION_CANCELLED', 'migration cancelled by operator'));
    }, { once: true });
  });
}

/** Shared batch mutation and receipt validation for copy-only and cutover migrations. */
export async function commitMigrationRecords<T>(
  migrationId: string,
  records: readonly VersionedRecord<T>[],
  expectedRevision: (record: VersionedRecord<T>) => string | undefined,
  commit: (mutations: readonly AtomicMutation<T>[]) => Promise<BatchReceipt>,
  now: () => Date,
): Promise<{ batch: BatchReceipt; records: MigrationRecordReceipt[] }> {
  const mutations = records.map(record => mutationFor(migrationId, record, expectedRevision(record)));
  const batch = await commit(mutations);
  if (!batch.committed || batch.recordReceipts.length !== records.length) {
    throw new MigrationProtocolError('AIWG_MIGRATION_INVALID_RECEIPT', 'destination returned an invalid batch receipt');
  }
  const committedByIdentity = new Map(batch.recordReceipts.map(receipt => [identityKey(receipt.identity), receipt]));
  const committedAt = now().toISOString();
  const receipts = records.map((record, index) => {
    const committed = committedByIdentity.get(identityKey(record.identity));
    if (!committed || committed.digest !== record.digest) {
      throw new MigrationProtocolError('AIWG_MIGRATION_CORRUPT_RECEIPT', `destination receipt diverged for ${identityKey(record.identity)}`);
    }
    return {
      identity: record.identity, sourceRevision: record.sourceRevision, contentDigest: record.digest,
      destinationRevision: committed.sourceRevision, tombstone: Boolean(record.tombstone),
      idempotencyKey: mutations[index].idempotencyKey, batchId: batch.batchId, committedAt,
    };
  });
  return { batch, records: receipts };
}
