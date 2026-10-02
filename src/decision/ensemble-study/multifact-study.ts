import { createHash } from 'node:crypto';
import { heldoutApprovalTemplate, heldoutDigest, heldoutRequestSize, heldoutReservationMicros, heldoutReservationTokens,
  validateHeldoutAttempt, validateHeldoutInputs } from '../heldout/contract.js';
import { heldoutCollectionAllowance } from '../heldout/journal.js';
import type { Digest, HeldoutApproval, HeldoutAttempt, HeldoutCorpus, HeldoutPreregistration, HeldoutRow } from '../heldout/types.js';
import type { CalibrationArtifact } from '../calibration/types.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';
import { wilsonScoreInterval } from '../qualification/quality.js';
import { D17_MULTIFACT_GENERATOR_ID, studyHeldoutGeneratorDigest } from '../heldout/study-generators.js';
import { applyD17Mapping, d17AttemptsByRow, d17NativeYes, qualifyD17Calibration, type D17CalibrationMapping } from './calibration.js';
import { D17_CALIBRATION } from './protocol.js';
import { D17MF_CELLS, D17MF_DEFINITION, D17MF_HOPS, D17MF_OUTCOMES, D17MF_POOL_IDS, D17MF_POOLS, D17MF_ROWS, D17MF_TEST_COUNTS,
  cellKey, d17MfGenerateCase, d17MfTextOracle, type D17MfLabel, type D17MfOutcome, type D17MfPoolId, type D17MfWorld } from './multifact.js';
import { validateD17MultifactArtifact } from './multifact-artifacts.js';

/**
 * D17-MF: preregistered, calibrated probe of Jev's multi-fact degradation (#2850).
 *
 * Primary reasoning metrics are threshold-free of any calibrator: the raw native answer (P(yes) > 0.5) and the AUROC of
 * the raw P(yes) between yes rows and missing-link rows. The registered D17 member calibrator was fitted on the pool-b
 * grammar, so calibrated answers would confound pool contrasts with where that calibrator sets its threshold; calibrated
 * metrics serve only the calibration-under-shift rule.
 *
 * Calibration choice: collector artifact mode binds the registered D17 calibration set, and the member calibrator is
 * applied to the single fresh call per row. A calibrator fitted on the shifted pools would absorb exactly the
 * miscalibration under shift this probe measures. The calibrator is re-derived from the D17 seal and qualified at bundle
 * time, at collection end and at the scoring clock; it is never trusted unverified and never skipped.
 */
export const D17MF_ARTIFACT_EXPIRY = '2026-11-01T10:02:38.000Z';
export const D17MF_PROTOCOL = Object.freeze({
  schemaVersion: 'decision-d17mf-protocol/v2', issue: 'roctinam/aiwg#2850', study: 'D17', generator: D17_MULTIFACT_GENERATOR_ID,
  design: Object.freeze({ pools: D17MF_POOL_IDS, hops: D17MF_HOPS, outcomes: D17MF_OUTCOMES, layouts: ['equalized', 'd17-faithful'],
    counts: D17MF_TEST_COUNTS, developmentPerCell: 2, rows: D17MF_ROWS,
    keyCells: 'equalized missing-link cells: 3 pools x 2 hops x 3 written encodings, plus pure absence at 3 hops; 220 rows each (Wilson 95% half-width 0.066 at p = 0.5)',
    supportingCells: 'equalized yes (110) and relay-off (40) cells and D17-faithful control cells (30)',
    rule: 'equalized cells state an exhaustive link-only rule; the D17-faithful control keeps the original D17 rule',
    order: 'equalized fact lines are shuffled uniformly; the rule line is last',
    sizeBound: 'one corpus stays inside the shared credential-scan traversal limit (100,000 nodes, 17 per row)',
    limitation: 'within a pool the link verb and the framing sentence co-vary (no verb x framing cross-cell fits the row bound), so H1 attributes a pool difference to the pool wording as a whole',
    dispatchOrder: 'development rows first, then test rows in a seeded Fisher-Yates permutation keyed by the corpus seed digest',
    requestsPerRow: 1, request: 'champion: one fresh call of jev-1.13.0 with the D17 DecisionDefinition' }),
  metrics: Object.freeze({
    primary: ['raw native answer accuracy (P(yes) > 0.5) per cell, Wilson 95%',
      'AUROC of the raw P(yes), yes rows vs missing-link rows per pool x hops (pooled and per encoding), Hanley-McNeil 95%'],
    secondary: 'calibrated accuracy, calibrated confidence and decile ECE through the registered D17 member calibrator; used only by the calibration-under-shift rule',
    positions: 'failure position as first, interior or last link (or relay); accuracy is reported by position' }),
  calibration: Object.freeze({ mode: 'artifact', calibrator: D17_CALIBRATION.calibrators.member.id,
    binding: 'approval.calibration.calibrationArtifactDigest = registered D17 calibration set digest',
    verification: 'the D17 calibration set is re-derived from its sealed calibration phase; the member artifact is qualified at bundle time, at collection end and at the scoring clock',
    expiresAt: D17MF_ARTIFACT_EXPIRY, profile: D17_CALIBRATION.profile }),
  interval: Object.freeze({ cell: 'wilson', difference: 'newcombe-hybrid-score-independent', auroc: 'hanley-mcneil', levelBps: 9500 }),
  multiplicity: Object.freeze({ method: 'holm', alpha: 0.05, test: 'two-sided two-proportion z (pooled)', families: ['H1 pool-pair contrasts', 'H4 per-pool layout contrasts'] }),
  coverage: Object.freeze({ minimumObservedFraction: 0.95, rule: 'every preregistered test cell must reach it; otherwise the report is incomplete and every verdict is "insufficient"' }),
  scoringClock: 'evaluatedAt is at least the latest collection end recorded by the collector (qualification.json generatedAt across the run lineage) and at most now; scoring happens at the exact approved source commit',
  hypotheses: Object.freeze([
    Object.freeze({ id: 'H1', name: 'wording', claim: 'Missing-link raw accuracy depends on the wording pool at fixed hops and encoding.' }),
    Object.freeze({ id: 'H2', name: 'depth', claim: 'Raw accuracy falls from one relay hop to three at fixed pool, outcome and failure position (first or last).' }),
    Object.freeze({ id: 'H3', name: 'missing-link-polarity', claim: 'A missing link is read as established (permissive linking), while a disabled relay is handled.' }),
    Object.freeze({ id: 'H3a', name: 'encoding', claim: 'The failure is specific to the contrastive verb rather than to missing links in general (pure absence is the baseline).' }),
    Object.freeze({ id: 'H4', name: 'layout', claim: 'At one hop and the last link, the D17-faithful rendering differs from the equalized rendering (rule wording, line order, decoys, names).' }),
  ]),
  decisionRules: Object.freeze({
    H1: 'supported when, for some missing-link encoding, a pool-pair raw-accuracy contrast is Holm-significant (family-wise 0.05) with |difference| >= 0.10 at every hop level the encoding has',
    H2: 'supported when, for some outcome, raw accuracy(h3) - accuracy(h1), restricted to first- and last-position failures, has a Newcombe 95% upper bound below -0.05 in at least 2 of 3 pools',
    H3: 'supported when, in every pool (pooled over hops), relay-off minus missing-link raw accuracy has a 95% lower bound above 0.10 for some encoding and that encoding is answered "yes" on more than half its rows',
    H3a: '"contrastive-specific" when, in at least 2 pools, contrastive raw accuracy is below both negation and the non-connective verb (95% upper bound below 0 and |difference| >= 0.15); "general" when the three written encodings are within 0.10 of each other and all below relay-off; otherwise "mixed"; the pure-absence baseline is reported against interior-position contrastive rows',
    H4: 'supported when some pool shows a Holm-significant raw-accuracy difference (d17-faithful minus equalized, one hop, last-link failures, missing-contrastive)',
    replication: 'the D17 failure replicates when pool-c d17-faithful missing-contrastive raw accuracy has a Wilson 95% upper bound at most 0.50',
    calibrationUnderShift: 'a cell is calibration-unreliable when mean calibrated confidence minus calibrated accuracy exceeds 0.10 and the calibrated accuracy upper bound is below the mean confidence',
  }),
  shortcutAudit: Object.freeze({ population: 'equalized test rows, per pool x hops, target gold yes/no', folds: 5, limit: 0.6,
    learners: ['cross-validated best single scalar threshold', 'cross-validated best token-count threshold', 'cross-validated depth-2 tree over scalar features',
      'cross-validated L2 logistic regression over scalar features'],
    features: ['line count', 'character length', 'digit count', 'word count', 'cue counts (link, contrastive, negation, non-connective, enabled, disabled)',
      'per cue class: mean, minimum and maximum normalized line position', 'positions of the first lines mentioning the query subject and destination and their order',
      'classes of the first and last fact lines', 'distinct entities', 'query subject and destination mentions', 'token counts with entity names abstracted'],
    positiveControl: 'the chain-first line order of the earlier layout must fail the audit (regression-tested)',
    control: 'd17-faithful rows are audited separately and reported; they reproduce D17 and are expected to be cue-solvable' }),
  budget: 'shares the D17 study cap (USD 8) with the D17 runs: the approval attests all prior D17 and program spend as floors; this study budget is USD 5',
  promotion: 'none: a diagnostic probe of the provider; the study decision is always HOLD',
});

