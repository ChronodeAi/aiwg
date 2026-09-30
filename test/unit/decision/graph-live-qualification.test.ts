import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateDagLiveWorkload, dagLivePreregistration, dagLiveDefinitions, DAG_LIVE_PATTERNS, DAG_LIVE_TAXONOMY,
  type DagLiveWorkload, type DagLiveTask } from '../../../src/decision/graph-live-workload.js';
import { analyzeDagLivePattern, buildDagLiveArms, DagLiveBudget, dagLiveDigest, DAG_LIVE_DEFAULT_LIMITS, DAG_LIVE_SOURCE_GOLDENS,
  patternCallRatioExceeded, planDagLiveQualification, recordDagLiveDecision, runDagLiveQualification, speculativeActionViolation,
  validateDagLiveApproval, validateDagLiveInputs, type DagLiveApproval, type DagLivePair } from '../../../src/decision/graph-live-qualification.js';
// @ts-expect-error untyped trusted resolver module
import { createOpenBaoJevResolver, JEV_SECRET_REFERENCE } from '../../../tools/decision/jev-openbao-credential.mjs';

const route = vi.hoisted(() => ({ root: '' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (command: string, args: string[], options: unknown) => command === 'aiwg'
    ? JSON.stringify({ artifact_root: route.root, write_ready: true }) : actual.execFileSync(command, args, { ...(options as object), timeout: 10_000 }) };
});
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
const skillId = 'aiwg:skill:7763181ed98b5100' as const;
const MODEL = 'jev-fixture-model';
const frozen = 'docs/decision/evidence/dag-live-v1';

function approvalFor(workload: DagLiveWorkload, overrides: Partial<DagLiveApproval> = {}): DagLiveApproval {
  const preregistration = dagLivePreregistration(workload);
  return { schemaVersion: 'dag-live-approval/v1', approved: true, reviewer: 'roctinam', stagingHost: 'offline-fixture', runId: 'd12-offline',
    sourceCommit: 'a'.repeat(40), exactHeadCi: 'offline-fixture', model: MODEL, apiRevision: 'v1', region: 'fixture-region',
    secretServiceReference: JEV_SECRET_REFERENCE, credentialResolverDigest: `sha256:${'b'.repeat(64)}`,
    workloadDigest: dagLiveDigest(workload), preregistrationDigest: dagLiveDigest(preregistration),
    ...structuredClone(DAG_LIVE_DEFAULT_LIMITS), ...overrides };
}

/** Oracle Jev: answers from the frozen labels unless `wrong(taskId, node)` flips an answer. */
function oracle(workload: DagLiveWorkload, wrong: (task: DagLiveTask, node: string) => boolean = () => false) {
  const bySubject = new Map(workload.tasks.map(task => [JSON.stringify(task.subject), task]));
  const byInstruction = new Map<string, string>();
  for (const task of workload.tasks) for (const [node, def] of Object.entries(dagLiveDefinitions(task))) byInstruction.set(def.spec.question, node);
  let requests = 0;
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const [[questionId, question]] = Object.entries(body.questions) as [[string, any]];
    const state = body.state.untrusted ?? body.state;
    const task = bySubject.get(JSON.stringify(state.subject))!;
    const node = byInstruction.get(question.instructions)!;
    const evidence = state.evidence ?? {};
    let answer: string | number;
    const sections = task.subject.sections as Array<{ id: string; items: Array<{ id: string }> }> | undefined;
    if (node === 'shortlist') answer = sections!.find(section => section.items.some(item => item.id === task.label))?.id ?? 'none';
    else if (node === 'rerank') answer = `position-${sections![evidence.candidates.sectionIndex]!.items.findIndex(item => item.id === task.label) + 1}`;
    else if (node.startsWith('branch-')) answer = DAG_LIVE_TAXONOMY[node as 'branch-a'].leaves.some(leaf => leaf.id === task.label) ? 4 : 0;
    else if (node === 'verifier') answer = evidence.evidence.status === task.label ? 'supported' : 'not-supported';
    else answer = task.label;
    if (wrong(task, node)) {
      if (typeof answer === 'number') answer = 4 - answer;
      else answer = Object.keys(question.criteria).find(key => key !== answer)!;
    }
    requests++;
    const payload = question.type === 'score'
      ? { type: 'score', score: answer, confidence: 1, legend: Object.fromEntries(question.criteria.map((v: string, i: number) => [String(i), v])),
        probabilities: Object.fromEntries(question.criteria.map((_: string, i: number) => [String(i), i === answer ? 1 : 0])) }
      : { type: 'choice', choice: answer, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === answer ? 1 : 0])) };
    return new Response(JSON.stringify({ model: MODEL, answers: { [questionId]: payload }, usage: { input_tokens: 600, output_tokens: 8 } }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `offline-${requests}` } });
  });
  return fetch;
}

