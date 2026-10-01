import type { MetricObservation } from '../types.js';
import { providerSourceDigest, requireRecords, type MetricProvider } from './types.js';

export interface ProportionRecord {
  slice: string;
  metric: string;
  event: boolean;
}

const VOCABULARY = {
  'false-ready': { kind: 'proportion', description: 'False-ready events per slice.' },
  'coverage': { kind: 'proportion', description: 'Accepted (advisory-ready) share per slice.' },
} as const;

/**
 * Core proportion provider with a fixed metric vocabulary, mirroring the future
 * `decision.screening/v1` shape: each record names its metric, and undeclared metric
 * names fail closed at compute time. Powers `interval-bound` (wilson, clopper-pearson),
 * `count-max` / `count-min` and `minimum-n` gates.
 */
export const proportionProvider: MetricProvider<ProportionRecord> = {
  id: 'test.proportion/v1',
  version: '1.0.0',
  description: 'Per-slice event counts from binary records with a fixed vocabulary.',
  metrics: {
    'false-ready': { ...VOCABULARY['false-ready'] },
    'coverage': { ...VOCABULARY.coverage },
  },
  sourceDigest: providerSourceDigest({ id: 'test.proportion/v1', version: '1.0.0', metrics: VOCABULARY }),
  compute(records: readonly ProportionRecord[]) {
    const rows = requireRecords(records, 'proportion');
    const tables = new Map<string, Map<string, { n: number; events: number }>>();
    for (const row of rows) {
      if (!row || typeof row.slice !== 'string' || !row.slice.trim() || typeof row.event !== 'boolean'
        || (row.metric !== 'false-ready' && row.metric !== 'coverage')) {
        throw new Error('proportion records require a nonempty slice, a declared metric and a boolean event');
      }
      const table = tables.get(row.metric) ?? new Map<string, { n: number; events: number }>();
      const current = table.get(row.slice) ?? { n: 0, events: 0 };
      table.set(row.slice, { n: current.n + 1, events: current.events + (row.event ? 1 : 0) });
      tables.set(row.metric, table);
    }
    const series = (table: Map<string, { n: number; events: number }> | undefined) => {
      const bySlice: Record<string, MetricObservation> = {};
      for (const [slice, counts] of table ?? []) bySlice[slice] = { ...counts };
      const pooled = Object.values(bySlice).reduce<MetricObservation | null>((sum, observation) => ({
        n: (sum?.n as number ?? 0) + (observation.n as number),
        events: (sum?.events as number ?? 0) + (observation.events as number),
      }), Object.keys(bySlice).length ? { n: 0, events: 0 } : null);
      return { bySlice, pooled };
    };
    return { version: '1.0.0', sourceDigest: proportionProvider.sourceDigest, metrics: {
      'false-ready': series(tables.get('false-ready')),
      'coverage': series(tables.get('coverage')),
    } };
  },
};