/** Public and review seeds can regenerate gold from source; they never back a paid collection. */
export const D17MF_PUBLIC_SEEDS: readonly string[] = ['d17mf-offline', 'd17mf-public-demo', 'd17mf-smoke', 'review-throwaway-a1', 'review-throwaway-b2'];
export function assertD17MultifactPrivateSeed(seed: string): void {
  if (D17MF_PUBLIC_SEEDS.includes(seed) || /^(review-|d17mf-(offline|public|smoke|sweep|demo))/.test(seed)) refuse('public-seed');
}

type Prepared = ReturnType<typeof prepareD17MultifactStudy>;
interface Gold { schemaVersion: 'decision-d17mf-gold/v1'; labels: Record<string, D17MfLabel>; worlds: Record<string, D17MfWorld> }
const refuse = (reason: string): never => { const error = new Error(`D17-MF refused (${reason})`) as Error & { reason: string }; error.reason = reason; throw error; };

// ---------- shortcut audit ----------
const NAME = /\b[A-Z][a-z0-9]{4}\b/g;
const CLASSES = ['relation', 'contrastive', 'negation', 'unrelated', 'enabled', 'disabled'] as const;
function lineClass(line: string, pool: D17MfPoolId): number {
  const p = D17MF_POOLS[pool];
  if (line.includes(' does not ')) return 2;
  if (line.includes(` ${p.contrastive} `)) return 1;
  if (line.includes(` ${p.unrelated} `)) return 3;
  if (line.includes(` ${p.relation} `)) return 0;
  if (line.endsWith(` is ${p.enabled}.`)) return 4;
  if (line.endsWith(` is ${p.disabled}.`)) return 5;
  return 6;
}
export function d17MultifactFeatures(payload: string, pool: D17MfPoolId) {
  const facts = payload.split('\nFacts:\n')[1]!.split('\nQuestion:')[0]!.split('\n').slice(0, -1);
  const q = /can reach (\S+)\?$/.exec(payload)![1]!, s = /established that (\S+) can reach/.exec(payload)![1]!;
  const classes = facts.map(line => lineClass(line, pool)), span = Math.max(1, facts.length - 1);
  const words = payload.replace(NAME, 'ENTITY').split(/\s+/).filter(Boolean);
  const mentions = (name: string) => facts.map((line, i) => line.split(/[ .]/).includes(name) ? i : -1).filter(i => i >= 0);
  const subj = mentions(s), dest = mentions(q);
  const scalar: Record<string, number> = { lines: facts.length, chars: payload.length, digits: (payload.match(/\d/g) ?? []).length, words: words.length,
    entities: new Set(facts.join(' ').match(NAME) ?? []).size, subjectMentions: subj.length, destinationMentions: dest.length,
    subjectFirstPos: subj.length ? subj[0]! / span : -1, destinationFirstPos: dest.length ? dest[0]! / span : -1,
    subjectBeforeDestination: subj.length && dest.length ? Number(subj[0]! < dest[0]!) : -1,
    firstLineClass: classes[0] ?? -1, lastLineClass: classes.at(-1) ?? -1 };
  CLASSES.forEach((name, c) => {
    const positions = classes.map((k, i) => k === c ? i / span : -1).filter(v => v >= 0);
    scalar[name] = positions.length;
    scalar[`meanPos_${name}`] = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : -1;
    scalar[`minPos_${name}`] = positions.length ? Math.min(...positions) : -1;
    scalar[`maxPos_${name}`] = positions.length ? Math.max(...positions) : -1;
  });
  const tokens: Record<string, number> = {};
  for (const w of words) tokens[w] = (tokens[w] ?? 0) + 1;
  return { scalar, tokens };
}
function balanced(rows: ReadonlyArray<{ y: boolean; predict: boolean }>) {
  const pos = rows.filter(r => r.y), neg = rows.filter(r => !r.y);
  if (!pos.length || !neg.length) return 0.5;
  return (pos.filter(r => r.predict).length / pos.length + neg.filter(r => !r.predict).length / neg.length) / 2;
}
type Rule = (x: Record<string, number>) => boolean;
type Example = { x: Record<string, number>; y: boolean; id: string };
function bestThreshold(train: readonly Example[], keys: readonly string[]): Rule {
  let best: { score: number; rule: Rule } = { score: -1, rule: () => false };
  for (const key of keys) {
    const values = [...new Set(train.map(r => r.x[key] ?? 0))].sort((a, b) => a - b);
    for (const t of values) for (const above of [true, false]) {
      const rule: Rule = x => above ? (x[key] ?? 0) >= t : (x[key] ?? 0) < t;
      const score = balanced(train.map(r => ({ y: r.y, predict: rule(r.x) })));
      if (score > best.score) best = { score, rule };
    }
  }
  return best.rule;
}
function stumpTree(train: readonly Example[], keys: readonly string[]): Rule {
  const root = bestThreshold(train, keys), left = train.filter(r => root(r.x)), right = train.filter(r => !root(r.x));
  const l = left.length ? bestThreshold(left, keys) : () => false, r = right.length ? bestThreshold(right, keys) : () => false;
  return x => root(x) ? l(x) : r(x);
}
/** Class-balanced L2 logistic regression on standardized features (fixed iterations and step: deterministic). */
function logistic(train: readonly Example[], keys: readonly string[]): Rule {
  const mean = keys.map(k => train.reduce((s, r) => s + (r.x[k] ?? 0), 0) / train.length);
  const sd = keys.map((k, j) => Math.sqrt(train.reduce((s, r) => s + ((r.x[k] ?? 0) - mean[j]!) ** 2, 0) / train.length) || 1);
  const z = (x: Record<string, number>) => keys.map((k, j) => ((x[k] ?? 0) - mean[j]!) / sd[j]!);
  const pos = train.filter(r => r.y).length, neg = train.length - pos, w = new Array(keys.length + 1).fill(0);
  const data = train.map(r => ({ v: z(r.x), y: Number(r.y), weight: r.y ? 0.5 / Math.max(1, pos) : 0.5 / Math.max(1, neg) }));
  for (let it = 0; it < 200; it++) {
    const g = new Array(keys.length + 1).fill(0);
    for (const d of data) {
      const p = 1 / (1 + Math.exp(-(w[0] + d.v.reduce((s, v, j) => s + v * w[j + 1], 0))));
      const e = (p - d.y) * d.weight; g[0] += e; d.v.forEach((v, j) => { g[j + 1] += e * v; });
    }
    for (let j = 0; j < w.length; j++) w[j] -= 0.5 * (g[j] + (j ? 0.01 * w[j] : 0));
  }
  return x => w[0] + z(x).reduce((s, v, j) => s + v * w[j + 1], 0) > 0;
}
function crossValidated(rows: readonly Example[], learn: (train: readonly Example[]) => Rule, folds: number) {
  const ordered = [...rows].sort((a, b) => a.id < b.id ? -1 : 1), predictions: Array<{ y: boolean; predict: boolean }> = [];
  for (let k = 0; k < folds; k++) {
    const rule = learn(ordered.filter((_, i) => i % folds !== k));
    for (const r of ordered.filter((_, i) => i % folds === k)) predictions.push({ y: r.y, predict: rule(r.x) });
  }
  return +balanced(predictions).toFixed(4);
}
/** D29-style shortcut audit, counts and line order included: no surface learner may predict gold above the limit. */
export function d17MultifactShortcutAudit(corpus: HeldoutCorpus, gold: Gold) {
  const { folds, limit } = D17MF_PROTOCOL.shortcutAudit;
  const groups = new Map<string, Array<{ x: Record<string, number>; t: Record<string, number>; y: boolean; id: string }>>();
  for (const row of corpus.rows.filter(r => r.split === 'test')) {
    const world = gold.worlds[row.id]!, key = `${world.layout}:${world.pool}:h${world.hops}`;
    const f = d17MultifactFeatures(String((row.input as { payload: string }).payload), world.pool);
    groups.set(key, [...(groups.get(key) ?? []), { x: f.scalar, t: f.tokens, y: gold.labels[row.id] === 'yes', id: row.id }]);
  }
  const results = [...groups].sort(([a], [b]) => a < b ? -1 : 1).map(([group, rows]) => {
    const scalarKeys = Object.keys(rows[0]!.x).sort(), tokenKeys = [...new Set(rows.flatMap(r => Object.keys(r.t)))].sort();
    const tokenRows = rows.map(r => ({ x: r.t, y: r.y, id: r.id }));
    const scores = { scalarThreshold: crossValidated(rows, train => bestThreshold(train, scalarKeys), folds),
      tokenThreshold: crossValidated(tokenRows, train => bestThreshold(train, tokenKeys), folds),
      depth2Tree: crossValidated(rows, train => stumpTree(train, scalarKeys), folds),
      logistic: crossValidated(rows, train => logistic(train, scalarKeys), folds) };
    const max = Math.max(...Object.values(scores));
    return { group, n: rows.length, yes: rows.filter(r => r.y).length, scores, max, passes: group.startsWith('d17-faithful') ? null : max <= limit };
  });
  const equalized = results.filter(r => r.passes !== null);
  const audit = { schemaVersion: 'decision-d17mf-shortcut-audit/v2', limit, folds, groups: results,
    equalizedPasses: equalized.every(r => r.passes), equalizedMax: Math.max(...equalized.map(r => r.max)),
    controlMax: Math.max(...results.filter(r => r.passes === null).map(r => r.max)) };
  return audit;
}

