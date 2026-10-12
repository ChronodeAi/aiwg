import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../src/decision/compile-cache/identity.js';
import { artifactPin } from '../../src/decision/validate.js';
import { DECISION_API_VERSION, type DecisionBinding, type DecisionDefinition, type DecisionResult,
  type DecisionRuleset, type ExecutionTarget, type RulesetResult } from '../../src/decision/types.js';
import type { SensitivityRuntimeRequest } from '../../src/decision/sensitivity/types.js';

export const REPLAY_SEED = 'aiwg-holdout-2497b51d-v1';
export const REPLAY_CLOCK = '2026-09-30T12:00:00.000Z';
export const REPLAY_IDENTITY = { tenantId: 'synthetic-d23', workspaceId: 'synthetic-study', projectId: 'd23-replay', principalId: 'offline-study-host' };
export const REPLAY_SLICES = ['threshold-boundary', 'priority-loss', 'unchanged-control', 'unreplayable'] as const;
type Slice = typeof REPLAY_SLICES[number];
type Split = 'tuning' | 'calibration' | 'test';
export type StoredReplayRequest = Omit<SensitivityRuntimeRequest, 'now' | 'probeState' | 'reevaluate'>;
export interface ReplayGold {
  status: string;
  outcomeChanged: boolean;
  acceptanceChanged: boolean;
  ruleChanged: boolean;
  unreplayable: boolean;
}
export interface StoredReplayRoot {
  id: string;
  slice: Slice;
  split: Split;
  payloadDigest: `sha256:${string}`;
  request: StoredReplayRequest;
}

// These are reference semantics, not calls into acceptance, composition or the analyzer.
// Each family changes exactly one declared parameter from its authored source world.
const OPERATIONS = {
  'threshold-boundary': ['threshold-below', 'threshold-equal', 'threshold-above'],
  'priority-loss': ['priority-winner', 'loss-outcome'],
  'unchanged-control': ['unchanged-threshold', 'unchanged-priority'],
  unreplayable: ['unobserved-fallback', 'earlier-producing-target'],
} as const;
type Operation = typeof OPERATIONS[Slice][number];
const REFERENCE: Record<Operation, ReplayGold> = {
  'threshold-below': { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: false },
  'threshold-equal': { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: false },
  'threshold-above': { status: 'review', outcomeChanged: true, acceptanceChanged: true, ruleChanged: true, unreplayable: false },
  'priority-winner': { status: 'completed', outcomeChanged: true, acceptanceChanged: false, ruleChanged: true, unreplayable: false },
  'loss-outcome': { status: 'completed', outcomeChanged: true, acceptanceChanged: false, ruleChanged: false, unreplayable: false },
  'unchanged-threshold': { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: false },
  'unchanged-priority': { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: false },
  'unobserved-fallback': { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: true },
  'earlier-producing-target': { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: true },
};

/** Hash raw UTF-8 counter input, as specified by the study; bounded draws reject modulo bias. */
function draws(split: Split, familyId: string): (maximum: number) => number {
  let counter = 0;
  return maximum => {
    const limit = Math.floor(0x1_0000_0000 / maximum) * maximum;
    for (;;) {
      const bytes = createHash('sha256').update(`${REPLAY_SEED}:D23:${split}:${familyId}:${counter++}`).digest();
      const value = bytes.readUInt32BE(0);
      if (value < limit) return value % maximum;
    }
  };
}

