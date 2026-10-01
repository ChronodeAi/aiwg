import { artifactDigest } from '../decision/validate.js';
import { evaluateGates, maxOutcome, type EvaluateGatesInput } from './evaluate.js';
import { validateGateDocument } from './schema.js';
import type { GateOutcome, GateReport } from './types.js';

export interface GateReportValidation {
  valid: boolean;
  reasons: string[];
}

/**
 * Validates a gate report against its inputs. Every pin the report claims is
 * re-derived from the supplied inputs, the digest is recomputed from the report's
 * own fields, and the decision is re-derived by re-running the pure evaluator, so
 * a report can never upgrade any component: tampered evidence breaks the digest,
 * and a downgraded decision breaks re-derivation. Returns reasons instead of
 * throwing so callers can log them.
 */
export function validateGateReport(report: unknown, input: EvaluateGatesInput): GateReportValidation {
  const reasons: string[] = [];
  let parsed: GateReport;
  try {
    parsed = validateGateDocument<GateReport>(report);
  } catch (error) {
    return { valid: false, reasons: [`report-schema:${error instanceof Error ? error.message : 'invalid'}`] };
  }
  const { digest, ...fields } = parsed;
  if (artifactDigest(fields) !== digest) reasons.push('report-digest-mismatch');
  if (artifactDigest(input.resolved.binding) !== parsed.binding.digest) reasons.push('report-binding-mismatch');
  if (input.trustedBindingDigest !== parsed.binding.digest) reasons.push('report-binding-untrusted');
  for (const pack of input.resolved.packs) {
    const pin = parsed.packs.find(candidate => candidate.id === pack.authored.metadata.id);
    if (pin === undefined || pin.digest !== pack.digest) reasons.push(`report-pack-mismatch:${pack.authored.metadata.id}`);
  }
  if (artifactDigest(input.metrics) !== parsed.metricsDigest) reasons.push('report-metrics-mismatch');
  if ((input.upstream?.digest ?? null) !== (parsed.upstream?.digest ?? null)) {
    reasons.push('report-upstream-mismatch');
  }
  let expected: GateReport;
  try {
    expected = evaluateGates({ ...input, now: parsed.evaluatedAt });
  } catch (error) {
    return { valid: false, reasons: [...reasons, `report-reevaluation:${error instanceof Error ? error.message : 'refused'}`] };
  }
  if (expected.decision !== parsed.decision) reasons.push('report-decision-mismatch');
  const components: GateOutcome[] = [
    ...parsed.gateEvidence.map(entry => entry.outcome),
    parsed.ceilings.packOutcome, parsed.ceilings.upstreamCeiling, parsed.ceilings.bindingCeiling,
  ];
  if (maxOutcome(parsed.decision, maxOutcome(...components)) !== parsed.decision) {
    reasons.push('report-upgrades-component');
  }
  return { valid: reasons.length === 0, reasons };
}
