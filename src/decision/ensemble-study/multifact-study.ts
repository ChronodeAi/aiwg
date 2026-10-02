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
 * Calibration choice: artifact mode applies the registered D17 member calibrator (staged D09, #2611) to the single fresh
 * call per row, instead of a new staged calibration phase. The probe asks whether Jev's multi-fact reasoning, and the
 * deployed calibration, survive wording, depth and polarity shift; a calibrator fitted on the shifted pools would absorb
 * exactly the miscalibration under shift the probe measures. Scoring re-derives the D17 set from its seal and qualifies
 * the member artifact at the scoring clock (approved, unexpired, within the frozen profile); it is never uncalibrated.
 */
export const D17MF_PROTOCOL = Object.freeze({
  schemaVersion: 'decision-d17mf-protocol/v1', issue: 'roctinam/aiwg#2850', study: 'D17', generator: D17_MULTIFACT_GENERATOR_ID,
  design: Object.freeze({ pools: D17MF_POOL_IDS, hops: D17MF_HOPS, outcomes: D17MF_OUTCOMES, layouts: ['equalized', 'd17-faithful'],
    counts: D17MF_TEST_COUNTS, developmentPerCell: 2, rows: D17MF_ROWS,
    keyCells: 'equalized missing-link cells (pool x hops x encoding), 250 rows each: Wilson 95% half-width 0.062 at p = 0.5',
    supportingCells: 'equalized yes (90) and relay-off (60) cells and D17-faithful control cells (50)',
    sizeBound: 'one corpus stays inside the shared credential-scan traversal limit (100,000 nodes, 17 per row)',
    requestsPerRow: 1, request: 'champion: one fresh call of jev-1.13.0 with the D17 DecisionDefinition' }),
  calibration: Object.freeze({ mode: 'artifact', calibrator: D17_CALIBRATION.calibrators.member.id,
    binding: 'approval.calibration.calibrationArtifactDigest = registered D17 calibration set digest',
    verification: 'scoring re-derives the D17 calibration set from its sealed calibration phase and qualifies the member artifact at the scoring clock',
    profile: D17_CALIBRATION.profile }),
  interval: Object.freeze({ cell: 'wilson', difference: 'newcombe-hybrid-score-independent', levelBps: 9500 }),
  hypotheses: Object.freeze([
    Object.freeze({ id: 'H1', name: 'wording', claim: 'Missing-link accuracy depends on the wording pool at fixed hops and encoding.' }),
    Object.freeze({ id: 'H2', name: 'depth', claim: 'Accuracy falls as relay hops increase at fixed pool and outcome.' }),
    Object.freeze({ id: 'H3', name: 'missing-link-polarity', claim: 'A missing link is read as established (permissive linking), while a disabled relay is handled.' }),
    Object.freeze({ id: 'H3a', name: 'encoding', claim: 'The failure is specific to the contrastive verb rather than to missing links in general.' }),
    Object.freeze({ id: 'H4', name: 'layout', claim: 'The D17-faithful rendering differs from the equalized rendering at one hop (decoys, rule form, names).' }),
  ]),
  decisionRules: Object.freeze({
    H1: 'supported when, for some missing-link encoding, both hop levels show a pool pair whose accuracy difference has a 95% interval excluding 0 and |difference| >= 0.10',
    H2: 'supported when, for some outcome, accuracy(h3) - accuracy(h1) has a 95% upper bound below -0.05 in at least 2 of 3 pools',
    H3: 'supported when, in every pool (pooled over hops), relay-off minus missing-link accuracy has a 95% lower bound above 0.10 for some encoding and that encoding is answered "yes" on more than half its rows',
    H3a: '"contrastive-specific" when, in at least 2 pools, contrastive accuracy is below both other encodings with 95% intervals excluding 0 and |difference| >= 0.15; "general" when all three encodings are within 0.10 and all below relay-off; otherwise "mixed"',
    H4: 'supported when, in some pool, the missing-contrastive accuracy difference (d17-faithful minus equalized, one hop) has a 95% interval excluding 0',
    replication: 'the D17 failure replicates when pool-c d17-faithful missing-contrastive calibrated accuracy has a 95% upper bound at most 0.50',
    calibrationUnderShift: 'a cell is calibration-unreliable when mean calibrated confidence minus accuracy exceeds 0.10 and the accuracy upper bound is below the mean confidence',
  }),
  shortcutAudit: Object.freeze({ population: 'equalized test rows, per pool x hops, target gold yes/no', folds: 5, limit: 0.6,
    learners: ['cross-validated best single scalar threshold', 'cross-validated best token-count threshold', 'cross-validated depth-2 tree over scalar features'],
    features: ['line count', 'character length', 'digit count', 'word count', 'cue counts (relation, contrastive, negation, unrelated, enabled, disabled)',
      'distinct entities', 'query subject and destination mentions in facts', 'token counts with entity names abstracted'],
    control: 'd17-faithful rows are audited separately and reported; they reproduce D17 and are expected to be cue-solvable' }),
  promotion: 'none: a diagnostic probe of the provider; the study decision is always HOLD',
});

type Prepared = ReturnType<typeof prepareD17MultifactStudy>;
interface Gold { schemaVersion: 'decision-d17mf-gold/v1'; labels: Record<string, D17MfLabel>; worlds: Record<string, D17MfWorld> }

// ---------- shortcut audit ----------
const NAME = /\b[A-Z][a-z0-9]{4}\b/g;
function features(payload: string, pool: D17MfPoolId) {
  const p = D17MF_POOLS[pool], facts = payload.split('\nFacts:\n')[1]!.split('\nQuestion:')[0]!.split('\n').slice(0, -1);
  const q = /can reach (\S+)\?$/.exec(payload)![1]!, s = /established that (\S+) can reach/.exec(payload)![1]!;
  const count = (re: RegExp) => facts.filter(line => re.test(line)).length;
  const words = payload.replace(NAME, 'ENTITY').split(/\s+/).filter(Boolean);
  const scalar: Record<string, number> = { lines: facts.length, chars: payload.length, digits: (payload.match(/\d/g) ?? []).length, words: words.length,
    relation: count(new RegExp(` ${p.relation} `)), contrastive: count(new RegExp(` ${p.contrastive} `)), negation: count(/ does not /),
    unrelated: count(new RegExp(` ${p.unrelated} `)), enabled: count(new RegExp(` is ${p.enabled}\\.$`)), disabled: count(new RegExp(` is ${p.disabled}\\.$`)),
    entities: new Set(facts.join(' ').match(NAME) ?? []).size, subjectMentions: facts.filter(l => l.split(' ').includes(s)).length,
    destinationMentions: facts.filter(l => l.split(/[ .]/).includes(q)).length };
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
function bestThreshold(train: ReadonlyArray<{ x: Record<string, number>; y: boolean }>, keys: readonly string[]): Rule {
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
function stumpTree(train: ReadonlyArray<{ x: Record<string, number>; y: boolean }>, keys: readonly string[]): Rule {
  const root = bestThreshold(train, keys);
  const left = train.filter(r => root(r.x)), right = train.filter(r => !root(r.x));
  const leaf = (part: typeof train) => part.length ? bestThreshold(part, keys) : () => false;
  const l = leaf(left), r = leaf(right);
  return x => root(x) ? l(x) : r(x);
}
function crossValidated(rows: ReadonlyArray<{ x: Record<string, number>; y: boolean; id: string }>, learn: (train: typeof rows) => Rule, folds: number) {
  const ordered = [...rows].sort((a, b) => a.id < b.id ? -1 : 1), predictions: Array<{ y: boolean; predict: boolean }> = [];
  for (let k = 0; k < folds; k++) {
    const train = ordered.filter((_, i) => i % folds !== k), test = ordered.filter((_, i) => i % folds === k);
    const rule = learn(train);
    for (const r of test) predictions.push({ y: r.y, predict: rule(r.x) });
  }
  return +balanced(predictions).toFixed(4);
}
/** The D29-style shortcut audit: no surface learner may predict gold above the preregistered limit within any pool x hops. */
export function d17MultifactShortcutAudit(corpus: HeldoutCorpus, gold: Gold) {
  const { folds, limit } = D17MF_PROTOCOL.shortcutAudit;
  const groups = new Map<string, Array<{ x: Record<string, number>; t: Record<string, number>; y: boolean; id: string }>>();
  for (const row of corpus.rows.filter(r => r.split === 'test')) {
    const world = gold.worlds[row.id]!, key = `${world.layout}:${world.pool}:h${world.hops}`;
    const f = features(String((row.input as { payload: string }).payload), world.pool);
    groups.set(key, [...(groups.get(key) ?? []), { x: f.scalar, t: f.tokens, y: gold.labels[row.id] === 'yes', id: row.id }]);
  }
  const scalarKeys = ['lines', 'chars', 'digits', 'words', 'relation', 'contrastive', 'negation', 'unrelated', 'enabled', 'disabled', 'entities', 'subjectMentions', 'destinationMentions'];
  const results = [...groups].sort(([a], [b]) => a < b ? -1 : 1).map(([group, rows]) => {
    const tokenKeys = [...new Set(rows.flatMap(r => Object.keys(r.t)))].sort();
    const tokenRows = rows.map(r => ({ x: r.t, y: r.y, id: r.id }));
    const scores = { scalarThreshold: crossValidated(rows, train => bestThreshold(train, scalarKeys), folds),
      tokenThreshold: crossValidated(tokenRows, train => bestThreshold(train, tokenKeys), folds),
      depth2Tree: crossValidated(rows, train => stumpTree(train, scalarKeys), folds) };
    const max = Math.max(...Object.values(scores));
    return { group, n: rows.length, yes: rows.filter(r => r.y).length, scores, max, passes: group.startsWith('d17-faithful') ? null : max <= limit };
  });
  const equalized = results.filter(r => r.passes !== null);
  return { schemaVersion: 'decision-d17mf-shortcut-audit/v1', limit, folds, groups: results,
    equalizedPasses: equalized.every(r => r.passes), equalizedMax: Math.max(...equalized.map(r => r.max)),
    controlMax: Math.max(...results.filter(r => r.passes === null).map(r => r.max)) };
}

// ---------- preparation ----------
function reviewTemplate(rows: readonly HeldoutRow[], gold: Gold) {
  // 40 development items: 8 per outcome, spread over pools, hops and layouts in allocation order.
  const picked: HeldoutRow[] = [];
  for (const outcome of D17MF_OUTCOMES) {
    const candidates = rows.filter(r => r.split === 'tuning' && gold.worlds[r.id]!.outcome === outcome);
    const byKey = new Map<string, HeldoutRow[]>();
    for (const r of candidates) byKey.set(r.slice, [...(byKey.get(r.slice) ?? []), r]);
    const keys = [...byKey.keys()];
    for (let i = 0; picked.filter(r => gold.worlds[r.id]!.outcome === outcome).length < 8; i++) {
      const list = byKey.get(keys[i % keys.length]!)!, item = list[Math.floor(i / keys.length)];
      if (item) picked.push(item);
    }
  }
  return { schemaVersion: 'decision-d17mf-review/v1', reviewer: null, preregistrationReview: null,
    assessments: picked.map((row, i) => ({ assessmentId: `mf-assessment-${String(i + 1).padStart(2, '0')}`, rowId: row.id, cell: row.slice,
      inputDigest: heldoutDigest(row.input), payload: String((row.input as { payload: string }).payload),
      reviewedAt: null, goldAuditLabel: null, goldAmbiguousOrIncorrect: null, rationale: null })),
    instructions: 'Label each development payload yes/no from the facts and rule alone, flag ambiguity, give a rationale and the review time, then compare with gold and the text oracle. Any ambiguous or incorrect gold stops the probe.' };
}

export function prepareD17MultifactStudy(seed: string, moduleDigest: Digest, sourceDigests: Record<string, Digest>) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(seed) || !/^sha256:[a-f0-9]{64}$/.test(moduleDigest)
    || !Object.keys(sourceDigests).length || Object.values(sourceDigests).some(v => !/^sha256:[a-f0-9]{64}$/.test(v))) throw new Error('D17-MF source or seed pins');
  const rows: HeldoutRow[] = [];
  const gold: Gold = { schemaVersion: 'decision-d17mf-gold/v1', labels: {}, worlds: {} };
  for (let index = 0; index < D17MF_ROWS; index++) {
    const rowSeed = `${seed}:${index}:single`, { row, world, label } = d17MfGenerateCase(rowSeed);
    if (d17MfTextOracle(String(row.input.payload)) !== label) throw new Error('D17-MF oracle disagreement');
    gold.labels[row.id] = label; gold.worlds[row.id] = world;
    rows.push({ ...row, provenance: { generatorId: D17_MULTIFACT_GENERATOR_ID, seed: rowSeed, outputDigest: heldoutDigest(row) } });
  }
  const corpus: HeldoutCorpus = { schemaVersion: 'decision-heldout-corpus/v1', study: 'D17', syntheticOnly: true,
    provenance: { kind: 'authored-synthetic', generatorDigest: studyHeldoutGeneratorDigest(D17_MULTIFACT_GENERATOR_ID), seed, goldDigest: heldoutDigest(gold) },
    definitions: [structuredClone(D17MF_DEFINITION)], rows };
  const audit = d17MultifactShortcutAudit(corpus, gold);
  if (!audit.equalizedPasses) throw new Error('D17-MF shortcut audit');
  const analysis = { schemaVersion: 'decision-d17mf-analysis/v1', protocol: D17MF_PROTOCOL, sourceDigests, auditDigest: heldoutDigest(audit),
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
  const review = reviewTemplate(rows, gold);
  validateD17MultifactArtifact('reviewTemplate', review);
  return { corpus, preregistration, gold, analysis, audit, approvalTemplate, reviewTemplate: review };
}
/** Study budget: USD 5 cap (program-authorized for #2850); calls and tokens leave headroom over the worst case at the 80% stop. */
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
const refuse = (reason: string): never => { const error = new Error(`D17-MF refused (${reason})`) as Error & { reason: string }; error.reason = reason; throw error; };
/** 40 complete development assessments agreeing with gold and the text oracle; the calibration approval must cite the digest. */
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

// ---------- scoring ----------
export function newcombeDifference(k1: number, n1: number, k2: number, n2: number, levelBps = 9500) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, [l1, u1] = wilsonScoreInterval({ events: k1, n: n1, levelBps }), [l2, u2] = wilsonScoreInterval({ events: k2, n: n2, levelBps });
  const d = p1 - p2;
  return { difference: +d.toFixed(4), lower: +(d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)).toFixed(4), upper: +(d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)).toFixed(4) };
}
export interface D17MfScoringContext {
  /** The registered D17 calibration set and its member artifact and mapping, already re-derived from the D17 seal by the host. */
  set: { member: { artifactId: string; artifactDigest: Digest; mappingDigest: Digest } }; trustedCalibrationSetDigest: Digest;
  member: { artifact: CalibrationArtifact; mapping: D17CalibrationMapping }; nowEpochMs: number;
}
interface RowResult { id: string; key: string; split: string; pool: D17MfPoolId; hops: number; outcome: D17MfOutcome; layout: string; gold: D17MfLabel;
  observed: boolean; correct: boolean; rawCorrect: boolean; saidYes: boolean; confidence: number; calibratedYes: number | null }

