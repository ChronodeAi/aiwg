import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectHeldoutStudy, scoreHeldoutStudy } from '../../../src/decision/heldout/collector.js';
import { heldoutDigest, heldoutExecutionDigest, heldoutReservationMicros, planHeldoutCollection, validateHeldoutBundle,
  validateHeldoutInputs } from '../../../src/decision/heldout/contract.js';
import { heldoutRunsRoot, readHeldoutJournal, scanHeldoutSpend } from '../../../src/decision/heldout/journal.js';
import type { HeldoutBundle, HeldoutStudyModule } from '../../../src/decision/heldout/types.js';
import { evaluateDecisionRuleset } from '../../../src/decision/evaluate.js';
import { heldoutExecution } from '../../../src/decision/heldout/contract.js';
import { prepare } from '../../../agentic/code/addons/decision-engine/examples/heldout-collector-offline.mjs';

// Offline source/root attestation seam. The production checks are exercised separately against real git.
const preflight = vi.hoisted(() => ({ failSource: false, canonical: '' }));
vi.mock('../../../src/decision/context-live-qualification.js', async original => {
  const module = await original<typeof import('../../../src/decision/context-live-qualification.js')>();
  return { ...module, assertContextLiveSource: vi.fn(async () => { if (preflight.failSource) throw new Error('dirty'); }),
    assertContextArtifactRoot: vi.fn(async (_source: string, root: string) => { if (root !== preflight.canonical) throw new Error('root'); }) };
});
const dirs: string[] = [];
afterEach(async () => { preflight.failSource = false; vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const pin = heldoutDigest('offline-fixture');
async function setup(count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'heldout-test-')); dirs.push(root); preflight.canonical = root;
  const { corpus, preregistration, gold } = await prepare('fresh-example');
  corpus.rows = Array.from({ length: count }, (_, i) => ({ ...structuredClone(corpus.rows[i % 2]), id: `row_${i}`, familyId: `family_${i}`,
    input: { payload: `Fictional lamp ${i} is on.` }, requests: [corpus.rows[0].requests[0]] }));
  corpus.provenance.goldDigest = heldoutDigest(gold);
  preregistration.corpusDigest = heldoutDigest(corpus);
  const bundle: HeldoutBundle = { corpus, preregistration, approval: { schemaVersion: 'decision-heldout-approval/v1', approved: true,
    study: 'D17', runId: 'offline-01', reviewer: 'fixture-reviewer', approvalReference: 'fixture-only', sourceCommit: 'a'.repeat(40),
    exactHeadCi: 'fixture-ci', stagingHost: 'titan', stagingWorkspace: 'fixture-workspace', model: 'jev-1.13.0', servedModel: 'jev-1.13.0',
    region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: pin,
    corpusDigest: heldoutDigest(corpus), preregistrationDigest: heldoutDigest(preregistration), executionDigest: pin, calibrationDigest: pin,
    providerTermsReference: 'fixture-synthetic-only', priceBound: { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
      evidenceReferences: ['fixture-rate'], approvalReference: 'fixture-attestation' }, budget: { calls: 1000, tokens: 4000000, usd: 1 },
    priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 } };
  const host = { resolveCredential: vi.fn(async () => new TextEncoder().encode('fake-scoped-reader-value')), dispose: vi.fn() };
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
  return { root, bundle, host, clock, refresh, run, gold, runDir: join(heldoutRunsRoot(root), bundle.approval.runId) };
}
function reply(init?: RequestInit, changes: Record<string, unknown> = {}) {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
    { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } }])),
    usage: { input_tokens: 20, output_tokens: 4 }, ...changes }), { headers: { 'content-type': 'application/json' } });
}
const fake = () => vi.fn(async (_url: unknown, init?: RequestInit) => reply(init));

