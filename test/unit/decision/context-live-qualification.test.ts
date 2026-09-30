import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { generateContextLiveCorpus, contextLiveDigest, contextLivePreregistration, validateContextLiveApproval,
  ContextLiveBudget, collectContextLiveCase, runContextLiveCollection, assertContextLiveSource, estimateContextLiveCollection, contextLiveRequestCapacity,
  contextLivePriorSpendUsd, contextLiveRunsRoot, TV12_ISSUE_USD_CAP, type ContextLiveApproval, type ContextLiveCorpus } from '../../../src/decision/context-live-qualification.js';
import { CanonicalJsonByteEstimator } from '../../../src/decision/context-plan.js';
const route = vi.hoisted(() => ({ root: '' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (command: string, args: string[], options: unknown) => command === 'aiwg'
    ? JSON.stringify({ artifact_root: route.root, write_ready: true }) : actual.execFileSync(command, args, { ...(options as object), timeout: 10_000 }) };
});
/*
 * Live-path test double: a JevDecisionAdapter constructed WITHOUT a transport (the live runner's form) gets
 * this fake. With no fake installed it refuses, so no test in this file can reach the network.
 */
const live = vi.hoisted(() => ({ fetch: null as null | typeof fetch }));
vi.mock('../../../src/decision/adapters/jev.js', async original => {
  const actual = await original<typeof import('../../../src/decision/adapters/jev.js')>();
  class LiveDoubleAdapter extends actual.JevDecisionAdapter {
    constructor(options: ConstructorParameters<typeof actual.JevDecisionAdapter>[0] = {}) {
      super(options.fetch ? options : { ...options, fetch: (async (...args: Parameters<typeof fetch>) => {
        if (!live.fetch) throw new Error('network disabled in tests');
        return live.fetch(...args);
      }) as typeof fetch });
    }
  }
  return { ...actual, JevDecisionAdapter: LiveDoubleAdapter };
});
const estimator = new CanonicalJsonByteEstimator();
const profile = { id: 'jev-tv12-unqualified', version: '1.0.0', estimator: { id: estimator.id, version: estimator.version },
  limits: { aggregateTokens: 64000, stateAndLongestQuestionTokens: 32000 }, safetyMarginBps: 1000, requestEnvelopeTokens: 32 };
