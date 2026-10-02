import { heldoutDigest, heldoutRequestSize, heldoutReservationMicros, heldoutReservationTokens, validateHeldoutInputs } from '../heldout/contract.js';
import { heldoutCollectionAllowance } from '../heldout/journal.js';
import type { Digest, HeldoutApproval, HeldoutAttempt, HeldoutCorpus, HeldoutPreregistration } from '../heldout/types.js';
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

type PlanApproval = Pick<HeldoutApproval, 'model' | 'region' | 'credentialRef' | 'priceBound'>;
interface PhasePlan { rows: number; firstAttempts: number; maximumAttempts: number; maximumRequestEstimateTokens: number;
  reservedTokens: number; reservedUsdMicros: number }

/**
 * Worst-case reservations for both staged phases from the actual projected request bytes and the approval's price bound,
 * with every preregistered retry. The collector plans one phase at a time; this bounds the whole study before any spend.
 */
export async function d17TwoPhasePlan(corpus: HeldoutCorpus, preregistration: HeldoutPreregistration, approval: PlanApproval) {
  const sizing = { ...approval, calibration: { mode: 'uncalibrated-diagnostic' } } as unknown as HeldoutApproval;
  const attemptsPerRequest = 1 + preregistration.providerFailurePolicy.maxRetries;
  const phase = async (splits: readonly string[]): Promise<PhasePlan> => {
    const plan: PhasePlan = { rows: 0, firstAttempts: 0, maximumAttempts: 0, maximumRequestEstimateTokens: 0, reservedTokens: 0, reservedUsdMicros: 0 };
    for (const row of corpus.rows.filter(item => splits.includes(item.split))) {
      plan.rows++;
      for (const request of row.requests) {
        const { estimatedTokens } = await heldoutRequestSize(corpus, preregistration, sizing, row, request);
        plan.firstAttempts++; plan.maximumAttempts += attemptsPerRequest;
        plan.maximumRequestEstimateTokens = Math.max(plan.maximumRequestEstimateTokens, estimatedTokens);
        plan.reservedTokens += attemptsPerRequest * heldoutReservationTokens(preregistration, estimatedTokens);
        plan.reservedUsdMicros += attemptsPerRequest * heldoutReservationMicros(sizing, estimatedTokens);
      }
    }
    return plan;
  };
  const calibration = await phase(D17_CALIBRATION.phaseSplits), test = await phase(['test']);
  return { calibration, test, combined: { maximumAttempts: calibration.maximumAttempts + test.maximumAttempts,
    reservedTokens: calibration.reservedTokens + test.reservedTokens, reservedUsdMicros: calibration.reservedUsdMicros + test.reservedUsdMicros } };
}

/** Both phases must fit the remaining collector allowance (the 80% stop thresholds net of prior charges). */
export function d17TwoPhaseFit(plan: Awaited<ReturnType<typeof d17TwoPhasePlan>>, allowance: { calls: number; tokens: number; usdMicros: number }) {
  const headroom = { calls: allowance.calls - plan.combined.maximumAttempts, tokens: allowance.tokens - plan.combined.reservedTokens,
    usdMicros: allowance.usdMicros - plan.combined.reservedUsdMicros };
  return { allowance: { ...allowance }, headroom, fits: headroom.calls >= 0 && headroom.tokens >= 0 && headroom.usdMicros >= 0 };
}

/** A fresh ledger's allowance for an approval: the first approval's thresholds net of its attested prior spend floors. */
export function d17FreshAllowance(approval: HeldoutApproval) {
  return heldoutCollectionAllowance(approval, { studyUsdMicros: Math.ceil(approval.priorStudySpendUsd * 1_000_000),
    portfolioUsdMicros: Math.ceil(approval.priorPortfolioSpendUsd * 1_000_000), studyCalls: 0, studyReservedTokens: 0,
    counterBlocked: false, attempts: [], journalDigests: [], runs: [] });
}

/**
 * The staged corpus is the diagnostic corpus for the same seed. Any attempt in the ledger on this corpus under another
 * preregistration (for example a diagnostic run that saw test rows) means the seed is spent: use a fresh seed.
 */
export function assertD17SeedUnused(attempts: readonly HeldoutAttempt[], approval: Pick<HeldoutApproval, 'corpusDigest' | 'preregistrationDigest'>) {
  if (attempts.some(attempt => attempt.corpusDigest === approval.corpusDigest && attempt.preregistrationDigest !== approval.preregistrationDigest)) {
    throw new Error('D17 seed reused: this corpus already has observations under another preregistration');
  }
}
