import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { canonicalJson } from '../security/artifact-trust.js';
import { artifactDigest, artifactPin, assertArtifactPin, validateDecisionDocument } from './validate.js';
import { allocateEstimatedUsage } from './batch-receipts/accounting.js';
import { type ArtifactPin, type DecisionBinding, type DecisionDefinition,
  type DecisionBatchRequestUsage, type DecisionResult, type DecisionRuleset, type DecisionUsage, type RulesetResult } from './types.js';
import { type DecisionLifecycleHold, type DecisionLifecyclePolicy, type DecisionLifecycleReference,
  type DecisionLifecycleReferenceState, type DecisionLifecycleStore, validateDecisionLifecyclePolicy } from './lifecycle.js';
import { verifyQualificationReleaseDigest, type QualificationIntegrityMetadata, type QualificationReleaseRecord } from './qualification/release.js';

export const DECISION_FEATURE_EXPORT_VERSION = 'decision-feature-export/v1' as const;
export const DECISION_FEATURE_SET_KIND = 'DecisionFeatureSet' as const;
export const DECISION_FEATURE_OBSERVATION_KIND = 'DecisionFeatureObservation' as const;
export const DECISION_FEATURE_EXPORT_MANIFEST_KIND = 'DecisionFeatureExportManifest' as const;

export type DecisionFeatureValueType = 'number' | 'string' | 'boolean';
export type DecisionFeaturePrimitive = 'choice' | 'ordinal-score' | 'truth-probability' | 'ruleset';
export type DecisionFeatureProvenanceKind =
  | 'provider-native'
  | 'model-self-report'
  | 'adapter-one-hot'
  | 'derived'
  | 'calibrated'
  | 'missing';
export type DecisionFeatureMissingReason =
  | 'not-applicable'
  | 'unsupported-old-field'
  | 'missing-evidence'
  | 'incompatible-primitive'
  | 'calibration-unavailable';
export type DecisionFeatureObservationState = 'present' | 'missing';
export type DecisionFeatureExportOperation = 'create' | 'list' | 'read' | 'export' | 'delete' | 'share';
export type DecisionFeatureExportFormat = 'jsonl' | 'csv';

export interface DecisionFeatureExportIdentity {
  tenantId: string;
  projectId: string;
  actorId: string;
  recipient: string;
  purpose: string;
  datasetPolicyId: string;
  accessScope: string;
}

export interface DecisionFeatureExportPolicy extends DecisionFeatureExportIdentity {
  operations: DecisionFeatureExportOperation[];
  allowExternalDelivery: boolean;
  allowRawState: false;
  allowOutcomeLabels: false;
  reidentificationCanary?: string;
}

export interface DecisionFeatureSourcePins {
  ruleset: ArtifactPin;
  binding: ArtifactPin;
  definitions: Record<string, ArtifactPin>;
  adapters: Record<string, { adapter: string; adapterVersion: string; requestedModel: string; servedModel: string | null }>;
  calibration: Record<string, { calibrationRef: string; maxAgeMs: number | null; recordedAtEpochMs: number | null }>;
}

export interface DecisionFeatureColumn {
  name: string;
  alias: string;
  primitive: DecisionFeaturePrimitive;
  valueType: DecisionFeatureValueType;
  nullable: boolean;
  order: number;
  domain?: string[];
  source: DecisionFeatureProvenanceKind;
  uncertaintyProfile: string | null;
  calibrationRef: string | null;
  derivation: { algorithm: string; version: string } | null;
  description: string;
}

export interface DecisionFeatureSet {
  schemaVersion: typeof DECISION_FEATURE_EXPORT_VERSION;
  kind: typeof DECISION_FEATURE_SET_KIND;
  metadata: { id: string; version: string; description: string; digest: `sha256:${string}` };
  spec: {
    pins: DecisionFeatureSourcePins;
    compatibleServedModels: Record<string, string[]>;
    missingValuePolicy: {
      numeric: 'null';
      categorical: 'null';
      missingStateColumn: true;
      missingNeverZero: true;
    };
    ordering: 'definition-pins-declared-order';
    privacy: {
      classification: 'internal' | 'confidential' | 'restricted';
      retentionMs: number;
      accessScope: string;
      exportPolicyId: string;
      deletion: 'erase' | 'tombstone';
      lifecycleSurface: 'export';
    };
    columns: DecisionFeatureColumn[];
  };
}

export interface DecisionFeatureCell {
  value: number | string | boolean | null;
  state: DecisionFeatureObservationState;
  source: DecisionFeatureProvenanceKind;
  missingReason: DecisionFeatureMissingReason | null;
  calibrationRef: string | null;
  derivation: { algorithm: string; version: string } | null;
  evidencePath: string;
}

export interface DecisionFeatureBatchOwnerReference {
  ownerId: string;
  runId: string;
  invocationId: string;
  groupId: string | null;
  ordinal: number | null;
  requestId: string | null;
  questionIds: string[];
  usageDigest: `sha256:${string}` | null;
}

export interface DecisionFeatureBatchAccounting {
  scope: 'none' | 'ruleset-batch-request' | 'durable-batch-receipt';
  reference: string | null;
  authoritativeUsage: null;
  owners: DecisionFeatureBatchOwnerReference[];
  allocation: {
    kind: 'none' | 'estimated';
    algorithm: string | null;
    algorithmVersion: string | null;
    usage: DecisionUsage | null;
  };
}

export interface DecisionFeatureObservation {
  schemaVersion: typeof DECISION_FEATURE_EXPORT_VERSION;
  kind: typeof DECISION_FEATURE_OBSERVATION_KIND;
  featureSet: { id: string; version: string; digest: `sha256:${string}` };
  observationId: string;
  subjectId: string;
  eventTime: string;
  exportTime: string;
  sourceReceipt: { kind: 'DecisionResult' | 'RulesetResult'; runId: string; invocationId: string; alias: string | null };
  authorization: DecisionFeatureExportIdentity;
  lifecycle: { surface: 'export'; reference: string; tombstone: boolean; legalHold: boolean; expiresAtEpochMs: number; revokedAtEpochMs: number | null; deletedAtEpochMs: number | null };
  lineage: { ruleset: ArtifactPin; binding: ArtifactPin; decision: ArtifactPin | null; definition: ArtifactPin | null };
  trainServe: { featureSetDigest: `sha256:${string}`; servedModels: Record<string, string | null>; calibrationRefs: Record<string, string | null> };
  batchAccounting: DecisionFeatureBatchAccounting;
  features: Record<string, DecisionFeatureCell>;
}

export interface DecisionFeatureExportManifest {
  schemaVersion: typeof DECISION_FEATURE_EXPORT_VERSION;
  kind: typeof DECISION_FEATURE_EXPORT_MANIFEST_KIND;
  featureSet: { id: string; version: string; digest: `sha256:${string}` };
  format: DecisionFeatureExportFormat;
  rowCount: number;
  columnOrder: string[];
  semanticContentDigest: `sha256:${string}`;
  payloadDigest: `sha256:${string}`;
  generatedAt: string;
  authorization: DecisionFeatureExportIdentity;
  lifecycle: { surface: 'export'; references: string[] };
  batchAccounting: DecisionFeatureManifestBatchAccounting[];
  split?: { train: string[]; validation: string[]; test: string[]; seed: number; algorithm: string };
  evalIntegrity?: DecisionFeatureEvalIntegrity;
}

export type DecisionFeatureIntegrityDisposition = QualificationIntegrityMetadata['release_gate']['decision'];

export interface DecisionFeatureEvalIntegrity {
  schemaVersion: 'decision-feature-eval-integrity/v1';
  /** The #2037/#2048 qualification release record, carried unchanged. */
  qualificationRelease: QualificationReleaseRecord;
  upstreamDisposition: DecisionFeatureIntegrityDisposition;
  disposition: DecisionFeatureIntegrityDisposition;
  reportRef: string;
  digest: `sha256:${string}`;
}

export interface GenerateDecisionFeatureSetInput {
  id: string;
  version: string;
  description: string;
  ruleset: DecisionRuleset;
  binding: DecisionBinding;
  definitions: Record<string, DecisionDefinition>;
  privacy: DecisionFeatureSet['spec']['privacy'];
  compatibleServedModels?: Record<string, string[]>;
  calibration?: DecisionFeatureSourcePins['calibration'];
}

export interface DecisionFeatureObservationInput {
  featureSet: DecisionFeatureSet;
  result: DecisionResult | RulesetResult;
  definitions: Record<string, DecisionDefinition>;
  subjectId: string;
  eventTime: string;
  exportTime: string;
  authorization: DecisionFeatureExportPolicy;
  lifecycle?: { reference?: string; tombstone?: boolean; legalHold?: boolean; expiresAtEpochMs?: number; revokedAtEpochMs?: number | null; deletedAtEpochMs?: number | null };
}

export interface DecisionFeatureManifestBatchAccounting {
  scope: 'ruleset-batch-request' | 'durable-batch-receipt';
  ownerId: string;
  reference: string;
  groupId: string | null;
  ordinal: number | null;
  requestId: string | null;
  questionIds: string[];
  authoritativeUsage: DecisionUsage;
  rowAllocations: Array<{ observationId: string; kind: 'estimated' | 'none'; algorithm: string | null; algorithmVersion: string | null; usage: DecisionUsage | null }>;
}

export interface DecisionFeatureBatchReceiptEvidence extends DecisionFeatureBatchOwnerReference {
  authoritativeUsage: DecisionUsage;
}

