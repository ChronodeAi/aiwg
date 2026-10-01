import { artifactDigest } from '../../decision/validate.js';
import type { GateMetricsDocument, MetricKind, MetricObservation, Sha256Digest } from '../types.js';

/**
 * A metric provider is a registered TypeScript module that computes a `GateMetricsDocument`
 * section from caller-supplied records. Packs stay declarative: they name the provider id
 * and metric name, never code. Addon and extension providers ship through this same
 * interface in a later issue (#2831); only core-registered modules load in v1alpha1.
 */
export interface MetricProvider<TRecord = unknown> {
  id: string;
  version: string;
  description: string;
  metrics: Record<string, { kind: MetricKind; description: string }>;
  /** Canonical digest of the provider descriptor. Pinned in every binding; a descriptor change changes the binding digest. */
  sourceDigest: Sha256Digest;
  compute(records: readonly TRecord[]): GateMetricsDocument['providers'][string];
}

export function providerSourceDigest(descriptor: { id: string; version: string; metrics: unknown }): Sha256Digest {
  return artifactDigest(descriptor);
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
