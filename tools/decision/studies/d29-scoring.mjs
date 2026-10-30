// Score D29 observations only after verifying protected frozen and signed access records.
import { heldoutDigest, validateHeldoutInputs } from '../../../src/decision/heldout/contract.ts';
import { qualificationIntegrityAllowlistProblems } from '../../../src/decision/qualification/release.ts';
import { CalibrationRegistry } from '../../../src/decision/calibration/registry.ts';
import { evaluateSdlcEvidenceScreening } from '../../../src/decision/sdlc-screening.ts';
import { pairedBinaryDifferenceInterval } from '../../../src/decision/qualification/quality.ts';
import { sealGateHoldoutFromFrozen } from '../../../src/gates/heldout.ts';
import { buildReport } from './d29-gates.mjs';
import { prepare, prepareWithGenerator, d29CorpusGeneratorId } from './d29-preparation.mjs';
import { validateStudyArtifact, observationFromAttempts, readinessCell, hostContext, groupedMetrics,
  GATE_CALIBRATION_EVIDENCE_ID } from './d29.mjs';
const MODEL = 'jev-1.13.0';
const closed = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) refuse('closed-fields');
};
const validatedArtifact = value => { validateStudyArtifact(value); return value; };
const refuse = reason => { throw new Error(`D29 study refused (${reason})`); };
function validateReviews(prepared, reviews) {
  validateStudyArtifact(reviews);
  const template = prepared.reviews;
  if (!reviews || reviews.reviewer !== 'roctinam' || reviews.corpusDigest !== template.corpusDigest
    || reviews.assessments.length !== template.assessments.length || !reviews.preregistrationReview || !reviews.finalDispositionReview) refuse('operator-review-missing');
  const unique = new Map();
  for (let i = 0; i < template.assessments.length; i++) {
    const item = reviews.assessments[i], expected = template.assessments[i];
    closed(item, Object.keys(expected));
    if (item.assessmentId !== expected.assessmentId || item.phase !== expected.phase || item.id !== expected.id
      || item.goldCorrect !== true || typeof item.goldRationale !== 'string' || !item.goldRationale.trim()
      || typeof item.agreed !== 'boolean' || typeof item.overridden !== 'boolean' || typeof item.rationale !== 'string' || !item.rationale.trim()
      || !Number.isFinite(Date.parse(item.blindReviewedAt)) || !Number.isFinite(Date.parse(item.unblindedAt))
      || Date.parse(item.blindReviewedAt) >= Date.parse(item.unblindedAt)) refuse('operator-review-invalid');
    if (item.phase === 'delayed-repeat') {
      const original = reviews.assessments.find(other => other.phase === 'holdout' && other.id === item.id);
      if (!original || Date.parse(item.blindReviewedAt) <= Date.parse(original.unblindedAt)) refuse('repeat-not-delayed');
    }
    if (item.phase === 'holdout') unique.set(item.id, { agreed: item.agreed, overridden: item.overridden });
  }
  return unique;
}

/** Scoring context comes from protected host artifacts, never from corpus payload or provider output. */
export function studyModule(context) {
  return { prepare, score: async input => {
    // Score regenerates with the generator recorded in the corpus rows, never by seed.
    const prepared = await prepareWithGenerator(d29CorpusGeneratorId(input.corpus), input.corpus.provenance.seed);
    const scoped = { ...prepared.corpus, rows: prepared.corpus.rows.filter(row => row.split === 'test') };
    if (heldoutDigest(input.corpus) !== heldoutDigest(scoped)) refuse('test-phase-corpus');
    return score({ ...input, corpus: prepared.corpus }, context);
  } };
}