export interface DecisionFeatureExportSerializeOptions {
  generatedAt: string;
  evalIntegrity?: DecisionFeatureEvalIntegrity;
  batchAccountingEvidence?: DecisionFeatureBatchReceiptEvidence[];
}

export interface DecisionFeatureSourceLifecycleStore extends DecisionLifecycleStore {
  register?: (subject: string, reference: { surface: 'export'; opaqueId: string }) => Promise<void>;
  resolveReference?: (reference: DecisionLifecycleReference) => Promise<DecisionLifecycleReferenceState>;
}

export interface DecisionFeatureExportStore {
  create(observation: DecisionFeatureObservation): Promise<void>;
  read(identity: DecisionFeatureExportIdentity, observationId: string): Promise<DecisionFeatureObservation | null>;
  list(identity: DecisionFeatureExportIdentity): Promise<DecisionFeatureObservation[]>;
  updateLifecycle(identity: DecisionFeatureExportIdentity, observationId: string,
    patch: Partial<DecisionFeatureObservation['lifecycle']>): Promise<DecisionFeatureObservation | null>;
}

export interface DecisionFeatureTrainServeContract {
  featureSet: { id: string; version: string; digest: `sha256:${string}` };
  columns: Array<{ name: string; valueType: DecisionFeatureValueType; nullable: boolean; domain?: string[] }>;
  compatibleServedModels: Record<string, string[]>;
  calibration: DecisionFeatureSourcePins['calibration'];
}

export class DecisionFeatureExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionFeatureExportError';
  }
}

let featureValidators: Map<string, ValidateFunction> | null = null;
const BATCH_ACCOUNTING_EVIDENCE = Symbol('decisionFeatureBatchAccountingEvidence');

type ObservationWithBatchEvidence = DecisionFeatureObservation & { [BATCH_ACCOUNTING_EVIDENCE]?: DecisionFeatureBatchReceiptEvidence[] };

export class MemoryDecisionFeatureExportStore implements DecisionFeatureExportStore {
  private readonly records = new Map<string, DecisionFeatureObservation>();

  async create(observation: DecisionFeatureObservation): Promise<void> {
    if (this.records.has(observation.observationId)) throw new DecisionFeatureExportError('Feature observation already exists');
    this.records.set(observation.observationId, cloneObservation(observation));
  }

  async read(identity: DecisionFeatureExportIdentity, observationId: string): Promise<DecisionFeatureObservation | null> {
    const value = this.records.get(observationId);
    return value && sameIdentity(value.authorization, identity) ? cloneObservation(value) : null;
  }

  async list(identity: DecisionFeatureExportIdentity): Promise<DecisionFeatureObservation[]> {
    return [...this.records.values()].filter(value => sameIdentity(value.authorization, identity)).map(value => cloneObservation(value));
  }

  async updateLifecycle(identity: DecisionFeatureExportIdentity, observationId: string,
    patch: Partial<DecisionFeatureObservation['lifecycle']>): Promise<DecisionFeatureObservation | null> {
    const current = await this.read(identity, observationId);
    if (!current) return null;
    current.lifecycle = { ...current.lifecycle, ...patch };
    this.records.set(observationId, cloneObservation(current));
    return current;
  }
}

export class DecisionFeatureExportService {
  constructor(private readonly featureSet: DecisionFeatureSet, private readonly store: DecisionFeatureExportStore,
    private readonly lifecyclePolicy?: DecisionLifecyclePolicy, private readonly lifecycleStore?: DecisionFeatureSourceLifecycleStore) {
    validateFeatureSet(featureSet);
  }

  async create(input: DecisionFeatureObservationInput): Promise<DecisionFeatureObservation> {
    validateDecisionFeatureExportAuthorization(input.authorization, 'create', this.lifecyclePolicy);
    if (input.featureSet.metadata.digest !== this.featureSet.metadata.digest) {
      throw new DecisionFeatureExportError('Feature observation feature set does not match the service feature set');
    }
    const observation = createDecisionFeatureObservation(input);
    assertObservationMatchesFeatureSet(this.featureSet, observation);
    assertExportLifecycleActive(observation, Date.parse(input.exportTime));
    if (this.lifecycleStore) await registerDecisionFeatureExportLifecycle(observation, this.lifecycleStore);
    await this.store.create(observation);
    return observation;
  }

  async read(policy: DecisionFeatureExportPolicy, observationId: string, nowEpochMs: number): Promise<DecisionFeatureObservation | null> {
    validateDecisionFeatureExportAuthorization(policy, 'read', this.lifecyclePolicy);
    const observation = await this.store.read(authIdentity(policy), observationId);
    if (!observation) return null;
    assertObservationMatchesFeatureSet(this.featureSet, observation);
    await this.assertHostLifecycleActive(observation, nowEpochMs);
    return observation;
  }

  async list(policy: DecisionFeatureExportPolicy, nowEpochMs: number): Promise<DecisionFeatureObservation[]> {
    validateDecisionFeatureExportAuthorization(policy, 'list', this.lifecyclePolicy);
    const active: DecisionFeatureObservation[] = [];
    for (const observation of await this.store.list(authIdentity(policy))) {
      try { assertObservationMatchesFeatureSet(this.featureSet, observation); await this.assertHostLifecycleActive(observation, nowEpochMs); active.push(observation); }
      catch (error) { if (!(error instanceof DecisionFeatureExportError)) throw error; }
    }
    return active;
  }

  async delete(policy: DecisionFeatureExportPolicy, observationId: string, nowEpochMs: number): Promise<void> {
    validateDecisionFeatureExportAuthorization(policy, 'delete', this.lifecyclePolicy);
    const observation = await this.store.read(authIdentity(policy), observationId);
    if (!observation) throw new DecisionFeatureExportError('Feature observation not found');
    assertObservationMatchesFeatureSet(this.featureSet, observation);
    await this.assertDeletionAllowed(observation, nowEpochMs);
    const reference = { surface: 'export' as const, opaqueId: observation.lifecycle.reference };
    if (this.lifecycleStore) {
      await this.lifecycleStore.tombstone({ subject: observation.subjectId, reference, deletedAt: nowEpochMs });
      await this.lifecycleStore.erase(reference);
    }
    const deleted = await this.store.updateLifecycle(authIdentity(policy), observationId, { tombstone: true, deletedAtEpochMs: nowEpochMs });
    if (!deleted) throw new DecisionFeatureExportError('Feature observation deletion failed');
  }

  async revoke(policy: DecisionFeatureExportPolicy, observationId: string, nowEpochMs: number): Promise<void> {
    validateDecisionFeatureExportAuthorization(policy, 'delete', this.lifecyclePolicy);
    const observation = await this.store.read(authIdentity(policy), observationId);
    if (!observation) throw new DecisionFeatureExportError('Feature observation not found');
    assertObservationMatchesFeatureSet(this.featureSet, observation);
    const revoked = await this.store.updateLifecycle(authIdentity(policy), observationId, { revokedAtEpochMs: nowEpochMs });
    if (!revoked) throw new DecisionFeatureExportError('Feature observation not found');
  }

  async share(policy: DecisionFeatureExportPolicy, observationId: string, nowEpochMs: number): Promise<DecisionFeatureObservation> {
    validateDecisionFeatureExportAuthorization(policy, 'share', this.lifecyclePolicy);
    const observation = await this.store.read(authIdentity(policy), observationId);
    if (!observation) throw new DecisionFeatureExportError('Feature observation not found');
    assertObservationMatchesFeatureSet(this.featureSet, observation);
    await this.assertHostLifecycleActive(observation, nowEpochMs);
    validateObservationForExport(observation, policy, nowEpochMs);
    return observation;
  }

  async exportJsonl(policy: DecisionFeatureExportPolicy, generatedAt: string, nowEpochMs: number,
    evalIntegrity?: DecisionFeatureEvalIntegrity): Promise<{ payload: string; manifest: DecisionFeatureExportManifest }> {
    const rows = await this.list(policy, nowEpochMs);
    return serializeDecisionFeatureJsonl(this.featureSet, rows, policy, { generatedAt, evalIntegrity });
  }

  async exportCsv(policy: DecisionFeatureExportPolicy, generatedAt: string, nowEpochMs: number,
    evalIntegrity?: DecisionFeatureEvalIntegrity): Promise<{ payload: string; manifest: DecisionFeatureExportManifest }> {
    const rows = await this.list(policy, nowEpochMs);
    return serializeDecisionFeatureCsv(this.featureSet, rows, policy, { generatedAt, evalIntegrity });
  }

  private async assertHostLifecycleActive(observation: DecisionFeatureObservation, nowEpochMs: number): Promise<void> {
    assertExportLifecycleActive(observation, nowEpochMs);
    if (!this.lifecycleStore) return;
    const reference = { surface: 'export' as const, opaqueId: observation.lifecycle.reference };
    if (!this.lifecycleStore.resolveReference) {
      throw new DecisionFeatureExportError('Feature export lifecycle source status is unavailable');
    }
    if (this.lifecycleStore.resolveReference) {
      const state = await this.lifecycleStore.resolveReference(reference);
      if (state.state !== 'linked') throw new DecisionFeatureExportError('Feature export lifecycle reference is not active');
      return;
    }

  }

  private async assertDeletionAllowed(observation: DecisionFeatureObservation, nowEpochMs: number): Promise<void> {
    assertExportLifecycleActive(observation, nowEpochMs);
    if (observation.lifecycle.legalHold) throw new DecisionFeatureExportError('Feature observation deletion denied by legal hold');
    if (!this.lifecycleStore) return;
    const holds = await this.lifecycleStore.holds(observation.subjectId);
    if (holds.some(hold => activeExportHold(hold, observation.subjectId, nowEpochMs))) {
      throw new DecisionFeatureExportError('Feature observation deletion denied by legal hold');
    }
  }
}

