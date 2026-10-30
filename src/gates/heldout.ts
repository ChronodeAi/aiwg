// Verify the frozen bundle, its pinned analysis and the independently anchored first-access record.
import { heldoutDigest } from '../decision/heldout/contract.js';
import type { HeldoutBundle } from '../decision/heldout/types.js';
import { artifactDigest } from '../decision/validate.js';
import { verifyHeldoutAccess, type HeldoutAccessRecord } from '../decision/heldout/access.js';
import type { EffectKeyring } from '../effects/types.js';
import { evaluateGates, GateEvaluationError, sealGateHoldout, type EvaluateGatesInput } from './evaluate.js';
import type { GateBinding, GateHoldoutInputs, GateReport, Sha256Digest } from './types.js';

export interface HeldoutGateAnalysis { gateBinding: GateBinding }
export type HeldoutGateAccess = HeldoutAccessRecord;
export interface HeldoutGateRecords {
  frozen: { bundle: HeldoutBundle; digest: Sha256Digest };
  /** HeldoutFrozen pins the analysis by digest; the binding lives inside that analysis. */
  analysis: HeldoutGateAnalysis;
  access: HeldoutGateAccess;
  /** Protected host keyring, loaded independently of the record and caller pins. */
  keyring: EffectKeyring;
  /** Independently retained host anchor, never a digest recomputed from an untrusted access record. */
  trustedAccessDigest: Sha256Digest;
}

/**
 * Derive gate inputs from HeldoutFrozen without altering its historical bytes.
 * The existing bundle contains only corpus, preregistration and approval, so
 * its studyAnalysisDigest must first verify the supplied analysis containing
 * the binding. The access record pins that same analysis (and hence binding).
 * Its signed body covers both digests, run ID and first-access time. The host
 * selects the keyring independently; the retained access digest is an extra
 * integrity check, never a substitute for signature verification.
 */
export function sealGateHoldoutFromFrozen(input: HeldoutGateRecords): {
  trustedBindingDigest: Sha256Digest; holdout: GateHoldoutInputs;
} {
  const { frozen, analysis, access, trustedAccessDigest, keyring } = input;
  if (!frozen?.bundle || frozen.digest !== heldoutDigest(frozen.bundle)) {
    throw new GateEvaluationError('frozen bundle digest does not match its content');
  }
  const analysisDigest = frozen.bundle.preregistration?.studyAnalysisDigest;
  if (!analysis?.gateBinding || heldoutDigest(analysis) !== analysisDigest) {
    throw new GateEvaluationError('analysis digest does not match the frozen record');
  }
  if (!access || typeof trustedAccessDigest !== 'string'
    || heldoutDigest(access) !== trustedAccessDigest) {
    throw new GateEvaluationError('first-access digest does not match its trusted pin');
  }
  if (!access.signature) throw new GateEvaluationError('first-access signature missing');
  if (access.analysisDigest !== analysisDigest) {
    throw new GateEvaluationError('first-access record does not belong to the frozen analysis and binding');
  }
  if (access.frozenBundleDigest !== frozen.digest) {
    throw new GateEvaluationError('first-access frozen-bundle digest does not match the frozen record');
  }
  if (access.runId !== frozen.bundle.approval.runId) throw new GateEvaluationError('first-access run ID does not match the frozen approval');
  try { verifyHeldoutAccess(access, keyring); }
  catch (error) { throw new GateEvaluationError((error as Error).message); }
  const trustedBindingDigest = artifactDigest(analysis.gateBinding) as Sha256Digest;
  return { trustedBindingDigest,
    holdout: sealGateHoldout({ frozenDigest: trustedBindingDigest, firstAccessedAt: access.firstTestAccessAt }) };
}

/** Evaluate with a binding pin and holdout seal derived exclusively from the verified records. */
export function evaluateGatesFromHeldoutFrozen(
  input: Omit<EvaluateGatesInput, 'trustedBindingDigest' | 'holdout'> & HeldoutGateRecords,
): GateReport {
  return evaluateGates({ ...input, ...sealGateHoldoutFromFrozen(input) });
}
