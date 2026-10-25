import { createHash } from 'node:crypto';
import { askDecision, type DecisionAskInput, type DecisionAskResult } from './ask.js';
import { BUNDLED_JEV_PRICING, tokenCost, validTokenPrice, type TokenPrice } from './pricing.js';
import type { DecisionConfig } from '../config/decision-config.js';
import { decisionSavingsWeights, estimateDecisionSavings } from './savings.js';

export type BenchmarkRates = NonNullable<NonNullable<DecisionConfig['ask']>['cost']>;
/** Require explicit rates and complete usage; defaults are not benchmark evidence. */
function observationCost(sample: BenchmarkObservation, rates: BenchmarkRates | undefined, baseline = false): number | null {
  if (sample.cost !== undefined) return sample.cost.usd;
  const usage = sample.usage;
  if (!rates || !usage || usage.inputTokens === null || usage.cachedInputTokens) return null;
  if (usage.outputTokens === null && (baseline || rates.jev_output_per_mtok !== 0 || rates.jev_input_per_mtok === undefined)) return null;
  if (baseline) {
    if (rates.llm_per_mtok === undefined) return null;
  } else {
    if (rates.jev_model && rates.jev_model !== sample.model) return null;
    if (!(rates.jev_input_per_mtok !== undefined && rates.jev_output_per_mtok !== undefined) && rates.jev_per_mtok === undefined) return null;
  }
  const weights = decisionSavingsWeights({ cost: baseline ? { jev_per_mtok: rates.llm_per_mtok } : rates });
  const cost = estimateDecisionSavings(0, false, usage.inputTokens + (usage.outputTokens ?? 0), weights, baseline ? null : usage);
  return -cost.cost_weighted_net_usd;
}
function validateRates(rates?: BenchmarkRates) {
  if (rates && Object.entries(rates).some(([key, value]) => /per_mtok$/.test(key) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000))) throw new Error('Invalid benchmark rates.');
}

export interface BenchmarkCase {
  id: string;
  split: 'tuning' | 'holdout';
  input: DecisionAskInput;
  expected: string | boolean | number;
}
export interface BenchmarkPrice extends TokenPrice { model: string; source: string; checkedAt: string }
export interface BenchmarkObservation {
  answer: string | boolean | number | null;
  confidence: number | null;
  probability?: number;
  status: 'answered' | 'fallback';
  model: string | null;
  usage: (NonNullable<DecisionAskResult['usage']> & { cachedInputTokens?: number | null }) | null;
  latencyMs: number;
  /** Captured sourced rate, bound to the served model; null is never a free call. */
  cost?: { usd: number | null; price: BenchmarkPrice | null };
}
export interface BenchmarkRow {
  id: string;
  baseline: BenchmarkObservation;
  jev: BenchmarkObservation[];
}
export interface BenchmarkPolicy { threshold: number; passes: number; agreement: number }
export interface BenchmarkCapture {
  schema: 'aiwg-decision-benchmark-capture/v1';
  datasetDigest: string;
  capturedAt: string;
  baselineLabel: string;
  rows: BenchmarkRow[];
  /** Interrupted captures retain real observations only and can be extended. */
  collection?: { stopReason: 'complete' | 'incomplete' | 'usd-limit' | 'unknown-cost'; calls: number; knownUsd: number };
}
export const BENCHMARK_PASS_COUNTS = [1, 3, 5, 10, 15, 20] as const;
export const MAX_BENCHMARK_PASSES = 20;

