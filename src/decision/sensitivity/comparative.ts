import { pairedBinaryDifferenceInterval, wilsonScoreInterval } from '../qualification/quality.js';
import { qualificationIntegrityAllowlistProblems, type QualificationIntegrityMetadata } from '../qualification/release.js';
import { checkSensitivitySchema, sensitivityDigest, validateSensitivityReport } from './contract.js';
import type { SensitivityDigest, SensitivityReport } from './types.js';

export const REPLAY_SLICES = ['threshold-boundary', 'priority-loss', 'unchanged-control', 'unreplayable'] as const;
export type ReplaySlice = typeof REPLAY_SLICES[number];
export type ReplayDecision = 'PROMOTE' | 'HOLD' | 'ROLLBACK';

export interface ComparativeReplayPreregistration {
  schemaVersion: 'decision-comparative-replay-preregistration/v1';
  id: string;
  mode: 'shadow';
  corpusDigest: SensitivityDigest;
  goldDigest: SensitivityDigest;
  splitDigest: SensitivityDigest;
  comparatorVersion: 'policy-replay-reference-v1';
  frozenAt: string;
  minimumTestRoots: number;
  minimumSliceRoots: number;
  levelBps: number;
  pairedMethod: 'newcombe-10';
  errorMethod: 'wilson';
  nonInferiorityMarginBps: number;
  maxErrorUpperBps: number;
  maxSliceErrorUpperBps: number;
  maxBackendCalls: 0;
  maxTokens: 0;
  maxCostMicros: 0;
  requireExactReproduction: true;
  digest: SensitivityDigest;
}

/** The reference is authored independently of the analyzer and stored before report access. */
export interface ComparativeReplayRoot {
  id: string;
  slice: ReplaySlice;
  split: 'tuning' | 'calibration' | 'test';
  sourceResultDigest: SensitivityDigest;
  gold: { status: string; outcomeChanged: boolean; acceptanceChanged: boolean; ruleChanged: boolean; unreplayable: boolean };
  report: SensitivityReport;
  trustedReportDigest: SensitivityDigest;
  reproductionDigest: SensitivityDigest;
}

export interface ComparativeReplayMember {
  id: string;
  slice: ReplaySlice;
  split: 'tuning' | 'calibration' | 'test';
  sourceResultDigest: SensitivityDigest;
  payloadDigest: SensitivityDigest;
  planDigest: SensitivityDigest;
}

export interface ComparativeReplayInput {
  preregistration: ComparativeReplayPreregistration;
  trustedPreregistrationDigest: SensitivityDigest;
  roots: readonly ComparativeReplayRoot[];
  members: readonly ComparativeReplayMember[];
  integrity: QualificationIntegrityMetadata;
  trustedIntegrityDigest: SensitivityDigest;
  accessedAt: string;
  /** Human review is deliberately pending; this offline builder cannot attest it. */
  reviewerAuditDigest: null;
}

