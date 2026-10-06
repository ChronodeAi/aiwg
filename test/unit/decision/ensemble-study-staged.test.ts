import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepare, runD17Bundle, runD17Calibration, runD17PhaseDryRun } from '../../../tools/decision/d17-study.mjs';
import { collectHeldoutStudy, scoreHeldoutStudy } from '../../../src/decision/heldout/collector.js';
import { readHeldoutCalibrationPhase } from '../../../src/decision/heldout/calibration.js';
import { heldoutDigest, heldoutExecutionDigest, validateHeldoutBundle } from '../../../src/decision/heldout/contract.js';
import { heldoutRunsRoot, readHeldoutJournal, scanHeldoutSpend } from '../../../src/decision/heldout/journal.js';
import type { HeldoutAttempt, HeldoutBundle } from '../../../src/decision/heldout/types.js';
import { CalibrationRegistry, calibrationArtifactDigest } from '../../../src/decision/calibration/registry.js';
import { applyD17Mapping, d17AttemptsByRow, d17CalibrationHandoffFromSealed, d17RawProbabilities, fitD17Calibration, fitD17Isotonic,
  qualifyD17Calibration, registerD17CalibrationFromHandoff, validateD17DevelopmentReview } from '../../../src/decision/ensemble-study/calibration.js';
import { buildD17NativeReport, d17NativeHandoff, d17NativeIntegrity, scoreD17StagedStudy, scoreD17Study } from '../../../src/decision/ensemble-study/score.js';
import { assertD17SeedUnused, d17FreshAllowance, d17TwoPhaseFit, d17TwoPhasePlan } from '../../../src/decision/ensemble-study/staged.js';
import { promoteChampionChallenger } from '../../../src/decision/ensemble/runtime.js';
import { buildIntegrityMetadata } from '../../../tools/eval/src/integrity.js';
import { validateD17Artifact } from '../../../src/decision/ensemble-study/artifacts.js';
import { D17_CALIBRATION } from '../../../src/decision/ensemble-study/protocol.js';
import { validateEnsembleIntegrityReport } from '../../../src/decision/ensemble/contract.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';

// Offline source/root attestation seam; no test acquires a live credential or transport.
const preflight = vi.hoisted(() => ({ canonical: '' }));
vi.mock('../../../src/decision/context-live-qualification.js', async original => {
  const module = await original<typeof import('../../../src/decision/context-live-qualification.js')>();
  return { ...module, assertContextLiveSource: vi.fn(async () => {}),
    assertContextArtifactRoot: vi.fn(async (_source: string, root: string, mode = 'exact') => {
      if (mode === 'exact' ? root !== preflight.canonical : !root.startsWith(preflight.canonical)) throw new Error('root');
    }) };
});

// Entry admission measures a 1s wall-clock budget; freeze only performance.now() for the whole file (as in #2848 and
// d29-test-support.mjs) so host load never trips it, including during the file-level preparation below.
const ADMISSION_CLOCK = ['performance'] as const;
beforeAll(() => { vi.useFakeTimers({ toFake: [...ADMISSION_CLOCK] }); });
beforeEach(() => { vi.useFakeTimers({ toFake: [...ADMISSION_CLOCK] }); });
afterAll(() => { vi.useRealTimers(); });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const pin = heldoutDigest('d17-staged-offline');
type Staged = Awaited<ReturnType<typeof prepare>>;
let staged: Staged, diagnostic: Staged;
beforeAll(async () => {
  [staged, diagnostic] = await Promise.all([prepare('d17-staged-offline', 'staged'), prepare('d17-staged-offline')]);
}, 120_000);