// ---------- preparation ----------
function reviewTemplate(rows: readonly HeldoutRow[], gold: Gold) {
  // 40 development items spread over outcomes, pools, hops and layouts in allocation order (absence included).
  const picked: HeldoutRow[] = [], per = [8, 7, 7, 6, 6, 6];
  D17MF_OUTCOMES.forEach((outcome, o) => {
    const candidates = rows.filter(r => r.split === 'tuning' && gold.worlds[r.id]!.outcome === outcome);
    const byKey = new Map<string, HeldoutRow[]>();
    for (const r of candidates) byKey.set(r.slice, [...(byKey.get(r.slice) ?? []), r]);
    const keys = [...byKey.keys()].sort();
    for (let i = 0, taken = 0; taken < per[o]!; i++) { const item = byKey.get(keys[i % keys.length]!)![Math.floor(i / keys.length)]; if (item) { picked.push(item); taken++; } }
  });
  return { schemaVersion: 'decision-d17mf-review/v1', reviewer: null, preregistrationReview: null,
    assessments: picked.map((row, i) => ({ assessmentId: `mf-assessment-${String(i + 1).padStart(2, '0')}`, rowId: row.id, cell: row.slice,
      inputDigest: heldoutDigest(row.input), payload: String((row.input as { payload: string }).payload),
      reviewedAt: null, goldAuditLabel: null, goldAmbiguousOrIncorrect: null, rationale: null })),
    instructions: 'Label each development payload yes/no from the facts and rule alone, flag ambiguity, give a rationale and the review time, then compare with gold and the text oracle. Any ambiguous or incorrect gold stops the probe.' };
}
/** Seeded Fisher-Yates over the test rows: dispatch interleaves cells instead of collecting them in blocks. */
function dispatchOrder(rows: HeldoutRow[], seed: string): HeldoutRow[] {
  const development = rows.filter(r => r.split !== 'test'), test = rows.filter(r => r.split === 'test');
  const key = `aiwg-holdout-2850-v1:D17MF:dispatch:${heldoutDigest(seed)}`;
  let counter = 0;
  const next = (bound: number) => { const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) { const v = createHash('sha256').update(`${key}:${counter++}`).digest().readUInt32BE(0); if (v < limit) return v % bound; } };
  for (let i = test.length - 1; i > 0; i--) { const j = next(i + 1); [test[i], test[j]] = [test[j]!, test[i]!]; }
  return [...development, ...test];
}

