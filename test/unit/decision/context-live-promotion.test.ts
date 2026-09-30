import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { generateContextLiveCorpus, contextLiveDigest, contextLivePreregistration, ContextLiveBudget, collectContextLiveCase, contextLiveRunsRoot,
  type ContextLiveApproval, type ContextLiveCorpus, type ContextLiveRecord } from '../../../src/decision/context-live-qualification.js';
import { recordContextQualification, verifyContextQualificationRecord, contextLiveRecordsDigest, runContextEnforceCanary, contextCanaryDispatches,
  validateContextCanaryApproval, type ContextMarginReview, type ContextCanaryApproval, type ContextCanaryPlan } from '../../../src/decision/context-live-promotion.js';
import { assertContextQualified } from '../../../src/decision/context-qualification.js';
import { CanonicalJsonByteEstimator } from '../../../src/decision/context-plan.js';
const route = vi.hoisted(() => ({ root: '' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (command: string, args: string[], options: unknown) => command === 'aiwg'
    ? JSON.stringify({ artifact_root: route.root, write_ready: true }) : actual.execFileSync(command, args, { ...(options as object), timeout: 10_000 }) };
});

/*
 * Offline guard tests only. Records are relabelled `provider` to stand in for reviewed provider
 * evidence (the recorder cannot authenticate a label); nothing here is TV-12 qualification evidence.
 */
const estimator = new CanonicalJsonByteEstimator();
const profile = { id: 'jev-tv12-collection', version: '1.0.0', estimator: { id: estimator.id, version: estimator.version },
  limits: { aggregateTokens: 64000, stateAndLongestQuestionTokens: 32000 }, safetyMarginBps: 3000, requestEnvelopeTokens: 512 };
const marginRule = { extraReserveBps: 500, maximumMarginBps: 3000 };
const MODEL = 'jev-pinned-fixture';
let generated: ContextLiveCorpus | undefined;

/** Fake Jev: reports actual input as `factor` times the planner estimate of the exact wire. */
function transport(factor: number) {
  let calls = 0;
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const estimate = estimator.estimate(body.state).tokens + Object.values(body.questions).reduce<number>((sum, q) => sum + estimator.estimate(q as any).tokens, 0) + profile.requestEnvelopeTokens;
    return new Response(JSON.stringify({ model: MODEL, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id,
      q.type === 'choice' ? { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((key, i) => [key, i ? 0 : 1])) }
        : { type: 'score', score: 0, confidence: 1, probabilities: Object.fromEntries(q.criteria.map((_: unknown, i: number) => [String(i), i ? 0 : 1])), legend: Object.fromEntries(q.criteria.map((v: unknown, i: number) => [String(i), v])) }])),
    usage: { input_tokens: Math.ceil(estimate * factor), output_tokens: 8 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `offline-${++calls}` } });
  });
  return fetch;
}
async function setup(caseIds: string[], factor = 1.1) {
  generated ??= await generateContextLiveCorpus(profile);
  const corpus: ContextLiveCorpus = { ...structuredClone(generated), cases: structuredClone(generated.cases.filter(c => caseIds.includes(c.id))) };
  const approval: ContextLiveApproval = { schemaVersion: 'context-live-approval/v1', approved: true, reviewer: 'offline-reviewer', stagingWorkspace: 'offline-only',
    runId: 'offline-collection', sourceCommit: 'a'.repeat(40), exactHeadCi: 'offline-fixture', model: MODEL, apiRevision: 'v1', region: 'fixture-region',
    secretServiceReference: 'openbao-approle.fixture-jev-reader.typesafe-jev', credentialResolverDigest: `sha256:${'b'.repeat(64)}`, corpusDigest: contextLiveDigest(corpus), preregistrationDigest: '',
    budget: { requests: 200, tokens: 100_000_000, usd: 2, wallClockMs: 600_000 },
    perRequestBound: { totalTokens: 72_000, usd: 0.0072, approvalReference: 'offline-fixture-bound' }, marginRule };
  approval.preregistrationDigest = contextLiveDigest(contextLivePreregistration(corpus, marginRule));
  const fetch = transport(factor);
  const resolver = vi.fn(async () => new TextEncoder().encode('offline-credential-bytes'));
  const records: ContextLiveRecord[] = [];
  const budget = new ContextLiveBudget(approval, Date.now());
  for (const item of corpus.cases) {
    const collected = await collectContextLiveCase(item, corpus, approval, { resolveCredential: resolver }, budget, new AbortController().signal, fetch as typeof globalThis.fetch);
    records.push(...collected.records);
  }
  // Declared-provider stand-in: relabel and re-derive the usage binding exactly as the runner would.
  const declared = records.map(r => {
    const usage = { source: 'provider' as const, servedModel: r.servedModel, requestId: r.requestId, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd };
    const usageArtifactDigest = contextLiveDigest(usage);
    return { ...r, source: 'provider' as const, usageArtifactDigest, usageRef: `usage:${usageArtifactDigest}` };
  });
  const worst = Math.max(...declared.map(r => r.undercountBps));
  const review: ContextMarginReview = { schemaVersion: 'context-margin-review/v1', approved: true, reviewer: 'offline-reviewer', approvalReference: 'offline-review',
    runId: approval.runId, recordsDigest: contextLiveRecordsDigest(declared), selectedMarginBps: worst + marginRule.extraReserveBps,
    qualifiedProfile: { id: 'jev-tv12-qualified', version: '1.0.0' } };
  return { corpus, approval, records, declared, review, worst, fetch };
}

