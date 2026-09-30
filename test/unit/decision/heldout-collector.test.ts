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
import { generateHeldoutRow } from '../../../src/decision/heldout/generators.js';
import { prepare, prepareStaged } from '../../../agentic/code/addons/decision-engine/examples/heldout-collector-offline.mjs';

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
  corpus.rows = Array.from({ length: count }, (_, i) => generateHeldoutRow('heldout-lamp/v1', `fresh-example:${i}:single`));
  corpus.provenance.goldDigest = heldoutDigest(gold);
  preregistration.corpusDigest = heldoutDigest(corpus);
  const bundle: HeldoutBundle = { corpus, preregistration, approval: { schemaVersion: 'decision-heldout-approval/v1', approved: true,
    study: 'D17', runId: 'offline-01', reviewer: 'fixture-reviewer', approvalReference: 'fixture-only', sourceCommit: 'a'.repeat(40),
    exactHeadCi: 'fixture-ci', stagingHost: 'titan', stagingWorkspace: 'fixture-workspace', model: 'jev-1.13.0', servedModel: 'jev-1.13.0',
    region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: pin,
    corpusDigest: heldoutDigest(corpus), preregistrationDigest: heldoutDigest(preregistration), executionDigest: pin, calibration: { mode: 'uncalibrated-diagnostic' },
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
      (b: any) => { b.approval.priceBound.outputUsdPerMTok = null; },
      (b: any) => { b.approval.priceBound.outputTokenBound = null; },
      (b: any) => { b.approval.priceBound.outputTokenBound = -1; },
      (b: any) => { b.approval.priceBound.evidenceReferences = []; },
      (b: any) => { b.approval.priceBound.extra = true; },
      (b: any) => { b.approval.calibration = null; },
      (b: any) => { b.approval.approvalReference = ''; },
      (b: any) => { b.corpus.rows[1].familyId = b.corpus.rows[0].familyId; b.corpus.rows[1].split = 'calibration'; },
    ]) {
      const bad = structuredClone(bundle); mutate(bad);
      expect(() => validateHeldoutBundle(bad, heldoutDigest(bad.approval))).toThrow();
    }
    refresh(); expect(() => validateHeldoutBundle(bundle, heldoutDigest(bundle.approval))).not.toThrow();
    expect(heldoutReservationMicros(bundle.approval, 4000)).toBe(400);
    bundle.approval.priceBound.inputUsdPerMTok = 2; bundle.approval.priceBound.perRequestUsd = 0.001;
    bundle.approval.priceBound.outputTokenBound = 100;
    expect(heldoutReservationMicros(bundle.approval, 4000)).toBe(9000);
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
    c.bundle.corpus.definitions[0].spec.question = 'x'.repeat(4001);
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
      expect(events.at(-1)?.attempt.reservedUsdMicros).toBe(76);
      const request = JSON.parse(String(init?.body));
      expect(request.state).toEqual({ verified: {}, untrusted: { payload: c.bundle.corpus.rows[transport.mock.calls.length - 1].input.payload } });
      expect(request).not.toHaveProperty('gold'); return reply(init);
    });
    const result = await c.run(transport);
    expect(result).toMatchObject({ status: 'complete', reservedUsdMicros: 152, completedRows: 2, missingRows: [], decision: 'HOLD', source: 'injected-transport' });
    const attempts = (await readHeldoutJournal(c.runDir)).filter(e => e.attempt.result).map(e => e.attempt);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].result?.receiptDigest).toMatch(/^sha256:/);
    expect(attempts[0].result?.inputTokens).toBe(20);
    expect(attempts[0].result?.providerCostUsd).toBeNull();
    expect((await scanHeldoutSpend(c.root, 'D17')).studyUsdMicros).toBe(152);
    const manifest = JSON.parse(await readFile(join(c.runDir, 'qualification.json'), 'utf8'));
    expect(manifest.mode).toBe('recorded'); expect(manifest.evidence[0]).toMatchObject({ executable: true, outcome: 'pass' });
    expect(c.host.dispose).toHaveBeenCalledOnce();
  });
  it('AC2 reserves one terminal retry, persists measurement failure and stops spending on an over-tolerance slice', async () => {
    const c = await setup(20);
    const transport = vi.fn(async () => new Response('{}', { status: 503 }));
    const result = await c.run(transport);
    expect(result).toMatchObject({ measurementFailures: ['row_0', 'row_1'], reservedUsdMicros: 304, completedRows: 0 });
    expect(transport).toHaveBeenCalledTimes(4);
    const events = await readHeldoutJournal(c.runDir);
    expect(events.filter(e => e.attempt.result).map(e => e.attempt.result?.disposition)).toEqual(['retryable', 'measurement-failure', 'retryable', 'measurement-failure']);
    expect(events[1].attempt.result?.inputTokens).toBeNull();
  });
  it('AC2 a successful retry remains a real observation with both paid attempts retained', async () => {
    const c = await setup(1); let n = 0;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => ++n === 1 ? new Response('{}', { status: 503 }) : reply(init));
    expect(await c.run(transport)).toMatchObject({ completedRows: 1, reservedUsdMicros: 152 });
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
    expect(result).toMatchObject({ status: 'stopped', completedRows: 1, reservedUsdMicros: 152 });
    expect(transport).toHaveBeenCalledTimes(2);
    const events = await readHeldoutJournal(c.runDir);
    expect(events[1].attempt.result?.disposition).toBe('success');
    expect(JSON.stringify(events)).not.toContain('fake-scoped-reader-value');
    expect(JSON.stringify(events)).not.toContain('private transport text');
  });
  it('AC3 reserves before budget exhaustion and counts prior runs under both hard caps', async () => {
    const c = await setup(3); c.bundle.approval.budget.calls = 2;
    const transport = fake(); expect(await c.run(transport)).toMatchObject({ status: 'stopped', reason: 'budget-exhausted', completedRows: 1, reservedUsdMicros: 76 });
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
      expect(await c.run(transport, { signal: controller.signal })).toMatchObject({ status: 'stopped', completedRows: 1, reservedUsdMicros: 152 });
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
    expect(summary).toMatchObject({ completedRows: 2, reservedUsdMicros: 76 });
    const metadata = { sample_n: 2, uncertainty: {}, paired_baseline: {}, integrity_mode: 'locked', fresh_workspace_required: false,
      fresh_workspace_verified: false, integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [],
      weak_signal_reason: null, release_gate: { decision: 'HOLD' as const, reasons: ['fixture'] } };
    const score = vi.fn(async () => ({ calibrated: false, decision: 'HOLD' }));
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
    const c = await setup();
    c.bundle.preregistration.calibration = { scope: 'calibrated', allowedModes: ['artifact'] };
    c.bundle.approval.calibration = { mode: 'artifact', calibrationArtifactDigest: pin };
    const summary: any = await c.run(fake());
    const score = vi.fn(async () => ({ calibrated: false, decision: 'PROMOTE', candidateQuality: 0.1, baselineQuality: 1, netSavingsUsd: -1 }));
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
    expect(await c.run(transport)).toMatchObject({ measurementFailures: ['row_0'], reservedUsdMicros: 76 });
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
    const next = await setup(1); next.bundle.approval.priorPortfolioSpendUsd = 47.99992;
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
    c.bundle.corpus.rows[0] = generateHeldoutRow('heldout-lamp/v1', 'fresh-example:0:local');
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
    expect(generated.corpus.rows[0].input.payload).toMatch(/world w-[a-f0-9]{16}, lamp/);
    expect(generated.corpus.rows[0].input.payload).not.toContain('independent-seed');
    expect(generated.gold).toEqual({ example_0: 'yes', example_1: 'no' });
    expect(() => validateHeldoutInputs(generated.corpus, generated.preregistration)).not.toThrow();
    const planned = await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval));
    expect(planned).toMatchObject({ providerCalls: 0, maximumAttempts: 4, reservedTokens: 4054, reservedUsdMicros: 304, fitsBeforeStop: true });
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
  it.each(['missing', 'unknown', 'digest', 'seed', 'forged'])('provenance re-runs the registered generator and refuses %s row provenance', async kind => {
    const c = await setup(1); const row = c.bundle.corpus.rows[0];
    if (kind === 'missing') delete (row as any).provenance;
    if (kind === 'unknown') row.provenance.generatorId = 'unregistered/v1';
    if (kind === 'digest') row.provenance.outputDigest = pin;
    if (kind === 'seed') row.provenance.seed = 'changed:1:single';
    if (kind === 'forged') {
      row.input.payload = 'Copied opaque text';
      const { provenance, ...output } = row; provenance.outputDigest = heldoutDigest(output);
    }
    const transport = fake(); await expect(c.run(transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('provenance refuses a claimed synthetic row with a forged generator output', async () => {
    const c = await setup(1); const transport = fake();
    c.bundle.corpus.rows[0].input.payload = 'Opaque material copied from elsewhere';
    await expect(c.run(transport)).rejects.toThrow('generator-output');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('HIGH3 refuses a missing or modified baseline instead of resetting prior spend', async () => {
    for (const change of ['missing', 'modified', 'approval']) {
      const c = await setup(1); await c.run(fake()); c.bundle.approval.runId = 'baseline-rerun';
      const path = join(c.root, 'research/qualification/heldout/baselines/portfolio.json');
      if (change === 'missing') await rm(path);
      else {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (change === 'approval') value.approvalDigest = pin; else value.usdMicros = 1;
        await writeFile(path, JSON.stringify(value));
      }
      const transport = fake(); await expect(c.run(transport)).rejects.toThrow(change === 'missing' ? 'operator-repair' : 'baseline-mismatch');
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
    expect(await scanHeldoutSpend(c.root, 'D29')).toMatchObject({ studyUsdMicros: 0, portfolioUsdMicros: 47700076 });
  });
  it('HIGH3 retains the durable $7 study / $47 portfolio baseline across three runs without renewing allowance', async () => {
    const c = await setup(3); c.bundle.approval.priorStudySpendUsd = 7; c.bundle.approval.priorPortfolioSpendUsd = 47;
    c.bundle.approval.budget.calls = 2; c.bundle.approval.priceBound.perRequestUsd = 0.4;
    const transport = fake();
    expect(await scanHeldoutSpend(c.root, 'D17', c.bundle.approval)).toMatchObject({ studyUsdMicros: 7000000, portfolioUsdMicros: 47000000 });
    expect(await readdir(join(c.root, 'research/qualification/heldout/baselines'))).toEqual([]);
    expect(await c.run(transport)).toMatchObject({ completedRows: 1, reservedUsdMicros: 400076 });
    c.bundle.approval.runId = 'floor-02';
    expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', completedRows: 1, reservedUsdMicros: 0 });
    c.bundle.approval.runId = 'floor-03';
    expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', completedRows: 1, reservedUsdMicros: 0 });
    expect(transport).toHaveBeenCalledOnce();
    expect(await scanHeldoutSpend(c.root, 'D17')).toMatchObject({ studyUsdMicros: 7400076, portfolioUsdMicros: 47400076 });
    expect(await scanHeldoutSpend(c.root, 'D17', c.bundle.approval)).toMatchObject({ studyUsdMicros: 7400076, portfolioUsdMicros: 47400076 });
    c.bundle.approval.priorPortfolioSpendUsd = 46;
    await expect(scanHeldoutSpend(c.root, 'D17', c.bundle.approval)).rejects.toThrow('baseline-changed');
  });
  it('HIGH2 refuses the 4000-token reservation / 9000-token paid-output probe before dispatch', async () => {
    const c = await setup(1); c.bundle.approval.budget.usd = 8;
    c.bundle.approval.priceBound.outputUsdPerMTok = 1000;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init, { usage: { input_tokens: 20, output_tokens: 9000 } }));
    await expect(c.run(transport)).rejects.toThrow('free-output-required');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it.each([1, 1000])('HIGH2 refuses paid output priced at %s even with an affordable attested bound', async rate => {
    const c = await setup(1);
    Object.assign(c.bundle.approval.priceBound, { outputUsdPerMTok: rate, outputTokenBound: 100 });
    const transport = fake();
    await expect(c.run(transport)).rejects.toThrow('free-output-required');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('HIGH2 reserves serialized UTF-8 input plus overhead and a fee before dispatch, then halts on excess free output', async () => {
    const c = await setup(2);
    Object.assign(c.bundle.approval.priceBound, { inputUsdPerMTok: 2, outputTokenBound: 100, perRequestUsd: 0.001 });
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const attempt = (await readHeldoutJournal(c.runDir)).at(-1)!.attempt;
      const bytes = Buffer.byteLength(String(init?.body), 'utf8');
      expect(attempt.reservedTokens).toBe(bytes + 512 + 256);
      expect(attempt.reservedUsdMicros).toBe((bytes + 512) * 2 + 1000);
      const counter = (await readFile(join(c.root, 'research/qualification/heldout/spend-counter.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(counter.at(-1)).toMatchObject({ charge: { accountedUsdMicros: null }, totalUsdMicros: (bytes + 512) * 2 + 1000 });
      return reply(init, { usage: { input_tokens: 20, output_tokens: 101 } });
    });
    expect(await c.run(transport)).toMatchObject({ reason: 'output-bound', status: 'stopped' });
    expect(transport).toHaveBeenCalledOnce();
    expect((await readHeldoutJournal(c.runDir)).at(-1)?.attempt.result?.outputTokens).toBe(101);
  });
  it('HIGH2 rejects multibyte input exceeding its token reservation before dispatch', async () => {
    const c = await setup(1); c.bundle.corpus.definitions[0].spec.question = '💡'.repeat(1000);
    const transport = fake(); await expect(c.run(transport)).rejects.toThrow('payload-bound');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
    expect(await readdir(c.root)).toEqual([]);
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

describe('collector re-verification cap probes', () => {
  it('rejects paid output even with an approved 100-token bound before the 9000-token response', async () => {
    const c = await setup(1);
    Object.assign(c.bundle.approval.priceBound, { outputUsdPerMTok: 1000, outputTokenBound: 100 });
    c.bundle.approval.budget.usd = 8;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init, { usage: { input_tokens: 20, output_tokens: 9000 } }));
    await expect(c.run(transport)).rejects.toThrow('free-output-required');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('rejects the $0.0005 approval when one byte-plus-overhead reservation costs more', async () => {
    const c = await setup(1); c.bundle.approval.budget.usd = 0.0005;
    c.bundle.approval.priceBound.inputUsdPerMTok = 1;
    const transport = fake(); await expect(c.run(transport)).rejects.toThrow('approval-call-budget');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it.each(['run-directory', 'events-and-summary'])('retains the study/portfolio allowance after deleting %s', async change => {
    const c = await setup(1); const transport = fake();
    Object.assign(c.bundle.approval, { priorStudySpendUsd: 7, priorPortfolioSpendUsd: 47 });
    c.bundle.approval.priceBound.perRequestUsd = 0.5;
    await c.run(transport);
    const before = await scanHeldoutSpend(c.root, 'D17');
    if (change === 'run-directory') await rm(c.runDir, { recursive: true });
    else for (const name of ['00000001.json', '00000002.json', 'summary.json']) await rm(join(c.runDir, name));
    const after = await scanHeldoutSpend(c.root, 'D17');
    expect(after.studyUsdMicros).toBe(before.studyUsdMicros);
    expect(after.portfolioUsdMicros).toBe(before.portfolioUsdMicros);
    for (const runId of ['deleted-02', 'deleted-03']) {
      c.bundle.approval.runId = runId;
      expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', reservedUsdMicros: 0 });
    }
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['delete', 'truncate', 'prefix', 'chain', 'head-delete', 'head-stale', 'interrupted-head'])('fails closed with operator repair on counter %s after deleting run evidence', async change => {
    const c = await setup(1); await c.run(fake()); await rm(c.runDir, { recursive: true });
    const path = join(c.root, 'research/qualification/heldout/spend-counter.jsonl');
    const bytes = await readFile(path, 'utf8');
    if (change === 'delete') await rm(path);
    if (change === 'truncate') await writeFile(path, bytes.slice(0, -10));
    if (change === 'prefix') await writeFile(path, bytes.split('\n')[0] + '\n');
    if (change === 'head-delete') await rm(join(c.root, 'research/qualification/heldout/spend-head.json'));
    if (change === 'head-stale') {
      const head = JSON.parse(await readFile(join(c.root, 'research/qualification/heldout/spend-head.json'), 'utf8'));
      head.sequence--;
      await writeFile(join(c.root, 'research/qualification/heldout/spend-head.json'), JSON.stringify(head));
    }
    if (change === 'interrupted-head') await writeFile(join(c.root, 'research/qualification/heldout/spend-head.next.json'), '{}');
    if (change === 'chain') {
      const lines = bytes.trim().split('\n').map(line => JSON.parse(line)); lines[1].previous = pin;
      await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    }
    c.bundle.approval.runId = 'damaged-counter'; const transport = fake();
    await expect(c.run(transport)).rejects.toThrow('operator-repair');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([undefined, 1024])('reserves the default or preregistered overhead %s and halts at one excess input token', async overhead => {
    const c = await setup(2);
    if (overhead === undefined) delete c.bundle.preregistration.providerOverheadTokens;
    else c.bundle.preregistration.providerOverheadTokens = overhead;
    c.bundle.approval.priceBound.inputUsdPerMTok = 10;
    let reservationBytes = '', bound = 0;
    const path = join(c.root, 'research/qualification/heldout/spend-counter.jsonl');
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bound = Buffer.byteLength(String(init?.body), 'utf8') + (overhead ?? 512);
      const attempt = (await readHeldoutJournal(c.runDir)).at(-1)!.attempt;
      expect(attempt.reservedUsdMicros).toBe(bound * 10);
      reservationBytes = await readFile(path, 'utf8');
      return reply(init, { usage: { input_tokens: bound + 1, output_tokens: 0 } });
    });
    expect(await c.run(transport)).toMatchObject({ reason: 'usage-bound', completedRows: 0 });
    expect(transport).toHaveBeenCalledOnce();
    const bytes = await readFile(path, 'utf8');
    expect(bytes.startsWith(reservationBytes)).toBe(true);
    const events = bytes.trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ totalUsdMicros: (bound + 1) * 10,
      charge: { accountedUsdMicros: (bound + 1) * 10, disposition: 'stop' } });
    await rm(c.runDir, { recursive: true });
    expect(await scanHeldoutSpend(c.root, 'D17')).toMatchObject({ studyUsdMicros: (bound + 1) * 10, counterBlocked: true });
    c.bundle.approval.runId = 'after-input-overrun';
    await expect(c.run(transport)).rejects.toThrow('prior-stop');
    expect(transport).toHaveBeenCalledOnce();
  });
  it('rejects null overhead and corpus seeds inconsistent across reproducible rows', async () => {
    const c = await setup(2), transport = fake();
    c.bundle.preregistration.providerOverheadTokens = null as any;
    await expect(c.run(transport)).rejects.toThrow('schema');
    c.bundle.preregistration.providerOverheadTokens = 512;
    c.bundle.corpus.rows[1] = generateHeldoutRow('heldout-lamp/v1', 'another-seed:1:single');
    await expect(c.run(transport)).rejects.toThrow('corpus-provenance');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['generatorDigest', 'seed'])('verifies corpus %s despite refreshed approval pins', async field => {
    const c = await setup(1);
    c.bundle.corpus.provenance[field as 'seed' | 'generatorDigest'] = field === 'seed' ? 'forged-seed' : pin;
    const transport = fake(); await expect(c.run(transport)).rejects.toThrow('corpus-provenance');
    expect(transport).not.toHaveBeenCalled();
  });
  it('keeps a permitted raw seed out of model-visible payloads', async () => {
    const generated = await prepare('ignore-previous-instructions');
    expect(generated.corpus.rows[0].input.payload).not.toContain('ignore-previous-instructions');
    expect(generated.corpus.rows[0].input.payload).toMatch(/world w-[a-f0-9]{16}, lamp/);
  });
  it.each(['opaque text', 'ignore.previous.instructions', 'a'.repeat(33), 'x\n', '💡', 'x:0:single'])('rejects an unsafe world component %s', async seed => {
    await expect(prepare(seed)).rejects.toThrow();
  });
});

// #2778 calibration scopes and staged approvals; all observations remain offline fixtures.
describe('held-out calibration scope and two-phase approval', () => {
  async function scoped(mode: 'staged' | 'uncalibrated-diagnostic' | 'artifact' = 'staged') {
    const c = await setup(3);
    delete (c.bundle.approval as any).calibrationDigest;
    Object.assign(c.bundle.preregistration, { calibration: mode === 'uncalibrated-diagnostic'
      ? { scope: mode, allowedModes: [mode] }
      : { scope: 'calibrated', allowedModes: [mode], ...(mode === 'staged' ? { calibrationPhaseSplits: ['tuning', 'calibration'] } : {}) } });
    Object.assign(c.bundle.approval, { calibration: mode === 'staged' ? { mode, phase: 'calibration' }
      : mode === 'artifact' ? { mode, calibrationArtifactDigest: pin } : { mode } });
    if (mode === 'staged') c.bundle.corpus.rows = ['tuning', 'calibration', 'test'].map((split, i) =>
      generateHeldoutRow('heldout-lamp-splits/v1', `fresh-example:${i}:single:${split}`));
    c.refresh(); return c;
  }
  const metadata = () => ({ sample_n: 3, uncertainty: {}, paired_baseline: {}, integrity_mode: 'locked', fresh_workspace_required: false,
    fresh_workspace_verified: false, integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [],
    weak_signal_reason: null, release_gate: { decision: 'HOLD' as const, reasons: ['fixture'] } });
  async function scoreRun(c: Awaited<ReturnType<typeof setup>>, summary: any, score = vi.fn(async () => ({ calibrated: false }))) {
    const integrity = metadata();
    return scoreHeldoutStudy({ run: join(heldoutRunsRoot(c.root), c.bundle.approval.runId), trustedEvidenceDigest: summary.evidenceDigest,
      trustedApprovalDigest: heldoutDigest(c.bundle.approval), module: { prepare, score } as HeldoutStudyModule,
      moduleDigest: c.bundle.preregistration.scorerDigest, gold: c.gold, integrity, trustedIntegrityDigest: heldoutDigest(integrity) });
  }
  async function testApproval(c: Awaited<ReturnType<typeof setup>>, summary: any) {
    const priorApprovalDigest = heldoutDigest(c.bundle.approval);
    c.bundle.approval.runId = 'test-phase';
    Object.assign(c.bundle.approval, { calibration: { mode: 'staged', phase: 'test', calibrationArtifactDigest: pin,
      calibrationPhaseRecordDigest: summary.calibrationPhaseRecordDigest, priorApprovalDigest } });
    await c.clock.sleep(1); c.refresh();
  }
  it.each(['staged', 'artifact', 'uncalibrated-diagnostic'] as const)('review P1 %s retains each exhausted threshold through resumes and run deletion', async mode => {
    for (const budget of ['usd', 'calls', 'tokens'] as const) for (const removeRuns of [true, false]) {
      const c = await scoped(mode); c.bundle.preregistration.providerFailurePolicy.maxRetries = 0;
      if (budget === 'usd') c.bundle.approval.priceBound.perRequestUsd = 0.6;
      if (budget === 'calls') c.bundle.approval.budget.calls = 2;
      if (budget === 'tokens') c.bundle.approval.budget.tokens = 1600;
      const originalBudget = structuredClone(c.bundle.approval.budget);
      expect(await c.run(fake())).toMatchObject({ reason: 'budget-exhausted', completedRows: 1 });
      const before = await scanHeldoutSpend(c.root, 'D17');
      expect(before.studyCalls).toBe(1);
      if (removeRuns) await rm(heldoutRunsRoot(c.root), { recursive: true });
      c.bundle.approval.runId = 'unchanged-resume'; c.host.resolveCredential.mockClear(); const transport = fake();
      expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', reservedUsdMicros: 0 });
      expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
      if (removeRuns) await rm(heldoutRunsRoot(c.root), { recursive: true });
      c.bundle.approval.runId = 'larger-approval'; c.bundle.approval.budget[budget] *= 2;
      if (removeRuns) c.bundle.corpus.definitions[0].spec.question = 'Is this lamp on?';
      await expect(c.run(transport)).rejects.toThrow('budget-changed');
      await expect(scanHeldoutSpend(c.root, 'D17', c.bundle.approval)).rejects.toThrow('budget-changed');
      expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
      expect(await scanHeldoutSpend(c.root, 'D17')).toMatchObject({ studyCalls: before.studyCalls,
        studyReservedTokens: before.studyReservedTokens, studyUsdMicros: before.studyUsdMicros });
      const baseline = JSON.parse(await readFile(join(c.root, 'research/qualification/heldout/baselines/D17.json'), 'utf8'));
      expect(baseline.budget).toEqual(originalBudget);
    }
  });
  it('review P1 refuses missing or malformed durable thresholds after deleting run evidence', async () => {
    for (const budget of [undefined, null, { calls: 2, tokens: 1600, usd: null }, { calls: 2, tokens: 1600, usd: 1, extra: true }]) {
      const c = await scoped(); await c.run(fake());
      const path = join(c.root, 'research/qualification/heldout/baselines/D17.json');
      const baseline = JSON.parse(await readFile(path, 'utf8'));
      baseline.budget = budget; await writeFile(path, JSON.stringify(baseline));
      await rm(heldoutRunsRoot(c.root), { recursive: true });
      c.bundle.approval.runId = 'missing-thresholds'; c.host.resolveCredential.mockClear(); const transport = fake();
      await expect(c.run(transport)).rejects.toThrow('schema');
      expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
    }
  });
  it.each(['uncalibrated-diagnostic', 'staged'] as const)('review P2 rejects a structured PROMOTE from a %s scorer', async mode => {
    const c = await scoped(mode), summary = await c.run(fake());
    await expect(scoreRun(c, summary, vi.fn(async () => ({ calibrated: false, decision: 'PROMOTE' })))).rejects.toThrow('uncalibrated-report');
  });
  it('AC1/3 explicitly binds diagnostic scoring and refuses calibrated claims or an unregistered scope', async () => {
    const c = await scoped('uncalibrated-diagnostic'); const summary = await c.run(fake());
    const score = vi.fn(async () => ({ calibrated: false, decision: 'HOLD' }));
    expect(await scoreRun(c, summary, score)).toMatchObject({ calibrated: false, d09Qualified: false, calibratedGate: false,
      approvedCalibration: { mode: 'uncalibrated-diagnostic' }, decision: 'HOLD' });
    expect(score.mock.calls[0][0]).toMatchObject({ calibrated: false, approvedCalibration: { mode: 'uncalibrated-diagnostic' } });
    for (const diagnostic of [{}, { calibrated: false, decision: 'PROMOTE' }, { calibrated: true }, { calibrated: false, d09Qualified: true }, { calibrated: false, calibratedGate: true },
      { calibrated: false, d09Qualified: 'qualified' }, { calibrated: false, calibratedGate: null }]) {
      await expect(scoreRun(c, summary, vi.fn(async () => diagnostic) as any)).rejects.toThrow('uncalibrated-report');
    }
    Object.assign(c.bundle.preregistration, { calibration: { scope: 'calibrated', allowedModes: ['artifact'] } }); c.refresh();
    await expect(c.run(fake())).rejects.toThrow('calibration-scope');
  });
  it('AC1 closes each calibration variant and refuses bare, null and mixed bindings', async () => {
    const c = await scoped('artifact');
    expect(() => validateHeldoutBundle(c.bundle, heldoutDigest(c.bundle.approval))).not.toThrow();
    for (const calibration of [null, {}, { mode: 'artifact', calibrationArtifactDigest: null },
      { mode: 'artifact', calibrationArtifactDigest: pin, phase: 'test' }, { mode: 'staged', phase: 'test' },
      { mode: 'uncalibrated-diagnostic', calibrationArtifactDigest: pin }]) {
      const bad = structuredClone(c.bundle); Object.assign(bad.approval, { calibration });
      expect(() => validateHeldoutBundle(bad, heldoutDigest(bad.approval))).toThrow();
    }
    const bad = structuredClone(c.bundle); delete (bad.approval as any).calibration; Object.assign(bad.approval, { calibrationDigest: pin });
    expect(() => validateHeldoutBundle(bad, heldoutDigest(bad.approval))).toThrow();
  });
  it('AC1/3/5 a known fixture artifact digest remains an unvalidated binding, including at the scorer', async () => {
    const c = await scoped('artifact');
    const fixture = JSON.parse(await readFile(resolve('docs/decision/evidence/calibration-qualification-v1/calibration-artifact.json'), 'utf8'));
    Object.assign(c.bundle.approval, { calibration: { mode: 'artifact', calibrationArtifactDigest: heldoutDigest(fixture) } });
    const summary = await c.run(fake()), score = vi.fn(async () => ({ calibrated: false }));
    const report = await scoreRun(c, summary, score);
    expect(score.mock.calls[0][0].approvedCalibration).toEqual((c.bundle.approval as any).calibration);
    expect(report).toMatchObject({ calibrated: null, d09Qualified: false, calibratedGate: false, calibrationArtifactValidation: 'not-performed' });
  });
  it('AC1/2 dry-run estimates only declared phase rows and forbids test requests in calibration', async () => {
    const c = await scoped();
    const estimate = await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval));
    expect(estimate).toMatchObject({ calibration: { mode: 'staged', phase: 'calibration' }, rowsInScope: ['row_0', 'row_1'],
      maximumAttempts: 4, reservedUsdMicros: 304, fitsBeforeStop: true, providerCalls: 0 });
    const bin = join(c.root, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'aiwg'), '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify({ artifact_root: c.root })) + ');\n', { mode: 0o700 });
    await writeFile(join(bin, 'git'), '#!/usr/bin/env node\nif (process.argv[2] === "rev-parse") process.stdout.write("a".repeat(40)); else if (process.argv[2] !== "status") process.exit(2);\n', { mode: 0o700 });
    const path = join(c.root, 'bundle.json'); await writeFile(path, JSON.stringify(c.bundle));
    const dry = spawnSync(process.execPath, [resolve('tools/decision/heldout-study.mjs'), '--dry-run', path, heldoutDigest(c.bundle.approval), c.root],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
    expect(dry.status, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ calibration: { mode: 'staged', phase: 'calibration' }, rowsInScope: ['row_0', 'row_1'],
      reservedUsdMicros: 304, allowance: { usdMicros: 800000 }, ready: true, providerCalls: 0 });
    const { heldoutRequest } = await import('../../../src/decision/heldout/contract.js');
    const row = c.bundle.corpus.rows[2];
    await expect(heldoutRequest(c.bundle.corpus, c.bundle.preregistration, c.bundle.approval, row, row.requests[0])).rejects.toThrow('calibration-phase-row');
    const example = await prepareStaged('split-example');
    expect(() => validateHeldoutInputs(example.corpus, example.preregistration)).not.toThrow();
    expect(example.corpus.rows.map((r: any) => r.split)).toEqual(['tuning', 'calibration', 'test']);
    (c.bundle.preregistration as any).calibration.calibrationPhaseSplits = ['calibration']; c.refresh();
    expect(await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval))).toMatchObject({ rowsInScope: ['row_1'], maximumAttempts: 2 });
    const transport = fake(); expect(await c.run(transport)).toMatchObject({ completedRows: 1 }); expect(transport).toHaveBeenCalledOnce();
    (c.bundle.preregistration as any).calibration.calibrationPhaseSplits = ['test']; c.refresh();
    await expect(c.run(fake())).rejects.toThrow('schema');
  });
  it.each(['D17', 'D29'] as const)('AC1/3 %s seals calibration lineage and accesses only test rows after a matching approval and seal', async study => {
    const c = await scoped(), transport = fake();
    c.bundle.corpus.study = study; c.bundle.preregistration.study = study; c.bundle.approval.study = study;
    const first: any = await c.run(transport);
    expect(first).toMatchObject({ status: 'complete', completedRows: 2, missingRows: [] });
    expect(transport).toHaveBeenCalledTimes(2);
    const seal = JSON.parse(await readFile(join(c.runDir, 'calibration-phase.json'), 'utf8'));
    expect(first.calibrationPhaseRecordDigest).toBe(heldoutDigest(seal));
    expect(seal).toMatchObject({ schemaVersion: 'decision-heldout-calibration-phase/v1', approvalDigest: heldoutDigest(c.bundle.approval),
      rowIds: ['row_0', 'row_1'], corpusDigest: c.bundle.approval.corpusDigest, preregistrationDigest: c.bundle.approval.preregistrationDigest });
    expect(seal.lineageDigest).toBe(heldoutDigest([{ runId: 'offline-01', events: await readHeldoutJournal(c.runDir) }]));
    const calibrationScore = vi.fn(async () => ({ calibrated: false }));
    await scoreRun(c, first, calibrationScore);
    expect(calibrationScore.mock.calls[0][0].corpus.rows.map((r: any) => r.split)).toEqual(['tuning', 'calibration']);
    await testApproval(c, first);
    expect(await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval))).toMatchObject({ rowsInScope: ['row_2'], maximumAttempts: 2, reservedUsdMicros: 152 });
    const second: any = await c.run(transport); expect(second).toMatchObject({ completedRows: 1, reservedUsdMicros: 76 });
    expect(transport).toHaveBeenCalledTimes(3);
    const run = join(heldoutRunsRoot(c.root), 'test-phase'), frozen = JSON.parse(await readFile(join(run, 'frozen.json'), 'utf8'));
    expect(Date.parse(frozen.testPhaseAccessAt)).toBeGreaterThan(Date.parse(seal.sealedAt));
    expect((await readHeldoutJournal(run)).map(e => e.attempt.rowId)).toEqual(['row_2', 'row_2']);
    const score = vi.fn(async () => ({ calibrated: false }));
    expect(await scoreRun(c, second, score)).toMatchObject({ complete: true, decision: 'HOLD' });
    expect(score.mock.calls[0][0].approvedCalibration).toEqual((c.bundle.approval as any).calibration);
    expect(score.mock.calls[0][0].attempts.map((a: any) => a.rowId)).toEqual(['row_2']);
    expect((await scanHeldoutSpend(c.root, study)).studyUsdMicros).toBe(228);
  });
  it.each(['missing-seal', 'seal-pin', 'prior-approval', 'changed-seal', 'same-time', 'budget-change', 'corpus-change', 'preregistration-change'])('AC1/5 refuses test access for %s before credentials', async change => {
    const c = await scoped(); const summary: any = await c.run(fake());
    const sealedAt = JSON.parse(await readFile(join(c.runDir, 'calibration-phase.json'), 'utf8')).sealedAt;
    await testApproval(c, summary);
    if (change === 'missing-seal') await rm(join(c.runDir, 'calibration-phase.json'));
    if (change === 'seal-pin') (c.bundle.approval as any).calibration.calibrationPhaseRecordDigest = pin;
    if (change === 'prior-approval') (c.bundle.approval as any).calibration.priorApprovalDigest = pin;
    if (change === 'budget-change') c.bundle.approval.budget.usd = 2;
    if (change === 'corpus-change') c.bundle.corpus.definitions[0].spec.question = 'Is this lamp on?';
    if (change === 'preregistration-change') c.bundle.preregistration.studyAnalysisDigest = pin;
    if (change === 'changed-seal') {
      const path = join(c.runDir, 'calibration-phase.json'), seal = JSON.parse(await readFile(path, 'utf8'));
      seal.lineageDigest = pin; await writeFile(path, JSON.stringify(seal));
      (c.bundle.approval as any).calibration.calibrationPhaseRecordDigest = heldoutDigest(seal);
    }
    c.host.resolveCredential.mockClear(); const transport = fake();
    await expect(c.run(transport, change === 'same-time' ? { now: () => Date.parse(sealedAt) } : {})).rejects.toThrow(change === 'preregistration-change'
      ? 'changed-preregistration' : change === 'budget-change' ? 'budget-changed' : 'calibration-phase');
    expect(transport).not.toHaveBeenCalled(); expect(c.host.resolveCredential).not.toHaveBeenCalled();
  });
  it('AC1/5 does not seal a checkpoint or a skipped slice and seals terminal measurement failures on resume', async () => {
    const c = await scoped(); c.bundle.preregistration.sessionLimitMs = 5000;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { await c.clock.sleep(1); return reply(init); });
    expect(await c.run(transport)).toMatchObject({ status: 'checkpoint', calibrationPhaseRecordDigest: null });
    expect(await readdir(c.runDir)).not.toContain('calibration-phase.json');
    c.bundle.approval.runId = 'calibration-resume';
    const summary: any = await c.run(vi.fn(async () => new Response('{}', { status: 503 })));
    expect(summary).toMatchObject({ status: 'complete', measurementFailures: ['row_1'] });
    expect(summary.calibrationPhaseRecordDigest).toMatch(/^sha256:/);
    const seal = JSON.parse(await readFile(join(heldoutRunsRoot(c.root), 'calibration-resume/calibration-phase.json'), 'utf8'));
    expect(seal.lineage.map((r: any) => r.runId)).toEqual(['offline-01', 'calibration-resume']);
    await testApproval(c, summary); expect(await c.run(fake())).toMatchObject({ completedRows: 1 });
    const blocked = await scoped();
    blocked.bundle.corpus.rows[1] = generateHeldoutRow('heldout-lamp-splits/v1', 'fresh-example:1:single:tuning');
    const incomplete: any = await blocked.run(vi.fn(async () => new Response('{}', { status: 503 })));
    expect(incomplete).toMatchObject({ calibrationPhaseRecordDigest: null, missingRows: ['row_0', 'row_1'] });
  });
  it.each(['usd', 'calls', 'tokens'])('AC2 retains the global %s stop threshold across phase approvals', async budget => {
    const c = await scoped(); c.bundle.preregistration.providerFailurePolicy.maxRetries = 0;
    if (budget === 'usd') { c.bundle.approval.budget.usd = 1; c.bundle.approval.priceBound.perRequestUsd = 0.3; }
    if (budget === 'calls') c.bundle.approval.budget.calls = 3;
    if (budget === 'tokens') c.bundle.approval.budget.tokens = 3000;
    const first: any = await c.run(fake()); expect(first.completedRows).toBe(2);
    const spent = (await scanHeldoutSpend(c.root, 'D17')).studyUsdMicros;
    await testApproval(c, first); const transport = fake();
    expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', reservedUsdMicros: 0, completedRows: 0 });
    expect(transport).not.toHaveBeenCalled(); expect((await scanHeldoutSpend(c.root, 'D17')).studyUsdMicros).toBe(spent);
  });
  it.each(['calls', 'tokens'])('AC2 deletion of test run evidence cannot restore the %s allowance', async budget => {
    const c = await scoped(); c.bundle.preregistration.providerFailurePolicy.maxRetries = 0;
    if (budget === 'calls') c.bundle.approval.budget.calls = 4;
    else c.bundle.approval.budget.tokens = 4000;
    const first: any = await c.run(fake()); await testApproval(c, first);
    expect(await c.run(fake())).toMatchObject({ completedRows: 1 });
    const before = await scanHeldoutSpend(c.root, 'D17');
    await rm(join(heldoutRunsRoot(c.root), 'test-phase'), { recursive: true });
    c.bundle.approval.runId = 'test-resume'; const transport = fake();
    expect(await c.run(transport)).toMatchObject({ reason: 'budget-exhausted', reservedUsdMicros: 0 });
    expect(transport).not.toHaveBeenCalled();
    expect(await scanHeldoutSpend(c.root, 'D17')).toMatchObject({ studyCalls: before.studyCalls,
      studyReservedTokens: before.studyReservedTokens, studyUsdMicros: before.studyUsdMicros });
  });
  it('AC3 scoring rechecks the phase seal and access time before calling the study', async () => {
    const c = await scoped(); const first: any = await c.run(fake()); await testApproval(c, first);
    const second: any = await c.run(fake()), score = vi.fn(async () => ({ calibrated: false }));
    await scoreRun(c, second, score); expect(score).toHaveBeenCalledOnce();
    const { heldoutEvidenceDigest } = await import('../../../src/decision/heldout/journal.js');
    const path = join(heldoutRunsRoot(c.root), 'test-phase/frozen.json');
    const bytes = await readFile(path, 'utf8'), frozen = JSON.parse(bytes);
    frozen.testPhaseAccessAt = '2026-09-30T00:00:00Z'; await writeFile(path, JSON.stringify(frozen));
    const changed = { ...second, evidenceDigest: await heldoutEvidenceDigest(join(heldoutRunsRoot(c.root), 'test-phase'),
      await readHeldoutJournal(join(heldoutRunsRoot(c.root), 'test-phase'))) };
    await expect(scoreRun(c, changed, score)).rejects.toThrow('calibration-phase');
    await writeFile(path, bytes);
    await rm(join(c.runDir, 'calibration-phase.json'));
    await expect(scoreRun(c, second, score)).rejects.toThrow('calibration-phase');
    expect(score).toHaveBeenCalledOnce();
  });
});
