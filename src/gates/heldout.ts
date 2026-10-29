// Verify the frozen bundle, its pinned analysis and the independently anchored first-access record.
import { heldoutDigest } from '../decision/heldout/contract.js';
import type { HeldoutBundle } from '../decision/heldout/types.js';
import { artifactDigest } from '../decision/validate.js';
import { evaluateGates, GateEvaluationError, sealGateHoldout, type EvaluateGatesInput } from './evaluate.js';
import type { GateBinding, GateHoldoutInputs, GateReport, Sha256Digest } from './types.js';

export interface HeldoutGateAnalysis { gateBinding: GateBinding }
export interface HeldoutGateAccess { analysisDigest: Sha256Digest; firstTestAccessAt: string }
export interface HeldoutGateRecords {
  frozen: { bundle: HeldoutBundle; digest: Sha256Digest };
  /** HeldoutFrozen pins the analysis by digest; the binding lives inside that analysis. */
  analysis: HeldoutGateAnalysis;
  access: HeldoutGateAccess;
  /** Independently retained host anchor, never a digest recomputed from an untrusted access record. */
  trustedAccessDigest: Sha256Digest;
}

/**
 * Derive gate inputs from HeldoutFrozen without altering its historical bytes.
 * The existing bundle contains only corpus, preregistration and approval, so
 * its studyAnalysisDigest must first verify the supplied analysis containing
 * the binding. The access record pins that same analysis (and hence binding).
 * Its timestamp is covered by the independently trusted access digest.
 * Neither an unkeyed digest nor the access record alone authenticates a clock:
 * D29 access/v1 has no signature or frozen-bundle digest. The host must retain
 * the access anchor independently, just as for the existing D29 scorer.
 */
export function sealGateHoldoutFromFrozen(input: HeldoutGateRecords): {
  trustedBindingDigest: Sha256Digest; holdout: GateHoldoutInputs;
} {
  const { frozen, analysis, access, trustedAccessDigest } = input;
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
  if (access.analysisDigest !== analysisDigest) {
    throw new GateEvaluationError('first-access record does not belong to the frozen analysis and binding');
  }
  if (typeof access.firstTestAccessAt !== 'string' || !Number.isFinite(Date.parse(access.firstTestAccessAt))) {
    throw new GateEvaluationError('first-access timestamp is not a valid date-time');
  }
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