// Shared collector acceptance criteria 1-8; these are plumbing controls, never study quality evidence.
describe('held-out collector contract and default-off isolation', () => {
  it('AC1 rejects unknown/null price, approval, calibration and membership fields', async () => {
    const { bundle, refresh } = await setup();
    for (const mutate of [
      (b: any) => { b.unregistered = true; },
      (b: any) => { b.approval.priceBound.inputUsdPerMTok = null; },
      (b: any) => { b.approval.priceBound.evidenceReferences = []; },
      (b: any) => { b.approval.priceBound.extra = true; },
      (b: any) => { b.approval.calibrationDigest = null; },
      (b: any) => { b.approval.approvalReference = ''; },
      (b: any) => { b.corpus.rows[1].familyId = b.corpus.rows[0].familyId; b.corpus.rows[1].split = 'calibration'; },
    ]) {
      const bad = structuredClone(bundle); mutate(bad);
      expect(() => validateHeldoutBundle(bad, heldoutDigest(bad.approval))).toThrow();
    }
    refresh(); expect(() => validateHeldoutBundle(bundle, heldoutDigest(bundle.approval))).not.toThrow();
    expect(heldoutReservationMicros(bundle.approval, bundle.preregistration)).toBe(400);
    bundle.approval.priceBound.outputUsdPerMTok = 2; bundle.approval.priceBound.perRequestUsd = 0.001;
    bundle.approval.priceBound.outputTokenBound = 100;
    expect(heldoutReservationMicros(bundle.approval, bundle.preregistration)).toBe(1600);
  });
  it('AC8 refuses non-synthetic and credential-bearing payloads before credential resolution', async () => {
    const context = await setup(); const transport = fake();
    (context.bundle.corpus as any).syntheticOnly = false;
    await expect(context.run(transport)).rejects.toThrow();
    context.bundle.corpus.syntheticOnly = true;
    context.bundle.corpus.rows[0].input.payload = { api_key: 'not-synthetic-secret' };
    await expect(context.run(transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled(); expect(context.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('AC5 binds frozen inputs, bounds request size, and enforces exact source/root and the env gate', async () => {
    const c = await setup(); const transport = fake();
    await expect(collectHeldoutStudy({ enabled: true, bundle: c.bundle, trustedApprovalDigest: pin, sourceRoot: process.cwd(), artifactRoot: c.root,
      offline: { transport, host: c.host } })).rejects.toThrow();
    preflight.failSource = true; await expect(c.run(transport)).rejects.toThrow(); preflight.failSource = false;
    await expect(c.run(transport, { artifactRoot: join(c.root, 'nested') })).rejects.toThrow();
    const old = process.env.AIWG_DECISION_HELDOUT_LIVE; delete process.env.AIWG_DECISION_HELDOUT_LIVE;
    try { await expect(c.run(transport, { offline: undefined })).rejects.toThrow('live-gate'); }
    finally { if (old !== undefined) process.env.AIWG_DECISION_HELDOUT_LIVE = old; }
    c.bundle.corpus.rows[0].input.payload = 'x'.repeat(4001);
    await expect(c.run(transport)).rejects.toThrow('payload-bound');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('AC5 disabled collection leaves existing decision bytes identical and invokes no hooks', async () => {
    const c = await setup();
    const execution = heldoutExecution(c.bundle.corpus, c.bundle.preregistration, c.bundle.approval, c.bundle.corpus.rows[0].requests[0]);
    const adapter = { id: 'jev', version: '1.0.0', capabilities: async () => ({ answerKinds: ['choice'], features: ['typed-output'],
      executable: true, confidenceProfiles: [], maxOptions: 255, egress: { mode: 'none' } }), evaluate: vi.fn(async () => ({ status: 'success', reason: 'none', value: 'yes',
      uncertainty: null, actualModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: null })) };
    const evaluate = () => evaluateDecisionRuleset({ ruleset: execution.ruleset, binding: execution.binding,
      definitions: { [execution.definition.metadata.id]: execution.definition }, input: c.bundle.corpus.rows[0].input,
      runId: 'existing', invocationId: 'existing', adapters: { jev: adapter as any }, now: c.clock.now });
    const before = await evaluate();
    expect(before.spec.status).toBe('completed'); expect(before.spec.outcome).toBe('review');
    const hostile = { get bundle() { throw new Error('disabled code touched inputs'); } };
    expect(await collectHeldoutStudy(hostile as any)).toEqual({ status: 'disabled' });
    expect(JSON.stringify(await evaluate())).toBe(JSON.stringify(before));
    expect(adapter.evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('held-out collector dispatch and durable accounting', () => {
  it('AC1 reserves durably before every dispatch, projects only payload, retains receipts and never refunds', async () => {
    const c = await setup();
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = await readHeldoutJournal(c.runDir);
      expect(events.at(-1)?.attempt.result).toBeNull();
      expect(events.at(-1)?.attempt.reservedUsdMicros).toBe(400);
      const request = JSON.parse(String(init?.body));
      expect(request.state).toEqual({ verified: {}, untrusted: { payload: c.bundle.corpus.rows[transport.mock.calls.length - 1].input.payload } });
      expect(request).not.toHaveProperty('gold'); return reply(init);
    });
    const result = await c.run(transport);
    expect(result).toMatchObject({ status: 'complete', reservedUsdMicros: 800, completedRows: 2, missingRows: [], decision: 'HOLD', source: 'injected-transport' });
    const attempts = (await readHeldoutJournal(c.runDir)).filter(e => e.attempt.result).map(e => e.attempt);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].result?.receiptDigest).toMatch(/^sha256:/);
    expect(attempts[0].result?.inputTokens).toBe(20);
    expect(attempts[0].result?.providerCostUsd).toBeNull();
    expect((await scanHeldoutSpend(c.root, 'D17')).studyUsdMicros).toBe(800);
    const manifest = JSON.parse(await readFile(join(c.runDir, 'qualification.json'), 'utf8'));
    expect(manifest.mode).toBe('recorded'); expect(manifest.evidence[0]).toMatchObject({ executable: true, outcome: 'pass' });
    expect(c.host.dispose).toHaveBeenCalledOnce();
  });
  it('AC2 reserves one terminal retry, persists measurement failure and stops spending on an over-tolerance slice', async () => {
    const c = await setup(20);
    const transport = vi.fn(async () => new Response('{}', { status: 503 }));
    const result = await c.run(transport);
    expect(result).toMatchObject({ measurementFailures: ['row_0', 'row_1'], reservedUsdMicros: 1600, completedRows: 0 });
    expect(transport).toHaveBeenCalledTimes(4);
    const events = await readHeldoutJournal(c.runDir);
    expect(events.filter(e => e.attempt.result).map(e => e.attempt.result?.disposition)).toEqual(['retryable', 'measurement-failure', 'retryable', 'measurement-failure']);
    expect(events[1].attempt.result?.inputTokens).toBeNull();
  });
  it('AC2 a successful retry remains a real observation with both paid attempts retained', async () => {
    const c = await setup(1); let n = 0;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => ++n === 1 ? new Response('{}', { status: 503 }) : reply(init));
    expect(await c.run(transport)).toMatchObject({ completedRows: 1, reservedUsdMicros: 800 });
    expect((await readHeldoutJournal(c.runDir)).filter(e => e.attempt.result)).toHaveLength(2);
  });
  it.each(['model', 'usage', 'unknown-usage', 'auth', 'rejected', 'credential'])('AC3 stops immediately on %s and preserves completed rows', async kind => {
    const c = await setup(3); let n = 0;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (++n === 1) return reply(init);
      if (kind === 'rejected') throw new Error('private transport text');
      if (kind === 'auth') return new Response('{}', { status: 401 });
      return reply(init, kind === 'model' ? { model: 'changed-model' } : kind === 'usage' ? { usage: { input_tokens: 4001, output_tokens: 0 } }
        : kind === 'unknown-usage' ? { usage: {} } : { model: 'fake-scoped-reader-value' });
    });
    const result = await c.run(transport);
    expect(result).toMatchObject({ status: 'stopped', completedRows: 1, reservedUsdMicros: 800 });
    expect(transport).toHaveBeenCalledTimes(2);
    const events = await readHeldoutJournal(c.runDir);
    expect(events[1].attempt.result?.disposition).toBe('success');
    expect(JSON.stringify(events)).not.toContain('fake-scoped-reader-value');
    expect(JSON.stringify(events)).not.toContain('private transport text');
  });
  it('AC3 reserves before budget exhaustion and counts prior runs under both hard caps', async () => {
    const c = await setup(3); c.bundle.approval.budget.calls = 2;
    const transport = fake(); expect(await c.run(transport)).toMatchObject({ status: 'stopped', reason: 'budget-exhausted', completedRows: 1, reservedUsdMicros: 400 });
    expect(transport).toHaveBeenCalledOnce();
    c.bundle.approval.runId = 'offline-02'; c.bundle.approval.budget.calls = 1000;
    c.bundle.approval.priorStudySpendUsd = 7.9996;
    await expect(c.run(transport)).rejects.toThrow('baseline-changed');
    expect(transport).toHaveBeenCalledOnce();
  });
  it('AC3 cancellation and timeout keep the stopping reservation without retry or undefined hashing', async () => {
    for (const kind of ['cancel', 'timeout']) {
      const c = await setup(2); const controller = new AbortController();
      if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      c.bundle.preregistration.requestTimeoutMs = 25;
      let n = 0;
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (++n === 1) return reply(init);
        if (kind === 'cancel') controller.abort();
        if (kind === 'timeout') await vi.advanceTimersByTimeAsync(26);
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new Error('aborted'));
          else init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      });
      expect(await c.run(transport, { signal: controller.signal })).toMatchObject({ status: 'stopped', completedRows: 1, reservedUsdMicros: 800 });
      expect(transport).toHaveBeenCalledTimes(2);
      expect((await readHeldoutJournal(c.runDir)).at(-1)?.attempt.result?.disposition).toBe('stop');
      vi.useRealTimers();
    }
  });
  it('AC5 checkpoints before an unaffordable pair and resumes without recollecting completed requests', async () => {
    const c = await setup(2); c.bundle.preregistration.sessionLimitMs = 5000;
    // 4000ms worst-case pair, so after 1000ms pacing only the first row fits the 80% session window.
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { await c.clock.sleep(1); return reply(init); });
    expect(await c.run(transport)).toMatchObject({ status: 'checkpoint', completedRows: 1 });
    c.bundle.approval.runId = 'offline-resume';
    const summary: any = await c.run(transport);
    expect(summary).toMatchObject({ completedRows: 2, reservedUsdMicros: 400 });
    const metadata = { sample_n: 2, uncertainty: {}, paired_baseline: {}, integrity_mode: 'locked', fresh_workspace_required: false,
      fresh_workspace_verified: false, integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [],
      weak_signal_reason: null, release_gate: { decision: 'HOLD' as const, reasons: ['fixture'] } };
    const score = vi.fn(async () => ({ decision: 'HOLD' }));
    expect(await scoreHeldoutStudy({ run: join(heldoutRunsRoot(c.root), 'offline-resume'), trustedEvidenceDigest: summary.evidenceDigest,
      trustedApprovalDigest: heldoutDigest(c.bundle.approval), module: { prepare, score } as HeldoutStudyModule,
      moduleDigest: c.bundle.preregistration.scorerDigest, gold: c.gold, integrity: metadata, trustedIntegrityDigest: heldoutDigest(metadata) })).toMatchObject({ complete: true });
    expect(score.mock.calls[0][0].attempts).toHaveLength(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('AC1 rejects concurrent studies, symlinked roots and corrupted prior journals', async () => {
    const c = await setup(1); let release!: () => void;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { await new Promise<void>(done => { release = done; }); return reply(init); });
    const pending = c.run(transport);
    while (!release) await new Promise(done => setTimeout(done, 5));
    await expect(c.run(fake())).rejects.toThrow('dispatch-locked'); release(); await pending;
    const eventPath = join(c.runDir, '00000001.json'); await writeFile(eventPath, '{}');
    await expect(scanHeldoutSpend(c.root, 'D17')).rejects.toThrow();
    const other = await setup(1); const target = join(other.root, 'outside'); await writeFile(target, '{}');
    await symlink(target, join(other.root, 'link'));
    await expect(scanHeldoutSpend(join(other.root, 'link'), 'D17')).rejects.toThrow();
  });
});

describe('held-out recorded evidence and study interface', () => {
  const integrity = () => ({ sample_n: 2, uncertainty: { method: 'wilson', levelBps: 9500 }, paired_baseline: { n: 2 },
    integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'verified',
    trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [], weak_signal_reason: null,
    release_gate: { decision: 'HOLD' as const, reasons: ['fixture-only'] } });
  it('AC6/7 rereads evidence before the scorer, rejects forged integrity and never upgrades HOLD or ROLLBACK', async () => {
    const c = await setup(); const summary: any = await c.run(fake());
    const score = vi.fn(async () => ({ decision: 'PROMOTE', candidateQuality: 0.1, baselineQuality: 1, netSavingsUsd: -1 }));
    const module = { prepare, score } as HeldoutStudyModule;
    const metadata = integrity();
    const input = { run: c.runDir, trustedEvidenceDigest: summary.evidenceDigest, trustedApprovalDigest: heldoutDigest(c.bundle.approval),
      module, moduleDigest: c.bundle.preregistration.scorerDigest, gold: c.gold, integrity: metadata, trustedIntegrityDigest: heldoutDigest(metadata) };
    const report = await scoreHeldoutStudy(input);
    expect(report).toMatchObject({ complete: true, decision: 'HOLD', source: 'injected-transport' });
    expect(score.mock.calls[0][0].attempts).toHaveLength(2);
    await expect(scoreHeldoutStudy({ ...input, integrity: { ...metadata, sample_n: 2000 } })).rejects.toThrow('scoring-pins');
    const rollback = { ...metadata, release_gate: { decision: 'ROLLBACK' as const, reasons: ['compromise'] } };
    expect(await scoreHeldoutStudy({ ...input, integrity: rollback, trustedIntegrityDigest: heldoutDigest(rollback) })).toMatchObject({ decision: 'ROLLBACK' });
    const invalid = { ...metadata, sample_n: null };
    await expect(scoreHeldoutStudy({ ...input, integrity: invalid as any, trustedIntegrityDigest: heldoutDigest(invalid) })).rejects.toThrow('integrity-invalid');
    await writeFile(join(c.runDir, '00000002.json'), '{}');
    await expect(scoreHeldoutStudy(input)).rejects.toThrow(); expect(score).toHaveBeenCalledTimes(2);
  });
  it('AC6 detects tampered traces, truncated journals and changed frozen inputs', async () => {
    for (const change of ['trace', 'truncate', 'frozen']) {
      const c = await setup(1); await c.run(fake());
      if (change === 'trace') await writeFile(join(c.runDir, 'trace-1.json'), '[{"changed":true}]');
      else if (change === 'truncate') await rm(join(c.runDir, '00000002.json'));
      else {
        const frozen = JSON.parse(await readFile(join(c.runDir, 'frozen.json'), 'utf8')); frozen.bundle.corpus.rows[0].input.payload = 'changed';
        await writeFile(join(c.runDir, 'frozen.json'), JSON.stringify(frozen));
      }
      await expect(scanHeldoutSpend(c.root, 'D17')).rejects.toThrow();
    }
  });
  it('AC2 applies the preregistered failure tolerance and zero-retry policy', async () => {
    const c = await setup(20); c.bundle.preregistration.providerFailurePolicy.maximumSliceFailureBps = 0;
    c.bundle.preregistration.providerFailurePolicy.maxRetries = 0;
    const transport = vi.fn(async () => new Response('{}', { status: 503 }));
    expect(await c.run(transport)).toMatchObject({ measurementFailures: ['row_0'], reservedUsdMicros: 400 });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('AC3 pre-cancellation makes no reservation; unknown execution blocks all later studies', async () => {
    const c = await setup(); const controller = new AbortController(); controller.abort(); const transport = fake();
    expect(await c.run(transport, { signal: controller.signal })).toMatchObject({ reason: 'cancelled', reservedUsdMicros: 0 });
    expect(transport).not.toHaveBeenCalled();
    c.bundle.approval.runId = 'offline-unknown';
    await c.run(vi.fn(async () => { throw new Error('lost connection'); }));
    c.bundle.approval.runId = 'offline-after-unknown';
    await expect(c.run(transport)).rejects.toThrow('dispatch-locked');
    expect(transport).not.toHaveBeenCalled();
  });
  it('AC1 accounts above-bound observed usage and enforces the portfolio remainder before dispatch', async () => {
    const c = await setup(1);
    await c.run(vi.fn(async (_url: unknown, init?: RequestInit) => reply(init, { usage: { input_tokens: 10000, output_tokens: 0 } })));
    expect((await scanHeldoutSpend(c.root, 'D17')).studyUsdMicros).toBe(1000);
    const next = await setup(1); next.bundle.approval.priorPortfolioSpendUsd = 47.9996;
    const transport = fake(); expect(await next.run(transport)).toMatchObject({ reason: 'budget-exhausted', reservedUsdMicros: 0 });
    expect(transport).not.toHaveBeenCalled();
  });
  it('AC3 suppresses credential-bearing worker output, stops and persists no secret', async () => {
    const c = await setup(2);
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { process.stdout.write('fake-scoped-reader-value'); return reply(init); });
    expect(await c.run(transport)).toMatchObject({ reason: 'credential-anomaly' });
    expect(transport).toHaveBeenCalledOnce();
    const events = await readHeldoutJournal(c.runDir);
    expect(JSON.stringify(events)).not.toContain('fake-scoped-reader-value');
    expect(events.at(-1)?.attempt.result?.receipt).toBeNull();
  });
  it('AC7 supports a D29 deterministic zero-call row with local evidence, separate from provider measurements', async () => {
    const c = await setup(1); c.bundle.corpus.study = 'D29'; c.bundle.preregistration.study = 'D29'; c.bundle.approval.study = 'D29';
    c.bundle.corpus.rows[0].requests = []; c.bundle.corpus.rows[0].localOutcome = { route: 'FAIL', reason: 'required-test-failed' };
    const transport = fake(); expect(await c.run(transport)).toMatchObject({ status: 'complete', completedRows: 1, reservedUsdMicros: 0 });
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('AC5 source-only CLI help, example generation, prepare and live gates do not invoke build or a resolver', async () => {
    const c = await setup();
    const cli = resolve('tools/decision/heldout-study.mjs');
    const blocked = spawnSync(process.execPath, [cli, '--collect-approved', 'missing', pin, c.root],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, AIWG_DECISION_HELDOUT_LIVE: '' } });
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('Held-out collector refused');
    const help = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 10000 });
    expect(help.status).toBe(0); expect(help.stdout).toContain('--prepare');
    const generated = await prepare('independent-seed');
    expect(generated.corpus.rows[0].input.payload).toContain('independent-seed');
    expect(generated.gold).toEqual({ example_0: 'yes', example_1: 'no' });
    expect(() => validateHeldoutInputs(generated.corpus, generated.preregistration)).not.toThrow();
    const planned = await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval));
    expect(planned).toMatchObject({ providerCalls: 0, maximumAttempts: 4, reservedTokens: 17024, reservedUsdMicros: 1600, fitsBeforeStop: true });
    const real = await vi.importActual<typeof import('../../../src/decision/context-live-qualification.js')>('../../../src/decision/context-live-qualification.js');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
    expect(head).toMatch(/^[a-f0-9]{40}$/);
    await expect(real.assertContextLiveSource(process.cwd(), '0'.repeat(40))).rejects.toThrow();
    expect(await readdir(c.root)).toEqual([]);
    const bin = join(c.root, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'aiwg'), '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify({ artifact_root: c.root })) + ');\n', { mode: 0o700 });
    await writeFile(join(bin, 'npm'), '#!/usr/bin/env node\nprocess.exit(99);\n', { mode: 0o700 });
    const prepared = spawnSync(process.execPath, [cli, '--prepare', resolve('agentic/code/addons/decision-engine/examples/heldout-collector-offline.mjs'), 'cli-seed', join(c.root, 'prepared')],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(JSON.parse(prepared.stdout).providerCalls).toBe(0);
    const saved = JSON.parse(await readFile(join(c.root, 'prepared/corpus.json'), 'utf8'));
    expect(saved.provenance.seed).toBe('cli-seed');
    expect(JSON.parse(await readFile(join(c.root, 'prepared/approval-template.json'), 'utf8')).approved).toBe(false);
  });
});