export function prepareD17MultifactStudy(seed: string, moduleDigest: Digest, sourceDigests: Record<string, Digest>) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(seed) || !/^sha256:[a-f0-9]{64}$/.test(moduleDigest)
    || !Object.keys(sourceDigests).length || Object.values(sourceDigests).some(v => !/^sha256:[a-f0-9]{64}$/.test(v))) throw new Error('D17-MF source or seed pins');
  const generated: HeldoutRow[] = [];
  const gold: Gold = { schemaVersion: 'decision-d17mf-gold/v1', labels: {}, worlds: {} };
  for (let index = 0; index < D17MF_ROWS; index++) {
    const rowSeed = `${seed}:${index}:single`, { row, world, label } = d17MfGenerateCase(rowSeed);
    if (d17MfTextOracle(String(row.input.payload)) !== label) throw new Error('D17-MF oracle disagreement');
    gold.labels[row.id] = label; gold.worlds[row.id] = world;
    generated.push({ ...row, provenance: { generatorId: D17_MULTIFACT_GENERATOR_ID, seed: rowSeed, outputDigest: heldoutDigest(row) } });
  }
  const rows = dispatchOrder(generated, seed);
  const corpus: HeldoutCorpus = { schemaVersion: 'decision-heldout-corpus/v1', study: 'D17', syntheticOnly: true,
    provenance: { kind: 'authored-synthetic', generatorDigest: studyHeldoutGeneratorDigest(D17_MULTIFACT_GENERATOR_ID), seed, goldDigest: heldoutDigest(gold) },
    definitions: [structuredClone(D17MF_DEFINITION)], rows };
  const audit = d17MultifactShortcutAudit(corpus, gold);
  validateD17MultifactArtifact('audit', audit);
  if (!audit.equalizedPasses) throw new Error('D17-MF shortcut audit');
  const analysis = { schemaVersion: 'decision-d17mf-analysis/v2', protocol: D17MF_PROTOCOL, sourceDigests, auditDigest: heldoutDigest(audit),
    dispatchOrderDigest: heldoutDigest(rows.map(r => r.id)),
    cells: D17MF_CELLS.map(c => ({ split: c.split, key: cellKey(c), rule: c.rule, count: c.count })) };
  validateD17MultifactArtifact('analysis', analysis);
  const preregistration: HeldoutPreregistration = { schemaVersion: 'decision-heldout-preregistration/v1', study: 'D17',
    frozenAt: '2026-10-02T00:00:00Z', corpusDigest: heldoutDigest(corpus), studyAnalysisDigest: heldoutDigest(analysis), scorerDigest: moduleDigest,
    calibration: { scope: 'calibrated', allowedModes: ['artifact'] },
    providerFailurePolicy: { maxRetries: 1, maximumSliceFailureBps: 500, retryOnlyTerminal: true }, perRequestTokenBound: 4000,
    outputAndHiddenTokenAllowance: 256, providerOverheadTokens: 512, requestTimeoutMs: 60000, minDispatchIntervalMs: 1000, sessionLimitMs: 1800000 };
  validateHeldoutInputs(corpus, preregistration);
  const base = heldoutApprovalTemplate(corpus, preregistration);
  const approvalTemplate = { ...base, budget: { ...D17MF_BUDGET }, calibration: { mode: 'artifact', calibrationArtifactDigest: null },
    priceBound: { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
      evidenceReferences: ['https://www.eesel.ai/blog/typesafe-jev-pricing', 'https://www.mindstudio.ai/blog/jev-pricing-cost-per-token', 'roctinam/aiwg#2613 comment 153093'],
      approvalReference: null } };
  const review = reviewTemplate(generated, gold);
  validateD17MultifactArtifact('reviewTemplate', review);
  return { corpus, preregistration, gold, analysis, audit, approvalTemplate, reviewTemplate: review };
}
/** Study budget: USD 5 cap (program-authorized for #2850, inside the shared USD 8 D17 cap); calls and tokens leave headroom at the 80% stop. */
export const D17MF_BUDGET = Object.freeze({ calls: 16000, tokens: 30000000, usd: 5 });

