import type { MetricObservation } from '../types.js';
import { providerSourceDigest, requireRecords, type MetricProvider } from './types.js';

export interface EvidenceRecord {
  id: string;
  passed: boolean;
  expiresAt?: string | null;
}

/** Sorted, de-duplicated attestations shared by the evidence providers. */
export function collectAttestations(rows: readonly EvidenceRecord[], label: string) {
  const seen = new Set<string>();
  const available: { id: string; passed: boolean; expiresAt?: string | null }[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || typeof row.passed !== 'boolean'
      || (row.expiresAt !== undefined && row.expiresAt !== null && typeof row.expiresAt !== 'string')
      || seen.has(row.id)) {
      throw new Error(`${label} records require unique nonempty ids, a boolean passed and an optional expiry`);
    }
    seen.add(row.id);
    available.push({ id: row.id, passed: row.passed, ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }) });
  }
  return [...available].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Core evidence provider: required-evidence attestations are caller-asserted records
 * evaluated against the binding clock. Powers `evidence` gates. The provider reports
 * presence, pass state and expiry; the gate decides.
 */
export const evidenceProvider: MetricProvider<EvidenceRecord> = {
  id: 'test.evidence/v1',
  version: '1.0.0',
  description: 'Caller-asserted evidence attestations with pass state and expiry.',
  metrics: {
    'attestations': { kind: 'evidence', description: 'Evidence attestations by id.' },
  },
  sourceDigest: providerSourceDigest({ id: 'test.evidence/v1', version: '1.0.0',
    metrics: { 'attestations': { kind: 'evidence' } } }),
  compute(records: readonly EvidenceRecord[]) {
    const rows = requireRecords(records, 'evidence');
    const pooled: MetricObservation = { available: collectAttestations(rows, 'evidence') };
    return { version: '1.0.0', sourceDigest: evidenceProvider.sourceDigest,
      metrics: { 'attestations': { bySlice: {}, pooled } } };
  },
};
