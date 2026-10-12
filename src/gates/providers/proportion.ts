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

/** Per-metric per-slice tallies shared by the proportion providers. */
export type ProportionTallies = Map<string, Map<string, { n: number; events: number }>>;

/**
 * Tallies binary records per metric and slice. Records outside `allowed`
 * throw: undeclared metric names fail closed at compute time.
 */
export function tallyProportionRecords(
  rows: readonly ProportionRecord[], allowed: ReadonlySet<string>, label: string,
): ProportionTallies {
  const tables: ProportionTallies = new Map();
  for (const row of rows) {
    if (!row || typeof row.slice !== 'string' || !row.slice.trim() || typeof row.event !== 'boolean'
      || typeof row.metric !== 'string' || !allowed.has(row.metric)) {
      throw new Error(`${label} records require a nonempty slice, a declared metric and a boolean event`);
    }
    const table = tables.get(row.metric) ?? new Map<string, { n: number; events: number }>();
    const current = table.get(row.slice) ?? { n: 0, events: 0 };
    table.set(row.slice, { n: current.n + 1, events: current.events + (row.event ? 1 : 0) });
    tables.set(row.metric, table);
  }
  return tables;
}

/** Builds one metric series per tally table, pooling slices into an overall observation. */
export function proportionSeries(tables: ProportionTallies, names: readonly string[]) {
  const series = (table: Map<string, { n: number; events: number }> | undefined) => {
    const bySlice: Record<string, MetricObservation> = {};
    for (const [slice, counts] of table ?? []) bySlice[slice] = { ...counts };
    const pooled = Object.values(bySlice).reduce<MetricObservation | null>((sum, observation) => ({
      n: (sum?.n as number ?? 0) + (observation.n as number),
      events: (sum?.events as number ?? 0) + (observation.events as number),
    }), Object.keys(bySlice).length ? { n: 0, events: 0 } : null);
    return { bySlice, pooled };
  };
  return Object.fromEntries(names.map(name => [name, series(tables.get(name))]));
}

/**
 * Core proportion provider with a fixed metric vocabulary: each record names
 * its metric, and undeclared metric names fail closed at compute time. Powers
 * `interval-bound` (wilson, clopper-pearson), `count-max` / `count-min` and
 * `minimum-n` gates.
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
    const tables = tallyProportionRecords(rows, new Set(['false-ready', 'coverage']), 'proportion');
    return { version: '1.0.0', sourceDigest: proportionProvider.sourceDigest,
      metrics: proportionSeries(tables, ['false-ready', 'coverage']) };
  },
};
