import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateDagLiveWorkload, dagLivePreregistration, dagLiveDefinitions, DAG_LIVE_PATTERNS, DAG_LIVE_TAXONOMY,
  type DagLiveWorkload, type DagLiveTask } from '../../../src/decision/graph-live-workload.js';
import { analyzeDagLivePattern, buildDagLiveArms, DagLiveBudget, dagLiveDigest, DAG_LIVE_DEFAULT_LIMITS, DAG_LIVE_SOURCE_GOLDENS,
  dagLiveChargeMicros, dagLivePriorSpend, dagLiveReservationMicros, DAG_LIVE_RESERVE_FLOOR_USD_PER_MTOK, loadDagLiveResolver,
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
    ...structuredClone(DAG_LIVE_DEFAULT_LIMITS), priceBound: { ...structuredClone(DAG_LIVE_DEFAULT_LIMITS.priceBound), approvalReference: 'offline-fixture-attestation' },
    priorSpendUsd: 0, secretService: structuredClone(SECRET_SERVICE), ...overrides };
}
const BAO_ORIGIN = 'https://bao.example.invalid';
const SECRET_PATH = 'kv_internal/data/typesafe/jev/api-key';
const SECRET_SERVICE = { origin: BAO_ORIGIN, secretPathDigest: `sha256:${createHash('sha256').update(SECRET_PATH).digest('hex')}` as const };
const PRICE = { ...DAG_LIVE_DEFAULT_LIMITS.priceBound, approvalReference: 'offline-fixture-attestation' };

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