export async function score(input, context = null) {
  validateHeldoutInputs(input.corpus, input.preregistration);
  const prepared = await prepareWithGenerator(d29CorpusGeneratorId(input.corpus), input.corpus.provenance.seed);
  if (heldoutDigest(input.corpus) !== heldoutDigest(prepared.corpus) || heldoutDigest(input.gold) !== prepared.corpus.provenance.goldDigest
    || heldoutDigest(input.preregistration) !== heldoutDigest(prepared.preregistration)) refuse('frozen-study-mismatch');
  const seenAttempts = new Set();
  const members = new Map(input.corpus.rows.map(row => [row.id, row]));
  for (const attempt of input.attempts) {
    const row = members.get(attempt.rowId), key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
    if (!row?.requests.some(request => request.id === attempt.requestId) || seenAttempts.has(key)
      || attempt.preregistrationDigest !== heldoutDigest(input.preregistration)) refuse('attempt-membership');
    seenAttempts.add(key);
  }
  const problems = qualificationIntegrityAllowlistProblems(input.integrity);
  if (!context) refuse('approved-calibration');
  const approved = input.approvedCalibration;
  if (approved?.mode !== 'staged' || approved.phase !== 'test'
    || !/^sha256:[0-9a-f]{64}$/.test(approved.calibrationArtifactDigest)
    || approved.calibrationArtifactDigest !== context.trustedCalibrationDigest
    || !/^sha256:[0-9a-f]{64}$/.test(approved.calibrationPhaseRecordDigest)
    || !/^sha256:[0-9a-f]{64}$/.test(approved.priorApprovalDigest)) refuse('approved-calibration');
  if (problems.includes('integrity-invalid') || heldoutDigest(input.integrity) !== context.trustedIntegrityDigest) refuse('integrity-pin');
  const analysis = prepared.analysis;
  if (heldoutDigest(analysis) !== context.trustedAnalysisDigest || input.preregistration.studyAnalysisDigest !== context.trustedAnalysisDigest) refuse('analysis-pin');
  const access = context.access;
  sealGateHoldoutFromFrozen({ frozen: input.frozen, analysis, access, keyring: context.keyring, trustedAccessDigest: context.trustedAccessDigest });
  validateStudyArtifact(access);
  if (access.schemaVersion !== 'decision-d29-access/v2' || heldoutDigest(access) !== context.trustedAccessDigest
    || access.analysisDigest !== context.trustedAnalysisDigest || !access.reference
    || !Number.isFinite(Date.parse(access.anchoredAt)) || !Number.isFinite(Date.parse(access.firstTestAccessAt))
    || Date.parse(access.anchoredAt) < Date.parse(analysis.native.frozenAt)
    || Date.parse(access.firstTestAccessAt) <= Date.parse(access.anchoredAt)) refuse('holdout-access');
  const rows = input.corpus.rows.filter(row => row.split === 'test');
  const corpusDigest = heldoutDigest(input.corpus);
  const mapped = rows.map(row => ({ row, ...observationFromAttempts(input.corpus, row, input.attempts, corpusDigest) }));
  const missing = mapped.filter(item => item.missing).map(item => item.row.id);
  const mapping = context.mapping;
  validateStudyArtifact(mapping);
  if (mapping.schemaVersion !== 'decision-d29-readiness/v2' || mapping.model !== MODEL
    || mapping.splitDigest !== analysis.splits[1].digest || mapping.definitionDigest !== heldoutDigest(input.corpus.definitions)
    || mapping.method !== analysis.calibration.method || Object.values(mapping.cells).some(cell => cell.n < analysis.calibration.minimumCellN)
    || heldoutDigest(mapping) !== context.trustedMappingDigest) refuse('mapping-pin');
  // The calibration attestation is derived from a successful D09 qualification
  // of the trusted artifact at the evaluation clock — never asserted. An
  // absent artifact (no trusted digest in history) or a failed qualification
  // refuses; it never passes decoratively.
  const calibrationRegistry = context.calibration?.registry;
  const trustedArtifact = calibrationRegistry instanceof CalibrationRegistry && typeof context.trustedCalibrationDigest === 'string'
    ? calibrationRegistry.artifactHistory().find(item => item.digest === context.trustedCalibrationDigest) : undefined;
  if (!trustedArtifact) refuse('calibration-unqualified');
  if (heldoutDigest(trustedArtifact.profile) !== heldoutDigest(analysis.calibration.profile)) refuse('calibration-profile');
  const { qualifyD29Calibration } = await import('./d29-calibration.mjs');
  qualifyD29Calibration(trustedArtifact, new Date(context.nowEpochMs).toISOString());
  const calibrationExpires = Number.isFinite(trustedArtifact.profile?.expiresAfterDays) && Number.isFinite(Date.parse(trustedArtifact.effectiveAt))
    ? new Date(Date.parse(trustedArtifact.effectiveAt) + trustedArtifact.profile.expiresAfterDays * 86400000).toISOString() : null;
  const calibrationAttestation = { id: GATE_CALIBRATION_EVIDENCE_ID, passed: true,
    ...(calibrationExpires === null ? {} : { expiresAt: calibrationExpires }) };
  const reviewers = validateReviews(prepared, context.reviews);
  if (heldoutDigest(context.reviews) !== context.trustedReviewsDigest) refuse('review-pin');
  for (const item of context.reviews.assessments) {
    if (Date.parse(item.unblindedAt) > context.nowEpochMs
      || (item.phase === 'development' ? Date.parse(item.unblindedAt) >= Date.parse(access.anchoredAt)
        : Date.parse(item.blindReviewedAt) < Date.parse(access.firstTestAccessAt))) refuse('review-time');
  }
  const gold = new Map(input.gold.rows.map(row => [row.id, row.gold]));
  const samples = [], provenance = [];
  for (const item of mapped.filter(item => !item.missing)) {
    const { row, observation } = item, host = hostContext(row);
    const calibration = context.calibration;
    if (!calibration || !(calibration.registry instanceof CalibrationRegistry) || calibration.request.actualIdentity.actualModel !== MODEL
      || calibration.request.actualIdentity.provider !== 'jev' || calibration.request.actualIdentity.backend !== 'api'
      || calibration.request.actualIdentity.primitive !== 'choice' || calibration.request.actualIdentity.adapterVersion !== '1.0.0'
      || calibration.request.actualIdentity.calibrator.id !== 'd29-readiness' || calibration.request.actualIdentity.calibrator.version !== '1'
      || Date.parse(calibration.request.at) !== context.nowEpochMs
      || calibration.request.actualIdentity.definitionDigest !== mapping.definitionDigest
      || calibration.request.actualIdentity.dataset.hash !== mapping.splitDigest
      || calibration.request.actualIdentity.calibrator.parametersDigest !== context.trustedMappingDigest) refuse('calibration-identity');
    const compatible = calibration.registry.resolve({ ...calibration.request,
      runId: heldoutDigest({ row: row.id, request: calibration.request, artifact: context.trustedCalibrationDigest }) }, calibration.policy);
    if (compatible.action !== 'allow' || compatible.artifactDigest !== context.trustedCalibrationDigest) refuse('calibration-incompatible');
    const receipt = evaluateSdlcEvidenceScreening({ schemaVersion: 'decision-sdlc-evidence-screening/v1', mode: 'shadow',
      subject: host.subject, inventory: host.inventory, gatePolicyPin: host.gatePolicyPin, nowEpochMs: context.nowEpochMs,
      ...(observation ? { observation } : {}) }, { gatePolicyPin: host.gatePolicyPin, gatePolicies: [host.policy], calibration });
    const attempts = input.attempts.filter(attempt => attempt.rowId === row.id);
    const sum = field => attempts.some(attempt => attempt.result?.[field] == null) ? null : attempts.reduce((n, attempt) => n + attempt.result[field], 0);
    const label = gold.get(row.id), saved = row.localOutcome.passageBaselineV3 ?? row.localOutcome.passageBaseline;
    const correct = (saved.route === 'ADVISORY_READY') === label.ready && (row.input.payload.kind !== 'citation' || saved.support === label.support);
    samples.push({ id: row.id, kind: host.subject.kind, slice: row.slice, gold: label,
      candidate: { route: receipt.route, support: observation?.kind === 'citation' ? observation.support : null,
        readyProbability: observation ? mapping.cells[readinessCell(observation)].probability : 0,
        latencyMs: attempts.reduce((n, attempt) => n + (attempt.result?.latencyMs ?? 0), 0),
        inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), costUsd: sum('providerCostUsd'),
        calls: attempts.length, retries: attempts.filter(attempt => attempt.ordinal > 1).length, fallbacks: 0 },
      baseline: { correct, costUsd: 0 }, reviewer: reviewers.get(row.id) ?? null });
    provenance.push({ id: row.id, receiptDigest: heldoutDigest(receipt), attempts: item.lineage, mappingDigest: context.trustedMappingDigest,
      baseline: saved, baselineDigest: heldoutDigest(saved), secondaryBaseline: row.localOutcome.baseline,
      secondaryBaselineDigest: heldoutDigest(row.localOutcome.baseline), passageBaselineV1: row.localOutcome.passageBaselineV1,
      passageBaselineV1Digest: heldoutDigest(row.localOutcome.passageBaselineV1),
      ...(row.localOutcome.passageBaselineV3 ? { passageBaselineV3: row.localOutcome.passageBaselineV3,
        passageBaselineV3Digest: heldoutDigest(row.localOutcome.passageBaselineV3) } : {}),
      reservationUsdMicros: attempts.reduce((n, attempt) => n + attempt.reservedUsdMicros, 0) });
  }
  if (input.integrity.sample_n !== rows.length || !Number.isSafeInteger(context.nowEpochMs)
    || context.nowEpochMs < Date.parse(access.firstTestAccessAt)) refuse('evaluation-time-or-n');
  const heldout = { schemaVersion: 'decision-sdlc-screening-heldout-records/v1', evaluatedAt: new Date(context.nowEpochMs).toISOString(),
    splits: analysis.splits, samples };
  const report = buildReport({ analysis, trustedAnalysisDigest: context.trustedAnalysisDigest, heldout: missing.length ? null : heldout,
    integrity: input.integrity, trustedIntegrityDigest: context.trustedIntegrityDigest, nowEpochMs: context.nowEpochMs,
    frozen: input.frozen, access, trustedAccessDigest: context.trustedAccessDigest, keyring: context.keyring, calibrationAttestation, projectRoot: context.projectRoot, requireProjectConfig: true });
  const { native, gateReport } = report;
  const groups = groupedMetrics(input.corpus, input.gold, samples, analysis.native.confidenceInterval.levelBps);
  const correct = row => (row.candidate.route === 'ADVISORY_READY') === row.gold.ready
    && (row.kind !== 'citation' || row.candidate.support === row.gold.support);
  const byId = new Map(samples.map(row => [row.id, row]));
  const counts = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
  for (const row of rows) {
    const observed = byId.get(row.id), label = gold.get(row.id), baseline = row.localOutcome.passageBaseline;
    const candidateCorrect = observed ? correct(observed) : false;
    const baselineCorrect = (baseline.route === 'ADVISORY_READY') === label.ready
      && (row.input.payload.kind !== 'citation' || baseline.support === label.support);
    counts[candidateCorrect ? baselineCorrect ? 'both' : 'candidateOnly' : baselineCorrect ? 'baselineOnly' : 'neither']++;
  }
  const failureAsError = { counts, interval: pairedBinaryDifferenceInterval({ counts, levelBps: analysis.native.confidenceInterval.levelBps }),
    missingCandidateErrors: missing.length, denominator: rows.length, promotable: false };
  return validatedArtifact({ schemaVersion: ['decision-d29-analysis/v6', 'decision-d29-analysis/v7'].includes(analysis.schemaVersion) ? 'decision-d29-score/v8'
    : analysis.schemaVersion === 'decision-d29-analysis/v5' ? 'decision-d29-score/v7' : 'decision-d29-score/v6',
    decision: report.decision, native, gateReport, groups, heldout: missing.length ? null : heldout,
    provenance, reviewerN: samples.filter(row => row.reviewer !== null).length, missingInputs: missing,
    completeCase: { n: samples.length, correct: samples.filter(correct).length },
    failureAsError,
    limitations: ['Synthetic diagnostic only; no efficiency or publication claim.', 'One reviewer, 100 unique test audits; no inter-rater evidence.'] });
}