describe('TV-12 profile and margin recording (offline guards, not qualification evidence)', () => {
  it('selects the preregistered margin and records a qualification the enforcement gate accepts', async () => {
    const s = await setup(['many-short', 'unicode-nested', 'longest-raw-2']);
    expect(s.worst).toBeGreaterThan(0);
    const record = await recordContextQualification({ approval: s.approval, corpus: s.corpus, records: s.declared, review: s.review });
    expect(record.selection).toEqual({ worstUndercountBps: s.worst, extraReserveBps: 500, candidateMarginBps: s.worst + 500, maximumMarginBps: 3000 });
    expect(record.profile).toMatchObject({ id: 'jev-tv12-qualified', version: '1.0.0', safetyMarginBps: s.worst + 500 });
    expect(record.qualification.cases).toHaveLength(2);
    // The stored artifact, not the in-memory object, is what enforcement consumes.
    const stored = JSON.parse(JSON.stringify(record));
    expect(() => verifyContextQualificationRecord(stored)).not.toThrow();
    expect(() => assertContextQualified(stored.qualification, stored.profile, estimator)).not.toThrow();
    const bumped = { ...stored.profile, version: '1.0.1' };
    expect(() => verifyContextQualificationRecord(stored, bumped)).toThrow('does not match');
    expect(() => assertContextQualified(stored.qualification, bumped, estimator)).toThrow();
    expect(() => verifyContextQualificationRecord({ ...stored, profile: bumped, review: { ...stored.review, qualifiedProfile: { id: bumped.id, version: bumped.version } } })).toThrow();
  });

  it.each([
    ['a margin other than the rule output', (r: ContextMarginReview) => ({ ...r, selectedMarginBps: r.selectedMarginBps + 1 })],
    ['a lower margin than the rule output', (r: ContextMarginReview) => ({ ...r, selectedMarginBps: r.selectedMarginBps - 1 })],
    ['different records', (r: ContextMarginReview) => ({ ...r, recordsDigest: `sha256:${'c'.repeat(64)}` })],
    ['an unapproved review', (r: ContextMarginReview) => ({ ...r, approved: false as unknown as true })],
    ['the unqualified collection profile identity', (r: ContextMarginReview) => ({ ...r, qualifiedProfile: { id: profile.id, version: profile.version } })],
    ['an unknown field', (r: ContextMarginReview) => ({ ...r, override: true })],
  ])('rejects a review with %s', async (_label, mutate) => {
    const s = await setup(['many-short']);
    await expect(recordContextQualification({ approval: s.approval, corpus: s.corpus, records: s.declared, review: mutate(s.review) as ContextMarginReview })).rejects.toThrow();
  });

  it('refuses to qualify when the observed undercount plus reserve exceeds the frozen maximum', async () => {
    const s = await setup(['many-short'], 1.4);
    expect(s.worst + marginRule.extraReserveBps).toBeGreaterThan(marginRule.maximumMarginBps);
    await expect(recordContextQualification({ approval: s.approval, corpus: s.corpus, records: s.declared, review: s.review })).rejects.toThrow('preregistered maximum');
  });

  it('refuses synthetic, partial, surplus or edited evidence', async () => {
    const s = await setup(['many-short', 'unicode-nested']);
    const attempt = (records: ContextLiveRecord[]) => recordContextQualification({ approval: s.approval, corpus: s.corpus, records,
      review: { ...s.review, recordsDigest: contextLiveRecordsDigest(records) } });
    await expect(attempt(s.records)).rejects.toThrow('bind');
    await expect(attempt(s.declared.slice(1))).rejects.toThrow();
    await expect(attempt([...s.declared, { ...s.declared[0]!, requestId: 'duplicate' }])).rejects.toThrow();
    await expect(attempt([{ ...s.declared[0]!, actualInputTokens: 1, inputTokens: 1 }, ...s.declared.slice(1)])).rejects.toThrow('bind');
    await expect(attempt([{ ...s.declared[0]!, estimatedInputTokens: s.declared[0]!.estimatedInputTokens + 1 }, ...s.declared.slice(1)])).rejects.toThrow('bind');
  });

  it('requires the collection margin to cover the preregistered maximum', async () => {
    const s = await setup(['many-short']);
    s.approval.marginRule = { extraReserveBps: 500, maximumMarginBps: 4000 };
    s.approval.preregistrationDigest = contextLiveDigest(contextLivePreregistration(s.corpus, s.approval.marginRule));
    await expect(recordContextQualification({ approval: s.approval, corpus: s.corpus, records: s.declared, review: s.review })).rejects.toThrow('collection margin');
  });
});

