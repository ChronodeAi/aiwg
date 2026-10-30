// Coordinates protocol migration, copy checkpoints and backend cutover.
import { randomUUID } from 'node:crypto';
import type { VersionedRecord } from './backend-contract.js';
import {
  MigrationProtocolError, STORAGE_MIGRATION_PROTOCOL,
  type MigrationEndpoint, type MigrationManifestStore, type MigrationRoutingControl,
  type MigrationRunOptions, type MigrationManifest, type MigrationSnapshot,
  type MigrationVerification, type MigrationRecordReceipt,
} from './migration-types.js';
import {
  boundedInteger, digestRecords, assertBoundaryState, validateManifest, summarizeVerificationFailure,
  sha256, stableStringify, approvalDigest, recordMap, digestRecordChunks, validateSemanticVerification,
  semanticIsValid, receiptKey, identityKey, recordKey, compareRevisions, revisionConflict, chunk,
  commitMigrationRecords, isRetryableError, errorMessage, abortableDelay,
} from './migration-records.js';
import { runMigrationCopy, type MigrationCopyRequest } from './migration-copy.js';
export * from './migration-types.js';
export type { MigrationCopyCheckpoint, MigrationCopyPlanItem, MigrationCopyReceipt } from './migration-copy.js';
export { digestRecords, digestRecordChunks, approvalDigest, validateManifest } from './migration-records.js';