/** Descriptive collection totals, not policy-selection evidence. Missing usage stays unknown. */
export function benchmarkComparison(capture: BenchmarkCapture, pricing?: BenchmarkRates): string {
  validateRates(pricing);
  const money = (n: number | null) => n === null ? 'unknown' : `$${n.toFixed(8)}`;
  const totals = (samples: BenchmarkObservation[], baseline = false) => {
    const input = samples.every(s => s.usage?.inputTokens != null) ? samples.reduce((sum, s) => sum + s.usage!.inputTokens!, 0) : null;
    const output = samples.every(s => s.usage?.outputTokens != null) ? samples.reduce((sum, s) => sum + s.usage!.outputTokens!, 0) : null;
    const cached = samples.every(s => s.usage?.cachedInputTokens != null) ? samples.reduce((sum, s) => sum + s.usage!.cachedInputTokens!, 0) : null;
    const costs = samples.map(s => observationCost(s, pricing, baseline));
    return { input, output, cached, cost: costs.some(c => c === null) ? null : costs.reduce<number>((sum, c) => sum + c!, 0),
      latency: samples.length ? samples.reduce((sum, s) => sum + s.latencyMs, 0) / capture.rows.length : 0 };
  };
  const display = (n: number | null) => n === null ? 'unknown' : n.toLocaleString('en-US');
  const baseline = totals(capture.rows.map(r => r.baseline), true);
  const available = Math.min(...capture.rows.map(r => r.jev.length));
  const passCounts = [...new Set([...BENCHMARK_PASS_COUNTS.filter(n => n <= available), available])];
  const lines = [
    `Comparison across ${capture.rows.length} labeled decisions (tuning + holdout):`, '',
    '| Configuration | Input tokens | Cached input (subset) | Output tokens | Total tokens | Mean ms/decision | Estimated USD |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...passCounts.map(passes => {
      const samples = capture.rows.flatMap(r => r.jev.slice(0, passes));
      const t = totals(samples, false);
      return `| Jev, ${passes} pass${passes === 1 ? '' : 'es'} | ${display(t.input)} | n/a | ${display(t.output)} | ${display(t.input === null || t.output === null ? null : t.input + t.output)} | ${t.latency.toFixed(1)} | ${money(t.cost)} |`;
    }),
    `| ${capture.baselineLabel.replace(/[|\r\n]/g, ' ')} | ${display(baseline.input)} | ${display(baseline.cached)} | ${display(baseline.output)} | ${display(baseline.input === null || baseline.output === null ? null : baseline.input + baseline.output)} | ${baseline.latency.toFixed(1)} | ${money(baseline.cost)} |`, '',
    capture.rows.some(r => r.baseline.cost || r.jev.some(s => s.cost)) ? 'Captured costs use sourced rates recorded per observation; unknown costs remain unknown.' : pricing ? `Rates: decision.ask.cost.* (${pricing.source ?? 'manual'}, checked ${pricing.checked_at ?? 'unknown'}).` : 'Costs unknown: no explicit decision.ask.cost.* rates.',
    'Costs use reported usage and explicit pricing assumptions, not subscription invoices.',
    'Standalone baseline requests do not measure the marginal cost of an inline LLM decision.',
  ];
  return lines.join('\n');
}
export function benchmarkDigest(cases: BenchmarkCase[]): string {
  return createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}