function reply(init?: RequestInit, yes = 0.9) {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
    { type: 'choice', choice: yes >= 0.5 ? 'yes' : 'no', confidence: Math.max(yes, 1 - yes), probabilities: { yes, no: 1 - yes } }])),
    usage: { input_tokens: 20, output_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
}
function developmentReview(prepared: Staged, reviewedAt = '2026-10-01T00:00:00Z') {
  const review = structuredClone(prepared.reviewTemplate) as any;
  Object.assign(review, { reviewer: 'fixture-reviewer', preregistrationReview: 'fixture preregistration review' });
  for (const item of review.assessments) if (item.stage === 'development') Object.assign(item, { reviewedAt,
    goldAuditLabel: prepared.gold.labels[item.rowId], goldAmbiguousOrIncorrect: false, rationale: 'fixture: facts establish the stated label' });
  return review;
}
function approval(bundle: Pick<HeldoutBundle, 'corpus' | 'preregistration'>, runId: string, calibration: HeldoutBundle['approval']['calibration'],
  approvalReference = 'fixture-only') {
  const value = { schemaVersion: 'decision-heldout-approval/v1', approved: true, study: 'D17', runId, reviewer: 'fixture-reviewer',
    approvalReference, sourceCommit: 'a'.repeat(40), exactHeadCi: 'fixture-ci', stagingHost: 'titan',
    stagingWorkspace: 'fixture-workspace', model: 'jev-1.13.0', servedModel: 'jev-1.13.0', region: 'fixture-region',
    credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: pin, corpusDigest: heldoutDigest(bundle.corpus),
    preregistrationDigest: heldoutDigest(bundle.preregistration), executionDigest: pin, calibration,
    providerTermsReference: 'fixture-synthetic-only', priceBound: { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
      evidenceReferences: ['fixture-rate'], approvalReference: 'fixture-attestation' }, budget: { calls: 100, tokens: 400000, usd: 1 },
    priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 } as HeldoutBundle['approval'];
  value.executionDigest = heldoutExecutionDigest(bundle.corpus, bundle.preregistration, value);
  return value;
}
/** A reduced staged study: a few calibration-phase rows and one test row; digests recomputed for the subset. */
function reduced(prepared: Staged) {
  const small = structuredClone(prepared);
  const pick = (split: string, n: number) => small.corpus.rows.filter(row => row.split === split).slice(0, n);
  small.corpus.rows = [...pick('tuning', 1), ...pick('calibration', 2), ...pick('test', 1)];
  small.preregistration.corpusDigest = heldoutDigest(small.corpus);
  return small;
}
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'ensemble-study-staged-')); dirs.push(dir); preflight.canonical = dir; return dir;
}
let template: HeldoutAttempt | null = null;
/** One real receipt-bearing attempt from an offline collection; synthetic attempts patch only its distribution. */
async function receiptTemplate() {
  if (template) return template;
  const dir = await root(), small = reduced(staged);
  const bundle = { corpus: small.corpus, preregistration: small.preregistration,
    approval: approval(small, 'd17-template', { mode: 'staged', phase: 'calibration' }) } as HeldoutBundle;
  let time = Date.parse('2026-10-01T01:00:00Z');
  await collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(bundle.approval), artifactRoot: dir,
    sourceRoot: process.cwd(), offline: { transport: vi.fn(async (_url: unknown, init?: RequestInit) => reply(init)),
      host: { resolveCredential: async () => new TextEncoder().encode('fake-d17-reader'), dispose: () => {} } },
    now: () => time, sleep: async (ms: number) => { time += ms; } });
  const events = await readHeldoutJournal(join(heldoutRunsRoot(dir), 'd17-template'));
  template = events.find(event => event.attempt.result?.disposition === 'success')!.attempt;
  return template;
}
const pins = new WeakMap<object, { corpusDigest: string; preregistrationDigest: string }>();
function synthetic(base: HeldoutAttempt, prepared: Staged, rowId: string, requestId: string, yes: number): HeldoutAttempt {
  const attempt = structuredClone(base);
  if (!pins.has(prepared)) pins.set(prepared, { corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration) });
  Object.assign(attempt, { rowId, requestId, ordinal: 1, ...pins.get(prepared) });
  const q0 = attempt.result!.receipt!.spec.evaluations.q0 as any;
  q0.spec.value = yes >= 0.5 ? 'yes' : 'no';
  q0.spec.uncertainty.distribution = { yes, no: 1 - yes };
  attempt.result!.receiptDigest = heldoutDigest(attempt.result!.receipt);
  return attempt;
}
type YesFn = (prepared: Staged, rowId: string, index: number, member: number) => number;
const spread = (index: number, member: number) => [0.92, 0.85, 0.78, 0.97][(index + member) % 4]!;
/** Deterministic synthetic native probabilities: about 5% confident errors shared by every call. */
const observedYes: YesFn = (prepared, rowId, index, member) => {
  const gold = prepared.gold.labels[rowId] === 'yes', right = index % 20 === 0 ? !gold : gold;
  return right ? spread(index, member) : 1 - spread(index, member);
};
/** A better ensemble: the single champion call errs on 4% of rows, all three members together on 0.5%. */
const promoteYes: YesFn = (prepared, rowId, index, member) => {
  const gold = prepared.gold.labels[rowId] === 'yes';
  const right = member === 0 ? index % 25 !== 0 : index % 200 !== 0;
  return (right ? gold : !gold) ? spread(index, member) : 1 - spread(index, member);
};
/** Uninformative scores: the label carries no signal, so only an in-sample fit can look calibrated. */
const noiseYes: YesFn = (_prepared, rowId, _index, member) => Number.parseInt(rowId.slice(8 * member, 8 * member + 6), 16) % 97 / 100 + 0.01;
function attemptsFor(base: HeldoutAttempt, prepared: Staged, split: string, yes: YesFn = observedYes) {
  return prepared.corpus.rows.filter(row => row.split === split).flatMap((row, index) =>
    ['champion', 'member_1', 'member_2', 'member_3'].map((requestId, member) =>
      synthetic(base, prepared, row.id, requestId, yes(prepared, row.id, index, member))));
}
const sealedAt = '2026-10-01T02:00:00.000Z', reviewedAt = '2026-10-01T03:00:00Z', accessAt = '2026-10-01T04:00:00.000Z';
const evaluatedAt = Date.parse('2026-10-02T00:00:00Z');
/** A full staged calibration phase from synthetic sealed attempts: review-bound approval, fit, operator review, registration. */
async function stagedFlow(yes: YesFn = observedYes) {
  const base = await receiptTemplate();
  const review = developmentReview(staged);
  const phaseApproval = approval(staged, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' },
    `roctinam calibration-phase approval citing development review ${heldoutDigest(review)}`);
  const record = { schemaVersion: 'decision-heldout-calibration-phase/v1', study: 'D17', runId: 'd17-calibration-01',
    corpusDigest: heldoutDigest(staged.corpus), preregistrationDigest: heldoutDigest(staged.preregistration),
    approvalDigest: heldoutDigest(phaseApproval), sealedAt, rowIds: [], lineage: [], lineageDigest: pin } as const;
  const calibration = attemptsFor(base, staged, 'calibration', yes);
  const sealed = { bundle: { corpus: staged.corpus, preregistration: staged.preregistration, approval: phaseApproval },
    source: 'injected-transport' as const, record: record as any, attempts: [...attemptsFor(base, staged, 'tuning', yes), ...calibration] };
  const handoffInput = { sealed, prepared: staged, trustedApprovalDigest: heldoutDigest(phaseApproval),
    trustedCalibrationPhaseRecordDigest: heldoutDigest(record), developmentReview: review, trustedDevelopmentReviewDigest: heldoutDigest(review) };
  const observed = d17CalibrationHandoffFromSealed(handoffInput);
  const calibrationReview = { ...observed.reviewTemplate, approved: true, reviewer: phaseApproval.reviewer, approvalReference: 'offline-fixture-only', reviewedAt };
  const registered = registerD17CalibrationFromHandoff(observed, calibrationReview, heldoutDigest(calibrationReview));
  const context = { sealed, registered: { set: registered.set, artifacts: registered.artifacts, mappings: registered.mappings },
    trustedCalibrationSetDigest: registered.calibrationSetDigest, calibrationReview, trustedCalibrationReviewDigest: heldoutDigest(calibrationReview),
    developmentReview: review, trustedDevelopmentReviewDigest: heldoutDigest(review), testPhaseAccessAt: accessAt as string | null, nowEpochMs: evaluatedAt };
  const testApproval = approval(staged, 'd17-test-01', registered.approval.calibration as HeldoutBundle['approval']['calibration']);
  const input = { corpus: { ...staged.corpus, rows: staged.corpus.rows.filter(row => row.split === 'test') }, preregistration: staged.preregistration,
    attempts: attemptsFor(base, staged, 'test', yes).map(attempt => ({ ...attempt, approvalDigest: heldoutDigest(testApproval) })),
    gold: staged.gold, integrity: verifiedHold(), approvedCalibration: testApproval.calibration, calibrated: null };
  return { base, review, phaseApproval, handoffInput, observed, calibrationReview, registered, context, input, calibration };
}
function verifiedHold(): QualificationIntegrityMetadata {
  return { sample_n: 1200, uncertainty: { method: 'newcombe-10', levelBps: 9500 }, paired_baseline: { n: 1200 }, integrity_mode: 'locked',
    fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot',
    compromise_labels: [], weak_signal_reason: null, release_gate: { decision: 'HOLD', reasons: ['offline-control'] } };
}

