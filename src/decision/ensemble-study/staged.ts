import { heldoutDigest, validateHeldoutInputs } from '../heldout/contract.js';
import type { Digest, HeldoutPreregistration } from '../heldout/types.js';
import { d17DryRun, prepareD17Study } from './corpus.js';
import { D17_ANALYSIS, D17_CALIBRATION } from './protocol.js';
import { validateD17Artifact } from './artifacts.js';

/**
 * Staged D09 calibration preparation (#2611). The corpus, gold, split manifest, review template and native
 * templates are exactly the diagnostic ones for the same seed (the corpus module, and therefore the corpus
 * pin, is unchanged); only the preregistration, the v2 analysis, the calibration-phase approval form and the
 * per-phase dry run differ. The v1 diagnostic preparation remains available and unchanged.
 */
export function prepareD17StagedStudy(seed: string, moduleDigest: Digest, sourceDigests: Record<string, Digest>) {
  const base = prepareD17Study(seed, moduleDigest, sourceDigests);
  const analysis = { schemaVersion: 'decision-d17-analysis/v2', protocol: D17_ANALYSIS, scope: 'staged-calibrated',
    calibration: D17_CALIBRATION, sourceDigests: base.analysis.sourceDigests, splitManifestDigest: base.analysis.splitManifestDigest,
    nativeTemplatesDigest: base.analysis.nativeTemplatesDigest };
  validateD17Artifact('analysisV2', analysis);
  const preregistration: HeldoutPreregistration = { ...base.preregistration, studyAnalysisDigest: heldoutDigest(analysis),
    calibration: { scope: 'calibrated', allowedModes: ['staged'], calibrationPhaseSplits: [...D17_CALIBRATION.phaseSplits] } };
  validateHeldoutInputs(base.corpus, preregistration);
  // The study starts with the calibration-phase approval; the test-phase form comes from the reviewed calibration set.
  const approvalTemplate = { ...base.approvalTemplate, preregistrationDigest: heldoutDigest(preregistration),
    calibration: { mode: 'staged', phase: 'calibration' } };
  const dryRun = d17StagedDryRun();
  validateD17Artifact('dryRunV2', dryRun);
  return { ...base, preregistration, analysis, approvalTemplate, dryRun };
}

/** Staged planning bounds: the same 7,200 first attempts, split into the calibration and test phases. */
export function d17StagedDryRun() {
  return { ...d17DryRun(), schemaVersion: 'decision-d17-dry-run/v2',
    phases: { calibration: { splits: ['tuning', 'calibration'], rows: 600, firstAttempts: 2400, worstCaseAttempts: 4800 },
      test: { splits: ['test'], rows: 1200, firstAttempts: 4800, worstCaseAttempts: 9600 } },
    missingInputs: ['completed 40-item development review', 'calibration-phase operator approval', 'exact-source CI evidence',
      'provider terms', 'prior study and portfolio spend', 'region and credential resolver pin', 'calibration-phase live observations',
      'fitted and operator-reviewed D09 calibration set', 'test-phase operator approval', 'test-phase live observations', 'blind human review'] };
}
