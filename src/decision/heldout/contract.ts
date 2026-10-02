import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { admitEntry, DEFAULT_ENTRY_LIMITS } from '../entry.js';
import { sha256 } from '../compile-cache/identity.js';
import { artifactPin, validateDefinition, validateDecisionDocument } from '../validate.js';
import { contextLiveBinding, contextLiveRuleset, contextLiveTarget } from '../context-live-qualification.js';
import { JEV_ENDPOINT, compileJevQuestion } from '../adapters/jev.js';
import { projectDecisionState, partitionProjectedState } from '../projection.js';
import { dagLiveReservationMicros } from '../graph-live-qualification.js';
import { redactStructured, redactText } from '../../governance/redaction.js';
import { heldoutCorpusSeed } from './generators.js';
import { studyHeldoutGeneratorDigest as registeredHeldoutGeneratorDigest, reproducibleStudyHeldoutRow as reproducibleRegisteredHeldoutRow,
  D17_MULTIFACT_GENERATOR_ID, d17MultifactPublicSeed, usesD17MultifactGenerator } from './study-generators.js';
import { D29_PAID_GENERATOR_IDS } from './d29-generator-ids.js';
import type { HeldoutApproval, HeldoutAttempt, HeldoutBundle, HeldoutCorpus, HeldoutExecution,
  HeldoutPreregistration, HeldoutRequest, HeldoutRow, Study } from './types.js';

export { sha256 as heldoutDigest };
export const HELDOUT_CAP_USD: Readonly<Record<Study, number>> = Object.freeze({ D17: 8, D29: 6 });
export const HELDOUT_PORTFOLIO_CAP_USD = 48;
export const HELDOUT_ENV_GATE = 'AIWG_DECISION_HELDOUT_LIVE';
const D29_PUBLIC_DEMO_SEEDS = new Set(['d29-study-v1', 'd29-study-v2', 'd29-study-v3', 'd29-study-v4', 'd29-study-v5', 'd29-study-v6', 'd29-study-v7', 'd29-study-v8']);
// Canonical corpus digests, including the public version before the wording correction.
// Slim corpus headers stay refused alongside the full corpora they pin: both are committed demo bytes.
const D29_PUBLIC_DEMO_CORPORA = new Set([
  'sha256:6bb4c5990c2d039841074bfb099e8c1ad5c6c40b5bd334817cb897bc320fd744',
  'sha256:4a0833e7a82d3809cb3b9448af1fbe5eae0ebeb1ee4d8055ae67b9c24f05baca',
  'sha256:505283a46217e158b39ba93f61e17c28c39c582cad857f7090f38e8844a6794a',
  'sha256:35ecc8936b7a251d1c34cf630e9b09ed82eff0d05f96c901c01edfa0f9849934',
  'sha256:372cb180f129938280751bf3db76e4f9bc142ef85e68f38370b88aeec5602963',
  'sha256:5d09130d1327033dc00e7edb6e936fc3388036c3177aaef3ba20ae1a6ae38604',
  'sha256:d5b722d175903aefe1b98c3db0c5310df35c0807eb8b7682ebd852f566e28ebc',
  'sha256:53dea2a1008af107c1634c4d35c663fc18a9412a82a662141a50b0c8bbbdaf64',
  'sha256:018912caaae0102593be0196fa86f0721edded8b2bed625b5a32b4df260b8a6e',
  'sha256:6f5834c418810e5d89ce37185b13063ce0c8922220becbb43ae7253678d2da23',
  'sha256:76186887d4753a8fd011b6abf438f467d19e3b11b15881522fc59d6f0c7cc7d6',
  'sha256:65454a6a3c1dfd85b3c7e953d836309328a48442ec9ae931b9a907c8d91ff855',
  // v8 per-generator pins: the same public v6/v7 corpora after the generator digest change.
  'sha256:4635395bac1c4efc036729879a831d8fd827b8b00d5b3e704b614135123c6549',
  'sha256:c4a0f5d2a4000091cb435e75a3caca48ae0f4478b03f24a619132ce8bec260de',
  // Generator d29-synthetic/v8 public development corpus (seed d29-study-v8); refused preemptively.
  'sha256:ce5642f156003c3a29c28dd9ad7208964e6ced5ea0fd1f3ebd7bc04dacd40c64',
]);
const limits = { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 32_000_000, properties: 1_000_000,
  arrayLength: 20000, entries: 2_000_000, memoryBytes: 256_000_000 };
