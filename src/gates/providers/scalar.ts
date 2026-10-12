import type { MetricObservation } from '../types.js';
import { providerSourceDigest, requireRecords, type MetricProvider } from './types.js';

export interface ScalarRecord {
  slice: string;
  value: number;
}

/**
 * Core scalar provider: per-slice mean, extrema and raw differences from numeric records.
 * Powers `value-threshold` gates (mean) and `bootstrap-bound` gates (differences).
 */
export const scalarProvider: MetricProvider<ScalarRecord> = {
  id: 'test.scalar/v1',
  version: '1.0.0',
  description: 'Per-slice mean and raw values from numeric records.',
  metrics: {
    'measurement': { kind: 'scalar', description: 'Mean value per slice.' },
    'delta': { kind: 'differences', description: 'Raw per-record values per slice.' },
  },
  sourceDigest: providerSourceDigest({ id: 'test.scalar/v1', version: '1.0.0',
    metrics: { 'measurement': { kind: 'scalar' }, 'delta': { kind: 'differences' } } }),
  compute(records: readonly ScalarRecord[]) {
    const rows = requireRecords(records, 'scalar');
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      if (!row || typeof row.slice !== 'string' || !row.slice.trim()
        || typeof row.value !== 'number' || !Number.isFinite(row.value)) {
        throw new Error('scalar records require a nonempty slice and a finite value');
      }
      groups.set(row.slice, [...(groups.get(row.slice) ?? []), row.value]);
    }
    const measurement: Record<string, MetricObservation> = {};
    const delta: Record<string, MetricObservation> = {};
    for (const [slice, values] of groups) {
      measurement[slice] = { n: values.length, value: values.reduce((sum, value) => sum + value, 0) / values.length };
      delta[slice] = { n: values.length, differences: [...values] };
    }
    const all = [...groups.values()].flat();
    const mean = (values: number[]): MetricObservation | null => values.length
      ? { n: values.length, value: values.reduce((sum, value) => sum + value, 0) / values.length } : null;
    return { version: '1.0.0', sourceDigest: scalarProvider.sourceDigest, metrics: {
      'measurement': { bySlice: measurement, pooled: mean(all) },
      'delta': { bySlice: delta, pooled: all.length ? { n: all.length, differences: all } : null },
    } };
  },
};
