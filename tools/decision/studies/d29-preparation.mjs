// Prepare frozen D29 populations, analysis plans and zero-call dry runs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { heldoutApprovalTemplate, heldoutRequest, heldoutReservationMicros, heldoutReservationTokens,
  validateHeldoutInputs, assertHeldoutRequestBounds, HeldoutError } from '../../../src/decision/heldout/contract.ts';
import { generateHeldoutRow, heldoutGeneratorDigest, D29_V4_VARIANTS as D29_VARIANTS } from '../../../src/decision/heldout/generators.ts';
import { freezeQualificationSplit } from '../../../src/decision/qualification/quality.ts';
import { artifactDigest } from '../../../src/decision/validate.ts';
import { sdlcScreeningPreflight, SDLC_SCREENING_PREREGISTRATION_VERSION_V2 } from '../../../src/decision/sdlc-screening.ts';
import { d29WorldV6 } from '../../../src/decision/heldout/d29-v6.ts';
import { d29WorldV7, D29_V7_GENERATOR_ID } from '../../../src/decision/heldout/d29-v7.ts';
import { d29WorldV8, D29_V8_GENERATOR_ID } from '../../../src/decision/heldout/d29-v8.ts';
import { generateRegisteredHeldoutRow, registeredHeldoutGeneratorDigest, D29_LATEST_GENERATOR_ID } from '../../../src/decision/heldout/generator-registry.ts';
import { d29PassageBaselineV2Digest } from '../../../src/decision/heldout/d29-passage-baseline-v2.ts';
import { d29PassageBaselineV3Digest } from '../../../src/decision/heldout/d29-passage-baseline-v3.ts';
import { d29PassageBaselineDigest } from '../../../src/decision/heldout/d29-passage-baseline.ts';
import { shortcutAudit } from './d29-shortcuts.mjs';
import { shortcutAuditV7 } from './d29-shortcuts-v7.mjs';
import { shortcutAuditV8, SHORTCUT_AUDIT_V8_PARAMETERS } from './d29-shortcuts-v8.mjs';
import { d29ScorerDigest, definitions, definitionsV8, oracle, buildHost, validateStudyArtifact,
  FROZEN_AT, V8_BINDING_FROZEN_AT, V8_DATASET_FROZEN_AT, absoluteGateBinding, SLICES, GATE_BLOCKING_SLICES, populationSummary, gateDryRunDigests } from './d29.mjs';
const byteDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
import { heldoutDigest } from '../../../src/decision/heldout/contract.ts';
const refuse = reason => { throw new Error(`D29 study refused (${reason})`); };
/**
 * Public development seeds and the generator their committed fixtures use.
 * Every other seed is a fresh private seed and prepares with the latest
 * generator. Historical public seeds v1–v5 regenerate through the v6
 * pipeline; all of them stay refused for paid collection by the contract.
 */
export const D29_PUBLIC_SEED_GENERATORS = Object.freeze({
  'd29-study-v1': 'd29-synthetic/v6', 'd29-study-v2': 'd29-synthetic/v6', 'd29-study-v3': 'd29-synthetic/v6',
  'd29-study-v4': 'd29-synthetic/v6', 'd29-study-v5': 'd29-synthetic/v6', 'd29-study-v6': 'd29-synthetic/v6',
  'd29-study-v7': D29_V7_GENERATOR_ID, 'd29-study-v8': D29_V8_GENERATOR_ID,
});

/** Generator a seed prepares with: its pinned public generator, else the latest generator. */
export function d29GeneratorForSeed(seed) {
  const pinned = Object.hasOwn(D29_PUBLIC_SEED_GENERATORS, seed) ? D29_PUBLIC_SEED_GENERATORS[seed] : undefined;
  return pinned ?? D29_LATEST_GENERATOR_ID;
}

/** The single generator id recorded in every row's provenance; mixed or unknown ids refuse. */
export function d29CorpusGeneratorId(corpus) {
  const ids = new Set((Array.isArray(corpus?.rows) ? corpus.rows : [null]).map(row => row?.provenance?.generatorId));
  const [id] = ids;
  if (ids.size !== 1 || !Object.hasOwn(D29_PIPELINES, id)) refuse('corpus-generator');
  return id;
}

