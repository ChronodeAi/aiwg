import { heldoutDigest } from '../heldout/contract.js';
import type { Digest, HeldoutAttempt, HeldoutBundle, HeldoutCalibration, HeldoutCalibrationPhase, HeldoutRow } from '../heldout/types.js';
import { CalibrationRegistry, calibrationArtifactDigest } from '../calibration/registry.js';
import type { CalibrationArtifact, CompatibilityDecision, CompatibilityPolicy } from '../calibration/types.js';
import { evaluateBinaryCalibration, freezeQualificationSplit, wilsonScoreInterval } from '../qualification/quality.js';
import type { BinaryQualificationSample } from '../qualification/quality.js';
import { D17_CALIBRATION } from './protocol.js';
import { D17_SLICES, d17TextOracle } from './corpus.js';
import type { prepareD17StagedStudy } from './staged.js';
import { validateD17Artifact, type D17Review } from './artifacts.js';

/**
 * Staged D09 calibration for the D17 ensemble study (#2611).
 *
 * Calibration-phase observations are read only through the verified collector seal. The member
 * calibrator maps one fresh call's native P(yes); the aggregate calibrator maps the raw mean P(yes)
 * of the three ensemble members. Both are monotone (isotonic, pool-adjacent-violators) step
 * functions with Laplace-smoothed block frequencies, fitted on calibration-split rows only. Fitting
 * produces `CalibrationArtifact.v1` records in the `observed` state; only a separately anchored
 * operator review can approve them, and only an approved, D09-qualified pair can bind a test phase.
 */
type Prepared = ReturnType<typeof prepareD17StagedStudy>;
type Role = 'member' | 'aggregate';
export interface D17CalibrationBlock { lower: number; upper: number; n: number; yes: number; probability: number }
export interface D17CalibrationMapping {
  schemaVersion: 'decision-d17-calibration-mapping/v1'; role: Role;
  calibrator: { id: string; version: '1' }; method: 'isotonic-pav-laplace-v1'; model: 'jev-1.13.0';
  splitDigest: Digest; definitionDigest: Digest; evidenceDigest: Digest; n: number; rows: number; blocks: D17CalibrationBlock[];
  qualification: { method: 'slice-stratified-k-fold-out-of-fold'; folds: 5; outOfFold: D17CalibrationMetrics; inSample: D17CalibrationMetrics };
}
export interface D17CalibrationPin { artifactId: string; artifactDigest: Digest; mappingDigest: Digest }
export interface D17CalibrationSet {
  schemaVersion: 'decision-d17-calibration-set/v1'; corpusDigest: Digest; preregistrationDigest: Digest;
  calibrationPhaseRecordDigest: Digest; priorApprovalDigest: Digest; member: D17CalibrationPin; aggregate: D17CalibrationPin;
}
export interface D17CalibrationReview {
  schemaVersion: 'decision-d17-calibration-review/v1'; approved: true; reviewer: string; calibrationSetDigest: Digest;
  memberArtifactDigest: Digest; aggregateArtifactDigest: Digest; approvalReference: string; reviewedAt: string;
}
export interface D17SealedPhase {
  bundle: HeldoutBundle; source: 'provider' | 'injected-transport'; record: HeldoutCalibrationPhase; attempts: HeldoutAttempt[];
}