export function validateBenchmarkCases(value: unknown): asserts value is BenchmarkCase[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 100) throw new Error('Benchmark needs 2..100 labeled cases.');
  const ids = new Set<string>();
  for (const c of value as BenchmarkCase[]) {
    if (!fields(c, ['id', 'split', 'input', 'expected']) || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(c.id) || ids.has(c.id) || !['tuning', 'holdout'].includes(c.split)
      || !fields(c.input, ['question', 'mode', 'context']) || (c.input.context !== undefined && (typeof c.input.context !== 'string' || c.input.context.length > 100_000)) || typeof c.input.question !== 'string' || !c.input.question.trim() || c.input.question.length > 10_000
      || !c.input.mode || !['yes-no', 'choices', 'scale'].includes(c.input.mode.kind)) throw new Error('Invalid or duplicate benchmark case.');
    const mode = c.input.mode;
    if (!fields(mode, mode.kind === 'choices' ? ['kind', 'choices'] : mode.kind === 'scale' ? ['kind', 'low', 'high'] : ['kind'])) throw new Error('Invalid decision mode fields.');
    if (mode.kind === 'yes-no' ? typeof c.expected !== 'boolean'
      : mode.kind === 'choices' ? !Array.isArray(mode.choices) || mode.choices.length < 2 || mode.choices.length > 100 || mode.choices.some(v => typeof v !== 'string' || !v.trim() || v.length > 1000) || new Set(mode.choices).size !== mode.choices.length || !mode.choices.includes(c.expected as string)
      : !Number.isSafeInteger(mode.low) || !Number.isSafeInteger(mode.high) || mode.low >= mode.high || typeof c.expected !== 'number' || !Number.isInteger(c.expected) || c.expected < mode.low || c.expected > mode.high) throw new Error('Gold answer does not match decision mode.');
    ids.add(c.id);
  }
  if (!value.some(c => c.split === 'tuning') || !value.some(c => c.split === 'holdout')) throw new Error('Both tuning and holdout cases are required.');
}
function validObservation(r: BenchmarkObservation): boolean {
  return !!r && ['answered', 'fallback'].includes(r.status) && (r.answer === null || ['string', 'number', 'boolean'].includes(typeof r.answer))
    && (typeof r.answer !== 'number' || Number.isFinite(r.answer))
    && (r.confidence === null || Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1)
    && (r.probability === undefined || Number.isFinite(r.probability) && r.probability >= 0 && r.probability <= 1)
    && Number.isFinite(r.latencyMs) && r.latencyMs >= 0
    && (r.model === null || typeof r.model === 'string')
    && (r.usage === null || [r.usage.inputTokens, r.usage.outputTokens].every(n => n === null || Number.isSafeInteger(n) && n >= 0))
    && (r.usage?.cachedInputTokens == null || Number.isSafeInteger(r.usage.cachedInputTokens) && r.usage.cachedInputTokens >= 0
      && r.usage.inputTokens !== null && r.usage.cachedInputTokens <= r.usage.inputTokens)
    && (r.status !== 'answered' || r.answer !== null);
}
function modeAnswer(c: BenchmarkCase, r: BenchmarkObservation): boolean {
  if (r.status !== 'answered') return true;
  const m = c.input.mode;
  return m.kind === 'yes-no' ? typeof r.answer === 'boolean' : m.kind === 'choices' ? m.choices.includes(r.answer as string)
    : typeof r.answer === 'number' && Number.isInteger(r.answer) && r.answer >= m.low && r.answer <= m.high;
}
export interface CollectBenchmarkOptions {
  live: boolean;
  maxCalls: number;
  maxUsd: number;
  passes: number;
  baselineLabel: string;
  baseline: (input: DecisionAskInput) => Promise<BenchmarkObservation>;
  jev?: (input: DecisionAskInput) => Promise<BenchmarkObservation>;
  baselinePrices?: BenchmarkPrice[];
  jevPrices?: BenchmarkPrice[];
  /** Reuse a complete Jev response set while collecting a new baseline. */
  jevCapture?: BenchmarkCapture;
  extendCapture?: BenchmarkCapture;
  holdout?: number;
  seed?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  onCheckpoint?: (capture: BenchmarkCapture) => Promise<void>;
}
function validPrice(price: BenchmarkPrice): boolean {
  return fields(price, ['model', 'source', 'checkedAt', 'inputPerMillionUsd', 'outputPerMillionUsd', 'cachedInputPerMillionUsd'])
    && validTokenPrice(price) && typeof price.model === 'string' && !!price.model.trim()
    && typeof price.source === 'string' && /^https:\/\//.test(price.source)
    && typeof price.checkedAt === 'string' && Number.isFinite(Date.parse(price.checkedAt));
}
function validCost(sample: BenchmarkObservation): boolean {
  if (sample.cost === undefined) return true;
  const cost = sample.cost;
  return fields(cost, ['usd', 'price']) && (cost.price === null ? cost.usd === null
    : validPrice(cost.price) && cost.price.model === sample.model && cost.usd === tokenCost(sample.usage, cost.price));
}