export interface ComparativeReplayReport {
  schemaVersion: 'decision-comparative-replay-report/v1';
  mode: 'shadow';
  semantics: 'associative-sensitivity-not-causal';
  actionAuthorization: 'not-authorized';
  preregistrationDigest: SensitivityDigest;
  corpusDigest: SensitivityDigest;
  goldDigest: SensitivityDigest;
  splitDigest: SensitivityDigest;
  accessedAt: string;
  integrity: QualificationIntegrityMetadata;
  integrityDigest: SensitivityDigest;
  roots: Array<{ id: string; slice: ReplaySlice; split: ComparativeReplayMember['split']; reportDigest: SensitivityDigest; correct: boolean; falseNoChange: boolean }>;
  metrics: { testRoots: number; errors: number; falseNoChange: number; pairedLowerBps: number | null; errorUpperBps: number | null;
    slices: Record<ReplaySlice, { roots: number; errors: number; errorUpperBps: number | null }>;
    backendCalls: number; tokens: number; costMicros: number; exactReproduction: boolean };
  diagnosticDecision: 'pass' | 'fail';
  reviewStatus: 'pending';
  findings: string[];
  upstreamDecision: ReplayDecision;
  decision: ReplayDecision;
  digest: SensitivityDigest;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const bpsUpper = (events: number, n: number, levelBps: number): number | null => n ? Math.ceil(wilsonScoreInterval({ events, n, levelBps })[1] * 10_000) : null;

export function validateComparativeReplayPreregistration(value: ComparativeReplayPreregistration): void {
  checkSensitivitySchema('comparativePlan', value);
  if (value.minimumTestRoots < value.minimumSliceRoots * REPLAY_SLICES.length) {
    throw new Error('comparative replay slice support exceeds total minimum');
  }
  const { digest, ...payload } = value;
  if (sensitivityDigest(payload) !== digest) throw new Error('comparative replay preregistration digest mismatch');
}

/** Rebuild from trusted preregistration, stored reports and independently authored gold. */
export function buildComparativeReplayReport(input: ComparativeReplayInput): ComparativeReplayReport {
  const plan = input.preregistration;
  validateComparativeReplayPreregistration(plan);
  if (plan.digest !== input.trustedPreregistrationDigest) throw new Error('untrusted comparative replay preregistration');
  checkSensitivitySchema('comparativeIntegrity', input.integrity);
  if (!DIGEST.test(input.trustedIntegrityDigest) || sensitivityDigest(input.integrity) !== input.trustedIntegrityDigest) {
    throw new Error('untrusted eval-integrity metadata');
  }
  if (!Number.isFinite(Date.parse(input.accessedAt)) || Date.parse(input.accessedAt) <= Date.parse(plan.frozenAt)) {
    throw new Error('test access must follow preregistration freeze');
  }
  checkSensitivitySchema('comparativeMembers', input.members);
  if (sensitivityDigest(input.members) !== plan.splitDigest
    || sensitivityDigest(input.members.map(({ id, payloadDigest }) => ({ id, payloadDigest }))) !== plan.corpusDigest) {
    throw new Error('frozen comparative replay membership mismatch');
  }
  const members = new Map(input.members.map(member => [member.id, member]));
  if (members.size !== input.members.length || input.roots.length !== input.members.length) {
    throw new Error('incomplete or duplicate comparative replay membership');
  }
  const gold = input.roots.map(({ id, gold }) => ({ id, gold })).sort((a, b) => a.id.localeCompare(b.id));
  checkSensitivitySchema('comparativeGold', gold);
  if (sensitivityDigest(gold) !== plan.goldDigest) throw new Error('frozen comparative replay gold mismatch');
  const findings = new Set<string>();
  const ids = new Set<string>();
  const sources = new Set<string>();
  const rows: ComparativeReplayReport['roots'] = [];
  let backendCalls = 0; let tokens = 0; let costMicros = 0; let exactReproduction = true;
  for (const root of input.roots) {
    if (!root.id || ids.has(root.id) || !REPLAY_SLICES.includes(root.slice) || !DIGEST.test(root.sourceResultDigest)) {
      throw new Error('invalid or duplicate comparative replay root');
    }
    ids.add(root.id);
    if (sources.has(root.sourceResultDigest)) throw new Error('duplicate source scenario');
    sources.add(root.sourceResultDigest);
    const member = members.get(root.id);
    if (!member || member.slice !== root.slice || member.split !== root.split
      || member.sourceResultDigest !== root.sourceResultDigest) throw new Error('comparative replay root membership mismatch');
    const report = validateSensitivityReport(root.report);
    if (report.digest !== root.trustedReportDigest || report.analysisKind !== 'policy-replay'
      || report.plan.digest !== member.planDigest || report.status !== 'completed' || report.rows.length !== 1 || report.baseline.resultRef.digest !== root.sourceResultDigest) {
      findings.add(`report-invalid:${root.id}`);
    }
    if (report.privacy.redaction !== 'hash-values' || report.privacy.summaryPrecisionBps < 100
      || report.rows.some(row => !['reused-stored-evidence', 'deduplicated-control', 'unreplayable'].includes(row.inference)
        || row.freshInvocationId !== null || row.counterfactualReceipt !== null
        || row.sourceReceipt.digest !== root.sourceResultDigest
        || row.resourceUse.backendCalls !== 0 || row.resourceUse.tokens !== 0 || row.resourceUse.costMicros !== 0)) {
      findings.add(`not-zero-call-policy-replay:${root.id}`);
    }
    if (root.reproductionDigest !== report.digest) exactReproduction = false;
    backendCalls += report.budget.backendCalls;
    tokens += report.budget.tokens;
    costMicros += report.budget.costMicros;
    const row = report.rows[0];
    const predictedUnreplayable = row?.inference === 'unreplayable';
    const falseNoChange = root.gold.unreplayable && !predictedUnreplayable;
    const correct = !!row && report.status === 'completed'
      && predictedUnreplayable === root.gold.unreplayable
      && row.deltas.status === root.gold.status
      && row.deltas.outcomeChanged === root.gold.outcomeChanged
      && row.deltas.acceptanceChanged === root.gold.acceptanceChanged
      && row.deltas.ruleChanged === root.gold.ruleChanged;
    rows.push({ id: root.id, slice: root.slice, split: root.split, reportDigest: report.digest, correct, falseNoChange });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const testRows = rows.filter(row => row.split === 'test');
  const errors = testRows.filter(row => !row.correct).length;
  const falseNoChange = testRows.filter(row => row.falseNoChange).length;
  const pairedLowerBps = testRows.length ? pairedBinaryDifferenceInterval({ counts: { both: testRows.length - errors,
    candidateOnly: 0, baselineOnly: errors, neither: 0 }, levelBps: plan.levelBps, method: plan.pairedMethod }).lowerBps : null;
  const errorUpperBps = bpsUpper(errors, testRows.length, plan.levelBps);
  const slices = Object.fromEntries(REPLAY_SLICES.map(slice => {
    const items = testRows.filter(row => row.slice === slice);
    const sliceErrors = items.filter(row => !row.correct).length;
    return [slice, { roots: items.length, errors: sliceErrors, errorUpperBps: bpsUpper(sliceErrors, items.length, plan.levelBps) }];
  })) as ComparativeReplayReport['metrics']['slices'];
  if (testRows.length < plan.minimumTestRoots) findings.add('test-support-insufficient');
  if (errors > 0) findings.add('diagnostic-errors');
  if (falseNoChange > 0) findings.add('false-no-change');
  if (pairedLowerBps === null || pairedLowerBps < plan.nonInferiorityMarginBps) findings.add('non-inferiority-failed');
  if (errorUpperBps === null || errorUpperBps > plan.maxErrorUpperBps) findings.add('error-bound-failed');
  for (const slice of REPLAY_SLICES) {
    const metric = slices[slice];
    if (metric.roots < plan.minimumSliceRoots || metric.errors > 0
      || metric.errorUpperBps === null || metric.errorUpperBps > plan.maxSliceErrorUpperBps) findings.add(`slice-failed:${slice}`);
  }
  if (backendCalls > plan.maxBackendCalls || tokens > plan.maxTokens || costMicros > plan.maxCostMicros) findings.add('zero-call-budget-violated');
  if (!exactReproduction) findings.add('reproduction-mismatch');
  const diagnosticDecision = findings.size === 0 ? 'pass' : 'fail';
  for (const problem of qualificationIntegrityAllowlistProblems(input.integrity)) findings.add(problem);
  if (input.integrity.sample_n !== testRows.length) findings.add('integrity-sample-mismatch');
  if (input.reviewerAuditDigest !== null) throw new Error('operator review ingestion is not implemented');
  findings.add('reviewer-audit-pending');
  const upstreamDecision = input.integrity.release_gate.decision;
  const decision = upstreamDecision === 'ROLLBACK' || input.integrity.integrity_state === 'compromised'
    || input.integrity.compromise_labels.length > 0 ? 'ROLLBACK'
    : upstreamDecision === 'HOLD' || findings.size > 0 ? 'HOLD' : 'PROMOTE';
  const payload: Omit<ComparativeReplayReport, 'digest'> = {
    schemaVersion: 'decision-comparative-replay-report/v1', mode: 'shadow',
    semantics: 'associative-sensitivity-not-causal', actionAuthorization: 'not-authorized',
    preregistrationDigest: plan.digest, corpusDigest: plan.corpusDigest, goldDigest: plan.goldDigest,
    splitDigest: plan.splitDigest, accessedAt: input.accessedAt, integrity: input.integrity,
    integrityDigest: input.trustedIntegrityDigest, roots: rows,
    metrics: { testRoots: testRows.length, errors, falseNoChange, pairedLowerBps, errorUpperBps,
      slices, backendCalls, tokens, costMicros, exactReproduction },
    diagnosticDecision, reviewStatus: 'pending', findings: [...findings].sort(), upstreamDecision, decision,
  };
  const report: ComparativeReplayReport = { ...payload, digest: sensitivityDigest(payload) };
  checkSensitivitySchema('comparativeReport', report);
  return report;
}

export function validateComparativeReplayReport(report: ComparativeReplayReport, input: ComparativeReplayInput): void {
  checkSensitivitySchema('comparativeReport', report);
  const expected = buildComparativeReplayReport(input);
  if (sensitivityDigest(report) !== sensitivityDigest(expected)) throw new Error('comparative replay report differs from bound inputs');
}