/** Explicit generator-version pipelines: preparation and offline dry run. */
const D29_PIPELINES = Object.freeze({
  'd29-synthetic/v6': { prepare: seed => prepareV6(seed), dryRun: prepared => dryRunV6(prepared) },
  [D29_V7_GENERATOR_ID]: { prepare: seed => prepareV7(seed), dryRun: prepared => dryRunV7(prepared) },
  [D29_V8_GENERATOR_ID]: { prepare: seed => prepareV8(seed), dryRun: prepared => dryRunV8(prepared) },
});

/** Prepares `seed` with an explicit generator version. */
export async function prepareWithGenerator(generatorId, seed) {
  if (!Object.hasOwn(D29_PIPELINES, generatorId)) refuse('generator');
  return D29_PIPELINES[generatorId].prepare(seed);
}

/** Study-module entry: a fresh (non-public) seed always prepares with the latest generator. */
export async function prepare(seed) {
  return prepareWithGenerator(d29GeneratorForSeed(seed), seed);
}

/** Offline dry run routed by the corpus's recorded generator version. */
export async function dryRun(prepared) {
  return D29_PIPELINES[d29CorpusGeneratorId(prepared?.corpus)].dryRun(prepared);
}

export async function prepareV6(seed) {
  if (typeof seed !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(seed)) refuse('seed');
  const moduleDigest = await d29ScorerDigest(seed);
  const rows = [], goldRows = [];
  for (let ordinal = 0; ordinal < 2000; ordinal++) {
    const { world } = d29WorldV6(seed, ordinal);
    const row = generateHeldoutRow('d29-synthetic/v6', `${seed}:${ordinal}:${world.artifactPresent && world.testPassed ? 'single' : 'local'}`);
    const { subject, policy } = buildHost(row.id, row.input.payload, world.artifactPresent, world.testPassed);
    if ((sdlcScreeningPreflight(subject, Date.parse(FROZEN_AT), policy).length === 0) !== (row.requests.length > 0)) refuse('preflight-generator');
    rows.push(row); goldRows.push({ id: row.id, variant: world.variant, world, gold: oracle(world) });
  }
  const gold = { schemaVersion: 'decision-d29-gold/v6', syntheticOnly: true, rows: goldRows };
  const corpus = { schemaVersion: 'decision-heldout-corpus/v1', study: 'D29', syntheticOnly: true,
    provenance: { kind: 'authored-synthetic', generatorDigest: heldoutGeneratorDigest('d29-synthetic/v6'), seed, goldDigest: heldoutDigest(gold) }, definitions: definitions(), rows };
  const analysis = analysisPlan(corpus);
  const preregistration = { schemaVersion: 'decision-heldout-preregistration/v1', study: 'D29', frozenAt: FROZEN_AT,
    corpusDigest: heldoutDigest(corpus), studyAnalysisDigest: heldoutDigest(analysis), scorerDigest: moduleDigest,
    calibration: { scope: 'calibrated', allowedModes: ['staged'], calibrationPhaseSplits: ['tuning', 'calibration'] },
    regeneration: { reason: 'synthetic-v6-balanced-records-claim-relative-audit-passage-v2', collectorCommit: 'ca23244f3', priorLiveObservations: 0 },
    providerFailurePolicy: { maxRetries: 1, maximumSliceFailureBps: 500, retryOnlyTerminal: true },
    perRequestTokenBound: 4500, providerOverheadTokens: 512, outputAndHiddenTokenAllowance: 256,
    requestTimeoutMs: 30000, minDispatchIntervalMs: 1000, sessionLimitMs: 1800000 };
  validateHeldoutInputs(corpus, preregistration);
  validateStudyArtifact(gold); validateStudyArtifact(analysis);
  return { corpus, preregistration, gold, analysis, reviews: reviewTemplate(corpus, gold),
    approval: approvalWithGatePins(approvalTemplate(corpus, preregistration), analysis) };
}

