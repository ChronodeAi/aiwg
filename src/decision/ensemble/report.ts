import type { AliasEvent, PromotionEligibility } from '../calibration/types.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';
import {
  championChallengerEligibilityProblems, ensembleContractDigest, EnsembleContractError, ensembleIntegrityDecision,
  integrityMetadataFindings, pairedDeltaFinding, validateChampionChallenger, validateEnsembleIntegrityReport,
} from './contract.js';
import type { DecisionEnsembleIntegrityReport, PairedDeltaObservation } from './types.js';

export interface EnsembleIntegrityReportInput {
  record: unknown;
  /** The #2037/#2048 integrity metadata and release gate, carried unchanged. */
  integrity: QualificationIntegrityMetadata;
  pairedDeltas: readonly PairedDeltaObservation[];
  /** D09 eligibility for `record.eligibilityId`; null records the gap and holds promotion. */
  eligibility: PromotionEligibility | null;
  aliasHistory?: readonly AliasEvent[];
}

/** Extends the eval-integrity report with paired champion/challenger evidence. D17 findings can
 * only hold or roll back: HOLD and ROLLBACK from the upstream gate are never upgraded. */
export function buildEnsembleIntegrityReport(input: EnsembleIntegrityReportInput): DecisionEnsembleIntegrityReport {
  const { record, digest } = validateChampionChallenger(input.record, input.aliasHistory ? { aliasHistory: input.aliasHistory } : {});
  const integrity = input.integrity;
  const findings = new Set<string>();
  if (!input.eligibility) findings.add('d09-eligibility-missing');
  else for (const problem of championChallengerEligibilityProblems(record, input.eligibility)) findings.add(`d09-${problem}`);
  for (const finding of integrityMetadataFindings(integrity, Math.max(...record.pairedMetrics.map(item => item.minimumPairs)))) findings.add(finding);

  const observed = new Map<string, PairedDeltaObservation>();
  for (const item of input.pairedDeltas) {
    if (observed.has(item.metric)) throw new EnsembleContractError(`paired delta ${item.metric} is duplicated`, 'semantic');
    observed.set(item.metric, item);
  }
  const pairedDeltas = record.pairedMetrics.map(threshold => {
    const item = observed.get(threshold.metric);
    const finding = pairedDeltaFinding(threshold, item);
    if (finding) findings.add(finding);
    return { ...threshold, delta: item?.delta ?? null, pairs: item?.pairs ?? 0, passed: finding === null };
  }).sort((a, b) => a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0);

  const upstreamDecision = integrity.release_gate.decision;
  const decision = ensembleIntegrityDecision(integrity, findings.size);
  const payload: Omit<DecisionEnsembleIntegrityReport, 'digest'> = {
    schemaVersion: 'decision-ensemble-integrity-report/v1',
    subject: { kind: 'champion-challenger', id: record.id, digest, eligibilityId: record.eligibilityId },
    integrity, pairedDeltas, findings: [...findings].sort(), upstreamDecision, decision,
  };
  return validateEnsembleIntegrityReport({ ...payload, digest: ensembleContractDigest(payload) });
}