/** Worst-case plan from the actual projected request sizes and the approval price bound; fits against an allowance. */
export async function d17MultifactPlan(prepared: Pick<Prepared, 'corpus' | 'preregistration'>, approval: Pick<HeldoutApproval, 'model' | 'region' | 'credentialRef' | 'priceBound'>) {
  const sizing = { ...approval, calibration: { mode: 'uncalibrated-diagnostic' } } as unknown as HeldoutApproval;
  const attempts = 1 + prepared.preregistration.providerFailurePolicy.maxRetries;
  let rows = 0, first = 0, tokens = 0, usd = 0, max = 0;
  for (const row of prepared.corpus.rows) {
    rows++;
    for (const request of row.requests) {
      const { estimatedTokens } = await heldoutRequestSize(prepared.corpus, prepared.preregistration, sizing, row, request);
      first++; max = Math.max(max, estimatedTokens);
      tokens += attempts * heldoutReservationTokens(prepared.preregistration, estimatedTokens);
      usd += attempts * heldoutReservationMicros(sizing, estimatedTokens);
    }
  }
  return { rows, firstAttempts: first, maximumAttempts: first * attempts, maximumRequestEstimateTokens: max, reservedTokens: tokens, reservedUsdMicros: usd };
}
export function d17MultifactFit(plan: Awaited<ReturnType<typeof d17MultifactPlan>>, allowance: { calls: number; tokens: number; usdMicros: number }) {
  const headroom = { calls: allowance.calls - plan.maximumAttempts, tokens: allowance.tokens - plan.reservedTokens, usdMicros: allowance.usdMicros - plan.reservedUsdMicros };
  return { allowance: { ...allowance }, headroom, fits: headroom.calls >= 0 && headroom.tokens >= 0 && headroom.usdMicros >= 0 };
}
export function d17MultifactFreshAllowance(approval: HeldoutApproval) {
  return heldoutCollectionAllowance(approval, { studyUsdMicros: Math.ceil(approval.priorStudySpendUsd * 1_000_000),
    portfolioUsdMicros: Math.ceil(approval.priorPortfolioSpendUsd * 1_000_000), studyCalls: 0, studyReservedTokens: 0,
    counterBlocked: false, attempts: [], journalDigests: [], runs: [] });
}

// ---------- development review ----------
/** 40 complete development assessments agreeing with gold and the text oracle; the approval must cite the digest. */
export function validateD17MultifactReview(prepared: Prepared, review: unknown, trustedDigest: unknown, options: { before?: string } = {}) {
  try { validateD17MultifactArtifact('review', review); } catch { refuse('development-review'); }
  const value = review as { reviewer: string; preregistrationReview: string; assessments: Array<{ assessmentId: string; rowId: string; cell: string;
    inputDigest: string; payload: string; reviewedAt: string; goldAuditLabel: string; goldAmbiguousOrIncorrect: boolean; rationale: string }> };
  const template = prepared.reviewTemplate;
  if (typeof trustedDigest !== 'string' || heldoutDigest(value) !== trustedDigest || !value.reviewer?.trim() || !value.preregistrationReview?.trim()
    || value.assessments.length !== template.assessments.length) refuse('development-review');
  value.assessments.forEach((item, i) => {
    const expected = template.assessments[i]!, gold = prepared.gold.labels[item.rowId];
    if (item.assessmentId !== expected.assessmentId || item.rowId !== expected.rowId || item.payload !== expected.payload
      || item.inputDigest !== expected.inputDigest || item.cell !== expected.cell) refuse('development-review');
    if (item.goldAmbiguousOrIncorrect !== false) refuse('development-gold-invalid');
    if (!Number.isFinite(Date.parse(item.reviewedAt)) || !item.rationale?.trim() || item.goldAuditLabel !== gold
      || d17MfTextOracle(item.payload) !== gold) refuse('development-review-incomplete');
    if (options.before !== undefined && !(Date.parse(item.reviewedAt) < Date.parse(options.before))) refuse('development-review-time');
  });
  return value;
}