export async function prepareV7(seed) {
  if (typeof seed !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(seed)) refuse('seed');
  const moduleDigest = await d29ScorerDigest(seed);
  const rows = [], goldRows = [];
  for (let ordinal = 0; ordinal < 2000; ordinal++) {
    const { world } = d29WorldV7(seed, ordinal);
    const row = generateHeldoutRow(D29_V7_GENERATOR_ID, `${seed}:${ordinal}:${world.artifactPresent && world.testPassed ? 'single' : 'local'}`);
    const { subject, policy } = buildHost(row.id, row.input.payload, world.artifactPresent, world.testPassed);
    if ((sdlcScreeningPreflight(subject, Date.parse(FROZEN_AT), policy).length === 0) !== (row.requests.length > 0)) refuse('preflight-generator');
    if ((world.pool === 'train') !== (row.split !== 'test')) refuse('pool-split');
    rows.push(row); goldRows.push({ id: row.id, variant: world.variant, world, gold: oracle(world) });
  }
  const gold = { schemaVersion: 'decision-d29-gold/v7', syntheticOnly: true, rows: goldRows };
  const corpus = { schemaVersion: 'decision-heldout-corpus/v1', study: 'D29', syntheticOnly: true,
    provenance: { kind: 'authored-synthetic', generatorDigest: heldoutGeneratorDigest(D29_V7_GENERATOR_ID), seed, goldDigest: heldoutDigest(gold) }, definitions: definitions(), rows };
  const analysis = analysisPlanV7(corpus);
  const preregistration = { schemaVersion: 'decision-heldout-preregistration/v1', study: 'D29', frozenAt: FROZEN_AT,
    corpusDigest: heldoutDigest(corpus), studyAnalysisDigest: heldoutDigest(analysis), scorerDigest: moduleDigest,
    calibration: { scope: 'calibrated', allowedModes: ['staged'], calibrationPhaseSplits: ['tuning', 'calibration'] },
    regeneration: { reason: 'synthetic-v7-held-out-wording-pools-train-test-split', collectorCommit: 'ba5946380', priorLiveObservations: 0 },
    providerFailurePolicy: { maxRetries: 1, maximumSliceFailureBps: 500, retryOnlyTerminal: true },
    perRequestTokenBound: 4500, providerOverheadTokens: 512, outputAndHiddenTokenAllowance: 256,
    requestTimeoutMs: 30000, minDispatchIntervalMs: 1000, sessionLimitMs: 1800000 };
  validateHeldoutInputs(corpus, preregistration);
  validateStudyArtifact(gold); validateStudyArtifact(analysis);
  return { corpus, preregistration, gold, analysis, reviews: reviewTemplate(corpus, gold),
    approval: approvalWithGatePins(approvalTemplate(corpus, preregistration), analysis) };
}

/**
 * Generator-v8 dataset: same population, oracle, comparators and gates as
 * v7, with uniform operator-note templates, value-changing moves and
 * non-contradicting claimed-module distractors (d29-v8.ts), the v5 shortcut
 * audit, and its own freeze time and GateBinding. Gold keeps the v7 format.
 */