export function validateDecisionFeatureExportAuthorization(policy: DecisionFeatureExportPolicy,
  operation: DecisionFeatureExportOperation, lifecycle?: DecisionLifecyclePolicy): void {
  if (!policy.tenantId || !policy.projectId || !policy.actorId || !policy.recipient
    || !policy.purpose || !policy.datasetPolicyId || !policy.accessScope) {
    throw new DecisionFeatureExportError('Feature export authorization is incomplete');
  }
  if (!policy.operations.includes(operation)) throw new DecisionFeatureExportError(`Feature export ${operation} is not authorized`);
  if ((operation === 'export' || operation === 'share') && !policy.allowExternalDelivery) {
    throw new DecisionFeatureExportError('External feature delivery requires an approved export policy');
  }
  if (policy.allowRawState || policy.allowOutcomeLabels) {
    throw new DecisionFeatureExportError('Feature export policy cannot authorize raw state or outcome labels');
  }
  if (lifecycle) {
    validateDecisionLifecyclePolicy(lifecycle);
    const rule = lifecycle.surfaces.export;
    if (rule.export !== 'sanitized' || !rule.accessScopes.includes(policy.accessScope)) {
      throw new DecisionFeatureExportError('Feature export lifecycle policy does not authorize sanitized export access');
    }
  }
}

export async function registerDecisionFeatureExportLifecycle(observation: DecisionFeatureObservation,
  store: DecisionFeatureSourceLifecycleStore): Promise<void> {
  assertExportLifecycleActive(observation, Date.parse(observation.exportTime));
  if (!store.register) throw new DecisionFeatureExportError('Feature export lifecycle registration unavailable');
  await store.register(observation.subjectId, { surface: 'export', opaqueId: observation.lifecycle.reference });
}

export function generateDecisionFeatureSet(input: GenerateDecisionFeatureSetInput): DecisionFeatureSet {
  validateDecisionDocument(input.ruleset);
  validateDecisionDocument(input.binding);
  assertArtifactPin(input.ruleset, input.binding.spec.ruleset, 'ruleset');
  const pins: DecisionFeatureSourcePins = {
    ruleset: artifactPin(input.ruleset),
    binding: artifactPin(input.binding),
    definitions: {},
    adapters: {},
    calibration: structuredClone(input.calibration ?? {}),
  };
  const columns: DecisionFeatureColumn[] = [];
  const aliases = input.ruleset.spec.evaluations.map(item => item.alias);
  for (const entry of input.ruleset.spec.evaluations) {
    const definition = input.definitions[entry.alias];
    if (!definition) throw new DecisionFeatureExportError(`Missing definition for ${entry.alias}`);
    validateDecisionDocument(definition);
    assertArtifactPin(definition, entry.decision, `definition ${entry.alias}`);
    pins.definitions[entry.alias] = artifactPin(definition);
    const bindingEntry = input.binding.spec.evaluations[entry.alias];
    const target = bindingEntry?.targets[0];
    if (!target) throw new DecisionFeatureExportError(`Missing binding target for ${entry.alias}`);
    pins.adapters[entry.alias] = {
      adapter: target.adapter,
      adapterVersion: target.adapterVersion,
      requestedModel: target.model,
      servedModel: null,
    };
    columns.push(...columnsForDefinition(entry.alias, definition));
  }
  columns.push(...rulesetColumns(aliases));
  columns.forEach((column, index) => { column.order = index; });
  const draft: DecisionFeatureSet = {
    schemaVersion: DECISION_FEATURE_EXPORT_VERSION,
    kind: DECISION_FEATURE_SET_KIND,
    metadata: { id: input.id, version: input.version, description: input.description, digest: `sha256:${'0'.repeat(64)}` },
    spec: {
      pins,
      compatibleServedModels: structuredClone(input.compatibleServedModels ?? {}),
      missingValuePolicy: { numeric: 'null', categorical: 'null', missingStateColumn: true, missingNeverZero: true },
      ordering: 'definition-pins-declared-order',
      privacy: structuredClone(input.privacy),
      columns,
    },
  };
  draft.metadata.digest = digestFeatureSet(draft);
  return draft;
}

export function decisionFeatureTrainServeContract(featureSet: DecisionFeatureSet): DecisionFeatureTrainServeContract {
  validateFeatureSet(featureSet);
  return {
    featureSet: { id: featureSet.metadata.id, version: featureSet.metadata.version, digest: featureSet.metadata.digest },
    columns: featureSet.spec.columns.map(column => ({ name: column.name, valueType: column.valueType,
      nullable: column.nullable, ...(column.domain ? { domain: [...column.domain] } : {}) })),
    compatibleServedModels: structuredClone(featureSet.spec.compatibleServedModels),
    calibration: structuredClone(featureSet.spec.pins.calibration),
  };
}

export function createDecisionFeatureObservation(input: DecisionFeatureObservationInput): DecisionFeatureObservation {
  validateDecisionFeatureExportAuthorization(input.authorization, 'create');
  validateFeatureSet(input.featureSet);
  const decisions = decisionsFromResult(input.result);
  for (const decision of decisions) validateDecisionDocument(decision);
  const rulesetPin = input.result.kind === 'RulesetResult' ? input.result.spec.ruleset : decisions[0]?.spec.ruleset;
  const bindingPin = input.result.kind === 'RulesetResult' ? input.result.spec.binding : decisions[0]?.spec.binding;
  if (!rulesetPin || !bindingPin) throw new DecisionFeatureExportError('Feature export source is empty');
  requireSamePin(rulesetPin, input.featureSet.spec.pins.ruleset, 'ruleset');
  requireSamePin(bindingPin, input.featureSet.spec.pins.binding, 'binding');
  const features: Record<string, DecisionFeatureCell> = {};
  for (const column of input.featureSet.spec.columns) features[column.name] = missingCell(column, 'missing-evidence', '$');
  for (const decision of decisions) {
    const definition = input.definitions[decision.spec.alias];
    const pin = input.featureSet.spec.pins.definitions[decision.spec.alias];
    if (!definition || !pin) throw new DecisionFeatureExportError(`Missing definition pin for ${decision.spec.alias}`);
    requireSamePin(artifactPin(definition), pin, `definition ${decision.spec.alias}`);
    requireSamePin(decision.spec.decision, pin, `decision ${decision.spec.alias}`);
    assertAttemptMatchesPins(input.featureSet, decision);
    for (const cell of cellsForDecision(input.featureSet, decision, definition)) features[cell.name] = cell.cell;
  }
  for (const column of input.featureSet.spec.columns) {
    if (!features[column.name]) features[column.name] = missingCell(column, 'missing-evidence', '$');
    validateCell(column, features[column.name]!);
  }
  const alias = decisions.length === 1 ? decisions[0]!.spec.alias : null;
  const observedModels = Object.fromEntries(decisions.map(decision => [decision.spec.alias, latestActualModel(decision)]));
  const calibrationRefs = Object.fromEntries(decisions.map(decision => [decision.spec.alias, decision.spec.uncertainty?.calibrationRef ?? null]));
  const lifecycleReference = input.lifecycle?.reference ?? opaqueExportReference(input.featureSet, input.subjectId, input.result.spec.invocationId, alias);
  const exportEpoch = Date.parse(input.exportTime);
  const expiresAtEpochMs = input.lifecycle?.expiresAtEpochMs ?? exportEpoch + input.featureSet.spec.privacy.retentionMs;
  const batch = batchAccountingFor(input.result, decisions);
  const observation: DecisionFeatureObservation = {
    schemaVersion: DECISION_FEATURE_EXPORT_VERSION,
    kind: DECISION_FEATURE_OBSERVATION_KIND,
    featureSet: { id: input.featureSet.metadata.id, version: input.featureSet.metadata.version, digest: input.featureSet.metadata.digest },
    observationId: opaqueExportReference(input.featureSet, input.subjectId, input.result.spec.invocationId, alias ?? 'ruleset'),
    subjectId: input.subjectId,
    eventTime: input.eventTime,
    exportTime: input.exportTime,
    sourceReceipt: { kind: input.result.kind, runId: input.result.spec.runId, invocationId: input.result.spec.invocationId, alias },
    authorization: authIdentity(input.authorization),
    lifecycle: { surface: 'export', reference: lifecycleReference, tombstone: input.lifecycle?.tombstone ?? false,
      legalHold: input.lifecycle?.legalHold ?? false, expiresAtEpochMs,
      revokedAtEpochMs: input.lifecycle?.revokedAtEpochMs ?? null, deletedAtEpochMs: input.lifecycle?.deletedAtEpochMs ?? null },
    lineage: { ruleset: structuredClone(rulesetPin), binding: structuredClone(bindingPin),
      decision: decisions.length === 1 ? structuredClone(decisions[0]!.spec.decision) : null,
      definition: decisions.length === 1 ? structuredClone(input.featureSet.spec.pins.definitions[decisions[0]!.spec.alias]!) : null },
    trainServe: { featureSetDigest: input.featureSet.metadata.digest, servedModels: observedModels, calibrationRefs },
    batchAccounting: batch.accounting,
    features,
  };
  attachBatchEvidence(observation, batch.evidence);
  assertNoFeatureLeakage(observation, input.authorization);
  assertExportLifecycleActive(observation, exportEpoch);
  validateDecisionFeatureObservation(input.featureSet, observation);
  return observation;
}