export class StorageMigrationCoordinator<T> {
  /** Copy-only CLI workflow: digest-aware resume and plan-authorized deletes, without cutover. */
  static copy(request: MigrationCopyRequest) {
    return runMigrationCopy(request);
  }

  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly rollbackWindowMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly source: MigrationEndpoint<T>,
    private readonly destination: MigrationEndpoint<T>,
    private readonly store: MigrationManifestStore,
    private readonly routing: MigrationRoutingControl,
    private readonly options: MigrationRunOptions<T>,
  ) {
    this.batchSize = boundedInteger(options.batchSize, 100, 1, 10_000, 'batchSize');
    this.concurrency = boundedInteger(options.concurrency, 4, 1, 32, 'concurrency');
    this.maxRetries = boundedInteger(options.maxRetries, 5, 0, 20, 'maxRetries');
    this.baseBackoffMs = boundedInteger(options.baseBackoffMs, 25, 1, 60_000, 'baseBackoffMs');
    this.rollbackWindowMs = boundedInteger(options.rollbackWindowMs, 86_400_000, 1, 31_536_000_000, 'rollbackWindowMs');
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    if (options.mode === 'online' && !options.compareSourceRevisions) {
      throw new MigrationProtocolError(
        'AIWG_MIGRATION_REVISION_ORDER_REQUIRED',
        'online migration requires a source-revision comparator',
      );
    }
  }

  async preview(): Promise<MigrationManifest> {
    this.throwIfAborted();
    const boundary = await this.options.safety.prepare(
      this.options.mode,
      this.source.identity,
      this.options.signal,
    );
    try {
      assertBoundaryState(boundary, this.options.mode === 'offline' ? 'quiesced' : 'tracking', 'initial');
    } catch (error) {
      await this.options.safety.release(boundary, 'failed');
      throw error;
    }
    let snapshot: MigrationSnapshot<T>;
    try {
      snapshot = await this.source.snapshot(this.options.signal);
    } catch (error) {
      await this.options.safety.release(boundary, 'failed');
      throw error;
    }
    const createdAt = this.now().toISOString();
    const sourceDigest = digestRecords(snapshot.records);
    const manifest: MigrationManifest = {
      protocol: STORAGE_MIGRATION_PROTOCOL,
      migrationId: randomUUID(),
      mode: this.options.mode,
      state: 'preview',
      source: this.source.identity,
      destination: this.destination.identity,
      toolVersion: this.options.toolVersion,
      createdAt,
      updatedAt: createdAt,
      snapshot: {
        id: snapshot.id,
        highWaterMark: snapshot.highWaterMark,
        ...(snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor }),
      },
      checkpoint: { highWaterMark: snapshot.highWaterMark, committedBatches: 0 },
      counts: {
        source: snapshot.records.length,
        upserts: snapshot.records.filter(record => !record.tombstone).length,
        tombstones: snapshot.records.filter(record => record.tombstone).length,
        committed: 0,
      },
      digests: { source: sourceDigest },
      records: [],
      boundaries: { initial: boundary },
    };
    try {
      await this.store.save(manifest);
    } catch (error) {
      await this.options.safety.release(boundary, 'failed');
      throw error;
    }
    return manifest;
  }

  async apply(manifest: MigrationManifest): Promise<MigrationManifest> {
    validateManifest(manifest, this.source.identity, this.destination.identity);
    try {
      const snapshot = await this.source.snapshot(this.options.signal);
      if (digestRecords(snapshot.records) !== manifest.digests.source) {
        throw new MigrationProtocolError(
          'AIWG_MIGRATION_SNAPSHOT_CHANGED',
          'source snapshot no longer matches the preview; create a new preview',
        );
      }
      manifest.state = 'copying';
      await this.persist(manifest);
      await this.copyRecords(snapshot.records, manifest);

      if (manifest.mode === 'online') {
        if (!this.source.changes) {
          throw new MigrationProtocolError(
            'AIWG_MIGRATION_CURSOR_UNAVAILABLE',
            'online migration requires a source change cursor',
          );
        }
        manifest.state = 'replaying';
        await this.persist(manifest);
        await this.replayChanges(manifest);
      }

      const finalBoundary = await this.options.safety.freeze(manifest, this.options.signal);
      manifest.boundaries.final = finalBoundary;
      assertBoundaryState(finalBoundary, 'quiesced', 'final');
      await this.persist(manifest);
      if (manifest.mode === 'online') await this.replayChanges(manifest);

      manifest.state = 'verifying';
      await this.persist(manifest);
      const verification = await this.verify(manifest);
      if (!verification.valid) {
        throw new MigrationProtocolError('AIWG_MIGRATION_PARITY_FAILED', summarizeVerificationFailure(verification));
      }
      manifest.digests.destination = verification.destinationDigest;
      manifest.verification = verification;
      manifest.digests.verification = sha256(stableStringify(verification));
      manifest.state = 'awaiting-approval';
      manifest.updatedAt = this.now().toISOString();
      manifest.digests.approval = approvalDigest(manifest);
      await this.save(manifest);
      return manifest;
    } catch (error) {
      const stage = manifest.state;
      manifest.state = 'failed';
      manifest.failure = { stage, message: errorMessage(error) };
      try {
        await this.persist(manifest);
      } catch {
        // Preserve the triggering failure; the manifest store error is already observable at its source.
      }
      await this.options.safety.release(
        manifest.boundaries.final ?? manifest.boundaries.initial,
        'failed',
      );
      throw error;
    }
  }

  async verify(manifest: MigrationManifest): Promise<MigrationVerification> {
    const [sourceRecords, destinationRecords] = await Promise.all([
      this.source.readAll(this.options.signal),
      this.destination.readAll(this.options.signal),
    ]);
    const sourceMap = recordMap(sourceRecords);
    const destinationMap = recordMap(destinationRecords);
    const missing = [...sourceMap.keys()].filter(key => !destinationMap.has(key)).sort();
    const unexpected = [...destinationMap.keys()].filter(key => !sourceMap.has(key)).sort();
    const corrupt = [...sourceMap.entries()]
      .filter(([key, record]) => {
        const destination = destinationMap.get(key);
        return destination !== undefined && (
          destination.sourceRevision !== record.sourceRevision ||
          destination.digest !== record.digest ||
          Boolean(destination.tombstone) !== Boolean(record.tombstone)
        );
      })
      .map(([key]) => key)
      .sort();
    const boundaryReady = manifest.boundaries.final?.state === 'quiesced';
    const lag = Number(!boundaryReady || (manifest.mode === 'online' && !manifest.checkpoint.drained));
    const sourceDigest = digestRecords(sourceRecords);
    const destinationDigest = digestRecords(destinationRecords);
    const sourceChunks = digestRecordChunks(sourceRecords, this.batchSize);
    const destinationChunks = digestRecordChunks(destinationRecords, this.batchSize);
    const chunks = {
      valid: stableStringify(sourceChunks) === stableStringify(destinationChunks),
      source: sourceChunks,
      destination: destinationChunks,
    };
    const semantic = await this.options.verifier.verify({
      manifest,
      source: this.source,
      destination: this.destination,
      sourceRecords,
      destinationRecords,
      signal: this.options.signal,
    });
    validateSemanticVerification(semantic);
    return {
      valid: missing.length === 0 && unexpected.length === 0 && corrupt.length === 0 && lag === 0 &&
        sourceDigest === destinationDigest && chunks.valid && semanticIsValid(semantic),
      sourceCount: sourceRecords.length,
      destinationCount: destinationRecords.length,
      sourceDigest,
      destinationDigest,
      missing,
      unexpected,
      corrupt,
      lag,
      chunks,
      semantic,
    };
  }

  async cutover(manifest: MigrationManifest, approval: string): Promise<MigrationManifest> {
    validateManifest(manifest, this.source.identity, this.destination.identity);
    if (manifest.state !== 'awaiting-approval') {
      throw new MigrationProtocolError('AIWG_MIGRATION_NOT_READY', 'migration is not awaiting cutover approval');
    }
    const expected = approvalDigest(manifest);
    if (approval !== expected || manifest.digests.approval !== expected) {
      throw new MigrationProtocolError('AIWG_MIGRATION_APPROVAL_MISMATCH', 'cutover approval is not bound to this verified manifest');
    }
    const verification = await this.verify(manifest);
    if (!verification.valid) {
      throw new MigrationProtocolError('AIWG_MIGRATION_PARITY_FAILED', summarizeVerificationFailure(verification));
    }
    if (!manifest.digests.verification || sha256(stableStringify(verification)) !== manifest.digests.verification) {
      throw new MigrationProtocolError(
        'AIWG_MIGRATION_VERIFICATION_CHANGED',
        'migration verification changed after approval; verify and approve a new manifest',
      );
    }
    const finalBoundary = manifest.boundaries.final;
    if (!finalBoundary) {
      throw new MigrationProtocolError('AIWG_MIGRATION_BOUNDARY_MISSING', 'migration has no final quiesced source boundary');
    }
    manifest.state = 'cutover';
    await this.persist(manifest);
    try {
      manifest.routingSwitch = await this.routing.switchAtomically(manifest);
      await this.options.safety.release(finalBoundary, 'cutover');
    } catch (error) {
      await this.routing.restoreSource(manifest);
      await this.options.safety.release(finalBoundary, 'failed');
      manifest.state = 'failed';
      manifest.failure = { stage: 'cutover', message: errorMessage(error) };
      await this.persist(manifest);
      throw new MigrationProtocolError('AIWG_MIGRATION_CUTOVER_FAILED', manifest.failure.message);
    }
    manifest.state = 'observing';
    manifest.rollbackWindowEndsAt = new Date(this.now().getTime() + this.rollbackWindowMs).toISOString();
    await this.persist(manifest);
    return manifest;
  }

  async complete(manifest: MigrationManifest): Promise<MigrationManifest> {
    if (manifest.state !== 'observing') {
      throw new MigrationProtocolError('AIWG_MIGRATION_NOT_OBSERVING', 'migration is not in its rollback window');
    }
    manifest.state = 'completed';
    await this.persist(manifest);
    return manifest;
  }

  async rollback(manifest: MigrationManifest): Promise<MigrationManifest> {
    if (!['cutover', 'observing', 'failed'].includes(manifest.state)) {
      throw new MigrationProtocolError('AIWG_MIGRATION_NOT_ROLLBACKABLE', `cannot roll back state ${manifest.state}`);
    }
    await this.routing.restoreSource(manifest);
    await this.options.safety.release(manifest.boundaries.final ?? manifest.boundaries.initial, 'rollback');
    manifest.state = 'rolled-back';
    await this.persist(manifest);
    return manifest;
  }

  private async copyRecords(records: readonly VersionedRecord<T>[], manifest: MigrationManifest): Promise<void> {
    const completed = new Set(manifest.records.map(receiptKey));
    const latest = new Map<string, MigrationRecordReceipt>();
    for (const receipt of manifest.records) latest.set(identityKey(receipt.identity), receipt);
    const selected = new Map<string, VersionedRecord<T>>();
    for (const record of records) {
      if (completed.has(recordKey(record))) continue;
      const key = identityKey(record.identity);
      const receipt = latest.get(key);
      if (receipt && this.options.compareSourceRevisions) {
        const order = compareRevisions(this.options.compareSourceRevisions, record.sourceRevision, receipt.sourceRevision);
        if (order < 0) continue;
        if (order === 0) {
          if (record.digest !== receipt.contentDigest) throw revisionConflict(key, record.sourceRevision);
          continue;
        }
      }
      const prior = selected.get(key);
      if (!prior) {
        selected.set(key, record);
        continue;
      }
      if (!this.options.compareSourceRevisions) {
        throw new MigrationProtocolError('AIWG_MIGRATION_DUPLICATE_IDENTITY', `snapshot contains multiple records for ${key}`);
      }
      const order = compareRevisions(this.options.compareSourceRevisions, record.sourceRevision, prior.sourceRevision);
      if (order > 0) selected.set(key, record);
      else if (order === 0 && record.digest !== prior.digest) throw revisionConflict(key, record.sourceRevision);
    }
    const pending = [...selected.values()].sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
    const batches = chunk(pending, this.batchSize);
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, batches.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= batches.length) return;
        const batch = batches[index];
        const committed = await commitMigrationRecords(
          manifest.migrationId, batch,
          record => latest.get(identityKey(record.identity))?.destinationRevision,
          mutations => this.retry(
            () => this.destination.commitBatch(mutations, this.options.signal),
            `batch ${index}`,
          ),
          this.now,
        );
        manifest.records.push(...committed.records);
        manifest.counts.committed = manifest.records.length;
        manifest.checkpoint.committedBatches += 1;
        manifest.checkpoint.highWaterMark = committed.batch.highWaterMark;
        await this.persist(manifest);
      }
    });
    await Promise.all(workers);
  }

  private async replayChanges(manifest: MigrationManifest): Promise<void> {
    if (!this.source.changes) {
      throw new MigrationProtocolError(
        'AIWG_MIGRATION_CURSOR_UNAVAILABLE',
        'online migration requires a source change cursor',
      );
    }
    let cursor = manifest.checkpoint.cursor ?? manifest.snapshot.cursor;
    for (;;) {
      this.throwIfAborted();
      const page = await this.source.changes(cursor, this.options.signal);
      await this.copyRecords(page.records, manifest);
      cursor = page.nextCursor ?? page.highWaterMark;
      manifest.checkpoint = {
        ...manifest.checkpoint,
        cursor,
        highWaterMark: page.highWaterMark,
        drained: page.records.length === 0 || page.nextCursor === undefined,
      };
      await this.persist(manifest);
      if (manifest.checkpoint.drained) break;
    }
  }

  private async retry<R>(operation: () => Promise<R>, label: string): Promise<R> {
    let attempt = 0;
    for (;;) {
      this.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        const retryable = isRetryableError(error);
        if (!retryable) throw error;
        if (attempt >= this.maxRetries) {
          throw new MigrationProtocolError(
            'AIWG_MIGRATION_RETRY_EXHAUSTED',
            `${label} failed after ${attempt + 1} attempt(s): ${errorMessage(error)}`,
          );
        }
        const exponential = this.baseBackoffMs * 2 ** attempt;
        const jitter = Math.floor(exponential * 0.25 * this.random());
        await abortableDelay(Math.min(exponential + jitter, 60_000), this.options.signal);
        attempt += 1;
      }
    }
  }

  private async persist(manifest: MigrationManifest): Promise<void> {
    manifest.updatedAt = this.now().toISOString();
    await this.save(manifest);
  }

  private async save(manifest: MigrationManifest): Promise<void> {
    const snapshot = structuredClone(manifest);
    const save = this.persistChain.then(() => this.store.save(snapshot));
    this.persistChain = save.catch(() => undefined);
    await save;
  }

  private throwIfAborted(): void {
    if (this.options.signal?.aborted) {
      throw new MigrationProtocolError('AIWG_MIGRATION_CANCELLED', 'migration cancelled by operator');
    }
  }
}
