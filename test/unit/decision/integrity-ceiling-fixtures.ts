// Synthetic integrity variants with the findings required by retained report policies.
import type { QualificationIntegrityMetadata } from '../../../src/gates/upstream-ceiling.js';

export const integrityOutcomes = ['PROMOTE', 'HOLD', 'ROLLBACK'] as const;
export const integrityVariants: {
  name: string; patch: Partial<QualificationIntegrityMetadata>; releaseHold: boolean; ensemble: string[]; contextHold: boolean;
}[] = [
  { name: 'verified', patch: {}, releaseHold: false, ensemble: [], contextHold: false },
  { name: 'unverified', patch: { integrity_state: 'unverified' }, releaseHold: true, ensemble: ['integrity-not-verified'], contextHold: true },
  { name: 'compromised state', patch: { integrity_state: 'compromised' }, releaseHold: true, ensemble: ['integrity-not-verified'], contextHold: true },
  { name: 'compromise label', patch: { compromise_labels: ['fixture_edit'] }, releaseHold: true, ensemble: ['compromised'], contextHold: false },
  { name: 'standard mode', patch: { integrity_mode: 'standard' }, releaseHold: true, ensemble: ['integrity-mode-standard'], contextHold: false },
  { name: 'retained custom mode', patch: { integrity_mode: 'isolated' }, releaseHold: false, ensemble: [], contextHold: false },
  { name: 'untrusted source', patch: { trusted_score_source: 'local-unverified' }, releaseHold: true, ensemble: ['untrusted-score-source'], contextHold: false },
  { name: 'retained custom source', patch: { trusted_score_source: 'fixture' }, releaseHold: false, ensemble: [], contextHold: false },
  { name: 'fresh workspace missing', patch: { fresh_workspace_required: true, fresh_workspace_verified: false }, releaseHold: false, ensemble: ['fresh-workspace-unverified'], contextHold: false },
  { name: 'optional fresh workspace', patch: { fresh_workspace_required: false, fresh_workspace_verified: false }, releaseHold: false, ensemble: [], contextHold: false },
  { name: 'uncertainty missing', patch: { uncertainty: null }, releaseHold: true, ensemble: ['uncertainty-missing'], contextHold: false },
  { name: 'baseline missing', patch: { paired_baseline: null }, releaseHold: false, ensemble: ['paired-baseline-missing'], contextHold: false },
  { name: 'weak signal', patch: { weak_signal_reason: 'fixture' }, releaseHold: false, ensemble: ['weak-signal'], contextHold: false },
  { name: 'no samples', patch: { sample_n: 0 }, releaseHold: true, ensemble: ['insufficient-samples'], contextHold: false },
  { name: 'insufficient pairs', patch: { sample_n: 1 }, releaseHold: false, ensemble: ['insufficient-samples'], contextHold: false },
];

export function syntheticIntegrity(overrides: Partial<QualificationIntegrityMetadata> = {}): QualificationIntegrityMetadata {
  return { sample_n: 1000, uncertainty: { method: 'fixture' }, paired_baseline: { id: 'fixture' },
    integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: true,
    integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [], weak_signal_reason: null,
    release_gate: { decision: 'PROMOTE', reasons: [] }, ...overrides };
}