export async function scoreD17Multifact(input: { corpus: HeldoutCorpus; preregistration: HeldoutPreregistration; attempts: readonly HeldoutAttempt[];
  gold: unknown; integrity: QualificationIntegrityMetadata; approvedCalibration: unknown; calibrated: unknown }, prepared: Prepared, context: D17MfScoringContext) {
  if (heldoutDigest(input.corpus) !== heldoutDigest(prepared.corpus) || heldoutDigest(input.preregistration) !== heldoutDigest(prepared.preregistration)
    || heldoutDigest(input.gold) !== prepared.corpus.provenance.goldDigest || heldoutDigest(prepared.gold) !== prepared.corpus.provenance.goldDigest) refuse('frozen-pins');
  const approved = input.approvedCalibration as { mode?: string; calibrationArtifactDigest?: string };
  if (approved?.mode !== 'artifact' || input.calibrated !== null || approved.calibrationArtifactDigest !== context?.trustedCalibrationSetDigest) refuse('approved-calibration');
  // The applied calibrator: the registered member artifact and its mapping, for this exact definition, qualified now.
  const { artifact, mapping } = context.member;
  if (artifact.digest !== context.set.member.artifactDigest || artifact.id !== context.set.member.artifactId
    || heldoutDigest(mapping) !== context.set.member.mappingDigest || artifact.identity.calibrator.parametersDigest !== context.set.member.mappingDigest
    || artifact.identity.calibrator.id !== D17_CALIBRATION.calibrators.member.id || artifact.identity.definitionDigest !== heldoutDigest(prepared.corpus.definitions)
    || artifact.identity.actualModel !== 'jev-1.13.0' || artifact.approval.state !== 'approved') refuse('calibration-artifact');
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
    const c = raw === null ? null : applyD17Mapping(mapping, raw), answer = c === null ? null : c > 0.5 ? 'yes' : c < 0.5 ? 'no' : 'defer';
    return { id: row.id, key: row.slice, split: row.split, pool: world.pool, hops: world.hops, outcome: world.outcome, layout: world.layout, gold: label,
      observed: raw !== null, correct: answer === label, rawCorrect: raw !== null && (raw > 0.5 ? 'yes' : raw < 0.5 ? 'no' : 'defer') === label,
      saidYes: answer === 'yes', confidence: c === null ? 0.5 : Math.max(c, 1 - c), calibratedYes: c };
  });
  const test = results.filter(r => r.split === 'test');
  const stats = (list: readonly RowResult[]) => {
    const observed = list.filter(r => r.observed), k = observed.filter(r => r.correct).length, n = observed.length;
    const [lo, hi] = n ? wilsonScoreInterval({ events: k, n, levelBps: 9500 }) : [null, null];
    const meanConfidence = n ? observed.reduce((s, r) => s + r.confidence, 0) / n : null;
    const bins = new Map<number, RowResult[]>();
    for (const r of observed) { const b = Math.min(9, Math.floor((r.calibratedYes ?? 0.5) * 10)); bins.set(b, [...(bins.get(b) ?? []), r]); }
    const ece = n ? [...bins.values()].reduce((s, b) => s + b.length / n * Math.abs(b.reduce((a, r) => a + (r.calibratedYes ?? 0.5), 0) / b.length
      - b.filter(r => r.gold === 'yes').length / b.length), 0) : null;
    return { n: list.length, observed: n, correct: k, accuracy: n ? +(k / n).toFixed(4) : null, wilson95: lo === null ? null : [+lo.toFixed(4), +hi!.toFixed(4)],
      rawAccuracy: n ? +(observed.filter(r => r.rawCorrect).length / n).toFixed(4) : null, saidYesRate: n ? +(observed.filter(r => r.saidYes).length / n).toFixed(4) : null,
      meanConfidence: meanConfidence === null ? null : +meanConfidence.toFixed(4), confidenceMinusAccuracy: n ? +(meanConfidence! - k / n).toFixed(4) : null,
      ece: ece === null ? null : +ece.toFixed(4),
      calibrationUnreliable: n ? meanConfidence! - k / n > 0.1 && hi! < meanConfidence! : null };
  };
  const pick = (f: (r: RowResult) => boolean) => test.filter(f);
  const cells = Object.fromEntries([...new Set(test.map(r => r.key))].sort().map(key => [key, stats(pick(r => r.key === key))]));
  const eq = (r: RowResult) => r.layout === 'equalized';
  const diff = (a: RowResult[], b: RowResult[]) => { const sa = stats(a), sb = stats(b); return newcombeDifference(sa.correct, sa.observed, sb.correct, sb.observed); };
  const missing = D17MF_OUTCOMES.filter(o => o.startsWith('missing'));
  // H1 wording: pool pairs at fixed hops and encoding.
  const h1 = missing.map(outcome => {
    const levels = D17MF_HOPS.map(hops => {
      const pairs = [['pool-a', 'pool-b'], ['pool-a', 'pool-c'], ['pool-b', 'pool-c']].map(([x, y]) => ({ pools: `${x} - ${y}`,
        interval: diff(pick(r => eq(r) && r.outcome === outcome && r.hops === hops && r.pool === x), pick(r => eq(r) && r.outcome === outcome && r.hops === hops && r.pool === y)) }));
      return { hops, pairs, meets: pairs.some(p => p.interval && (p.interval.lower > 0 || p.interval.upper < 0) && Math.abs(p.interval.difference) >= 0.1) };
    });
    return { outcome, levels, supported: levels.every(l => l.meets) };
  });
  // H2 depth: h3 - h1 at fixed pool and outcome.
  const h2 = D17MF_OUTCOMES.map(outcome => {
    const pools = D17MF_POOL_IDS.map(pool => ({ pool, interval: diff(pick(r => eq(r) && r.outcome === outcome && r.pool === pool && r.hops === 3),
      pick(r => eq(r) && r.outcome === outcome && r.pool === pool && r.hops === 1)) }));
    return { outcome, pools, supported: pools.filter(p => p.interval && p.interval.upper < -0.05).length >= 2 };
  });
  // H3 missing link vs disabled relay, pooled over hops, per pool.
  const h3 = D17MF_POOL_IDS.map(pool => {
    const relayOff = pick(r => eq(r) && r.pool === pool && r.outcome === 'relay-off');
    const encodings = missing.map(outcome => { const rows = pick(r => eq(r) && r.pool === pool && r.outcome === outcome);
      const interval = diff(relayOff, rows), s = stats(rows);
      return { outcome, interval, saidYesRate: s.saidYesRate, meets: Boolean(interval && interval.lower > 0.1 && (s.saidYesRate ?? 0) > 0.5) }; });
    return { pool, encodings, meets: encodings.some(e => e.meets) };
  });
  // H3a encoding specificity per pool (pooled over hops).
  const h3a = D17MF_POOL_IDS.map(pool => {
    const by = (o: D17MfOutcome) => pick(r => eq(r) && r.pool === pool && r.outcome === o);
    const vsNegation = diff(by('missing-contrastive'), by('missing-negation')), vsUnrelated = diff(by('missing-contrastive'), by('missing-unrelated'));
    const negVsUnrelated = diff(by('missing-negation'), by('missing-unrelated'));
    const relayOff = stats(by('relay-off')).accuracy ?? 0, acc = missing.map(o => stats(by(o)).accuracy ?? 0);
    const specific = [vsNegation, vsUnrelated].every(d => d && d.upper < 0 && Math.abs(d.difference) >= 0.15);
    const general = [vsNegation, vsUnrelated, negVsUnrelated].every(d => d && Math.abs(d.difference) <= 0.1) && acc.every(a => a < relayOff);
    return { pool, vsNegation, vsUnrelated, negVsUnrelated, specific, general };
  });
  const h3aVerdict = h3a.filter(p => p.specific).length >= 2 ? 'contrastive-specific' : h3a.every(p => p.general) ? 'general' : 'mixed';
  // H4 layout at one hop.
  const h4 = D17MF_POOL_IDS.map(pool => ({ pool, interval: diff(pick(r => r.layout === 'd17-faithful' && r.pool === pool && r.outcome === 'missing-contrastive'),
    pick(r => eq(r) && r.pool === pool && r.hops === 1 && r.outcome === 'missing-contrastive')) }));
  const replication = stats(pick(r => r.layout === 'd17-faithful' && r.pool === 'pool-c' && r.outcome === 'missing-contrastive'));
  const report = { schemaVersion: 'decision-d17mf-report/v1', issue: 'roctinam/aiwg#2850', scope: 'synthetic-calibrated-probe',
    calibrated: true, calibration: { mode: 'artifact', calibrationSetDigest: context.trustedCalibrationSetDigest, memberArtifactDigest: artifact.digest,
      mappingDigest: context.set.member.mappingDigest, compatibility: { action: compatibility.action, state: compatibility.state }, qualifiedAt: at },
    corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration), analysisDigest: heldoutDigest(prepared.analysis),
    integrityDigest: heldoutDigest(input.integrity), auditDigest: prepared.analysis.auditDigest,
    coverage: { testRows: test.length, observed: test.filter(r => r.observed).length, developmentRows: results.length - test.length },
    overall: stats(test), cells,
    hypotheses: { H1: { supported: h1.some(h => h.supported), byEncoding: h1 }, H2: { supported: h2.some(h => h.supported), byOutcome: h2 },
      H3: { supported: h3.every(p => p.meets), byPool: h3 }, H3a: { verdict: h3aVerdict, byPool: h3a },
      H4: { supported: h4.some(p => p.interval && (p.interval.lower > 0 || p.interval.upper < 0)), byPool: h4 },
      replication: { replicated: Boolean(replication.wilson95 && replication.wilson95[1] <= 0.5), cell: replication } },
    decision: 'HOLD' as const, promotion: 'none: diagnostic probe' };
  validateD17MultifactArtifact('report', report);
  return report;
}
export type D17MultifactReport = Awaited<ReturnType<typeof scoreD17Multifact>>;
