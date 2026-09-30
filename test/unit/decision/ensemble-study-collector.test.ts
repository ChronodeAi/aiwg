import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepare } from '../../../tools/decision/d17-study.mjs';
import { evaluateDecisionRuleset } from '../../../src/decision/evaluate.js';
import { collectHeldoutStudy } from '../../../src/decision/heldout/collector.js';
import { heldoutDigest, heldoutExecution, heldoutExecutionDigest } from '../../../src/decision/heldout/contract.js';
import { heldoutRunsRoot, readHeldoutJournal, scanHeldoutSpend } from '../../../src/decision/heldout/journal.js';
import type { HeldoutBundle } from '../../../src/decision/heldout/types.js';
import { buildD17NativeReport, scoreD17Study } from '../../../src/decision/ensemble-study/score.js';
import { D17_ANALYSIS } from '../../../src/decision/ensemble-study/protocol.js';
import { pairedThresholdsDigest, validateChampionChallenger, validateEnsembleIntegrityReport } from '../../../src/decision/ensemble/contract.js';
import { championChallengerInputSetDigest, championChallengerShadowBaseline, runChampionChallengerShadow } from '../../../src/decision/ensemble/runtime.js';
import { d17Statistics } from '../../../src/decision/ensemble-study/statistics.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';

// Offline source/root attestation seam; no test acquires a live credential or transport.
const preflight = vi.hoisted(() => ({ canonical: '' }));
vi.mock('../../../src/decision/context-live-qualification.js', async original => {
  const module = await original<typeof import('../../../src/decision/context-live-qualification.js')>();
  return { ...module, assertContextLiveSource: vi.fn(async () => {}),
    assertContextArtifactRoot: vi.fn(async (_source: string, root: string) => { if (root !== preflight.canonical) throw new Error('root'); }) };
});

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const pin = heldoutDigest('d17-offline-diagnostic');
async function setup(scoring = false) {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-study-test-')); dirs.push(root); preflight.canonical = root;
  const prepared = await prepare('d17-offline-diagnostic');
  const { corpus, preregistration } = prepared;
  // Only two development subjects exercise collection mechanics. This is not a frozen study analysis.
  corpus.rows = scoring ? [corpus.rows.find(row => row.split === 'tuning')!, corpus.rows.find(row => row.split === 'calibration')!,
    ...corpus.rows.filter(row => row.split === 'test').slice(0, 2)] : corpus.rows.filter(row => row.split === 'tuning').slice(0, 2);
  const bundle: HeldoutBundle = { corpus, preregistration, approval: { schemaVersion: 'decision-heldout-approval/v1', approved: true,
    study: 'D17', runId: 'd17-offline-01', reviewer: 'fixture-reviewer', approvalReference: 'fixture-only', sourceCommit: 'a'.repeat(40),
    exactHeadCi: 'fixture-ci', stagingHost: 'titan', stagingWorkspace: 'fixture-workspace', model: 'jev-1.13.0', servedModel: 'jev-1.13.0',
    region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: pin,
    corpusDigest: heldoutDigest(corpus), preregistrationDigest: heldoutDigest(preregistration), executionDigest: pin, calibrationDigest: pin,
    providerTermsReference: 'fixture-synthetic-only', priceBound: { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
      evidenceReferences: ['fixture-rate'], approvalReference: 'fixture-attestation' }, budget: { calls: 100, tokens: 400000, usd: 1 },
    priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 } };
  const host = { resolveCredential: vi.fn(async () => new TextEncoder().encode('fake-d17-scoped-reader-value')), dispose: vi.fn() };
  let time = Date.parse('2026-09-30T01:00:00Z');
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const refresh = () => {
    bundle.preregistration.corpusDigest = heldoutDigest(bundle.corpus);
    bundle.approval.corpusDigest = heldoutDigest(bundle.corpus);
    bundle.approval.preregistrationDigest = heldoutDigest(bundle.preregistration);
    bundle.approval.executionDigest = heldoutExecutionDigest(bundle.corpus, bundle.preregistration, bundle.approval);
  };
  refresh();
  const run = async (transport: typeof fetch, extra = {}) => {
    refresh(); return collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(bundle.approval),
      artifactRoot: root, sourceRoot: process.cwd(), offline: { transport, host }, ...clock, ...extra });
  };
  return { root, bundle, host, clock, run, prepared, runDir: join(heldoutRunsRoot(root), bundle.approval.runId) };
}
function reply(init?: RequestInit, changes: Record<string, unknown> = {}) {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
    { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } }])),
    usage: { input_tokens: 20, output_tokens: 4 }, ...changes }), { headers: { 'content-type': 'application/json' } });
}