function requestFor(id: string, split: Split, operation: Operation): StoredReplayRequest {
  const draw = draws(split, id);
  const confidenceBps = 6000 + draw(21) * 100;
  const originalThreshold = confidenceBps - 200;
  const loss = (draw(40) + 1) * 100;
  const subject = `Fable-${draw(1_000_000).toString().padStart(6, '0')}`;
  const inputSchema = { type: 'object', additionalProperties: false, required: ['subject', 'quantity'],
    properties: { subject: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } } };
  const definition: DecisionDefinition = {
    apiVersion: DECISION_API_VERSION, kind: 'DecisionDefinition',
    metadata: { id: 'synthetic-d23-choice', version: '1.0.0', description: 'Authored fictional stored evidence; no provider invocation' },
    spec: { purpose: 'Synthetic policy replay', inputSchema, question: 'Assign the fictional parcel to a bay.',
      answer: { kind: 'choice', options: [{ id: 'bay-a', description: 'Fictional bay A' }, { id: 'bay-b', description: 'Fictional bay B' }] },
      requiredCapabilities: [] },
  };
  const ruleset: DecisionRuleset = {
    apiVersion: DECISION_API_VERSION, kind: 'DecisionRuleset',
    metadata: { id: 'synthetic-d23-rules', version: '1.0.0', description: 'Authored parcel policy with finite loss outcomes' },
    spec: { purpose: 'Synthetic policy replay', inputSchema,
      evaluations: [{ alias: 'parcel', decision: artifactPin(definition), inputPointer: '' }],
      rules: [{ id: 'bay-a-rule', priority: 200,
        when: { op: 'eq', left: { source: 'decision', alias: 'parcel', pointer: '/value' }, right: 'bay-a' },
        outcome: { bay: 'a', loss } },
      { id: 'bay-b-rule', priority: 100,
        when: { op: 'eq', left: { source: 'decision', alias: 'parcel', pointer: '/value' }, right: 'bay-a' },
        outcome: { bay: 'b', loss: loss + 100 } }],
      composition: 'first-match', conflict: 'review', defaultOutcome: { bay: 'review', loss: 0 }, failureOutcome: { bay: 'review', loss: 0 },
      outputSchema: { type: 'object', additionalProperties: false, required: ['bay', 'loss'],
        properties: { bay: { enum: ['a', 'b', 'review'] }, loss: { type: 'integer', minimum: 0 } } } },
  };
  const target: ExecutionTarget = { adapter: 'jev', adapterVersion: 'synthetic-only-v1', model: 'synthetic-no-provider-primary', credentialRef: 'synthetic-unresolvable-reference',
    requiredCapabilities: [], acceptance: { mode: 'confidence-threshold', profile: 'synthetic-distribution-v1', minimumBps: originalThreshold },
    timeoutMs: 1000, retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 } };
  const binding: DecisionBinding = {
    apiVersion: DECISION_API_VERSION, kind: 'DecisionBinding',
    metadata: { id: 'synthetic-d23-binding', version: '1.0.0', description: 'Inert stored identities; the opaque credential reference has no resolver or secret' },
    spec: { ruleset: artifactPin(ruleset), totalTimeoutMs: 3000, maxAttempts: 2, concurrency: 1,
      evaluations: { parcel: { targets: [target], fallbackOn: [] } } },
  };
  const unreplayable = operation === 'unobserved-fallback' || operation === 'earlier-producing-target';
  if (unreplayable) {
    binding.spec.evaluations.parcel!.targets.push({ ...structuredClone(target), model: 'synthetic-no-provider-secondary' });
    binding.spec.evaluations.parcel!.fallbackOn = ['low-confidence'];
  }
  if (operation === 'earlier-producing-target') {
    binding.spec.evaluations.parcel!.targets[0]!.acceptance = { mode: 'confidence-threshold', profile: 'synthetic-distribution-v1', minimumBps: confidenceBps + 100 };
  }
  const rulesetPin = artifactPin(ruleset); const bindingPin = artifactPin(binding);
  const producer = operation === 'earlier-producing-target' ? 1 : 0;
  const evaluation: DecisionResult = {
    apiVersion: DECISION_API_VERSION, kind: 'DecisionResult',
    metadata: { id: `${id}-evidence`, version: '1.0.0', description: 'Synthetic observation and attempt lineage, never a live receipt' },
    spec: { decision: artifactPin(definition), ruleset: rulesetPin, binding: bindingPin, alias: 'parcel', runId: id, invocationId: `${id}-synthetic-source`,
      status: 'success', value: 'bay-a', reason: 'none',
      uncertainty: { source: 'derived', profile: 'synthetic-distribution-v1', calibration: 'uncalibrated',
        confidence: confidenceBps / 10000, distribution: { 'bay-a': confidenceBps / 10000, 'bay-b': (10000 - confidenceBps) / 10000 }, calibrationRef: null },
      attempts: Array.from({ length: producer + 1 }, (_, index) => ({ ordinal: index + 1, adapter: 'jev', adapterVersion: 'synthetic-only-v1',
        requestedModel: binding.spec.evaluations.parcel!.targets[index]!.model,
        actualModel: binding.spec.evaluations.parcel!.targets[index]!.model, subagent: null,
        status: index === producer ? 'success' : 'abstained', reason: index === producer ? 'none' : 'low-confidence',
        durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, requestId: null })),
    },
  };
  const sourceResult: RulesetResult = { apiVersion: DECISION_API_VERSION, kind: 'RulesetResult',
    metadata: { id: `${id}-source`, version: '1.0.0', description: 'Synthetic source result authored from the latent world' },
    spec: { ruleset: rulesetPin, binding: bindingPin, runId: id, invocationId: `${id}-synthetic-source`, status: 'completed', reason: 'none',
      outcome: { bay: 'a', loss }, matchedRules: ['bay-a-rule'], evaluations: { parcel: evaluation } } };
  let path = '/binding/spec/evaluations/parcel/targets/0/acceptance/minimumBps';
  let value = originalThreshold;
  if (operation === 'threshold-below') value = confidenceBps - 100;
  if (operation === 'threshold-equal') value = confidenceBps;
  if (operation === 'threshold-above' || operation === 'unobserved-fallback') value = confidenceBps + 100;
  if (operation === 'priority-winner' || operation === 'unchanged-priority') {
    path = '/ruleset/spec/rules/1/priority'; value = operation === 'priority-winner' ? 300 : 100;
  }
  if (operation === 'loss-outcome') { path = '/ruleset/spec/rules/0/outcome/loss'; value = loss + 100; }
  const { principalId, ...scope } = REPLAY_IDENTITY;
  return {
    plan: { schemaVersion: 'decision-sensitivity-plan/v1', id: `${id}-plan`, version: '1.0.0', mode: 'shadow', ...scope,
      actor: { principalId, authenticatedAt: REPLAY_CLOCK }, purpose: 'Offline synthetic comparative policy diagnostics',
      sourceSubject: { ...scope, subjectRef: id },
      source: { ruleset: rulesetPin, binding: bindingPin, result: artifactPin(sourceResult), evidencePins: [artifactPin(evaluation)], policyPins: [rulesetPin, bindingPin] },
      analysisKind: 'policy-replay', allowedPaths: [path], pathDomains: [{ path, values: [value], sensitivity: 'public' }],
      variants: [{ id: `${id}-variant`, changes: [{ path, value }] }],
      budgets: { maxVariants: 1, maxBackendCalls: 0, maxTokens: 0, maxCostMicros: 0, concurrency: 1, deadlineMs: 1000 },
      privacy: { egress: 'no-external-egress', redaction: 'hash-values', summaryPrecisionBps: 100, differencing: 'deny' },
      retention: { class: 'review-evidence', deleteAfterEpochMs: Date.parse('2027-09-30T12:00:00.000Z'), legalHold: false },
      baselineStability: { enabled: false, repeats: 0 }, unchangedVariant: 'retain-control',
      authorization: { authorizedLabels: [], authorizedActions: [], approvedAt: REPLAY_CLOCK, expiresAt: '2026-10-01T12:00:00.000Z' },
      probeControl: { windowId: 'synthetic-d23-study-window', maxPerPrincipalSubjectPath: 2, maxReportsPerWindow: 2, prohibitMembershipQueries: true },
      requestedMetrics: ['outcome-change', 'acceptance-change', 'rule-change', 'distribution-distance'], comparisonBaseline: 'source-result' },
    sourceRuleset: ruleset, sourceBinding: binding, sourceDefinitions: { [definition.metadata.id]: definition },
    sourceInput: { subject, quantity: draw(10000) + 1 }, sourceResult, generatedAt: REPLAY_CLOCK, probeIdentity: structuredClone(REPLAY_IDENTITY),
  };
}

