import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { admitEntry, DEFAULT_ENTRY_LIMITS } from '../../src/decision/entry.js';
import { sha256 } from '../../src/decision/compile-cache/identity.js';
import type { generateComparativeReplayCorpus } from './comparative-replay-corpus.js';

type ReplayAssets = ReturnType<typeof generateComparativeReplayCorpus>;
export const REPLAY_ASSET_SCHEMAS = {
  corpus: 'DecisionComparativeReplayCorpus.v1.schema.json',
  gold: 'DecisionComparativeReplayGoldAsset.v1.schema.json',
  split: 'DecisionComparativeReplaySplit.v1.schema.json',
  auditSample: 'DecisionComparativeReplayAuditSample.v1.schema.json',
} as const;
const STUDY_LIMITS = { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 16 * 1024 * 1024,
  properties: 300_000, entries: 500_000, arrayLength: 600, memoryBytes: 64 * 1024 * 1024, timeMs: 5000 };
let validators: Map<keyof typeof REPLAY_ASSET_SCHEMAS, ValidateFunction> | null = null;
const REVIEW_SCHEMAS = {
  packets: 'DecisionComparativeReplayReviewPackets.v1.schema.json',
  freeze: 'DecisionComparativeReplayFreeze.v1.schema.json',
} as const;
let reviewValidators: Map<keyof typeof REVIEW_SCHEMAS, ValidateFunction> | null = null;

function loadValidators(): NonNullable<typeof validators> {
  if (validators) return validators;
  const ajv = new Ajv2020({ strict: true, allErrors: false });
  addFormats(ajv);
  const directory = resolve(import.meta.dirname, '../../schemas/decision');
  const dependencies = ['DecisionSensitivityPlan.v1.schema.json', 'DecisionDefinition.schema.json',
    'DecisionBinding.schema.json', 'DecisionRuleset.schema.json', 'RulesetResult.schema.json',
    'DecisionComparativeReplayGold.v1.schema.json', 'DecisionComparativeReplayMembers.v1.schema.json'];
  for (const file of [...dependencies, ...Object.values(REPLAY_ASSET_SCHEMAS), ...Object.values(REVIEW_SCHEMAS)]) {
    ajv.addSchema(JSON.parse(readFileSync(resolve(directory, file), 'utf8')));
  }
  validators = new Map(Object.entries(REPLAY_ASSET_SCHEMAS).map(([key, file]) => [key as keyof typeof REPLAY_ASSET_SCHEMAS,
    ajv.getSchema(`https://aiwg.io/schemas/decision/${file}`)!]));
  reviewValidators = new Map(Object.entries(REVIEW_SCHEMAS).map(([key, file]) => [key as keyof typeof REVIEW_SCHEMAS,
    ajv.getSchema(`https://aiwg.io/schemas/decision/${file}`)!]));
  return validators;
}

function validateReviewArtifact(kind: keyof typeof REVIEW_SCHEMAS, value: unknown): void {
  admitEntry(value, STUDY_LIMITS);
  loadValidators();
  const validate = reviewValidators!.get(kind)!;
  if (!validate(value)) throw new Error(`invalid replay ${kind}: ${validate.errors?.[0]?.instancePath ?? '/'}`);
}

export function validateReplayReviewPackets(value: unknown): void {
  validateReviewArtifact('packets', value);
  const packets = (value as { packets: Array<{ assessmentId: string }> }).packets;
  if (new Set(packets.map(packet => packet.assessmentId)).size !== 44) throw new Error('duplicate review packet assessment');
}

export function validateReplayFreeze(value: unknown): void {
  validateReviewArtifact('freeze', value);
}