describe('D17 diagnostic collection through the shared collector', () => {
  it('AC3/7 makes four fresh calls per subject with identical projected inputs and separately retained native evidence', async () => {
    const c = await setup(); const bodies: unknown[] = [];
    expect(c.bundle.corpus.rows[0].requests.map(request => request.arm)).toEqual(['baseline', 'candidate', 'candidate', 'candidate']);
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = await readHeldoutJournal(c.runDir);
      expect(events.at(-1)?.attempt).toMatchObject({ result: null, reservedUsdMicros: 400, reservedTokens: 4000 });
      expect(events.filter(event => event.attempt.result === null)).toHaveLength(transport.mock.calls.length);
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      expect(body.state).toEqual({ verified: {}, untrusted: { payload: c.bundle.corpus.rows[Math.floor((transport.mock.calls.length - 1) / 4)].input.payload } });
      expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
      expect(body).not.toHaveProperty('gold'); expect(body.state).not.toHaveProperty('labels');
      return reply(init);
    });
    expect(await c.run(transport)).toMatchObject({ status: 'complete', completedRows: 2, reservedUsdMicros: 3200,
      missingRows: [], source: 'injected-transport', decision: 'HOLD' });
    expect(transport).toHaveBeenCalledTimes(8);
    expect(bodies.slice(0, 4)).toEqual(Array(4).fill(bodies[0]));
    expect(bodies.slice(4)).toEqual(Array(4).fill(bodies[4]));
    expect(bodies[0]).not.toEqual(bodies[4]);
    const attempts = (await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result).map(event => event.attempt);
    expect(attempts.slice(0, 4).map(attempt => attempt.requestId)).toEqual(['champion', 'member_1', 'member_2', 'member_3']);
    expect(new Set(attempts.map(attempt => attempt.result?.receipt?.spec.invocationId)).size).toBe(8);
    for (const attempt of attempts) {
      expect(attempt.result).toMatchObject({ disposition: 'success', servedModel: 'jev-1.13.0', inputTokens: 20, outputTokens: 4,
        providerCostUsd: null, accountedUsdMicros: 400 });
      expect(attempt.result?.receiptDigest).toBe(heldoutDigest(attempt.result?.receipt));
      expect(attempt.result?.receipt?.spec.evaluations.q0.spec.uncertainty?.distribution).toEqual({ yes: 0.9, no: 0.1 });
    }
    expect((await scanHeldoutSpend(c.root, 'D17')).studyUsdMicros).toBe(3200);
    const manifest = JSON.parse(await readFile(join(c.runDir, 'qualification.json'), 'utf8'));
    expect(manifest.mode).toBe('recorded'); expect(manifest.evidence[0].outcome).toBe('pass');
    expect(c.host.dispose).toHaveBeenCalledOnce();
  });
  it.each(['cancel', 'timeout', 'rejected', 'model', 'unknown-usage'])('AC3/5 retains a completed pair and stopping reservation after %s', async kind => {
    const c = await setup(); const controller = new AbortController(); let calls = 0;
    if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    c.bundle.preregistration.requestTimeoutMs = 25;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (++calls <= 4) return reply(init);
      if (kind === 'rejected') throw new Error('private dispatch failure');
      if (kind === 'model') return reply(init, { model: 'unknown-model' });
      if (kind === 'unknown-usage') return reply(init, { usage: {} });
      if (kind === 'cancel') controller.abort();
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(26);
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error('aborted'));
        else init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    expect(await c.run(transport, { signal: controller.signal })).toMatchObject({ status: 'stopped', completedRows: 1,
      missingRows: [c.bundle.corpus.rows[1].id], reservedUsdMicros: 2000, decision: 'HOLD' });
    expect(transport).toHaveBeenCalledTimes(5);
    const attempts = (await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result).map(event => event.attempt);
    expect(attempts.map(attempt => attempt.result?.disposition)).toEqual(['success', 'success', 'success', 'success', 'stop']);
    expect(attempts.slice(0, 4).every(attempt => attempt.result?.receiptDigest)).toBe(true);
    expect(JSON.stringify(attempts)).not.toContain('private dispatch failure');
    expect(attempts[4].result?.accountedUsdMicros).toBe(400);
  });
  it('AC5 checks call, token and USD limits before dispatch and retains the completed subject', async () => {
    for (const ceiling of ['calls', 'tokens', 'usd']) {
      const c = await setup();
      if (ceiling === 'calls') c.bundle.approval.budget.calls = 5;
      if (ceiling === 'tokens') c.bundle.approval.budget.tokens = 20000;
      if (ceiling === 'usd') c.bundle.approval.budget.usd = 0.002;
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init));
      expect(await c.run(transport)).toMatchObject({ status: 'stopped', reason: 'budget-exhausted', completedRows: 1,
        reservedUsdMicros: 1600, missingRows: [c.bundle.corpus.rows[1].id] });
      expect(transport).toHaveBeenCalledTimes(4);
      expect((await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result === null)).toHaveLength(4);
    }
  });
  it('AC3/5 retains the paid failed attempt when a terminal retry completes a member', async () => {
    const c = await setup(); let calls = 0;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => ++calls === 2 ? new Response('{}', { status: 503 }) : reply(init));
    expect(await c.run(transport)).toMatchObject({ status: 'complete', completedRows: 2, reservedUsdMicros: 3600 });
    const attempts = (await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result).map(event => event.attempt);
    expect(transport).toHaveBeenCalledTimes(9);
    expect(attempts[1]).toMatchObject({ ordinal: 1, result: { disposition: 'retryable', inputTokens: null, providerCostUsd: null } });
    expect(attempts[2]).toMatchObject({ requestId: attempts[1].requestId, rowId: attempts[1].rowId,
      ordinal: 2, result: { disposition: 'success' } });
    expect((await scanHeldoutSpend(c.root, 'D17')).studyUsdMicros).toBe(3600);
  });
  it('AC11 rejects credential-bearing synthetic input before credential resolution or dispatch', async () => {
    const c = await setup();
    c.bundle.corpus.rows[0].input.payload = { api_key: 'not-synthetic-secret' };
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init));
    await expect(c.run(transport)).rejects.toThrow('credential-material');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('AC13 default-off collection leaves existing decision output byte-identical without reading study inputs', async () => {
    const c = await setup();
    const execution = heldoutExecution(c.bundle.corpus, c.bundle.preregistration, c.bundle.approval, c.bundle.corpus.rows[0].requests[0]);
    const adapter = { id: 'jev', version: '1.0.0', capabilities: async () => ({ answerKinds: ['choice'], features: ['typed-output'],
      executable: true, confidenceProfiles: [], maxOptions: 255, egress: { mode: 'none' } }), evaluate: vi.fn(async () => ({ status: 'success', reason: 'none', value: 'yes',
      uncertainty: null, actualModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: null })) };
    const evaluate = () => evaluateDecisionRuleset({ ruleset: execution.ruleset, binding: execution.binding,
      definitions: { [execution.definition.metadata.id]: execution.definition }, input: c.bundle.corpus.rows[0].input,
      runId: 'existing', invocationId: 'existing', adapters: { jev: adapter as any }, now: c.clock.now });
    const before = await evaluate(); expect(before.spec.status).toBe('completed'); expect(before.spec.outcome).toBe('review');
    const hostile = { get bundle() { throw new Error('disabled collection accessed study inputs'); } };
    expect(await collectHeldoutStudy(hostile as any)).toEqual({ status: 'disabled' });
    expect(JSON.stringify(await evaluate())).toBe(JSON.stringify(before));
    expect(adapter.evaluate).toHaveBeenCalledTimes(2); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
});

