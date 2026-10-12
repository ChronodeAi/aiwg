import type { MetricObservation } from '../types.js';
import { providerSourceDigest, requireRecords, type MetricProvider } from './types.js';
import type { EvidenceRecord } from './evidence.js';
import { collectAttestations } from './evidence.js';
import type { ProportionRecord } from './proportion.js';
import { proportionSeries, tallyProportionRecords } from './proportion.js';

/**
 * Records for the screening provider: binary per-slice events (the
 * `ProportionRecord` shape) and calibration attestations (the `EvidenceRecord`
 * shape). A record carrying both an `id` and a `metric` is ambiguous and
 * refused; a record carrying neither is unknown. Null means unknown downstream,
 * so every refusal here fails closed at compute time.
 */
export type ScreeningRecord = ProportionRecord | EvidenceRecord;

const PROPORTIONS = ['false-ready', 'false-support', 'coverage', 'accuracy'] as const;

const VOCABULARY = {
  'false-ready': { kind: 'proportion', description: 'False-ready events per slice: advisory-ready with non-ready gold.' },
  'false-support': { kind: 'proportion', description: 'False-support events per citation slice: accepted support with non-support gold.' },
  'coverage': { kind: 'proportion', description: 'Advisory-ready share per slice; the always-review reference rate is 0.' },
  'accuracy': { kind: 'proportion', description: 'Joint candidate correctness per slice: route matches gold readiness and support.' },
  'calibration': { kind: 'evidence', description: 'Staged D09 calibration artifact binding for the scored phase.' },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Core screening provider behind the `aiwg:decision-engine/absolute-screening`
 * pack. Binary records tally into per-slice proportion series; calibration
 * attestations collect into the pooled evidence observation. Powers
 * `interval-bound` (wilson), `count-max`, `minimum-n` and `evidence` gates.
 */
export const screeningProvider: MetricProvider<ScreeningRecord> = {
  id: 'decision.screening/v1',
  version: '1.0.0',
  description: 'SDLC evidence-screening proportions with the staged-calibration attestation.',
  metrics: {
    'false-ready': { ...VOCABULARY['false-ready'] },
    'false-support': { ...VOCABULARY['false-support'] },
    'coverage': { ...VOCABULARY.coverage },
    'accuracy': { ...VOCABULARY.accuracy },
    'calibration': { ...VOCABULARY.calibration },
  },
  sourceDigest: providerSourceDigest({ id: 'decision.screening/v1', version: '1.0.0', metrics: VOCABULARY }),
  compute(records: readonly ScreeningRecord[]) {
    const rows = requireRecords(records, 'screening');
    const binary: ProportionRecord[] = [];
    const attestations: EvidenceRecord[] = [];
    for (const row of rows) {
      const hasMetric = isRecord(row) && typeof row.metric === 'string';
      const hasId = isRecord(row) && typeof row.id === 'string';
      if (hasMetric === hasId) {
        throw new Error('screening records are either binary {slice, metric, event} or attestations {id, passed}');
      }
      if (hasMetric) binary.push(row as ProportionRecord);
      else attestations.push(row as EvidenceRecord);
    }
    const tables = tallyProportionRecords(binary, new Set(PROPORTIONS), 'screening');
    const metrics = proportionSeries(tables, [...PROPORTIONS]) as Record<string, { bySlice: Record<string, MetricObservation>; pooled: MetricObservation | null }>;
    const pooled: MetricObservation = { available: collectAttestations(attestations, 'screening') };
    return { version: '1.0.0', sourceDigest: screeningProvider.sourceDigest,
      metrics: { ...metrics, 'calibration': { bySlice: {}, pooled } } };
  },
};
