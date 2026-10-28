// Shared contracts for the storage migration protocol.
import type { AtomicMutation, BatchReceipt, LogicalRecordIdentity, VersionedRecord } from './backend-contract.js';

export const STORAGE_MIGRATION_PROTOCOL = 'aiwg.storage-migration/v1' as const;

export type MigrationMode = 'offline' | 'online';
export type MigrationState =
  | 'preview'
  | 'copying'
  | 'replaying'
  | 'verifying'
  | 'awaiting-approval'
  | 'cutover'
  | 'observing'
  | 'completed'
  | 'rolled-back'
  | 'failed';

export interface MigrationEndpointIdentity {
  backend: string;
  instance: string;
  tenant: string;
  subsystem: string;
  schemaVersion: string;
}

export interface MigrationRecordReceipt {
  identity: LogicalRecordIdentity;
  sourceRevision: string;
  contentDigest: string;
  destinationRevision: string;
  tombstone: boolean;
  idempotencyKey: string;
  batchId: string;
  committedAt: string;
}

export interface MigrationManifest {
  protocol: typeof STORAGE_MIGRATION_PROTOCOL;
  migrationId: string;
  mode: MigrationMode;
  state: MigrationState;
  source: MigrationEndpointIdentity;
  destination: MigrationEndpointIdentity;
  toolVersion: string;
  createdAt: string;
  updatedAt: string;
  snapshot: { id: string; highWaterMark: string; cursor?: string };
  checkpoint: { cursor?: string; highWaterMark: string; committedBatches: number; drained?: boolean };
  counts: { source: number; upserts: number; tombstones: number; committed: number };
  digests: { source: string; destination?: string; verification?: string; approval?: string };
  records: MigrationRecordReceipt[];
  boundaries: {
    initial: MigrationBoundaryReceipt;
    final?: MigrationBoundaryReceipt;
  };
  routingSwitch?: MigrationRoutingReceipt;
  verification?: MigrationVerification;
  rollbackWindowEndsAt?: string;
  failure?: { stage: string; message: string };
}

export type MigrationBoundaryState = 'tracking' | 'quiesced';

export interface MigrationBoundaryReceipt {
  boundaryId: string;
  state: MigrationBoundaryState;
  establishedAt: string;
  highWaterMark?: string;
}

export interface MigrationRoutingReceipt {
  switchId: string;
  previousTarget: string;
  activeTarget: string;
  committedAt: string;
}

export interface MigrationSnapshot<T> {
  id: string;
  highWaterMark: string;
  cursor?: string;
  records: readonly VersionedRecord<T>[];
}

export interface MigrationChangePage<T> {
  records: readonly VersionedRecord<T>[];
  nextCursor?: string;
  highWaterMark: string;
}

export interface MigrationEndpoint<T> {
  identity: MigrationEndpointIdentity;
  snapshot(signal?: AbortSignal): Promise<MigrationSnapshot<T>>;
  changes?(cursor: string | undefined, signal?: AbortSignal): Promise<MigrationChangePage<T>>;
  commitBatch(mutations: readonly AtomicMutation<T>[], signal?: AbortSignal): Promise<BatchReceipt>;
  readAll(signal?: AbortSignal): Promise<readonly VersionedRecord<T>[]>;
}

export interface MigrationManifestStore {
  save(manifest: MigrationManifest): Promise<void>;
}

export interface MigrationSafetyControl {
  prepare(
    mode: MigrationMode,
    source: MigrationEndpointIdentity,
    signal?: AbortSignal,
  ): Promise<MigrationBoundaryReceipt>;
  freeze(manifest: MigrationManifest, signal?: AbortSignal): Promise<MigrationBoundaryReceipt>;
  release(
    boundary: MigrationBoundaryReceipt,
    outcome: 'cutover' | 'rollback' | 'failed',
  ): Promise<void>;
}

export interface MigrationRoutingControl {
  switchAtomically(manifest: MigrationManifest): Promise<MigrationRoutingReceipt>;
  restoreSource(manifest: MigrationManifest): Promise<void>;
}

export type MigrationSemanticDimension =
  | 'schema'
  | 'constraints'
  | 'countsByType'
  | 'edgeIntegrity'
  | 'queryParity'
  | 'traversalParity';

export interface MigrationSemanticCheck {
  valid: boolean;
  declared: number;
  checked: number;
  failures: string[];
  evidenceDigest?: string;
  sourceCounts?: Record<string, number>;
  destinationCounts?: Record<string, number>;
}

export type MigrationSemanticVerification = Record<MigrationSemanticDimension, MigrationSemanticCheck>;

export interface MigrationVerifierContext<T> {
  manifest: MigrationManifest;
  source: MigrationEndpoint<T>;
  destination: MigrationEndpoint<T>;
  sourceRecords: readonly VersionedRecord<T>[];
  destinationRecords: readonly VersionedRecord<T>[];
  signal?: AbortSignal;
}

export interface MigrationSemanticVerifier<T> {
  verify(context: MigrationVerifierContext<T>): Promise<MigrationSemanticVerification>;
}

export interface MigrationRunOptions<T = unknown> {
  mode: MigrationMode;
  toolVersion: string;
  batchSize?: number;
  concurrency?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  rollbackWindowMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
  random?: () => number;
  safety: MigrationSafetyControl;
  verifier: MigrationSemanticVerifier<T>;
  /** Required for online mode because source revisions are backend-defined opaque values. */
  compareSourceRevisions?: (left: string, right: string) => number;
}

export interface MigrationVerification {
  valid: boolean;
  sourceCount: number;
  destinationCount: number;
  sourceDigest: string;
  destinationDigest: string;
  missing: string[];
  unexpected: string[];
  corrupt: string[];
  lag: number;
  chunks: { valid: boolean; source: string[]; destination: string[] };
  semantic: MigrationSemanticVerification;
}

export class MigrationProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MigrationProtocolError';
  }
}