export function validateDecisionFeatureObservation(featureSet: DecisionFeatureSet,
  observation: DecisionFeatureObservation): void {
  validateFeatureSet(featureSet);
  if (observation.schemaVersion !== DECISION_FEATURE_EXPORT_VERSION || observation.kind !== DECISION_FEATURE_OBSERVATION_KIND) {
    throw new DecisionFeatureExportError('Unsupported feature observation');
  }
  if (observation.featureSet.id !== featureSet.metadata.id || observation.featureSet.version !== featureSet.metadata.version
    || observation.featureSet.digest !== featureSet.metadata.digest || observation.trainServe.featureSetDigest !== featureSet.metadata.digest) {
    throw new DecisionFeatureExportError('Feature observation was produced for a different feature set');
  }
  validateFeatureSchema(observation, 'DecisionFeatureObservation');
  const expected = featureSet.spec.columns.map(column => column.name);
  const actual = Object.keys(observation.features);
  if (actual.length !== expected.length || expected.some((name, index) => actual[index] !== name)) {
    throw new DecisionFeatureExportError('Feature observation column order does not match the feature set');
  }
  for (const column of featureSet.spec.columns) validateCell(column, observation.features[column.name]!);
}

export function validateDecisionFeatureTrainServe(featureSet: DecisionFeatureSet,
  contract: DecisionFeatureTrainServeContract, observation: DecisionFeatureObservation, nowEpochMs: number): void {
  validateDecisionFeatureObservation(featureSet, observation);
  if (contract.featureSet.id !== featureSet.metadata.id || contract.featureSet.version !== featureSet.metadata.version
    || contract.featureSet.digest !== featureSet.metadata.digest) {
    throw new DecisionFeatureExportError('Train/serve feature-set pin mismatch');
  }
  const columns = featureSet.spec.columns;
  if (contract.columns.length !== columns.length || contract.columns.some((column, index) => column.name !== columns[index]!.name
    || column.valueType !== columns[index]!.valueType || column.nullable !== columns[index]!.nullable
    || canonicalJson(column.domain ?? []) !== canonicalJson(columns[index]!.domain ?? []))) {
    throw new DecisionFeatureExportError('Train/serve feature-domain mismatch');
  }
  const aliases = Object.keys(featureSet.spec.pins.definitions).sort();
  if (!sameStringSet(Object.keys(contract.compatibleServedModels), Object.keys(featureSet.spec.compatibleServedModels))
    || canonicalJson(contract.compatibleServedModels) !== canonicalJson(featureSet.spec.compatibleServedModels)) {
    throw new DecisionFeatureExportError('Train/serve model compatibility contract mismatch');
  }
  if (!sameStringSet(Object.keys(contract.calibration), Object.keys(featureSet.spec.pins.calibration))
    || canonicalJson(contract.calibration) !== canonicalJson(featureSet.spec.pins.calibration)) {
    throw new DecisionFeatureExportError('Train/serve calibration contract mismatch');
  }
  if (!sameStringSet(Object.keys(observation.trainServe.servedModels), aliases)) {
    throw new DecisionFeatureExportError('Train/serve served-model alias mismatch');
  }
  if (!sameStringSet(Object.keys(observation.trainServe.calibrationRefs), aliases)) {
    throw new DecisionFeatureExportError('Train/serve calibration alias mismatch');
  }
  for (const [alias, servedModel] of Object.entries(observation.trainServe.servedModels)) {
    const allowed = contract.compatibleServedModels[alias];
    if (allowed?.length && (!servedModel || !allowed.includes(servedModel))) {
      throw new DecisionFeatureExportError(`Train/serve served-model incompatibility for ${alias}`);
    }
  }
  for (const [alias, rule] of Object.entries(contract.calibration)) {
    const observed = observation.trainServe.calibrationRefs[alias];
    if (observed !== rule.calibrationRef) throw new DecisionFeatureExportError(`Train/serve calibration mismatch for ${alias}`);
    if (rule.recordedAtEpochMs !== null && rule.maxAgeMs !== null && nowEpochMs - rule.recordedAtEpochMs > rule.maxAgeMs) {
      throw new DecisionFeatureExportError(`Train/serve stale calibration for ${alias}`);
    }
  }
}

export function serializeDecisionFeatureJsonl(featureSet: DecisionFeatureSet,
  observations: readonly DecisionFeatureObservation[], authorization: DecisionFeatureExportPolicy,
  options: DecisionFeatureExportSerializeOptions | string): { payload: string; manifest: DecisionFeatureExportManifest } {
  validateDecisionFeatureExportAuthorization(authorization, 'export');
  const resolved = typeof options === 'string' ? { generatedAt: options } : options;
  const rows = observations.map(observation => {
    validateDecisionFeatureObservation(featureSet, observation);
    validateObservationForExport(observation, authorization, Date.parse(resolved.generatedAt));
    return observation;
  });
  const payload = `${rows.map(row => canonicalJson(row)).join('\n')}${rows.length ? '\n' : ''}`;
  return { payload, manifest: manifestFor(featureSet, rows, authorization, 'jsonl', payload, resolved) };
}

export function serializeDecisionFeatureCsv(featureSet: DecisionFeatureSet,
  observations: readonly DecisionFeatureObservation[], authorization: DecisionFeatureExportPolicy,
  options: DecisionFeatureExportSerializeOptions | string): { payload: string; manifest: DecisionFeatureExportManifest } {
  validateDecisionFeatureExportAuthorization(authorization, 'export');
  const resolved = typeof options === 'string' ? { generatedAt: options } : options;
  const rows = observations.map(observation => {
    validateDecisionFeatureObservation(featureSet, observation);
    validateObservationForExport(observation, authorization, Date.parse(resolved.generatedAt));
    return observation;
  });
  const header = csvHeader(featureSet);
  const lines = [header, ...rows.map(row => csvRow(featureSet, row))];
  const payload = `${lines.join('\n')}\n`;
  return { payload, manifest: manifestFor(featureSet, rows, authorization, 'csv', payload, resolved) };
}

export function loadDecisionFeatureCsv(featureSet: DecisionFeatureSet, payload: string): DecisionFeatureObservation[] {
  const records = parseCsv(payload);
  if (!records.length) return [];
  const expected = csvHeader(featureSet);
  if (records[0]!.join(',') !== expected) throw new DecisionFeatureExportError('CSV feature columns are missing, extra, or reordered');
  return records.slice(1).filter(record => record.length > 1 || record[0] !== '').map(record => observationFromCsvRecord(featureSet, records[0]!, record));
}