// ---------- statistics ----------
export function newcombeDifference(k1: number, n1: number, k2: number, n2: number, levelBps = 9500) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, [l1, u1] = wilsonScoreInterval({ events: k1, n: n1, levelBps }), [l2, u2] = wilsonScoreInterval({ events: k2, n: n2, levelBps });
  const d = p1 - p2;
  return { difference: +d.toFixed(4), lower: +(d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)).toFixed(4), upper: +(d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)).toFixed(4) };
}
/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7). */
function phi(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const p = (k1 + k2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  return 2 * (1 - phi(Math.abs(k1 / n1 - k2 / n2) / se));
}
/** Holm step-down: adjusted p-values in the original order (monotone, capped at 1). */
export function holmAdjust(pValues: ReadonlyArray<number | null>): Array<number | null> {
  const present = pValues.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p !== null).sort((a, b) => a.p - b.p);
  const out: Array<number | null> = pValues.map(() => null), m = present.length;
  let running = 0;
  present.forEach(({ p, i }, rank) => { running = Math.max(running, Math.min(1, (m - rank) * p)); out[i] = +running.toFixed(6); });
  return out;
}
/** AUROC of scores between positives and negatives (ties count half) with the Hanley-McNeil 95% interval. */
export function auroc(positives: readonly number[], negatives: readonly number[]) {
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const a of positives) for (const b of negatives) wins += a > b ? 1 : a === b ? 0.5 : 0;
  const A = wins / (positives.length * negatives.length), q1 = A / (2 - A), q2 = 2 * A * A / (1 + A);
  const se = Math.sqrt(Math.max(0, (A * (1 - A) + (positives.length - 1) * (q1 - A * A) + (negatives.length - 1) * (q2 - A * A)) / (positives.length * negatives.length)));
  return { auroc: +A.toFixed(4), lower: +Math.max(0, A - 1.96 * se).toFixed(4), upper: +Math.min(1, A + 1.96 * se).toFixed(4), positives: positives.length, negatives: negatives.length };
}

// ---------- scoring ----------
export interface D17MfScoringContext {
  /** The registered D17 calibration set and its member artifact and mapping, already re-derived from the D17 seal by the host. */
  set: { member: { artifactId: string; artifactDigest: Digest; mappingDigest: Digest } }; trustedCalibrationSetDigest: Digest;
  member: { artifact: CalibrationArtifact; mapping: D17CalibrationMapping };
  /** Latest collection end the collector recorded across the run lineage; the scoring clock may not precede it. */
  collectionEndedAt: string;
  nowEpochMs: number;
}
type Position = 'first' | 'interior' | 'last' | null;
interface RowResult { id: string; key: string; split: string; pool: D17MfPoolId; hops: number; outcome: D17MfOutcome; layout: string; gold: D17MfLabel;
  position: Position; observed: boolean; raw: number | null; rawCorrect: boolean; rawSaidYes: boolean; calCorrect: boolean; calConfidence: number; calYes: number | null }