async function run(workload: DagLiveWorkload, fetch: typeof globalThis.fetch, overrides: Partial<DagLiveApproval> = {}, now?: () => number,
  seed?: (artifacts: string) => Promise<void>) {
  return withRepo(async ({ source, artifacts, commit }) => {
    await seed?.(artifacts);
    const approval = approvalFor(workload, { sourceCommit: commit, ...overrides });
    const issued: Uint8Array[] = [];
    const resolveCredential = vi.fn(async () => { const key = new TextEncoder().encode('fixture-secret-value'); issued.push(key); return key; });
    const result = await runDagLiveQualification({ approval, workload, preregistration: dagLivePreregistration(workload), sourceRoot: source,
      artifactRoot: artifacts, host: { resolveCredential }, executeFlow: executeFlowGraph, skillId, transport: fetch, ...(now ? { now } : {}) }) as any;
    const directory = join(artifacts, approval.runId);
    const read = async (name: string) => readFile(join(directory, name), 'utf8');
    const files = Object.fromEntries(await Promise.all(['summary.json', 'pairs.jsonl', 'calls.jsonl', 'run-manifest.json', 'evidence-manifest.json',
      'g5-load-result.json', 'g6-review-request.json'].map(async name => [name, await read(name)])));
    const decisions = { hold: await recordDagLiveDecision(directory, 'hold', 'roctinam', 'synthetic offline run').catch(error => error as Error) };
    return { result, files, resolveCredential, directory, decisions, issued };
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

  it('validates the approval, including the USD 2.00 hard cap and the operator-attested price bound', () => {
    const workload = generateDagLiveWorkload(11, 3);
    const preregistration = dagLivePreregistration(workload);
    expect(() => validateDagLiveApproval(approvalFor(workload), workload, preregistration)).not.toThrow();
    const cases: Array<Partial<DagLiveApproval> | Record<string, unknown>> = [
      { budget: { ...DAG_LIVE_DEFAULT_LIMITS.budget, usd: 2.01 } },
      { priceBound: undefined }, { price: { ceilingUsdPerMTok: 0.1 } },
      { priceBound: { ...PRICE, approvalReference: '<operator approval reference>' } },
      { priceBound: { ...PRICE, evidenceReferences: [] } }, { priceBound: { ...PRICE, inputUsdPerMTok: -1 } },
      { priceBound: { ...PRICE, perRequestUsd: 0 } }, { priceBound: { ...PRICE, unknown: 1 } },
      { priorSpendUsd: -0.01 }, { priorSpendUsd: undefined },
      // The approver must be the preregistered promotion owner.
      { reviewer: 'someone-else' },
      // The vault origin and secret path are pinned: missing, plain HTTP, pathful or malformed pins are refused.
      { secretService: undefined }, { secretService: { ...SECRET_SERVICE, origin: 'http://bao.example.invalid' } },
      { secretService: { ...SECRET_SERVICE, origin: 'https://bao.example.invalid/v1' } },
      { secretService: { ...SECRET_SERVICE, secretPathDigest: SECRET_PATH } }, { secretService: { ...SECRET_SERVICE, extra: 1 } },
      { budget: { ...DAG_LIVE_DEFAULT_LIMITS.budget, perPattern: { ...DAG_LIVE_DEFAULT_LIMITS.budget.perPattern, calls: 5_000 } } },
      { model: 'jev-latest' }, { approved: false as never }, { workloadDigest: `sha256:${'c'.repeat(64)}` }, { extra: 1 },
    ];
    for (const change of cases) expect(() => validateDagLiveApproval({ ...approvalFor(workload), ...change } as DagLiveApproval, workload, preregistration)).toThrow();
  });
});

describe('D12 budget, plan and stop rules', () => {
  const limits = structuredClone(DAG_LIVE_DEFAULT_LIMITS);
  it('reserves the worst case before dispatch and refuses at 80% of each dimension', () => {
    const tight = (budget: Partial<DagLiveApproval['budget']>) => ({ ...limits, priceBound: PRICE, budget: { ...limits.budget, ...budget } });
    const used = (inputTokens: number, outputTokens = 0) => ({ inputTokens, outputTokens });
    const calls = new DagLiveBudget(tight({ calls: 5 }), 4000, 0.8, 0, () => 0);
    for (let i = 0; i < 4; i++) calls.reserve('taxonomy-beam')(used(100));
    expect(() => calls.reserve('taxonomy-beam')).toThrow('budget-run-calls');
    const usd = new DagLiveBudget(tight({ usd: 0.001 }), 4000, 0.8, 0, () => 0);
    usd.reserve('taxonomy-beam')(null); // unknown usage keeps the full USD 0.0004 reservation
    usd.reserve('taxonomy-beam')(used(3990, 10));
    expect(() => usd.reserve('taxonomy-beam')).toThrow('budget-run-usd');
    expect(usd.total.usdMicros).toBe(800);
    const pattern = new DagLiveBudget({ ...limits, priceBound: PRICE, budget: { ...limits.budget, perPattern: { ...limits.budget.perPattern, tokens: 7_000 } } }, 4000, 0.8, 0, () => 0);
    pattern.reserve('shortlist-rerank')(used(1000));
    pattern.reserve('shortlist-rerank')(used(1000));
    expect(pattern.total.tokens).toBe(2000);
    expect(() => pattern.reserve('shortlist-rerank')).toThrow('budget-pattern-tokens');
    expect(() => pattern.reserve('taxonomy-beam')).not.toThrow();
    let clock = 0; const time = new DagLiveBudget({ ...limits, priceBound: PRICE }, 4000, 0.8, 0, () => clock);
    clock = limits.budget.wallClockMs * 0.8; expect(() => time.reserve('taxonomy-beam')).toThrow('budget-run-wall-clock');
  });

  it('reserves against the larger of the attested price and the USD 0.10/1M floor, and charges actual usage above the reservation', () => {
    expect(DAG_LIVE_RESERVE_FLOOR_USD_PER_MTOK).toBe(0.1);
    // Attested USD 0.042 input / free output: the floor governs the reservation.
    expect(dagLiveReservationMicros(PRICE, 4000)).toBe(400);
    expect(dagLiveChargeMicros(PRICE, 369, 38)).toBe(41);
    // A higher attested price raises both the reservation and the charge.
    const dear = { ...PRICE, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2 };
    expect(dagLiveReservationMicros(dear, 4000)).toBe(8000);
    expect(dagLiveChargeMicros(dear, 1000, 100)).toBe(700);
    // An attested per-request price is a floor on every reservation and charge.
    const perRequest = { ...PRICE, perRequestUsd: 0.01 };
    expect(dagLiveReservationMicros(perRequest, 4000)).toBe(10_000);
    expect(dagLiveChargeMicros(perRequest, 10, 0)).toBe(10_000);
    // Usage reported above the reservation is charged in full, never capped at the reservation.
    const budget = new DagLiveBudget({ ...limits, priceBound: PRICE }, 4000, 0.8, 0, () => 0);
    budget.reserve('taxonomy-beam')({ inputTokens: 4500, outputTokens: 8 });
    expect(budget.total).toMatchObject({ calls: 1, tokens: 4508, usdMicros: 451 });
  });

  it('plans worst-case calls, tokens and USD without any provider call, and flags a budget that cannot cover it', () => {
    const workload = generateDagLiveWorkload();
    const preregistration = dagLivePreregistration(workload);
    const plan = planDagLiveQualification(workload, preregistration, { ...limits, priceBound: PRICE });
    expect(plan.providerCalls).toBe(0);
    expect(plan.totals).toMatchObject({ worstCaseCalls: 1100, worstCaseTokens: 4_400_000, worstCaseReservedUsd: 0.44, hardCapUsd: 2 });
    expect(plan.withinBudget).toBe(true);
    expect(plan.boundCoversLargestEstimate).toBe(true);
    expect(planDagLiveQualification(workload, preregistration, { ...limits, priceBound: PRICE, budget: { ...limits.budget, calls: 1_000 } }).withinBudget).toBe(false);
    // A higher attested price is reserved even though the floor alone would fit.
    expect(planDagLiveQualification(workload, preregistration, { ...limits, priceBound: { ...PRICE, inputUsdPerMTok: 1 } }).withinBudget).toBe(false);
  });

  it('stops a pattern whose calls exceed three times its Flow baseline', () => {
    const pair = (calls: number) => ({ pattern: 'taxonomy-beam', baseline: { calls: 1 }, candidate: { calls } }) as unknown as DagLivePair;
    expect(patternCallRatioExceeded([pair(3), pair(3)], 'taxonomy-beam', 3)).toBe(false);
    expect(patternCallRatioExceeded([pair(3), pair(4)], 'taxonomy-beam', 3)).toBe(true);
  });

  it('treats any node able to request an action or permission as a speculative-action stop', () => {
    const task = generateDagLiveWorkload(11, 2).tasks.find(t => t.pattern === 'taxonomy-beam')!;
    const arms = buildDagLiveArms(task, { model: MODEL, secretServiceReference: JEV_SECRET_REFERENCE, skillId, perCallTokenBound: 4000,
      reservationMicros: 400, taskDeadlineMs: 60_000 });
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
  const price = PRICE;
  function pairs(options: { baselineWrong?: number; candidateWrong?: number; candidateCalls?: number; candidateLatency?: number; candidateTokens?: number; n?: number } = {}): DagLivePair[] {
    return workload.tasks.filter(task => task.pattern === 'taxonomy-beam').slice(0, options.n ?? 100).map((task, index) => ({
      pattern: 'taxonomy-beam', taskId: task.id, slice: task.slice, index, order: index % 2 ? 'candidate-first' : 'baseline-first', label: task.label,
      baseline: { answer: null, correct: index >= (options.baselineWrong ?? 10), calls: 1, inputTokens: 600, outputTokens: 8, latencyMs: 100 + index, requestIds: [] },
      candidate: { answer: null, correct: index >= (options.candidateWrong ?? 10), calls: options.candidateCalls ?? 3, inputTokens: options.candidateTokens ?? 1800,
        outputTokens: 24, latencyMs: (options.candidateLatency ?? 300) + index, requestIds: [], outcome: 'complete', receiptDigest: 'x', unusedCalls: 0, unusedTokens: 0 },
    }));
  }
  it('excludes measurement-failure tasks from the paired table and applies the preregistered 5% tolerance', () => {
    const policy = preregistration.analysis.providerFailurePolicy;
    expect(policy).toMatchObject({ retriesPerCall: 1, maxMeasurementFailureFractionPerPattern: 0.05, beyondTolerance: 'pattern-insufficient-evidence' });
    const failed = (rows: DagLivePair[], count: number) => rows.map((row, index) => index < count
      ? { ...row, baseline: { ...row.baseline, correct: false }, candidate: { ...row.candidate, correct: false, outcome: 'measurement-failure' },
        measurementFailure: { arm: 'candidate' as const, node: 'detail-branch-a', reason: 'provider-invalid-output' } } : row);
    // Five failed tasks (5%): excluded from Newcombe, the pattern can still be eligible.
    const within = analyzeDagLivePattern('taxonomy-beam', failed(pairs(), 5), preregistration, price);
    expect(within.measurementFailures).toBe(5);
    expect(within.n).toBe(95);
    expect(within.quality.difference!.n).toBe(95);
    // The excluded tasks were the first rows, which were wrong in both arms: they are not in the table.
    expect(within.quality.table).toEqual({ both: 90, candidateOnly: 0, baselineOnly: 0, neither: 5 });
    expect(within.verdict).toBe('eligible');
    expect(within.eligible).toBe(true);
    // Six failed tasks exceed the tolerance: insufficient evidence, never eligible, whatever the quality.
    const beyond = analyzeDagLivePattern('taxonomy-beam', failed(pairs(), 6), preregistration, price);
    expect(beyond.verdict).toBe('insufficient-evidence');
    expect(beyond.eligible).toBe(false);
    // A regressed candidate is still not eligible within tolerance.
    expect(analyzeDagLivePattern('taxonomy-beam', failed(pairs({ candidateWrong: 25 }), 2), preregistration, price).verdict).toBe('not-eligible');
  });

  it('bases the call ratio on first attempts: retries are charged and reported, not counted as graph calls', () => {
    const retried = pairs().map((row, index) => index < 10 ? { ...row, candidate: { ...row.candidate, retries: 1 } } : row);
    const analysis = analyzeDagLivePattern('taxonomy-beam', retried, preregistration, price);
    expect(analysis.economics.callRatio).toBe(3);
    expect(analysis.economics.retries).toEqual({ baseline: 0, candidate: 10 });
    expect(patternCallRatioExceeded(retried, 'taxonomy-beam', 3)).toBe(false);
  });

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
    const { result, files, resolveCredential, decisions, issued } = await run(workload, fetch as never);
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
    // The array the resolver returned is zeroed once copied.
    expect(issued).toHaveLength(1);
    expect(issued[0]!.every(byte => byte === 0)).toBe(true);
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
      // The decision is checked against the run's preregistered owner, and that file is digest-bound.
      const preregistered = JSON.parse(await readFile(join(directory, 'preregistration.json'), 'utf8'));
      await rm(join(directory, 'preregistration.json'));
      await writeFile(join(directory, 'preregistration.json'), JSON.stringify({ ...preregistered, promotionOwner: 'mallory' }));
      await expect(recordDagLiveDecision(directory, 'hold', 'roctinam', 'n/a')).rejects.toThrow('preregistration');
      await rm(join(directory, 'preregistration.json'));
      await writeFile(join(directory, 'preregistration.json'), JSON.stringify(preregistered));
      const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
      await rm(join(directory, 'summary.json'));
      await writeFile(join(directory, 'summary.json'), JSON.stringify({ ...summary, recommendation: 'eligible-for-promotion-review', liveEvidence: true }));
      await expect(recordDagLiveDecision(directory, 'promote', 'roctinam', 'forged')).rejects.toThrow('does not bind');
    });
  }, 60_000);

  it.each([
    ['a different served model', 'served-model-mismatch', async (response: Response) => {
      const body = await response.json(); body.model = 'other-model';
      return new Response(JSON.stringify(body), { headers: response.headers });
    }],
    ['usage above the per-call reservation', 'usage-exceeded-reservation', async (response: Response) => {
      const body = await response.json(); body.usage.input_tokens = 4_500;
      return new Response(JSON.stringify(body), { headers: response.headers });
    }],
    ['a missing request identity', 'missing-request-id', async (response: Response) => {
      const headers = new Headers(response.headers); headers.delete('x-request-id');
      return new Response(await response.text(), { headers });
    }],
  ])('stops immediately, without retry, on %s and keeps completed pairs', async (_name, reason, mutate) => {
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
    const calls = files['calls.jsonl'].trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(5);
    expect(result.analyses.some((a: any) => a.eligible)).toBe(false);
    // The stopping request's reported usage is evidence and is charged to spend.
    const summary = JSON.parse(files['summary.json']);
    expect(summary.stoppingCall).toEqual(calls[4]);
    expect(summary.spend.providerCalls).toBe(5);
    expect(summary.spend.inputTokens).toBe(calls.reduce((sum: number, call: any) => sum + (call.inputTokens ?? 0), 0));
    const charged = { 'served-model-mismatch': 608, 'usage-exceeded-reservation': 4508, 'missing-request-id': 608 }[reason]!;
    expect(result.reserved.tokens).toBe(4 * 608 + charged);
    expect(summary.spend.chargedUsd).toBe(result.reserved.usd);
    if (reason === 'usage-exceeded-reservation') expect(summary.stoppingCall).toMatchObject({ inputTokens: 4500, outputTokens: 8 });
    expect(JSON.parse(files['run-manifest.json']).evidence.every((row: any) => row.outcome === 'fail')).toBe(true);
  }, 60_000);

  it.each([
    ['an invalid output (HTTP 200, null usage)', 'provider-invalid-output', async () => new Response('{"model":"jev-fixture-model","answers":{}}',
      { headers: { 'content-type': 'application/json', 'x-request-id': 'invalid-1' } })],
    ['a 5xx', 'provider-service-error', async () => new Response('private provider text', { status: 503, headers: { 'x-request-id': 'fail-1' } })],
    ['a rate limit', 'provider-rate-limited', async () => new Response('private provider text', { status: 429 })],
    ['missing token usage', 'unknown-usage', async (response: Response) => {
      const body = await response.json(); delete body.usage.input_tokens;
      return new Response(JSON.stringify(body), { headers: response.headers });
    }],
  ])('retries once after %s, charges both attempts and completes the run', async (_name, reason, mutate) => {
    const workload = generateDagLiveWorkload(21, 4);
    const inner = oracle(workload);
    let requests = 0;
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      const response = await inner(url, init);
      return ++requests === 5 ? mutate(response) : response;
    });
    const { result, files } = await run(workload, fetch as never);
    expect(result.stopped).toBeNull();
    expect(result.pairs).toBe(12);
    const calls = files['calls.jsonl'].trim().split('\n').map(line => JSON.parse(line));
    expect(calls[4]).toMatchObject({ attempt: 1, outcome: reason });
    expect(calls[5]).toMatchObject({ attempt: 2, outcome: 'ok', taskId: calls[4].taskId, node: calls[4].node, arm: calls[4].arm });
    expect(calls).toHaveLength(fetch.mock.calls.length);
    // Every attempt was reserved and charged; the retried attempt is reported, not counted as a graph call.
    expect(result.reserved.calls).toBe(fetch.mock.calls.length);
    const pair = files['pairs.jsonl'].trim().split('\n').map(line => JSON.parse(line)).find((row: any) => row.taskId === calls[4].taskId);
    expect(pair.measurementFailure).toBeUndefined();
    expect(pair[calls[4].arm].retries).toBe(1);
    expect(Object.values(files).join('')).not.toContain('private provider text');
  }, 60_000);

  it('records a task that fails twice as a measurement failure in both arms and carries on', async () => {
    const workload = generateDagLiveWorkload(21, 4);
    const inner = oracle(workload);
    let requests = 0;
    const invalid = () => new Response('{"model":"jev-fixture-model","answers":{}}', { headers: { 'content-type': 'application/json', 'x-request-id': 'bad' } });
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      const response = await inner(url, init);
      return [5, 6].includes(++requests) ? invalid() : response;
    });
    const { result, files } = await run(workload, fetch as never);
    expect(result.stopped).toBeNull();
    const pairs = files['pairs.jsonl'].trim().split('\n').map(line => JSON.parse(line));
    const failed = pairs.filter((row: any) => row.measurementFailure);
    expect(failed).toHaveLength(1);
    expect(failed[0].measurementFailure).toMatchObject({ reason: 'provider-invalid-output' });
    // With 4 tasks per pattern the 5% tolerance allows none, so that pattern is abandoned as
    // insufficient evidence; the other patterns still complete. The run is not stopped.
    const byPattern = Object.fromEntries(result.analyses.map((a: any) => [a.pattern, a]));
    const failedPattern = failed[0].pattern;
    expect(byPattern[failedPattern].verdict).toBe('insufficient-evidence');
    expect(byPattern[failedPattern].measurementFailures).toBe(1);
    expect(result.abandonedPatterns).toEqual([failedPattern]);
    for (const pattern of DAG_LIVE_PATTERNS.filter(p => p !== failedPattern)) expect(byPattern[pattern].n).toBe(4);
    expect(result.recommendation).toBe('hold');
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

  it('treats a hung provider as a measurement failure after one retry and never hangs the run', async () => {
    const workload = generateDagLiveWorkload(21, 2);
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const { result, files } = await run(workload, fetch as never, { taskDeadlineMs: 1_000 });
    expect(result.stopped).toBeNull();
    // Each pattern loses its first task (tolerance 0 of 2) and is abandoned as insufficient evidence.
    expect(result.abandonedPatterns).toEqual([...DAG_LIVE_PATTERNS]);
    expect(result.analyses.every((a: any) => a.verdict === 'insufficient-evidence')).toBe(true);
    const calls = files['calls.jsonl'].trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map((call: any) => call.attempt)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(calls.every((call: any) => call.inputTokens === null && call.chargedTokens === 4000)).toBe(true);
    // Unknown usage keeps the whole reservation for every attempt.
    expect(result.reserved).toMatchObject({ calls: 6, tokens: 24_000 });
    expect(result.recommendation).toBe('hold');
  }, 60_000);

  it('holds the USD 2.00 cap across reruns: earlier summaries, crashed runs and the operator floor all count', async () => {
    const workload = generateDagLiveWorkload(21, 2);
    const seed = async (artifacts: string) => {
      await mkdir(join(artifacts, 'earlier-complete'));
      await writeFile(join(artifacts, 'earlier-complete', 'approval.json'), JSON.stringify(approvalFor(workload, { runId: 'earlier-complete' })));
      await writeFile(join(artifacts, 'earlier-complete', 'summary.json'), JSON.stringify({ schemaVersion: 'dag-live-summary/v1', spend: { chargedUsd: 1.998 } }));
      // A crashed run, nested below the root, has no summary: each logged call counts at its charged amount
      // (a line without one at the reservation), plus one call in flight at the reservation.
      await mkdir(join(artifacts, 'team', 'earlier-crashed'), { recursive: true });
      await writeFile(join(artifacts, 'team', 'earlier-crashed', 'approval.json'), JSON.stringify(approvalFor(workload, { runId: 'earlier-crashed' })));
      await writeFile(join(artifacts, 'team', 'earlier-crashed', 'calls.jsonl'), '{"chargedUsdMicros":500}\n{}\n');
      await mkdir(join(artifacts, 'unrelated')); await writeFile(join(artifacts, 'unrelated', 'summary.json'), '{"spend":{"chargedUsd":5}}');
    };
    await withRepo(async ({ artifacts }) => {
      await seed(artifacts);
      expect(await dagLivePriorSpend(artifacts)).toEqual({ usd: 1.9993, runs: ['earlier-complete', 'team/earlier-crashed'] });
    });
    // Only USD 0.0007 remains: the run stops at 80% of it, before a reservation could pass the cap.
    const fetch = oracle(workload);
    const { result, files } = await run(workload, fetch as never, {}, undefined, seed);
    expect(result).toMatchObject({ priorSpendUsd: 1.9993, effectiveRunUsdCap: 0.0007, stopped: 'budget-run-usd' });
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(result.spend.chargedUsd).toBeLessThanOrEqual(0.0007 * 0.8);
    expect(result.spend.chargedUsd + 0.0004).toBeGreaterThan(0.0007 * 0.8);
    expect(result.priorSpendUsd + result.spend.chargedUsd).toBeLessThan(2);
    expect(JSON.parse(files['g5-load-result.json']).manifest.bounds.reservedUsdMicros).toBe(700);
    // The operator value is a floor: it applies even when no earlier run is on disk.
    await withRepo(async ({ source, artifacts, commit }) => {
      const resolveCredential = vi.fn();
      await expect(runDagLiveQualification({ approval: approvalFor(workload, { sourceCommit: commit, priorSpendUsd: 1.9997 }), workload,
        preregistration: dagLivePreregistration(workload), sourceRoot: source, artifactRoot: artifacts, host: { resolveCredential },
        executeFlow: executeFlowGraph, skillId, transport: oracle(workload) as never })).rejects.toThrow('prior spend');
      expect(resolveCredential).not.toHaveBeenCalled();
    });
  }, 60_000);

  it('accepts only the canonical artifact root itself, so a subdirectory cannot reset the cap', async () => {
    const workload = generateDagLiveWorkload(21, 2);
    await withRepo(async ({ source, artifacts, commit }) => {
      await mkdir(join(artifacts, 'sub'));
      const resolveCredential = vi.fn();
      await expect(runDagLiveQualification({ approval: approvalFor(workload, { sourceCommit: commit }), workload,
        preregistration: dagLivePreregistration(workload), sourceRoot: source, artifactRoot: join(artifacts, 'sub'), host: { resolveCredential },
        executeFlow: executeFlowGraph, skillId, transport: oracle(workload) as never })).rejects.toThrow('canonical artifact root');
      expect(resolveCredential).not.toHaveBeenCalled();
    });
  });

  it('loads the resolver from the same bytes it digests and refuses any pin mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'd12-resolver-'));
    try {
      const file = join(dir, 'resolver.mjs');
      const bytes = 'import { createHash } from "node:crypto";\nexport function createOpenBaoJevResolver() { return async () => new Uint8Array([createHash("sha256").digest().length]); }\n';
      await writeFile(file, bytes);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
      const loaded = await loadDagLiveResolver(file, digest, digest);
      expect(typeof loaded.createOpenBaoJevResolver).toBe('function');
      await expect(loadDagLiveResolver(file, digest, `sha256:${'c'.repeat(64)}`)).rejects.toThrow('resolver-pin');
      await writeFile(file, bytes + '// swapped\n');
      await expect(loadDagLiveResolver(file, digest, digest)).rejects.toThrow('resolver-pin');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('runs the dry run and --freeze from source without building dist', () => {
    const out = join(tmpdir(), `d12-freeze-${process.pid}-${Date.now()}`);
    // CI may already hold a built dist/, so assert these paths leave it exactly as they found it.
    const built = 'dist/src/decision/graph-live-qualification.js';
    const before = existsSync(built) ? statSync(built).mtimeMs : null;
    try {
      const dry = spawnSync(process.execPath, ['tools/decision/dag-live-qualification.mjs'], { encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, AIWG_DECISION_DAG_LIVE: '' } });
      expect(dry.status).toBe(0);
      const plan = JSON.parse(dry.stdout);
      expect(plan).toMatchObject({ providerCalls: 0, withinBudget: true, totals: { worstCaseCalls: 1100, worstCaseReservedUsd: 0.44 } });
      expect(plan.approvalTemplate.priceBound).toMatchObject({ inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 });
      const freeze = spawnSync(process.execPath, ['tools/decision/dag-live-qualification.mjs', '--freeze', out], { encoding: 'utf8', timeout: 120_000 });
      expect(freeze.status).toBe(0);
      expect(readFileSync(join(out, 'workload.json'), 'utf8')).toBe(readFileSync(`${frozen}/workload.json`, 'utf8'));
      expect(readFileSync(join(out, 'preregistration.json'), 'utf8')).toBe(readFileSync(`${frozen}/preregistration.json`, 'utf8'));
      // Neither path compiled the runtime: dist output is unchanged.
      expect(existsSync(built) ? statSync(built).mtimeMs : null).toBe(before);
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 150_000);

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
  type Call = { url: string; options: any };
  function fixture(options: { secret?: unknown; status?: number; env?: Record<string, string>; pin?: unknown; token?: string } = {}) {
    const calls: Call[] = [];
    const helper = vi.fn(async () => options.token ?? 'fixture-bao-token');
    const request = vi.fn(async (url: string, requestOptions: any) => {
      calls.push({ url, options: requestOptions });
      if (url.endsWith('/revoke-self')) return { status: 204, body: Buffer.alloc(0) };
      return { status: options.status ?? 200, body: Buffer.from(JSON.stringify({ data: { data: options.secret ?? { token: 'fixture-jev-key', note: 'other' } } })) };
    });
    const resolver = createOpenBaoJevResolver({ env: { BAO_ADDR: BAO_ORIGIN, ...options.env }, acquireToken: helper, request,
      pin: 'pin' in options ? (options as any).pin : SECRET_SERVICE });
    return { resolver, calls, helper, request };
  }
  it('reads the `token` field over verified TLS, then revokes its own vault token', async () => {
    const { resolver, calls, helper } = fixture();
    expect(new TextDecoder().decode(await resolver(JEV_SECRET_REFERENCE))).toBe('fixture-jev-key');
    expect(helper).toHaveBeenCalledWith('aiwg-jev-reader', expect.anything());
    expect(calls.map(call => [call.options.method, call.url])).toEqual([
      ['GET', 'https://bao.example.invalid/v1/kv_internal/data/typesafe/jev/api-key'],
      ['POST', 'https://bao.example.invalid/v1/auth/token/revoke-self']]);
    for (const call of calls) {
      expect(call.options.rejectUnauthorized).toBe(true);
      expect(call.options.headers['x-vault-token']).toBe('fixture-bao-token');
      expect(call.url).not.toContain('fixture-bao-token');
    }
  });
  it('revokes the vault token even when the read fails', async () => {
    const { resolver, calls } = fixture({ status: 403 });
    await expect(resolver(JEV_SECRET_REFERENCE)).rejects.toThrow('(read)');
    expect(calls.at(-1)!.url).toMatch(/revoke-self$/);
  });
  it.each([
    ['a TLS verification override', { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }, 'configuration'],
    ['a plain-HTTP secret service', { env: { BAO_ADDR: 'http://bao.example.invalid' } }, 'configuration'],
    ['a secret without the token field', { secret: { api_key: 'fixture-jev-key' } }, 'shape'],
    ['a vault origin other than the pinned one', { env: { BAO_ADDR: 'https://attacker.example.invalid' } }, 'configuration'],
    ['a secret path other than the pinned one', { env: { AIWG_JEV_OPENBAO_SECRET_PATH: 'kv_internal/data/other/secret' } }, 'configuration'],
    ['a missing approval pin', { pin: undefined }, 'configuration'],
  ])('refuses %s with a fixed category and no secret material', async (_name, options, category) => {
    const { resolver, request, helper } = fixture(options as never);
    const error = await resolver(JEV_SECRET_REFERENCE).catch(value => value as Error);
    expect(error.message).toBe(`Jev credential resolution failed (${category})`);
    // Configuration is refused before any vault token exists or is sent anywhere.
    if (category === 'configuration') { expect(helper).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); }
  });
  it('revokes a helper token that fails validation, and never sends a header-unsafe one', async () => {
    const odd = fixture({ token: 'short' });
    await expect(odd.resolver(JEV_SECRET_REFERENCE)).rejects.toThrow('(login)');
    expect(odd.calls.map(call => call.url)).toEqual([`${BAO_ORIGIN}/v1/auth/token/revoke-self`]);
    const unsafe = fixture({ token: 'bad\ntoken-value' });
    await expect(unsafe.resolver(JEV_SECRET_REFERENCE)).rejects.toThrow('(login)');
    expect(unsafe.request).not.toHaveBeenCalled();
  });
  it('never exposes the key, path or vault token in errors', async () => {
    const failing = createOpenBaoJevResolver({ env: { BAO_ADDR: BAO_ORIGIN }, pin: SECRET_SERVICE,
      acquireToken: async () => { throw new Error('fixture-bao-token kv_internal/data/typesafe/jev/api-key fixture-jev-key'); }, request: vi.fn() });
    const error = await failing(JEV_SECRET_REFERENCE).catch(value => value as Error);
    expect(error.message).toBe('Jev credential resolution failed (login)');
    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toMatch(/fixture-bao-token|kv_internal|fixture-jev-key/);
    await expect(fixture().resolver('openbao.other.secret')).rejects.toThrow('(reference)');
  });
});