export function semanticFeatureContentDigest(observations: readonly DecisionFeatureObservation[]): `sha256:${string}` {
  const normalized = observations.map(normalizedSemanticRow);
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`;
}

export function deterministicFeatureSplit(observations: readonly DecisionFeatureObservation[],
  seed: number): { train: string[]; validation: string[]; test: string[]; seed: number; algorithm: string } {
  if (!Number.isSafeInteger(seed)) throw new DecisionFeatureExportError('Feature split seed must be an integer');
  const ordered = observations.map(row => row.observationId).sort((a, b) => digestText(`${seed}:${a}`).localeCompare(digestText(`${seed}:${b}`)));
  const trainEnd = Math.max(1, Math.floor(ordered.length * 0.6));
  const validationEnd = Math.max(trainEnd, Math.floor(ordered.length * 0.8));
  return { train: ordered.slice(0, trainEnd), validation: ordered.slice(trainEnd, validationEnd),
    test: ordered.slice(validationEnd), seed, algorithm: 'sha256-stable-60-20-20/v1' };
}

function validateFeatureSet(featureSet: DecisionFeatureSet): void {
  if (featureSet.schemaVersion !== DECISION_FEATURE_EXPORT_VERSION || featureSet.kind !== DECISION_FEATURE_SET_KIND
    || featureSet.metadata.digest !== digestFeatureSet(featureSet)) {
    throw new DecisionFeatureExportError('Invalid decision feature set');
  }
  const names = featureSet.spec.columns.map(column => column.name);
  if (new Set(names).size !== names.length || featureSet.spec.columns.some((column, index) => column.order !== index)) {
    throw new DecisionFeatureExportError('Decision feature columns must be uniquely and deterministically ordered');
  }
  validateFeatureSchema(featureSet, 'DecisionFeatureSet');
}

function featureSchemaRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../schemas/decision'), resolve(here, '../../../schemas/decision')];
  const found = candidates.find(candidate => existsSync(resolve(candidate, 'DecisionFeatureSet.v1.schema.json')));
  if (!found) throw new DecisionFeatureExportError('Decision feature schema directory is unavailable');
  return found;
}

function getFeatureValidators(): Map<string, ValidateFunction> {
  if (featureValidators) return featureValidators;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  featureValidators = new Map();
  for (const [kind, filename] of [
    ['DecisionFeatureSet', 'DecisionFeatureSet.v1.schema.json'],
    ['DecisionFeatureObservation', 'DecisionFeatureObservation.v1.schema.json'],
  ] as const) {
    const schema = JSON.parse(readFileSync(resolve(featureSchemaRoot(), filename), 'utf8')) as Record<string, unknown>;
    featureValidators.set(kind, ajv.compile(schema));
  }
  return featureValidators;
}

function validateFeatureSchema(value: unknown, kind: 'DecisionFeatureSet' | 'DecisionFeatureObservation'): void {
  const validate = getFeatureValidators().get(kind)!;
  if (!validate(value)) {
    const message = validate.errors?.map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join('; ') ?? 'invalid';
    throw new DecisionFeatureExportError(`${kind} schema validation failed: ${message}`);
  }
}

function digestFeatureSet(featureSet: DecisionFeatureSet): `sha256:${string}` {
  const clone = structuredClone(featureSet);
  clone.metadata.digest = `sha256:${'0'.repeat(64)}`;
  return artifactDigest(clone);
}

function columnsForDefinition(alias: string, definition: DecisionDefinition): DecisionFeatureColumn[] {
  const answer = definition.spec.answer;
  const out: DecisionFeatureColumn[] = [];
  const primitive = answer.kind;
  if (answer.kind === 'choice') {
    for (const option of answer.options) {
      out.push(column(`raw.provider.${alias}.choice.${option.id}.probability`, alias, primitive, 'number', 'provider-native',
        `Native probability for choice option ${option.id}.`, { domain: answer.options.map(value => value.id) }));
      out.push(column(`compat.one_hot.${alias}.choice.${option.id}`, alias, primitive, 'number', 'adapter-one-hot',
        `One-hot compatibility output for selected option ${option.id}.`, { derivation: { algorithm: 'selected-choice-one-hot', version: '1' } }));
    }
    out.push(column(`derived.${alias}.selected_probability`, alias, primitive, 'number', 'derived', 'Selected option probability.',
      { derivation: { algorithm: 'selected-choice-probability', version: '1' } }));
    out.push(column(`derived.${alias}.top_two_margin`, alias, primitive, 'number', 'derived', 'Top-two probability margin.',
      { derivation: { algorithm: 'top-two-margin', version: '1' } }));
    out.push(column(`derived.${alias}.entropy`, alias, primitive, 'number', 'derived', 'Shannon entropy over choice probabilities.',
      { derivation: { algorithm: 'shannon-entropy-natural-log', version: '1' } }));
    out.push(column(`derived.${alias}.concentration`, alias, primitive, 'number', 'derived', 'Sum of squared choice probabilities.',
      { derivation: { algorithm: 'sum-squared-probabilities', version: '1' } }));
  } else if (answer.kind === 'ordinal-score') {
    for (const [index] of answer.levels.entries()) {
      out.push(column(`raw.provider.${alias}.score.level_${index}.probability`, alias, primitive, 'number', 'provider-native',
        `Native probability for score level ${index}.`, { domain: answer.levels.map((_, level) => String(level)) }));
    }
    out.push(column(`derived.${alias}.expected_score`, alias, primitive, 'number', 'derived', 'Expected score over declared levels.',
      { derivation: { algorithm: 'ordinal-expected-value', version: '1' } }));
    out.push(column(`derived.${alias}.variance`, alias, primitive, 'number', 'derived', 'Ordinal score variance.',
      { derivation: { algorithm: 'ordinal-variance', version: '1' } }));
  } else {
    out.push(column(`raw.provider.${alias}.noul.truth_probability`, alias, primitive, 'number', 'provider-native',
      'Native truth probability. No fabricated two-class distribution is emitted.'));
  }
  out.push(column(`model_self_report.${alias}.confidence`, alias, primitive, 'number', 'model-self-report',
    'LLM self-reported confidence, if present; distinct from Jev-native probability.'));
  out.push(column(`calibrated.${alias}.risk`, alias, primitive, 'number', 'calibrated',
    'Separately pinned calibrated risk.', { calibrationRef: null }));
  return out;
}

function rulesetColumns(aliases: string[]): DecisionFeatureColumn[] {
  return aliases.map(alias => column(`ruleset.${alias}.status_success`, alias, 'ruleset', 'boolean', 'derived',
    'Ruleset-level success marker for this evaluation.', { derivation: { algorithm: 'status-success-marker', version: '1' } }));
}

function column(name: string, alias: string, primitive: DecisionFeaturePrimitive, valueType: DecisionFeatureValueType,
  source: DecisionFeatureProvenanceKind, description: string,
  options: Partial<Pick<DecisionFeatureColumn, 'domain' | 'derivation' | 'calibrationRef'>> = {}): DecisionFeatureColumn {
  return { name, alias, primitive, valueType, nullable: true, order: -1, source, uncertaintyProfile: null,
    calibrationRef: options.calibrationRef ?? null, derivation: options.derivation ?? null, description,
    ...(options.domain ? { domain: options.domain } : {}) };
}

function decisionsFromResult(result: DecisionResult | RulesetResult): DecisionResult[] {
  return result.kind === 'DecisionResult' ? [result] : Object.values(result.spec.evaluations);
}

function cellsForDecision(featureSet: DecisionFeatureSet, decision: DecisionResult,
  definition: DecisionDefinition): Array<{ name: string; cell: DecisionFeatureCell }> {
  const answer = definition.spec.answer;
  const uncertainty = decision.spec.uncertainty;
  const distribution = uncertainty?.distribution ?? null;
  const values: Array<{ name: string; cell: DecisionFeatureCell }> = [];
  const col = (suffix: string) => featureSet.spec.columns.find(column => column.alias === decision.spec.alias && column.name.endsWith(suffix));
  if (answer.kind === 'choice') {
    for (const option of answer.options) {
      const raw = col(`choice.${option.id}.probability`);
      if (raw) values.push({ name: raw.name, cell: uncertainty?.source === 'provider'
        ? numericCell(raw, distribution?.[option.id] ?? null, uncertainty, '$.spec.uncertainty.distribution')
        : missingCell(raw, 'missing-evidence', '$.spec.uncertainty.distribution') });
      const oneHot = col(`choice.${option.id}`);
      if (oneHot?.name.startsWith('compat.one_hot.')) {
        values.push({ name: oneHot.name, cell: decision.spec.status === 'success' && typeof decision.spec.value === 'string'
          && answer.options.some(item => item.id === decision.spec.value)
          ? numericCell(oneHot, decision.spec.value === option.id ? 1 : 0, null, '$.spec.value')
          : missingCell(oneHot, 'missing-evidence', '$.spec.value') });
      }
    }
    if (uncertainty?.source === 'provider' && distribution && answer.options.every(option => Number.isFinite(distribution[option.id]))) {
      const probabilities = answer.options.map(option => distribution[option.id]!);
      const selected = typeof decision.spec.value === 'string' ? distribution[decision.spec.value] ?? null : null;
      const sorted = [...probabilities].sort((a, b) => b - a);
      pushMetric(values, col('selected_probability'), selected, '$.spec.uncertainty.distribution');
      pushMetric(values, col('top_two_margin'), sorted[0] !== undefined && sorted[1] !== undefined ? sorted[0] - sorted[1] : null, '$.spec.uncertainty.distribution');
      pushMetric(values, col('entropy'), -probabilities.reduce((sum, value) => value > 0 ? sum + value * Math.log(value) : sum, 0), '$.spec.uncertainty.distribution');
      pushMetric(values, col('concentration'), probabilities.reduce((sum, value) => sum + value * value, 0), '$.spec.uncertainty.distribution');
    }
  } else if (answer.kind === 'ordinal-score') {
    for (const [index] of answer.levels.entries()) {
      const raw = col(`level_${index}.probability`);
      if (raw) values.push({ name: raw.name, cell: uncertainty?.source === 'provider'
        ? numericCell(raw, distribution?.[String(index)] ?? null, uncertainty, '$.spec.uncertainty.distribution')
        : missingCell(raw, 'missing-evidence', '$.spec.uncertainty.distribution') });
    }
    if (uncertainty?.source === 'provider' && distribution && answer.levels.every((_, index) => Number.isFinite(distribution[String(index)]))) {
      const pairs = answer.levels.map((_, index) => [index, distribution[String(index)]!] as const);
      const mean = pairs.reduce((sum, [index, probability]) => sum + index * probability, 0);
      const variance = pairs.reduce((sum, [index, probability]) => sum + probability * (index - mean) ** 2, 0);
      pushMetric(values, col('expected_score'), mean, '$.spec.uncertainty.distribution');
      pushMetric(values, col('variance'), variance, '$.spec.uncertainty.distribution');
    }
  } else {
    const raw = col('truth_probability');
    const value = typeof decision.spec.value === 'number' ? decision.spec.value : null;
    if (raw) values.push({ name: raw.name, cell: uncertainty?.source === 'provider'
      ? numericCell(raw, value, uncertainty, '$.spec.value') : missingCell(raw, 'missing-evidence', '$.spec.value') });
  }
  pushMetric(values, col('confidence'), uncertainty?.source === 'model-self-report' ? uncertainty.confidence : null, '$.spec.uncertainty.confidence');
  const calibrated = col('risk');
  if (calibrated) values.push({ name: calibrated.name, cell: numericCell(calibrated,
    uncertainty?.calibratedRisk?.value ?? null, uncertainty, '$.spec.uncertainty.calibratedRisk') });
  const status = col('status_success');
  if (status) values.push({ name: status.name, cell: { value: decision.spec.status === 'success', state: 'present',
    source: 'derived', missingReason: null, calibrationRef: null, derivation: status.derivation, evidencePath: '$.spec.status' } });
  return values;
}

function assertAttemptMatchesPins(featureSet: DecisionFeatureSet, decision: DecisionResult): void {
  const expected = featureSet.spec.pins.adapters[decision.spec.alias];
  if (!expected) throw new DecisionFeatureExportError(`Feature export adapter pin missing for ${decision.spec.alias}`);
  const attempt = decision.spec.attempts.find(value => value.adapter === expected.adapter
    && value.adapterVersion === expected.adapterVersion && value.requestedModel === expected.requestedModel);
  if (!attempt) throw new DecisionFeatureExportError(`Feature export adapter pin mismatch for ${decision.spec.alias}`);
}

function pushMetric(values: Array<{ name: string; cell: DecisionFeatureCell }>,
  column: DecisionFeatureColumn | undefined, value: number | null, evidencePath: string): void {
  if (column) values.push({ name: column.name, cell: numericCell(column, value, null, evidencePath) });
}

function numericCell(column: DecisionFeatureColumn, value: number | null,
  uncertainty: DecisionResult['spec']['uncertainty'], evidencePath: string): DecisionFeatureCell {
  if (typeof value !== 'number' || !Number.isFinite(value)) return missingCell(column, 'missing-evidence', evidencePath);
  return { value, state: 'present', source: column.source, missingReason: null,
    calibrationRef: column.source === 'calibrated' ? uncertainty?.calibratedRisk?.calibrationRef ?? column.calibrationRef : column.calibrationRef,
    derivation: column.derivation, evidencePath };
}

function missingCell(column: DecisionFeatureColumn, reason: DecisionFeatureMissingReason, evidencePath: string): DecisionFeatureCell {
  return { value: null, state: 'missing', source: 'missing', missingReason: reason, calibrationRef: column.calibrationRef,
    derivation: column.derivation, evidencePath };
}

function validateCell(column: DecisionFeatureColumn, cell: DecisionFeatureCell): void {
  if (cell.state === 'missing') {
    if (cell.value !== null || cell.missingReason === null) throw new DecisionFeatureExportError(`Invalid missing feature ${column.name}`);
    return;
  }
  if (cell.value === null || typeof cell.value !== column.valueType) throw new DecisionFeatureExportError(`Wrong type for feature ${column.name}`);
  if (typeof cell.value === 'number' && !Number.isFinite(cell.value)) throw new DecisionFeatureExportError(`Invalid numeric feature ${column.name}`);
  if (column.domain && typeof cell.value === 'string' && !column.domain.includes(cell.value)) {
    throw new DecisionFeatureExportError(`Out-of-domain feature ${column.name}`);
  }
}

function batchAccountingFor(result: DecisionResult | RulesetResult, decisions: readonly DecisionResult[]): { accounting: DecisionFeatureBatchAccounting; evidence: DecisionFeatureBatchReceiptEvidence[] } {
  if (result.kind === 'RulesetResult' && result.spec.batchRequests?.length) {
    const requests = result.spec.batchRequests;
    const owners = requests.map(request => batchRequestOwner(result.spec.runId, result.spec.invocationId, request));
    const usage = requests.reduce((sum, request) => ({
      inputTokens: addNullable(sum.inputTokens, request.usage.inputTokens),
      outputTokens: addNullable(sum.outputTokens, request.usage.outputTokens),
      costUsd: addNullable(sum.costUsd, request.usage.costUsd),
    }), { inputTokens: 0 as number | null, outputTokens: 0 as number | null, costUsd: 0 as number | null });
    const questionIds = [...new Set(requests.flatMap(request => request.questionIds))].sort();
    const allocations = allocateEstimatedUsage(questionIds, usage);
    const allocationUsage = requests.length === 1 ? { inputTokens: allocations.reduce((sum, value) => sum === null || value.inputTokens === null ? null : sum + value.inputTokens, 0 as number | null),
      outputTokens: allocations.reduce((sum, value) => sum === null || value.outputTokens === null ? null : sum + value.outputTokens, 0 as number | null),
      costUsd: null } : null;
    return { accounting: { scope: 'ruleset-batch-request', reference: batchReference(owners), authoritativeUsage: null, owners,
      allocation: { kind: 'estimated', algorithm: 'largest-remainder-weighted', algorithmVersion: '1', usage: allocationUsage } }, evidence: owners.map(owner => {
        const request = requests.find(item => item.groupId === owner.groupId && item.ordinal === owner.ordinal && item.requestId === owner.requestId)!;
        return { ...owner, authoritativeUsage: structuredClone(request.usage) };
      }) };
  }
  const durableDecision = decisions.find(decision => decision.spec.batchResult);
  const durable = durableDecision?.spec.batchResult;
  if (durable && durableDecision) {
    const owner = { ownerId: `durable-batch-receipt:${durableDecision.spec.runId}:${durableDecision.spec.invocationId}:${durable.batchId}:${durable.questionId}`,
      runId: durableDecision.spec.runId, invocationId: durableDecision.spec.invocationId, groupId: durable.batchId, ordinal: null,
      requestId: null, questionIds: [durable.questionId], usageDigest: null };
    return { accounting: { scope: 'durable-batch-receipt', reference: owner.ownerId, authoritativeUsage: null, owners: [owner],
      allocation: { kind: 'none', algorithm: null, algorithmVersion: null, usage: null } }, evidence: [] };
  }
  return { accounting: { scope: 'none', reference: null, authoritativeUsage: null, owners: [],
    allocation: { kind: 'none', algorithm: null, algorithmVersion: null, usage: null } }, evidence: [] };
}


function batchRequestOwner(runId: string, invocationId: string, request: DecisionBatchRequestUsage): DecisionFeatureBatchOwnerReference {
  const questionIds = [...request.questionIds].sort();
  const usageDigest = digestUsage(request.usage);
  const ownerPayload = { runId, invocationId, groupId: request.groupId, ordinal: request.ordinal, requestId: request.requestId, questionIds };
  return { ownerId: `ruleset-batch-request:${createHash('sha256').update(canonicalJson(ownerPayload)).digest('hex')}`,
    runId, invocationId, groupId: request.groupId, ordinal: request.ordinal, requestId: request.requestId, questionIds, usageDigest };
}

function batchReference(owners: readonly DecisionFeatureBatchOwnerReference[]): string {
  return `sha256:${createHash('sha256').update(canonicalJson(owners.map(owner => owner.ownerId).sort())).digest('hex')}`;
}

function digestUsage(usage: DecisionUsage): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(usage)).digest('hex')}`;
}

