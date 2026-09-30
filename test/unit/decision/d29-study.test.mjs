import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepare, dryRun, drawStream, baseline, hostContext, oracle, observationFromAttempts, buildReport,
  externalReport, validateStudyArtifact, fitReadinessMapping, SLICES, LABELS, score } from '../../../tools/decision/studies/d29.mjs';
import { heldoutDigest, heldoutExecutionDigest, validateHeldoutBundle, planHeldoutCollection } from '../../../src/decision/heldout/contract.js';
import { collectHeldoutStudy } from '../../../src/decision/heldout/collector.js';
import { heldoutRunsRoot, readHeldoutJournal } from '../../../src/decision/heldout/journal.js';
import { CalibrationRegistry, calibrationArtifactDigest } from '../../../src/decision/calibration/registry.js';
import { evaluateSdlcEvidenceScreening, applySdlcScreeningToGateOutcome } from '../../../src/decision/sdlc-screening.js';

const hostChecks = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/decision/context-live-qualification.js', async original => {
  const source = await original();
  return { ...source, assertContextLiveSource: vi.fn(async () => {}),
    assertContextArtifactRoot: vi.fn(async (_source, root) => { if (root !== hostChecks.root) throw new Error('root'); }) };
});
let prepared;
beforeAll(async () => { prepared = await prepare('offline-d29-conformance'); });
const dirs = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const integrity = () => ({ sample_n: 1200, uncertainty: { method: 'wilson', levelBps: 9500 }, paired_baseline: { n: 1200 },
  integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'verified',
  trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [], weak_signal_reason: null,
  release_gate: { decision: 'PROMOTE', reasons: [] } });
function reportFixture() {
  const analysis = structuredClone(prepared.analysis);
  const samples = prepared.corpus.rows.filter(row => row.split === 'test').map(row => {
    const index = SLICES.indexOf(row.slice), support = index < 4 ? LABELS[index] : null;
    const ready = index === 0 || index === 4;
    return { id: row.id, kind: index < 4 ? 'citation' : 'phase-criterion', slice: row.slice, gold: { ready, support },
      candidate: { route: ready ? 'ADVISORY_READY' : 'REVIEW', support, readyProbability: ready ? 0.95 : 0.05,
        latencyMs: 4, inputTokens: 10, outputTokens: 2, costUsd: 0.001, calls: 1, retries: 0, fallbacks: 0 },
      baseline: { correct: true, costUsd: 0 }, reviewer: null };
  });
  const heldout = { schemaVersion: 'decision-sdlc-screening-heldout-records/v1', evaluatedAt: '2026-10-02T00:00:00.000Z', splits: analysis.splits, samples };
  const metadata = integrity();
  const build = () => buildReport({ analysis, trustedAnalysisDigest: heldoutDigest(analysis), heldout, integrity: metadata,
    trustedIntegrityDigest: heldoutDigest(metadata), nowEpochMs: Date.parse(heldout.evaluatedAt) });
  return { analysis, heldout, metadata, build };
}