describe('held-out raw transport controls', () => {
  it('HIGH3 refuses a missing or modified baseline instead of resetting prior spend', async () => {
    for (const change of ['missing', 'modified']) {
      const c = await setup(1); await c.run(fake()); c.bundle.approval.runId = 'baseline-rerun';
      const path = join(c.root, 'research/qualification/heldout/baselines/portfolio.json');
      if (change === 'missing') await rm(path);
      else { const value = JSON.parse(await readFile(path, 'utf8')); value.usdMicros = 1; await writeFile(path, JSON.stringify(value)); }
      const transport = fake(); await expect(c.run(transport)).rejects.toThrow('baseline-mismatch');
      expect(transport).not.toHaveBeenCalled();
    }
  });
  it('HIGH3 charges another study against the same portfolio baseline and prior run spend', async () => {
    const c = await setup(1); c.bundle.approval.priorStudySpendUsd = 7; c.bundle.approval.priorPortfolioSpendUsd = 47;
    c.bundle.approval.priceBound.perRequestUsd = 0.7; const transport = fake();
    await c.run(transport);
    c.bundle.corpus.study = 'D29'; c.bundle.preregistration.study = 'D29'; c.bundle.approval.study = 'D29';
    c.bundle.approval.priorStudySpendUsd = 0; c.bundle.approval.runId = 'other-study';
    expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', reservedUsdMicros: 0 });
    expect(transport).toHaveBeenCalledOnce();
    expect(await scanHeldoutSpend(c.root, 'D29')).toMatchObject({ studyUsdMicros: 0, portfolioUsdMicros: 47700400 });
  });
  it('HIGH3 adds three runs to the durable $7 study / $47 portfolio baseline without reusing the remainder', async () => {
    const c = await setup(3); c.bundle.approval.priorStudySpendUsd = 7; c.bundle.approval.priorPortfolioSpendUsd = 47;
    c.bundle.approval.budget.calls = 2; c.bundle.approval.priceBound.perRequestUsd = 0.4;
    const transport = fake();
    expect(await c.run(transport)).toMatchObject({ completedRows: 1, reservedUsdMicros: 400400 });
    c.bundle.approval.runId = 'floor-02';
    expect(await c.run(transport)).toMatchObject({ completedRows: 2, reservedUsdMicros: 400400 });
    c.bundle.approval.runId = 'floor-03';
    expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', completedRows: 2, reservedUsdMicros: 0 });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await scanHeldoutSpend(c.root, 'D17')).toMatchObject({ studyUsdMicros: 7800800, portfolioUsdMicros: 47800800 });
  });
  it('HIGH2 refuses the 4000-token reservation / 9000-token paid-output probe before dispatch', async () => {
    const c = await setup(1); c.bundle.approval.budget.usd = 8;
    c.bundle.approval.priceBound.outputUsdPerMTok = 1000;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init, { usage: { input_tokens: 20, output_tokens: 9000 } }));
    await expect(c.run(transport)).rejects.toThrow('output-bound-required');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('HIGH2 refuses a schema-permitted tariff whose attested output bound exceeds the remaining cap', async () => {
    const c = await setup(1); c.bundle.approval.budget.usd = 8;
    Object.assign(c.bundle.approval.priceBound, { outputUsdPerMTok: 1000, outputTokenBound: 9000 });
    const transport = fake();
    expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', reservedUsdMicros: 0 });
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('HIGH2 reserves serialized UTF-8 input and attested paid output before dispatch, then halts on excess output', async () => {
    const c = await setup(2); c.bundle.corpus.rows[0].input.payload = '灯'.repeat(100);
    Object.assign(c.bundle.approval.priceBound, { inputUsdPerMTok: 2, outputUsdPerMTok: 3, outputTokenBound: 100 });
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const attempt = (await readHeldoutJournal(c.runDir)).at(-1)!.attempt;
      expect(attempt.reservedTokens).toBeGreaterThanOrEqual(Buffer.byteLength(String(init?.body), 'utf8') + 100);
      expect(attempt.reservedUsdMicros).toBe(8300);
      return reply(init, { usage: { input_tokens: 20, output_tokens: 101 } });
    });
    expect(await c.run(transport)).toMatchObject({ reason: 'output-bound', status: 'stopped' });
    expect(transport).toHaveBeenCalledOnce();
    expect((await readHeldoutJournal(c.runDir)).at(-1)?.attempt.result?.outputTokens).toBe(101);
  });
  it('HIGH1 refuses incomplete offline options before credentials or global fetch with live and TLS gates unset', async () => {
    const c = await setup(1); const transport = fake();
    vi.stubGlobal('fetch', transport);
    vi.stubEnv('AIWG_DECISION_HELDOUT_LIVE', '');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    try {
      for (const offline of [{ host: c.host }, { transport }, null, {}, { transport: null, host: c.host }]) {
        await expect(c.run(transport, { offline })).rejects.toThrow('offline-options');
      }
      expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
      expect(await readdir(c.root)).toEqual([]);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
  it.each(['model', 'usage', 'credential'])('AC3 stops on %s even when the answer is invalid', async kind => {
    const c = await setup(2);
    const transport = vi.fn(async () => new Response(JSON.stringify({ model: kind === 'model' ? 'changed-model' : 'jev-1.13.0',
      answers: {}, usage: { input_tokens: kind === 'usage' ? 10000 : 20, output_tokens: 1 },
      ignored: kind === 'credential' ? 'fake-scoped-reader-value' : 'safe' }), { headers: { 'content-type': 'application/json' } }));
    expect(await c.run(transport)).toMatchObject({ status: 'stopped', completedRows: 0 });
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(await readHeldoutJournal(c.runDir))).not.toContain('fake-scoped-reader-value');
  });
});