function attachBatchEvidence(observation: DecisionFeatureObservation, evidence: DecisionFeatureBatchReceiptEvidence[]): void {
  Object.defineProperty(observation, BATCH_ACCOUNTING_EVIDENCE, { value: evidence.map(item => structuredClone(item)), enumerable: false });
}

function batchEvidence(observation: DecisionFeatureObservation): DecisionFeatureBatchReceiptEvidence[] {
  return ((observation as ObservationWithBatchEvidence)[BATCH_ACCOUNTING_EVIDENCE] ?? []).map(item => structuredClone(item));
}

function cloneObservation(observation: DecisionFeatureObservation): DecisionFeatureObservation {
  const clone = structuredClone(observation);
  attachBatchEvidence(clone, batchEvidence(observation));
  return clone;
}

function assertObservationMatchesFeatureSet(featureSet: DecisionFeatureSet, observation: DecisionFeatureObservation): void {
  if (observation.featureSet.id !== featureSet.metadata.id || observation.featureSet.version !== featureSet.metadata.version
    || observation.featureSet.digest !== featureSet.metadata.digest) {
    throw new DecisionFeatureExportError('Feature observation feature set does not match the service feature set');
  }
}

function manifestBatchAccounting(observations: readonly DecisionFeatureObservation[], explicitEvidence: readonly DecisionFeatureBatchReceiptEvidence[] = []): DecisionFeatureManifestBatchAccounting[] {
  const grouped = new Map<string, DecisionFeatureManifestBatchAccounting>();
  for (const row of observations) {
    const accounting = row.batchAccounting;
    if (accounting.scope === 'none') continue;
    const evidenceByOwner = new Map([...batchEvidence(row), ...explicitEvidence].map(item => [item.ownerId, item]));
    for (const owner of accounting.owners) {
      const evidence = evidenceByOwner.get(owner.ownerId);
      if (!evidence) {
        if (accounting.scope === 'durable-batch-receipt') continue;
        throw new DecisionFeatureExportError(`Feature export authoritative batch accounting is missing for ${owner.ownerId}`);
      }
      if (owner.usageDigest !== digestUsage(evidence.authoritativeUsage)) {
        throw new DecisionFeatureExportError(`Feature export authoritative batch accounting digest mismatch for ${owner.ownerId}`);
      }
      const allocation = { observationId: row.observationId, kind: accounting.allocation.kind,
        algorithm: accounting.allocation.algorithm, algorithmVersion: accounting.allocation.algorithmVersion,
        usage: accounting.owners.length === 1 && accounting.allocation.usage ? structuredClone(accounting.allocation.usage) : null };
      const existing = grouped.get(owner.ownerId);
      if (existing) {
        if (canonicalJson(existing.authoritativeUsage) !== canonicalJson(evidence.authoritativeUsage)) {
          throw new DecisionFeatureExportError(`Feature export conflicting authoritative batch accounting for ${owner.ownerId}`);
        }
        existing.rowAllocations.push(allocation);
        continue;
      }
      grouped.set(owner.ownerId, { scope: accounting.scope, ownerId: owner.ownerId, reference: accounting.reference ?? owner.ownerId,
        groupId: owner.groupId, ordinal: owner.ordinal, requestId: owner.requestId, questionIds: [...owner.questionIds],
        authoritativeUsage: structuredClone(evidence.authoritativeUsage), rowAllocations: [allocation] });
    }
  }
  return [...grouped.values()].sort((a, b) => a.ownerId.localeCompare(b.ownerId));
}