/** Validate closed study assets before hashing or using stored requests; no network schema loader. */
export function validateReplayAssets(value: unknown): asserts value is ReplayAssets {
  admitEntry(value, STUDY_LIMITS);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid replay assets');
  const assets = value as ReplayAssets;
  const expectedKeys = [...Object.keys(REPLAY_ASSET_SCHEMAS), 'reviewTemplate'].sort();
  if (JSON.stringify(Object.keys(assets).sort()) !== JSON.stringify(expectedKeys) || typeof assets.reviewTemplate !== 'string') {
    throw new Error('invalid replay asset envelope');
  }
  for (const [key, validate] of loadValidators()) {
    if (!validate(assets[key])) throw new Error(`invalid replay ${key}: ${validate.errors?.[0]?.instancePath ?? '/'}`);
  }
  if (new Set([assets.corpus.generatorDigest, assets.gold.generatorDigest, assets.split.generatorDigest, assets.auditSample.generatorDigest]).size !== 1) {
    throw new Error('replay generator digests differ');
  }
  const roots = new Map(assets.corpus.roots.map(root => [root.id, root]));
  const members = new Map(assets.split.members.map(member => [member.id, member]));
  const gold = new Map(assets.gold.roots.map(row => [row.id, row]));
  const families = new Map(assets.split.families.map(row => [row.id, row]));
  if ([roots, members, gold, families].some(map => map.size !== 600)
    || new Set(assets.corpus.roots.map(root => sha256(root.request.sourceInput))).size !== 600) throw new Error('duplicate replay roots or inputs');
  for (const root of assets.corpus.roots) {
    const member = members.get(root.id); const family = families.get(root.id);
    if (!member || !family || !gold.has(root.id) || member.slice !== root.slice || member.split !== root.split
      || family.slice !== root.slice || family.split !== root.split || sha256(root.request) !== root.payloadDigest
      || member.payloadDigest !== root.payloadDigest || member.planDigest !== sha256(root.request.plan)
      || member.sourceResultDigest !== sha256(root.request.sourceResult)
      || sha256(root.request.probeIdentity) !== sha256(assets.corpus.hostIdentity)) throw new Error(`replay root binding differs: ${root.id}`);
    if (root.request.plan.mode !== 'shadow' || root.request.plan.analysisKind !== 'policy-replay'
      || root.request.plan.budgets.maxBackendCalls !== 0 || root.request.plan.budgets.maxTokens !== 0
      || root.request.plan.budgets.maxCostMicros !== 0) throw new Error('replay request is not zero-call shadow policy');
  }
  for (const split of ['tuning', 'calibration', 'test']) {
    for (const slice of ['threshold-boundary', 'priority-loss', 'unchanged-control', 'unreplayable']) {
      if (assets.corpus.roots.filter(root => root.split === split && root.slice === slice).length !== (split === 'test' ? 100 : 25)) {
        throw new Error('replay slice quota differs');
      }
    }
  }
  if (assets.auditSample.splitDigest !== sha256(assets.split.members) || assets.auditSample.goldDigest !== sha256(assets.gold.roots)) {
    throw new Error('replay audit digests differ');
  }
  const assessments = new Map(assets.auditSample.assessments.map(item => [item.assessmentId, item]));
  if (assessments.size !== 44) throw new Error('duplicate audit assessment');
  for (const item of assessments.values()) {
    const root = roots.get(item.rootId);
    if (!root || (item.phase === 'development' ? root.split !== 'tuning' : root.split !== 'test')) throw new Error('audit root is outside its phase');
    if (item.phase === 'delayed-repeat') {
      const original = item.repeatOf ? assessments.get(item.repeatOf) : null;
      if (!original || original.phase !== 'holdout' || original.rootId !== item.rootId) throw new Error('audit repeat differs');
    } else if (item.repeatOf !== null) throw new Error('unexpected audit repeat');
  }
  for (const [phase, count] of [['development', 20], ['holdout', 20], ['delayed-repeat', 4]] as const) {
    const items = assets.auditSample.assessments.filter(item => item.phase === phase);
    if (items.length !== count || new Set(items.map(item => item.rootId)).size !== count) throw new Error('audit assessment quota differs');
  }
}
