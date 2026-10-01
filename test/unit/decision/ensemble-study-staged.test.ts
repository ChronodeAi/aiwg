import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepare, runD17Bundle, runD17Calibration } from '../../../tools/decision/d17-study.mjs';
import { collectHeldoutStudy, scoreHeldoutStudy } from '../../../src/decision/heldout/collector.js';
import { readHeldoutCalibrationPhase } from '../../../src/decision/heldout/calibration.js';
import { heldoutDigest, heldoutExecutionDigest, validateHeldoutBundle } from '../../../src/decision/heldout/contract.js';
import { heldoutRunsRoot, readHeldoutJournal } from '../../../src/decision/heldout/journal.js';
import type { HeldoutAttempt, HeldoutBundle } from '../../../src/decision/heldout/types.js';
import { CalibrationRegistry, calibrationArtifactDigest } from '../../../src/decision/calibration/registry.js';
import { applyD17Mapping, d17CalibrationHandoffFromSealed, fitD17Calibration, fitD17Isotonic, qualifyD17Calibration,
  registerD17CalibrationFromHandoff, validateD17DevelopmentReview } from '../../../src/decision/ensemble-study/calibration.js';
import { buildD17NativeReport, d17NativeHandoff, scoreD17StagedStudy, scoreD17Study } from '../../../src/decision/ensemble-study/score.js';
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

