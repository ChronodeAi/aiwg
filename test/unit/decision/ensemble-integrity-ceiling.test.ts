// Verdict and tamper controls for D17's migration to the upstream-ceiling gate.
import { expect, it } from 'vitest';
import { buildEnsembleIntegrityReport } from '../../../src/decision/ensemble/report.js';
import { ensembleContractDigest, ensembleIntegrityDecision, integrityMetadataFindings,
  validateEnsembleIntegrityReport } from '../../../src/decision/ensemble/contract.js';
import type { DecisionChampionChallenger } from '../../../src/decision/ensemble/types.js';
import { records } from './ensemble-fixtures.js';
import { integrityOutcomes, integrityVariants, syntheticIntegrity } from './integrity-ceiling-fixtures.js';

const record = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09')!;
const minimumPairs = Math.max(...record.pairedMetrics.map(item => item.minimumPairs));
const eligibility = { id: record.eligibilityId, alias: record.alias, candidateIdentityDigest: record.challenger.identityDigest,
  candidateActualModel: record.challenger.actualModel, evaluationIntegrityReport: record.evaluationIntegrityReport,
  approvalReference: record.approval.reference, rollbackTarget: record.rollbackTarget,
  eligible: true, reasons: [], recordedAt: '2026-09-05T00:00:00.000Z' };

it.each(integrityOutcomes)('upstream-ceiling preserves ensemble reports for %s', upstream => {
  for (const variant of integrityVariants) for (const failedDelta of [false, true]) {
    const metadata = syntheticIntegrity({ ...variant.patch, release_gate: { decision: upstream, reasons: [] } });
    expect(integrityMetadataFindings(metadata, minimumPairs), variant.name).toEqual(variant.ensemble);
    const report = buildEnsembleIntegrityReport({ record, integrity: metadata, eligibility,
      pairedDeltas: record.pairedMetrics.map(item => ({ metric: item.metric, pairs: item.minimumPairs,
        delta: failedDelta && item.metric === 'quality' ? -999 : 0 })) });
    const expected = upstream === 'ROLLBACK' || metadata.integrity_state === 'compromised' || metadata.compromise_labels.length ? 'ROLLBACK'
      : upstream === 'HOLD' || variant.ensemble.length || failedDelta ? 'HOLD' : 'PROMOTE';
    expect(report.decision, variant.name).toBe(expected);
    expect(report.findings).toEqual([...variant.ensemble, ...(failedDelta ? ['paired-delta-failed:quality'] : [])].sort());
    expect(validateEnsembleIntegrityReport(report)).toBe(report);
    for (const count of [0, 1, 3]) {
      expect(ensembleIntegrityDecision(metadata, count)).toBe(upstream === 'ROLLBACK'
        || metadata.integrity_state === 'compromised' || metadata.compromise_labels.length ? 'ROLLBACK'
        : upstream === 'HOLD' || count > 0 ? 'HOLD' : 'PROMOTE');
    }
    expect(() => validateEnsembleIntegrityReport({ ...report, integrity: { ...metadata, sample_n: 7 } })).toThrow();
    if (expected !== 'PROMOTE') {
      const { digest: _digest, ...fields } = { ...report, decision: 'PROMOTE' as const, findings: [] };
      expect(() => validateEnsembleIntegrityReport({ ...fields, digest: ensembleContractDigest(fields) })).toThrow();
    }
  }
});