/** Opt-in only. One invocation is one provider call; production ask never calls this collector. */
export async function collectBenchmark(dataset: BenchmarkCase[], options: CollectBenchmarkOptions): Promise<BenchmarkCapture> {
  validateBenchmarkCases(dataset);
  if (options.live !== true || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 0)
    throw new Error('Explicit live opt-in and nonnegative maxCalls required.');
  if (!Number.isFinite(options.maxUsd) || options.maxUsd <= 0) throw new Error('Positive maxUsd required for live collection.');
  if (!Number.isInteger(options.passes) || options.passes < 1 || options.passes > MAX_BENCHMARK_PASSES)
    throw new Error('passes must be 1..20.');
  if (options.jevCapture && options.extendCapture) throw new Error('Cannot combine Jev reuse and capture extension.');
  const cases = splitBenchmarkHoldout(dataset, options.holdout ?? 0.3, options.seed ?? '3291');
  const prior = options.extendCapture;
  if (prior) validateBenchmarkCapture(cases, prior);
  const reused = options.jevCapture;
  if (reused) {
    validateBenchmarkCapture(cases, reused);
    if (reused.rows.length !== cases.length || reused.rows.some(row => row.jev.length !== options.passes))
      throw new Error('Reused Jev capture must contain every case with the same pass count.');
  }
  if (typeof options.baselineLabel !== 'string' || !options.baselineLabel.trim() || options.baselineLabel.length > 200
    || prior && prior.baselineLabel !== options.baselineLabel) throw new Error('Invalid or changed baseline label.');
  const jevPrices = options.jevPrices ?? Object.entries(BUNDLED_JEV_PRICING.models).map(([model, price]) => ({
    ...price, model, source: BUNDLED_JEV_PRICING.source, checkedAt: BUNDLED_JEV_PRICING.checkedAt,
  }));
  for (const prices of [jevPrices, options.baselinePrices ?? []]) {
    if (prices.some(p => !validPrice(p)) || new Set(prices.map(p => p.model)).size !== prices.length)
      throw new Error('Invalid or duplicate sourced model rates.');
  }
  const rows = structuredClone(prior?.rows ?? []);
  if (rows.some(row => row.jev.length > options.passes)) throw new Error('Extension cannot remove existing passes.');
  const planned = cases.reduce((sum, c) => {
    const row = rows.find(r => r.id === c.id);
    return sum + (row ? 0 : 1) + (reused ? 0 : Math.max(0, options.passes - (row?.jev.length ?? 0)));
  }, 0);
  if (planned > options.maxCalls) throw new Error(`Insufficient maxCalls: need ${planned}; no providers invoked.`);
  const now = options.now ?? Date.now;
  let calls = 0, knownUsd = 0;
  for (const row of rows) for (const [index, sample] of [row.baseline, ...row.jev].entries()) {
    // Legacy captures can acquire a sourced cost without changing their recorded response.
    if (!sample.cost) {
      const price = (index === 0 ? options.baselinePrices ?? [] : jevPrices).find(p => p.model === sample.model) ?? null;
      sample.cost = { usd: price ? tokenCost(sample.usage, price) : null, price: structuredClone(price) };
    }
    if (sample.cost.usd === null) throw new Error('Cannot safely extend an unpriced capture.');
    knownUsd += sample.cost.usd;
  }
  let stopReason: NonNullable<BenchmarkCapture['collection']>['stopReason'] = 'incomplete';
  const snapshot = (): BenchmarkCapture => ({ schema: 'aiwg-decision-benchmark-capture/v1',
    datasetDigest: benchmarkDigest(cases), capturedAt: new Date(now()).toISOString(),
    baselineLabel: options.baselineLabel, rows: structuredClone(rows), collection: { stopReason, calls, knownUsd } });
  if (planned === 0 || knownUsd >= options.maxUsd * 0.8) {
    stopReason = planned === 0 ? 'complete' : 'usd-limit';
    const capture = snapshot();
    validateBenchmarkCapture(cases, capture);
    if (options.onCheckpoint) await options.onCheckpoint(capture);
    return capture;
  }
  const environment = options.env ?? process.env;
  if (!reused && !options.jev && planned > 0 && cases.some(c => (rows.find(r => r.id === c.id)?.jev.length ?? 0) < options.passes)
    && !(environment.JEV_API_KEY?.trim() || environment.AIWG_DECISION_JEV_API_KEY?.trim()))
    throw new Error('Live benchmark requires JEV_API_KEY or AIWG_DECISION_JEV_API_KEY in the caller environment.');
  const jev = options.jev ?? (async (input: DecisionAskInput) => {
    // Force environment-only lookup; lookupJevCredential skips credential files with this explicit flag.
    return askDecision(input, { env: { ...environment, AIWG_DECISION_ENABLED: '1' }, now });
  });
  const invoke = async (c: BenchmarkCase, baseline: boolean): Promise<BenchmarkObservation> => {
    const started = now();
    calls++;
    let result: BenchmarkObservation;
    try {
      result = await (baseline ? options.baseline : jev)({ ...structuredClone(c.input), threshold: 0, passes: 1, escalationPasses: 1 });
    } catch {
      // No retry: a failed request can still be billable. Stop when its usage is unknown.
      result = { status: 'fallback', answer: null, confidence: null, model: null, usage: null, latencyMs: 0 };
    }
    const sample: BenchmarkObservation = { answer: result.answer, confidence: result.confidence, status: result.status,
      model: result.model, usage: structuredClone(result.usage), latencyMs: Math.max(0, now() - started),
      ...(result.probability === undefined ? {} : { probability: result.probability }) };
    if (!validObservation(sample) || !modeAnswer(c, sample)) throw new Error(`Invalid provider observation: ${c.id}`);
    const price = (baseline ? options.baselinePrices ?? [] : jevPrices).find(p => p.model === sample.model) ?? null;
    const usd = price ? tokenCost(sample.usage, price) : null;
    sample.cost = { usd, price: structuredClone(price) };
    if (usd === null) stopReason = 'unknown-cost';
    else { knownUsd += usd; if (knownUsd >= options.maxUsd * 0.8) stopReason = 'usd-limit'; }
    return sample;
  };
  for (const c of cases) {
    let row = rows.find(r => r.id === c.id);
    if (!row) {
      row = { id: c.id, baseline: await invoke(c, true),
        jev: structuredClone(reused?.rows.find(r => r.id === c.id)!.jev ?? []) };
      rows.push(row);
    }
    if (options.onCheckpoint) await options.onCheckpoint(snapshot());
    if (stopReason !== 'incomplete') break;
    while (row.jev.length < options.passes) {
      row.jev.push(await invoke(c, false));
      if (options.onCheckpoint) await options.onCheckpoint(snapshot());
      if (stopReason !== 'incomplete') break;
    }
    if (stopReason !== 'incomplete') break;
  }
  if (cases.every(c => rows.some(r => r.id === c.id && r.jev.length === options.passes))) stopReason = 'complete';
  const capture = snapshot();
  validateBenchmarkCapture(cases, capture);
  if (options.onCheckpoint) await options.onCheckpoint(capture);
  return capture;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
}
/** Sample SD: one observation cannot estimate variation and is reported as null. */
function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  return Math.sqrt(values.reduce((sum, n) => sum + (n - average) ** 2, 0) / (values.length - 1));
}
export function benchmarkScoringDeviation(cases: BenchmarkCase[], capture: BenchmarkCapture, passes: number) {
  validateBenchmarkCapture(cases, capture);
  if (!Number.isInteger(passes) || passes < 1 || passes > MAX_BENCHMARK_PASSES) throw new Error('Invalid deviation pass count.');
  const rows = cases.map(c => {
    const row = capture.rows.find(r => r.id === c.id);
    if (!row || row.jev.length < passes) throw new Error('Insufficient observations for deviation.');
    const samples = row.jev.slice(0, passes);
    const answered = samples.filter(r => r.status === 'answered' && r.answer !== null);
    const counts = new Map<string, number>();
    for (const r of answered) { const key = JSON.stringify(r.answer); counts.set(key, (counts.get(key) ?? 0) + 1); }
    const confidence = samples.flatMap(r => r.confidence === null ? [] : [r.confidence]);
    const scores = c.input.mode.kind === 'scale' ? answered.flatMap(r => typeof r.answer === 'number' ? [r.answer] : []) : [];
    const probabilities = c.input.mode.kind === 'yes-no' ? samples.flatMap(r => r.probability === undefined ? [] : [r.probability]) : [];
    return { id: c.id, split: c.split, kind: c.input.mode.kind, observations: samples.length, answered: answered.length,
      rawCorrect: answered.filter(r => r.answer === c.expected).length,
      nonModalAnswers: answered.length - Math.max(0, ...counts.values()),
      confidenceMean: mean(confidence), confidenceStdDev: sampleStdDev(confidence),
      scaleScoreMean: mean(scores), scaleScoreStdDev: sampleStdDev(scores),
      scaleScoreMin: scores.length ? Math.min(...scores) : null, scaleScoreMax: scores.length ? Math.max(...scores) : null,
      scaleMaeGold: mean(scores.map(n => Math.abs(n - Number(c.expected)))),
      scaleMaeBaseline: row.baseline.status === 'answered' && typeof row.baseline.answer === 'number'
        ? mean(scores.map(n => Math.abs(n - Number(row.baseline.answer)))) : null,
      yesNoBrier: mean(probabilities.map(p => (p - Number(c.expected)) ** 2)),
    };
  });
  const present = (values: (number | null)[]) => values.filter((n): n is number => n !== null);
  const answered = rows.reduce((sum, r) => sum + r.answered, 0);
  return { passes, observations: cases.length * passes, answered,
    rawAccuracy: rows.reduce((sum, r) => sum + r.rawCorrect, 0) / (cases.length * passes),
    answerDisagreementRate: answered ? rows.reduce((sum, r) => sum + r.nonModalAnswers, 0) / answered : null,
    meanConfidence: mean(present(rows.map(r => r.confidenceMean))),
    meanWithinCaseConfidenceStdDev: mean(present(rows.map(r => r.confidenceStdDev))),
    meanWithinCaseScaleScoreStdDev: mean(present(rows.map(r => r.scaleScoreStdDev))),
    meanScaleMaeGold: mean(present(rows.map(r => r.scaleMaeGold))),
    meanScaleMaeBaseline: mean(present(rows.map(r => r.scaleMaeBaseline))),
    meanYesNoBrier: mean(present(rows.map(r => r.yesNoBrier))), cases: rows };
}
function select(observations: BenchmarkObservation[], policy: BenchmarkPolicy) {
  const samples = observations.slice(0, policy.passes);
  const votes = new Map<string, { answer: string | boolean | number; count: number; confidence: number }>();
  for (const r of samples) {
    if (r.status !== 'answered' || r.answer === null || r.confidence === null) continue;
    const key = JSON.stringify(r.answer); const vote = votes.get(key) ?? { answer: r.answer, count: 0, confidence: 0 };
    vote.count++; vote.confidence += r.confidence; votes.set(key, vote);
  }
  const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
  const best = ranked[0];
  if (!best || ranked[1]?.count === best.count || best.count / policy.passes < policy.agreement
    || best.confidence / best.count < policy.threshold) return null;
  return best.answer;
}