async function setup(caseId = 'many-short') {
  const generated = await generateContextLiveCorpus(profile);
  const corpus: ContextLiveCorpus = { ...generated, cases: generated.cases.filter(c => c.id === caseId) };
  const approval: ContextLiveApproval = { schemaVersion: 'context-live-approval/v1', approved: true, reviewer: 'offline-reviewer', stagingWorkspace: 'offline-only',
    runId: 'offline-test', sourceCommit: 'a'.repeat(40), exactHeadCi: 'offline-fixture', model: 'jev-pinned-fixture', apiRevision: 'v1', region: 'fixture-region',
    secretServiceReference: 'openbao-approle.fixture-jev-reader.typesafe-jev', credentialResolverDigest: `sha256:${'b'.repeat(64)}`, corpusDigest: contextLiveDigest(corpus), preregistrationDigest: '',
    budget: { requests: 100, tokens: 10_000_000, usd: 2, wallClockMs: 60_000 },
    perRequestBound: { totalTokens: 100_000, usd: 0.01, approvalReference: 'offline-fixture-bound' }, marginRule: { extraReserveBps: 100, maximumMarginBps: 1000 } };
  approval.preregistrationDigest = contextLiveDigest(contextLivePreregistration(corpus, approval.marginRule));
  const resolver = vi.fn(async () => new TextEncoder().encode('fixture-secret'));
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ model: approval.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id,
      q.type === 'choice' ? { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((key, i) => [key, i ? 0 : 1])) }
        : { type: 'score', score: 0, confidence: 1, probabilities: Object.fromEntries(q.criteria.map((_: unknown, i: number) => [String(i), i ? 0 : 1])), legend: Object.fromEntries(q.criteria.map((v: unknown, i: number) => [String(i), v])) }])), usage: { input_tokens: 1200, output_tokens: 24 } }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'offline-request-1' } });
  });
  return { corpus, approval, resolver, fetch, budget: new ContextLiveBudget(approval, Date.now()) };
}
describe('TV-12 live collector offline guards (not qualification evidence)', () => {
  it('generates immutable compiled boundary corpus covering required shapes', async () => {
    const corpus = await generateContextLiveCorpus(profile);
    expect(corpus.cases).toHaveLength(17);
    expect(contextLiveDigest(corpus)).toBe(contextLiveDigest(await generateContextLiveCorpus(profile)));
    expect(corpus.cases.find(c => c.id === 'choice-255')!.definitions[0]!.spec.answer).toMatchObject({ options: expect.any(Array) });
  });
  it('rejects incomplete approval and altered preregistration', async () => {
    const { corpus, approval } = await setup();
    expect(() => validateContextLiveApproval({ ...approval, approved: false } as any, corpus)).toThrow();
    expect(() => validateContextLiveApproval({ ...approval, corpusDigest: 'altered' }, corpus)).toThrow();
    expect(() => validateContextLiveApproval({ ...approval, marginRule: { ...approval.marginRule, extraReserveBps: 200 } }, corpus)).toThrow();
  });
  it.each([500, 2.01])('hard-caps every approval at the USD 2.00 issue limit (usd=%s)', async usd => {
    const { corpus, approval } = await setup();
    expect(TV12_ISSUE_USD_CAP).toBe(2);
    expect(() => validateContextLiveApproval({ ...approval, budget: { ...approval.budget, usd } }, corpus)).toThrow();
    expect(() => validateContextLiveApproval({ ...approval, budget: { ...approval.budget, usd: 2 } }, corpus)).not.toThrow();
  });
  it('rejects a collection margin below the preregistered maximum before any spend', async () => {
    const { corpus, approval } = await setup();
    const marginRule = { extraReserveBps: 100, maximumMarginBps: 1500 };
    const widened = { ...approval, marginRule, preregistrationDigest: contextLiveDigest(contextLivePreregistration(corpus, marginRule)) };
    expect(() => validateContextLiveApproval(widened, corpus)).toThrow();
  });
  it('rejects a secret-service reference that a DecisionBinding credentialRef would refuse', async () => {
    const { corpus, approval } = await setup();
    expect(() => validateContextLiveApproval({ ...approval, secretServiceReference: 'openbao-approle:aiwg-jev-reader/typesafe/jev' }, corpus)).toThrow();
  });
  it('dry-run runs the same pre-dispatch request validation as collection', async () => {
    // 101 short questions plan into one request but exceed the binding's 100-attempt limit, a check that
    // only runs when the request is built just before admission and dispatch.
    const s = await setup('many-short');
    const definitions = s.corpus.cases[0]!.definitions;
    while (definitions.length < 101) {
      const copy = structuredClone(definitions[0]!); copy.metadata.id = `short-extra-${definitions.length}`; definitions.push(copy);
    }
    s.approval.corpusDigest = contextLiveDigest(s.corpus);
    s.approval.preregistrationDigest = contextLiveDigest(contextLivePreregistration(s.corpus, s.approval.marginRule));
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch)).rejects.toThrow('maxAttempts');
    await expect(estimateContextLiveCollection(s.approval, s.corpus)).rejects.toThrow('maxAttempts');
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.resolver).not.toHaveBeenCalled();
  });
  it('denies budget before credentials or transport', async () => {
    const s = await setup(); s.approval.budget.requests = 1;
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch)).rejects.toThrow('budget');
    expect(s.resolver).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
  it('rejects oversize before credentials or transport', async () => {
    const s = await setup('longest-effective-2');
    const result = await collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch);
    expect(result.rejected).toBe(true); expect(s.resolver).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled(); expect(s.budget.requests).toBe(0);
  });
  it('uses native shared usage once and never labels fake transport live', async () => {
    const s = await setup();
    const result = await collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch);
    expect(result.synthetic).toBe(true); expect(result.records).toHaveLength(1); expect(s.resolver).toHaveBeenCalledTimes(1); expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(result.records[0]).toMatchObject({ actualInputTokens: 1200, outputTokens: 24, costUsd: null, requestId: 'offline-request-1' });
    expect(JSON.stringify(result.records)).not.toContain('fixture-secret'); expect(JSON.stringify(result.records)).not.toContain('Assess');
    const wire = JSON.parse(s.fetch.mock.calls[0]![1].body as string); expect(wire.state).toHaveProperty('untrusted'); expect(Object.keys(wire.questions)).toHaveLength(24);
    expect(result.records[0]!.wireDigest).toBe(contextLiveDigest(wire));
    expect(result.records[0]!.wireBytes).toBe(Buffer.byteLength(s.fetch.mock.calls[0]![1].body as string));
    expect(result.records[0]!.estimatedInputTokens).toBe(estimator.estimate(wire.state).tokens
      + Object.values(wire.questions).reduce<number>((sum, question) => sum + estimator.estimate(question as any).tokens, 0) + profile.requestEnvelopeTokens);
  });
  it('stops on first 4xx without retry', async () => {
    const s = await setup(); s.fetch.mockImplementation(async () => new Response('sensitive provider text', { status: 413 }));
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch)).rejects.toThrow('identity or outcome');
    expect(s.fetch).toHaveBeenCalledTimes(1); expect(s.budget.requests).toBe(1);
  });
  it('fails on missing identity and usage bounds', async () => {
    const s = await setup(); s.approval.perRequestBound.totalTokens = 1000;
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, AbortSignal.abort(), s.fetch as typeof fetch)).rejects.toThrow();
    expect(s.resolver).not.toHaveBeenCalled();
  });
  it('replans split groups and keeps each request usage with its own estimate', async () => {
    const s = await setup('aggregate-effective-2');
    let ordinal = 0;
    const original = s.fetch.getMockImplementation()!;
    s.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init); const body = await response.json();
      body.usage.input_tokens = ++ordinal * 100;
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'x-request-id': `partition-${ordinal}` } });
    });
    const retained: unknown[] = [];
    const result = await collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval,
      { resolveCredential: s.resolver, record: async row => { retained.push(row); } }, s.budget, new AbortController().signal, s.fetch as typeof fetch);
    expect(result.records).toHaveLength(2); expect(retained).toHaveLength(2); expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(result.records.map(r => r.actualInputTokens)).toEqual([100, 200]);
    expect(result.records[0]!.estimatedInputTokens).toBeGreaterThan(result.records[1]!.estimatedInputTokens);
    expect(result.records[0]!.planDigest).not.toBe(result.records[1]!.planDigest);
    expect(s.budget.requests).toBe(2);
  });
  it('stops on missing request identity without exposing provider text', async () => {
    const s = await setup(); const original = s.fetch.getMockImplementation()!;
    s.fetch.mockImplementation(async (url, init) => new Response(await (await original(url, init)).text(), { headers: { 'content-type': 'application/json' } }));
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch)).rejects.toThrow('identity');
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
  it('retains first partition before a later partition fails', async () => {
    const s = await setup('aggregate-effective-2'); const original = s.fetch.getMockImplementation()!;
    let calls = 0; s.fetch.mockImplementation(async (url, init) => ++calls === 1 ? original(url, init) : new Response('private', { status: 429 }));
    const records: unknown[] = [];
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver, record: async row => { records.push(row); } }, s.budget, new AbortController().signal, s.fetch as typeof fetch)).rejects.toThrow();
    expect(records).toHaveLength(1); expect(calls).toBe(2);
  });

  it.each(['model', 'input_tokens', 'output_tokens'])('stops on missing authoritative %s', async field => {
    const s = await setup(); const original = s.fetch.getMockImplementation()!;
    s.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init); const body = await response.json();
      if (field === 'model') body.model = 'unexpected-model'; else delete body.usage[field];
      return new Response(JSON.stringify(body), { headers: response.headers });
    });
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch)).rejects.toThrow();
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels an unresolved credential at the wall-clock signal without dispatch', async () => {
    const s = await setup(); s.resolver.mockImplementation(() => new Promise(() => {}));
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, AbortSignal.timeout(30), s.fetch as typeof fetch)).rejects.toThrow();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('cannot use the offline seam as a live transport entry point', async () => {
    const s = await setup();
    await expect(collectContextLiveCase(s.corpus.cases[0]!, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal)).rejects.toThrow('source-verified');
    expect(s.resolver).not.toHaveBeenCalled();
  });
  it('requires exact clean source including untracked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tv12-source-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    try {
      git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
      const head = git('rev-parse', 'HEAD'); await expect(assertContextLiveSource(root, head)).resolves.toBeUndefined();
      await expect(assertContextLiveSource(root, 'a'.repeat(40))).rejects.toThrow('clean exact');
      await writeFile(join(root, 'untracked'), 'fixture'); await expect(assertContextLiveSource(root, head)).rejects.toThrow('clean exact');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['tokens', 'usd', 'time'])('reserves and stops at eighty percent of %s ceiling', async dimension => {
    const s = await setup();
    if (dimension === 'tokens') s.approval.budget.tokens = s.approval.perRequestBound.totalTokens;
    if (dimension === 'usd') s.approval.budget.usd = s.approval.perRequestBound.usd;
    const budget = new ContextLiveBudget(s.approval, 1000, () => dimension === 'time' ? 1000 + s.approval.budget.wallClockMs : 1000);
    expect(() => budget.reserve()).toThrow('budget'); expect(budget.requests).toBe(0);
  });

  it('dry-run estimate matches the partitions collection dispatches, without credentials or transport', async () => {
    const s = await setup(); s.corpus = await generateContextLiveCorpus(profile);
    s.approval.corpusDigest = contextLiveDigest(s.corpus);
    s.approval.preregistrationDigest = contextLiveDigest(contextLivePreregistration(s.corpus, s.approval.marginRule));
    const estimate = await estimateContextLiveCollection(s.approval, s.corpus);
    expect(s.resolver).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
    for (const item of s.corpus.cases) {
      const collected = await collectContextLiveCase(item, s.corpus, s.approval, { resolveCredential: s.resolver }, s.budget, new AbortController().signal, s.fetch as typeof fetch);
      const planned = estimate.cases.find(c => c.id === item.id)!;
      expect(planned.rejectedBeforeDispatch).toBe(collected.rejected);
      expect(collected.records.map(r => [r.partitionId, r.estimatedInputTokens])).toEqual(planned.partitions.map(p => [p.id, p.estimatedInputTokens]));
    }
    expect(s.fetch).toHaveBeenCalledTimes(estimate.requests);
    expect(estimate.reserved).toMatchObject({ requests: estimate.requests, tokens: estimate.requests * 100_000 });
    expect(estimate.reserved.usd).toBeCloseTo(estimate.requests * 0.01, 9);
    expect(estimate.fitsBeforeStop).toBe(true);
    s.approval.budget.requests = Math.ceil(estimate.requests / 0.8) - 1;
    expect((await estimateContextLiveCollection(s.approval, s.corpus)).fitsBeforeStop).toBe(false);
  });
  it.each([7, 10, 35, 125])('request capacity equals what the 80%% budget guard admits (requests=%i)', requests => {
    const approval = { budget: { requests, tokens: 10_000_000, usd: 3, wallClockMs: 60_000 }, perRequestBound: { totalTokens: 100_000, usd: 0.03, approvalReference: 'x' } };
    const budget = new ContextLiveBudget(approval, 0, () => 0);
    let admitted = 0;
    try { for (;;) { budget.reserve(); admitted++; } } catch { /* stop reached */ }
    expect(contextLiveRequestCapacity(approval)).toBe(admitted);
  });
  async function orchestration() {
    const s = await setup(); s.corpus = await generateContextLiveCorpus(profile);
    s.approval.corpusDigest = contextLiveDigest(s.corpus);
    s.approval.preregistrationDigest = contextLiveDigest(contextLivePreregistration(s.corpus, s.approval.marginRule));
    const root = await mkdtemp(join(tmpdir(), 'tv12-orchestration-'));
    const output = await mkdtemp(join(tmpdir(), 'tv12-artifacts-')); route.root = output;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    await mkdir(join(root, 'src/decision/adapters'), { recursive: true });
    for (const file of ['context-live-qualification.ts', 'context-plan.ts', 'adapters/jev.ts']) {
      await writeFile(join(root, 'src/decision', file), await readFile(join('src/decision', file)));
    }
    git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic fixture source');
    s.approval.sourceCommit = git('rev-parse', 'HEAD');
    const runs = contextLiveRunsRoot(output);
    const dispose = vi.fn();
    const run = (artifactRoot = output, transport: 'offline' | 'live' = 'offline') => runContextLiveCollection({ approval: s.approval, corpus: s.corpus, sourceRoot: root, artifactRoot,
      host: { resolveCredential: s.resolver, dispose }, ...(transport === 'offline' ? { offlineTransport: s.fetch as typeof fetch } : {}) }) as Promise<any>;
    const seed = async (runId: string, files: Record<string, unknown>) => {
      await mkdir(join(runs, runId), { recursive: true });
      for (const [name, value] of Object.entries(files)) await writeFile(join(runs, runId, name), JSON.stringify(value));
    };
    return { s, root, output, runs, run, seed, dispose, cleanup: async () => { route.root = ''; await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); } };
  }
  it.each([false, true])('runs complete D11 orchestration with explicitly synthetic transport (fail=%s)', async fail => {
    const o = await orchestration(); const { s, runs } = o;
    try {
      const original = s.fetch.getMockImplementation()!; let requests = 0;
      s.fetch.mockImplementation(async (url, init) => {
        requests++;
        if (fail) return new Response('private-limit-diagnostic', { status: 413, headers: { 'x-request-id': 'failure-id' } });
        const response = await original(url, init);
        return new Response(await response.text(), { headers: { ...Object.fromEntries(response.headers), 'x-request-id': `offline-${requests}` } });
      });
      const summary = await o.run();
      expect(summary.source).toBe('synthetic'); expect(summary.qualifiedForEnforcement).toBe(false); expect(summary.collectionSuccess).toBe(!fail);
      expect(summary.issueSpend).toEqual({ capUsd: 2, priorUsd: 0, runUsdCeiling: 2 });
      expect(o.dispose).toHaveBeenCalledTimes(1);
      const manifest = JSON.parse(await readFile(join(runs, s.approval.runId, 'run-manifest.json'), 'utf8'));
      expect(manifest.mode).toBe('offline'); expect(manifest.evidence).toHaveLength(17);
      expect(manifest.evidence.every((item: any) => item.testEvidenceIds.includes('CTX-TV12'))).toBe(true);
      const links = JSON.parse(await readFile(join(runs, summary.evidenceManifest), 'utf8')); expect(links.evidence).toHaveLength(17);
      expect(contextLiveDigest(JSON.parse(await readFile(join(runs, s.approval.runId, 'corpus.json'), 'utf8')))).toBe(s.approval.corpusDigest);
      if (fail) { expect(requests).toBe(1); expect(summary.collected).toBe(0); expect(manifest.evidence.some((row: any) => row.outcome === 'fail')).toBe(true); }
      else { expect(requests).toBeGreaterThan(13); expect(summary.collected).toBe(requests); }
      // The completed run now counts against the issue cap at its charged reservation.
      expect(await contextLivePriorSpendUsd(runs)).toBeCloseTo(summary.reserved.usd, 9);
    } finally { await o.cleanup(); }
  });
  it('executes provider-path collection and records it through a D11 mode that runs executors', async () => {
    // Regression for the first approved run: D11 "live" mode skips every executor as live-evidence-unavailable,
    // so collection dispatched nothing and the evidence manifest refused the skipped cases.
    const o = await orchestration(); const { s, runs } = o;
    const original = s.fetch.getMockImplementation()!; let requests = 0;
    live.fetch = (async (url: any, init: any) => {
      requests++;
      const response = await original(url, init);
      return new Response(await response.text(), { headers: { ...Object.fromEntries(response.headers), 'x-request-id': `live-double-${requests}` } });
    }) as typeof fetch;
    try {
      const summary = await o.run(o.output, 'live');
      expect(summary).toMatchObject({ source: 'provider', collectionSuccess: true, stopped: false, qualifiedForEnforcement: false });
      // The corpus starts with oversized cases: each is recorded as rejected and collection continues.
      expect(s.corpus.cases[0]!.id).toBe('longest-raw-0');
      expect(summary.rejected).toEqual(['longest-raw-0', 'longest-raw-1', 'longest-raw-2', 'longest-effective-2']);
      expect(requests).toBeGreaterThan(13); expect(summary.collected).toBe(requests); expect(summary.reserved.requests).toBe(requests);
      expect(s.resolver).toHaveBeenCalled(); expect(o.dispose).toHaveBeenCalledTimes(1);
      const manifest = JSON.parse(await readFile(join(runs, s.approval.runId, 'run-manifest.json'), 'utf8'));
      expect(manifest.mode).toBe('recorded');
      expect(manifest.evidence.every((row: any) => row.outcome === 'pass' && !row.error)).toBe(true);
      expect(JSON.parse(await readFile(join(runs, summary.evidenceManifest), 'utf8')).evidence).toHaveLength(17);
    } finally { live.fetch = null; await o.cleanup(); }
  });
  it('requires the canonical artifact root itself, not a subdirectory', async () => {
    const o = await orchestration();
    try {
      await mkdir(join(o.output, 'nested'));
      await expect(o.run(join(o.output, 'nested'))).rejects.toThrow('canonical artifact root');
      expect(o.s.fetch).not.toHaveBeenCalled(); expect(o.s.resolver).not.toHaveBeenCalled();
    } finally { await o.cleanup(); }
  });
  it('counts a crashed prior run at its full approved budget and caps this run at the remainder', async () => {
    const o = await orchestration();
    try {
      // 1.97 prior leaves 0.03, so the 80% stop (0.024) admits two 0.01 reservations.
      await o.seed('crashed-collection', { 'approval.json': { schemaVersion: 'context-live-approval/v1', budget: { usd: 1.5 } } });
      await o.seed('finished-canary', { 'canary-approval.json': { schemaVersion: 'context-canary-approval/v1', plan: { budget: { usd: 2 } } },
        'summary.json': { schemaVersion: 'context-enforce-canary/v1', reserved: { usd: 0.47 } } });
      expect(await contextLivePriorSpendUsd(o.runs)).toBeCloseTo(1.97, 9);
      const summary = await o.run();
      expect(summary.issueSpend).toEqual({ capUsd: 2, priorUsd: 1.97, runUsdCeiling: 0.03 });
      expect(summary.collectionSuccess).toBe(false);
      expect(o.s.fetch).toHaveBeenCalledTimes(2); expect(summary.reserved.usd).toBeCloseTo(0.02, 9);
    } finally { await o.cleanup(); }
  });
  it.each([
    ['an exhausted issue cap', { 'approval.json': { schemaVersion: 'context-live-approval/v1', budget: { usd: 2 } } }],
    ['an unrecognized run directory', { 'usage-x.json': {} }],
    ['an unreadable prior summary', { 'approval.json': { schemaVersion: 'context-live-approval/v1', budget: { usd: 0.1 } }, 'summary.json': { reserved: { usd: 'x' } } }],
  ])('refuses before any write, credential or dispatch given %s', async (_label, files) => {
    const o = await orchestration();
    try {
      await o.seed('prior', files);
      await expect(o.run()).rejects.toThrow();
      expect(o.s.fetch).not.toHaveBeenCalled(); expect(o.s.resolver).not.toHaveBeenCalled();
      await expect(readFile(join(o.runs, o.s.approval.runId, 'approval.json'))).rejects.toThrow();
    } finally { await o.cleanup(); }
  });
  it('refuses a concurrent run holding the spend lock', async () => {
    const o = await orchestration();
    try {
      await mkdir(o.runs, { recursive: true }); await writeFile(join(o.runs, '.tv12-spend.lock'), 'held');
      await expect(o.run()).rejects.toThrow('lock');
      expect(o.s.fetch).not.toHaveBeenCalled();
    } finally { await o.cleanup(); }
  });
});