export async function scoreD17Multifact(input: { corpus: HeldoutCorpus; preregistration: HeldoutPreregistration; attempts: readonly HeldoutAttempt[];
  gold: unknown; integrity: QualificationIntegrityMetadata; approvedCalibration: unknown; calibrated: unknown }, prepared: Prepared, context: D17MfScoringContext) {
  if (heldoutDigest(input.corpus) !== heldoutDigest(prepared.corpus) || heldoutDigest(input.preregistration) !== heldoutDigest(prepared.preregistration)
    || heldoutDigest(input.gold) !== prepared.corpus.provenance.goldDigest || heldoutDigest(prepared.gold) !== prepared.corpus.provenance.goldDigest) refuse('frozen-pins');
  const approved = input.approvedCalibration as { mode?: string; calibrationArtifactDigest?: string };
  if (approved?.mode !== 'artifact' || input.calibrated !== null || approved.calibrationArtifactDigest !== context?.trustedCalibrationSetDigest) refuse('approved-calibration');
  const ended = Date.parse(context.collectionEndedAt);
  if (!Number.isSafeInteger(context.nowEpochMs) || !Number.isFinite(ended) || context.nowEpochMs < ended) refuse('scoring-clock');
  // The applied calibrator: the registered member artifact and its mapping, for this exact definition.
  const { artifact, mapping } = context.member;
  if (artifact.digest !== context.set.member.artifactDigest || artifact.id !== context.set.member.artifactId
    || heldoutDigest(mapping) !== context.set.member.mappingDigest || artifact.identity.calibrator.parametersDigest !== context.set.member.mappingDigest
    || artifact.identity.calibrator.id !== D17_CALIBRATION.calibrators.member.id || artifact.identity.definitionDigest !== heldoutDigest(prepared.corpus.definitions)
    || artifact.identity.actualModel !== 'jev-1.13.0' || artifact.approval.state !== 'approved') refuse('calibration-artifact');
  // Qualified at collection end and at the scoring clock: an expired calibrator refuses either way.
  qualifyD17Calibration(artifact, new Date(ended).toISOString());
  const at = new Date(context.nowEpochMs).toISOString(), compatibility = qualifyD17Calibration(artifact, at);
  const rowsById = new Map(prepared.corpus.rows.map(r => [r.id, r])), seen = new Set<string>();
  for (const attempt of input.attempts) {
    validateHeldoutAttempt(attempt);
    const key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
    if (!rowsById.has(attempt.rowId) || attempt.requestId !== 'champion' || seen.has(key) || attempt.study !== 'D17'
      || attempt.corpusDigest !== input.preregistration.corpusDigest || attempt.preregistrationDigest !== heldoutDigest(input.preregistration)) refuse('attempt-membership');
    seen.add(key);
  }
  const grouped = d17AttemptsByRow(input.attempts), gold = prepared.gold;
  const results: RowResult[] = prepared.corpus.rows.map(row => {
    const world = gold.worlds[row.id]!, label = gold.labels[row.id]!, raw = d17NativeYes(grouped.get(row.id) ?? [], row.id, 'champion');
    const c = raw === null ? null : applyD17Mapping(mapping, raw), answer = (p: number | null) => p === null ? null : p > 0.5 ? 'yes' : p < 0.5 ? 'no' : 'defer';
    const last = world.failureKind === 'link' ? world.hops : world.hops - 1;
    const position: Position = world.failurePosition === null ? null : world.failurePosition === 0 ? 'first' : world.failurePosition === last ? 'last' : 'interior';
    return { id: row.id, key: row.slice, split: row.split, pool: world.pool, hops: world.hops, outcome: world.outcome, layout: world.layout, gold: label, position,
      observed: raw !== null, raw, rawCorrect: answer(raw) === label, rawSaidYes: answer(raw) === 'yes',
      calCorrect: answer(c) === label, calConfidence: c === null ? 0.5 : Math.max(c, 1 - c), calYes: c };
  });
  const test = results.filter(r => r.split === 'test');
  const wil = (k: number, n: number) => n ? wilsonScoreInterval({ events: k, n, levelBps: 9500 }).map(v => +v.toFixed(4)) as [number, number] : null;
  const stats = (list: readonly RowResult[]) => {
    const obs = list.filter(r => r.observed), n = obs.length, rawK = obs.filter(r => r.rawCorrect).length, calK = obs.filter(r => r.calCorrect).length;
    const meanConfidence = n ? obs.reduce((s, r) => s + r.calConfidence, 0) / n : null;
    const bins = new Map<number, RowResult[]>();
    for (const r of obs) { const b = Math.min(9, Math.floor((r.calYes ?? 0.5) * 10)); bins.set(b, [...(bins.get(b) ?? []), r]); }
    const ece = n ? [...bins.values()].reduce((s, b) => s + b.length / n * Math.abs(b.reduce((a, r) => a + (r.calYes ?? 0.5), 0) / b.length
      - b.filter(r => r.gold === 'yes').length / b.length), 0) : null;
    const calInterval = wil(calK, n);
    return { n: list.length, observed: n, coverage: list.length ? +(n / list.length).toFixed(4) : null,
      raw: { correct: rawK, accuracy: n ? +(rawK / n).toFixed(4) : null, wilson95: wil(rawK, n), saidYesRate: n ? +(obs.filter(r => r.rawSaidYes).length / n).toFixed(4) : null },
      calibrated: { correct: calK, accuracy: n ? +(calK / n).toFixed(4) : null, wilson95: calInterval,
        meanConfidence: meanConfidence === null ? null : +meanConfidence.toFixed(4), confidenceMinusAccuracy: n ? +(meanConfidence! - calK / n).toFixed(4) : null,
        ece: ece === null ? null : +ece.toFixed(4), calibrationUnreliable: n ? meanConfidence! - calK / n > 0.1 && calInterval![1] < meanConfidence! : null } };
  };
  const pick = (f: (r: RowResult) => boolean) => test.filter(f);
  const cells = Object.fromEntries([...new Set(test.map(r => r.key))].sort().map(key => [key, stats(pick(r => r.key === key))]));
  const complete = Object.values(cells).every(c => (c.coverage ?? 0) >= D17MF_PROTOCOL.coverage.minimumObservedFraction);
  const eq = (r: RowResult) => r.layout === 'equalized';
  const rawCounts = (rows: RowResult[]) => { const obs = rows.filter(r => r.observed); return { k: obs.filter(r => r.rawCorrect).length, n: obs.length }; };
  const diff = (a: RowResult[], b: RowResult[]) => { const x = rawCounts(a), y = rawCounts(b); return newcombeDifference(x.k, x.n, y.k, y.n); };
  const pValue = (a: RowResult[], b: RowResult[]) => { const x = rawCounts(a), y = rawCounts(b); return twoProportionP(x.k, x.n, y.k, y.n); };
  const written = ['missing-contrastive', 'missing-negation', 'missing-unrelated'] as const;
  const encodings = [...written, 'missing-absence'] as const;
  const hopsFor = (o: D17MfOutcome) => o === 'missing-absence' ? [3] : [...D17MF_HOPS];
  // H1: pool-pair contrasts, Holm across the whole family.
  const h1Tests = encodings.flatMap(outcome => hopsFor(outcome).flatMap(hops => [['pool-a', 'pool-b'], ['pool-a', 'pool-c'], ['pool-b', 'pool-c']].map(([x, y]) => {
    const a = pick(r => eq(r) && r.outcome === outcome && r.hops === hops && r.pool === x), b = pick(r => eq(r) && r.outcome === outcome && r.hops === hops && r.pool === y);
    return { outcome, hops, pools: `${x} - ${y}`, interval: diff(a, b), p: pValue(a, b) };
  })));
  const h1Adjusted = holmAdjust(h1Tests.map(t => t.p));
  const h1Rows = h1Tests.map((t, i) => ({ ...t, holmP: h1Adjusted[i] ?? null,
    meets: Boolean(t.interval && (h1Adjusted[i] ?? 1) < 0.05 && Math.abs(t.interval.difference) >= 0.1) }));
  const h1 = encodings.map(outcome => ({ outcome, supported: hopsFor(outcome).every(hops => h1Rows.some(t => t.outcome === outcome && t.hops === hops && t.meets)) }));
  // H2: h3 - h1 restricted to first and last failure positions (yes rows: all).
  const endpoint = (r: RowResult) => r.position === null || r.position === 'first' || r.position === 'last';
  const h2 = D17MF_OUTCOMES.filter(o => o !== 'missing-absence').map(outcome => {
    const pools = D17MF_POOL_IDS.map(pool => ({ pool, interval: diff(pick(r => eq(r) && endpoint(r) && r.outcome === outcome && r.pool === pool && r.hops === 3),
      pick(r => eq(r) && endpoint(r) && r.outcome === outcome && r.pool === pool && r.hops === 1)) }));
    return { outcome, matchedPositions: 'first and last', pools, supported: pools.filter(p => p.interval && p.interval.upper < -0.05).length >= 2 };
  });
  // H3: relay-off vs each missing encoding, pooled over hops.
  const h3 = D17MF_POOL_IDS.map(pool => {
    const relayOff = pick(r => eq(r) && r.pool === pool && r.outcome === 'relay-off');
    const byEncoding = encodings.map(outcome => { const rows = pick(r => eq(r) && r.pool === pool && r.outcome === outcome);
      const interval = diff(relayOff, rows), s = stats(rows);
      return { outcome, interval, rawSaidYesRate: s.raw.saidYesRate, meets: Boolean(interval && interval.lower > 0.1 && (s.raw.saidYesRate ?? 0) > 0.5) }; });
    return { pool, byEncoding, meets: byEncoding.some(e => e.meets) };
  });
  // H3a: encoding specificity, and the pure-absence baseline against interior-position contrastive rows (three hops).
  const h3a = D17MF_POOL_IDS.map(pool => {
    const by = (o: D17MfOutcome) => pick(r => eq(r) && r.pool === pool && r.outcome === o);
    const vsNegation = diff(by('missing-contrastive'), by('missing-negation')), vsUnrelated = diff(by('missing-contrastive'), by('missing-unrelated'));
    const negVsUnrelated = diff(by('missing-negation'), by('missing-unrelated'));
    const absenceBaseline = diff(pick(r => eq(r) && r.pool === pool && r.hops === 3 && r.outcome === 'missing-contrastive' && r.position === 'interior'),
      pick(r => eq(r) && r.pool === pool && r.outcome === 'missing-absence'));
    const relayOff = stats(by('relay-off')).raw.accuracy ?? 0, acc = written.map(o => stats(by(o)).raw.accuracy ?? 0);
    const specific = [vsNegation, vsUnrelated].every(d => d && d.upper < 0 && Math.abs(d.difference) >= 0.15);
    const general = [vsNegation, vsUnrelated, negVsUnrelated].every(d => d && Math.abs(d.difference) <= 0.1) && acc.every(a => a < relayOff);
    return { pool, vsNegation, vsUnrelated, negVsUnrelated, contrastiveInteriorVsAbsence: absenceBaseline, specific, general };
  });
  const h3aVerdict = h3a.filter(p => p.specific).length >= 2 ? 'contrastive-specific' : h3a.every(p => p.general) ? 'general' : 'mixed';
  // H4: layout at one hop on last-link failures (the faithful control always breaks the relay-to-destination link), Holm across pools.
  const h4Tests = D17MF_POOL_IDS.map(pool => {
    const a = pick(r => r.layout === 'd17-faithful' && r.pool === pool && r.outcome === 'missing-contrastive');
    const b = pick(r => eq(r) && r.pool === pool && r.hops === 1 && r.outcome === 'missing-contrastive' && r.position === 'last');
    const unmatched = diff(a, pick(r => eq(r) && r.pool === pool && r.hops === 1 && r.outcome === 'missing-contrastive'));
    return { pool, matchedPosition: 'last link', interval: diff(a, b), unmatchedInterval: unmatched, p: pValue(a, b) };
  });
  const h4Adjusted = holmAdjust(h4Tests.map(t => t.p));
  const h4 = h4Tests.map((t, i) => ({ ...t, holmP: h4Adjusted[i] ?? null, meets: Boolean(t.interval && (h4Adjusted[i] ?? 1) < 0.05) }));
  const replication = stats(pick(r => r.layout === 'd17-faithful' && r.pool === 'pool-c' && r.outcome === 'missing-contrastive'));
  // Threshold-free primary metric: AUROC of the raw P(yes), yes rows vs missing-link rows, per pool x hops.
  const scores = (rows: RowResult[]) => rows.filter(r => r.observed).map(r => r.raw!);
  const aurocs = D17MF_POOL_IDS.flatMap(pool => D17MF_HOPS.map(hops => {
    const yes = scores(pick(r => eq(r) && r.pool === pool && r.hops === hops && r.outcome === 'yes'));
    const missingRows = (o?: D17MfOutcome) => scores(pick(r => eq(r) && r.pool === pool && r.hops === hops && (o ? r.outcome === o : r.outcome.startsWith('missing'))));
    return { pool, hops, pooled: auroc(yes, missingRows()), byEncoding: Object.fromEntries(encodings.filter(o => hopsFor(o).includes(hops)).map(o => [o, auroc(yes, missingRows(o))])) };
  }));
  const positions = Object.fromEntries([...new Set(test.filter(r => r.position !== null).map(r => `${r.key}:${r.position}`))].sort()
    .map(k => { const [key, position] = k.split(':'); return [k, stats(pick(r => r.key === key && r.position === position))]; }));
  const verdict = <T>(value: T) => complete ? value : 'insufficient' as const;
  const report = { schemaVersion: 'decision-d17mf-report/v2', issue: 'roctinam/aiwg#2850', scope: 'synthetic-calibrated-probe',
    calibrated: true, primaryMetric: 'raw native answer and raw-score AUROC (calibrated metrics: calibration-under-shift only)',
    calibration: { mode: 'artifact', calibrationSetDigest: context.trustedCalibrationSetDigest, memberArtifactDigest: artifact.digest,
      mappingDigest: context.set.member.mappingDigest, compatibility: { action: compatibility.action, state: compatibility.state },
      qualifiedAt: at, collectionEndedAt: new Date(ended).toISOString(), expiresAt: D17MF_ARTIFACT_EXPIRY },
    corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration), analysisDigest: heldoutDigest(prepared.analysis),
    integrityDigest: heldoutDigest(input.integrity), auditDigest: prepared.analysis.auditDigest,
    coverage: { testRows: test.length, observed: test.filter(r => r.observed).length, developmentRows: results.length - test.length,
      minimumObservedFraction: D17MF_PROTOCOL.coverage.minimumObservedFraction, complete },
    overall: stats(test), cells, byFailurePosition: positions, auroc: aurocs,
    hypotheses: {
      H1: { verdict: verdict(h1.some(h => h.supported)), byEncoding: h1, tests: h1Rows },
      H2: { verdict: verdict(h2.some(h => h.supported)), byOutcome: h2 },
      H3: { verdict: verdict(h3.every(p => p.meets)), byPool: h3 },
      H3a: { verdict: verdict(h3aVerdict), byPool: h3a },
      H4: { verdict: verdict(h4.some(p => p.meets)), byPool: h4,
        differences: ['rule wording (D17 sufficient one-relay rule vs exhaustive link-only rule)', 'line order (fixed vs uniformly shuffled)',
          'decoy lines (none vs label-independent decoys)', 'entity names (role-prefixed vs neutral)'] },
      replication: { verdict: verdict(Boolean(replication.raw.wilson95 && replication.raw.wilson95[1] <= 0.5)), cell: replication },
      calibrationUnderShift: { unreliableCells: Object.entries(cells).filter(([, c]) => c.calibrated.calibrationUnreliable).map(([k]) => k).sort() } },
    decision: 'HOLD' as const, promotion: 'none: diagnostic probe' };
  validateD17MultifactArtifact('report', report);
  return report;
}
export type D17MultifactReport = Awaited<ReturnType<typeof scoreD17Multifact>>;