// D29 controls and synthetic study protocol. No fixture response is live model evidence.
describe('D29 frozen synthetic population', () => {
  it('AC1/4 freezes exact balanced counts, disjoint families, payloads and digest-bound gold', async () => {
    expect(prepared.corpus.rows).toHaveLength(1600);
    expect(prepared.analysis.splits.map(split => split.ids.length)).toEqual([200, 200, 1200]);
    expect(new Set(prepared.corpus.rows.map(row => row.familyId)).size).toBe(1600);
    expect(new Set(prepared.corpus.rows.map(row => heldoutDigest(row.input))).size).toBe(1600);
    for (const split of ['tuning', 'calibration', 'test']) for (const slice of SLICES) {
      expect(prepared.corpus.rows.filter(row => row.split === split && row.slice === slice)).toHaveLength(split === 'test' ? slice.startsWith('citation') ? 200 : 100 : 25);
    }
    expect(prepared.corpus.provenance.kind).toBe('authored-synthetic');
    expect(prepared.corpus.provenance.goldDigest).toBe(heldoutDigest(prepared.gold));
    const other = await prepare('different-offline-seed');
    expect(new Set(other.corpus.rows.map(row => row.familyId)).has(prepared.corpus.rows[0].familyId)).toBe(false);
    expect(other.preregistration.corpusDigest).not.toBe(prepared.preregistration.corpusDigest);
    expect(heldoutDigest((await prepare('offline-d29-conformance')).corpus)).toBe(prepared.preregistration.corpusDigest);
    expect(JSON.stringify(prepared.corpus.rows.map(row => row.input))).not.toContain('gold');
  });
  it('AC4 implements the prescribed counter stream and an independent latent-world oracle', () => {
    const draw = drawStream('tuning', 'independent-known-family');
    expect([draw(100), draw(100), draw(100)]).toEqual([0, 80, 26]);
    const development = prepared.gold.rows.filter(row => row.id.includes('-tuning-'));
    expect(development.filter(row => oracle(row.world).ready)).toHaveLength(50);
    expect(oracle({ ...development[0].world, injected: true }).ready).toBe(false);
    expect(oracle({ ...development[0].world, sourceValue: -1 }).support).toBe('contradicts');
    expect(baseline({ kind: 'citation', claim: 'Module A uses port 12.', source: 'Module A uses port 12.' }, true)).toEqual({ route: 'ADVISORY_READY', support: 'supports' });
    expect(baseline({ kind: 'citation', claim: 'Module A uses port 12.', source: 'Module A might use port 12.' }, true)).toEqual({ route: 'REVIEW', support: 'unclear' });
  });
  it('AC9 retains every preregistered field and rejects extra/null artifact controls', () => {
    for (const artifact of [prepared.gold, prepared.analysis, prepared.reviews]) {
      expect(() => validateStudyArtifact(artifact)).not.toThrow();
      expect(() => validateStudyArtifact({ ...artifact, allow: true })).toThrow('study-schema');
    }
    const bad = structuredClone(prepared.analysis); bad.native.maximumFalseReadyRateBps = null;
    expect(() => validateStudyArtifact(bad)).toThrow('study-schema');
    expect(prepared.analysis.native).toMatchObject({ minimumTotalSupport: 1200, minimumSliceSupport: 100, minimumGateBlockingSliceSupport: 200,
      maximumFalseSupportRateBps: 100, maximumFalseReadyRateBps: 100, confidenceInterval: { method: 'wilson', levelBps: 9500 },
      qualityNonInferiorityBps: 300, efficiencyClaim: { enabled: false, minimumPositiveTotalEconomicsUsd: null } });
    expect(prepared.reviews.assessments).toHaveLength(132);
    expect(new Set(prepared.reviews.assessments.filter(item => item.phase === 'holdout').map(item => item.id)).size).toBe(80);
    expect(prepared.reviews.assessments.filter(item => item.phase === 'delayed-repeat')).toHaveLength(12);
    expect(prepared.reviews.assessments.every(item => item.goldCorrect === null && item.agreed === null)).toBe(true);
  });
  it('AC9 budgets the executable unbatched path, including every retry, without attesting approval', async () => {
    expect(dryRun(prepared)).toMatchObject({ providerCalls: 0, subjects: 1600, deterministicNoCallSubjects: 300,
      expected: { initialCalls: 4500, attempts: 4612.5, inputTokens: 9225000, usd: 0.38745 },
      worst: { attempts: 9000, tokens: 36000000, reservedUsd: 3.6 }, hardCapUsd: 6 });
    const c = await setup();
    c.bundle.corpus = prepared.corpus; c.bundle.preregistration = prepared.preregistration;
    c.bundle.approval.corpusDigest = heldoutDigest(prepared.corpus);
    c.bundle.approval.preregistrationDigest = heldoutDigest(prepared.preregistration);
    c.bundle.approval.executionDigest = heldoutExecutionDigest(prepared.corpus, prepared.preregistration, c.bundle.approval);
    const fullPlan = await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval));
    expect(fullPlan).toMatchObject({ maximumAttempts: 9000, reservedTokens: 36000000, reservedUsdMicros: 3600000, fitsBeforeStop: true });
    expect(fullPlan.maximumRequestEstimateTokens).toBeLessThanOrEqual(3744);
    expect(c.host.resolveCredential).not.toHaveBeenCalled();
    expect(prepared.approval.budget).toEqual({ calls: 11250, tokens: 45000000, usd: 6 });
    expect(prepared.approval.priceBound).toMatchObject({ inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0, approvalReference: null });
    expect(() => validateHeldoutBundle({ corpus: prepared.corpus, preregistration: prepared.preregistration, approval: prepared.approval }, heldoutDigest(prepared.approval))).toThrow();
  });
});