// Entry admission measures a 1s wall-clock budget; freeze performance.now() so host load never trips it.
beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); });
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
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
function approval(bundle: Pick<HeldoutBundle, 'corpus' | 'preregistration'>, runId: string, calibration: HeldoutBundle['approval']['calibration']) {
  const value = { schemaVersion: 'decision-heldout-approval/v1', approved: true, study: 'D17', runId, reviewer: 'fixture-reviewer',
    approvalReference: 'fixture-only', sourceCommit: 'a'.repeat(40), exactHeadCi: 'fixture-ci', stagingHost: 'titan',
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
/** Deterministic synthetic native probabilities: about 5% confident errors and some moderate scores. */
function observedYes(prepared: Staged, rowId: string, index: number, member: number) {
  const gold = prepared.gold.labels[rowId] === 'yes';
  const confident = index % 20 === 0 ? !gold : gold;
  const spread = [0.92, 0.85, 0.78, 0.97][(index + member) % 4]!;
  return confident ? spread : 1 - spread;
}
function attemptsFor(base: HeldoutAttempt, prepared: Staged, split: string) {
  return prepared.corpus.rows.filter(row => row.split === split).flatMap((row, index) =>
    ['champion', 'member_1', 'member_2', 'member_3'].map((requestId, member) =>
      synthetic(base, prepared, row.id, requestId, observedYes(prepared, row.id, index, member))));
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
    expect(diagnostic.analysis.schemaVersion).toBe('decision-d17-analysis/v1');
    expect(staged.approvalTemplate).toMatchObject({ approved: false, calibration: { mode: 'staged', phase: 'calibration' },
      preregistrationDigest: heldoutDigest(staged.preregistration), budget: { calls: 18000, tokens: 72000000, usd: 8 } });
    expect(staged.dryRun).toMatchObject({ schemaVersion: 'decision-d17-dry-run/v2', providerCalls: 0,
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
  it('assembles a collector bundle only with a completed development review', async () => {
    const dir = await root(), preparedDir = join(dir, 'prepared');
    const { writeHeldoutFile } = await import('../../../src/decision/heldout/journal.js');
    const { mkdir } = await import('node:fs/promises'); await mkdir(preparedDir);
    for (const name of ['corpus', 'preregistration', 'gold'] as const) await writeHeldoutFile(join(preparedDir, `${name}.json`), staged[name]);
    const form = approval(staged, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' });
    await writeFile(join(dir, 'approval.json'), JSON.stringify(form));
    const review = developmentReview(staged);
    await writeFile(join(dir, 'review.json'), JSON.stringify(staged.reviewTemplate));
    await expect(runD17Bundle([preparedDir, join(dir, 'approval.json'), join(dir, 'review.json'),
      heldoutDigest(staged.reviewTemplate), join(dir, 'refused.json')])).rejects.toThrow('development-review');
    await expect(readFile(join(dir, 'refused.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(dir, 'review.json'), JSON.stringify(review));
    expect(await runD17Bundle([preparedDir, join(dir, 'approval.json'), join(dir, 'review.json'), heldoutDigest(review), join(dir, 'bundle.json')]))
      .toMatchObject({ providerCalls: 0, phase: 'calibration', approvalDigest: heldoutDigest(form), preregistrationDigest: heldoutDigest(staged.preregistration) });
    const bundle = JSON.parse(await readFile(join(dir, 'bundle.json'), 'utf8'));
    expect(Object.keys(bundle).sort()).toEqual(['approval', 'corpus', 'preregistration']);
  }, 120_000);
});

describe('D17 staged calibration phase through the shared collector', () => {
  it('collects only calibration-phase rows, seals the phase and refuses unsupported or unreproduced fits', async () => {
    const dir = await root(), small = reduced(staged);
    const bundle = { corpus: small.corpus, preregistration: small.preregistration,
      approval: approval(small, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' }) } as HeldoutBundle;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init));
    let time = Date.parse('2026-10-01T01:00:00Z');
    const summary = await collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(bundle.approval), artifactRoot: dir,
      sourceRoot: process.cwd(), offline: { transport, host: { resolveCredential: async () => new TextEncoder().encode('fake-d17-reader'), dispose: () => {} } },
      now: () => time, sleep: async (ms: number) => { time += ms; } });
    if (summary.status === 'disabled') throw new Error('expected offline collection');
    expect(summary).toMatchObject({ status: 'complete', completedRows: 3 });
    expect(transport).toHaveBeenCalledTimes(12);
    const run = join(heldoutRunsRoot(dir), 'd17-calibration-01');
    const sealed = await readHeldoutCalibrationPhase(run, heldoutDigest(bundle.approval), summary.calibrationPhaseRecordDigest!);
    expect(sealed.attempts.every(attempt => small.corpus.rows.find(row => row.id === attempt.rowId)!.split !== 'test')).toBe(true);
    const review = developmentReview(small, '2026-10-01T00:30:00Z');
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
      sourceRoot: process.cwd(), offline: { transport, host: { resolveCredential: async () => new TextEncoder().encode('fake-d17-reader'), dispose: () => {} } },
      now: () => time, sleep: async (ms: number) => { time += ms; } });
    if (tested.status === 'disabled') throw new Error('expected offline collection');
    expect(tested).toMatchObject({ status: 'complete', completedRows: 1 }); expect(transport).toHaveBeenCalledTimes(16);
    const integrity: QualificationIntegrityMetadata = { sample_n: 1, uncertainty: null, paired_baseline: null, integrity_mode: 'standard',
      fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'not-assessed', trusted_score_source: 'local-unverified',
      compromise_labels: [], weak_signal_reason: 'offline-control', release_gate: { decision: 'HOLD', reasons: ['offline-control'] } };
    const seen: any[] = [];
    await expect(scoreHeldoutStudy({ run: join(heldoutRunsRoot(dir), 'd17-test-01'), trustedEvidenceDigest: tested.evidenceDigest,
      trustedApprovalDigest: heldoutDigest(testBundle.approval), gold: small.gold, integrity, trustedIntegrityDigest: heldoutDigest(integrity),
      moduleDigest: small.preregistration.scorerDigest, module: { prepare: async () => small, score: async scored => {
        seen.push(scored);
        return scoreD17StagedStudy(scored, small, { set: {}, trustedCalibrationSetDigest: pin, artifacts: {} as any, mappings: {} as any,
          developmentReview: review, trustedDevelopmentReviewDigest: heldoutDigest(review), nowEpochMs: time });
      } } })).rejects.toThrow('calibration-set');
    expect(seen[0]).toMatchObject({ calibrated: null, approvedCalibration: { mode: 'staged', phase: 'test' } });
    expect(seen[0].corpus.rows.map((row: any) => row.split)).toEqual(['test']);
  }, 120_000);
});

describe('D17 calibration fit, registration and calibrated test-phase scoring', () => {
  const sealedAt = '2026-10-01T02:00:00.000Z', reviewedAt = '2026-10-01T03:00:00Z', evaluatedAt = Date.parse('2026-10-02T00:00:00Z');
  async function handoff() {
    const base = await receiptTemplate();
    const calibration = attemptsFor(base, staged, 'calibration');
    const phaseApproval = approval(staged, 'd17-calibration-01', { mode: 'staged', phase: 'calibration' });
    const review = developmentReview(staged);
    const record = { schemaVersion: 'decision-heldout-calibration-phase/v1', study: 'D17', runId: 'd17-calibration-01',
      corpusDigest: heldoutDigest(staged.corpus), preregistrationDigest: heldoutDigest(staged.preregistration),
      approvalDigest: heldoutDigest(phaseApproval), sealedAt, rowIds: [], lineage: [], lineageDigest: pin } as const;
    const sealed = { bundle: { corpus: staged.corpus, preregistration: staged.preregistration, approval: phaseApproval },
      source: 'injected-transport' as const, record: record as any, attempts: [...attemptsFor(base, staged, 'tuning'), ...calibration] };
    const observed = d17CalibrationHandoffFromSealed({ sealed, prepared: staged, trustedApprovalDigest: heldoutDigest(phaseApproval),
      trustedCalibrationPhaseRecordDigest: heldoutDigest(record), developmentReview: review, trustedDevelopmentReviewDigest: heldoutDigest(review) });
    const calibrationReview = { ...observed.reviewTemplate, approved: true, reviewer: 'roctinam', approvalReference: 'offline-fixture-only', reviewedAt };
    const registered = registerD17CalibrationFromHandoff(observed, calibrationReview, heldoutDigest(calibrationReview));
    return { base, calibration, observed, registered, review, calibrationReview };
  }
  it('fits only calibration rows, emits observed artifacts and requires a reviewed, qualified registration', async () => {
    const { base, calibration, observed, registered, calibrationReview } = await handoff();
    // Tuning and test observations never change the fitted calibrators.
    expect(fitD17Calibration(staged, [...calibration, ...attemptsFor(base, staged, 'test').slice(0, 40)])).toEqual(observed.mappings);
    expect(() => fitD17Calibration(staged, attemptsFor(base, staged, 'tuning'))).toThrow('calibration-support');
    expect(observed.mappings.member).toMatchObject({ role: 'member', n: 1600, rows: 400, calibrator: { id: 'd17-single-call-isotonic' } });
    expect(observed.mappings.aggregate).toMatchObject({ role: 'aggregate', n: 400, rows: 400, calibrator: { id: 'd17-three-sample-mean-isotonic' } });
    for (const role of ['member', 'aggregate'] as const) {
      const artifact = observed.artifacts[role];
      expect(artifact).toMatchObject({ schemaVersion: 'decision-calibration-artifact/v1', approval: { state: 'observed', reference: null },
        effectiveAt: sealedAt, identity: { actualModel: 'jev-1.13.0', calibrator: { parametersDigest: heldoutDigest(observed.mappings[role]) } },
        metrics: { totalSamples: 400, perSliceSamples: 100 } });
      expect(() => qualifyD17Calibration(artifact, reviewedAt)).toThrow('calibration-unqualified');
      expect(registered.compatibility[role]).toMatchObject({ action: 'allow', state: 'exact' });
      expect(registered.artifacts[role].approval).toEqual({ state: 'approved', reference: 'offline-fixture-only' });
    }
    expect(observed.approval).toMatchObject({ approved: false, runId: null, calibration: { mode: 'staged', phase: 'test',
      calibrationArtifactDigest: observed.calibrationSetDigest } });
    expect(registered.approval.calibration).toMatchObject({ calibrationArtifactDigest: heldoutDigest(registered.set) });
    expect(registered.set.member.artifactDigest).toBe(registered.artifacts.member.digest);
    for (const changed of [{ ...calibrationReview, memberArtifactDigest: pin }, { ...calibrationReview, reviewedAt: '2026-09-30T00:00:00Z' },
      { ...calibrationReview, approved: null }]) {
      expect(() => registerD17CalibrationFromHandoff(observed, changed, heldoutDigest(changed))).toThrow('calibration-review');
    }
    expect(() => registerD17CalibrationFromHandoff(observed, calibrationReview, pin)).toThrow('calibration-review');
    // Expired, unbounded or unapproved artifacts never qualify.
    expect(() => qualifyD17Calibration(registered.artifacts.member, '2026-12-01T00:00:00Z')).toThrow('calibration-unqualified');
    for (const patch of [{ selectiveRisk: 0.5 }, { totalSamples: 10 }, { confidenceIntervals: { selectiveRisk: { lower: 0, upper: 0.2 } } }]) {
      const { digest: _digest, ...payload } = structuredClone(registered.artifacts.member); Object.assign(payload.metrics, patch);
      expect(() => qualifyD17Calibration({ ...payload, digest: calibrationArtifactDigest(payload) }, reviewedAt)).toThrow('calibration-unqualified');
    }
  }, 120_000);
  it('applies member and aggregate calibration, runs the native gates on calibrated measurements and supports AC7/AC14', async () => {
    const { base, registered, review } = await handoff();
    const testApproval = { ...approval(staged, 'd17-test-01', registered.approval.calibration as HeldoutBundle['approval']['calibration']) };
    const attempts = attemptsFor(base, staged, 'test').map(attempt => ({ ...attempt, approvalDigest: heldoutDigest(testApproval) }));
    const testCorpus = { ...staged.corpus, rows: staged.corpus.rows.filter(row => row.split === 'test') };
    const integrity: QualificationIntegrityMetadata = { sample_n: 1200, uncertainty: { method: 'newcombe-10', levelBps: 9500 },
      paired_baseline: { n: 1200 }, integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: false,
      integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [], weak_signal_reason: null,
      release_gate: { decision: 'HOLD', reasons: ['offline-control'] } };
    const context = { set: registered.set, trustedCalibrationSetDigest: heldoutDigest(registered.set), artifacts: registered.artifacts,
      mappings: registered.mappings, developmentReview: review, trustedDevelopmentReviewDigest: heldoutDigest(review), nowEpochMs: evaluatedAt };
    const input = { corpus: testCorpus, preregistration: staged.preregistration, attempts, gold: staged.gold, integrity,
      approvedCalibration: testApproval.calibration, calibrated: null };
    const report = await scoreD17StagedStudy(input, staged, context);
    expect(report).toMatchObject({ schemaVersion: 'decision-d17-study-report/v2', calibrated: true, d09Qualified: true, calibratedGate: true,
      decision: 'HOLD', calibration: { mode: 'staged-test', calibrationSetDigest: heldoutDigest(registered.set),
        member: { artifactDigest: registered.artifacts.member.digest, compatibility: { action: 'allow' } },
        aggregate: { artifactDigest: registered.artifacts.aggregate.digest } }, gates: { source: 'd17-native-protocol', gateBinding: null } });
    expect(report.pairs).toHaveLength(1200);
    const row = staged.corpus.rows.find(item => item.split === 'test')!;
    const rawChampion = observedYes(staged, row.id, 0, 0);
    expect(report.pairs[0]!.champion.probability).toBe(applyD17Mapping(registered.mappings.member, rawChampion));
    const rawMean = [1, 2, 3].reduce((sum, member) => sum + observedYes(staged, row.id, 0, member), 0) / 3;
    expect(report.pairs[0]!.challenger.probability).toBe(applyD17Mapping(registered.mappings.aggregate, rawMean));
    expect(report.uncalibratedStatistics.sampleN).toBe(1200);
    expect(report.statistics.pairedDeltas.map(delta => delta.metric)).toEqual(['quality', 'calibration', 'risk-coverage', 'abstention',
      'latency', 'tokens', 'cost', 'slice']);
    expect(report.calibrationDiagnostics.calibrated).toBe(true);
    expect(() => validateD17Artifact('reportV2', { ...report, decision: 'PROMOTE' })).toThrow('invalid reportV2');
    expect(await scoreD17StagedStudy({ ...input, integrity: { ...integrity, release_gate: { decision: 'ROLLBACK', reasons: ['control'] } } }, staged, context))
      .toMatchObject({ decision: 'ROLLBACK' });
    // The approved binding, each artifact, the mapping, the review and the scoring clock are all enforced.
    const refusals: Array<[Partial<typeof context>, string]> = [
      [{ trustedCalibrationSetDigest: pin }, 'calibration-set'],
      [{ mappings: { ...registered.mappings, member: { ...registered.mappings.member, n: 1 } } }, 'mapping-pin'],
      [{ artifacts: { ...registered.artifacts, aggregate: registered.artifacts.member } }, 'calibration-artifact'],
      [{ nowEpochMs: Date.parse('2026-12-01T00:00:00Z') }, 'calibration-unqualified'],
      [{ developmentReview: staged.reviewTemplate, trustedDevelopmentReviewDigest: heldoutDigest(staged.reviewTemplate) }, 'development-review'],
    ];
    for (const [patch, reason] of refusals) await expect(scoreD17StagedStudy(input, staged, { ...context, ...patch })).rejects.toThrow(reason);
    await expect(scoreD17StagedStudy({ ...input, calibrated: false }, staged, context)).rejects.toThrow('staged calibration scope');
    await expect(scoreD17StagedStudy({ ...input, corpus: staged.corpus }, staged, context)).rejects.toThrow('frozen scoring pins');
    await expect(scoreD17StagedStudy({ ...input, approvedCalibration: { mode: 'staged', phase: 'calibration' } }, staged, context))
      .rejects.toThrow('approved-calibration');
    // The diagnostic scorer still refuses any calibrated binding.
    await expect(scoreD17Study({ ...input, corpus: staged.corpus, approvedCalibration: testApproval.calibration, calibrated: false } as any, staged as any))
      .rejects.toThrow('D17 uncalibrated diagnostic scope');

    // AC7/AC14: a real champion/challenger record citing both D09 artifacts, bound into anchored integrity metadata.
    const operator = { alias: 'd17-offline-alias', aliasRevision: 1, eligibilityId: 'd17-eligibility-not-issued',
      integrityReportId: 'd17-native-integrity-offline', approvalReference: 'offline-fixture-only', approvedAt: '2026-10-02T00:00:00Z',
      holdoutAccessedAt: '2026-10-01T04:00:00Z' };
    const native = await d17NativeHandoff({ report, trustedReportDigest: heldoutDigest(report), prepared: staged, artifacts: registered.artifacts, operator });
    expect(native.record.champion.calibration).toEqual({ artifactId: registered.artifacts.member.id, artifactDigest: registered.artifacts.member.digest });
    expect(native.record.challenger.calibration).toEqual({ artifactId: registered.artifacts.aggregate.id, artifactDigest: registered.artifacts.aggregate.digest });
    const anchored = { ...integrity, paired_baseline: native.pairedBaseline };
    const record = { ...native.record, evaluationIntegrityReport: { ...native.record.evaluationIntegrityReport, digest: heldoutDigest(anchored) } };
    const nativeInput = { report, prepared: staged, record, integrity: anchored, trustedIntegrityDigest: heldoutDigest(anchored), trustedReportDigest: heldoutDigest(report) };
    const nativeReport = await buildD17NativeReport(nativeInput);
    expect(() => validateEnsembleIntegrityReport(nativeReport)).not.toThrow();
    expect(nativeReport.decision).toBe('HOLD'); expect(nativeReport.findings).toContain('d09-eligibility-missing');
    expect(nativeReport.pairedDeltas.every(delta => delta.pairs === 1200)).toBe(true);
    const uncited = structuredClone(record); uncited.challenger.calibration = { artifactId: registered.artifacts.member.id, artifactDigest: registered.artifacts.member.digest };
    await expect(buildD17NativeReport({ ...nativeInput, record: uncited })).rejects.toThrow('native calibration pins');
    await expect(d17NativeHandoff({ report, trustedReportDigest: pin, prepared: staged, artifacts: registered.artifacts, operator })).rejects.toThrow('native report pin');
    // An unregistered registry never resolves an observed artifact.
    expect(new CalibrationRegistry().artifactHistory()).toEqual([]);
  }, 300_000);
});

describe('D17 staged CLIs', () => {
  it('describe the staged modes and refuse open or mismatched configs before reading evidence', async () => {
    const help = spawnSync(process.execPath, ['tools/decision/d17-score.mjs', '--help'], { encoding: 'utf8', timeout: 20000 });
    expect(help.status, help.stderr).toBe(0);
    for (const word of ['--staged', '--native-handoff', '--native', 'trustedCalibrationSetDigest', 'trustedDevelopmentReviewDigest']) expect(help.stdout).toContain(word);
    const studyHelp = spawnSync(process.execPath, ['tools/decision/d17-study.mjs', '--help'], { encoding: 'utf8', timeout: 20000 });
    for (const word of ['--prepare-staged', '--bundle', '--fit-calibration', '--register-calibration']) expect(studyHelp.stdout).toContain(word);
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