const validators = new Map<string, ValidateFunction>();
export class HeldoutError extends Error {
  /** `detail` names where (for example a corpus row index), never row content. */
  constructor(readonly category: string, readonly detail?: string) { super(`Held-out collector refused (${category})${detail ? ` at ${detail}` : ''}`); }
}
export function checkHeldoutSchema(kind: 'Corpus' | 'Preregistration' | 'Approval' | 'Attempt' | 'Event' | 'Summary' | 'Frozen' | 'Baseline' | 'SpendEvent' | 'SpendHead' | 'CalibrationPhase', value: unknown): void {
  admitEntry(value, limits);
  let validate = validators.get(kind);
  if (!validate) {
    const here = dirname(fileURLToPath(import.meta.url));
    const name = `Heldout${kind}.${kind === 'SpendHead' ? 'v2' : 'v1'}.schema.json`;
    const root = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
      .find(path => existsSync(resolve(path, name)));
    if (!root) throw new HeldoutError('schema-unavailable');
    const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
    for (const dependency of ['Corpus', 'Preregistration', 'Approval', 'Attempt']) {
      if (kind === 'Frozen' || kind === 'Event') ajv.addSchema(JSON.parse(readFileSync(resolve(root, `Heldout${dependency}.v1.schema.json`), 'utf8')));
    }
    validate = ajv.compile(JSON.parse(readFileSync(resolve(root, name), 'utf8'))); validators.set(kind, validate);
  }
  if (!validate(value)) throw new HeldoutError('schema');
}
export function validateHeldoutInputs(corpus: HeldoutCorpus, plan: HeldoutPreregistration): void {
  checkHeldoutSchema('Corpus', corpus); checkHeldoutSchema('Preregistration', plan);
  // Every row pins its own generator family: the corpus digest must equal the
  // single family digest all rows resolve to, so no row rides on another study's pin.
  // Null means unknown, so an unregistered generator or mixed families fail closed.
  const familyDigests = new Map<string, `sha256:${string}`>();
  const digestOf = (generatorId: string): `sha256:${string}` => {
    const cached = familyDigests.get(generatorId);
    if (cached !== undefined) return cached;
    try {
      const digest = registeredHeldoutGeneratorDigest(generatorId);
      familyDigests.set(generatorId, digest);
      return digest;
    } catch {
      throw new HeldoutError('corpus-provenance');
    }
  };
  let familyDigest: string | null = null;
  for (const row of corpus.rows) {
    const digest = digestOf(row.provenance.generatorId);
    if (familyDigest === null) familyDigest = digest;
    else if (familyDigest !== digest) throw new HeldoutError('corpus-provenance');
  }
  if (familyDigest === null || corpus.provenance.generatorDigest !== familyDigest
    || corpus.provenance.seed !== heldoutCorpusSeed(corpus.rows)) {
    throw new HeldoutError('corpus-provenance');
  }
  const ids = new Set<string>(), families = new Map<string, string>(), payloads = new Set<string>();
  const definitions = new Set(corpus.definitions.map(d => d.metadata.id));
  corpus.definitions.forEach(validateDefinition);
  if (definitions.size !== corpus.definitions.length || plan.study !== corpus.study || plan.corpusDigest !== sha256(corpus)
    || plan.outputAndHiddenTokenAllowance >= plan.perRequestTokenBound) throw new HeldoutError('input-pins');
  for (const row of corpus.rows) {
    if (!reproducibleRegisteredHeldoutRow(row)) throw new HeldoutError('generator-output');
    if (ids.has(row.id) || families.has(row.familyId) && families.get(row.familyId) !== row.split
      || payloads.has(sha256(row.input)) || new Set(row.requests.map(r => r.id)).size !== row.requests.length
      || row.requests.some(r => !definitions.has(r.definitionId)) || !row.requests.length && row.localOutcome === null) {
      throw new HeldoutError('membership');
    }
    ids.add(row.id); families.set(row.familyId, row.split); payloads.add(sha256(row.input));
  }
  // A recognizable secret is not synthetic text. Opaque private data still needs operator review.
  if (redactStructured(corpus).sensitivity !== 'none') throw new HeldoutError('credential-material');
}
export function heldoutExecution(corpus: HeldoutCorpus, plan: HeldoutPreregistration,
  approval: Pick<HeldoutApproval, 'model' | 'region' | 'credentialRef'>, request: HeldoutRequest): HeldoutExecution {
  const definition = corpus.definitions.find(d => d.metadata.id === request.definitionId)!;
  const purpose = 'heldout-study', origin = new URL(JEV_ENDPOINT).origin;
  const projection = { version: 'heldout-v1', provider: 'jev', model: approval.model, region: approval.region, origin,
    purpose, allowIncompleteContext: false, maxSensitivity: 'public' as const,
    fields: [{ pointer: '/payload', output: 'payload', source: 'synthetic-corpus', subject: 'heldout-subject', trust: 'untrusted' as const,
      sensitivity: 'public' as const, purpose, retentionClass: 'qualification', accessScopes: ['heldout-reviewer'], exportPolicy: 'denied' as const,
      deletionPolicy: 'erase' as const, backupPolicy: 'not-persisted' as const, allowedProviders: ['jev'], allowedModels: [approval.model],
      allowedOrigins: [origin], allowedRegions: [approval.region] }] };
  const ruleset = contextLiveRuleset(definition.metadata.id, ['q0'], [definition]);
  const target = contextLiveTarget({ model: approval.model, secretServiceReference: approval.credentialRef }, '1.0.0', plan.requestTimeoutMs);
  return { definition, projection, ruleset, binding: contextLiveBinding(ruleset, ['q0'], target, plan.requestTimeoutMs) };
}
export function heldoutExecutionDigest(corpus: HeldoutCorpus, plan: HeldoutPreregistration, approval: HeldoutApproval): `sha256:${string}` {
  return sha256(corpus.definitions.map(definition => {
    const item = heldoutExecution(corpus, plan, approval, { id: 'pin', arm: 'pin', definitionId: definition.metadata.id });
    return { definition: artifactPin(item.definition), ruleset: artifactPin(item.ruleset), binding: artifactPin(item.binding), projection: sha256(item.projection),
      adapter: { id: 'jev', version: '1.0.0' } };
  }));
}
export function validateHeldoutBundle(bundle: HeldoutBundle, trustedApprovalDigest: string): void {
  admitEntry(bundle, limits);
  if (Object.keys(bundle).sort().join(',') !== 'approval,corpus,preregistration') throw new HeldoutError('bundle-fields');
  const { corpus, preregistration: plan, approval: a } = bundle;
  if (corpus?.study === 'D29') {
    if (D29_PUBLIC_DEMO_CORPORA.has(sha256(corpus))) throw new HeldoutError('public-demo-corpus');
    if (D29_PUBLIC_DEMO_SEEDS.has(corpus.provenance?.seed)) throw new HeldoutError('public-demo-seed');
    // A D29 bundle is paid-eligible only when every row comes from the current
    // paid-eligible D29 generator. Older D29 generators (v1–v7) reproduce public
    // development corpora only, and no other generator (lamp, D17) may be
    // relabelled as D29.
    const rows: unknown[] = Array.isArray(corpus.rows) ? corpus.rows : [];
    if (!rows.length || rows.some(row => !D29_PAID_GENERATOR_IDS.includes((row as HeldoutRow)?.provenance?.generatorId))) {
      throw new HeldoutError('paid-generator');
    }
  }
  if (usesD17MultifactGenerator(corpus?.rows)) {
    // D17-MF (#2850): only its own generator, only D17, only a private seed, only the registered calibrator (artifact mode).
    if (corpus.study !== 'D17' || corpus.rows.some(row => row?.provenance?.generatorId !== D17_MULTIFACT_GENERATOR_ID)) throw new HeldoutError('paid-generator');
    if (d17MultifactPublicSeed(corpus.provenance?.seed)) throw new HeldoutError('public-demo-seed');
    if (a?.calibration?.mode !== 'artifact') throw new HeldoutError('calibration-scope');
  }
  validateHeldoutInputs(corpus, plan);
  if (a?.priceBound?.outputUsdPerMTok !== 0) throw new HeldoutError('free-output-required');
  checkHeldoutSchema('Approval', a);
  if (redactText(JSON.stringify([plan, a])).sensitivity !== 'none') throw new HeldoutError('credential-material');
  if (!(plan.calibration.allowedModes as string[]).includes(a.calibration.mode)
    || a.calibration.mode === 'uncalibrated-diagnostic' && plan.calibration.scope !== 'uncalibrated-diagnostic') throw new HeldoutError('calibration-scope');
  if (!heldoutRowsInScope(bundle).length) throw new HeldoutError('calibration-phase-empty');
  if (sha256(a) !== trustedApprovalDigest || a.study !== corpus.study || a.corpusDigest !== sha256(corpus)
    || a.preregistrationDigest !== sha256(plan) || a.executionDigest !== heldoutExecutionDigest(corpus, plan, a)
    || a.budget.usd > HELDOUT_CAP_USD[a.study] || a.priorStudySpendUsd >= HELDOUT_CAP_USD[a.study]
    || a.priorPortfolioSpendUsd >= HELDOUT_PORTFOLIO_CAP_USD || a.region.toLowerCase() === 'unknown') throw new HeldoutError('approval-pins');
}
/** Input-only pricing: Jev has no remote generation limit, so paid output is inadmissible. */
export function heldoutReservationMicros(a: HeldoutApproval, inputTokenBound: number): number {
  if (a.priceBound.outputUsdPerMTok !== 0) throw new HeldoutError('free-output-required');
  if (!Number.isSafeInteger(inputTokenBound) || inputTokenBound < 1) throw new HeldoutError('input-bound');
  return dagLiveReservationMicros({ ...a.priceBound, perRequestUsd: undefined }, inputTokenBound)
    + Math.ceil(a.priceBound.perRequestUsd * 1_000_000);
}
export function heldoutReservationTokens(plan: HeldoutPreregistration, inputTokenBound: number): number {
  return inputTokenBound + plan.outputAndHiddenTokenAllowance;
}
export function heldoutRowsInScope(bundle: HeldoutBundle): HeldoutRow[] {
  const { calibration } = bundle.approval;
  if (calibration.mode !== 'staged') return bundle.corpus.rows;
  const plan = bundle.preregistration.calibration;
  if (plan.scope !== 'calibrated' || !plan.calibrationPhaseSplits?.length) throw new HeldoutError('calibration-scope');
  return bundle.corpus.rows.filter(row => calibration.phase === 'test' ? row.split === 'test'
    : (plan.calibrationPhaseSplits as string[]).includes(row.split));
}
export async function heldoutRequest(corpus: HeldoutCorpus, plan: HeldoutPreregistration, approval: HeldoutApproval,
  row: HeldoutRow, request: HeldoutRequest) {
  if (!heldoutRowsInScope({ corpus, preregistration: plan, approval }).some(item => item.id === row.id && sha256(item) === sha256(row))) {
    throw new HeldoutError('calibration-phase-row');
  }
  return heldoutRequestSize(corpus, plan, approval, row, request);
}
/**
 * The request a row would send and its preregistered size bound, for any row
 * of the corpus whatever the current phase. Only sizing and planning call it
 * directly; dispatch goes through heldoutRequest, which also checks the phase.
 */
