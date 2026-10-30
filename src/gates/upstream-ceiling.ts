// Shared upstream-ceiling evaluation with explicit policies for retained report contracts.
import { ceilingDecision, type GateOutcome } from './lattice.js';

/** Structural #2037/#2048 serialized integrity contract; no runtime dependency on tools/eval. */
export interface QualificationIntegrityMetadata {
  sample_n: number;
  uncertainty: unknown | null;
  paired_baseline: unknown | null;
  integrity_mode: string;
  fresh_workspace_required: boolean;
  fresh_workspace_verified: boolean;
  integrity_state: string;
  trusted_score_source: string;
  compromise_labels: readonly string[];
  weak_signal_reason: string | null;
  release_gate: { decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK'; reasons: readonly string[] };
}

/**
 * #2037/#2048 integrity modes whose verified state has a trusted score source.
 * Mirrors tools/eval buildIntegrityMetadata: each strict mode maps to exactly one source.
 */
export const VERIFIED_QUALIFICATION_INTEGRITY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  fresh: 'fresh-workspace',
  locked: 'locked-artifact-snapshot',
  'full-locked': 'full-locked-workspace',
});

/**
 * Allowlist check for promotable integrity metadata. Any malformed, unknown or
 * unverified mode/state/score-source is a problem; an empty result is the only
 * state that may PROMOTE. Callers still honour upstream HOLD/ROLLBACK separately.
 */
export function qualificationIntegrityAllowlistProblems(integrity: unknown): string[] {
  const value = integrity as QualificationIntegrityMetadata | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.sample_n) || value.sample_n < 0
    || typeof value.integrity_mode !== 'string' || typeof value.integrity_state !== 'string'
    || typeof value.trusted_score_source !== 'string'
    || typeof value.fresh_workspace_required !== 'boolean' || typeof value.fresh_workspace_verified !== 'boolean'
    || !Array.isArray(value.compromise_labels) || value.compromise_labels.some(label => typeof label !== 'string')
    || !(value.weak_signal_reason === null || typeof value.weak_signal_reason === 'string')
    || !('uncertainty' in value) || !('paired_baseline' in value)
    || !value.release_gate || typeof value.release_gate !== 'object'
    || !['PROMOTE', 'HOLD', 'ROLLBACK'].includes(value.release_gate.decision)
    || !Array.isArray(value.release_gate.reasons)) {
    return ['integrity-invalid'];
  }
  const problems: string[] = [];
  const expectedSource = Object.hasOwn(VERIFIED_QUALIFICATION_INTEGRITY_SOURCES, value.integrity_mode)
    ? VERIFIED_QUALIFICATION_INTEGRITY_SOURCES[value.integrity_mode] : undefined;
  if (value.integrity_state !== 'verified') problems.push('integrity-not-verified');
  if (expectedSource === undefined) problems.push('integrity-mode-not-allowlisted');
  else if (value.trusted_score_source !== expectedSource) problems.push('untrusted-score-source');
  if (value.fresh_workspace_required && !value.fresh_workspace_verified) problems.push('fresh-workspace-unverified');
  if (value.uncertainty === null || value.uncertainty === undefined) problems.push('uncertainty-missing');
  if (value.paired_baseline === null || value.paired_baseline === undefined) problems.push('paired-baseline-missing');
  if (value.weak_signal_reason !== null) problems.push('weak-signal');
  if (value.compromise_labels.length > 0) problems.push('compromised');
  if (value.sample_n <= 0) problems.push('insufficient-samples');
  if (value.release_gate.decision !== 'PROMOTE') problems.push(`upstream-integrity-${value.release_gate.decision.toLowerCase()}`);
  return problems;
}

/** Retained reports keep their original checks; gate packs use the strict allowlist by default. */
export type IntegrityPolicy = 'allowlist' | 'qualification-release' | 'ensemble' | 'context-pruning' | 'upstream';

export function integrityProblems(
  integrity: QualificationIntegrityMetadata, policy: IntegrityPolicy = 'allowlist', minimumSamples = 1,
): string[] {
  if (policy === 'allowlist') return qualificationIntegrityAllowlistProblems(integrity);
  if (policy === 'upstream') return [];
  const problems: string[] = [];
  if (integrity.integrity_state !== 'verified') problems.push('integrity-not-verified');
  if (policy === 'context-pruning') {
    if (integrity.release_gate.decision === 'ROLLBACK') problems.push('upstream-rollback');
    if (integrity.release_gate.decision === 'HOLD') problems.push('upstream-hold');
    return problems;
  }
  if (integrity.integrity_mode === 'standard') problems.push('integrity-mode-standard');
  if (integrity.trusted_score_source === 'local-unverified') problems.push('untrusted-score-source');
  if (policy === 'ensemble' && integrity.fresh_workspace_required && !integrity.fresh_workspace_verified) {
    problems.push('fresh-workspace-unverified');
  }
  if (integrity.uncertainty === null) problems.push('uncertainty-missing');
  if (policy === 'ensemble' && integrity.paired_baseline === null) problems.push('paired-baseline-missing');
  if (policy === 'ensemble' && integrity.weak_signal_reason !== null) problems.push('weak-signal');
  if (integrity.compromise_labels.length > 0) problems.push('compromised');
  if (policy === 'qualification-release' ? !(integrity.sample_n > 0) : integrity.sample_n < minimumSamples) {
    problems.push('insufficient-samples');
  }
  return problems;
}

/** Evaluate the same upstream-ceiling primitive used by the integrity-ceiling pack.
 * Callers validate/seal evidence before evaluation. Legacy policies preserve their
 * versioned report semantics, including context pruning's verified-state-only check.
 */
export function evaluateUpstreamCeiling(
  integrity: QualificationIntegrityMetadata | null,
  options: { policy?: IntegrityPolicy; minimumSamples?: number; findings?: number } = {},
): { ceiling: GateOutcome; problems: string[]; compromised: boolean } {
  if (integrity === null) return { ceiling: 'HOLD', problems: ['upstream-ceiling-missing'], compromised: false };
  const policy = options.policy ?? 'allowlist';
  const problems = integrityProblems(integrity, policy, options.minimumSamples);
  const release = integrity?.release_gate?.decision;
  const hasCompromiseLabels = policy === 'allowlist' ? problems.includes('compromised')
    : (integrity?.compromise_labels?.length ?? 0) > 0;
  const compromised = release === 'ROLLBACK' || (policy !== 'context-pruning'
    && (integrity?.integrity_state === 'compromised' || hasCompromiseLabels));
  return {
    ceiling: ceilingDecision(release ?? 'HOLD', compromised ? 'ROLLBACK' : 'PROMOTE',
      problems.length || (options.findings ?? 0) > 0 ? 'HOLD' : 'PROMOTE'),
    problems, compromised,
  };
}