function manifestFor(featureSet: DecisionFeatureSet, observations: readonly DecisionFeatureObservation[],
  authorization: DecisionFeatureExportPolicy, format: DecisionFeatureExportFormat,
  payload: string, options: DecisionFeatureExportSerializeOptions): DecisionFeatureExportManifest {
  const evalIntegrity = normalizeEvalIntegrity(options.evalIntegrity);
  return {
    schemaVersion: DECISION_FEATURE_EXPORT_VERSION,
    kind: DECISION_FEATURE_EXPORT_MANIFEST_KIND,
    featureSet: { id: featureSet.metadata.id, version: featureSet.metadata.version, digest: featureSet.metadata.digest },
    format,
    rowCount: observations.length,
    columnOrder: featureSet.spec.columns.map(column => column.name),
    semanticContentDigest: semanticFeatureContentDigest(observations),
    payloadDigest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    generatedAt: options.generatedAt,
    authorization: authIdentity(authorization),
    lifecycle: { surface: 'export', references: observations.map(row => row.lifecycle.reference) },
    batchAccounting: manifestBatchAccounting(observations, options.batchAccountingEvidence ?? []),
    ...(evalIntegrity ? { evalIntegrity } : {}),
  };
}

function csvHeader(featureSet: DecisionFeatureSet): string {
  const fixed = ['observationId', 'subjectId', 'eventTime', 'exportTime', 'featureSetId', 'featureSetVersion', 'featureSetDigest', 'aiwgSemantic'];
  const featureColumns = featureSet.spec.columns.flatMap(column => [
    `${column.name}__value`, `${column.name}__state`, `${column.name}__source`,
    `${column.name}__missing`, `${column.name}__calibration`, `${column.name}__derivation`,
  ]);
  return [...fixed, ...featureColumns].map(csvEscape).join(',');
}

function csvRow(featureSet: DecisionFeatureSet, observation: DecisionFeatureObservation): string {
  const fixed = [observation.observationId, observation.subjectId, observation.eventTime, observation.exportTime,
    observation.featureSet.id, observation.featureSet.version, observation.featureSet.digest,
    canonicalJson(normalizedSemanticRow(observation))];
  const values = featureSet.spec.columns.flatMap(column => {
    const cell = observation.features[column.name]!;
    return [cell.value === null ? '' : String(cell.value), cell.state, cell.source, cell.missingReason ?? '',
      cell.calibrationRef ?? '', cell.derivation ? `${cell.derivation.algorithm}@${cell.derivation.version}` : ''];
  });
  return [...fixed, ...values].map(csvEscape).join(',');
}