describe('TV-12 enforce canary with rollback (offline guards, not staging evidence)', () => {
  async function canary(caseIds: string[], adjust: (plan: ContextCanaryPlan) => void = () => {}) {
    const s = await setup(caseIds);
    const record = await recordContextQualification({ approval: s.approval, corpus: s.corpus, records: s.declared, review: s.review });
    const plan: ContextCanaryPlan = { schemaVersion: 'context-canary-plan/v1', caseIds, rollback: 'observe-only',
      budget: { requests: 200, tokens: 100_000_000, usd: 2, wallClockMs: 600_000 }, perRequestBound: { totalTokens: 72_000, usd: 0.0072, approvalReference: 'offline-bound' } };
    adjust(plan);
    const approval: ContextCanaryApproval = { schemaVersion: 'context-canary-approval/v1', approved: true, reviewer: 'offline-reviewer', stagingWorkspace: 'offline-only',
      runId: 'offline-canary', sourceCommit: '', exactHeadCi: 'offline-fixture', model: MODEL, apiRevision: 'v1', region: 'fixture-region',
      secretServiceReference: 'openbao-approle.fixture-jev-reader.typesafe-jev', credentialResolverDigest: `sha256:${'b'.repeat(64)}`, corpusDigest: contextLiveDigest(s.corpus),
      qualificationRecordDigest: contextLiveDigest(record), canaryPlanDigest: contextLiveDigest(plan), plan };
    const root = await mkdtemp(join(tmpdir(), 'tv12-canary-src-'));
    const output = await mkdtemp(join(tmpdir(), 'tv12-canary-out-')); route.root = output;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
    approval.sourceCommit = git('rev-parse', 'HEAD');
    const fetch = transport(1.1);
    const dispose = vi.fn();
    const resolver = vi.fn(async () => new TextEncoder().encode('offline-credential-bytes'));
    const cleanup = async () => { route.root = ''; await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); };
    const runs = contextLiveRunsRoot(output);
    return { s, record, approval, root, output, runs, fetch, resolver, dispose, cleanup,
      run: (overrides: Partial<Parameters<typeof runContextEnforceCanary>[0]> = {}) => runContextEnforceCanary({ approval, corpus: s.corpus, record, sourceRoot: root,
        artifactRoot: output, host: { resolveCredential: resolver, dispose }, offlineTransport: fetch as typeof globalThis.fetch, ...overrides }) };
  }

  it('enforces the qualified plan with zero oversized dispatches, then rolls back to single calls', async () => {
    const c = await canary(['aggregate-raw-2', 'longest-raw-2', 'dominant']);
    try {
      const expected = await contextCanaryDispatches(c.approval.plan.caseIds, c.s.corpus, c.record);
      expect(expected).toEqual([{ caseId: 'aggregate-raw-2', enforce: expect.any(Number), rollback: 4 }, { caseId: 'longest-raw-2', enforce: 0, rollback: 0 }, { caseId: 'dominant', enforce: 1, rollback: 2 }]);
      expect(expected[0]!.enforce).toBeGreaterThan(1);
      const summary = await c.run();
      expect(summary).toMatchObject({ source: 'synthetic', canaryPassed: true, stopped: null, oversizedDispatches: 0, rollbackExercised: true, rollbackNativeDispatches: 0, cases: 6 });
      expect(summary.enforceDispatches).toBe(expected[0]!.enforce + 1);
      expect(c.fetch).toHaveBeenCalledTimes(expected.reduce((n, row) => n + row.enforce + row.rollback, 0));
      expect(summary.reserved.requests).toBe(c.fetch.mock.calls.length);
      expect(c.resolver).toHaveBeenCalled(); expect(c.dispose).toHaveBeenCalledTimes(1);
      expect(summary.issueSpend).toEqual({ capUsd: 2, priorUsd: 0, runUsdCeiling: 2 });
      const bodies = c.fetch.mock.calls.map(([, init]) => Object.keys(JSON.parse((init as RequestInit).body as string).questions).length);
      // Enforce splits the four questions across partitions and batches at least one natively; rollback sends singles.
      const enforced = bodies.slice(0, expected[0]!.enforce);
      expect(enforced.reduce((n, q) => n + q, 0)).toBe(4); expect(Math.max(...enforced)).toBeGreaterThan(1);
      expect(bodies.slice(expected[0]!.enforce, expected[0]!.enforce + 4)).toEqual([1, 1, 1, 1]);
      const oversized = JSON.parse(await readFile(join(c.runs, 'offline-canary', 'longest-raw-2-enforce.json'), 'utf8'));
      expect(oversized).toMatchObject({ rejectedBeforeDispatch: true, dispatches: 0, pass: true });
      const rollback = JSON.parse(await readFile(join(c.runs, 'offline-canary', 'aggregate-raw-2-rollback.json'), 'utf8'));
      expect(rollback).toMatchObject({ dispatches: 4, nativeDispatches: 0, pass: true });
      expect(rollback.partitions.every((p: any) => p.questions === 1 && p.withinEffectiveLimits)).toBe(true);
      for (const name of await readdir(join(c.runs, 'offline-canary'))) {
        const text = await readFile(join(c.runs, 'offline-canary', name), 'utf8');
        expect(text).not.toContain('offline-credential-bytes'); expect(text).not.toContain('Assess');
      }
    } finally { await c.cleanup(); }
  });

  it('fails the canary when the provider reports an oversized request', async () => {
    const c = await canary(['dominant']);
    try {
      const summary = await c.run({ offlineTransport: transport(100) as typeof globalThis.fetch });
      expect(summary).toMatchObject({ canaryPassed: false, stopped: 'canary-check-failed', rollbackExercised: false });
      expect(summary.oversizedDispatches).toBeGreaterThan(0);
    } finally { await c.cleanup(); }
  });

  it('reserves each phase before dispatch and stops at eighty percent of the plan budget', async () => {
    const c = await canary(['aggregate-raw-2'], plan => { plan.budget.requests = 5; });
    try {
      const expected = (await contextCanaryDispatches(['aggregate-raw-2'], c.s.corpus, c.record))[0]!;
      expect(expected.enforce).toBeLessThanOrEqual(4); expect(expected.enforce + expected.rollback).toBeGreaterThan(4);
      const summary = await c.run();
      // Enforce fits the 4-request stop; rollback's four single calls would cross it, so none are sent.
      expect(summary).toMatchObject({ canaryPassed: false, stopped: 'budget-exhausted', cases: 1, requestCapacityAtStop: 4 });
      expect(c.fetch).toHaveBeenCalledTimes(expected.enforce);
    } finally { await c.cleanup(); }
  });

  it('charges prior #2681 runs against the USD 2.00 cap before the first canary reservation', async () => {
    const c = await canary(['dominant']);
    try {
      await mkdir(join(c.runs, 'crashed-collection'), { recursive: true });
      await writeFile(join(c.runs, 'crashed-collection', 'approval.json'), JSON.stringify({ schemaVersion: 'context-live-approval/v1', budget: { usd: 1.99 } }));
      const summary = await c.run();
      // 0.01 remains; its 80% stop (0.008) admits the single enforce request but not the two rollback calls.
      expect(summary).toMatchObject({ canaryPassed: false, stopped: 'budget-exhausted', issueSpend: { capUsd: 2, priorUsd: 1.99, runUsdCeiling: 0.01 } });
      expect(c.fetch).toHaveBeenCalledTimes(1); expect(c.dispose).toHaveBeenCalledTimes(1);
    } finally { await c.cleanup(); }
  });

  it.each([
    ['a many-question case whose result exceeds entry limits', (a: ContextCanaryApproval) => { a.plan.caseIds = ['dominant', 'many-short']; }],
    ['a plan budget above the issue cap', (a: ContextCanaryApproval) => { a.plan.budget.usd = 2.5; }],
  ])('rejects %s in the canary approval', async (_label, mutate) => {
    const c = await canary(['dominant', 'many-short']);
    try {
      const sign = (a: ContextCanaryApproval) => { a.canaryPlanDigest = contextLiveDigest(a.plan); return a; };
      const valid = structuredClone(c.approval); valid.plan.caseIds = ['dominant'];
      expect(() => validateContextCanaryApproval(sign(valid), c.s.corpus, c.record)).not.toThrow();
      const changed = structuredClone(valid); mutate(changed);
      expect(() => validateContextCanaryApproval(sign(changed), c.s.corpus, c.record)).toThrow('canary approval');
    } finally { await c.cleanup(); }
  });

  it('rejects an edited record, plan or corpus before credentials or transport', async () => {
    const c = await canary(['dominant']);
    try {
      const bumped = { ...c.record, profile: { ...c.record.profile, version: '9.9.9' } };
      await expect(c.run({ record: bumped })).rejects.toThrow();
      await expect(c.run({ approval: { ...c.approval, plan: { ...c.approval.plan, caseIds: ['dominant', 'many-short'] } } })).rejects.toThrow('canary approval');
      await expect(c.run({ approval: { ...c.approval, model: 'jev-other' } })).rejects.toThrow('canary approval');
      expect(c.resolver).not.toHaveBeenCalled(); expect(c.fetch).not.toHaveBeenCalled();
    } finally { await c.cleanup(); }
  });
});
