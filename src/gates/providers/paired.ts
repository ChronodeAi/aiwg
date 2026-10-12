import type { MetricObservation } from '../types.js';
import { providerSourceDigest, requireRecords, type MetricProvider } from './types.js';

export interface PairedRecord {
  slice: string;
  candidate: boolean;
  baseline: boolean;
}

/**
 * Core paired provider: builds the 2x2 paired table per slice from candidate/baseline
 * records. Powers `paired-difference` (newcombe, tango; non-inferiority, superiority) gates.
 */
export const pairedProvider: MetricProvider<PairedRecord> = {
  id: 'test.paired/v1',
  version: '1.0.0',
  description: 'Per-slice paired candidate/baseline tables.',
  metrics: {
    'contrast': { kind: 'paired', description: 'Paired 2x2 table per slice.' },
  },
  sourceDigest: providerSourceDigest({ id: 'test.paired/v1', version: '1.0.0',
    metrics: { 'contrast': { kind: 'paired' } } }),
  compute(records: readonly PairedRecord[]) {
    const rows = requireRecords(records, 'paired');
    const cells: Record<string, { both: number; candidateOnly: number; baselineOnly: number; neither: number }> = {};
    for (const row of rows) {
      if (!row || typeof row.slice !== 'string' || !row.slice.trim()
        || typeof row.candidate !== 'boolean' || typeof row.baseline !== 'boolean') {
        throw new Error('paired records require a nonempty slice and boolean candidate/baseline');
      }
      const cell = cells[row.slice] ?? { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
      if (row.candidate && row.baseline) cell.both++;
      else if (row.candidate) cell.candidateOnly++;
      else if (row.baseline) cell.baselineOnly++;
      else cell.neither++;
      cells[row.slice] = cell;
    }
    const bySlice: Record<string, MetricObservation> = {};
    for (const [slice, cell] of Object.entries(cells)) {
      bySlice[slice] = { n: cell.both + cell.candidateOnly + cell.baselineOnly + cell.neither, paired: { ...cell } };
    }
    const total = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
    for (const cell of Object.values(cells)) {
      total.both += cell.both; total.candidateOnly += cell.candidateOnly;
      total.baselineOnly += cell.baselineOnly; total.neither += cell.neither;
    }
    const pooled: MetricObservation | null = Object.keys(bySlice).length
      ? { n: total.both + total.candidateOnly + total.baselineOnly + total.neither, paired: total }
      : null;
    return { version: '1.0.0', sourceDigest: pairedProvider.sourceDigest,
      metrics: { 'contrast': { bySlice, pooled } } };
  },
};