describe('D29 report thresholds', () => {
  it('AC8/9 computes full four-class confusion and true conditional denominators', () => {
    const { build } = reportFixture(), result = build();
    expect(result.native.preregisteredDecision).toBe('pass');
    expect(result.proposedStatisticalDisposition).toBe('pass');
    expect(result.decision).toBe('HOLD');
    expect(result.external.confusion['does-not-support']['does-not-support']).toBe(200);
    expect(result.external.classes['does-not-support']).toEqual({ n: 200, precisionBps: 10000, recallBps: 10000 });
    expect(result.external.conditional.falseSupportAmongNonSupport.n).toBe(600);
    expect(result.external.conditional.falseSupportAmongAcceptedSupport.n).toBe(200);
    expect(result.external.conditional.falseReadyAmongNonReady.n).toBe(900);
    expect(result.external.conditional.falseReadyAmongAcceptedReady.n).toBe(300);
    expect(result.external.blocking['failed-test'].upperBps).toBe(370);
  });
  it('AC9 prevents all-review success and applies stricter coverage and per-blocker thresholds', () => {
    const f = reportFixture(); f.heldout.samples.forEach(row => { row.candidate.route = 'REVIEW'; });
    expect(f.build().external.reasons).toContain('accepted-coverage-floor');
    expect(f.build().proposedStatisticalDisposition).toBe('HOLD');
    const strict = reportFixture(); strict.analysis.external.minimumAcceptedCoverageLowerBps = 3000;
    expect(strict.build().external.reasons).toContain('accepted-coverage-floor');
    const failed = strict.heldout.samples.find(row => row.slice === 'failed-test'); failed.candidate.route = 'ADVISORY_READY';
    expect(strict.build().external.reasons).toContain('blocking-slice:failed-test');
  });
  it('AC9 uses Wilson upper bounds: three false supports or six false-ready events fail', () => {
    for (const [count, support, reason] of [[3, true, 'false-support-bound-exceeded'], [6, false, 'false-ready-bound-exceeded']]) {
      const f = reportFixture();
      const candidates = f.heldout.samples.filter(row => support ? row.gold.support === 'contradicts' : row.slice === 'criterion-incomplete');
      candidates.slice(0, count).forEach(row => { row.candidate.route = 'ADVISORY_READY'; if (support) row.candidate.support = 'supports'; });
      expect(f.build().native.reasons).toContain(reason);
      expect(f.build().proposedStatisticalDisposition).toBe('HOLD');
    }
  });
  it('AC9 enforces CI method/level, per-slice support and paired NI instead of point accuracy', () => {
    const f = reportFixture();
    f.heldout.samples.filter(row => row.gold.ready).slice(0, 40).forEach(row => { row.candidate.route = 'REVIEW'; });
    expect(f.build().native.reasons).toContain('quality-not-non-inferior');
    f.analysis.native.qualityNonInferiorityBps = 1000;
    expect(f.build().native.reasons).not.toContain('quality-not-non-inferior');
    f.analysis.native.confidenceInterval.method = 'exact-binomial';
    expect(f.build().native.reasons).toContain('confidence-interval-unsupported');
    const g = reportFixture(); g.analysis.native.maximumFalseSupportRateBps = 48;
    expect(g.build().native.preregisteredDecision).toBe('pass');
    g.analysis.native.confidenceInterval.levelBps = 9900;
    expect(g.build().native.reasons).toContain('false-support-bound-exceeded');
    const h = reportFixture(); h.heldout.samples.filter(row => row.slice === 'missing-artifact').forEach(row => { row.slice = 'failed-test'; });
    expect(h.build().native.reasons).toContain('slice-support-missing:missing-artifact');
    expect(h.build().external.reasons).toContain('blocking-slice:missing-artifact');
  });
  it('AC9 independently applies every support minimum and external blocking cap', () => {
    for (const [field, value, reason] of [['minimumTotalSupport', 1201, 'minimum-total-support-missing'],
      ['minimumSliceSupport', 101, 'slice-support-missing:criterion-ready'],
      ['minimumGateBlockingSliceSupport', 201, 'gate-blocking-slice-support-missing']]) {
      const f = reportFixture(); f.analysis.native[field] = value;
      expect(f.build().native.reasons).toContain(reason); expect(f.build().proposedStatisticalDisposition).toBe('HOLD');
    }
    const f = reportFixture(); f.analysis.external.maximumBlockingSliceFalseReadyUpperBps = 369;
    expect(f.build().external.reasons).toContain('blocking-slice:failed-test');
    f.analysis.external.maximumBlockingSliceFalseReadyUpperBps = 1000;
    f.heldout.samples.find(row => row.slice === 'failed-test').candidate.route = 'ADVISORY_READY';
    expect(f.build().external.reasons).toContain('blocking-slice:failed-test');
    f.analysis.external.maximumBlockingSliceFalseReadyEvents = 1;
    expect(f.build().external.reasons).not.toContain('blocking-slice:failed-test');
  });
  it('AC13 uses net baseline savings and never upgrades upstream HOLD/ROLLBACK or forged integrity', () => {
    const f = reportFixture(); f.analysis.native.efficiencyClaim = { enabled: true, minimumPositiveTotalEconomicsUsd: 0.1 };
    expect(f.build().native.reasons).toContain('total-economics-not-positive');
    f.heldout.samples.forEach(row => { row.candidate.costUsd = null; });
    expect(f.build().native.reasons).toContain('total-economics-unknown');
    for (const decision of ['HOLD', 'ROLLBACK']) {
      const g = reportFixture(); g.metadata.release_gate.decision = decision;
      expect(g.build().decision).toBe(decision);
      expect(g.build().proposedStatisticalDisposition).toBe('HOLD');
    }
    const savings = reportFixture(); savings.heldout.samples.forEach(row => { row.baseline.costUsd = 0.002; });
    savings.analysis.native.efficiencyClaim = { enabled: true, minimumPositiveTotalEconomicsUsd: 1 };
    expect(savings.build().native.preregisteredDecision).toBe('pass');
    savings.analysis.native.efficiencyClaim.minimumPositiveTotalEconomicsUsd = 2;
    expect(savings.build().native.reasons).toContain('total-economics-not-positive');
    const g = reportFixture();
    expect(() => buildReport({ analysis: g.analysis, trustedAnalysisDigest: heldoutDigest(g.analysis), heldout: g.heldout,
      integrity: { ...g.metadata, sample_n: 1201 }, trustedIntegrityDigest: heldoutDigest(g.metadata), nowEpochMs: 0 })).toThrow('report-anchor');
    g.metadata.integrity_mode = 'invented'; expect(g.build().proposedStatisticalDisposition).toBe('HOLD');
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'd29-study-')); dirs.push(root); hostChecks.root = root;
  const corpus = structuredClone(prepared.corpus);
  corpus.rows = SLICES.map(slice => corpus.rows.find(row => row.split === 'tuning' && row.slice === slice));
  const preregistration = { ...prepared.preregistration, corpusDigest: heldoutDigest(corpus), requestTimeoutMs: 100 };
  const approval = { ...structuredClone(prepared.approval), approved: true, runId: 'd29-offline', reviewer: 'offline-fixture',
    approvalReference: 'fixture-only', sourceCommit: 'a'.repeat(40), exactHeadCi: 'fixture-only', stagingWorkspace: 'fixture',
    region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: heldoutDigest('fixture'),
    corpusDigest: heldoutDigest(corpus), preregistrationDigest: heldoutDigest(preregistration), calibrationDigest: heldoutDigest('fixture'),
    providerTermsReference: 'offline-no-egress', priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 };
  approval.priceBound.approvalReference = 'offline-fixture';
  approval.executionDigest = heldoutExecutionDigest(corpus, preregistration, approval);
  const bundle = { corpus, preregistration, approval };
  let now = Date.parse('2026-10-01T00:00:00Z');
  const host = { resolveCredential: vi.fn(async () => new TextEncoder().encode('offline-placeholder')), dispose: vi.fn() };
  const run = (transport, options = {}) => collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(approval),
    sourceRoot: process.cwd(), artifactRoot: root, offline: { transport, host }, now: () => now,
    sleep: async ms => { now += ms; }, ...options });
  return { bundle, run, root, host, runDir: join(heldoutRunsRoot(root), approval.runId) };
}
function response(init) {
  const wire = JSON.parse(init.body), question = wire.questions.q0, criteria = question.criteria;
  const payload = wire.state.untrusted.payload;
  expect(wire.state.verified).toEqual({}); expect(payload.kind).toMatch(/citation|phase-criterion/);
  expect(wire.state).not.toHaveProperty('localOutcome'); expect(wire.state).not.toHaveProperty('gold');
  let answer;
  if (question.type === 'score') answer = { type: 'score', score: 2, confidence: 0.99, probabilities: { 0: 0, 1: 0, 2: 1 }, legend: Object.fromEntries(criteria.map((level, i) => [String(i), level])) };
  else {
    const choices = Object.keys(criteria), support = payload.source?.includes('might') ? 'unclear' : payload.source?.includes('colored') ? 'does-not-support'
      : payload.source === payload.claim ? 'supports' : 'contradicts';
    const choice = choices.includes('supports') ? support : choices.includes('no') ? payload.source?.includes('Instruction:') ? 'yes' : 'no'
      : choices.includes('relevant') ? 'relevant' : choices.includes('complete') ? payload.evidence?.includes('not documented') ? 'incomplete' : 'complete' : choices.includes('none') ? 'none'
        : choices.includes('low') ? 'low' : 'not-needed';
    answer = { type: 'choice', choice, confidence: 0.99, probabilities: Object.fromEntries(choices.map(id => [id, id === choice ? 1 : 0])) };
  }
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { q0: answer }, usage: { input_tokens: 200, output_tokens: 20 } }),
    { headers: { 'content-type': 'application/json' } });
}