function parseCsv(payload: string): string[][] {
  const rows: string[][] = [];
  let field = ''; let row: string[] = []; let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  const finishField = (): void => { row.push(field); field = ''; state = 'start'; };
  const finishRow = (): void => { finishField(); rows.push(row); row = []; };
  for (let index = 0; index < payload.length; index++) {
    const char = payload[index]!;
    if (state === 'quoted') {
      if (char === '"' && payload[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') state = 'closed';
      else field += char;
      continue;
    }
    if (state === 'closed') {
      if (char === ',') { finishField(); continue; }
      if (char === '\n') { finishRow(); continue; }
      if (char === '\r' && payload[index + 1] === '\n') { finishRow(); index++; continue; }
      throw new DecisionFeatureExportError('CSV quoted field has trailing characters');
    }
    if (char === '"') {
      if (state !== 'start') throw new DecisionFeatureExportError('CSV quote inside unquoted field');
      state = 'quoted';
    } else if (char === ',') finishField();
    else if (char === '\n') finishRow();
    else if (char === '\r') {
      if (payload[index + 1] !== '\n') throw new DecisionFeatureExportError('CSV bare carriage return is invalid');
      finishRow(); index++;
    } else { field += char; state = 'unquoted'; }
  }
  if (state === 'quoted') throw new DecisionFeatureExportError('CSV quoted field is unterminated');
  if (state === 'closed' || field || row.length) finishField();
  if (row.length) rows.push(row);
  return rows;
}

function observationFromCsvRecord(featureSet: DecisionFeatureSet, header: string[], record: string[]): DecisionFeatureObservation {
  if (record.length !== header.length) throw new DecisionFeatureExportError('CSV feature row has the wrong width');
  const at = (name: string) => record[header.indexOf(name)] ?? '';
  const features: Record<string, DecisionFeatureCell> = {};
  for (const column of featureSet.spec.columns) {
    const value = at(`${column.name}__value`);
    const state = at(`${column.name}__state`) as DecisionFeatureObservationState;
    const derivation = at(`${column.name}__derivation`);
    features[column.name] = {
      value: parseCsvFeatureValue(column, value),
      state,
      source: at(`${column.name}__source`) as DecisionFeatureProvenanceKind,
      missingReason: (at(`${column.name}__missing`) || null) as DecisionFeatureMissingReason | null,
      calibrationRef: at(`${column.name}__calibration`) || null,
      derivation: derivation ? { algorithm: derivation.split('@')[0]!, version: derivation.split('@')[1] ?? '' } : null,
      evidencePath: '$.csv',
    };
  }

function parseCsvFeatureValue(column: DecisionFeatureColumn, value: string): number | string | boolean | null {
  if (value === '') return null;
  if (column.valueType === 'number') {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) {
      throw new DecisionFeatureExportError(`CSV numeric feature ${column.name} is not canonical`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new DecisionFeatureExportError(`CSV numeric feature ${column.name} is not finite`);
    return parsed;
  }
  if (column.valueType === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new DecisionFeatureExportError(`CSV boolean feature ${column.name} is not canonical`);
    return value === 'true';
  }
  return value;
}

  const semantic = JSON.parse(at('aiwgSemantic')) as Pick<DecisionFeatureObservation,
    'featureSet' | 'observationId' | 'subjectId' | 'eventTime' | 'exportTime' | 'sourceReceipt' | 'authorization' | 'lifecycle' | 'lineage' | 'trainServe' | 'batchAccounting' | 'features'>;
  assertCsvFixedColumn(at, 'observationId', semantic.observationId);
  assertCsvFixedColumn(at, 'subjectId', semantic.subjectId);
  assertCsvFixedColumn(at, 'eventTime', semantic.eventTime);
  assertCsvFixedColumn(at, 'exportTime', semantic.exportTime);
  assertCsvFixedColumn(at, 'featureSetId', semantic.featureSet.id);
  assertCsvFixedColumn(at, 'featureSetVersion', semantic.featureSet.version);
  assertCsvFixedColumn(at, 'featureSetDigest', semantic.featureSet.digest);
  if (canonicalJson(visibleFeatureCells(semantic.features)) !== canonicalJson(visibleFeatureCells(features))) {
    throw new DecisionFeatureExportError('CSV semantic row does not match visible feature columns');
  }
  const observation: DecisionFeatureObservation = {
    schemaVersion: DECISION_FEATURE_EXPORT_VERSION,
    kind: DECISION_FEATURE_OBSERVATION_KIND,
    featureSet: semantic.featureSet,
    observationId: semantic.observationId,
    subjectId: semantic.subjectId,
    eventTime: semantic.eventTime,
    exportTime: semantic.exportTime,
    sourceReceipt: semantic.sourceReceipt,
    authorization: semantic.authorization,
    lifecycle: semantic.lifecycle,
    lineage: semantic.lineage,
    trainServe: semantic.trainServe,
    batchAccounting: semantic.batchAccounting,
    features: Object.fromEntries(featureSet.spec.columns.map(column => [column.name, semantic.features[column.name]!])),
  };
  validateDecisionFeatureObservation(featureSet, observation);
  return observation;
}

function assertCsvFixedColumn(at: (name: string) => string, name: string, expected: string): void {
  if (at(name) !== expected) throw new DecisionFeatureExportError(`CSV fixed column ${name} does not match semantic row`);
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function authIdentity(policy: DecisionFeatureExportPolicy): DecisionFeatureExportIdentity {
  return { tenantId: policy.tenantId, projectId: policy.projectId, actorId: policy.actorId,
    recipient: policy.recipient, purpose: policy.purpose, datasetPolicyId: policy.datasetPolicyId,
    accessScope: policy.accessScope };
}

function requireSamePin(actual: ArtifactPin, expected: ArtifactPin, label: string): void {
  if (actual.id !== expected.id || actual.version !== expected.version || actual.digest !== expected.digest) {
    throw new DecisionFeatureExportError(`Feature export ${label} pin mismatch`);
  }
}

function validateObservationForExport(observation: DecisionFeatureObservation,
  policy: DecisionFeatureExportPolicy, nowEpochMs: number): void {
  if (!sameIdentity(observation.authorization, authIdentity(policy))) {
    throw new DecisionFeatureExportError('Feature export authorization does not match the observation');
  }
  assertExportLifecycleActive(observation, nowEpochMs);
  assertSafeExportMetadata(observation);
  assertNoFeatureLeakage(observation, policy);
}

function lifecycleActive(observation: DecisionFeatureObservation, nowEpochMs: number): boolean {
  return !observation.lifecycle.tombstone && observation.lifecycle.deletedAtEpochMs === null
    && observation.lifecycle.revokedAtEpochMs === null && nowEpochMs < observation.lifecycle.expiresAtEpochMs;
}

function assertExportLifecycleActive(observation: DecisionFeatureObservation, nowEpochMs: number): void {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) throw new DecisionFeatureExportError('Feature export time is invalid');
  if (!lifecycleActive(observation, nowEpochMs)) throw new DecisionFeatureExportError('Feature export lifecycle is not active');
}

function sameIdentity(left: DecisionFeatureExportIdentity, right: DecisionFeatureExportIdentity): boolean {
  return left.tenantId === right.tenantId && left.projectId === right.projectId && left.actorId === right.actorId
    && left.recipient === right.recipient && left.purpose === right.purpose
    && left.datasetPolicyId === right.datasetPolicyId && left.accessScope === right.accessScope;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

function addNullable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

export function buildDecisionFeatureEvalIntegrity(input: {
  qualificationRelease: QualificationReleaseRecord;
  reportRef: string;
  disposition?: DecisionFeatureIntegrityDisposition;
}): DecisionFeatureEvalIntegrity {
  const upstreamDisposition = input.qualificationRelease.decision;
  const disposition = input.disposition ?? upstreamDisposition;
  const payload: Omit<DecisionFeatureEvalIntegrity, 'digest'> = {
    schemaVersion: 'decision-feature-eval-integrity/v1',
    qualificationRelease: structuredClone(input.qualificationRelease),
    upstreamDisposition,
    disposition,
    reportRef: input.reportRef,
  };
  const value: DecisionFeatureEvalIntegrity = { ...payload, digest: digestEvalIntegrity(payload) };
  return normalizeEvalIntegrity(value)!;
}

function normalizeEvalIntegrity(value: DecisionFeatureEvalIntegrity | undefined): DecisionFeatureEvalIntegrity | undefined {
  if (!value) return undefined;
  if (value.schemaVersion !== 'decision-feature-eval-integrity/v1' || !value.reportRef) {
    throw new DecisionFeatureExportError('Feature export integrity report is invalid');
  }
  validateQualificationRelease(value.qualificationRelease);
  if (value.upstreamDisposition !== value.qualificationRelease.decision) {
    throw new DecisionFeatureExportError('Feature export integrity must preserve the upstream qualification release decision');
  }
  if (integrityRank(value.disposition) < integrityRank(value.upstreamDisposition)) {
    throw new DecisionFeatureExportError(`Feature export integrity cannot upgrade ${value.upstreamDisposition} to ${value.disposition}`);
  }
  const { digest, ...payload } = value;
  if (digest !== digestEvalIntegrity(payload)) throw new DecisionFeatureExportError('Feature export integrity digest does not match its content');
  return structuredClone(value);
}

function validateQualificationRelease(record: QualificationReleaseRecord): void {
  if (!record || record.schemaVersion !== 'decision-qualification-release/v1' || !record.runId || !record.sourceCommit
    || !['PROMOTE', 'HOLD', 'ROLLBACK'].includes(record.decision) || !/^sha256:[0-9a-f]{64}$/.test(record.digest)) {
    throw new DecisionFeatureExportError('Feature export qualification release is invalid');
  }
  // Versioned legacy allowlist: pre-migration release records hashed JSON.stringify
  // output. The v1 schema version is the pre-migration lineage, so it alone
  // allowlists legacy; verification defaults to canonical-only everywhere else.
  if (verifyQualificationReleaseDigest(record, { digestModes: ['canonical', 'legacy'] }) === null) {
    throw new DecisionFeatureExportError('Feature export qualification release digest does not match its content');
  }
  validateQualificationIntegrity(record.integrity);
  if (integrityRank(record.decision) < integrityRank(record.integrity.release_gate.decision)) {
    throw new DecisionFeatureExportError('Feature export qualification release cannot upgrade its integrity release gate');
  }
}

function validateQualificationIntegrity(value: QualificationIntegrityMetadata): void {
  if (!value || !Number.isSafeInteger(value.sample_n) || value.sample_n < 0
    || typeof value.integrity_mode !== 'string' || !value.integrity_mode
    || typeof value.fresh_workspace_required !== 'boolean' || typeof value.fresh_workspace_verified !== 'boolean'
    || typeof value.integrity_state !== 'string' || !value.integrity_state
    || typeof value.trusted_score_source !== 'string' || !value.trusted_score_source
    || !Array.isArray(value.compromise_labels) || value.compromise_labels.some(label => typeof label !== 'string')
    || !(value.weak_signal_reason === null || typeof value.weak_signal_reason === 'string')
    || !value.release_gate || !['PROMOTE', 'HOLD', 'ROLLBACK'].includes(value.release_gate.decision)
    || !Array.isArray(value.release_gate.reasons) || value.release_gate.reasons.some(reason => typeof reason !== 'string')) {
    throw new DecisionFeatureExportError('Feature export integrity report is invalid');
  }
}

function digestEvalIntegrity(value: Omit<DecisionFeatureEvalIntegrity, 'digest'>): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function integrityRank(decision: DecisionFeatureIntegrityDisposition): number {
  return ({ PROMOTE: 0, HOLD: 1, ROLLBACK: 2 } as const)[decision];
}

function activeExportHold(hold: DecisionLifecycleHold, subject: string, nowEpochMs: number): boolean {
  return hold.subject === subject && hold.expiresAt > nowEpochMs && hold.scope.includes('export');
}

function latestActualModel(decision: DecisionResult): string | null {
  for (let index = decision.spec.attempts.length - 1; index >= 0; index--) {
    const model = decision.spec.attempts[index]!.actualModel;
    if (model) return model;
  }
  return null;
}

function opaqueExportReference(featureSet: DecisionFeatureSet, subjectId: string,
  invocationId: string, alias: string | null): string {
  return digestText(`${featureSet.metadata.digest}:${subjectId}:${invocationId}:${alias ?? 'ruleset'}`).slice(0, 40);
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const SAFE_EXPORT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SENSITIVE_EXPORT_IDENTIFIER = /(?:bearer\s+\S+|(?:https?|file|s3):\/\/|\/home\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|private)/iu;

function assertSafeExportMetadata(observation: DecisionFeatureObservation): void {
  const values: Array<[string, string | null]> = [
    ['featureSet.id', observation.featureSet.id], ['featureSet.version', observation.featureSet.version],
    ['observationId', observation.observationId], ['subjectId', observation.subjectId],
    ['sourceReceipt.runId', observation.sourceReceipt.runId], ['sourceReceipt.invocationId', observation.sourceReceipt.invocationId],
    ['sourceReceipt.alias', observation.sourceReceipt.alias], ['lifecycle.reference', observation.lifecycle.reference],
    ['authorization.tenantId', observation.authorization.tenantId], ['authorization.projectId', observation.authorization.projectId],
    ['authorization.actorId', observation.authorization.actorId], ['authorization.recipient', observation.authorization.recipient],
    ['authorization.purpose', observation.authorization.purpose], ['authorization.datasetPolicyId', observation.authorization.datasetPolicyId],
    ['authorization.accessScope', observation.authorization.accessScope],
    ['lineage.ruleset.id', observation.lineage.ruleset.id], ['lineage.binding.id', observation.lineage.binding.id],
    ['lineage.decision.id', observation.lineage.decision?.id ?? null], ['lineage.definition.id', observation.lineage.definition?.id ?? null],
  ];
  for (const owner of observation.batchAccounting.owners) {
    values.push(['batchAccounting.ownerId', owner.ownerId], ['batchAccounting.runId', owner.runId], ['batchAccounting.invocationId', owner.invocationId],
      ['batchAccounting.groupId', owner.groupId], ['batchAccounting.requestId', owner.requestId]);
    owner.questionIds.forEach(questionId => values.push(['batchAccounting.questionId', questionId]));
  }
  for (const [label, value] of values) assertSafeExportIdentifier(value, label);
}

function assertSafeExportIdentifier(value: string | null, label: string): void {
  if (value === null) return;
  if (!SAFE_EXPORT_IDENTIFIER.test(value) || SENSITIVE_EXPORT_IDENTIFIER.test(value)) {
    throw new DecisionFeatureExportError(`Feature export metadata identifier is outside the safe opaque subset: ${label}`);
  }
}

function assertNoFeatureLeakage(observation: DecisionFeatureObservation, authorization: DecisionFeatureExportPolicy): void {
  const serialized = canonicalJson(observation);
  for (const forbidden of ['rawState', 'prompt', 'credential', 'responseBody', 'privateLocator', 'SECRET_DO_NOT_EXPORT']) {
    if (serialized.includes(forbidden)) throw new DecisionFeatureExportError(`Feature export leaked ${forbidden}`);
  }
  if (authorization.reidentificationCanary && serialized.includes(authorization.reidentificationCanary)) {
    throw new DecisionFeatureExportError('Feature export leaked the re-identification canary');
  }
}

function normalizedSemanticRow(observation: DecisionFeatureObservation): Pick<DecisionFeatureObservation,
  'featureSet' | 'observationId' | 'subjectId' | 'eventTime' | 'exportTime' | 'sourceReceipt' | 'authorization' | 'lifecycle' | 'lineage' | 'trainServe' | 'batchAccounting' | 'features'> {
  return {
    featureSet: observation.featureSet,
    observationId: observation.observationId,
    subjectId: observation.subjectId,
    eventTime: observation.eventTime,
    exportTime: observation.exportTime,
    sourceReceipt: observation.sourceReceipt,
    authorization: observation.authorization,
    lifecycle: observation.lifecycle,
    lineage: observation.lineage,
    trainServe: observation.trainServe,
    batchAccounting: observation.batchAccounting,
    features: observation.features,
  };
}

function visibleFeatureCells(features: Record<string, DecisionFeatureCell>): Record<string, Omit<DecisionFeatureCell, 'evidencePath'>> {
  return Object.fromEntries(Object.entries(features).map(([name, cell]) => [name, {
    value: cell.value,
    state: cell.state,
    source: cell.source,
    missingReason: cell.missingReason,
    calibrationRef: cell.calibrationRef,
    derivation: cell.derivation,
  }]));
}