async function withRepo<T>(work: (paths: { source: string; artifacts: string; commit: string }) => Promise<T>): Promise<T> {
  const source = await mkdtemp(join(tmpdir(), 'd12-source-'));
  const artifacts = await mkdtemp(join(tmpdir(), 'd12-artifacts-'));
  route.root = artifacts;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  try {
    for (const file of DAG_LIVE_SOURCE_GOLDENS) {
      await mkdir(join(source, dirname(file)), { recursive: true });
      await writeFile(join(source, file), await readFile(file));
    }
    git('init'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    return await work({ source, artifacts, commit: git('rev-parse', 'HEAD') });
  } finally { route.root = ''; await rm(source, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
}

async function run(workload: DagLiveWorkload, fetch: typeof globalThis.fetch, overrides: Partial<DagLiveApproval> = {}, now?: () => number) {
  return withRepo(async ({ source, artifacts, commit }) => {
    const approval = approvalFor(workload, { sourceCommit: commit, ...overrides });
    const resolveCredential = vi.fn(async () => new TextEncoder().encode('fixture-secret-value'));
    const result = await runDagLiveQualification({ approval, workload, preregistration: dagLivePreregistration(workload), sourceRoot: source,
      artifactRoot: artifacts, host: { resolveCredential }, executeFlow: executeFlowGraph, skillId, transport: fetch, ...(now ? { now } : {}) }) as any;
    const directory = join(artifacts, approval.runId);
    const read = async (name: string) => readFile(join(directory, name), 'utf8');
    const files = Object.fromEntries(await Promise.all(['summary.json', 'pairs.jsonl', 'calls.jsonl', 'run-manifest.json', 'evidence-manifest.json',
      'g5-load-result.json', 'g6-review-request.json'].map(async name => [name, await read(name)])));
    const decisions = { hold: await recordDagLiveDecision(directory, 'hold', 'roctinam', 'synthetic offline run').catch(error => error as Error) };
    return { result, files, resolveCredential, directory, decisions };
  });
}

describe('D12 live qualification workload and preregistration (#2686)', () => {
  it('regenerates the frozen, digest-pinned synthetic workload and preregistration byte-for-byte', async () => {
    const workload = generateDagLiveWorkload();
    const preregistration = dagLivePreregistration(workload);
    expect(JSON.parse(await readFile(`${frozen}/workload.json`, 'utf8'))).toEqual(workload);
    expect(JSON.parse(await readFile(`${frozen}/preregistration.json`, 'utf8'))).toEqual(preregistration);
    expect(preregistration.workloadDigest).toBe(dagLiveDigest(workload));
    expect(DAG_LIVE_PATTERNS.map(p => workload.tasks.filter(t => t.pattern === p).length)).toEqual([100, 100, 100]);
    // Labels never leak into model-visible subjects, and every label is answerable by the flat arm.
    for (const task of workload.tasks) {
      expect(JSON.stringify(task.subject)).not.toContain('"label"');
      // Taxonomy tickets never spell out the hyphenated leaf ID they are labelled with.
      if (task.pattern === 'taxonomy-beam') expect(JSON.stringify(task.subject)).not.toContain(task.label);
      const flat = dagLiveDefinitions(task).flat!.spec.answer;
      expect(flat.kind === 'choice' && flat.options.map(o => o.id)).toContain(task.label);
    }
    expect(new Set(workload.tasks.map(t => t.slice)).size).toBeGreaterThanOrEqual(8);
    expect(generateDagLiveWorkload(7, 3)).not.toEqual(generateDagLiveWorkload(8, 3));
  });

  it('binds the margin and level: any edit to the preregistration or workload is rejected', () => {
    const workload = generateDagLiveWorkload(11, 3);
    const preregistration = dagLivePreregistration(workload);
    expect(() => validateDagLiveInputs(workload, preregistration)).not.toThrow();
    const loosened = structuredClone(preregistration) as any; loosened.analysis.nonInferiority.marginBps = -2500;
    expect(() => validateDagLiveInputs(workload, loosened)).toThrow('preregistration');
    const relabelled = structuredClone(workload); relabelled.tasks[0]!.label = 'none';
    expect(() => validateDagLiveInputs(relabelled, preregistration)).toThrow('workload');
  });

  it('validates the approval, including the USD 2.00 hard cap and price ceiling', () => {
    const workload = generateDagLiveWorkload(11, 3);
    const preregistration = dagLivePreregistration(workload);
    expect(() => validateDagLiveApproval(approvalFor(workload), workload, preregistration)).not.toThrow();
    const cases: Array<Partial<DagLiveApproval> | Record<string, unknown>> = [
      { budget: { ...DAG_LIVE_DEFAULT_LIMITS.budget, usd: 2.01 } },
      { price: { ...DAG_LIVE_DEFAULT_LIMITS.price, ceilingUsdPerMTok: 0.01 } },
      { budget: { ...DAG_LIVE_DEFAULT_LIMITS.budget, perPattern: { ...DAG_LIVE_DEFAULT_LIMITS.budget.perPattern, calls: 5_000 } } },
      { model: 'jev-latest' }, { approved: false as never }, { workloadDigest: `sha256:${'c'.repeat(64)}` }, { extra: 1 },
    ];
    for (const change of cases) expect(() => validateDagLiveApproval({ ...approvalFor(workload), ...change } as DagLiveApproval, workload, preregistration)).toThrow();
  });
});

describe('D12 budget, plan and stop rules', () => {
  const limits = structuredClone(DAG_LIVE_DEFAULT_LIMITS);
  it('reserves the worst case before dispatch and refuses at 80% of each dimension', () => {
    const tight = (budget: Partial<DagLiveApproval['budget']>) => ({ ...limits, budget: { ...limits.budget, ...budget } });
    const calls = new DagLiveBudget(tight({ calls: 5 }), 4000, 0.8, 0, () => 0);
    for (let i = 0; i < 4; i++) calls.reserve('taxonomy-beam')(100);
    expect(() => calls.reserve('taxonomy-beam')).toThrow('budget-run-calls');
    const usd = new DagLiveBudget(tight({ usd: 0.001 }), 4000, 0.8, 0, () => 0);
    usd.reserve('taxonomy-beam')(null); // unknown usage keeps the full USD 0.0004 reservation
    usd.reserve('taxonomy-beam')(4000);
    expect(() => usd.reserve('taxonomy-beam')).toThrow('budget-run-usd');
    expect(usd.total.usdMicros).toBe(800);
    const pattern = new DagLiveBudget({ ...limits, budget: { ...limits.budget, perPattern: { ...limits.budget.perPattern, tokens: 7_000 } } }, 4000, 0.8, 0, () => 0);
    pattern.reserve('shortlist-rerank')(1000);
    pattern.reserve('shortlist-rerank')(1000);
    expect(pattern.total.tokens).toBe(2000);
    expect(() => pattern.reserve('shortlist-rerank')).toThrow('budget-pattern-tokens');
    expect(() => pattern.reserve('taxonomy-beam')).not.toThrow();
    let clock = 0; const time = new DagLiveBudget(limits, 4000, 0.8, 0, () => clock);
    clock = limits.budget.wallClockMs * 0.8; expect(() => time.reserve('taxonomy-beam')).toThrow('budget-run-wall-clock');
  });

  it('plans worst-case calls, tokens and USD without any provider call, and flags a budget that cannot cover it', () => {
    const workload = generateDagLiveWorkload();
    const preregistration = dagLivePreregistration(workload);
    const plan = planDagLiveQualification(workload, preregistration, limits);
    expect(plan.providerCalls).toBe(0);
    expect(plan.totals).toMatchObject({ worstCaseCalls: 1100, worstCaseTokens: 4_400_000, worstCaseReservedUsd: 0.44, hardCapUsd: 2 });
    expect(plan.withinBudget).toBe(true);
    expect(plan.boundCoversLargestEstimate).toBe(true);
    expect(planDagLiveQualification(workload, preregistration, { ...limits, budget: { ...limits.budget, calls: 1_000 } }).withinBudget).toBe(false);
  });

  it('stops a pattern whose calls exceed three times its Flow baseline', () => {
    const pair = (calls: number) => ({ pattern: 'taxonomy-beam', baseline: { calls: 1 }, candidate: { calls } }) as unknown as DagLivePair;
    expect(patternCallRatioExceeded([pair(3), pair(3)], 'taxonomy-beam', 3)).toBe(false);
    expect(patternCallRatioExceeded([pair(3), pair(4)], 'taxonomy-beam', 3)).toBe(true);
  });

  it('treats any node able to request an action or permission as a speculative-action stop', () => {
    const task = generateDagLiveWorkload(11, 2).tasks.find(t => t.pattern === 'taxonomy-beam')!;
    const arms = buildDagLiveArms(task, { model: MODEL, secretServiceReference: JEV_SECRET_REFERENCE, skillId, perCallTokenBound: 4000,
      ceilingUsdPerMTok: 0.1, taskDeadlineMs: 60_000 });
    expect(speculativeActionViolation(arms.candidate.flow)).toBe(false);
    expect(speculativeActionViolation(arms.baseline.flow)).toBe(false);
    const acting = structuredClone(arms.candidate.flow); acting.spec.nodes[1].sideEffectMode = 'external-write';
    expect(speculativeActionViolation(acting)).toBe(true);
    const permitted = structuredClone(arms.baseline.flow); permitted.spec.nodes[0].permissions = ['net:egress'];
    expect(speculativeActionViolation(permitted)).toBe(true);
  });
});

describe('D12 paired analysis applies every preregistered threshold', () => {
  const workload = generateDagLiveWorkload(5, 100);
  const preregistration = dagLivePreregistration(workload);
  const price = DAG_LIVE_DEFAULT_LIMITS.price;
  function pairs(options: { baselineWrong?: number; candidateWrong?: number; candidateCalls?: number; candidateLatency?: number; candidateTokens?: number; n?: number } = {}): DagLivePair[] {
    return workload.tasks.filter(task => task.pattern === 'taxonomy-beam').slice(0, options.n ?? 100).map((task, index) => ({
      pattern: 'taxonomy-beam', taskId: task.id, slice: task.slice, index, order: index % 2 ? 'candidate-first' : 'baseline-first', label: task.label,
      baseline: { answer: null, correct: index >= (options.baselineWrong ?? 10), calls: 1, inputTokens: 600, outputTokens: 8, latencyMs: 100 + index, requestIds: [] },
      candidate: { answer: null, correct: index >= (options.candidateWrong ?? 10), calls: options.candidateCalls ?? 3, inputTokens: options.candidateTokens ?? 1800,
        outputTokens: 24, latencyMs: (options.candidateLatency ?? 300) + index, requestIds: [], outcome: 'complete', receiptDigest: 'x', unusedCalls: 0, unusedTokens: 0 },
    }));
  }
  it('marks an equal-quality candidate within economics eligible for the reviewer', () => {
    const analysis = analyzeDagLivePattern('taxonomy-beam', pairs(), preregistration, price);
    expect(analysis.quality.nonInferiority.decision).toBe('non-inferior');
    expect(analysis.quality.difference!.lowerBps).toBeGreaterThanOrEqual(-1000);
    expect(analysis.economics.callRatio).toBe(3);
    expect(analysis.economics.net.billableUsd).toBeCloseTo((1200 * 0.042) * 100 / 1e6, 12);
    expect(analysis.eligible).toBe(true);
  });
  it.each([
    ['a candidate 15 points less accurate', { candidateWrong: 25 }, 'quality'],
    ['a candidate costing more calls than the ratio allows', { candidateCalls: 4 }, 'callRatio'],
    ['a candidate with p95 latency above four times the baseline', { candidateLatency: 900 }, 'p95LatencyRatio'],
    ['a candidate whose extra tokens exceed the per-task bound', { candidateTokens: 9_900 }, 'extraTokensPerTask'],
    ['an incomplete pattern', { n: 99 }, 'complete'],
  ] as const)('does not mark %s eligible', (_name, options, failed) => {
    const analysis = analyzeDagLivePattern('taxonomy-beam', pairs(options), preregistration, price);
    expect(analysis.eligible).toBe(false);
    if (failed === 'quality') expect(analysis.quality.nonInferiority.decision).toBe('not-non-inferior');
    else if (failed === 'complete') expect(analysis.complete).toBe(false);
    else expect(analysis.economics.checks[failed]).toBe(false);
  });
  it('uses the preregistered margin: a lower bound between -10 and -5 points passes only at the registered -10', () => {
    const analysis = analyzeDagLivePattern('taxonomy-beam', pairs({ candidateWrong: 13 }), preregistration, price);
    expect(analysis.quality.difference!.lowerBps).toBeLessThan(-500);
    expect(analysis.quality.nonInferiority.decision).toBe('non-inferior');
    const stricter = structuredClone(preregistration) as any; stricter.analysis.nonInferiority.marginBps = -500;
    expect(analyzeDagLivePattern('taxonomy-beam', pairs({ candidateWrong: 13 }), stricter, price).quality.nonInferiority.decision).toBe('not-non-inferior');
  });
});

describe('D12 paired collection with an injected transport (synthetic, never live evidence)', () => {
  it('runs both arms through Flow, writes digest-bound D11 evidence and never recommends promotion', async () => {
    const workload = generateDagLiveWorkload(21, 4);
    const fetch = oracle(workload, (task, node) => task.id === 'tb-002' && node === 'flat');
    const { result, files, resolveCredential, decisions } = await run(workload, fetch as never);
    expect(result.stopped).toBeNull();
    expect(result.pairs).toBe(12);
    expect(result.source).toBe('synthetic'); expect(result.liveEvidence).toBe(false);
    expect(result.recommendation).toBe('hold');
    const pairs = files['pairs.jsonl'].trim().split('\n').map(line => JSON.parse(line)) as DagLivePair[];
    expect(pairs.find(p => p.taskId === 'tb-002')!.baseline.correct).toBe(false);
    expect(pairs.filter(p => p.taskId !== 'tb-002').every(p => p.baseline.correct && p.candidate.correct)).toBe(true);
    // Calls, tokens and order: flat is always one call; the candidate path depends on the answers.
    expect(pairs.every(p => p.baseline.calls === 1)).toBe(true);
    expect(pairs.filter(p => p.pattern === 'taxonomy-beam').every(p => p.candidate.calls === 3)).toBe(true);
    expect(pairs.filter(p => p.pattern === 'extractor-verifier-fallback').every(p => p.candidate.calls === 2)).toBe(true);
    for (const p of pairs.filter(p => p.pattern === 'shortlist-rerank')) expect(p.candidate.calls).toBe(p.label === 'none' ? 1 : 2);
    expect(pairs.map(p => p.order).slice(0, 2)).toEqual(['baseline-first', 'candidate-first']);
    const calls = files['calls.jsonl'].trim().split('\n');
    expect(calls).toHaveLength(fetch.mock.calls.length);
    expect(result.reserved.calls).toBe(fetch.mock.calls.length);
    expect(result.reserved.tokens).toBe(608 * fetch.mock.calls.length);
    // The credential is read once per run, sent on every call and never persisted.
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.every(([, init]) => (init.headers as Record<string, string>).authorization === 'Bearer fixture-secret-value')).toBe(true);
    for (const text of Object.values(files)) expect(text).not.toContain('fixture-secret-value');
    // Model-visible state is the D10 projection: only the subject and predecessor evidence, never labels.
    const wire = JSON.parse(String(fetch.mock.calls[0]![1].body));
    expect(Object.keys(wire.state.untrusted).sort()).toEqual(['evidence', 'subject']);
    expect(JSON.stringify(wire)).not.toContain('"label"');
    const summary = JSON.parse(files['summary.json']);
    expect(summary.pairsDigest).toBe(`sha256:${createHash('sha256').update(files['pairs.jsonl']).digest('hex')}`);
    expect(summary.callsDigest).toBe(`sha256:${createHash('sha256').update(files['calls.jsonl']).digest('hex')}`);
    const manifest = JSON.parse(files['run-manifest.json']);
    expect(manifest.mode).toBe('offline');
    expect(manifest.evidence.map((row: any) => row.caseId)).toEqual(DAG_LIVE_PATTERNS.map(p => `d12-${p}`));
    // Synthetic transport can never produce a passing D11 case or a G5 qualification.
    expect(manifest.evidence.every((row: any) => row.outcome === 'fail')).toBe(true);
    expect(JSON.parse(files['evidence-manifest.json']).evidence).toHaveLength(3);
    expect(JSON.parse(files['g5-load-result.json']).mode).toBe('synthetic-transport');
    expect(manifest.gateArtifacts).toBeUndefined();
    expect(manifest.evidenceFlags['load-manifest-qualified']).toBe(false);
    expect(JSON.parse(files['g6-review-request.json'])).toMatchObject({ reviewer: 'roctinam', recommendation: 'hold' });
    expect(decisions.hold).toMatchObject({ decision: 'hold', reviewer: 'roctinam' });
  }, 60_000);

  it('applies the preregistered gates end to end on the full workload: a degraded pattern is not eligible', async () => {
    const workload = generateDagLiveWorkload();
    // On 20 parcels the verifier wrongly rejects and the fallback answers wrongly; the flat arm stays correct.
    // (The flat and extractor questions are identical on the wire, so the oracle cannot degrade one alone.)
    const degraded = new Set(workload.tasks.filter(t => t.pattern === 'extractor-verifier-fallback').slice(0, 20).map(t => t.id));
    let clock = 0;
    const { result } = await run(workload, oracle(workload, (task, node) => degraded.has(task.id) && ['verifier', 'fallback'].includes(node)) as never,
      {}, () => (clock += 5));
    expect(result.stopped).toBeNull();
    expect(result.pairs).toBe(300);
    const byPattern = Object.fromEntries(result.analyses.map((a: any) => [a.pattern, a]));
    expect(byPattern['extractor-verifier-fallback'].quality.table).toEqual({ both: 80, candidateOnly: 0, baselineOnly: 20, neither: 0 });
    expect(byPattern['extractor-verifier-fallback'].quality.nonInferiority.decision).toBe('not-non-inferior');
    expect(byPattern['extractor-verifier-fallback'].eligible).toBe(false);
    for (const pattern of ['shortlist-rerank', 'taxonomy-beam']) {
      expect(byPattern[pattern].quality.table.both).toBe(100);
      expect(byPattern[pattern].quality.nonInferiority.decision).toBe('non-inferior');
      expect(byPattern[pattern].economics.callRatio).toBeLessThanOrEqual(3);
      expect(byPattern[pattern].eligible).toBe(true);
    }
    expect(byPattern['taxonomy-beam'].economics.callRatio).toBe(3);
    expect(byPattern['taxonomy-beam'].economics.speculative).toEqual({ unusedCalls: 0, unusedTokens: 0 });
    // Synthetic transport never yields a promotion recommendation, whatever the analysis says.
    expect(result.recommendation).toBe('hold');
  }, 120_000);

  it('refuses to record promotion for synthetic evidence or from anyone but the promotion owner', async () => {
    const workload = generateDagLiveWorkload(21, 2);
    await withRepo(async ({ source, artifacts, commit }) => {
      const approval = approvalFor(workload, { sourceCommit: commit });
      await runDagLiveQualification({ approval, workload, preregistration: dagLivePreregistration(workload), sourceRoot: source, artifactRoot: artifacts,
        host: { resolveCredential: async () => new TextEncoder().encode('k') }, executeFlow: executeFlowGraph, skillId, transport: oracle(workload) as never });
      const directory = join(artifacts, approval.runId);
      await expect(recordDagLiveDecision(directory, 'promote', 'roctinam', 'looks good')).rejects.toThrow('promotion refused');
      await expect(recordDagLiveDecision(directory, 'hold', 'someone-else', 'n/a')).rejects.toThrow('promotion owner');
      const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
      await rm(join(directory, 'summary.json'));
      await writeFile(join(directory, 'summary.json'), JSON.stringify({ ...summary, recommendation: 'eligible-for-promotion-review', liveEvidence: true }));
      await expect(recordDagLiveDecision(directory, 'promote', 'roctinam', 'forged')).rejects.toThrow('does not bind');
    });
  }, 60_000);

  it.each([
    ['a rate-limited provider', 'provider-rate-limited', (response: Response) => new Response('private provider text', { status: 429 })],
    ['missing token usage', 'unknown-usage', async (response: Response) => {
      const body = await response.json(); delete body.usage.input_tokens;
      return new Response(JSON.stringify(body), { headers: response.headers });
    }],
    ['a different served model', 'served-model-mismatch', async (response: Response) => {
      const body = await response.json(); body.model = 'other-model';
      return new Response(JSON.stringify(body), { headers: response.headers });
    }],
    ['usage above the per-call reservation', 'usage-exceeded-reservation', async (response: Response) => {
      const body = await response.json(); body.usage.input_tokens = 4_500;
      return new Response(JSON.stringify(body), { headers: response.headers });
    }],
  ])('stops without retry on %s and keeps completed pairs', async (_name, reason, mutate) => {
    const workload = generateDagLiveWorkload(21, 4);
    const inner = oracle(workload);
    let requests = 0;
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      const response = await inner(url, init);
      return ++requests === 5 ? mutate(response) : response;
    });
    const { result, files } = await run(workload, fetch as never);
    expect(result.stopped).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.pairs).toBeGreaterThan(0);
    expect(files['pairs.jsonl'].trim().split('\n')).toHaveLength(result.pairs);
    expect(files['calls.jsonl'].trim().split('\n')).toHaveLength(5);
    expect(result.analyses.some((a: any) => a.eligible)).toBe(false);
    expect(Object.values(files).join('')).not.toContain('private provider text');
    expect(JSON.parse(files['run-manifest.json']).evidence.every((row: any) => row.outcome === 'fail')).toBe(true);
  }, 60_000);

  it('stops before dispatch when the run budget is exhausted and at the wall-clock stop fraction', async () => {
    const workload = generateDagLiveWorkload(21, 4);
    const fetch = oracle(workload);
    const limited = await run(workload, fetch as never, { budget: { ...DAG_LIVE_DEFAULT_LIMITS.budget, calls: 5, perPattern: { ...DAG_LIVE_DEFAULT_LIMITS.budget.perPattern, calls: 5 } } });
    expect(limited.result.stopped).toBe('budget-run-calls');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(limited.result.reserved.calls).toBe(4);
    let clock = 0;
    const timed = oracle(workload);
    const slow = await run(workload, timed as never, {}, () => (clock += 1_000_000));
    expect(slow.result.stopped).toMatch(/^budget-(run|pattern)-wall-clock$/);
    expect(timed.mock.calls.length).toBeLessThan(10);
  }, 60_000);

  it('stops on a hung provider at the task deadline without retry and without hanging the run', async () => {
    const workload = generateDagLiveWorkload(21, 2);
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const { result, files } = await run(workload, fetch as never, { taskDeadlineMs: 1_000 });
    expect(result.stopped).toMatch(/^provider-(timeout|cancelled)$/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.pairs).toBe(0);
    expect(JSON.parse(files['calls.jsonl'])).toMatchObject({ status: expect.not.stringMatching(/^success$/), inputTokens: null });
    // Unknown usage keeps the whole reservation.
    expect(result.reserved).toMatchObject({ calls: 1, tokens: 4000 });
  }, 30_000);

  it('refuses a live run without the env gate and before any credential or transport use', async () => {
    const workload = generateDagLiveWorkload();
    await withRepo(async ({ source, artifacts, commit }) => {
      const resolveCredential = vi.fn();
      const executeFlow = vi.fn();
      await expect(runDagLiveQualification({ approval: approvalFor(workload, { sourceCommit: commit }), workload,
        preregistration: dagLivePreregistration(workload), sourceRoot: source, artifactRoot: artifacts, host: { resolveCredential },
        executeFlow, skillId })).rejects.toThrow('env gate');
      expect(resolveCredential).not.toHaveBeenCalled(); expect(executeFlow).not.toHaveBeenCalled();
    });
  });
});

