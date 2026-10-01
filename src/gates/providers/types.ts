import { artifactDigest } from '../../decision/validate.js';
import type { GateMetricsDocument, MetricKind, MetricObservation, Sha256Digest } from '../types.js';

/**
 * A metric provider is a registered TypeScript module that computes a `GateMetricsDocument`
 * section from caller-supplied records. Packs stay declarative: they name the provider id
 * and metric name, never code. Core providers register directly; addon and extension
 * providers load only through `loader.ts` from bundle-manifest `gateProviders`
 * declarations with a verified code digest and review attestation (#2831).
 */
export interface MetricProvider<TRecord = unknown> {
  id: string;
  version: string;
  description: string;
  metrics: Record<string, { kind: MetricKind; description: string }>;
  /** Canonical digest of the provider descriptor. Pinned in every binding; a descriptor change changes the binding digest. */
  sourceDigest: Sha256Digest;
  /**
   * Digest of the provider CODE (module bytes plus resolved local imports and
   * lockfile-pinned externals). Present only for bundle providers loaded via
   * `loader.ts`; core providers leave it undefined and verify by descriptor
   * only. Null never verifies: it fails closed.
   */
  codeDigest?: Sha256Digest;
  compute(records: readonly TRecord[]): GateMetricsDocument['providers'][string];
}

export function providerSourceDigest(descriptor: { id: string; version: string; metrics: unknown }): Sha256Digest {
  return artifactDigest(descriptor);
}

/**
 * An addon/extension bundle provider loaded through the isolated runner
 * (#2831 rework). The provider NEVER executes in-process: `compute` throws
 * and every invocation spawns the permission-restricted child over the
 * private `snapshotDir`. The snapshot holds the pinned provider bytes; the
 * child loads only from it.
 */
export interface BundleMetricProvider<TRecord = unknown> extends MetricProvider<TRecord> {
  codeDigest: Sha256Digest;
  review: { reviewer: string; reviewedAt: string; codeDigest: Sha256Digest };
  bundleId: string;
  modulePath: string;
  /** Private snapshot dir holding the pinned provider bytes (plus harness files). */
  snapshotDir: string;
  /** Bundle-relative posix paths of the snapshotted provider modules. */
  snapshotFiles: string[];
}

/** Isolated re-run inputs for bundle-provider bindings (records binding, P4). */
export interface ProviderRuntime {
  /** Loaded bundle providers (snapshots) available for re-runs. */
  providers: BundleMetricProvider[];
  /** Input records per provider id; each must digest to the binding's records pin. */
  records: Record<string, readonly unknown[]>;
  /** Wall-clock ceiling per re-run spawn (default in loader). */
  timeoutMs?: number;
}

/** Fail-closed record guard shared by core providers. */
export function requireRecords<TRecord>(records: readonly TRecord[], label: string): readonly TRecord[] {
  if (!Array.isArray(records)) throw new Error(`${label} records must be an array`);
  return records;
}

export function pooledFromSlices(slices: Record<string, MetricObservation>): MetricObservation | null {
  const observations = Object.values(slices);
  if (!observations.length) return null;
  const ns = observations.map(observation => observation.n);
  if (ns.some(n => n === null || n === undefined)) return null;
  const total = (ns as number[]).reduce((sum, n) => sum + n, 0);
  const sum = (pick: (observation: MetricObservation) => number | null | undefined): number | null => {
    const values = observations.map(pick);
    return values.every(value => typeof value === 'number') ? (values as number[]).reduce((a, b) => a + b, 0) : null;
  };
  return { n: total, events: sum(observation => observation.events), value: null };
}