export async function prepareV8(seed) {
  if (typeof seed !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(seed)) refuse('seed');
  const moduleDigest = await d29ScorerDigest(seed);
  const rows = [], goldRows = [];
  for (let ordinal = 0; ordinal < 2000; ordinal++) {
    const { world } = d29WorldV8(seed, ordinal);
    const row = generateRegisteredHeldoutRow(D29_V8_GENERATOR_ID, `${seed}:${ordinal}:${world.artifactPresent && world.testPassed ? 'single' : 'local'}`);
    const { subject, policy } = buildHost(row.id, row.input.payload, world.artifactPresent, world.testPassed);
    if ((sdlcScreeningPreflight(subject, Date.parse(V8_DATASET_FROZEN_AT), policy).length === 0) !== (row.requests.length > 0)) refuse('preflight-generator');
    if ((world.pool === 'train') !== (row.split !== 'test')) refuse('pool-split');
    rows.push(row); goldRows.push({ id: row.id, variant: world.variant, world, gold: oracle(world) });
  }
  const gold = { schemaVersion: 'decision-d29-gold/v7', syntheticOnly: true, rows: goldRows };
  const corpus = { schemaVersion: 'decision-heldout-corpus/v1', study: 'D29', syntheticOnly: true,
    provenance: { kind: 'authored-synthetic', generatorDigest: registeredHeldoutGeneratorDigest(D29_V8_GENERATOR_ID), seed, goldDigest: heldoutDigest(gold) }, definitions: definitionsV8(), rows };
  // Fail closed: a v8 corpus is never prepared (and so never approved or
  // scored) unless the v5 shortcut audit passes; the analysis pins its digest.
  const audit = shortcutAuditV8Cached(corpus, gold);
  if (!audit.passed) refuse('shortcut-audit');
  const analysis = analysisPlanV8(corpus, audit);
  const preregistration = { schemaVersion: 'decision-heldout-preregistration/v1', study: 'D29', frozenAt: V8_DATASET_FROZEN_AT,
    corpusDigest: heldoutDigest(corpus), studyAnalysisDigest: heldoutDigest(analysis), scorerDigest: moduleDigest,
    calibration: { scope: 'calibrated', allowedModes: ['staged'], calibrationPhaseSplits: ['tuning', 'calibration'] },
    regeneration: { reason: 'synthetic-v8-uniform-note-templates-value-changing-moves-consistent-claim-distractors', collectorCommit: 'f71843222', priorLiveObservations: 0 },
    providerFailurePolicy: { maxRetries: 1, maximumSliceFailureBps: 500, retryOnlyTerminal: true },
    perRequestTokenBound: 4500, providerOverheadTokens: 512, outputAndHiddenTokenAllowance: 256,
    requestTimeoutMs: 30000, minDispatchIntervalMs: 1000, sessionLimitMs: 1800000 };
  validateHeldoutInputs(corpus, preregistration);
  validateStudyArtifact(gold); validateStudyArtifact(analysis);
  const approval = approvalWithGatePins(approvalTemplate(corpus, preregistration), analysis);
  // Fail closed on size too: every request of every split must fit the
  // preregistered per-request bound, or no v8 corpus is prepared.
  await assertD29RequestBounds({ corpus, preregistration, approval });
  return { corpus, preregistration, gold, analysis, reviews: reviewTemplate(corpus, gold), approval };
}

/**
 * Refuses (`payload-bound at row <index>`) when any request of any row, in
 * any split, exceeds the preregistered per-request bound. Names the row index,
 * never its content.
 */
