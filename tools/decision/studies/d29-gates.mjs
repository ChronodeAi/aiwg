// D29 report evaluation uses verified frozen inputs and signed first-access records.
import { heldoutDigest } from '../../../src/decision/heldout/contract.ts';
import { buildSdlcScreeningReleaseReport } from '../../../src/decision/sdlc-screening.ts';
import { qualificationIntegrityAllowlistProblems } from '../../../src/decision/qualification/release.ts';
import { sealUpstream } from '../../../src/gates/evaluate.ts';
import { evaluateGatesFromHeldoutFrozen } from '../../../src/gates/heldout.ts';
import { screeningProvider } from '../../../src/gates/providers/index.ts';
import { gateRegistry, screeningRecords, d29RecordAttestations, loadD29ProjectFloors, validateStudyArtifact } from './d29.mjs';

const refuse = reason => { throw new Error(`D29 study refused (${reason})`); };

/**
 * Evaluates the preregistered absolute GateBinding over held-out samples. The binding,
 * pack and provider pins resolve inside `evaluateGates` (never trusted from the caller);
 * the holdout seal binds the frozen binding digest to the first test-access time, and the
 * upstream integrity record is sealed by digest. Missing calibration evidence fails closed,
 * as do missing record attestations. Project floors always load from the project
 * config under `projectRoot`; a caller-supplied `floors` value (including an opt-out)
 * refuses evaluation, so no caller can loosen the project ceiling.
 */
export function evaluateStudyGates(args) {
  if (Object.hasOwn(args, 'floors')) refuse('project-floors-caller-supplied');
  const { analysis, frozen, access, trustedAccessDigest, keyring, samples, heldout = null, integrity, calibrationAttestation = null, nowEpochMs,
    projectRoot, requireProjectConfig = false } = args;
  const binding = analysis.gateBinding;
  const records = [...screeningRecords(samples, calibrationAttestation),
    ...d29RecordAttestations({ binding, heldout, nowEpochMs })];
  const metrics = { providers: { [screeningProvider.id]: screeningProvider.compute(records) } };
  return evaluateGatesFromHeldoutFrozen({ binding, registry: gateRegistry(),
    frozen, analysis, access, trustedAccessDigest, keyring,
    metrics, upstream: sealUpstream(integrity), now: new Date(nowEpochMs).toISOString(),
    floors: loadD29ProjectFloors(projectRoot, { requireConfig: requireProjectConfig }) });
}


/**
 * Pure report endpoint also usable for offline fixtures; always advisory and digest-bound.
 * The native release report stays descriptive (v2 preregistration, no NI gate); the
 * preregistered GateBinding decides through `evaluateGates`, and any native
 * fail/insufficient verdict caps the outcome at HOLD (a gate ROLLBACK still
 * rolls back). The frozen bundle and the signed, independently pinned access record are
 * verified by `evaluateGatesFromHeldoutFrozen` before evaluation.
 *
 * Non-authoritative inputs: `calibrationAttestation` here is caller-asserted
 * (offline fixtures and reviewer probes). Only `score` is authoritative: it
 * derives the attestation from a D09 qualification of the trusted calibration
 * artifact and requires a project config under `context.projectRoot`. Floors
 * are never caller input on either path.
 */
export function buildReport(args) {
  if (Object.hasOwn(args, 'floors')) refuse('project-floors-caller-supplied');
  const { analysis, trustedAnalysisDigest, heldout, integrity, trustedIntegrityDigest, nowEpochMs,
    frozen, access, trustedAccessDigest, keyring, calibrationAttestation = null, projectRoot, requireProjectConfig = false } = args;
  validateStudyArtifact(analysis);
  if (heldoutDigest(analysis) !== trustedAnalysisDigest || heldoutDigest(integrity) !== trustedIntegrityDigest
    || qualificationIntegrityAllowlistProblems(integrity).includes('integrity-invalid')) refuse('report-anchor');
  const native = buildSdlcScreeningReleaseReport({ preregistration: analysis.native, trustedPreregistrationDigest: heldoutDigest(analysis.native),
    heldout, integrity, nowEpochMs });
  const samples = native.heldout && Array.isArray(heldout?.samples) ? heldout.samples : [];
  const gateReport = evaluateStudyGates({ analysis, frozen, access, trustedAccessDigest, keyring, samples, heldout, integrity, calibrationAttestation, nowEpochMs, projectRoot, requireProjectConfig });
  // The native verdict is descriptive, not a decision: rename it so no reader
  // mistakes it for one. Its digest covered the signed envelope, so it is
  // dropped with the renamed field rather than carried stale.
  const nativeRest = { ...native };
  const nativeDecision = nativeRest.decision;
  delete nativeRest.decision;
  delete nativeRest.digest;
  const descriptive = { ...nativeRest, descriptiveVerdict: nativeDecision };
  const decision = native.preregisteredDecision === 'pass' ? gateReport.decision
    : gateReport.decision === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD';
  return { native: descriptive, gateReport, decision };
}