/** Threshold/pass/consensus sweeps reuse captures. Holdout NEVER selects the policy. */
export function analyzeBenchmark(cases: BenchmarkCase[], capture: BenchmarkCapture, policies: BenchmarkPolicy[], pricing?: BenchmarkRates,
  options: { minimumAccuracy?: number; maximumFallbackRate?: number } = {}) {
  validateBenchmarkCases(cases);
  validateBenchmarkCapture(cases, capture);
  validateRates(pricing);
  if (capture.rows.length !== cases.length) throw new Error('Incomplete capture: extend before analysis.');
  if (!policies.length || policies.length > 100 || policies.some(p => !Number.isInteger(p.passes) || p.passes < 1 || p.passes > MAX_BENCHMARK_PASSES
    || !Number.isFinite(p.threshold) || p.threshold < 0 || p.threshold > 1 || !Number.isFinite(p.agreement) || p.agreement <= 0 || p.agreement > 1)) throw new Error('Invalid benchmark policy grid.');
  const minimumAccuracy = options.minimumAccuracy ?? 1;
  const maximumFallbackRate = options.maximumFallbackRate ?? 1;
  if (![minimumAccuracy, maximumFallbackRate].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Invalid benchmark quality limits.');
  const byId = new Map(capture.rows.map(r => [r.id, r]));
  for (const c of cases) {
    const row = byId.get(c.id);
    if (!row || !validObservation(row.baseline) || !modeAnswer(c, row.baseline) || !Array.isArray(row.jev)
      || row.jev.length < Math.max(...policies.map(p => p.passes)) || row.jev.some(r => !validObservation(r) || !modeAnswer(c, r))) throw new Error('Invalid or insufficient captured observations.');
  }
  const measurements = policies.map(policy => {
    const splits = (['tuning', 'holdout'] as const).map(split => {
      const selected = cases.filter(c => c.split === split);
      let accepted = 0, jevCorrect = 0, baselineCorrect = 0, routedCorrect = 0, agreements = 0;
      let jevUsd = 0, baselineUsd = 0, routedUsd = 0, unpriced = 0, unpricedJev = 0, unpricedBaseline = 0, jevMs = 0, baselineMs = 0, routedMs = 0;
      for (const c of selected) {
        const row = byId.get(c.id)!; const answer = select(row.jev, policy);
        const baselineCost = observationCost(row.baseline, pricing, true);
        let caseJevUsd = 0, caseJevMs = 0;
        let unknownJevCost = false;
        for (const r of row.jev.slice(0, policy.passes)) {
          const cost = observationCost(r, pricing);
          if (cost === null) unknownJevCost = true; else caseJevUsd += cost;
          caseJevMs += r.latencyMs;
        }
        if (unknownJevCost) unpricedJev++;
        if (baselineCost === null) unpricedBaseline++;
        if (unknownJevCost || baselineCost === null) unpriced++;
        jevUsd += caseJevUsd; baselineUsd += baselineCost ?? 0;
        routedUsd += caseJevUsd + (answer === null ? baselineCost ?? 0 : 0);
        jevMs += caseJevMs; baselineMs += row.baseline.latencyMs;
        routedMs += caseJevMs + (answer === null ? row.baseline.latencyMs : 0);
        if (row.baseline.status === 'answered' && row.baseline.answer === c.expected) baselineCorrect++;
        if (answer !== null) {
          accepted++; if (answer === c.expected) jevCorrect++;
          if (row.baseline.status === 'answered' && answer === row.baseline.answer) agreements++;
        }
        if ((answer ?? (row.baseline.status === 'answered' ? row.baseline.answer : null)) === c.expected) routedCorrect++;
      }
      return { split, cases: selected.length, accepted, fallbackRate: 1 - accepted / selected.length,
        selectiveAccuracy: accepted ? jevCorrect / accepted : null,
        baselineAccuracy: baselineCorrect / selected.length, routedAccuracy: routedCorrect / selected.length,
        agreementWithBaseline: accepted ? agreements / accepted : null,
        estimatedJevUsd: unpricedJev ? null : jevUsd, baselineUsd: unpricedBaseline ? null : baselineUsd,
        routedUsd: unpriced ? null : routedUsd, savingsUsd: unpriced ? null : baselineUsd - routedUsd,
        unpricedCases: unpriced, meanJevMs: jevMs / selected.length, meanBaselineMs: baselineMs / selected.length,
        meanRoutedMs: routedMs / selected.length };
    });
    return { policy, tuning: splits[0], holdout: splits[1] };
  });
  const eligible = measurements.filter(m => m.tuning.routedAccuracy >= minimumAccuracy && m.tuning.fallbackRate <= maximumFallbackRate);
  // With no comparable USD rate, use measured routed latency rather than inventing a price.
  const useCost = eligible.every(m => m.tuning.routedUsd !== null);
  eligible.sort((a, b) => (useCost ? a.tuning.routedUsd! - b.tuning.routedUsd! : a.tuning.meanRoutedMs - b.tuning.meanRoutedMs)
    || b.policy.threshold - a.policy.threshold);
  return { schema: 'aiwg-decision-benchmark-report/v1', datasetDigest: capture.datasetDigest,
    baselineLabel: capture.baselineLabel, pricing: pricing ?? null,
    minimumAccuracy, maximumFallbackRate, recommended: eligible[0]?.policy ?? null, measurements,
    scoringDeviation: [...new Set(policies.map(p => p.passes))].sort((a, b) => a - b).map(passes => benchmarkScoringDeviation(cases, capture, passes)),
    deviationDefinitions: {
      scaleScoreStdDev: 'Within-case sample SD of raw 1-N scale scores, averaged across scale cases; null for one pass.',
      confidenceStdDev: 'Within-case sample SD of reported confidence (0..1), averaged across cases; not a calibration guarantee.',
      answerDisagreementRate: 'Fraction of answered passes differing from their case modal answer; categorical labels are never assigned numeric scores.',
      scaleMae: 'Mean absolute difference of raw scale scores against gold labels or the saved LLM score; expressed in scale points.',
      yesNoBrier: 'Mean squared error of reported truth probability against gold boolean labels; null when probability is unavailable.',
    },
    limitations: ['Small labeled benchmark; LLM agreement is not ground truth.',
      'Recommendations use tuning cases only; evaluate holdout before adoption. No configuration is changed.',
      'Serial pass latency; modeled routing cost includes LLM cost on fallbacks. Benchmark collection itself pays both arms.',
      'Repeated Jev passes may be correlated; identical answers are not independent confidence evidence.',
      'Standalone baseline requests do not estimate marginal reasoning inside an existing conversation.',
      'Legacy captures may lack cached-input counts; cache-aware prices then leave costs unknown. No subscription invoice is inferred.',
      'Prices are API-equivalent estimates, not subscription invoices. Missing usage or rates makes savings unknown.'] };
}

export function benchmarkDeviationComparison(report: ReturnType<typeof analyzeBenchmark>): string {
  const format = (n: number | null, multiplier = 1) => n === null ? 'n/a' : (n * multiplier).toFixed(4);
  return [
    'Scoring deviation across repeated passes:', '',
    '| Passes | Raw accuracy % | Mean confidence % | Confidence SD (pp) | Scale-score SD (points) | Scale MAE vs gold | Answer disagreement % | Yes/no Brier |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...report.scoringDeviation.map(d => `| ${d.passes} | ${format(d.rawAccuracy, 100)} | ${format(d.meanConfidence, 100)} | ${format(d.meanWithinCaseConfidenceStdDev, 100)} | ${format(d.meanWithinCaseScaleScoreStdDev)} | ${format(d.meanScaleMaeGold)} | ${format(d.answerDisagreementRate, 100)} | ${format(d.meanYesNoBrier)} |`), '',
    'SD is the within-case sample standard deviation, averaged across applicable cases. One pass cannot estimate SD (n/a).',
    'Scale scores use their original rubric points; categorical answers have no numeric score. Raw accuracy counts every pass, before confidence-based routing.',
    'Pass-count rows are nested prefixes of one capture, not independent experiments; repeated calls may be correlated.',
  ].join('\n');
}

export const MAX_BENCHMARK_BYTES = 4 * 1024 * 1024;
function fields(value: unknown, allowed: string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
}
/** Captures contain values only: no paths, executable hooks, or provider settings. */
export function validateBenchmarkCapture(cases: BenchmarkCase[], value: unknown): asserts value is BenchmarkCapture {
  validateBenchmarkCases(cases);
  const c = value as BenchmarkCapture;
  if (!fields(c, ['schema', 'datasetDigest', 'capturedAt', 'baselineLabel', 'rows', 'collection'])
    || c.schema !== 'aiwg-decision-benchmark-capture/v1' || c.datasetDigest !== benchmarkDigest(cases)
    || typeof c.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(c.capturedAt) || !Number.isFinite(Date.parse(c.capturedAt))
    || typeof c.baselineLabel !== 'string' || !c.baselineLabel.trim() || c.baselineLabel.length > 200
    || !Array.isArray(c.rows) || c.rows.length > cases.length
    || ((!c.collection || c.collection.stopReason === 'complete') && c.rows.length !== cases.length)
    || new Set(c.rows.map(r => r?.id)).size !== c.rows.length) throw new Error('Capture does not match this dataset or schema.');
  if (c.collection !== undefined && (!fields(c.collection, ['stopReason', 'calls', 'knownUsd'])
    || !['complete', 'incomplete', 'usd-limit', 'unknown-cost'].includes(c.collection.stopReason)
    || !Number.isSafeInteger(c.collection.calls) || c.collection.calls < 0
    || !Number.isFinite(c.collection.knownUsd) || c.collection.knownUsd < 0)) throw new Error('Invalid collection totals.');
  const observation = (r: BenchmarkObservation) => fields(r, ['answer', 'confidence', 'probability', 'status', 'model', 'usage', 'latencyMs', 'cost'])
    && (r.usage === null || fields(r.usage, ['inputTokens', 'outputTokens', 'cachedInputTokens'])) && validObservation(r) && validCost(r);
  for (const row of c.rows) {
    const item = cases.find(item => item.id === row?.id);
    if (!fields(row, ['id', 'baseline', 'jev']) || !item || !observation(row.baseline) || !modeAnswer(item, row.baseline)
      || !Array.isArray(row.jev) || row.jev.length < (c.collection && c.collection.stopReason !== 'complete' ? 0 : 1) || row.jev.length > MAX_BENCHMARK_PASSES
      || row.jev.some(r => !observation(r) || !modeAnswer(item, r))) throw new Error('Invalid captured observations.');
  }
  if (Buffer.byteLength(JSON.stringify(c)) > MAX_BENCHMARK_BYTES) throw new Error('Capture exceeds size limit.');
}

/** Stable by ID and seed, independent of file order and observed answers. */
export function splitBenchmarkHoldout(cases: BenchmarkCase[], fraction: number, seed = '3291'): BenchmarkCase[] {
  validateBenchmarkCases(cases);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) throw new Error('Holdout fraction must be between 0 and 1.');
  const count = Math.max(1, Math.min(cases.length - 1, Math.round(cases.length * fraction)));
  const hash = (id: string) => createHash('sha256').update(JSON.stringify([seed, id])).digest('hex');
  const ids = new Set([...cases].sort((a, b) => hash(a.id).localeCompare(hash(b.id))).slice(0, count).map(c => c.id));
  return cases.map(c => ({ ...c, split: ids.has(c.id) ? 'holdout' : 'tuning' }));
}
