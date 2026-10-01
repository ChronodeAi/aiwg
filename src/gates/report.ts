import { canonicalJson } from '../security/artifact-trust.js';
import { artifactDigest } from '../decision/validate.js';
import { evaluateGates, maxOutcome, type EvaluateGatesInput } from './evaluate.js';
import { validateGateDocument } from './schema.js';
import type { GateOutcome, GateReport } from './types.js';

export interface GateReportValidation {
  valid: boolean;
  reasons: string[];
}

/**
 * Validates a gate report against its trusted inputs. The report is re-derived
 * by re-running the pure evaluator from the same trusted inputs (binding,
 * registry, holdout, metrics, upstream) and must be byte-identical: the
 * expected digest must equal the parsed digest. A forged report that rewrites
 * evidence and reseals the digest still fails, because re-derivation from
 * trusted inputs reproduces the honest bytes. Returns reasons instead of
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
  if (artifactDigest(input.binding) !== parsed.binding.digest) reasons.push('report-binding-mismatch');
  if (input.trustedBindingDigest !== parsed.binding.digest) reasons.push('report-binding-untrusted');
  if (input.holdout === undefined || input.holdout === null
    || input.holdout.frozenDigest !== parsed.binding.digest) {
    reasons.push('report-holdout-mismatch');
  }
  if ((input.holdout as { digest?: unknown } | null | undefined) !== undefined
    && (input.holdout as { digest?: unknown } | null | undefined) !== null) {
    const sealed = input.holdout as { digest?: unknown; firstAccessedAt?: unknown };
    if (sealed.digest !== (parsed as { holdout?: { digest?: unknown } }).holdout?.digest
      || sealed.firstAccessedAt !== (parsed as { holdout?: { firstAccessedAt?: unknown } }).holdout?.firstAccessedAt) {
      reasons.push('report-holdout-mismatch');
    }
  }
  if ((parsed as { holdout?: { digest?: unknown; frozenDigest?: unknown } }).holdout?.digest === undefined
    || (parsed as { holdout?: { frozenDigest?: unknown } }).holdout?.frozenDigest !== parsed.binding.digest) {
    reasons.push('report-holdout-mismatch');
  }
  for (const pin of input.binding.spec.packs) {
    const found = parsed.packs.find(candidate => candidate.id === pin.id);
    if (found === undefined || found.digest !== pin.digest || found.resolvedDigest !== pin.resolvedDigest) {
      reasons.push(`report-pack-mismatch:${pin.id}`);
    }
  }
  if (artifactDigest(input.metrics) !== parsed.metricsDigest
    // Bundle-provider sections are reproduced by isolated re-run, so the
    // caller-asserted document is not the evaluated one; re-derivation below
    // is authoritative for those bindings.
    && (input.providerRuntime === undefined
      || !input.binding.spec.metricProviders.some(pin =>
        typeof (pin as { codeDigest?: unknown }).codeDigest === 'string'))) {
    reasons.push('report-metrics-mismatch');
  }
  // The report records which floors governed it (R2): an applied digest or an
  // explicit opt-out marker. The input must say the same; re-derivation below
  // additionally reproduces the distinction byte-identically.
  const expectedFloors = input.floors === 'none-explicit-opt-out'
    ? 'opt-out' : `applied:${artifactDigest(input.floors)}`;
  const reportedFloors = parsed.floors.mode === 'applied' ? `applied:${parsed.floors.digest}` : 'opt-out';
  if (reportedFloors !== expectedFloors) reasons.push('report-floors-mismatch');
  if ((input.upstream?.digest ?? null) !== (parsed.upstream?.digest ?? null)) {
    reasons.push('report-upstream-mismatch');
  }
  let expected: GateReport;
  try {
    expected = evaluateGates({ ...input, now: parsed.evaluatedAt });
  } catch (error) {
    return { valid: false, reasons: [...reasons, `report-reevaluation:${error instanceof Error ? error.message : 'refused'}`] };
  }
  // Byte-identical re-derivation: the evaluator is deterministic, so the honest
  // report's canonical bytes must match exactly. Comparing digests (which hash
  // the canonical bytes) is equivalent and cheaper than a byte comparison; the
  // canonical comparison is the independent second route.
  if (expected.digest !== parsed.digest
    || canonicalJson(stripDigest(expected)) !== canonicalJson(fields)) {
    reasons.push('report-reevaluation-mismatch');
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

function stripDigest(report: GateReport): Omit<GateReport, 'digest'> {
  const { digest: _dropped, ...fields } = report;
  void _dropped;
  return fields;
}