describe('D29 collector integration', () => {
  it('AC1/2/3/5/7 projects actual semantic payloads and maps native receipts; hard blockers make zero requests', async () => {
    const c = await setup(), transport = vi.fn(async (_url, init) => response(init));
    expect(await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval))).toMatchObject({ maximumAttempts: 44, reservedUsdMicros: 17600 });
    const result = await c.run(transport);
    expect(result).toMatchObject({ status: 'complete', completedRows: 8, reservedUsdMicros: 8800, source: 'injected-transport' });
    expect(transport).toHaveBeenCalledTimes(22);
    const attempts = (await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result).map(event => event.attempt);
    const citation = observationFromAttempts(c.bundle.corpus, c.bundle.corpus.rows[0], attempts);
    expect(citation).toMatchObject({ missing: false, observation: { support: 'supports', supportStrengthBps: 10000, injection: 'no', model: 'jev-1.13.0', attempts: 3 } });
    expect(citation.observation.supportDistribution).toEqual({ supports: 1, contradicts: 0, unclear: 0, 'does-not-support': 0 });
    const criterion = observationFromAttempts(c.bundle.corpus, c.bundle.corpus.rows[4], attempts);
    expect(Object.keys(criterion.observation.distributions)).toHaveLength(5);
    for (const row of c.bundle.corpus.rows.slice(-2)) expect(attempts.filter(attempt => attempt.rowId === row.id)).toEqual([]);
    const changed = structuredClone(attempts); changed[0].result.receipt.spec.evaluations.q0.spec.value = 'contradicts';
    expect(() => observationFromAttempts(c.bundle.corpus, c.bundle.corpus.rows[0], changed)).toThrow();
  });
  it('AC6 exhaustively keeps failed prerequisites non-ready regardless of bounded output and confidence', () => {
    const row = prepared.corpus.rows.find(row => row.slice === 'failed-test'), host = hostContext(row);
    for (const relevance of ['relevant', 'irrelevant', 'unclear']) for (const completeness of ['complete', 'incomplete', 'unclear'])
      for (const contradiction of ['none', 'present', 'unclear']) for (const ambiguity of ['low', 'high', 'unclear'])
        for (const reviewerAttention of ['needed', 'not-needed']) for (const confidenceBps of [0, 7999, 8000, 10000]) {
          const receipt = evaluateSdlcEvidenceScreening({ schemaVersion: 'decision-sdlc-evidence-screening/v1', mode: 'shadow',
            subject: host.subject, inventory: host.inventory, gatePolicyPin: host.gatePolicyPin, nowEpochMs: 1, observation: { kind: 'phase-criterion', criterionId: host.subject.criterionId,
              evidenceIds: host.subject.evidence.map(item => item.id), relevance, completeness, contradiction, ambiguity, reviewerAttention,
              confidenceBps, model: 'jev-1.13.0', attempts: 1 } }, { gatePolicyPin: host.gatePolicyPin, gatePolicies: [host.policy], calibration: null });
          expect(receipt.route).toBe('FAIL');
          expect(receipt.deterministic.findings.some(item => item.reason === 'test-failed')).toBe(true);
        }
  });
  it('AC11/12 disabled collection and screening leave serialized host outcomes and receipts unchanged', async () => {
    const poison = new Proxy({}, { get() { throw new Error('disabled input accessed'); } });
    expect(await collectHeldoutStudy({ enabled: false, bundle: poison })).toEqual({ status: 'disabled' });
    expect(evaluateSdlcEvidenceScreening({ mode: 'disabled', subject: poison })).toBeNull();
    const outcome = { pass: false, reason: 'required-test-failed', publication: false };
    const original = JSON.stringify(outcome);
    const result = applySdlcScreeningToGateOutcome(outcome, 'disabled', [], null);
    expect(JSON.stringify(result.outcome)).toBe(original); expect(JSON.stringify(outcome)).toBe(original);
  });
  it.each(['budget', 'rejection', 'timeout', 'cancel'])('AC8/9 retains completed observations on %s and reserves before dispatch', async kind => {
    const c = await setup(); let calls = 0; const controller = new AbortController();
    if (kind === 'budget') c.bundle.approval.budget.calls = 5;
    if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = vi.fn(async (_url, init) => {
      if (++calls <= 3 || kind === 'budget') return response(init);
      if (kind === 'rejection') throw new Error('synthetic dispatch rejection');
      if (kind === 'cancel') controller.abort();
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(101);
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(new Error('aborted'));
        else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const result = await c.run(transport, { signal: controller.signal });
    expect(result.status).toBe('stopped'); expect(result.completedRows).toBeGreaterThanOrEqual(1);
    const attempts = (await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result).map(event => event.attempt);
    expect(attempts.slice(0, 3).every(attempt => attempt.result.disposition === 'success')).toBe(true);
    expect(attempts.every(attempt => attempt.reservedUsdMicros === 400)).toBe(true);
    expect(observationFromAttempts(c.bundle.corpus, c.bundle.corpus.rows[0], attempts).missing).toBe(false);
    expect(observationFromAttempts(c.bundle.corpus, c.bundle.corpus.rows[1], attempts).missing).toBe(true);
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('AC8/9/13 fits calibration only, binds every scored row to receipts, and withholds a report for missing measurements', async () => {
    const c = await setup();
    await c.run(vi.fn(async (_url, init) => response(init)));
    const templates = (await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result).map(event => event.attempt);
    // Expand explicitly injected fixture receipts to exercise full membership accounting, never live quality.
    const corpusDigest = heldoutDigest(prepared.corpus);
    const attempts = prepared.corpus.rows.flatMap(row => row.requests.map(request => {
      const original = templates.find(attempt => attempt.requestId === request.id
        && c.bundle.corpus.rows.find(item => item.id === attempt.rowId).slice === row.slice);
      const attempt = structuredClone(original); attempt.rowId = row.id; attempt.corpusDigest = corpusDigest;
      attempt.preregistrationDigest = heldoutDigest(prepared.preregistration);
      const invocation = `${row.id}-${request.id}-${attempt.ordinal}`;
      attempt.result.receipt.spec.invocationId = invocation;
      attempt.result.receipt.spec.evaluations.q0.spec.invocationId = invocation;
      attempt.result.receiptDigest = heldoutDigest(attempt.result.receipt);
      return attempt;
    }));
    const mapping = fitReadinessMapping(prepared, attempts);
    expect(mapping.cells['citation:true']).toMatchObject({ n: 25, ready: 25, probability: 26 / 27 });
    expect(mapping.cells['citation:false']).toMatchObject({ n: 75, ready: 0, probability: 1 / 77 });
    const changedTest = attempts.filter(attempt => !attempt.rowId.includes('-test-'));
    expect(fitReadinessMapping(prepared, changedTest)).toEqual(mapping);
    expect(() => fitReadinessMapping(prepared, attempts.filter(attempt => !attempt.rowId.includes('-calibration-')))).toThrow('calibration-observations-missing');
    const mappingDigest = heldoutDigest(mapping), analysisDigest = heldoutDigest(prepared.analysis);
    const identity = { provider: 'jev', backend: 'api', actualModel: 'jev-1.13.0', primitive: 'choice',
      definitionDigest: mapping.definitionDigest, adapterVersion: '1.0.0', dataset: { id: 'offline-calibration', hash: mapping.splitDigest },
      slice: { id: 'offline-synthetic', hash: mapping.splitDigest }, calibrator: { id: 'd29-readiness', version: '1', parametersDigest: mappingDigest } };
    const draft = { schemaVersion: 'decision-calibration-artifact/v1', id: 'offline-d29-calibration', identity,
      splitProvenance: { id: 'offline-calibration', hash: mapping.splitDigest, holdoutAccessedAt: null },
      profile: { minimumTotalSamples: 100, minimumPerSliceSamples: 20, powerRule: null, confidenceInterval: { method: 'wilson', level: 0.95 },
        maximumCalibrationError: 0.1, maximumSelectiveRisk: 0.1, expiresAfterDays: 30 },
      metrics: { totalSamples: 150, perSliceSamples: 25, calibrationError: 0.04, selectiveRisk: 0, confidenceIntervals: { ece: { lower: 0, upper: 0.08 } } },
      effectiveAt: '2026-10-01T00:00:00Z', limitations: ['Offline fixture only; no calibration qualification.'],
      approval: { state: 'approved', reference: 'offline-fixture-only' } };
    const registry = new CalibrationRegistry(), artifact = { ...draft, digest: calibrationArtifactDigest(draft) };
    registry.registerArtifact(artifact); registry.observeAlias('jev-1.13.0', identity, draft.effectiveAt);
    const reviews = structuredClone(prepared.reviews);
    for (const item of reviews.assessments) Object.assign(item, { goldCorrect: true, goldRationale: 'Offline fixture only',
      blindReviewedAt: '2026-10-02T00:00:00Z', agreed: true, overridden: false, rationale: 'Offline fixture only', unblindedAt: '2026-10-02T01:00:00Z' });
    for (const item of reviews.assessments.filter(item => item.phase === 'development')) {
      item.blindReviewedAt = '2026-09-30T00:10:00Z'; item.unblindedAt = '2026-09-30T00:30:00Z';
    }
    for (const item of reviews.assessments.filter(item => item.phase === 'delayed-repeat')) {
      item.blindReviewedAt = '2026-10-02T02:00:00Z'; item.unblindedAt = '2026-10-02T03:00:00Z';
    }
    reviews.preregistrationReview = 'offline-fixture'; reviews.finalDispositionReview = 'offline-fixture';
    const access = { schemaVersion: 'decision-d29-access/v1', analysisDigest, anchoredAt: '2026-09-30T01:00:00Z',
      firstTestAccessAt: '2026-10-01T00:00:00Z', reference: 'offline-fixture' };
    const metadata = integrity(), context = { trustedIntegrityDigest: heldoutDigest(metadata), trustedAnalysisDigest: analysisDigest,
      access, trustedAccessDigest: heldoutDigest(access), mapping, trustedMappingDigest: mappingDigest,
      reviews, trustedReviewsDigest: heldoutDigest(reviews), trustedCalibrationDigest: artifact.digest, nowEpochMs: Date.parse('2026-10-03T00:00:00Z'),
      calibration: { registry, request: { runId: 'offline-d29', requestedAlias: 'jev-1.13.0', actualIdentity: identity,
        calibrationArtifactId: artifact.id, at: '2026-10-03T00:00:00Z' },
        policy: { unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' } } };
    const input = { corpus: prepared.corpus, preregistration: prepared.preregistration, gold: prepared.gold, attempts, integrity: metadata };
    const report = await score(input, context);
    expect(report.heldout.samples).toHaveLength(1200);
    expect(report.reviewerN).toBe(80); expect(report.provenance).toHaveLength(1200);
    expect(report.heldout.samples.filter(row => row.candidate.route === 'ADVISORY_READY')).toHaveLength(300);
    expect(report.heldout.samples.find(row => row.candidate.calls > 0).candidate.costUsd).toBeNull();
    expect(report.heldout.samples.find(row => row.candidate.calls === 0).candidate.inputTokens).toBe(0);
    expect(report.failureAsError).toMatchObject({ missingCandidateErrors: 0, denominator: 1200 });
    expect(report.native.decision).toBe('PROMOTE'); expect(report.decision).toBe('HOLD');
    const missingId = attempts.find(attempt => attempt.rowId.includes('-test-')).rowId;
    const incomplete = await score({ ...input, attempts: attempts.filter(attempt => attempt.rowId !== missingId) }, context);
    expect(incomplete.heldout).toBeNull(); expect(incomplete.native.heldout).toBeNull();
    expect(incomplete.completeCase.n).toBe(1199); expect(incomplete.failureAsError.missingCandidateErrors).toBe(1);
    expect(incomplete.proposedStatisticalDisposition).toBe('HOLD');
    await expect(score(input, { ...context, calibration: null })).rejects.toThrow('calibration-identity');
    await expect(score(input, { ...context, calibration: { ...context.calibration, request: {
      ...context.calibration.request, actualIdentity: { ...identity, adapterVersion: 'unqualified' } } } })).rejects.toThrow('calibration-identity');
    const prematureRepeat = structuredClone(reviews);
    prematureRepeat.assessments.find(item => item.phase === 'delayed-repeat').blindReviewedAt = '2026-10-02T00:00:00Z';
    await expect(score(input, { ...context, reviews: prematureRepeat, trustedReviewsDigest: heldoutDigest(prematureRepeat) })).rejects.toThrow('repeat-not-delayed');
    await expect(score({ ...input, integrity: { ...metadata, sample_n: 9999 } }, context)).rejects.toThrow('integrity-pin');
    await expect(score(input, { ...context, access: { ...access, firstTestAccessAt: '2026-09-01T00:00:00Z' } })).rejects.toThrow('holdout-access');
  }, 30000);
  it('AC8/13 names missing live inputs without manufacturing calibration or reviewer agreement', async () => {
    expect(await score({ ...prepared, attempts: [], integrity: integrity() })).toMatchObject({ decision: 'HOLD', native: null });
  });
});
