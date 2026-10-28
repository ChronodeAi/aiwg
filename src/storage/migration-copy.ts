// Plans and checkpoints copy-only migrations without changing backend routing.
import { randomUUID } from 'node:crypto';
import type { VersionedRecord } from './backend-contract.js';
import {
  STORAGE_MIGRATION_PROTOCOL, MigrationProtocolError,
  type MigrationEndpoint, type MigrationEndpointIdentity, type MigrationRecordReceipt,
} from './migration-types.js';
import { commitMigrationRecords, sha256, stableStringify } from './migration-records.js';

export type MigrationCopyAction = 'copied' | 'recopied' | 'deleted' | 'skipped' | 'errored';
export interface MigrationCopyItem {
  path: string;
  reason: string;
}
export interface MigrationCopyPlanItem extends MigrationCopyItem {
  action: Exclude<MigrationCopyAction, 'errored'>;
  sourceDigest?: string;
  destinationRevision?: string;
  /** A delete is authorized only for an unchanged, previously copied destination. */
  deleteAuthorized?: boolean;
}
export type MigrationCopyReceipt = Record<MigrationCopyAction, MigrationCopyItem[]>;
export interface MigrationCopyCheckpoint {
  protocol: typeof STORAGE_MIGRATION_PROTOCOL;
  migrationId: string;
  source: MigrationEndpointIdentity;
  destination: MigrationEndpointIdentity;
  records: MigrationRecordReceipt[];
  plan: MigrationCopyPlanItem[];
  receipt: MigrationCopyReceipt;
}
export interface MigrationCopyEndpoint extends MigrationEndpoint<string> {
  readRecord(path: string): Promise<VersionedRecord<string> | null>;
}
export interface MigrationCopyRequest {
  source: MigrationCopyEndpoint;
  destination: MigrationCopyEndpoint;
  checkpoint?: MigrationCopyCheckpoint;
  save(checkpoint: MigrationCopyCheckpoint): Promise<void>;
  report?(action: MigrationCopyAction, item: MigrationCopyItem): Promise<void>;
  exclude?(path: string): string | undefined;
  dryRun?: boolean;
}

export async function runMigrationCopy(request: MigrationCopyRequest): Promise<MigrationCopyCheckpoint> {
  const { source, destination } = request;
  const prior = request.checkpoint;
  if (prior && (prior.protocol !== STORAGE_MIGRATION_PROTOCOL || !prior.migrationId ||
    stableStringify(prior.source) !== stableStringify(source.identity) ||
    stableStringify(prior.destination) !== stableStringify(destination.identity))) {
    throw new MigrationProtocolError('AIWG_MIGRATION_CHECKPOINT_MISMATCH', 'copy checkpoint does not match migration endpoints');
  }
  const latest = new Map(prior?.records.map(record => [record.identity.path, record]));
  const sourceRecords = (await source.snapshot()).records;
  // Preview must remain usable without connecting to the destination (e.g. corpus ingest).
  const destinationRecords = request.dryRun ? [] : (await destination.snapshot()).records;
  const sources = new Map(sourceRecords.map(record => [record.identity.path, record]));
  const destinations = new Map(destinationRecords.map(record => [record.identity.path, record]));
  const plan: MigrationCopyPlanItem[] = [];
  for (const record of sourceRecords) {
    const path = record.identity.path;
    const previous = latest.get(path);
    const current = destinations.get(path);
    const excluded = request.exclude?.(path);
    const unchanged = previous && !previous.tombstone && previous.contentDigest === record.digest &&
      previous.sourceRevision === record.sourceRevision &&
      (request.dryRun || current?.sourceRevision === previous.destinationRevision);
    plan.push({
      path, sourceDigest: record.digest, destinationRevision: current?.sourceRevision,
      action: excluded || unchanged ? 'skipped' : previous ? 'recopied' : 'copied',
      reason: excluded ?? (unchanged ? 'already migrated, skipped' : previous ?
        previous.contentDigest !== record.digest || previous.sourceRevision !== record.sourceRevision ? 'source changed since checkpoint' : 'destination changed since checkpoint' :
        'not yet migrated'),
    });
  }
  for (const record of destinationRecords) {
    const path = record.identity.path;
    if (sources.has(path)) continue;
    const previous = latest.get(path);
    const excluded = request.exclude?.(path);
    const authorized = !excluded && previous !== undefined && !previous.tombstone &&
      record.sourceRevision === previous.destinationRevision;
    plan.push({
      path, action: authorized ? 'deleted' : 'skipped', deleteAuthorized: authorized,
      destinationRevision: record.sourceRevision,
      reason: excluded ?? (authorized ? 'source removed; unchanged migration-owned destination' :
        !previous || previous.tombstone ? 'delete not authorized: destination has no live migration receipt' :
          'delete not authorized: destination changed since checkpoint'),
    });
  }
  plan.sort((a, b) => a.path.localeCompare(b.path));
  const checkpoint: MigrationCopyCheckpoint = {
    protocol: STORAGE_MIGRATION_PROTOCOL, migrationId: prior?.migrationId ?? randomUUID(),
    source: source.identity, destination: destination.identity,
    records: structuredClone(prior?.records ?? []), plan,
    receipt: { copied: [], recopied: [], deleted: [], skipped: [], errored: [] },
  };
  if (!request.dryRun) await request.save(structuredClone(checkpoint));
  for (const item of plan) {
    let action: MigrationCopyAction = item.action;
    let reason = item.reason;
    if (!request.dryRun && action !== 'skipped') {
      try {
        const sourceNow = await source.readRecord(item.path);
        const destinationNow = await destination.readRecord(item.path);
        if (destinationNow?.sourceRevision !== item.destinationRevision) {
          action = 'skipped';
          reason = 'destination changed after plan; retry to replan';
        } else if (item.action === 'deleted' && (!item.deleteAuthorized || sourceNow)) {
          action = 'skipped';
          reason = 'delete not authorized: source reappeared or plan denies deletion';
        } else if (item.action !== 'deleted' && sourceNow?.tombstone) {
          action = 'skipped';
          reason = 'delete not authorized: source tombstone is not a planned delete';
        } else if (item.action !== 'deleted' && sourceNow?.digest !== item.sourceDigest) {
          action = 'skipped';
          reason = 'source changed after plan; retry to replan';
        } else {
          const record: VersionedRecord<string> = item.action === 'deleted' ? {
            identity: destinationNow!.identity, sourceRevision: `deleted:${item.destinationRevision}`,
            digest: sha256(`deleted:${item.destinationRevision}`),
            tombstone: { deletedAt: new Date().toISOString(), reason },
          } : sourceNow!;
          const committed = await commitMigrationRecords(
            `${checkpoint.migrationId}:${checkpoint.records.length}`, [record],
            () => item.destinationRevision, mutations => destination.commitBatch(mutations), () => new Date(),
          );
          checkpoint.records.push(...committed.records);
        }
      } catch (error) {
        action = 'errored';
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    const receiptItem = { path: item.path, reason };
    checkpoint.receipt[action].push(receiptItem);
    // A failed checkpoint write stops the run: no later writes may outrun durable progress.
    if (!request.dryRun) await request.save(structuredClone(checkpoint));
    await request.report?.(action, receiptItem);
  }
  return checkpoint;
}