describe('D17 scorer with recorded injected-transport observations', () => {
  const integrity = (): QualificationIntegrityMetadata => ({ sample_n: 2, uncertainty: { method: 'newcombe-10', levelBps: 9500 },
    paired_baseline: { n: 2 }, integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: false,
    integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [], weak_signal_reason: null,
    release_gate: { decision: 'HOLD', reasons: ['offline-diagnostic-only'] } });
  const input = async (c: Awaited<ReturnType<typeof setup>>) => ({ corpus: c.bundle.corpus, preregistration: c.bundle.preregistration,
    attempts: (await readHeldoutJournal(c.runDir)).filter(event => event.attempt.result).map(event => event.attempt),
    gold: c.prepared.gold, integrity: integrity() });
  it('AC6/7 maps native mean distributions but scores shared errors against local gold, never agreement', async () => {
    const c = await setup(true);
    await c.run(vi.fn(async (_url: unknown, init?: RequestInit) => reply(init)));
    const report = await scoreD17Study(await input(c), c.prepared);
    expect(report.pairs.map(pair => pair.champion.correct)).toEqual([true, false]);
    expect(report.pairs.map(pair => pair.challenger.correct)).toEqual([true, false]);
    expect(report.observations[1].aggregate?.warnings).toContain('high-agreement-not-correctness');
    expect(report.observations[1].aggregate?.warnings).toContain('shared-systematic-error-risk');
    expect(report.observations[1].aggregate?.warnings).toContain('uncalibrated-members');
    expect(report.observations[1].champion?.quality).toBe(0); expect(report.observations[1].challenger?.quality).toBe(0);
    expect(report.statistics.netSavingsMicros).toBe(-1600);
    expect(report.pairs.map(pair => [pair.champion.reservedCostMicros, pair.challenger.reservedCostMicros])).toEqual([[400, 1200], [400, 1200]]);
    expect(report.statistics).toMatchObject({ statisticalGate: 'HOLD', benefitSupported: false,
      worstCaseFailureAsError: { n: 2, championCorrect: 1, challengerCorrect: 1, missingPairsCountedAsErrors: 0 } });
    expect(report.calibrationDiagnostics.calibrated).toBe(false); expect(report.decision).toBe('HOLD');
  });
  it('AC3/7 uses the three member probabilities and excludes the fresh champion from the aggregate', async () => {
    const c = await setup(true); let calls = 0;
    await c.run(vi.fn(async (_url: unknown, init?: RequestInit) => {
      const yes = [0.9, 0.6, 0.7, 0.8][calls++ % 4];
      return reply(init, { answers: { q0: { type: 'choice', choice: 'yes', confidence: yes, probabilities: { yes, no: 1 - yes } } } });
    }));
    const report = await scoreD17Study(await input(c), c.prepared);
    expect(report.pairs).toHaveLength(2);
    expect(report.pairs[0].champion.probability).toBe(0.9);
    expect(report.pairs[0].challenger.probability).toBeCloseTo(0.7, 12);
    expect(report.observations[0].aggregate?.statistics.meanDistribution).toEqual({ yes: 0.7, no: 0.3 });
    expect(report.pairs[0].challenger.brier).toBeCloseTo(0.09, 12);
    expect(report.pairs[1].challenger.brier).toBeCloseTo(0.49, 12);
    expect(report.pairs[0].champion.tokens).toBe(24); expect(report.pairs[0].challenger.tokens).toBe(72);
  });
  it('AC3/7 preserves the successful champion when a failed member withholds its paired endpoint', async () => {
    const c = await setup(true); let calls = 0;
    await c.run(vi.fn(async (_url: unknown, init?: RequestInit) => ++calls >= 10 ? new Response('{}', { status: 503 }) : reply(init)));
    const report = await scoreD17Study(await input(c), c.prepared);
    expect(report.pairs).toEqual([]);
    expect(report.observations[0].champion).toMatchObject({ quality: 1, tokens: 24, costMicros: 400 });
    expect(report.observations[0].challenger).toBeNull();
    expect(report.observations[0].aggregate?.warnings).toContain('member-failures-present');
    expect(report.statistics.worstCaseFailureAsError).toEqual({ n: 2, championCorrect: 1, challengerCorrect: 0, missingPairsCountedAsErrors: 2 });
    expect(report.accounting).toEqual({ allSplits: { attempts: 11, reservedCostMicros: 4400 },
      test: { championReservedCostMicros: 400, challengerReservedCostMicros: 800, netSavingsMicros: -400, complete: false } });
    expect(report.statistics.missingIds).toEqual(c.bundle.corpus.rows.filter(row => row.split === 'test').map(row => row.id));
    expect(report.calibrationDiagnostics.challenger).toBeNull(); expect(report.decision).toBe('HOLD');
  });
  it('AC3/5 does not turn unknown failed-retry usage into zero and includes its nonrefundable reservation', async () => {
    const c = await setup(true); let calls = 0;
    await c.run(vi.fn(async (_url: unknown, init?: RequestInit) => ++calls === 10 ? new Response('{}', { status: 503 }) : reply(init)));
    const report = await scoreD17Study(await input(c), c.prepared);
    expect(report.pairs).toHaveLength(2);
    expect(report.pairs[0].challenger.tokens).toBeNull();
    expect(report.observations[0].challenger?.tokens).toBeNull();
    expect(report.pairs[0].challenger.reservedCostMicros).toBe(1600);
    expect(report.statistics.netSavingsMicros).toBe(-2000);
    expect(report.statistics.pairedDeltas.find(delta => delta.metric === 'tokens')?.pairs).toBe(1);
    expect(report.statistics.findings).toContain('paired-delta-insufficient:tokens');
    expect(report.decision).toBe('HOLD');
  });
  it('AC14 rejects altered corpus, gold, prepared gold and spread-copied native observations', async () => {
    const c = await setup(true);
    await c.run(vi.fn(async (_url: unknown, init?: RequestInit) => reply(init)));
    const scoredInput = await input(c), report = await scoreD17Study(scoredInput, c.prepared);
    const altered = structuredClone(scoredInput); altered.corpus.rows[0].input.payload = 'altered fictional facts';
    await expect(scoreD17Study(altered, c.prepared)).rejects.toThrow();
    const gold = structuredClone(c.prepared.gold); gold.labels[c.bundle.corpus.rows.at(-1)!.id] = 'yes';
    await expect(scoreD17Study({ ...scoredInput, gold }, c.prepared)).rejects.toThrow('frozen scoring pins');
    await expect(scoreD17Study(scoredInput, { ...c.prepared, gold })).rejects.toThrow('frozen scoring pins');
    const record = JSON.parse(await readFile('test/fixtures/decision/ensemble/champion-challenger.v1.valid.json', 'utf8')).records[0];
    record.inputSet.itemCount = 1200; record.pairedMetrics = structuredClone(D17_ANALYSIS.native);
    record.preregistration.thresholdsDigest = pairedThresholdsDigest(record.pairedMetrics);
    record.evaluationIntegrityReport.digest = heldoutDigest(scoredInput.integrity);
    const forged = structuredClone(report); forged.observations[1].challenger!.quality = 1;
    await expect(buildD17NativeReport({ report: forged, prepared: c.prepared, record, integrity: scoredInput.integrity,
      trustedIntegrityDigest: heldoutDigest(scoredInput.integrity), trustedReportDigest: heldoutDigest(report) })).rejects.toThrow('anchored HOLD or ROLLBACK');
    const rollback = { ...scoredInput, integrity: { ...scoredInput.integrity, release_gate: { decision: 'ROLLBACK' as const, reasons: ['offline-compromise'] } } };
    expect((await scoreD17Study(rollback, c.prepared)).decision).toBe('ROLLBACK');
  });
  it('AC7/14 serializes all eight native metrics from an anchored synthetic control and preserves HOLD', async () => {
    const c = await setup(true);
    await c.run(vi.fn(async (_url: unknown, init?: RequestInit) => reply(init)));
    const report = await scoreD17Study(await input(c), c.prepared), prepared = await prepare('d17-native-diagnostic');
    const test = prepared.corpus.rows.filter(row => row.split === 'test');
    // Controlled in-memory observations exercise serialization only; none are live study measurements.
    report.pairs = test.map((row, i) => ({ ...structuredClone(report.pairs[i % 2]), id: row.id, slice: row.slice }));
    report.observations = test.map((row, i) => {
      const example = structuredClone(report.observations[i % 2]);
      for (const role of ['champion', 'challenger'] as const) {
        example[role]!.inputDigest = heldoutDigest(row.input);
        example[role]!.receiptDigest = heldoutDigest({ fixture: 'synthetic-native-control', id: row.id, role });
      }
      return { ...example, id: row.id };
    });
    report.statistics = d17Statistics(report.pairs, test.map(row => row.id));
    report.statisticsDigest = heldoutDigest(report.statistics);
    report.accounting = { allSplits: { attempts: 4800, reservedCostMicros: 1920000 },
      test: { championReservedCostMicros: 480000, challengerReservedCostMicros: 1440000, netSavingsMicros: -960000, complete: true } };
    report.corpusDigest = heldoutDigest(prepared.corpus); report.preregistrationDigest = heldoutDigest(prepared.preregistration);
    const pins = JSON.parse(await readFile('test/fixtures/decision/ensemble/champion-challenger.v1.valid.json', 'utf8')).records[0];
    const execution = report.executionPins;
    const record = { ...structuredClone(prepared.nativeTemplates.comparison), alias: 'fixture-d17-native',
      champion: { ...pins.champion, actualModel: execution.model, adapter: execution.adapter, binding: execution.binding, ensemblePolicy: null },
      challenger: { ...pins.challenger, actualModel: execution.model, adapter: execution.adapter, binding: execution.binding,
        ensemblePolicy: report.observations[0].aggregate!.policy },
      eligibilityId: 'fixture-eligibility-unavailable', evaluationIntegrityReport: { id: 'fixture-native-integrity', digest: pin },
      approval: { reference: 'fixture-offline-only', approvedAt: '2026-09-30T01:00:00Z' }, rollbackTarget: pins.rollbackTarget };
    const items = test.map(row => ({ id: row.id, input: row.input, slice: row.slice }));
    record.inputSet.digest = championChallengerInputSetDigest(items);
    record.preregistration.thresholdsDigest = pairedThresholdsDigest(record.pairedMetrics);
    record.preregistration.holdoutAccessedAt = '2026-09-30T00:30:00Z';
    expect(() => validateChampionChallenger(record)).not.toThrow();
    const shadow = await runChampionChallengerShadow(record, { enabled: true, invocationId: 'd17-recorded-replay', items,
      evaluate: async ({ role, item }) => report.observations.find(row => row.id === item.id)![role]! });
    const anchored = { ...integrity(), sample_n: 1200, paired_baseline: {
      championChallengerShadow: championChallengerShadowBaseline(record, shadow), d17StatisticsDigest: report.statisticsDigest } };
    record.evaluationIntegrityReport.digest = heldoutDigest(anchored);
    const nativeInput = { report, prepared, record, integrity: anchored, trustedIntegrityDigest: heldoutDigest(anchored), trustedReportDigest: heldoutDigest(report) };
    const native = await buildD17NativeReport(nativeInput);
    expect(() => validateEnsembleIntegrityReport(native)).not.toThrow();
    expect(native.decision).toBe('HOLD'); expect(native.upstreamDecision).toBe('HOLD');
    expect(native.findings).toContain('d09-eligibility-missing');
    expect(native.pairedDeltas.map(delta => delta.metric)).toEqual(['abstention', 'calibration', 'cost', 'latency', 'quality', 'risk-coverage', 'slice', 'tokens']);
    expect(native.pairedDeltas.every(delta => delta.pairs === 1200)).toBe(true);
    expect(native.pairedDeltas.find(delta => delta.metric === 'cost')?.delta).toBe(800);
    for (const role of ['champion', 'challenger'] as const) {
      const wrongModel = structuredClone(record); wrongModel[role].actualModel = 'unobserved-model';
      await expect(buildD17NativeReport({ ...nativeInput, record: wrongModel })).rejects.toThrow('native execution pins');
      const wrongBinding = structuredClone(record); wrongBinding[role].binding!.digest = pin;
      await expect(buildD17NativeReport({ ...nativeInput, record: wrongBinding })).rejects.toThrow('native execution pins');
    }
    const wrongPolicy = structuredClone(record); wrongPolicy.challenger.ensemblePolicy.digest = pin;
    await expect(buildD17NativeReport({ ...nativeInput, record: wrongPolicy })).rejects.toThrow('native execution pins');
    const missingUsage = structuredClone(report); missingUsage.observations[0].challenger!.tokens = null;
    await expect(buildD17NativeReport({ ...nativeInput, report: missingUsage, trustedReportDigest: heldoutDigest(missingUsage) }))
      .rejects.toThrow('incomplete native endpoints');
    const rollbackReport = structuredClone(report); rollbackReport.decision = 'ROLLBACK';
    rollbackReport.integrity.release_gate = { decision: 'ROLLBACK', reasons: ['synthetic-compromise-control'] };
    rollbackReport.integrityDigest = heldoutDigest(rollbackReport.integrity);
    await expect(buildD17NativeReport({ ...nativeInput, report: rollbackReport, trustedReportDigest: heldoutDigest(rollbackReport) }))
      .rejects.toThrow('anchored HOLD or ROLLBACK');
    const unbound = { ...anchored, paired_baseline: { ...anchored.paired_baseline, d17StatisticsDigest: pin } };
    await expect(buildD17NativeReport({ ...nativeInput, integrity: unbound, trustedIntegrityDigest: heldoutDigest(unbound),
      record: { ...record, evaluationIntegrityReport: { ...record.evaluationIntegrityReport, digest: heldoutDigest(unbound) } } }))
      .rejects.toThrow('unbound native statistics');
  });
  it('AC13 source-only scoring CLI describes local replay and rejects collection mode without opening artifacts', () => {
    const help = spawnSync(process.execPath, ['tools/decision/d17-score.mjs', '--help'], { encoding: 'utf8', timeout: 10000 });
    expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain('Offline D17 scoring');
    expect(help.stdout).toContain('trustedEvidenceDigest');
    const rejected = spawnSync(process.execPath, ['tools/decision/d17-score.mjs', '--collect-approved'], { encoding: 'utf8', timeout: 10000 });
    expect(rejected.status).toBe(1); expect(rejected.stderr).toContain('D17 scoring refused'); expect(rejected.stdout).toBe('');
  });
});
