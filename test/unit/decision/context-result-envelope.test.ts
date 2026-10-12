import { describe, it, expect, vi } from 'vitest';
import { generateContextLiveCorpus, contextLiveDigest, contextLivePreregistration, compileContextLiveCase,
  contextLiveRuleset, contextLiveBinding, contextLiveTarget, ContextLiveBudget, collectContextLiveCase,
  type ContextLiveApproval, type ContextLiveCorpus, type ContextLiveRecord } from '../../../src/decision/context-live-qualification.js';
import { recordContextQualification, contextLiveRecordsDigest, validateContextCanaryApproval,
  type ContextMarginReview, type ContextCanaryApproval } from '../../../src/decision/context-live-promotion.js';
import { CanonicalJsonByteEstimator, planDecisionContext } from '../../../src/decision/context-plan.js';
import { evaluateDecisionRuleset, contextResultEnvelopeFits } from '../../../src/decision/evaluate.js';
import { JevDecisionAdapter } from '../../../src/decision/adapters/jev.js';
import { decisionBatchQuestionId } from '../../../src/decision/batch.js';
import { admitEntry } from '../../../src/decision/entry.js';
import { assertDecisionResultWriterVersion } from '../../../src/decision/validate.js';

/*
 * #2797: a context-planned invocation with many aliases produces a result document above the
 * default entry limits, and that error surfaced after provider dispatch. The evaluator now
 * preflights the worst-case completion envelope before dispatch; the canary covers many-short.
 */
const estimator = new CanonicalJsonByteEstimator();
const profile = { id: 'jev-tv12-collection', version: '1.0.0', estimator: { id: estimator.id, version: estimator.version },
  limits: { aggregateTokens: 64000, stateAndLongestQuestionTokens: 32000 }, safetyMarginBps: 3000, requestEnvelopeTokens: 512 };
const marginRule = { extraReserveBps: 500, maximumMarginBps: 3000 };
const MODEL = 'jev-pinned-fixture';
const REGION = 'fixture-region';
const subject = 'synthetic-tv12';
let generated: ContextLiveCorpus | undefined;

/** Fake Jev: reports actual input as `factor` times the planner estimate of the exact wire. */
function transport(factor: number) {
  let calls = 0;
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const estimate = estimator.estimate(body.state).tokens + Object.values(body.questions).reduce<number>((sum, q) => sum + estimator.estimate(q as any).tokens, 0) + profile.requestEnvelopeTokens;
    return new Response(JSON.stringify({ model: MODEL, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id,
      { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((key, i) => [key, i ? 0 : 1])) }])),
    usage: { input_tokens: Math.ceil(estimate * factor), output_tokens: 8 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `offline-${++calls}` } });
  });
  return fetch;
}