export function generateComparativeReplayCorpus() {
  const generatorDigest = sha256(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  const roots: StoredReplayRoot[] = [];
  const labels: Array<{ id: string; gold: ReplayGold }> = [];
  const families: Array<{ id: string; slice: Slice; split: Split; operation: Operation }> = [];
  // Assign complete family memberships and ID-ordered operation quotas before drawing values.
  for (const split of ['tuning', 'calibration', 'test'] as const) {
    for (const slice of REPLAY_SLICES) {
      for (let index = 0; index < (split === 'test' ? 100 : 25); index += 1) {
        families.push({ id: `d23-${split}-${slice}-${String(index + 1).padStart(3, '0')}`, slice, split,
          operation: OPERATIONS[slice][index % OPERATIONS[slice].length]! });
      }
    }
  }
  families.sort((left, right) => left.id.localeCompare(right.id));
  for (const family of families) {
    const request = requestFor(family.id, family.split, family.operation);
    roots.push({ id: family.id, slice: family.slice, split: family.split, payloadDigest: sha256(request), request });
    labels.push({ id: family.id, gold: structuredClone(REFERENCE[family.operation]) });
  }
  const members = roots.map(root => ({ id: root.id, slice: root.slice, split: root.split,
    sourceResultDigest: artifactPin(root.request.sourceResult).digest, planDigest: sha256(root.request.plan), payloadDigest: root.payloadDigest }));
  const inputDigests = roots.map(root => sha256(root.request.sourceInput));
  const corpus = { schemaVersion: 'decision-comparative-replay-corpus/v1', seed: REPLAY_SEED, generatorDigest,
    origin: 'locally-authored-synthetic', fixtureClock: REPLAY_CLOCK, proceduralFreeze: 'pending-operator-record',
    hostIdentity: REPLAY_IDENTITY, hostProbeQuota: { maxEntriesPerPrincipal: 600, maxReportsPerWindow: 2, maxPerPrincipalSubjectPath: 2 },
    deduplication: { roots: roots.length, payloads: new Set(roots.map(root => root.payloadDigest)).size,
      duplicatePayloads: roots.length - new Set(roots.map(root => root.payloadDigest)).size,
      sourceInputs: new Set(inputDigests).size, duplicateSourceInputs: roots.length - new Set(inputDigests).size, crossSplitFamilies: 0 }, roots };
  const gold = { schemaVersion: 'decision-comparative-replay-gold/v1', comparatorVersion: 'policy-replay-reference-v1', generatorDigest, roots: labels };
  const split = { schemaVersion: 'decision-comparative-replay-split/v1', generatorDigest, families, members };
  const assessments: Array<{ assessmentId: string; phase: string; rootId: string; repeatOf: string | null; pairOrder: string }> = [];
  for (const phase of ['development', 'holdout'] as const) {
    for (const slice of REPLAY_SLICES) {
      const selected = roots.filter(root => root.slice === slice && root.split === (phase === 'development' ? 'tuning' : 'test')).slice(0, 5);
      for (const root of selected) assessments.push({ assessmentId: `audit-${String(assessments.length + 1).padStart(2, '0')}`,
        phase, rootId: root.id, repeatOf: null, pairOrder: draws(root.split, `${root.id}-audit-pair`)(2) === 0 ? 'gold-report' : 'report-gold' });
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const original = assessments[20 + index * 5]!;
    assessments.push({ ...original, assessmentId: `audit-${41 + index}`, phase: 'delayed-repeat', repeatOf: original.assessmentId,
      pairOrder: original.pairOrder === 'gold-report' ? 'report-gold' : 'gold-report' });
  }
  const auditSample = { schemaVersion: 'decision-comparative-replay-audit-sample/v1', generatorDigest,
    splitDigest: sha256(members), goldDigest: sha256(labels), status: 'pending', reviewer: null, completedAt: null,
    itemAssessments: 44, uniqueDevelopmentRoots: 20, uniqueHoldoutRoots: 20, delayedRepeats: 4,
    artifactReviews: [{ artifact: 'protocol-preregistration', status: 'pending' }, { artifact: 'final-comparative-report', status: 'pending' }],
    blinding: 'Operator-only deterministic blinded A/B key: hide rootId, repeatOf, pairOrder, source identities and prior answers in reviewer packets; expose only assessmentId and shuffled A/B diagnostic claims.',
    assessments };
  const reviewTemplate = `# D23 synthetic replay operator review

Status: pending. Reviewer: roctinam (not yet attested). No review result, freeze event, or independent holdout certification is recorded by these fixtures.

## Protocol review before test access

Review \`tools/decision/comparative-replay-corpus.ts\`, \`corpus.json\`, development-only \`gold.json\` rows, \`split.json\`, and the proposed preregistration. Confirm 100 tuning, 100 calibration-membership (no model calibration), 400 test roots; 100 test roots per slice. One variant per family stays in one split. Confirm synthetic-only provenance and zero transport, token and API-dollar budgets. Record the clean source commit, generator/corpus/gold/split/preregistration digests, actual freeze time, first test-access time and approval reference in a separate immutable operator record. The fixture clock and fixture authorization fields are simulated and are not operator approval.

Reference guide: threshold equality accepts; a higher confidence threshold reviews; the greatest matching rule priority wins; changing a selected rule's loss outcome changes the outcome only. Identical policies are controls. Unobserved fallback or a changed earlier failed target is unreplayable, never evidence of no change. Loss outcomes here are finite deterministic rule costs, not a learned loss matrix or economics benefit claim. Audit the reference table against those public semantics without consulting analyzer output.

Protocol disposition: pending. Operator record/reference: ____ Actual frozen at: ____ Test first accessed at: ____

## Item assessments

Use \`audit-sample.json\` as an operator-only key. Review 20 development oracle scenarios before freeze. After collecting reports, prepare the selected 20 holdout gold/report pairs with A/B assignment from pairOrder; hide assignment, root IDs, split, report identity, source metadata and prior verdicts. Strip any schema/digest fields that reveal which claim is gold. Preserve status, acceptance-change, outcome-change, rule-change and unreplayable claims. Present the four repeat packets after a delay without repeat labels. Keep the mapping separately from the reviewer packet. This is one reviewer and four intra-rater repeats, not independent or inter-rater agreement.

| Assessment | Gold/claim correctness | Ambiguity | A/B agreement | Override and rationale | Reviewer | Timestamp |
| --- | --- | --- | --- | --- | --- | --- |
${assessments.map(item => `| ${item.assessmentId} | pending | pending | pending | pending | | |`).join('\n')}

Any incorrect or ambiguous gold invalidates the affected preregistered analysis. Do not relabel, replace, omit or resample it after test access; revise the generator and create an independent holdout under a new protocol. Repeats do not increase independent N. Report agreement only for the audited roots.

## Final report review

Review the full comparative report, upstream eval-integrity envelope and its trusted digest, protected-artifact evidence, preregistration, all 400 test diagnostic report digests, exact reproduction result, root-level gates, four slice gates and the completed audit record. Require exact agreement for every replayable row and no false no-change claims for unreplayable rows. Require Newcombe-10 lower bound at 95% at least −100 bps, overall Wilson error upper at most 100 bps, and each slice at least 100 roots with zero known errors and Wilson upper at most 500 bps. Verify measured replay calls/tokens/cost all zero. Preserve upstream HOLD/ROLLBACK.

Final disposition: pending. Report digest: ____ Review record digest: ____ Reviewer/time: ____

No causal, model-quality, reviewer-time, live reevaluation, production promotion, durable cross-restart anti-probing or deletion/backups claim follows from this synthetic diagnostic audit.
`;
  return { corpus, gold, split, auditSample, reviewTemplate };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] ?? 'test/fixtures/decision/comparative-replay');
  const artifacts = generateComparativeReplayCorpus();
  mkdirSync(output, { recursive: true });
  const { roots, ...metadata } = artifacts.corpus;
  writeFileSync(resolve(output, 'corpus.json'), `${JSON.stringify(metadata).slice(0, -1)},"roots":[\n${roots.map(root => JSON.stringify(root)).join(',\n')}\n]}\n`);
  for (const [name, value] of Object.entries({ gold: artifacts.gold, split: artifacts.split, 'audit-sample': artifacts.auditSample })) {
    writeFileSync(resolve(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  writeFileSync(resolve(output, 'review-template.md'), artifacts.reviewTemplate);
  process.stdout.write(`Wrote synthetic replay fixtures to ${dirname(resolve(output, 'corpus.json'))}\n`);
}