describe('D17 staged D09 preparation', () => {
  it('keeps the frozen corpus, split and gold pins and preregisters only the two-phase calibrated scope', () => {
    expect(heldoutDigest(staged.corpus)).toBe(heldoutDigest(diagnostic.corpus));
    expect(heldoutDigest(staged.gold)).toBe(heldoutDigest(diagnostic.gold));
    expect(heldoutDigest(staged.splitManifest)).toBe(heldoutDigest(diagnostic.splitManifest));
    expect(staged.preregistration.calibration).toEqual({ scope: 'calibrated', allowedModes: ['staged'], calibrationPhaseSplits: ['tuning', 'calibration'] });
    expect(diagnostic.preregistration.calibration).toEqual({ scope: 'uncalibrated-diagnostic', allowedModes: ['uncalibrated-diagnostic'] });
    expect(staged.preregistration.studyAnalysisDigest).toBe(heldoutDigest(staged.analysis));
    expect(staged.analysis).toMatchObject({ schemaVersion: 'decision-d17-analysis/v2', scope: 'staged-calibrated', calibration: D17_CALIBRATION });
    expect(D17_CALIBRATION.qualificationMetrics).toEqual({ method: 'slice-stratified-k-fold-out-of-fold', folds: 5,
      assignment: 'row-id-order-within-slice-modulo-folds', finalMapping: 'full-calibration-split' });
    expect(diagnostic.analysis.schemaVersion).toBe('decision-d17-analysis/v1');
    expect(staged.approvalTemplate).toMatchObject({ approved: false, calibration: { mode: 'staged', phase: 'calibration' },
      preregistrationDigest: heldoutDigest(staged.preregistration), budget: { calls: 24000, tokens: 96000000, usd: 8 } });
    expect(staged.dryRun).toMatchObject({ schemaVersion: 'decision-d17-dry-run/v2', providerCalls: 0,
      approvalCeilings: { calls: 24000, tokens: 96000000, usd: 8 },
      phases: { calibration: { rows: 600, firstAttempts: 2400 }, test: { rows: 1200, firstAttempts: 4800 } } });
    // New versions never widen the v1 contracts.
    expect(() => validateD17Artifact('analysis', staged.analysis)).toThrow('invalid analysis');
    expect(() => validateD17Artifact('dryRun', staged.dryRun)).toThrow('invalid dryRun');
    expect(() => validateD17Artifact('analysisV2', { ...staged.analysis, calibration: { ...D17_CALIBRATION, minimumBlockN: 1 } })).toThrow('invalid analysisV2');
  });
  it('refuses calibration-phase approvals on the diagnostic preregistration and diagnostic approvals on the staged one', () => {
    const calibration = approval(staged, 'd17-calibration', { mode: 'staged', phase: 'calibration' });
    expect(() => validateHeldoutBundle({ corpus: staged.corpus, preregistration: staged.preregistration, approval: calibration },
      heldoutDigest(calibration))).not.toThrow();
    const diagnosticApproval = approval(staged, 'd17-diagnostic', { mode: 'uncalibrated-diagnostic' });
    expect(() => validateHeldoutBundle({ corpus: staged.corpus, preregistration: staged.preregistration, approval: diagnosticApproval },
      heldoutDigest(diagnosticApproval))).toThrow('calibration-scope');
    const crossed = approval(diagnostic, 'd17-crossed', { mode: 'staged', phase: 'calibration' });
    expect(() => validateHeldoutBundle({ corpus: diagnostic.corpus, preregistration: diagnostic.preregistration, approval: crossed },
      heldoutDigest(crossed))).toThrow('calibration-scope');
  });
  it('E bounds both phases from real request sizes before any spend', async () => {
    const plan = await d17TwoPhasePlan(staged.corpus, staged.preregistration,
      { ...staged.approvalTemplate, region: 'offline-planning', credentialRef: 'offline-planning' } as any);
    expect(plan.calibration).toMatchObject({ rows: 600, firstAttempts: 2400, maximumAttempts: 4800 });
    expect(plan.test).toMatchObject({ rows: 1200, firstAttempts: 4800, maximumAttempts: 9600 });
    expect(plan.combined.maximumAttempts).toBe(14400);
    expect(plan.combined.reservedTokens).toBeLessThan(57_600_000);
    const template = { ...staged.approvalTemplate, priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 } as any;
    // The operator-authorized 24,000-call / 96M-token budget gives a 19,200-call allowance: 4,800 calls of headroom.
    expect(d17TwoPhaseFit(plan, d17FreshAllowance(template))).toMatchObject({ fits: true,
      allowance: { calls: 19200, tokens: 76800000, usdMicros: 6400000 }, headroom: { calls: 4800 } });
    expect(d17TwoPhaseFit(plan, d17FreshAllowance({ ...template, priorStudySpendUsd: 0.099052 })).fits).toBe(true);
    // The previous 18,000-call budget left exactly zero headroom; one call fewer cannot hold both phases.
    expect(d17TwoPhaseFit(plan, d17FreshAllowance({ ...template, budget: { ...template.budget, calls: 18000 } }))).toMatchObject({ headroom: { calls: 0 } });
    expect(d17TwoPhaseFit(plan, d17FreshAllowance({ ...template, budget: { ...template.budget, calls: 17999 } })).fits).toBe(false);
  }, 120_000);
});

describe('D17 isotonic calibration', () => {
  it('fits a monotone, minimum-support step function with Laplace-smoothed blocks', () => {
    const samples = [...Array.from({ length: 30 }, (_, i) => ({ score: 0.1, label: Number(i < 3) as 0 | 1 })),
      ...Array.from({ length: 4 }, () => ({ score: 0.5, label: 0 as const })),
      ...Array.from({ length: 30 }, (_, i) => ({ score: 0.9, label: Number(i >= 2) as 0 | 1 }))];
    const blocks = fitD17Isotonic(samples);
    expect(blocks.every(block => block.n >= D17_CALIBRATION.minimumBlockN)).toBe(true);
    expect(blocks.map(block => block.probability)).toEqual([...blocks.map(block => block.probability)].sort((a, b) => a - b));
    expect(blocks.reduce((n, block) => n + block.n, 0)).toBe(64);
    for (const block of blocks) expect(block.probability).toBe((block.yes + 1) / (block.n + 2));
    expect(fitD17Isotonic([...samples].reverse())).toEqual(blocks);
    const mapping = { blocks };
    expect(applyD17Mapping(mapping, 0)).toBe(blocks[0]!.probability);
    expect(applyD17Mapping(mapping, 1)).toBe(blocks.at(-1)!.probability);
    expect(() => applyD17Mapping(mapping, 1.5)).toThrow('calibration-input');
    expect(() => fitD17Isotonic([{ score: Number.NaN, label: 1 }])).toThrow('calibration-samples');
  });
});