async function setup(caseIds: string[], factor = 1.1) {
  generated ??= await generateContextLiveCorpus(profile);
  const corpus: ContextLiveCorpus = { ...structuredClone(generated), cases: structuredClone(generated.cases.filter(c => caseIds.includes(c.id))) };
  const approval: ContextLiveApproval = { schemaVersion: 'context-live-approval/v1', approved: true, reviewer: 'offline-reviewer', stagingWorkspace: 'offline-only',
    runId: 'offline-collection', sourceCommit: 'a'.repeat(40), exactHeadCi: 'offline-fixture', model: MODEL, apiRevision: 'v1', region: REGION,
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
  const declared = records.map(r => {
    const usage = { source: 'provider' as const, servedModel: r.servedModel, requestId: r.requestId, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd };
    const usageArtifactDigest = contextLiveDigest(usage);
    return { ...r, source: 'provider' as const, usageArtifactDigest, usageRef: `usage:${usageArtifactDigest}` };
  });
  const worst = Math.max(...declared.map(r => r.undercountBps));
  const review: ContextMarginReview = { schemaVersion: 'context-margin-review/v1', approved: true, reviewer: 'offline-reviewer', approvalReference: 'offline-review',
    runId: approval.runId, recordsDigest: contextLiveRecordsDigest(declared), selectedMarginBps: worst + marginRule.extraReserveBps,
    qualifiedProfile: { id: 'jev-tv12-qualified', version: '1.0.0' } };
  return { corpus, approval, records, declared, review, worst, fetch, resolver };
}

/** A single-alias-per-dispatch evaluate request over a corpus case, mirroring the canary rollback shape. */
async function evaluateCase(caseId: string, fetch: ReturnType<typeof transport>, resolver: (ref: string) => Promise<Uint8Array>) {
  generated ??= await generateContextLiveCorpus(profile);
  const item = generated.cases.find(c => c.id === caseId)!;
  const { input, policy } = await compileContextLiveCase(item, MODEL, REGION);
  const aliases = item.definitions.map((_, i) => `q${i}`);
  const definitions: Record<string, any> = Object.fromEntries(aliases.map((alias, i) => [alias, item.definitions[i]]));
  const adapter = new JevDecisionAdapter({ region: REGION, fetch: fetch as typeof globalThis.fetch });
  const target = contextLiveTarget({ model: MODEL, secretServiceReference: 'openbao-approle.fixture-jev-reader.typesafe-jev' }, adapter.version, 30000);
  const ruleset = contextLiveRuleset(`envelope-${item.id}`, aliases, item.definitions);
  const binding = contextLiveBinding(ruleset, aliases, target, 30000 * aliases.length);
  return evaluateDecisionRuleset({ ruleset, binding, definitions, input: item.input, runId: 'offline-envelope', invocationId: `offline-envelope:${item.id}`,
    adapters: { jev: adapter }, signal: new AbortController().signal, resolveCredential: resolver,
    projection: { resolve: () => structuredClone(policy) },
    batching: { enabled: true, evaluations: Object.fromEntries(aliases.map(alias => [alias, { decisionSubject: subject, independent: true,
      egressPolicy: contextLiveDigest(policy), hostPolicy: 'tv12-canary-v1' }])) },
    context: { input: { ...input, questions: input.questions.map(q => ({ ...q, id: decisionBatchQuestionId(q.id) })) }, profile, estimator,
      rollout: { mode: 'observe-only' } } } as any);
}

describe('TV-12 result-envelope preflight (#2797, offline guards)', () => {
  it('rejects the 24-alias many-short invocation before provider dispatch', async () => {
    const fetch = transport(1.1);
    const resolver = vi.fn(async () => new TextEncoder().encode('offline-credential-bytes'));
    const result = await evaluateCase('many-short', fetch, resolver);
    expect(result.spec.status).toBe('error');
    expect(result.spec.reason).toBe('invalid-input');
    expect(result.spec.contextFailure).toMatchObject({ schemaVersion: 'decision-context-failure/v1', reason: 'invalid-input' });
    expect(result.spec.evaluations).toEqual({});
    expect(result.spec.context?.actualUsage).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    // The rejection itself is an admissible document: nothing completed was discarded.
    expect(() => admitEntry(result)).not.toThrow();
  });

  it('completes a fitting context-planned invocation with an admissible result', async () => {
    const fetch = transport(1.1);
    const resolver = vi.fn(async () => new TextEncoder().encode('offline-credential-bytes'));
    const result = await evaluateCase('dominant', fetch, resolver);
    expect(fetch).toHaveBeenCalled();
    const evaluations = Object.values(result.spec.evaluations);
    expect(evaluations).toHaveLength(2);
    expect(evaluations.every(e => e.spec.status === 'success')).toBe(true);
    expect(() => admitEntry(result)).not.toThrow();
  });

  it('bounds the worst-case completion envelope on either side of the alias boundary', async () => {
    generated ??= await generateContextLiveCorpus(profile);
    const item = generated.cases.find(c => c.id === 'many-short')!;
    const { input } = await compileContextLiveCase(item, MODEL, REGION);
    const plan = planDecisionContext(input, profile, estimator);
    const adapterVersion = new JevDecisionAdapter({ region: REGION }).version;
    const fitsFor = (count: number) => {
      const aliases = item.definitions.slice(0, count).map((_, i) => `q${i}`);
      const target = contextLiveTarget({ model: MODEL, secretServiceReference: 'openbao-approle.fixture-jev-reader.typesafe-jev' }, adapterVersion, 30000);
      const binding = contextLiveBinding(contextLiveRuleset(`envelope-bound-${count}`, aliases, item.definitions.slice(0, count)), aliases, target, 30000 * count);
      return contextResultEnvelopeFits(plan, aliases.map((alias, i) => ({ alias, definition: item.definitions[i]! })), binding);
    };
    expect(fitsFor(8)).toBe(true);
    expect(fitsFor(24)).toBe(false);
  });

  it('admits the many-short shape in the canary approval', async () => {
    const s = await setup(['many-short']);
    const record = await recordContextQualification({ approval: s.approval, corpus: s.corpus, records: s.declared, review: s.review });
    const plan = { schemaVersion: 'context-canary-plan/v1', caseIds: ['many-short'], rollback: 'observe-only',
      budget: { requests: 200, tokens: 100_000_000, usd: 2, wallClockMs: 600_000 },
      perRequestBound: { totalTokens: 72_000, outputTokens: 128, usd: 0.0072, approvalReference: 'offline-bound' } } as const;
    const approval: ContextCanaryApproval = { schemaVersion: 'context-canary-approval/v1', approved: true, reviewer: 'offline-reviewer', stagingWorkspace: 'offline-only',
      runId: 'offline-canary', sourceCommit: 'a'.repeat(40), exactHeadCi: 'offline-fixture', model: MODEL, apiRevision: 'v1', region: REGION,
      secretServiceReference: 'openbao-approle.fixture-jev-reader.typesafe-jev', credentialResolverDigest: `sha256:${'b'.repeat(64)}`, corpusDigest: contextLiveDigest(s.corpus),
      qualificationRecordDigest: contextLiveDigest(record), canaryPlanDigest: contextLiveDigest(plan), plan: { ...plan } };
    expect(() => validateContextCanaryApproval(approval, s.corpus, record)).not.toThrow();
  });
});

/*
 * The preflight is a worst-case bound on the completed result envelope: whenever it reports fit,
 * the real invocation must complete with a writer-admissible result. Each shape runs n = 1..30
 * through the fake Jev transport; only fitting shapes dispatch.
 */
describe('result-envelope preflight conservativeness (#2797 property)', () => {
  const shapes = [
    { name: 'observe-only', mode: 'observe-only', retries: 0, options255: false },
    { name: 'enforce', mode: 'enforce', retries: 0, options255: false },
    { name: 'observe-only-2-retries', mode: 'observe-only', retries: 2, options255: false },
    { name: 'many-option', mode: 'observe-only', retries: 0, options255: true },
  ] as const;

  /** Fake Jev that fails the first `failFirst` dispatches of each question batch with a retriable 503. */
  function flakyTransport(failFirst: number) {
    let calls = 0;
    const seen = new Map<string, number>();
    return vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const key = Object.keys(body.questions).sort().join(',');
      const attempt = (seen.get(key) ?? 0) + 1;
      seen.set(key, attempt);
      if (attempt <= failFirst) {
        return new Response('{"error":"x"}', { status: 503,
          headers: { 'content-type': 'application/json', 'x-request-id': `fail-${++calls}` } });
      }
      const estimate = estimator.estimate(body.state).tokens + Object.values(body.questions).reduce<number>((sum, q) => sum + estimator.estimate(q as any).tokens, 0) + profile.requestEnvelopeTokens;
      return new Response(JSON.stringify({ model: MODEL, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id,
        { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i ? 0 : 1])) }])),
        usage: { input_tokens: Math.ceil(estimate * 1.1), output_tokens: 8 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `ok-${++calls}` } });
    });
  }

  it('fits implies a writer-admissible completed result for n = 1..30', async () => {
    generated ??= await generateContextLiveCorpus(profile);
    const short = generated.cases.find(c => c.id === 'many-short')!;
    const wide = generated.cases.find(c => c.id === 'choice-255')!;
    let qualified: Awaited<ReturnType<typeof recordContextQualification>> | undefined;
    let qualifiedProfile = profile;
    for (const shape of shapes) {
      for (let n = 1; n <= 30; n++) {
        const tmpl = shape.options255 ? wide.definitions[0]! : short.definitions[0]!;
        const defs = Array.from({ length: n }, (_, i) => { const d = structuredClone(tmpl); d.metadata.id = `short${i}`; return d; });
        const item = { id: `envelope-prop-${n}`, dimension: 'many-short', input: { payload: 'synthetic' }, definitions: defs };
        const { input, policy } = await compileContextLiveCase(item, MODEL, REGION);
        const contextInput = { ...input, questions: input.questions.map(q => ({ ...q, id: decisionBatchQuestionId(q.id) })) };
        if (shape.mode === 'enforce' && !qualified) {
          const s = await setup(['dominant']);
          qualified = await recordContextQualification({ approval: s.approval, corpus: s.corpus, records: s.declared, review: s.review });
          qualifiedProfile = qualified.profile;
        }
        const activeProfile = shape.mode === 'enforce' ? qualifiedProfile : profile;
        const plan = planDecisionContext(contextInput, activeProfile, estimator);
        const aliases = defs.map((_, i) => `q${i}`);
        const fetch = flakyTransport(shape.retries);
        const adapter = new JevDecisionAdapter({ region: REGION, fetch: fetch as typeof globalThis.fetch });
        const target: any = contextLiveTarget({ model: MODEL, secretServiceReference: 'openbao-approle.fixture-jev-reader.typesafe-jev' }, adapter.version, 30000);
        if (shape.retries) target.retry = { maxRetries: shape.retries, initialDelayMs: 0, maxDelayMs: 0 };
        const ruleset = contextLiveRuleset(`envelope-prop-${shape.name}-${n}`, aliases, defs);
        const binding: any = contextLiveBinding(ruleset, aliases, target, 30000 * n);
        binding.spec.maxAttempts = n * (shape.retries + 1);
        if (!contextResultEnvelopeFits(plan, aliases.map((alias, i) => ({ alias, definition: defs[i]! })), binding)) continue;
        const resolver = vi.fn(async () => new TextEncoder().encode('offline-credential-bytes'));
        const result = await evaluateDecisionRuleset({ ruleset, binding,
          definitions: Object.fromEntries(aliases.map((alias, i) => [alias, defs[i]])),
          input: item.input, runId: 'offline-envelope-prop', invocationId: `offline-envelope-prop:${shape.name}:${n}`,
          adapters: { jev: adapter }, signal: new AbortController().signal, resolveCredential: resolver,
          projection: { resolve: () => structuredClone(policy) },
          batching: { enabled: true, evaluations: Object.fromEntries(aliases.map(alias => [alias, { decisionSubject: subject, independent: true,
            egressPolicy: contextLiveDigest(policy), hostPolicy: 'tv12-canary-v1' }])) },
          context: { input: contextInput, profile: activeProfile, estimator,
            rollout: shape.mode === 'enforce' ? { mode: 'enforce', qualification: qualified!.qualification } : { mode: 'observe-only' } } } as any);
        expect(Object.values(result.spec.evaluations).every(e => e.spec.status === 'success')).toBe(true);
        expect(() => assertDecisionResultWriterVersion(result)).not.toThrow();
      }
    }
  }, 30000);
});