export async function heldoutRequestSize(corpus: HeldoutCorpus, plan: HeldoutPreregistration, approval: HeldoutApproval,
  row: HeldoutRow, request: HeldoutRequest) {
  const execution = heldoutExecution(corpus, plan, approval, request);
  const projected = await projectDecisionState(row.input, execution.projection);
  const wire = { state: partitionProjectedState(projected.state, projected.evidence), model: approval.model,
    questions: { q0: JSON.parse(compileJevQuestion(execution.definition).question) } };
  // Provider-added input is covered by a preregistered allowance, not by a remote token limit.
  const requestBytes = Buffer.byteLength(JSON.stringify(wire), 'utf8');
  const inputTokenBound = requestBytes + (plan.providerOverheadTokens ?? 512);
  if (inputTokenBound + plan.outputAndHiddenTokenAllowance > plan.perRequestTokenBound) throw new HeldoutError('payload-bound');
  if (redactStructured(projected.state).sensitivity !== 'none') throw new HeldoutError('credential-material');
  return { execution, requestDigest: sha256(wire), requestBytes, estimatedTokens: inputTokenBound };
}
/**
 * Sizes every request of every corpus row, in every split, against the
 * preregistered per-request bound and refuses (`payload-bound`, naming the row
 * index) before any provider call. A staged run therefore learns at its
 * calibration phase, before any spend, that a later phase could not dispatch.
 */