describe('OpenBao Jev credential resolver', () => {
  it('passes the token only on stdin, returns the single secret value and never leaks messages', async () => {
    const runs: Array<{ command: string; args: string[]; input: Buffer | null }> = [];
    const resolver = createOpenBaoJevResolver({ address: 'https://bao.example.invalid', run: async (command: string, args: string[], input: Buffer | null) => {
      runs.push({ command, args, input: input ? Buffer.from(input) : null });
      return command === 'bash' ? Buffer.from('fixture-bao-token\n') : Buffer.from(JSON.stringify({ data: { data: { api_key: 'fixture-jev-key' } } }));
    } });
    expect(new TextDecoder().decode(await resolver(JEV_SECRET_REFERENCE))).toBe('fixture-jev-key');
    expect(runs[0]!.args.slice(1)).toEqual(['approle', 'aiwg-jev-reader']);
    expect(runs[1]!.args.join(' ')).not.toContain('fixture-bao-token');
    expect(runs[1]!.args).toContain('https://bao.example.invalid/v1/kv_internal/data/typesafe/jev/api-key');
    expect(runs[1]!.input!.toString()).toBe('X-Vault-Token: fixture-bao-token\n');
    await expect(resolver('openbao.other.secret')).rejects.toThrow('reference denied');
    const failing = createOpenBaoJevResolver({ address: 'https://bao.example.invalid', run: async () => { throw new Error('secret-bearing diagnostic'); } });
    await expect(failing(JEV_SECRET_REFERENCE)).rejects.toThrow(/^Jev credential resolution failed$/);
    const ambiguous = createOpenBaoJevResolver({ address: 'https://bao.example.invalid', run: async (command: string) => command === 'bash'
      ? Buffer.from('t') : Buffer.from(JSON.stringify({ data: { data: { a: 'x', b: 'y' } } })) });
    await expect(ambiguous(JEV_SECRET_REFERENCE)).rejects.toThrow('resolution failed');
    await expect(createOpenBaoJevResolver({ address: 'http://plain.example.invalid', run: vi.fn() })(JEV_SECRET_REFERENCE)).rejects.toThrow('configuration');
  });
});
