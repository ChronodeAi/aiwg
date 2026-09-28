import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { generateContextLiveCorpus, contextLiveDigest, contextLivePreregistration, validateContextLiveApproval,
  ContextLiveBudget, collectContextLiveCase, runContextLiveCollection, assertContextLiveSource, type ContextLiveApproval, type ContextLiveCorpus } from '../../../src/decision/context-live-qualification.js';
import { CanonicalJsonByteEstimator } from '../../../src/decision/context-plan.js';
const route = vi.hoisted(() => ({ root: '' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (command: string, args: string[], options: unknown) => command === 'aiwg'
    ? JSON.stringify({ artifact_root: route.root, write_ready: true }) : actual.execFileSync(command, args, options as any) };
});
const estimator = new CanonicalJsonByteEstimator();
const profile = { id: 'jev-tv12-unqualified', version: '1.0.0', estimator: { id: estimator.id, version: estimator.version },
  limits: { aggregateTokens: 64000, stateAndLongestQuestionTokens: 32000 }, safetyMarginBps: 1000, requestEnvelopeTokens: 32 };
async function setup(caseId = 'many-short') {
  const generated = await generateContextLiveCorpus(profile);
  const corpus: ContextLiveCorpus = { ...generated, cases: generated.cases.filter(c => c.id === caseId) };
  const approval: ContextLiveApproval = { schemaVersion: 'context-live-approval/v1', approved: true, reviewer: 'offline-reviewer', stagingWorkspace: 'offline-only',
    runId: 'offline-test', sourceCommit: 'a'.repeat(40), exactHeadCi: 'offline-fixture', model: 'jev-pinned-fixture', apiRevision: 'v1', region: 'fixture-region',
    secretServiceReference: 'fixture-secret-ref', credentialResolverDigest: `sha256:${'b'.repeat(64)}`, corpusDigest: contextLiveDigest(corpus), preregistrationDigest: '',
    budget: { requests: 100, tokens: 10_000_000, usd: 100, wallClockMs: 60_000 },
    perRequestBound: { totalTokens: 100_000, usd: 0.1, approvalReference: 'offline-fixture-bound' }, marginRule: { extraReserveBps: 100, maximumMarginBps: 4000 } };
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
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

  it.each([false, true])('runs complete D11 orchestration with explicitly synthetic transport (fail=%s)', async fail => {
    const s = await setup(); s.corpus = await generateContextLiveCorpus(profile);
    s.approval.corpusDigest = contextLiveDigest(s.corpus);
    s.approval.preregistrationDigest = contextLiveDigest(contextLivePreregistration(s.corpus, s.approval.marginRule));
    const root = await mkdtemp(join(tmpdir(), 'tv12-orchestration-'));
    const output = await mkdtemp(join(tmpdir(), 'tv12-artifacts-')); route.root = output;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
      await mkdir(join(root, 'src/decision/adapters'), { recursive: true });
      for (const file of ['context-live-qualification.ts', 'context-plan.ts', 'adapters/jev.ts']) {
        await writeFile(join(root, 'src/decision', file), await readFile(join('src/decision', file)));
      }
      git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic fixture source');
      s.approval.sourceCommit = git('rev-parse', 'HEAD');
      const original = s.fetch.getMockImplementation()!; let requests = 0;
      s.fetch.mockImplementation(async (url, init) => {
        requests++;
        if (fail) return new Response('private-limit-diagnostic', { status: 413, headers: { 'x-request-id': 'failure-id' } });
        const response = await original(url, init);
        return new Response(await response.text(), { headers: { ...Object.fromEntries(response.headers), 'x-request-id': `offline-${requests}` } });
      });
      const summary = await runContextLiveCollection({ approval: s.approval, corpus: s.corpus, sourceRoot: root, artifactRoot: output,
        host: { resolveCredential: s.resolver }, offlineTransport: s.fetch as typeof fetch }) as any;
      expect(summary.source).toBe('synthetic'); expect(summary.qualifiedForEnforcement).toBe(false); expect(summary.collectionSuccess).toBe(!fail);
      const manifest = JSON.parse(await readFile(join(output, s.approval.runId, 'run-manifest.json'), 'utf8'));
      expect(manifest.mode).toBe('offline'); expect(manifest.evidence).toHaveLength(17);
      expect(manifest.evidence.every((item: any) => item.testEvidenceIds.includes('CTX-TV12'))).toBe(true);
      const links = JSON.parse(await readFile(join(output, summary.evidenceManifest), 'utf8')); expect(links.evidence).toHaveLength(17);
      expect(contextLiveDigest(JSON.parse(await readFile(join(output, s.approval.runId, 'corpus.json'), 'utf8')))).toBe(s.approval.corpusDigest);
      if (fail) { expect(requests).toBe(1); expect(summary.collected).toBe(0); expect(manifest.evidence.some((row: any) => row.outcome === 'fail')).toBe(true); }
      else { expect(requests).toBeGreaterThan(13); expect(summary.collected).toBe(requests); }
    } finally { route.root = ''; await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
  });

});
