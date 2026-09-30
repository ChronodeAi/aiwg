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
import { CanonicalJsonByteEstimator } from '../context-plan.js';
import { dagLiveReservationMicros } from '../graph-live-qualification.js';
import { redactStructured, redactText } from '../../governance/redaction.js';
import type { HeldoutApproval, HeldoutAttempt, HeldoutBundle, HeldoutCorpus, HeldoutExecution,
  HeldoutPreregistration, HeldoutRequest, HeldoutRow, Study } from './types.js';

export { sha256 as heldoutDigest };
export const HELDOUT_CAP_USD: Readonly<Record<Study, number>> = Object.freeze({ D17: 8, D29: 6 });
export const HELDOUT_PORTFOLIO_CAP_USD = 48;
export const HELDOUT_ENV_GATE = 'AIWG_DECISION_HELDOUT_LIVE';
const limits = { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 32_000_000, properties: 1_000_000,
  arrayLength: 20000, entries: 2_000_000, memoryBytes: 256_000_000 };
const validators = new Map<string, ValidateFunction>();
export class HeldoutError extends Error {
  constructor(readonly category: string) { super(`Held-out collector refused (${category})`); }
}
export function checkHeldoutSchema(kind: 'Corpus' | 'Preregistration' | 'Approval' | 'Attempt' | 'Event' | 'Summary' | 'Frozen', value: unknown): void {
  admitEntry(value, limits);
  let validate = validators.get(kind);
  if (!validate) {
    const here = dirname(fileURLToPath(import.meta.url));
    const name = `Heldout${kind}.v1.schema.json`;
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
  const ids = new Set<string>(), families = new Map<string, string>(), payloads = new Set<string>();
  const definitions = new Set(corpus.definitions.map(d => d.metadata.id));
  corpus.definitions.forEach(validateDefinition);
  if (definitions.size !== corpus.definitions.length || plan.study !== corpus.study || plan.corpusDigest !== sha256(corpus)
    || plan.outputAndHiddenTokenAllowance >= plan.perRequestTokenBound) throw new HeldoutError('input-pins');
  for (const row of corpus.rows) {
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
  validateHeldoutInputs(corpus, plan); checkHeldoutSchema('Approval', a);
  if (redactText(JSON.stringify([plan, a])).sensitivity !== 'none') throw new HeldoutError('credential-material');
  if (sha256(a) !== trustedApprovalDigest || a.study !== corpus.study || a.corpusDigest !== sha256(corpus)
    || a.preregistrationDigest !== sha256(plan) || a.executionDigest !== heldoutExecutionDigest(corpus, plan, a)
    || a.budget.usd > HELDOUT_CAP_USD[a.study] || a.priorStudySpendUsd >= HELDOUT_CAP_USD[a.study]
    || a.priorPortfolioSpendUsd >= HELDOUT_PORTFOLIO_CAP_USD || a.region.toLowerCase() === 'unknown') throw new HeldoutError('approval-pins');
}
/** Token reservation uses the existing price-floor helper; a flat fee is additive, not a minimum. */
export function heldoutReservationMicros(a: HeldoutApproval, plan: HeldoutPreregistration): number {
  return dagLiveReservationMicros({ ...a.priceBound, perRequestUsd: undefined }, plan.perRequestTokenBound)
    + Math.ceil(a.priceBound.perRequestUsd * 1_000_000);
}
export async function heldoutRequest(corpus: HeldoutCorpus, plan: HeldoutPreregistration, approval: HeldoutApproval,
  row: HeldoutRow, request: HeldoutRequest) {
  const execution = heldoutExecution(corpus, plan, approval, request);
  const projected = await projectDecisionState(row.input, execution.projection);
  const wire = { state: partitionProjectedState(projected.state, projected.evidence), model: approval.model,
    questions: { q0: JSON.parse(compileJevQuestion(execution.definition).question) } };
  const estimate = new CanonicalJsonByteEstimator('1.0.0', 1).estimate(wire as import('../context-plan.js').ContextValue);
  if (estimate.tokens + plan.outputAndHiddenTokenAllowance > plan.perRequestTokenBound) throw new HeldoutError('payload-bound');
  if (redactStructured(projected.state).sensitivity !== 'none') throw new HeldoutError('credential-material');
  return { execution, requestDigest: sha256(wire), estimatedTokens: estimate.tokens };
}
export async function planHeldoutCollection(bundle: HeldoutBundle, digest: string) {
  validateHeldoutBundle(bundle, digest);
  let maximumRequestEstimateTokens = 0;
  for (const row of bundle.corpus.rows) for (const request of row.requests) {
    const planned = await heldoutRequest(bundle.corpus, bundle.preregistration, bundle.approval, row, request);
    maximumRequestEstimateTokens = Math.max(maximumRequestEstimateTokens, planned.estimatedTokens);
  }
  const attempts = bundle.corpus.rows.reduce((n, r) => n + r.requests.length, 0) * (1 + bundle.preregistration.providerFailurePolicy.maxRetries);
  const tokens = attempts * bundle.preregistration.perRequestTokenBound;
  const usdMicros = attempts * heldoutReservationMicros(bundle.approval, bundle.preregistration);
  const a = bundle.approval;
  return { providerCalls: 0, maximumAttempts: attempts, maximumRequestEstimateTokens, reservedTokens: tokens, reservedUsdMicros: usdMicros,
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
    corpusDigest: sha256(corpus), preregistrationDigest: sha256(plan), executionDigest: null, calibrationDigest: null,
    providerTermsReference: null, priceBound: { inputUsdPerMTok: null, outputUsdPerMTok: null, perRequestUsd: null,
      evidenceReferences: [], approvalReference: null }, budget: { calls: Math.max(1, Math.ceil(attempts / 0.8)),
      tokens: Math.max(1, Math.ceil(attempts * plan.perRequestTokenBound / 0.8)), usd: HELDOUT_CAP_USD[corpus.study] },
    priorStudySpendUsd: null, priorPortfolioSpendUsd: null };
}
export function validateHeldoutAttempt(attempt: HeldoutAttempt): void {
  checkHeldoutSchema('Attempt', attempt);
  if (attempt.result?.receipt) {
    validateDecisionDocument(attempt.result.receipt);
    if (attempt.result.receiptDigest !== sha256(attempt.result.receipt)) throw new HeldoutError('receipt-digest');
  } else if (attempt.result?.receiptDigest) throw new HeldoutError('receipt-missing');
}
