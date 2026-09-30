import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { heldoutDigest } from '../../../src/decision/heldout/contract.ts';
import { readHeldoutCalibrationPhase } from '../../../src/decision/heldout/calibration.ts';
import { CalibrationRegistry, calibrationArtifactDigest } from '../../../src/decision/calibration/registry.ts';
import { evaluateBinaryCalibration, wilsonScoreInterval } from '../../../src/decision/qualification/quality.ts';
import { prepare, fitReadinessMapping, observationFromAttempts, readinessCell, validateStudyArtifact } from './d29.mjs';

const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
const validateArtifact = ajv.compile(JSON.parse(readFileSync(new URL('../../../schemas/decision/CalibrationArtifact.v1.schema.json', import.meta.url), 'utf8')));
const refuse = reason => { throw new Error(`D29 study refused (${reason})`); };
const policy = { unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' };

/** Read verified sealed journals, then fit and measure only the calibration membership. No approval is inferred. */
export async function prepareCalibrationHandoff({ run, trustedApprovalDigest, trustedCalibrationPhaseRecordDigest }) {
  const sealed = await readHeldoutCalibrationPhase(run, trustedApprovalDigest, trustedCalibrationPhaseRecordDigest);
  const prepared = await prepare(sealed.bundle.corpus.provenance.seed);
  if (heldoutDigest(prepared.corpus) !== heldoutDigest(sealed.bundle.corpus)
    || heldoutDigest(prepared.preregistration) !== heldoutDigest(sealed.bundle.preregistration)) refuse('frozen-study-mismatch');
  const rows = prepared.corpus.rows.filter(row => row.split === 'calibration'), members = new Set(rows.map(row => row.id));
  const attempts = sealed.attempts.filter(attempt => members.has(attempt.rowId));
  const mapping = fitReadinessMapping(prepared, attempts), mappingDigest = heldoutDigest(mapping);
  const gold = new Map(prepared.gold.rows.filter(row => members.has(row.id)).map(row => [row.id, row.gold]));
  const samples = rows.map(row => {
    const { observation } = observationFromAttempts(prepared.corpus, row, attempts);
    const probability = observation ? mapping.cells[readinessCell(observation)].probability : 0;
    const observed = attempts.filter(attempt => attempt.rowId === row.id);
    const sum = field => observed.some(attempt => attempt.result?.[field] == null) ? null : observed.reduce((n, attempt) => n + attempt.result[field], 0);
    return { id: row.id, slice: row.slice, label: Number(gold.get(row.id).ready), probability, accepted: probability >= 0.5,
      latencyMs: observed.reduce((n, attempt) => n + attempt.result.latencyMs, 0), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
      costUsd: sum('providerCostUsd'), calls: observed.length, retries: observed.filter(attempt => attempt.ordinal > 1).length, fallbacks: 0 };
  });
  const measured = evaluateBinaryCalibration(prepared.analysis.splits, samples), profile = prepared.analysis.calibration.profile;
  if (profile.confidenceInterval.method !== 'wilson' || measured.overall.selectiveRisk === null) refuse('calibration-metrics-unknown');
  const interval = (events, n) => {
    const [lower, upper] = wilsonScoreInterval({ events, n, levelBps: Math.round(profile.confidenceInterval.level * 10000) });
    return { lower, upper };
  };
  const accepted = samples.filter(sample => sample.accepted);
  const confidenceIntervals = { selectiveRisk: interval(accepted.filter(sample => sample.label === 0).length, accepted.length),
    ...Object.fromEntries(Object.entries(mapping.cells).map(([id, cell]) => [`readiness:${id}`, interval(cell.ready, cell.n)])) };
  const draft = { schemaVersion: 'decision-calibration-artifact/v1', id: `d29-readiness-${mappingDigest.slice(7)}`,
    identity: { provider: 'jev', backend: 'api', actualModel: mapping.model, primitive: 'choice', definitionDigest: mapping.definitionDigest,
      adapterVersion: '1.0.0', dataset: { id: 'd29-calibration', hash: mapping.splitDigest }, slice: { id: 'd29-all-calibration-slices', hash: mapping.splitDigest },
      calibrator: { id: 'd29-readiness', version: '1', parametersDigest: mappingDigest } },
    splitProvenance: { id: 'd29-calibration', hash: mapping.splitDigest, holdoutAccessedAt: null }, profile,
    metrics: { totalSamples: measured.overall.sampleN, perSliceSamples: Math.min(...Object.values(measured.slices).map(slice => slice.sampleN)),
      calibrationError: measured.overall.expectedCalibrationError, selectiveRisk: measured.overall.selectiveRisk, confidenceIntervals },
    effectiveAt: sealed.record.sealedAt, limitations: [
      'Synthetic calibration-split fit diagnostics only; no independent test qualification or production authority.',
      'Decile ECE includes deterministic blockers; selective risk uses readiness probability >= 0.5. Wilson intervals describe binomial rates, not ECE.',
      `Observation source: ${sealed.source}; calibration attempts: ${mapping.evidenceDigest}.`,
      `Sealed phase: ${trustedCalibrationPhaseRecordDigest}; prior approval: ${trustedApprovalDigest}.`,
    ], approval: { state: 'observed', reference: null } };
  const artifact = { ...draft, digest: calibrationArtifactDigest(draft) };
  if (!validateArtifact(artifact)) refuse('calibration-artifact-schema');
  const approval = { ...prepared.approval, budget: structuredClone(sealed.bundle.approval.budget),
    priorStudySpendUsd: sealed.bundle.approval.priorStudySpendUsd, priorPortfolioSpendUsd: sealed.bundle.approval.priorPortfolioSpendUsd,
    calibration: { mode: 'staged', phase: 'test', calibrationArtifactDigest: artifact.digest,
      calibrationPhaseRecordDigest: trustedCalibrationPhaseRecordDigest, priorApprovalDigest: trustedApprovalDigest } };
  return { mapping, artifact, calibrationArtifactDigest: artifact.digest, approval };
}

/** Only a separately anchored operator review can produce an approved, usable D09 artifact. */
export async function registerCalibrationHandoff(input) {
  const { review, trustedReviewDigest } = input;
  try { validateStudyArtifact(review); } catch { refuse('calibration-review'); }
  if (review?.schemaVersion !== 'decision-d29-calibration-review/v1' || !review.approvalReference.trim()
    || heldoutDigest(review) !== trustedReviewDigest) refuse('calibration-review');
  const handoff = await prepareCalibrationHandoff(input), { artifact } = handoff;
  if (review.calibrationArtifactDigest !== artifact.digest || Date.parse(review.reviewedAt) < Date.parse(artifact.effectiveAt)) refuse('calibration-review');
  const { digest, ...payload } = artifact;
  payload.approval = { state: 'approved', reference: review.approvalReference };
  const approved = { ...payload, digest: calibrationArtifactDigest(payload) };
  const compatibility = qualifyD29Calibration(approved, review.reviewedAt);
  return { ...handoff, artifact: approved, calibrationArtifactDigest: approved.digest, compatibility,
    approval: { ...handoff.approval, calibration: { ...handoff.approval.calibration, calibrationArtifactDigest: approved.digest } } };
}

/** Apply the frozen D09 profile and its selective-risk interval before emitting a usable registration. */
export function qualifyD29Calibration(artifact, at) {
  if (!validateArtifact(artifact)) refuse('calibration-artifact-schema');
  const registry = new CalibrationRegistry(); registry.registerArtifact(artifact);
  const compatibility = registry.resolve({ runId: `d29-registration-${artifact.digest.slice(7)}`, requestedAlias: artifact.identity.actualModel,
    actualIdentity: artifact.identity, calibrationArtifactId: artifact.id, at }, policy);
  if (compatibility.action !== 'allow' || artifact.profile.confidenceInterval.method !== 'wilson'
    || !artifact.metrics.confidenceIntervals.selectiveRisk
    || artifact.metrics.confidenceIntervals.selectiveRisk.upper > artifact.profile.maximumSelectiveRisk) refuse('calibration-unqualified');
  return compatibility;
}