describe('D17 development review precondition', () => {
  it('requires 40 complete development assessments that agree with gold and the text oracle, before the seal, with test stages blank', () => {
    const review = developmentReview(staged), digest = heldoutDigest(review);
    expect(() => validateD17DevelopmentReview(staged, review, digest, { before: '2026-10-02T00:00:00Z', testStagesBlank: true })).not.toThrow();
    expect(() => validateD17DevelopmentReview(staged, staged.reviewTemplate, heldoutDigest(staged.reviewTemplate))).toThrow('development-review');
    expect(() => validateD17DevelopmentReview(staged, review, pin)).toThrow('development-review');
    const cases: Array<[(value: any) => void, string]> = [
      [value => { value.assessments[0].goldAmbiguousOrIncorrect = true; }, 'development-gold-invalid'],
      [value => { value.assessments[0].goldAuditLabel = value.assessments[0].goldAuditLabel === 'yes' ? 'no' : 'yes'; }, 'development-review-incomplete'],
      [value => { value.assessments[1].rationale = null; }, 'development-review-incomplete'],
      [value => { value.assessments[2].reviewedAt = null; }, 'development-review-incomplete'],
      [value => { value.assessments.find((item: any) => item.stage === 'blind-test').reviewedAt = '2026-10-01T00:00:00Z'; }, 'test-review-before-test-phase'],
      [value => { value.assessments[3].payload = 'changed'; }, 'development-review'],
    ];
    for (const [mutate, reason] of cases) {
      const changed = structuredClone(review); mutate(changed);
      expect(() => validateD17DevelopmentReview(staged, changed, heldoutDigest(changed), { testStagesBlank: true })).toThrow(reason);
    }
    expect(() => validateD17DevelopmentReview(staged, review, digest, { before: '2026-10-01T00:00:00Z' })).toThrow('development-review-time');
  });
  it('G/E assembles a bundle only with a completed review that the approval cites, and a test bundle only with a qualified set', async () => {
    const dir = await root(), preparedDir = join(dir, 'prepared');
    const { writeHeldoutFile } = await import('../../../src/decision/heldout/journal.js');
    const { mkdir } = await import('node:fs/promises'); await mkdir(preparedDir);
    for (const name of ['corpus', 'preregistration', 'gold'] as const) await writeHeldoutFile(join(preparedDir, `${name}.json`), staged[name]);
    const review = developmentReview(staged), reviewDigest = heldoutDigest(review);
    const uncited = approval(staged, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' });
    const fullBudget = { budget: { calls: 24000, tokens: 96000000, usd: 8 } };
    const uncitedFull = { ...uncited, ...fullBudget };
    const cited = { ...approval(staged, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' }, `approval citing ${reviewDigest}`), ...fullBudget };
    const tooSmall = { ...cited, budget: { ...cited.budget, calls: 17999, tokens: 72000000 } };
    for (const [name, value] of [['uncited', uncitedFull], ['cited', cited], ['small', tooSmall]] as const) {
      await writeFile(join(dir, `${name}.json`), JSON.stringify(value));
    }
    await writeFile(join(dir, 'template.json'), JSON.stringify(staged.reviewTemplate));
    await writeFile(join(dir, 'review.json'), JSON.stringify(review));
    const bundle = (approvalFile: string, reviewFile = 'review.json', digest = reviewDigest, out = 'refused.json', extra: string[] = []) =>
      runD17Bundle([preparedDir, join(dir, approvalFile), join(dir, reviewFile), digest, join(dir, out), ...extra]);
    await expect(bundle('cited.json', 'template.json', heldoutDigest(staged.reviewTemplate))).rejects.toThrow('development-review');
    await expect(bundle('uncited.json')).rejects.toThrow('development-review-not-bound');
    await expect(bundle('small.json')).rejects.toThrow('two-phase');
    await expect(readFile(join(dir, 'refused.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const accepted = await bundle('cited.json', 'review.json', reviewDigest, 'bundle.json');
    expect(accepted).toMatchObject({ providerCalls: 0, phase: 'calibration', approvalDigest: heldoutDigest(cited),
      twoPhaseFreshLedger: { fits: true } });
    expect(Object.keys(JSON.parse(await readFile(join(dir, 'bundle.json'), 'utf8'))).sort()).toEqual(['approval', 'corpus', 'preregistration']);
    // A test-phase bundle needs the calibration context (sealed run, registered set and calibration review).
    const testForm = approval(staged, 'd17-test-01', { mode: 'staged', phase: 'test', calibrationArtifactDigest: pin,
      calibrationPhaseRecordDigest: pin, priorApprovalDigest: heldoutDigest(cited) });
    await writeFile(join(dir, 'test.json'), JSON.stringify(testForm));
    await expect(bundle('test.json')).rejects.toThrow('usage');
    await writeFile(join(dir, 'context.json'), JSON.stringify({ calibrationRun: dir, calibrationDir: dir, calibrationReviewFile: join(dir, 'review.json'),
      trustedCalibrationReviewDigest: pin }));
    await expect(bundle('test.json', 'review.json', reviewDigest, 'refused.json', [join(dir, 'context.json')])).rejects.toThrow();
    await expect(readFile(join(dir, 'refused.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});

describe('D17 staged calibration phase through the shared collector', () => {
  it('collects only calibration-phase rows, seals the phase and refuses unsupported, unbound or unreproduced fits', async () => {
    const dir = await root(), small = reduced(staged);
    const review = developmentReview(small, '2026-10-01T00:30:00Z');
    const bundle = { corpus: small.corpus, preregistration: small.preregistration,
      approval: approval(small, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' }, `cites ${heldoutDigest(review)}`) } as HeldoutBundle;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init));
    const host = { resolveCredential: async () => new TextEncoder().encode('fake-d17-reader'), dispose: () => {} };
    let time = Date.parse('2026-10-01T01:00:00Z');
    const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
    const summary = await collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(bundle.approval), artifactRoot: dir,
      sourceRoot: process.cwd(), offline: { transport, host }, ...clock });
    if (summary.status === 'disabled') throw new Error('expected offline collection');
    expect(summary).toMatchObject({ status: 'complete', completedRows: 3 });
    expect(transport).toHaveBeenCalledTimes(12);
    const run = join(heldoutRunsRoot(dir), 'd17-calibration-01');
    const sealed = await readHeldoutCalibrationPhase(run, heldoutDigest(bundle.approval), summary.calibrationPhaseRecordDigest!);
    expect(sealed.attempts.every(attempt => small.corpus.rows.find(row => row.id === attempt.rowId)!.split !== 'test')).toBe(true);
    const input = { sealed, prepared: small, trustedApprovalDigest: heldoutDigest(bundle.approval),
      trustedCalibrationPhaseRecordDigest: summary.calibrationPhaseRecordDigest!, developmentReview: review, trustedDevelopmentReviewDigest: heldoutDigest(review) };
    // Two calibration rows cannot meet the preregistered 380-row support; nothing is fitted.
    expect(() => d17CalibrationHandoffFromSealed(input)).toThrow('calibration-support');
    expect(() => d17CalibrationHandoffFromSealed({ ...input, developmentReview: small.reviewTemplate,
      trustedDevelopmentReviewDigest: heldoutDigest(small.reviewTemplate) })).toThrow('development-review');
    expect(() => d17CalibrationHandoffFromSealed({ ...input, prepared: staged })).toThrow('frozen-study-mismatch');
    expect(() => d17CalibrationHandoffFromSealed({ ...input, trustedCalibrationPhaseRecordDigest: pin })).toThrow('calibration-phase-seal');
    const late = developmentReview(small, '2026-10-02T00:00:00Z');
    expect(() => d17CalibrationHandoffFromSealed({ ...input, developmentReview: late, trustedDevelopmentReviewDigest: heldoutDigest(late) }))
      .toThrow('development-review-time');
    // G: a review completed in time but not cited by the approval that authorized the spend is refused.
    const other = developmentReview(small, '2026-10-01T00:40:00Z');
    expect(() => d17CalibrationHandoffFromSealed({ ...input, developmentReview: other, trustedDevelopmentReviewDigest: heldoutDigest(other) }))
      .toThrow('development-review-not-bound');
    // The CLI regenerates the study from the sealed seed; a reduced corpus never reproduces it.
    await writeFile(join(dir, 'review.json'), JSON.stringify(review));
    await expect(runD17Calibration('--fit-calibration', [run, heldoutDigest(bundle.approval), summary.calibrationPhaseRecordDigest!,
      join(dir, 'review.json'), heldoutDigest(review), join(dir, 'fit')])).rejects.toThrow('frozen-study-mismatch');
    await expect(readFile(join(dir, 'fit', 'calibration-set.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Test phase: the collector admits only test rows after the seal; scoring hands the staged scorer `calibrated: null`.
    const testBundle = { ...bundle, approval: approval(small, 'd17-test-01', { mode: 'staged', phase: 'test', calibrationArtifactDigest: pin,
      calibrationPhaseRecordDigest: summary.calibrationPhaseRecordDigest!, priorApprovalDigest: heldoutDigest(bundle.approval) }) } as HeldoutBundle;
    time += 60_000;
    const tested = await collectHeldoutStudy({ enabled: true, bundle: testBundle, trustedApprovalDigest: heldoutDigest(testBundle.approval), artifactRoot: dir,
      sourceRoot: process.cwd(), offline: { transport, host }, ...clock });
    if (tested.status === 'disabled') throw new Error('expected offline collection');
    expect(tested).toMatchObject({ status: 'complete', completedRows: 1 }); expect(transport).toHaveBeenCalledTimes(16);
    const integrity: QualificationIntegrityMetadata = { sample_n: 1, uncertainty: null, paired_baseline: null, integrity_mode: 'standard',
      fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'not-assessed', trusted_score_source: 'local-unverified',
      compromise_labels: [], weak_signal_reason: 'offline-control', release_gate: { decision: 'HOLD', reasons: ['offline-control'] } };
    const scoring = { run: join(heldoutRunsRoot(dir), 'd17-test-01'), trustedEvidenceDigest: tested.evidenceDigest,
      trustedApprovalDigest: heldoutDigest(testBundle.approval), gold: small.gold, integrity, trustedIntegrityDigest: heldoutDigest(integrity),
      moduleDigest: small.preregistration.scorerDigest };
    const seen: any[] = [];
    await expect(scoreHeldoutStudy({ ...scoring, module: { prepare: async () => small, score: async scored => {
      seen.push(scored);
      return scoreD17StagedStudy(scored, small, { sealed, registered: { set: {}, artifacts: {} as any, mappings: {} as any },
        trustedCalibrationSetDigest: pin, calibrationReview: {}, trustedCalibrationReviewDigest: pin, developmentReview: review,
        trustedDevelopmentReviewDigest: heldoutDigest(review), testPhaseAccessAt: accessAt, nowEpochMs: time });
    } } })).rejects.toThrow('calibration');
    expect(seen[0]).toMatchObject({ calibrated: null, approvedCalibration: { mode: 'staged', phase: 'test' } });
    expect(seen[0].corpus.rows.map((row: any) => row.split)).toEqual(['test']);
    // F: the wrapper reflects a staged scorer's validation only when it names the exact approved binding.
    const claim = (calibrationSetDigest: string) => ({ calibrated: true, d09Qualified: true, calibratedGate: true, decision: 'HOLD',
      calibration: { mode: 'staged-test', calibrationSetDigest } });
    expect(await scoreHeldoutStudy({ ...scoring, module: { prepare: async () => small, score: async () => claim(pin) } }))
      .toMatchObject({ calibrated: true, d09Qualified: true, calibratedGate: true, calibrationArtifactValidation: 'performed-by-study-scorer', decision: 'HOLD' });
    expect(await scoreHeldoutStudy({ ...scoring, module: { prepare: async () => small, score: async () => claim(heldoutDigest('other')) } }))
      .toMatchObject({ calibrated: null, d09Qualified: false, calibratedGate: false, calibrationArtifactValidation: 'not-performed' });
    expect(await scoreHeldoutStudy({ ...scoring, module: { prepare: async () => small, score: async () => ({ decision: 'HOLD' }) } }))
      .toMatchObject({ calibrated: null, d09Qualified: false, calibrationArtifactValidation: 'not-performed' });
  }, 120_000);
  it('G refuses a seed whose corpus already has diagnostic observations, in the collector and before spend', async () => {
    const dir = await root(), small = reduced(staged);
    const diagnosticSmall = { corpus: small.corpus, preregistration: { ...diagnostic.preregistration, corpusDigest: heldoutDigest(small.corpus) } };
    const host = { resolveCredential: async () => new TextEncoder().encode('fake-d17-reader'), dispose: () => {} };
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init));
    let time = Date.parse('2026-10-01T01:00:00Z');
    const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
    const seen = { ...diagnosticSmall, approval: approval(diagnosticSmall, 'd17-diagnostic-01', { mode: 'uncalibrated-diagnostic' }) } as HeldoutBundle;
    const first = await collectHeldoutStudy({ enabled: true, bundle: seen, trustedApprovalDigest: heldoutDigest(seen.approval), artifactRoot: dir,
      sourceRoot: process.cwd(), offline: { transport, host }, ...clock });
    expect(first).toMatchObject({ status: 'complete', completedRows: 4 });
    const review = developmentReview(small);
    const reused = { corpus: small.corpus, preregistration: small.preregistration,
      approval: approval(small, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' }, `cites ${heldoutDigest(review)}`) } as HeldoutBundle;
    await expect(collectHeldoutStudy({ enabled: true, bundle: reused, trustedApprovalDigest: heldoutDigest(reused.approval), artifactRoot: dir,
      sourceRoot: process.cwd(), offline: { transport, host }, ...clock })).rejects.toThrow('changed-preregistration');
    const scan = await scanHeldoutSpend(dir, 'D17');
    expect(() => assertD17SeedUnused(scan.attempts, reused.approval)).toThrow('seed reused');
    await writeFile(join(dir, 'bundle.json'), JSON.stringify(reused));
    await expect(runD17PhaseDryRun([join(dir, 'bundle.json'), heldoutDigest(reused.approval), dir])).rejects.toThrow('seed reused');
  }, 120_000);
});

describe('D17 calibration fit, registration and calibrated test-phase scoring', () => {
  it('fits only calibration rows from this study, gates on out-of-fold metrics and requires a reviewed, qualified registration', async () => {
    const { base, calibration, observed, registered, calibrationReview } = await stagedFlow();
    // Tuning and test observations never change the fitted calibrators.
    expect(fitD17Calibration(staged, [...calibration, ...attemptsFor(base, staged, 'test').slice(0, 40)])).toEqual(observed.mappings);
    expect(() => fitD17Calibration(staged, attemptsFor(base, staged, 'tuning'))).toThrow('calibration-support');
    // P6: attempts pinned to another study, corpus or preregistration are refused by the library fit itself.
    for (const patch of [{ study: 'D29' }, { corpusDigest: pin }, { preregistrationDigest: pin }]) {
      expect(() => fitD17Calibration(staged, calibration.map(attempt => ({ ...attempt, ...patch }) as HeldoutAttempt))).toThrow('attempt-membership');
    }
    expect(observed.mappings.member).toMatchObject({ role: 'member', n: 1600, rows: 400, calibrator: { id: 'd17-single-call-isotonic' } });
    expect(observed.mappings.aggregate).toMatchObject({ role: 'aggregate', n: 400, rows: 400, calibrator: { id: 'd17-three-sample-mean-isotonic' } });
    for (const role of ['member', 'aggregate'] as const) {
      const artifact = observed.artifacts[role], { qualification } = observed.mappings[role];
      expect(qualification).toMatchObject({ method: 'slice-stratified-k-fold-out-of-fold', folds: 5 });
      // D: the artifact gates on the out-of-fold metrics, not the in-sample ones.
      expect(artifact.metrics).toEqual(qualification.outOfFold);
      expect(artifact).toMatchObject({ schemaVersion: 'decision-calibration-artifact/v1', approval: { state: 'observed', reference: null },
        effectiveAt: sealedAt, identity: { actualModel: 'jev-1.13.0', calibrator: { parametersDigest: heldoutDigest(observed.mappings[role]) } },
        metrics: { totalSamples: 400, perSliceSamples: 100 } });
      expect(() => qualifyD17Calibration(artifact, reviewedAt)).toThrow('calibration-unqualified');
      expect(registered.compatibility[role]).toMatchObject({ action: 'allow', state: 'exact' });
      expect(registered.artifacts[role].approval).toEqual({ state: 'approved', reference: 'reviewer=fixture-reviewer; offline-fixture-only' });
      // C: the registry refuses an artifact before it takes effect, so a back-dated clock cannot qualify it.
      expect(() => qualifyD17Calibration(registered.artifacts[role], '2026-10-01T01:00:00Z')).toThrow('calibration-unqualified');
    }
    expect(observed.approval).toMatchObject({ approved: false, runId: null, calibration: { mode: 'staged', phase: 'test',
      calibrationArtifactDigest: observed.calibrationSetDigest } });
    expect(registered.approval.calibration).toMatchObject({ calibrationArtifactDigest: heldoutDigest(registered.set) });
    for (const changed of [{ ...calibrationReview, memberArtifactDigest: pin }, { ...calibrationReview, reviewedAt: '2026-09-30T00:00:00Z' },
      { ...calibrationReview, approved: null }, { ...calibrationReview, reviewer: 'someone-else' }]) {
      expect(() => registerD17CalibrationFromHandoff(observed, changed, heldoutDigest(changed))).toThrow('calibration-review');
    }
    expect(() => registerD17CalibrationFromHandoff(observed, calibrationReview, pin)).toThrow('calibration-review');
    expect(() => qualifyD17Calibration(registered.artifacts.member, '2026-12-01T00:00:00Z')).toThrow('calibration-unqualified');
    for (const patch of [{ selectiveRisk: 0.5 }, { totalSamples: 10 }, { confidenceIntervals: { selectiveRisk: { lower: 0, upper: 0.2 } } }]) {
      const { digest: _digest, ...payload } = structuredClone(registered.artifacts.member); Object.assign(payload.metrics, patch);
      expect(() => qualifyD17Calibration({ ...payload, digest: calibrationArtifactDigest(payload) }, reviewedAt)).toThrow('calibration-unqualified');
    }
  }, 120_000);
  it('D out-of-fold metrics expose uninformative scores that an in-sample fit hides', async () => {
    const base = await receiptTemplate();
    const mappings = fitD17Calibration(staged, attemptsFor(base, staged, 'calibration', noiseYes));
    for (const role of ['member', 'aggregate'] as const) {
      const { inSample, outOfFold } = mappings[role].qualification;
      expect(outOfFold.calibrationError).toBeGreaterThan(inSample.calibrationError);
      expect(outOfFold.confidenceIntervals.selectiveRisk.upper).toBeGreaterThan(D17_CALIBRATION.profile.maximumSelectiveRisk);
    }
  }, 120_000);
  it('B/C scores calibrated probabilities only for a set re-derived from the seal, at a clock after review and test access', async () => {
    const { registered, context, input, base } = await stagedFlow();
    const report = await scoreD17StagedStudy(input, staged, context);
    expect(report).toMatchObject({ schemaVersion: 'decision-d17-study-report/v2', calibrated: true, d09Qualified: true, calibratedGate: true,
      decision: 'HOLD', calibrationReviewDigest: context.trustedCalibrationReviewDigest,
      calibration: { mode: 'staged-test', calibrationSetDigest: heldoutDigest(registered.set),
        member: { artifactDigest: registered.artifacts.member.digest, compatibility: { action: 'allow' } },
        aggregate: { artifactDigest: registered.artifacts.aggregate.digest } }, gates: { source: 'd17-native-protocol', gateBinding: null } });
    expect(report.pairs).toHaveLength(1200);
    const row = staged.corpus.rows.find(item => item.split === 'test')!;
    expect(report.pairs[0]!.champion.probability).toBe(applyD17Mapping(registered.mappings.member, observedYes(staged, row.id, 0, 0)));
    const rawMean = [1, 2, 3].reduce((sum, member) => sum + observedYes(staged, row.id, 0, member), 0) / 3;
    expect(report.pairs[0]!.challenger.probability).toBe(applyD17Mapping(registered.mappings.aggregate, rawMean));
    expect(report.uncalibratedStatistics.sampleN).toBe(1200);
    expect(report.calibrationDiagnostics.calibrated).toBe(true);
    expect(() => validateD17Artifact('reportV2', { ...report, decision: 'PROMOTE' })).toThrow('invalid reportV2');
    expect(await scoreD17StagedStudy({ ...input, integrity: { ...input.integrity, release_gate: { decision: 'ROLLBACK', reasons: ['control'] } } }, staged, context))
      .toMatchObject({ decision: 'ROLLBACK' });
    // P1: mappings fitted on TEST observations, with artifacts hand-set to approved, never score.
    const testAttempts = d17AttemptsByRow(attemptsFor(base, staged, 'test'));
    const forged = (role: 'member' | 'aggregate') => {
      const samples = staged.corpus.rows.filter(item => item.split === 'test').flatMap(item => {
        const raw = d17RawProbabilities(testAttempts.get(item.id) ?? [], item), label = Number(staged.gold.labels[item.id] === 'yes') as 0 | 1;
        return role === 'member' ? [raw.champion, ...raw.members].map(score => ({ score: score!, label })) : [{ score: raw.mean!, label }];
      });
      const mapping = { ...registered.mappings[role], blocks: fitD17Isotonic(samples), n: samples.length };
      const { digest: _digest, ...payload } = structuredClone(registered.artifacts[role]);
      payload.identity.calibrator.parametersDigest = heldoutDigest(mapping);
      return { mapping, artifact: { ...payload, digest: calibrationArtifactDigest(payload) } };
    };
    const member = forged('member'), aggregate = forged('aggregate');
    const forgedSet = { ...registered.set, member: { artifactId: member.artifact.id, artifactDigest: member.artifact.digest, mappingDigest: heldoutDigest(member.mapping) },
      aggregate: { artifactId: aggregate.artifact.id, artifactDigest: aggregate.artifact.digest, mappingDigest: heldoutDigest(aggregate.mapping) } };
    const forgedCalibration = { ...input.approvedCalibration, calibrationArtifactDigest: heldoutDigest(forgedSet) };
    await expect(scoreD17StagedStudy({ ...input, approvedCalibration: forgedCalibration }, staged, { ...context,
      trustedCalibrationSetDigest: heldoutDigest(forgedSet), registered: { set: forgedSet, artifacts: { member: member.artifact, aggregate: aggregate.artifact },
        mappings: { member: member.mapping, aggregate: aggregate.mapping } } })).rejects.toThrow('calibration-set');
    // Registered files that differ from the re-derivation (even with the honest set digest) are refused.
    await expect(scoreD17StagedStudy(input, staged, { ...context, registered: { ...context.registered,
      mappings: { ...registered.mappings, member: member.mapping } } })).rejects.toThrow('calibration-registered-mismatch');
    const refusals: Array<[Partial<typeof context>, string]> = [
      [{ trustedCalibrationSetDigest: pin }, 'calibration-set'],
      [{ trustedCalibrationReviewDigest: pin }, 'calibration-review'],
      [{ calibrationReview: { ...context.calibrationReview, approvalReference: 'changed' } }, 'calibration-review'],
      // Reviewer identity is bound: the same reference and time under another reviewer, even anchored, is refused.
      [{ calibrationReview: { ...context.calibrationReview, reviewer: 'someone-else' },
        trustedCalibrationReviewDigest: heldoutDigest({ ...context.calibrationReview, reviewer: 'someone-else' }) }, 'calibration-review'],
      // P2: a clock before the calibration review, or before the recorded first test access, is refused.
      [{ nowEpochMs: Date.parse(sealedAt) + 60_000 }, 'scoring-clock'],
      [{ nowEpochMs: Date.parse(reviewedAt) + 60_000 }, 'scoring-clock'],
      [{ nowEpochMs: Date.parse('2026-12-01T00:00:00Z') }, 'calibration-unqualified'],
      [{ testPhaseAccessAt: null }, 'staged test access'],
      [{ developmentReview: staged.reviewTemplate, trustedDevelopmentReviewDigest: heldoutDigest(staged.reviewTemplate) }, 'development-review'],
    ];
    for (const [patch, reason] of refusals) await expect(scoreD17StagedStudy(input, staged, { ...context, ...patch })).rejects.toThrow(reason);
    await expect(scoreD17StagedStudy({ ...input, calibrated: false }, staged, context)).rejects.toThrow('staged calibration scope');
    await expect(scoreD17StagedStudy({ ...input, corpus: staged.corpus }, staged, context)).rejects.toThrow('frozen scoring pins');
    await expect(scoreD17StagedStudy({ ...input, approvedCalibration: { mode: 'staged', phase: 'calibration' } }, staged, context))
      .rejects.toThrow('approved-calibration');
    await expect(scoreD17Study({ ...input, corpus: staged.corpus, calibrated: false } as any, staged as any))
      .rejects.toThrow('D17 uncalibrated diagnostic scope');
  }, 300_000);
});

describe('D17 AC7/AC14 native record and the D09 promotion route', () => {
  const operator = { alias: 'd17-offline-alias', aliasRevision: 1, eligibilityId: 'd17-eligibility-offline',
    integrityReportId: 'd17-native-integrity-offline', approvalReference: 'offline-fixture-only', approvedAt: '2026-10-02T00:00:00Z',
    holdoutAccessedAt: accessAt };
  /** Scores the flow and returns everything a promotion needs; `pieces` removes one prerequisite at a time. */
  async function promotion(yes: YesFn, pieces: { tradeoff?: boolean; eligibility?: boolean } = {}) {
    const flow = await stagedFlow(yes);
    const report = await scoreD17StagedStudy(flow.input, staged, flow.context);
    const handoff = await d17NativeHandoff({ report, trustedReportDigest: heldoutDigest(report), prepared: staged, artifacts: flow.registered.artifacts, operator });
    const passed = report.pairs.filter(pair => pair.challenger.correct).length;
    const base = buildIntegrityMetadata({ mode: 'locked', freshWorkspaceRequired: false, freshWorkspaceVerified: false, changedArtifacts: [],
      sampleN: report.statistics.sampleN, passedN: passed, overallScore: 100 * passed / report.statistics.sampleN }) as QualificationIntegrityMetadata;
    const tradeoff = { schemaVersion: 'decision-d17-tradeoff-approval/v1', approved: true, reviewer: 'roctinam', reportDigest: heldoutDigest(report),
      statisticsDigest: report.statisticsDigest, netSavingsMicros: report.statistics.netSavingsMicros,
      acceptedAdditionalCostMicros: Math.max(0, -report.statistics.netSavingsMicros), qualityLowerBps: report.statistics.quality!.lowerBps,
      approvalReference: 'offline-fixture-only', approvedAt: '2026-10-02T00:00:00Z' };
    const withTradeoff = pieces.tradeoff !== false;
    const integrity = d17NativeIntegrity({ base, pairedBaseline: handoff.pairedBaseline, report,
      ...(withTradeoff ? { tradeoff, trustedTradeoffDigest: heldoutDigest(tradeoff) } : {}) });
    const record = { ...handoff.record, evaluationIntegrityReport: { ...handoff.record.evaluationIntegrityReport, digest: heldoutDigest(integrity) } };
    const registry = new CalibrationRegistry();
    registry.observeAlias(operator.alias, flow.registered.artifacts.member.identity, '2026-10-02T00:00:00.000Z');
    const eligibility = { id: operator.eligibilityId, alias: operator.alias, candidateIdentityDigest: record.challenger.identityDigest,
      candidateActualModel: 'jev-1.13.0', evaluationIntegrityReport: { ...record.evaluationIntegrityReport } as { id: string; digest: `sha256:${string}` },
      approvalReference: operator.approvalReference, rollbackTarget: { ...record.rollbackTarget }, eligible: true, reasons: [],
      recordedAt: '2026-10-02T01:00:00.000Z' };
    registry.recordPromotionEligibility(eligibility);
    const nativeInput = { report, prepared: staged, record, integrity, trustedIntegrityDigest: heldoutDigest(integrity), trustedReportDigest: heldoutDigest(report),
      ...(pieces.eligibility !== false ? { eligibility, registry } : {}),
      ...(withTradeoff ? { tradeoff, trustedTradeoffDigest: heldoutDigest(tradeoff) } : {}) };
    return { flow, report, integrity, record, registry, eligibility, nativeInput, tradeoff, base };
  }
  it('A promotes a fully qualified calibrated challenger only through D09 eligibility and promoteChampionChallenger', async () => {
    const { report, integrity, record, registry, eligibility, nativeInput } = await promotion(promoteYes);
    expect(report.decision).toBe('HOLD');
    expect(report.gates.statisticalGate).toBe('pass'); expect(report.statistics.benefitSupported).toBe(true);
    expect(integrity.release_gate.decision).toBe('PROMOTE');
    expect(record.champion.calibration).toEqual({ artifactId: report.calibration.member.artifactId, artifactDigest: report.calibration.member.artifactDigest });
    expect(record.challenger.calibration).toEqual({ artifactId: report.calibration.aggregate.artifactId, artifactDigest: report.calibration.aggregate.artifactDigest });
    const native = await buildD17NativeReport(nativeInput);
    expect(() => validateEnsembleIntegrityReport(native)).not.toThrow();
    expect(native).toMatchObject({ decision: 'PROMOTE', upstreamDecision: 'PROMOTE', findings: [] });
    const event = promoteChampionChallenger({ record, integrityReport: native, eligibility, gateway: registry, at: '2026-10-02T02:00:00.000Z' });
    expect(event).toMatchObject({ kind: 'promoted', alias: operator.alias, actualIdentityDigest: record.challenger.identityDigest, revision: 2 });
    // The eligibility must be D09's stored record, not a caller-supplied copy.
    await expect(buildD17NativeReport({ ...nativeInput, eligibility: { ...eligibility, recordedAt: '2026-10-02T01:30:00.000Z' } })).rejects.toThrow('native eligibility');
  }, 300_000);
  it('A holds when any promotion prerequisite is missing, and the diagnostic v1 route stays refused', async () => {
    // No anchored tradeoff approval: the locked-snapshot PROMOTE gate is held.
    const noTradeoff = await promotion(promoteYes, { tradeoff: false });
    expect(noTradeoff.base.release_gate.decision).toBe('PROMOTE');
    expect(noTradeoff.integrity.release_gate).toMatchObject({ decision: 'HOLD' });
    expect(noTradeoff.integrity.release_gate.reasons.join(' ')).toContain('no anchored extra-cost tradeoff approval');
    const held = await buildD17NativeReport(noTradeoff.nativeInput);
    expect(held.decision).toBe('HOLD');
    expect(() => promoteChampionChallenger({ record: noTradeoff.record, integrityReport: held, eligibility: noTradeoff.eligibility,
      gateway: noTradeoff.registry, at: '2026-10-02T02:00:00.000Z' })).toThrow('promotion requires');
    // No D09 eligibility: HOLD with the eligibility finding.
    const noEligibility = await promotion(promoteYes, { eligibility: false });
    expect(await buildD17NativeReport(noEligibility.nativeInput)).toMatchObject({ decision: 'HOLD', findings: ['d09-eligibility-missing'] });
    // A failing calibrated study gate (5% shared errors): HOLD even with a tradeoff approval.
    const failing = await promotion(observedYes);
    expect(failing.report.gates.statisticalGate).toBe('HOLD');
    expect(failing.integrity.release_gate.decision).not.toBe('PROMOTE');
    expect((await buildD17NativeReport(failing.nativeInput)).decision).not.toBe('PROMOTE');
    // An upstream PROMOTE that does not carry the bound tradeoff is refused outright.
    const unbound = { ...noTradeoff.base, paired_baseline: noTradeoff.integrity.paired_baseline };
    await expect(buildD17NativeReport({ ...noTradeoff.nativeInput, integrity: unbound, trustedIntegrityDigest: heldoutDigest(unbound),
      record: { ...noTradeoff.record, evaluationIntegrityReport: { ...noTradeoff.record.evaluationIntegrityReport, digest: heldoutDigest(unbound) } } }))
      .rejects.toThrow('anchored HOLD or ROLLBACK');
    // A tradeoff that under-accepts the measured extra cost is invalid.
    const cheap = { ...noTradeoff.tradeoff, acceptedAdditionalCostMicros: 0 };
    expect(() => d17NativeIntegrity({ base: noTradeoff.base, pairedBaseline: {}, report: noTradeoff.report, tradeoff: cheap,
      trustedTradeoffDigest: heldoutDigest(cheap) })).toThrow('tradeoff approval');
    const uncited = structuredClone(noTradeoff.record);
    uncited.challenger.calibration = { ...uncited.champion.calibration! };
    await expect(buildD17NativeReport({ ...noTradeoff.nativeInput, record: uncited })).rejects.toThrow('native calibration pins');
    await expect(d17NativeHandoff({ report: noTradeoff.report, trustedReportDigest: pin, prepared: staged,
      artifacts: noTradeoff.flow.registered.artifacts, operator })).rejects.toThrow('native report pin');
  }, 300_000);
});

describe('D17 staged CLIs', () => {
  it('describe the staged modes and refuse open or mismatched configs before reading evidence', async () => {
    const help = spawnSync(process.execPath, ['tools/decision/d17-score.mjs', '--help'], { encoding: 'utf8', timeout: 20000 });
    expect(help.status, help.stderr).toBe(0);
    for (const word of ['--staged', '--native-handoff', '--native', 'calibrationRun', 'trustedCalibrationReviewDigest', 'trustedTradeoffApprovalDigest']) {
      expect(help.stdout).toContain(word);
    }
    const studyHelp = spawnSync(process.execPath, ['tools/decision/d17-study.mjs', '--help'], { encoding: 'utf8', timeout: 20000 });
    for (const word of ['--prepare-staged', '--bundle', '--dry-run-phases', '--fit-calibration', '--register-calibration']) expect(studyHelp.stdout).toContain(word);
    const dir = await root(), config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ run: dir, trustedEvidenceDigest: pin, trustedApprovalDigest: pin, goldFile: config,
      integrityFile: config, trustedIntegrityDigest: pin, unexpected: true }));
    for (const mode of ['--staged', '--native-handoff', '--native']) {
      const refused = spawnSync(process.execPath, ['tools/decision/d17-score.mjs', mode, config, join(dir, 'out.json')], { encoding: 'utf8', timeout: 20000 });
      expect(refused.status).toBe(1); expect(refused.stderr).toContain('D17 scoring refused'); expect(refused.stdout).toBe('');
    }
    const fit = spawnSync(process.execPath, ['tools/decision/d17-study.mjs', '--fit-calibration', dir], { encoding: 'utf8', timeout: 20000 });
    expect(fit.status).toBe(1); expect(fit.stderr).toContain('D17 preparation refused');
  }, 60_000);
});