export class D17CalibrationError extends Error {
  constructor(readonly reason: string) { super(`D17 calibration refused (${reason})`); }
}
const refuse = (reason: string): never => { throw new D17CalibrationError(reason); };
const MODEL = 'jev-1.13.0';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : Number.NaN;
export const D17_COMPATIBILITY_POLICY: CompatibilityPolicy = Object.freeze({
  unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' });

/** The staged scope is preregistered; no other scope may fit, register or apply a D17 calibration. */
export function assertD17Staged(prepared: Prepared): void {
  const analysis = prepared.analysis as Record<string, unknown>, plan = prepared.preregistration.calibration;
  if (analysis.schemaVersion !== 'decision-d17-analysis/v2' || analysis.scope !== 'staged-calibrated'
    || heldoutDigest(analysis.calibration) !== heldoutDigest(D17_CALIBRATION)
    || plan.scope !== 'calibrated' || plan.allowedModes.join(',') !== 'staged'
    || (plan.calibrationPhaseSplits ?? []).join(',') !== D17_CALIBRATION.phaseSplits.join(',')) refuse('staged-scope');
  validateD17Artifact('analysisV2', analysis);
}

/** Native P(yes) from the terminal successful attempt of one request, or null when it has no usable distribution. */
export function d17NativeYes(attempts: readonly HeldoutAttempt[], rowId: string, requestId: string): number | null {
  const terminal = attempts.filter(attempt => attempt.rowId === rowId && attempt.requestId === requestId)
    .sort((a, b) => a.ordinal - b.ordinal).at(-1)?.result;
  const decision = terminal?.receipt?.spec.evaluations.q0;
  const uncertainty = decision?.spec.uncertainty;
  if (terminal?.disposition !== 'success' || terminal.servedModel !== MODEL || decision?.spec.status !== 'success'
    || uncertainty?.source !== 'provider' || uncertainty.profile !== 'typesafe-distribution-v1' || !uncertainty.distribution) return null;
  const distribution = uncertainty.distribution as Record<string, unknown>;
  if (Object.keys(distribution).sort().join(',') !== 'no,yes' || !['yes', 'no'].includes(String(decision.spec.value))) refuse('native-distribution');
  const yes = distribution.yes;
  if (typeof yes !== 'number' || !Number.isFinite(yes) || yes < 0 || yes > 1) refuse('native-distribution');
  return yes as number;
}

/** Attempts grouped by row, so per-row reads stay linear in the journal size. */
export function d17AttemptsByRow(attempts: readonly HeldoutAttempt[]): Map<string, HeldoutAttempt[]> {
  const grouped = new Map<string, HeldoutAttempt[]>();
  for (const attempt of attempts) grouped.set(attempt.rowId, [...(grouped.get(attempt.rowId) ?? []), attempt]);
  return grouped;
}

/** Raw inputs of both calibrators for one row; null when a required call is unusable. */
export function d17RawProbabilities(attempts: readonly HeldoutAttempt[], row: Pick<HeldoutRow, 'id'>) {
  const champion = d17NativeYes(attempts, row.id, 'champion');
  const members = D17_CALIBRATION.calibrators.aggregate.requests.map(request => d17NativeYes(attempts, row.id, request));
  return { champion, members, mean: members.every(value => value !== null) ? members.reduce((sum, n) => sum! + n!, 0)! / members.length : null };
}

const laplace = (yes: number, n: number) => (yes + 1) / (n + 2);
function merge(a: D17CalibrationBlock, b: D17CalibrationBlock): D17CalibrationBlock {
  const n = a.n + b.n, yes = a.yes + b.yes;
  return { lower: Math.min(a.lower, b.lower), upper: Math.max(a.upper, b.upper), n, yes, probability: laplace(yes, n) };
}

/** Deterministic isotonic fit: PAV on raw frequencies, minimum block support, then monotone Laplace smoothing. */
export function fitD17Isotonic(samples: ReadonlyArray<{ score: number; label: 0 | 1 }>, minimumBlockN: number = D17_CALIBRATION.minimumBlockN): D17CalibrationBlock[] {
  if (!samples.length || samples.some(item => !Number.isFinite(item.score) || item.score < 0 || item.score > 1 || ![0, 1].includes(item.label))) {
    refuse('calibration-samples');
  }
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  const blocks: D17CalibrationBlock[] = [];
  for (const item of sorted) {
    const last = blocks.at(-1);
    if (last && last.lower === item.score) { last.n++; last.yes += item.label; last.probability = laplace(last.yes, last.n); }
    else blocks.push({ lower: item.score, upper: item.score, n: 1, yes: item.label, probability: laplace(item.label, 1) });
  }
  // Pool adjacent violators on raw frequencies (cross-multiplied to stay exact).
  const pooled: D17CalibrationBlock[] = [];
  for (const block of blocks) {
    pooled.push({ ...block });
    while (pooled.length > 1 && pooled.at(-2)!.yes * pooled.at(-1)!.n > pooled.at(-1)!.yes * pooled.at(-2)!.n) {
      const right = pooled.pop()!, left = pooled.pop()!; pooled.push(merge(left, right));
    }
  }
  // Minimum support: a sparse block joins its right neighbour (the last block joins its left one).
  for (let i = pooled.findIndex(block => block.n < minimumBlockN); i !== -1 && pooled.length > 1; i = pooled.findIndex(block => block.n < minimumBlockN)) {
    const j = i < pooled.length - 1 ? i + 1 : i - 1, [a, b] = [Math.min(i, j), Math.max(i, j)];
    pooled.splice(a, 2, merge(pooled[a]!, pooled[b]!));
  }
  // Laplace smoothing can reorder blocks with different support; pool again on the smoothed values.
  for (let i = 0; i < pooled.length - 1;) {
    if (pooled[i]!.probability > pooled[i + 1]!.probability) { pooled.splice(i, 2, merge(pooled[i]!, pooled[i + 1]!)); i = Math.max(0, i - 1); }
    else i++;
  }
  return pooled;
}

/** Step-function application: the last block whose lower score is at or below the input, else the first block. */
export function applyD17Mapping(mapping: Pick<D17CalibrationMapping, 'blocks'>, score: number): number {
  if (!Number.isFinite(score) || score < 0 || score > 1 || !mapping.blocks.length) refuse('calibration-input');
  let selected = mapping.blocks[0]!;
  for (const block of mapping.blocks) if (block.lower <= score) selected = block;
  return selected.probability;
}

function validateMapping(mapping: unknown, role: Role, prepared: Prepared): asserts mapping is D17CalibrationMapping {
  try { validateD17Artifact('calibration', mapping); } catch { refuse('mapping-schema'); }
  const value = mapping as D17CalibrationMapping, calibrator = D17_CALIBRATION.calibrators[role];
  if (value.schemaVersion !== 'decision-d17-calibration-mapping/v1' || value.role !== role || value.calibrator.id !== calibrator.id
    || value.calibrator.version !== calibrator.version || value.method !== D17_CALIBRATION.method
    || value.splitDigest !== prepared.splitManifest.splits.calibration.digest
    || value.definitionDigest !== heldoutDigest(prepared.corpus.definitions)
    || value.blocks.reduce((sum, block) => sum + block.n, 0) !== value.n
    || value.blocks.some((block, i) => block.n < D17_CALIBRATION.minimumBlockN && value.blocks.length > 1
      || block.probability !== laplace(block.yes, block.n) || block.yes > block.n || block.lower > block.upper
      || i > 0 && (block.lower <= value.blocks[i - 1]!.upper || block.probability < value.blocks[i - 1]!.probability))
    || value.qualification.method !== D17_CALIBRATION.qualificationMetrics.method
    || value.qualification.folds !== D17_CALIBRATION.qualificationMetrics.folds) refuse('mapping-pin');
}

type Sample = { score: number; label: 0 | 1 };
export interface D17CalibrationMetrics {
  totalSamples: number; perSliceSamples: number; calibrationError: number; selectiveRisk: number;
  confidenceIntervals: { selectiveRisk: { lower: number; upper: number }; coverage: { lower: number; upper: number } };
}

/** Library fitting accepts only attempts pinned to this exact D17 study, corpus and preregistration. */
function assertStudyAttempts(prepared: Prepared, attempts: readonly HeldoutAttempt[]): void {
  const corpusDigest = heldoutDigest(prepared.corpus), preregistrationDigest = heldoutDigest(prepared.preregistration);
  if (attempts.some(attempt => attempt.study !== 'D17' || attempt.corpusDigest !== corpusDigest
    || attempt.preregistrationDigest !== preregistrationDigest)) refuse('attempt-membership');
}

/** Training samples for one calibrator from the given rows. */
function samplesFor(role: Role, rows: readonly HeldoutRow[], grouped: Map<string, HeldoutAttempt[]>, prepared: Prepared): Sample[] {
  const label = (row: HeldoutRow) => Number(prepared.gold.labels[row.id] === 'yes') as 0 | 1;
  return rows.flatMap(row => {
    const raw = d17RawProbabilities(grouped.get(row.id) ?? [], row);
    if (role === 'aggregate') return raw.mean === null ? [] : [{ score: raw.mean, label: label(row) }];
    return [raw.champion, ...raw.members].filter((value): value is number => value !== null).map(score => ({ score, label: label(row) }));
  });
}

/** Deterministic slice-stratified folds: calibration rows in record-ID order within each slice, index modulo folds. */
export function d17CalibrationFolds(rows: readonly HeldoutRow[], folds: number = D17_CALIBRATION.qualificationMetrics.folds): Map<string, number> {
  const assigned = new Map<string, number>();
  for (const slice of D17_SLICES) {
    rows.filter(row => row.slice === slice).map(row => row.id).sort().forEach((id, index) => assigned.set(id, index % folds));
  }
  return assigned;
}

/**
 * Calibrated quality of one calibrator over the calibration split. `probability(row, score)` supplies the calibrated
 * value for a row's raw score: the full-split mapping (in-sample) or the mapping fitted without the row's fold (out-of-fold).
 */
function calibrationMetrics(prepared: Prepared, grouped: Map<string, HeldoutAttempt[]>, role: Role,
  probability: (row: HeldoutRow, score: number) => number): D17CalibrationMetrics {
  const rows = prepared.corpus.rows.filter(row => row.split === D17_CALIBRATION.fitSplit);
  const splits = (['tuning', 'calibration', 'test'] as const).map(split =>
    freezeQualificationSplit(split, prepared.corpus.rows.filter(row => row.split === split).map(row => row.id)));
  let observed = 0;
  const perSlice = new Map<string, number>();
  const samples: BinaryQualificationSample[] = rows.map(row => {
    const rowAttempts = grouped.get(row.id) ?? [];
    const raw = d17RawProbabilities(rowAttempts, row), score = role === 'member' ? raw.champion : raw.mean;
    const requests: string[] = role === 'member' ? ['champion'] : [...D17_CALIBRATION.calibrators.aggregate.requests];
    const own = rowAttempts.filter(attempt => requests.includes(attempt.requestId));
    const known = (key: 'inputTokens' | 'outputTokens' | 'providerCostUsd') => own.some(a => a.result?.[key] == null) || !own.length
      ? null : own.reduce((sum, a) => sum + a.result![key]!, 0);
    if (score !== null) { observed++; perSlice.set(row.slice, (perSlice.get(row.slice) ?? 0) + 1); }
    const p = score === null ? 0.5 : probability(row, score);
    return { id: row.id, slice: row.slice, label: Number(prepared.gold.labels[row.id] === 'yes') as 0 | 1, probability: p,
      accepted: score !== null && p !== 0.5, latencyMs: own.reduce((sum, a) => sum + (a.result?.latencyMs ?? 0), 0),
      inputTokens: known('inputTokens'), outputTokens: known('outputTokens'), costUsd: known('providerCostUsd'),
      calls: own.length, retries: own.filter(a => a.ordinal > 1).length, fallbacks: 0 };
  });
  const measured = evaluateBinaryCalibration(splits, samples);
  const selectiveRisk = measured.overall.selectiveRisk ?? refuse('calibration-metrics-unknown');
  const level = Math.round(D17_CALIBRATION.profile.confidenceInterval.level * 10000);
  const interval = (events: number, n: number) => {
    const [lower, upper] = wilsonScoreInterval({ events, n, levelBps: level }); return { lower, upper };
  };
  const accepted = samples.filter(sample => sample.accepted);
  const errors = accepted.filter(sample => (sample.probability >= 0.5 ? 1 : 0) !== sample.label).length;
  return { totalSamples: observed, perSliceSamples: Math.min(...D17_SLICES.map(slice => perSlice.get(slice) ?? 0)),
    calibrationError: measured.overall.expectedCalibrationError, selectiveRisk,
    confidenceIntervals: { selectiveRisk: interval(errors, accepted.length), coverage: interval(accepted.length, samples.length) } };
}

/**
 * Fits both preregistered calibrators from calibration-split rows only. Tuning and test rows never contribute. The final
 * mapping uses the full calibration split; its qualification metrics are slice-stratified 5-fold out-of-fold, so a
 * calibrator is gated on rows it was not fitted on (in-sample metrics are recorded alongside, for comparison only).
 */
export function fitD17Calibration(prepared: Prepared, attempts: readonly HeldoutAttempt[]): Record<Role, D17CalibrationMapping> {
  assertD17Staged(prepared);
  assertStudyAttempts(prepared, attempts);
  const rows = prepared.corpus.rows.filter(row => row.split === D17_CALIBRATION.fitSplit);
  const members = new Set(rows.map(row => row.id));
  const used = attempts.filter(attempt => members.has(attempt.rowId)).map(attempt => heldoutDigest(attempt)).sort();
  const grouped = d17AttemptsByRow(attempts.filter(attempt => members.has(attempt.rowId)));
  const observedRows = (role: Role) => rows.filter(row => samplesFor(role, [row], grouped, prepared).length).length;
  const { minimumTotalSamples } = D17_CALIBRATION.profile;
  if (observedRows('member') < minimumTotalSamples || observedRows('aggregate') < minimumTotalSamples) refuse('calibration-support');
  const folds = d17CalibrationFolds(rows), { qualificationMetrics } = D17_CALIBRATION;
  const base = { method: D17_CALIBRATION.method, model: MODEL, splitDigest: prepared.splitManifest.splits.calibration.digest,
    definitionDigest: heldoutDigest(prepared.corpus.definitions), evidenceDigest: heldoutDigest(used) } as const;
  const build = (role: Role): D17CalibrationMapping => {
    const samples = samplesFor(role, rows, grouped, prepared), blocks = fitD17Isotonic(samples);
    const foldBlocks = Array.from({ length: qualificationMetrics.folds }, (_, k) =>
      fitD17Isotonic(samplesFor(role, rows.filter(row => folds.get(row.id) !== k), grouped, prepared)));
    const mapping: D17CalibrationMapping = { schemaVersion: 'decision-d17-calibration-mapping/v1', role,
      calibrator: { id: D17_CALIBRATION.calibrators[role].id, version: '1' }, ...base, n: samples.length, rows: observedRows(role), blocks,
      qualification: { method: qualificationMetrics.method, folds: qualificationMetrics.folds,
        outOfFold: calibrationMetrics(prepared, grouped, role, (row, score) => applyD17Mapping({ blocks: foldBlocks[folds.get(row.id)!]! }, score)),
        inSample: calibrationMetrics(prepared, grouped, role, (_row, score) => applyD17Mapping({ blocks }, score)) } };
    validateMapping(mapping, role, prepared); return mapping;
  };
  return { member: build('member'), aggregate: build('aggregate') };
}

function artifactFor(role: Role, mapping: D17CalibrationMapping,
  sealedAt: string, seal: { calibrationPhaseRecordDigest: Digest; priorApprovalDigest: Digest; source: string }): CalibrationArtifact {
  const mappingDigest = heldoutDigest(mapping), calibrator = D17_CALIBRATION.calibrators[role];
  const draft: Omit<CalibrationArtifact, 'digest'> = { schemaVersion: 'decision-calibration-artifact/v1',
    id: `d17-${role}-${mappingDigest.slice(7, 23)}`,
    identity: { provider: 'jev', backend: 'api', actualModel: MODEL, primitive: 'choice', definitionDigest: mapping.definitionDigest,
      adapterVersion: '1.0.0', dataset: { id: 'd17-calibration', hash: mapping.splitDigest },
      slice: { id: 'd17-all-calibration-slices', hash: mapping.splitDigest },
      calibrator: { id: calibrator.id, version: calibrator.version, parametersDigest: mappingDigest } },
    splitProvenance: { id: 'd17-calibration', hash: mapping.splitDigest, holdoutAccessedAt: null },
    profile: structuredClone(D17_CALIBRATION.profile) as CalibrationArtifact['profile'],
    metrics: structuredClone(mapping.qualification.outOfFold), effectiveAt: sealedAt,
    limitations: [
      `Synthetic D17 calibration-split fit (${role === 'member' ? 'single fresh call' : 'mean of three ensemble members'}); no production authority.`,
      'Metrics are slice-stratified 5-fold out-of-fold on the calibration split; the deployed mapping is fitted on the full split. In-sample metrics are in the mapping, for comparison only.',
      'Decile ECE; selective risk counts calibrated non-tie answers. Wilson intervals describe binomial rates, not ECE.',
      `Observation source: ${seal.source}; calibration evidence: ${mapping.evidenceDigest}.`,
      `Sealed phase: ${seal.calibrationPhaseRecordDigest}; prior approval: ${seal.priorApprovalDigest}.`,
    ], approval: { state: 'observed', reference: null } };
  return { ...draft, digest: calibrationArtifactDigest(draft) };
}

function calibrationSet(prepared: Prepared, seal: { calibrationPhaseRecordDigest: Digest; priorApprovalDigest: Digest },
  artifacts: Record<Role, CalibrationArtifact>, mappings: Record<Role, D17CalibrationMapping>): D17CalibrationSet {
  const pin = (role: Role) => ({ artifactId: artifacts[role].id, artifactDigest: artifacts[role].digest, mappingDigest: heldoutDigest(mappings[role]) });
  const set: D17CalibrationSet = { schemaVersion: 'decision-d17-calibration-set/v1', corpusDigest: heldoutDigest(prepared.corpus),
    preregistrationDigest: heldoutDigest(prepared.preregistration), calibrationPhaseRecordDigest: seal.calibrationPhaseRecordDigest,
    priorApprovalDigest: seal.priorApprovalDigest, member: pin('member'), aggregate: pin('aggregate') };
  validateD17Artifact('calibration', set); return set;
}

/**
 * The 40 development assessments must be complete, unambiguous and agree with both the generator gold and the
 * independent text oracle. `before` bounds every development review time; `testStagesBlank` refuses any test audit
 * recorded before the test phase (a blind test audit belongs after test collection).
 */
export function validateD17DevelopmentReview(prepared: Prepared, review: unknown, trustedDigest: unknown,
  options: { before?: string; testStagesBlank?: boolean } = {}): D17Review {
  try { validateD17Artifact('review', review); } catch { refuse('development-review'); }
  const value = review as D17Review, template = prepared.reviewTemplate;
  if (typeof trustedDigest !== 'string' || heldoutDigest(value) !== trustedDigest || !value.reviewer?.trim() || !value.preregistrationReview?.trim()
    || value.assessments.length !== template.assessments.length) refuse('development-review');
  const limit = options.before === undefined ? null : time(options.before);
  value.assessments.forEach((item, i) => {
    const expected = template.assessments[i]!;
    if (item.assessmentId !== expected.assessmentId || item.rowId !== expected.rowId || item.stage !== expected.stage
      || item.slice !== expected.slice || item.payload !== expected.payload || item.inputDigest !== expected.inputDigest) refuse('development-review');
    if (item.stage === 'development') {
      const gold = prepared.gold.labels[item.rowId];
      if (item.goldAmbiguousOrIncorrect !== false) refuse('development-gold-invalid');
      if (!Number.isFinite(time(item.reviewedAt)) || !item.rationale?.trim() || item.goldAuditLabel !== gold
        || d17TextOracle(String(item.payload)) !== gold) refuse('development-review-incomplete');
      if (limit !== null && !(time(item.reviewedAt) < limit)) refuse('development-review-time');
    } else if (options.testStagesBlank && [item.reviewedAt, item.goldAuditLabel, item.goldAmbiguousOrIncorrect,
      item.blindedResultAudit, item.rationale].some(field => field !== null)) refuse('test-review-before-test-phase');
  });
  return value;
}

/**
 * Approvals carry no timestamp, so ordering is proved by digest: the calibration-phase approval reference must cite the
 * completed development review digest, which therefore existed before the approval that authorized any spend.
 */
export function assertD17ReviewBoundToApproval(approval: { approvalReference?: unknown }, trustedDevelopmentReviewDigest: unknown): void {
  if (typeof trustedDevelopmentReviewDigest !== 'string' || !DIGEST.test(trustedDevelopmentReviewDigest)
    || typeof approval?.approvalReference !== 'string' || !approval.approvalReference.includes(trustedDevelopmentReviewDigest)) {
    refuse('development-review-not-bound');
  }
}

/** A staged prepared study that reproduces the sealed bundle exactly. */
function assertSealedStudy(sealed: D17SealedPhase, prepared: Prepared, trustedApprovalDigest: Digest, trustedSealDigest: Digest): void {
  assertD17Staged(prepared);
  const calibration = sealed.bundle.approval.calibration;
  if (heldoutDigest(prepared.corpus) !== heldoutDigest(sealed.bundle.corpus)
    || heldoutDigest(prepared.preregistration) !== heldoutDigest(sealed.bundle.preregistration)) refuse('frozen-study-mismatch');
  if (calibration.mode !== 'staged' || calibration.phase !== 'calibration' || heldoutDigest(sealed.bundle.approval) !== trustedApprovalDigest
    || heldoutDigest(sealed.record) !== trustedSealDigest || sealed.record.approvalDigest !== trustedApprovalDigest) refuse('calibration-phase-seal');
}

/** Fit both calibrators from a verified seal and emit observed artifacts plus unapproved operator forms. */
export function d17CalibrationHandoffFromSealed(input: { sealed: D17SealedPhase; prepared: Prepared; trustedApprovalDigest: Digest;
  trustedCalibrationPhaseRecordDigest: Digest; developmentReview: unknown; trustedDevelopmentReviewDigest: unknown }) {
  const { sealed, prepared, trustedApprovalDigest, trustedCalibrationPhaseRecordDigest: sealDigest } = input;
  assertSealedStudy(sealed, prepared, trustedApprovalDigest, sealDigest);
  validateD17DevelopmentReview(prepared, input.developmentReview, input.trustedDevelopmentReviewDigest,
    { before: sealed.record.sealedAt, testStagesBlank: true });
  assertD17ReviewBoundToApproval(sealed.bundle.approval, input.trustedDevelopmentReviewDigest);
  const members = new Set(prepared.corpus.rows.filter(row => row.split === D17_CALIBRATION.fitSplit).map(row => row.id));
  const attempts = sealed.attempts.filter(attempt => members.has(attempt.rowId));
  const mappings = fitD17Calibration(prepared, attempts);
  const seal = { calibrationPhaseRecordDigest: sealDigest, priorApprovalDigest: trustedApprovalDigest, source: sealed.source };
  const artifacts = { member: artifactFor('member', mappings.member, sealed.record.sealedAt, seal),
    aggregate: artifactFor('aggregate', mappings.aggregate, sealed.record.sealedAt, seal) };
  const set = calibrationSet(prepared, seal, artifacts, mappings);
  const review = { schemaVersion: 'decision-d17-calibration-review/v1', approved: null, reviewer: null,
    calibrationSetDigest: heldoutDigest(set), memberArtifactDigest: artifacts.member.digest,
    aggregateArtifactDigest: artifacts.aggregate.digest, approvalReference: null, reviewedAt: null };
  validateD17Artifact('calibration', review);
  return { mappings, artifacts, set, calibrationSetDigest: heldoutDigest(set), reviewTemplate: review,
    approval: testApprovalTemplate(sealed.bundle, heldoutDigest(set), sealDigest, trustedApprovalDigest) };
}

function testApprovalTemplate(bundle: HeldoutBundle, setDigest: Digest, sealDigest: Digest, priorApprovalDigest: Digest) {
  const prior = bundle.approval;
  // Unapproved form: operator attestations stay null; the shared budget and original spend floors are carried.
  return { ...structuredClone(prior), approved: false, runId: null, approvalReference: null, exactHeadCi: null, sourceCommit: null,
    calibration: { mode: 'staged', phase: 'test', calibrationArtifactDigest: setDigest, calibrationPhaseRecordDigest: sealDigest, priorApprovalDigest } };
}

/** D09 qualification at `at`: approved, compatible, unexpired, within the frozen profile and its selective-risk interval. */
export function qualifyD17Calibration(artifact: CalibrationArtifact, at: string, registry: CalibrationRegistry = new CalibrationRegistry()): CompatibilityDecision {
  if (heldoutDigest(artifact.profile) !== heldoutDigest(D17_CALIBRATION.profile)) refuse('calibration-profile');
  if (!registry.artifactHistory().some(item => item.digest === artifact.digest)) {
    try { registry.registerArtifact(artifact); } catch { refuse('calibration-artifact'); }
  }
  let compatibility: CompatibilityDecision;
  try {
    compatibility = registry.resolve({ runId: `d17-qualification-${artifact.digest.slice(7)}-${at}`, requestedAlias: artifact.identity.actualModel,
      actualIdentity: artifact.identity, calibrationArtifactId: artifact.id, at }, D17_COMPATIBILITY_POLICY);
  } catch { return refuse('calibration-unqualified'); }
  const risk = artifact.metrics.confidenceIntervals.selectiveRisk;
  if (compatibility.action !== 'allow' || compatibility.artifactDigest !== artifact.digest || !risk
    || risk.upper > artifact.profile.maximumSelectiveRisk) refuse('calibration-unqualified');
  return compatibility;
}

/** Operator review approves both observed artifacts; the approved pair forms a new set that binds the test phase. */
export function registerD17CalibrationFromHandoff(handoff: ReturnType<typeof d17CalibrationHandoffFromSealed>,
  review: unknown, trustedReviewDigest: unknown) {
  try { validateD17Artifact('calibration', review); } catch { refuse('calibration-review'); }
  const value = review as D17CalibrationReview;
  if (value?.schemaVersion !== 'decision-d17-calibration-review/v1' || value.approved !== true || typeof trustedReviewDigest !== 'string'
    || heldoutDigest(value) !== trustedReviewDigest || value.calibrationSetDigest !== handoff.calibrationSetDigest
    || value.memberArtifactDigest !== handoff.artifacts.member.digest || value.aggregateArtifactDigest !== handoff.artifacts.aggregate.digest
    || !(time(value.reviewedAt) >= time(handoff.artifacts.member.effectiveAt))) refuse('calibration-review');
  const approve = (artifact: CalibrationArtifact): CalibrationArtifact => {
    const { digest: _observed, ...payload } = structuredClone(artifact);
    payload.approval = { state: 'approved', reference: value.approvalReference };
    return { ...payload, digest: calibrationArtifactDigest(payload) };
  };
  const artifacts = { member: approve(handoff.artifacts.member), aggregate: approve(handoff.artifacts.aggregate) };
  const compatibility = { member: qualifyD17Calibration(artifacts.member, value.reviewedAt),
    aggregate: qualifyD17Calibration(artifacts.aggregate, value.reviewedAt) };
  const set: D17CalibrationSet = { ...handoff.set,
    member: { ...handoff.set.member, artifactId: artifacts.member.id, artifactDigest: artifacts.member.digest },
    aggregate: { ...handoff.set.aggregate, artifactId: artifacts.aggregate.id, artifactDigest: artifacts.aggregate.digest } };
  validateD17Artifact('calibration', set);
  const setDigest = heldoutDigest(set);
  return { ...handoff, artifacts, compatibility, set, calibrationSetDigest: setDigest,
    approval: { ...handoff.approval, calibration: { ...handoff.approval.calibration, calibrationArtifactDigest: setDigest } } };
}

export interface D17CalibrationContext {
  /** The calibration phase, re-read through the verified collector seal (`readHeldoutCalibrationPhase`). */
  sealed: D17SealedPhase;
  /** Registered files as anchored by the operator; they must equal the deterministic re-derivation exactly. */
  registered: { set: unknown; artifacts: Record<Role, unknown>; mappings: Record<Role, unknown> };
  trustedCalibrationSetDigest: Digest;
  calibrationReview: unknown; trustedCalibrationReviewDigest: Digest;
  developmentReview: unknown; trustedDevelopmentReviewDigest: Digest;
  /** First test access recorded by the collector (`frozen.testPhaseAccessAt`); null only before the test phase. */
  testPhaseAccessAt: string | null;
  /** The scoring clock; qualification (approval, expiry, bounds) is evaluated at this instant. */
  nowEpochMs: number;
}

/**
 * Test-phase verification. Nothing in the registered files is trusted: the calibration set is re-derived from the sealed
 * calibration phase (re-fit, out-of-fold metrics, operator review, approval), and the registered set, artifacts and
 * mappings must be canonically identical to that derivation and to the approved binding. The scoring clock cannot
 * precede the calibration review or the recorded first test access, and both artifacts must qualify at that clock.
 */
export function verifyD17CalibrationSet(prepared: Prepared, approvedCalibration: HeldoutCalibration, context: D17CalibrationContext) {
  assertD17Staged(prepared);
  const approved = approvedCalibration as Extract<HeldoutCalibration, { phase: 'test' }>;
  if (approved?.mode !== 'staged' || approved.phase !== 'test' || !DIGEST.test(approved.calibrationArtifactDigest)
    || !DIGEST.test(approved.calibrationPhaseRecordDigest) || !DIGEST.test(approved.priorApprovalDigest)) refuse('approved-calibration');
  if (!context || !Number.isSafeInteger(context.nowEpochMs) || !context.sealed || !context.registered) refuse('calibration-context');
  if (approved.calibrationArtifactDigest !== context.trustedCalibrationSetDigest) refuse('calibration-set');
  const derived = registerD17CalibrationFromHandoff(d17CalibrationHandoffFromSealed({ sealed: context.sealed, prepared,
    trustedApprovalDigest: approved.priorApprovalDigest, trustedCalibrationPhaseRecordDigest: approved.calibrationPhaseRecordDigest,
    developmentReview: context.developmentReview, trustedDevelopmentReviewDigest: context.trustedDevelopmentReviewDigest }),
  context.calibrationReview, context.trustedCalibrationReviewDigest);
  if (derived.calibrationSetDigest !== context.trustedCalibrationSetDigest) refuse('calibration-set');
  const same = (a: unknown, b: unknown) => heldoutDigest(a) === heldoutDigest(b);
  const { registered } = context;
  if (!same(registered.set, derived.set) || (['member', 'aggregate'] as const).some(role =>
    !same(registered.artifacts?.[role], derived.artifacts[role]) || !same(registered.mappings?.[role], derived.mappings[role]))) {
    refuse('calibration-registered-mismatch');
  }
  const review = context.calibrationReview as D17CalibrationReview;
  if (!(context.nowEpochMs >= time(review.reviewedAt))) refuse('scoring-clock');
  if (context.testPhaseAccessAt !== null && !(context.nowEpochMs >= time(context.testPhaseAccessAt))) refuse('scoring-clock');
  const at = new Date(context.nowEpochMs).toISOString(), registry = new CalibrationRegistry();
  const resolved = (role: Role) => ({ artifact: derived.artifacts[role], mapping: derived.mappings[role],
    compatibility: qualifyD17Calibration(derived.artifacts[role], at, registry) });
  const member = resolved('member'), aggregate = resolved('aggregate');
  return { set: derived.set, setDigest: derived.calibrationSetDigest, member, aggregate, qualifiedAt: at,
    developmentReviewDigest: context.trustedDevelopmentReviewDigest, calibrationReviewDigest: context.trustedCalibrationReviewDigest };
}