export async function assertD29RequestBounds(prepared) {
  const planningApproval = { ...prepared.approval, region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev' };
  try { await assertHeldoutRequestBounds(prepared.corpus, prepared.preregistration, planningApproval); }
  catch (error) {
    if (error instanceof HeldoutError && error.category === 'payload-bound') refuse(`payload-bound at ${error.detail}`);
    throw error;
  }
}

/** v5 audit memoized by corpus and gold digest: preparation, scoring and the dry run share one run per process. */
const v8AuditCache = new Map();
export function shortcutAuditV8Cached(corpus, gold) {
  const key = `${heldoutDigest(corpus)}:${heldoutDigest(gold)}`;
  if (!v8AuditCache.has(key)) {
    const audit = shortcutAuditV8(corpus, gold); validateStudyArtifact(audit);
    v8AuditCache.set(key, audit);
  }
  return structuredClone(v8AuditCache.get(key));
}

/** Generator-v8 analysis (`decision-d29-analysis/v7`): every audit parameter plus the passing audit's digest. */
export function analysisPlanV8(corpus, audit) {
  if (!audit || audit.schemaVersion !== 'decision-d29-shortcut-audit/v5' || audit.passed !== true) refuse('shortcut-audit');
  const v7 = analysisPlanV7(corpus), splits = v7.splits;
  return { ...v7, schemaVersion: 'decision-d29-analysis/v7', native: { ...v7.native, planId: 'd29-synthetic-v8', frozenAt: V8_DATASET_FROZEN_AT },
    shortcutAudit: { sourceDigest: byteDigest(readFileSync(new URL('./d29-shortcuts-v8.mjs', import.meta.url))),
      ...structuredClone(SHORTCUT_AUDIT_V8_PARAMETERS), ngramSizes: [...SHORTCUT_AUDIT_V8_PARAMETERS.ngramSizes],
      reportDigest: heldoutDigest(audit), passed: true },
    gateBinding: absoluteGateBinding({ planId: 'd29-synthetic-v8', bindingId: 'd29-synthetic-v8-absolute-gates',
      splitDigest: splits[2].digest, corpusDigest: heldoutDigest(corpus), goldDigest: corpus.provenance.goldDigest, frozenAt: V8_DATASET_FROZEN_AT }) };
}

export function analysisPlanV7(corpus) {
  const splits = ['tuning', 'calibration', 'test'].map(name => freezeQualificationSplit(name, corpus.rows.filter(row => row.split === name).map(row => row.id)));
  const generatorSource = readFileSync(new URL('../../../src/decision/heldout/generators.ts', import.meta.url), 'utf8');
  const secondarySource = generatorSource.slice(generatorSource.indexOf('export function d29Baseline('), generatorSource.indexOf('export function d29World('));
  const native = { schemaVersion: SDLC_SCREENING_PREREGISTRATION_VERSION_V2, planId: 'd29-synthetic-v7', frozenAt: FROZEN_AT,
    heldoutSplitDigest: splits[2].digest, slices: [...SLICES], gateBlockingSlices: [...GATE_BLOCKING_SLICES],
    maximumFalseSupportRateBps: 100, maximumFalseReadyRateBps: 100, minimumTotalSupport: 1500, minimumSliceSupport: 100,
    minimumGateBlockingSliceSupport: 500, confidenceInterval: { method: 'wilson', levelBps: 9500 }, qualityNonInferiorityBps: null,
    efficiencyClaim: { enabled: false, minimumPositiveTotalEconomicsUsd: null } };
  return { schemaVersion: 'decision-d29-analysis/v6', syntheticOnly: true, splits,
    comparators: { primary: { id: 'd29-passage-baseline/v3', sourceDigest: d29PassageBaselineV3Digest() },
      ceiling: { id: 'd29-passage-baseline/v2', sourceDigest: d29PassageBaselineV2Digest() },
      passageV1: { id: 'd29-passage-baseline/v1', sourceDigest: d29PassageBaselineDigest() },
      secondary: { id: 'd29-baseline/v1', sourceDigest: byteDigest(secondarySource) } },
    shortcutAudit: { sourceDigest: byteDigest(readFileSync(new URL('./d29-shortcuts-v7.mjs', import.meta.url))),
      pairFeatureLimit: 200, injection: 0.75, readiness: 0.75, support: 0.80,
      modelInjection: 0.80, modelReadiness: 0.80, modelSupport: 0.85 },
    native,
    gateBinding: absoluteGateBinding({ planId: 'd29-synthetic-v7', bindingId: 'd29-synthetic-v7-absolute-gates',
      splitDigest: splits[2].digest, corpusDigest: heldoutDigest(corpus), goldDigest: corpus.provenance.goldDigest }),
    calibration: { method: 'kind-and-safe-semantic-ready-frequency-v2', minimumCellN: 10, smoothing: 'laplace-1', split: 'calibration',
      profile: { minimumTotalSamples: 250, minimumPerSliceSamples: 25, powerRule: null, confidenceInterval: { method: 'wilson', level: 0.95 },
        maximumCalibrationError: 0.1, maximumSelectiveRisk: 0.1, expiresAfterDays: 30 } },
    review: { development: 50, holdout: 100, delayedRepeats: 15, reviewer: 'roctinam' },
    missingPolicy: 'withhold-native-report; complete-case-description; missing-as-error',
    conditionalRates: ['false-support/non-support-gold', 'false-support/accepted-support', 'false-ready/non-ready-gold', 'false-ready/accepted-ready'] };
}

export function analysisPlan(corpus) {
  const splits = ['tuning', 'calibration', 'test'].map(name => freezeQualificationSplit(name, corpus.rows.filter(row => row.split === name).map(row => row.id)));
  const generatorSource = readFileSync(new URL('../../../src/decision/heldout/generators.ts', import.meta.url), 'utf8');
  const secondarySource = generatorSource.slice(generatorSource.indexOf('export function d29Baseline('), generatorSource.indexOf('export function d29World('));
  const native = { schemaVersion: SDLC_SCREENING_PREREGISTRATION_VERSION_V2, planId: 'd29-synthetic-v6', frozenAt: FROZEN_AT,
    heldoutSplitDigest: splits[2].digest, slices: [...SLICES], gateBlockingSlices: [...GATE_BLOCKING_SLICES],
    maximumFalseSupportRateBps: 100, maximumFalseReadyRateBps: 100, minimumTotalSupport: 1500, minimumSliceSupport: 100,
    minimumGateBlockingSliceSupport: 500, confidenceInterval: { method: 'wilson', levelBps: 9500 }, qualityNonInferiorityBps: null,
    efficiencyClaim: { enabled: false, minimumPositiveTotalEconomicsUsd: null } };
  return { schemaVersion: 'decision-d29-analysis/v6', syntheticOnly: true, splits,
    comparators: { primary: { id: 'd29-passage-baseline/v2', sourceDigest: d29PassageBaselineV2Digest() },
      passageV1: { id: 'd29-passage-baseline/v1', sourceDigest: d29PassageBaselineDigest() },
      secondary: { id: 'd29-baseline/v1', sourceDigest: byteDigest(secondarySource) } },
    shortcutAudit: { sourceDigest: byteDigest(readFileSync(new URL('./d29-shortcuts.mjs', import.meta.url))),
      pairFeatureLimit: 200, injection: 0.75, readiness: 0.75, support: 0.80 },
    native,
    gateBinding: absoluteGateBinding({ planId: 'd29-synthetic-v6', bindingId: 'd29-synthetic-v6-absolute-gates',
      splitDigest: splits[2].digest, corpusDigest: heldoutDigest(corpus), goldDigest: corpus.provenance.goldDigest }),
    calibration: { method: 'kind-and-safe-semantic-ready-frequency-v2', minimumCellN: 10, smoothing: 'laplace-1', split: 'calibration',
      profile: { minimumTotalSamples: 250, minimumPerSliceSamples: 25, powerRule: null, confidenceInterval: { method: 'wilson', level: 0.95 },
        maximumCalibrationError: 0.1, maximumSelectiveRisk: 0.1, expiresAfterDays: 30 } },
    review: { development: 50, holdout: 100, delayedRepeats: 15, reviewer: 'roctinam' },
    missingPolicy: 'withhold-native-report; complete-case-description; missing-as-error',
    conditionalRates: ['false-support/non-support-gold', 'false-support/accepted-support', 'false-ready/non-ready-gold', 'false-ready/accepted-ready'] };
}

/**
 * Pins the preregistered GateBinding explicitly on the approval, alongside
 * the transitive preregistration digest pin. The operator verifies
 * gateBindingDigest against artifactDigest of the approved analysis's
 * gateBinding before approving collection.
 */
export function approvalWithGatePins(template, analysis) {
  return { ...template, gateBindingDigest: artifactDigest(analysis.gateBinding),
    gatePackDigests: analysis.gateBinding.spec.packs.map(({ id, version, digest, resolvedDigest }) => ({ id, version, digest, resolvedDigest })) };
}

export function approvalTemplate(corpus, plan) {
  const template = heldoutApprovalTemplate(corpus, plan);
  return { ...template, calibration: { mode: 'staged', phase: 'calibration' }, reviewer: 'roctinam', budget: { ...template.budget, tokens: 60000000 },
    priceBound: { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
    evidenceReferences: ['https://www.eesel.ai/blog/typesafe-jev-pricing', 'https://www.mindstudio.ai/blog/jev-pricing-cost-per-token',
      'roctinam/aiwg#2613 comment 153093'], approvalReference: null } };
}

export function reviewTemplate(corpus, gold) {
  const select = (split, count) => SLICES.flatMap(slice => corpus.rows.filter(row => row.split === split && row.slice === slice)
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, count).map(row => row.id)).sort();
  const labels = new Map(gold.rows.map(row => [row.id, row]));
  const tuning = corpus.rows.filter(row => row.split === 'tuning').sort((a, b) => a.id.localeCompare(b.id));
  const selected = new Set(), phrases = new Set();
  const add = row => { selected.add(row.id); if (labels.get(row.id).world.injected) phrases.add(labels.get(row.id).world.injectionPhrase); };
  for (const slice of SLICES) for (const variant of D29_VARIANTS[slice]) {
    const matches = tuning.filter(row => row.slice === slice && labels.get(row.id).variant === variant);
    add(matches.find(row => !phrases.has(labels.get(row.id).world.injectionPhrase)) ?? matches[0]);
  }
  for (const row of tuning.filter(row => labels.get(row.id).world.injected)) {
    if (selected.size < 50 && !phrases.has(labels.get(row.id).world.injectionPhrase)) add(row);
  }
  for (const row of tuning) if (selected.size < 50 && !selected.has(row.id)) add(row);
  const development = [...selected].sort(), holdout = select('test', 10);
  return { schemaVersion: 'decision-d29-review/v2', reviewer: 'roctinam', corpusDigest: heldoutDigest(corpus),
    assessments: [...development.map(id => ({ phase: 'development', id })), ...holdout.map(id => ({ phase: 'holdout', id })),
      ...holdout.filter((_, i) => i % 7 === 0).slice(0, 15).map(id => ({ phase: 'delayed-repeat', id }))]
      .map((item, i) => ({ assessmentId: `audit-${String(i + 1).padStart(3, '0')}`, ...item,
        goldCorrect: null, goldRationale: null, blindReviewedAt: null, agreed: null, overridden: null, rationale: null, unblindedAt: null })),
    preregistrationReview: null, finalDispositionReview: null };
}