export async function assertHeldoutRequestBounds(corpus: HeldoutCorpus, plan: HeldoutPreregistration, approval: HeldoutApproval) {
  for (const [index, row] of corpus.rows.entries()) for (const request of row.requests) {
    try { await heldoutRequestSize(corpus, plan, approval, row, request); }
    catch (error) {
      if (error instanceof HeldoutError && error.category === 'payload-bound') throw new HeldoutError('payload-bound', `row ${index}`);
      throw error;
    }
  }
}
export async function planHeldoutCollection(bundle: HeldoutBundle, digest: string) {
  validateHeldoutBundle(bundle, digest);
  await assertHeldoutRequestBounds(bundle.corpus, bundle.preregistration, bundle.approval);
  let maximumRequestEstimateTokens = 0, tokens = 0, usdMicros = 0;
  const rows = heldoutRowsInScope(bundle);
  for (const row of rows) for (const request of row.requests) {
    const planned = await heldoutRequest(bundle.corpus, bundle.preregistration, bundle.approval, row, request);
    maximumRequestEstimateTokens = Math.max(maximumRequestEstimateTokens, planned.estimatedTokens);
    const reservation = heldoutReservationMicros(bundle.approval, planned.estimatedTokens);
    if (reservation > Math.floor(bundle.approval.budget.usd * 1_000_000)) throw new HeldoutError('approval-call-budget');
    const attempts = 1 + bundle.preregistration.providerFailurePolicy.maxRetries;
    tokens += attempts * heldoutReservationTokens(bundle.preregistration, planned.estimatedTokens);
    usdMicros += attempts * reservation;
  }
  const attempts = rows.reduce((n, r) => n + r.requests.length, 0) * (1 + bundle.preregistration.providerFailurePolicy.maxRetries);
  const a = bundle.approval;
  return { calibration: structuredClone(a.calibration), rowsInScope: rows.map(row => row.id), providerCalls: 0, maximumAttempts: attempts, maximumRequestEstimateTokens, reservedTokens: tokens, reservedUsdMicros: usdMicros,
    fitsBeforeStop: attempts <= Math.floor(a.budget.calls * 0.8) && tokens <= Math.floor(a.budget.tokens * 0.8)
      && usdMicros <= Math.floor(Math.min(a.budget.usd, HELDOUT_CAP_USD[a.study] - a.priorStudySpendUsd,
        HELDOUT_PORTFOLIO_CAP_USD - a.priorPortfolioSpendUsd) * 800_000) };
}
/** An intentionally unapproved, unpriced form. Unknown attestations stay null, never fixture approvals. */
export function heldoutApprovalTemplate(corpus: HeldoutCorpus, plan: HeldoutPreregistration) {
  validateHeldoutInputs(corpus, plan);
  const attempts = corpus.rows.reduce((n, row) => n + row.requests.length, 0) * (1 + plan.providerFailurePolicy.maxRetries);
  return { schemaVersion: 'decision-heldout-approval/v1', approved: false, study: corpus.study, runId: null,
    reviewer: null, approvalReference: null, sourceCommit: null, exactHeadCi: null, stagingHost: 'titan', stagingWorkspace: null,
    model: 'jev-1.13.0', servedModel: 'jev-1.13.0', region: null, credentialRef: null, credentialResolverDigest: null,
    corpusDigest: sha256(corpus), preregistrationDigest: sha256(plan), executionDigest: null, calibration: plan.calibration.scope === 'uncalibrated-diagnostic'
      ? { mode: 'uncalibrated-diagnostic' } : null,
    providerTermsReference: null, priceBound: { inputUsdPerMTok: null, outputUsdPerMTok: null, perRequestUsd: null,
      evidenceReferences: [], approvalReference: null }, budget: { calls: Math.max(1, Math.ceil(attempts / 0.8)),
      tokens: Math.max(1, Math.ceil(attempts * (plan.perRequestTokenBound + plan.outputAndHiddenTokenAllowance) / 0.8)), usd: HELDOUT_CAP_USD[corpus.study] },
    priorStudySpendUsd: null, priorPortfolioSpendUsd: null };
}
export function validateHeldoutAttempt(attempt: HeldoutAttempt): void {
  checkHeldoutSchema('Attempt', attempt);
  if (attempt.result?.receipt) {
    validateDecisionDocument(attempt.result.receipt);
    if (attempt.result.receiptDigest !== sha256(attempt.result.receipt)) throw new HeldoutError('receipt-digest');
  } else if (attempt.result?.receiptDigest) throw new HeldoutError('receipt-missing');
}
