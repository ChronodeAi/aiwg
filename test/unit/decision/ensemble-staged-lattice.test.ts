// Offline staged D17 fixtures for the shared outcome regression tables.
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

describe('D17 staged outcome lattice (#2829)', () => {
  it('preserves the staged study verdict table across upstream and compromise outcomes', async () => {
    const { input, context } = await stagedFlow();
    for (const upstream of ['PROMOTE', 'HOLD', 'ROLLBACK'] as const) for (const compromised of [false, true]) {
      const integrity = { ...input.integrity, release_gate: { decision: upstream, reasons: [] },
        compromise_labels: compromised ? ['fixture_edit'] : [] };
      const report = await scoreD17StagedStudy({ ...input, integrity }, staged, context);
      expect(report.decision).toBe(upstream === 'ROLLBACK' || compromised ? 'ROLLBACK' : 'HOLD');
    }
  }, 120_000);
  it('preserves the native promotion ceiling for every upstream outcome', async () => {
    const { input, context } = await stagedFlow();
    const report = await scoreD17StagedStudy(input, staged, context);
    for (const decision of ['PROMOTE', 'HOLD', 'ROLLBACK'] as const) {
      const base = { ...input.integrity, release_gate: { decision, reasons: ['fixture'] } };
      const native = d17NativeIntegrity({ base, pairedBaseline: { n: 1200 }, report });
      expect(native.release_gate.decision).toBe(decision === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD');
      expect(base.release_gate.decision).toBe(decision);
    }
  }, 120_000);
});