export async function dryRunV7(prepared) {
  // The v4 audit learns on train-pool rows and evaluates the same rules on the
  // held-out test split internally, so no separate public-test audit call is needed.
  const audit = shortcutAuditV7(prepared.corpus, prepared.gold); validateStudyArtifact(audit);
  return plannedDryRun(prepared, audit);
}

/** Generator v8: the v5 audit runs per wording pool and transfers train rules to the test pool. */
export async function dryRunV8(prepared) {
  const audit = shortcutAuditV8Cached(prepared.corpus, prepared.gold);
  if (!audit.passed || heldoutDigest(audit) !== prepared.analysis.shortcutAudit.reportDigest) refuse('shortcut-audit');
  return plannedDryRun(prepared, audit);
}

/** Zero-call budget plan shared by the v7 and v8 dry runs; the audit is computed by the caller. */
async function plannedDryRun(prepared, audit) {
  await assertD29RequestBounds(prepared);
  const phases = Object.fromEntries(['calibration', 'test'].map(phase => {
    const rows = prepared.corpus.rows.filter(row => phase === 'test' ? row.split === 'test' : row.split !== 'test');
    return [phase, { subjects: rows.length, initialCalls: rows.reduce((n, row) => n + row.requests.length, 0) }];
  }));
  const initial = prepared.corpus.rows.reduce((n, row) => n + row.requests.length, 0);
  const planningApproval = { ...prepared.approval, region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev' };
  let inputTokens = 0, reservedTokens = 0, reservedUsdMicros = 0, maximumRequestEstimateTokens = 0;
  for (const row of prepared.corpus.rows) for (const request of row.requests) {
    const approval = row.split === 'test' ? { ...planningApproval, calibration: { mode: 'staged', phase: 'test',
      calibrationArtifactDigest: null, calibrationPhaseRecordDigest: null, priorApprovalDigest: null } } : planningApproval;
    const planned = await heldoutRequest(prepared.corpus, prepared.preregistration, approval, row, request);
    inputTokens += planned.estimatedTokens;
    reservedTokens += heldoutReservationTokens(prepared.preregistration, planned.estimatedTokens);
    reservedUsdMicros += heldoutReservationMicros(planningApproval, planned.estimatedTokens);
    maximumRequestEstimateTokens = Math.max(maximumRequestEstimateTokens, planned.estimatedTokens);
  }
  return { ...populationSummary(prepared), ...gateDryRunDigests(prepared.analysis), shortcutAudit: audit, publicTestShortcutAudit: null, providerCalls: 0, execution: 'individual-questions', phases, subjects: prepared.corpus.rows.length,
    deterministicNoCallSubjects: prepared.corpus.rows.filter(row => !row.requests.length).length,
    providerOverheadTokens: prepared.preregistration.providerOverheadTokens,
    maximumRequestEstimateTokens,
    expected: { initialCalls: initial, attempts: initial * 1.025, inputTokens: inputTokens * 1.025,
      reservedTokens: reservedTokens * 1.025, inputAtAttestedTariffUsd: inputTokens * 1.025 * 0.042 / 1e6,
      reservedUsd: reservedUsdMicros * 1.025 / 1e6 },
    worst: { attempts: initial * 2, inputTokens: inputTokens * 2, tokens: reservedTokens * 2,
      reservedUsd: reservedUsdMicros * 2 / 1e6 },
    hardCapUsd: 6, stopAtUsd: 4.8, preregistrationDigest: heldoutDigest(prepared.preregistration),
    analysisDigest: heldoutDigest(prepared.analysis), corpusDigest: heldoutDigest(prepared.corpus),
    goldDigest: prepared.corpus.provenance.goldDigest, generatorDigest: prepared.corpus.provenance.generatorDigest, scorerDigest: prepared.preregistration.scorerDigest,
    approvalTemplateDigest: heldoutDigest(prepared.approval), splitDigests: prepared.analysis.splits.map(({ name, digest }) => ({ name, digest })) };
}

export async function dryRunV6(prepared) {
  const phases = Object.fromEntries(['calibration', 'test'].map(phase => {
    const rows = prepared.corpus.rows.filter(row => phase === 'test' ? row.split === 'test' : row.split !== 'test');
    return [phase, { subjects: rows.length, initialCalls: rows.reduce((n, row) => n + row.requests.length, 0) }];
  }));
  const initial = prepared.corpus.rows.reduce((n, row) => n + row.requests.length, 0);
  const planningApproval = { ...prepared.approval, region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev' };
  let inputTokens = 0, reservedTokens = 0, reservedUsdMicros = 0, maximumRequestEstimateTokens = 0;
  for (const row of prepared.corpus.rows) for (const request of row.requests) {
    const approval = row.split === 'test' ? { ...planningApproval, calibration: { mode: 'staged', phase: 'test',
      calibrationArtifactDigest: null, calibrationPhaseRecordDigest: null, priorApprovalDigest: null } } : planningApproval;
    const planned = await heldoutRequest(prepared.corpus, prepared.preregistration, approval, row, request);
    inputTokens += planned.estimatedTokens;
    reservedTokens += heldoutReservationTokens(prepared.preregistration, planned.estimatedTokens);
    reservedUsdMicros += heldoutReservationMicros(planningApproval, planned.estimatedTokens);
    maximumRequestEstimateTokens = Math.max(maximumRequestEstimateTokens, planned.estimatedTokens);
  }
  const audit = shortcutAudit(prepared.corpus, prepared.gold); validateStudyArtifact(audit);
  const publicTestAudit = prepared.corpus.provenance.seed === 'd29-study-v6'
    ? shortcutAudit(prepared.corpus, prepared.gold, { splits: ['test'] }) : null;
  if (publicTestAudit) validateStudyArtifact(publicTestAudit);
  return { ...populationSummary(prepared), ...gateDryRunDigests(prepared.analysis), shortcutAudit: audit, publicTestShortcutAudit: publicTestAudit, providerCalls: 0, execution: 'individual-questions', phases, subjects: prepared.corpus.rows.length,
    deterministicNoCallSubjects: prepared.corpus.rows.filter(row => !row.requests.length).length,
    providerOverheadTokens: prepared.preregistration.providerOverheadTokens,
    maximumRequestEstimateTokens,
    expected: { initialCalls: initial, attempts: initial * 1.025, inputTokens: inputTokens * 1.025,
      reservedTokens: reservedTokens * 1.025, inputAtAttestedTariffUsd: inputTokens * 1.025 * 0.042 / 1e6,
      reservedUsd: reservedUsdMicros * 1.025 / 1e6 },
    worst: { attempts: initial * 2, inputTokens: inputTokens * 2, tokens: reservedTokens * 2,
      reservedUsd: reservedUsdMicros * 2 / 1e6 },
    hardCapUsd: 6, stopAtUsd: 4.8, preregistrationDigest: heldoutDigest(prepared.preregistration),
    analysisDigest: heldoutDigest(prepared.analysis), corpusDigest: heldoutDigest(prepared.corpus),
    goldDigest: prepared.corpus.provenance.goldDigest, generatorDigest: prepared.corpus.provenance.generatorDigest, scorerDigest: prepared.preregistration.scorerDigest,
    approvalTemplateDigest: heldoutDigest(prepared.approval), splitDigests: prepared.analysis.splits.map(({ name, digest }) => ({ name, digest })) };
}

