import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  MISSION_API_VERSION,
  WORKER_BASELINE_FEATURES,
  WORKER_CONTRACT_REVISION,
  WORKER_DEFINITIONS,
  WORKER_KNOWN_FEATURES,
  WorkerContractError,
  type CanonicalMission,
  type MissionDecodeResult,
  type MissionEncodeResult,
  type MissionLoss,
  type MissionSource,
  type MissionState,
  type MissionTarget,
  type WorkerConsumerSupport,
  type WorkerArtifact,
  type WorkerDefinitionName,
  type WorkerNegotiationRequest,
  type WorkerNegotiationVerdict,
} from './types.js';

type RecordValue = Record<string, unknown>;
const TERMINAL = new Set<MissionState>(['completed', 'failed', 'incomplete', 'cancelled']);

function object(value: unknown, label = 'Mission input'): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function requiredId(record: RecordValue): string {
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata as RecordValue : {};
  const id = string(record.missionId) ?? string(record.mission_id) ?? string(record.id)
    ?? string(record.taskId) ?? string(record.task_id) ?? string(record.responseId) ?? string(metadata.id);
  if (!id) throw new Error('Mission source is missing a stable identifier.');
  return id;
}

export function normalizeMissionState(nativeState: unknown): MissionState {
  const state = String(nativeState ?? 'unknown').toLowerCase().replace(/_/g, '-');
  if (['done', 'completed', 'succeeded', 'success'].includes(state)) return 'completed';
  if (['aborted', 'cancelled', 'canceled'].includes(state)) return 'cancelled';
  if (['failed', 'error', 'rejected', 'timed-out'].includes(state)) return 'failed';
  if (['incomplete', 'budget-exhausted', 'max-iterations', 'max-tokens'].includes(state)) return 'incomplete';
  if (['running', 'in-progress', 'working', 'started', 'assigned', 'admitted', 'starting'].includes(state)) return 'running';
  if (['pending', 'submitted', 'queued', 'runnable', 'scheduled'].includes(state)) return 'pending';
  if (['blocked', 'blocked-hitl', 'input-required', 'auth-required', 'paused', 'suspended'].includes(state)) return 'blocked';
  if (['operator-review', 'operator-review-required', 'manual-review'].includes(state)) return 'operator-review';
  if (['unknown', 'disconnected', 'detached', 'unreachable'].includes(state)) return 'unknown';
  return 'unknown';
}

function knownKeysFor(source: MissionSource): Set<string> {
  const common = ['id', 'missionId', 'mission_id', 'taskId', 'task_id', 'responseId', 'title', 'goal', 'objective', 'prompt', 'completion', 'completionCriterion', 'completion_criterion', 'status', 'state', 'nativeState', 'createdAt', 'created_at', 'updatedAt', 'updated_at', 'metadata', 'spec', 'provenance', 'extensions', 'artifacts', 'output', 'partialOutput', 'error', 'checkpoint', 'cycles', 'activityLog', 'totalCost', 'runtimesUsed', 'apiVersion', 'api_version', 'schemaVersion', 'schema_version', 'kind', 'session_id', 'previous_response_id'];
  if (source === 'uhp-2026-08-11') common.push('object', 'model', 'incomplete_details', 'store', 'usage');
  return new Set(common);
}

function extensions(record: RecordValue, source: MissionSource): RecordValue {
  const explicit = record.extensions && typeof record.extensions === 'object' ? structuredClone(record.extensions as RecordValue) : {};
  if (record.metadata && typeof record.metadata === 'object') explicit.metadata = structuredClone(record.metadata);
  if (record.status && typeof record.status === 'object') explicit.nativeStatus = structuredClone(record.status);
  for (const [key, value] of Object.entries(record)) if (!knownKeysFor(source).has(key)) explicit[key] = structuredClone(value);
  return explicit;
}

function artifacts(record: RecordValue): CanonicalMission['status']['artifacts'] {
  const values = Array.isArray(record.artifacts) ? record.artifacts : [];
  return values.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const artifact = item as RecordValue;
    const id = string(artifact.id) ?? string(artifact.fileId) ?? string(artifact.file_id) ?? string(artifact.uri) ?? `artifact-${index}`;
    return [{
      id,
      kind: string(artifact.kind) ?? 'other',
      ...(string(artifact.uri) ? { uri: string(artifact.uri) } : {}),
      ...(string(artifact.sha256) ? { sha256: string(artifact.sha256) } : {}),
      ...(string(artifact.mediaType) ?? string(artifact.media_type) ? { mediaType: string(artifact.mediaType) ?? string(artifact.media_type) } : {}),
      extensions: structuredClone(artifact),
    }];
  });
}

function uhpOutputArtifacts(record: RecordValue): CanonicalMission['status']['artifacts'] {
  const found = new Map<string, CanonicalMission['status']['artifacts'][number]>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as RecordValue;
    const id = string(item.file_id);
    if (id) found.set(id, { id, kind: 'uhp-file', ...(string(item.media_type) ? { mediaType: string(item.media_type) } : {}), extensions: { 'uhp.file': structuredClone(item) } });
    Object.values(item).forEach(visit);
  }
  visit(record.output);
  return [...found.values()];
}

function nativeStateFor(source: MissionSource, record: RecordValue, statusRecord: RecordValue): string {
  const explicit = string(statusRecord.state) ?? string(record.nativeState) ?? string(record.status)
    ?? string(record.state) ?? string(record.observed_state) ?? string(record.observedState) ?? string(record.nodeState);
  if (explicit) return explicit;
  if (source === 'mission-ledger' && record.checkpoint && typeof record.checkpoint === 'object') {
    const checkpoint = record.checkpoint as RecordValue;
    if (Array.isArray(checkpoint.pending) && checkpoint.pending.length) return 'running';
    if (Array.isArray(checkpoint.failed) && checkpoint.failed.length) return 'failed';
    if (Array.isArray(checkpoint.completed) && checkpoint.completed.length) return 'completed';
  }
  return 'unknown';
}

function sourceVersion(source: MissionSource, record: RecordValue): string {
  if (source === 'canonical') return string(record.apiVersion) ?? 'unknown';
  if (source === 'uhp-2026-08-11') return '2026-08-11';
  if (source === 'executor-v1') return 'executor.aiwg.io/v1';
  if (source === 'fleet-workload-v1') return 'fleet-workload/v1';
  if (source === 'graph-flow-v1') return 'graph.flow.aiwg.io/v1';
  if (source === 'activity-v1') return 'activity.aiwg.io/v1';
  return string(record.apiVersion) ?? string(record.api_version) ?? string(record.schemaVersion) ?? string(record.schema_version) ?? 'unversioned';
}

function assertSupported(version: string): void {
  const supported = new Set(['unversioned', MISSION_API_VERSION, '2026-08-11', 'executor.aiwg.io/v1', 'fleet-workload/v1', 'graph.flow.aiwg.io/v1', 'activity.aiwg.io/v1']);
  if (supported.has(version)) return;
  const major = version.match(/(?:^|\/)v(\d+)(?:$|[.-])/)?.[1];
  if (major && major !== '1') throw new Error(`Unsupported Mission source major version '${version}'; supported major is v1.`);
  throw new Error(`Unsupported Mission source version '${version}'.`);
}

export function validateCanonicalMission(value: unknown): CanonicalMission {
  const record = object(value, 'Canonical Mission');
  assertMissionWorkerHandoff(record, 'canonical');
  if (record.apiVersion !== MISSION_API_VERSION) throw new Error(`Unsupported canonical Mission version '${String(record.apiVersion)}'.`);
  if (record.kind !== 'Mission') throw new Error("Canonical Mission kind must be 'Mission'.");
  const metadata = object(record.metadata, 'Mission metadata');
  const spec = object(record.spec, 'Mission spec');
  const status = object(record.status, 'Mission status');
  const provenance = object(record.provenance, 'Mission provenance');
  if (!string(metadata.id) || !string(spec.objective) || !string(provenance.sourceContract) || !string(provenance.sourceVersion)) throw new Error('Canonical Mission is missing required identity, objective, or provenance.');
  const state = normalizeMissionState(status.state);
  if (status.state !== state) throw new Error(`Canonical Mission state '${String(status.state)}' is not normalized.`);
  if (status.terminal !== TERMINAL.has(state)) throw new Error(`Canonical Mission terminal flag contradicts state '${state}'.`);
  if (!Array.isArray(status.artifacts)) throw new Error('Canonical Mission artifacts must be an array.');
  return structuredClone(value as CanonicalMission);
}

export function decodeMission(input: unknown, source: MissionSource): MissionDecodeResult {
  const record = object(input);
  assertMissionWorkerHandoff(record, source);
  if (source === 'canonical') {
    const value = validateCanonicalMission(record);
    return { value, sourceVersion: MISSION_API_VERSION, warnings: [], preservedExtensions: structuredClone(value.extensions ?? {}), lossReport: [] };
  }
  const version = sourceVersion(source, record);
  assertSupported(version);
  const statusRecord = record.status && typeof record.status === 'object' ? record.status as RecordValue : {};
  const nativeState = nativeStateFor(source, record, statusRecord);
  const state = normalizeMissionState(nativeState);
  const objective = string(record.goal) ?? string(record.objective) ?? string(record.title) ?? string(record.prompt) ?? '(legacy mission objective unavailable)';
  const completionCriterion = string(record.completionCriterion) ?? string(record.completion_criterion) ?? string(record.completion);
  const preserved = extensions(record, source);
  const warnings: string[] = [];
  const lossReport: MissionLoss[] = [];
  if (objective.startsWith('(legacy')) warnings.push('Source did not contain a mission objective; placeholder retained.');
  if (state === 'unknown' && nativeState !== 'unknown') warnings.push(`Unknown native state '${nativeState}' preserved beside normalized unknown state.`);
  const sourceArtifacts = artifacts(record);
  if (source === 'uhp-2026-08-11') {
    const ids = new Set(sourceArtifacts.map(artifact => artifact.id));
    for (const artifact of uhpOutputArtifacts(record)) if (!ids.has(artifact.id)) sourceArtifacts.push(artifact);
  }
  const budgets = record.budgets && typeof record.budgets === 'object' ? record.budgets as CanonicalMission['spec']['budgets'] : undefined;
  const lineage = Array.isArray(record.lineage) ? record.lineage.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as RecordValue;
    return string(entry.relation) && string(entry.id) ? [{ relation: string(entry.relation)!, id: string(entry.id)! }] : [];
  }) : undefined;
  const value: CanonicalMission = {
    apiVersion: MISSION_API_VERSION,
    kind: 'Mission',
    metadata: {
      id: requiredId(record),
      ...(string(record.createdAt) ?? string(record.created_at) ? { createdAt: string(record.createdAt) ?? string(record.created_at) } : {}),
      ...(string(record.updatedAt) ?? string(record.updated_at) ? { updatedAt: string(record.updatedAt) ?? string(record.updated_at) } : {}),
      ...(string(record.previous_response_id) ? { previousId: string(record.previous_response_id) } : {}),
      ...(lineage?.length ? { lineage } : {}),
    },
    spec: { objective, ...(completionCriterion ? { completionCriterion } : {}), ...(budgets ? { budgets: structuredClone(budgets) } : {}) },
    status: {
      state,
      terminal: TERMINAL.has(state),
      nativeState,
      artifacts: sourceArtifacts,
      ...(record.output !== undefined || record.partialOutput !== undefined || record.partial_output !== undefined ? { partialOutput: structuredClone(record.partialOutput ?? record.partial_output ?? record.output) } : {}),
    },
    provenance: { sourceContract: source, sourceVersion: version, ...(source === 'a2a' || source.startsWith('uhp') ? { transport: source.split('-')[0] } : {}), sourceId: requiredId(record) },
    ...(Object.keys(preserved).length ? { extensions: { [`aiwg.source.${source}`]: preserved } } : {}),
  };
  return { value, sourceVersion: version, warnings, preservedExtensions: preserved, lossReport };
}

function projectionLosses(value: CanonicalMission, target: MissionTarget): MissionLoss[] {
  const losses: MissionLoss[] = [];
  if (value.status.verification?.length) losses.push({ path: '/status/verification', reason: `${target} has no native verification ledger`, severity: 'warning' });
  if (value.metadata.lineage?.length && !['mission-ledger', 'fleet-workload-v1', 'canonical'].includes(target)) losses.push({ path: '/metadata/lineage', reason: `${target} cannot represent full lineage`, severity: 'required' });
  if (value.spec.budgets && !['fleet-workload-v1', 'canonical'].includes(target)) losses.push({ path: '/spec/budgets', reason: `${target} cannot represent every canonical budget`, severity: 'warning' });
  return losses;
}

export function encodeMission(value: CanonicalMission, target: MissionTarget, options: { allowLoss?: boolean } = {}): MissionEncodeResult {
  assertMissionWorkerHandoff(value, target);
  const mission = validateCanonicalMission(value);
  if (target === 'canonical') return { value: mission, targetVersion: MISSION_API_VERSION, warnings: [], lossReport: [] };
  const lossReport = projectionLosses(mission, target);
  const required = lossReport.filter(loss => loss.severity === 'required');
  if (required.length && !options.allowLoss) throw new Error(`Projection to ${target} would silently lose required semantics: ${required.map(loss => loss.path).join(', ')}.`);
  const base = {
    missionId: mission.metadata.id,
    goal: mission.spec.objective,
    completionCriterion: mission.spec.completionCriterion,
    status: mission.status.nativeState ?? mission.status.state,
    artifacts: structuredClone(mission.status.artifacts),
    partialOutput: structuredClone(mission.status.partialOutput),
    lineage: structuredClone(mission.metadata.lineage ?? []),
    extensions: {
      'aiwg.mission.canonical': { apiVersion: mission.apiVersion, state: mission.status.state, lossReport },
      ...(mission.extensions ?? {}),
    },
  };
  let projected: unknown = base;
  if (target === 'mission-plan') projected = { missionId: base.missionId, goal: base.goal, completionCriterion: base.completionCriterion ?? '', cycles: [], extensions: base.extensions };
  else if (target === 'mission-ledger') projected = { ...base, activityLog: [], cycles: [], totalCost: 0, checkpoint: { completed: [], pending: [], failed: [] }, runtimesUsed: [] };
  else if (target === 'uhp-2026-08-11') projected = { id: mission.provenance.sourceId ?? mission.metadata.id, object: 'response', created_at: 0, status: base.status, model: '', output: mission.status.partialOutput ?? [], metadata: base.extensions };
  else if (target === 'a2a') projected = { id: mission.provenance.sourceId ?? mission.metadata.id, status: { state: base.status }, artifacts: base.artifacts, partialOutput: base.partialOutput, metadata: base.extensions };
  else if (target === 'graph-flow-v1') projected = { schemaVersion: 'graph.flow.aiwg.io/v1', runId: mission.metadata.id, nodeState: mission.status.state, metadata: base.extensions };
  else if (target === 'cockpit') projected = { id: mission.metadata.id, session_id: mission.metadata.id, source: mission.provenance.transport ?? mission.provenance.sourceContract, title: mission.spec.objective, completion: mission.spec.completionCriterion, status: mission.status.state, artifacts: base.artifacts, partialOutput: base.partialOutput, extensions: base.extensions };
  else if (target === 'activity-v1') projected = { event: 'mission.projected', missionId: mission.metadata.id, objective: mission.spec.objective, state: mission.status.state, metadata: base.extensions };
  else if (target === 'executor-v1') projected = { mission_id: mission.metadata.id, objective: mission.spec.objective, completion_criterion: mission.spec.completionCriterion, state: base.status, artifacts: base.artifacts, partial_output: base.partialOutput, metadata: base.extensions };
  else if (target === 'fleet-workload-v1') projected = { mission_id: mission.metadata.id, objective: mission.spec.objective, completion_criterion: mission.spec.completionCriterion, observed_state: base.status, budgets: mission.spec.budgets, artifacts: base.artifacts, partial_output: base.partialOutput, lineage: base.lineage, metadata: base.extensions };
  else if (target === 'mission-control-session') projected = { id: mission.metadata.id, objective: mission.spec.objective, status: mission.status.state, completion: mission.spec.completionCriterion, artifacts: base.artifacts, partialOutput: base.partialOutput, extensions: base.extensions };
  return { value: projected, targetVersion: target, warnings: lossReport.map(loss => `${loss.path}: ${loss.reason}`), lossReport };
}

// Worker dispatch payloads (05 §5.1). Validators compile lazily from the
// production schemas/mission-v1.schema.json owner, so codecs cannot drift
// from the shipped contract. Nothing here instantiates a Mission runtime.

interface WorkerValidatorSet {
  schemaId: string;
  bundleDigest: string;
  validators: Map<WorkerDefinitionName, ValidateFunction>;
}

let cachedWorkerValidators: WorkerValidatorSet | undefined;

function missionPackageRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    try {
      const packageJson = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as { name?: string };
      if (packageJson.name === 'aiwg' || packageJson.name === '@aiwg/cli') return current;
    } catch {
      // Keep walking; source and compiled modules have different depths.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('worker contracts: could not locate the aiwg package root');
    current = parent;
  }
}

function loadWorkerValidators(): WorkerValidatorSet {
  if (!cachedWorkerValidators) {
    const schemaPath = join(missionPackageRoot(dirname(fileURLToPath(import.meta.url))), 'schemas/mission-v1.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    if (typeof schema.$id !== 'string') throw new WorkerContractError('OG_CONTRACT_INVALID', 'Worker contract owner has no schema $id.');
    const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
    ajv.addSchema(schema);
    const validators = new Map<WorkerDefinitionName, ValidateFunction>();
    for (const definition of WORKER_DEFINITIONS) validators.set(definition, ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` }));
    cachedWorkerValidators = { schemaId: schema.$id, bundleDigest: workerBundleDigestFor(schema), validators };
  }
  return cachedWorkerValidators;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function workerBundleDigestFor(schema: Record<string, unknown>): string {
  const defs = schema.$defs as Record<string, unknown>;
  const workerDefs = Object.fromEntries(WORKER_DEFINITIONS.filter(definition => definition in defs).map(definition => [definition, defs[definition]]));
  return `sha256:${createHash('sha256').update(stableJson(workerDefs)).digest('hex')}`;
}

/** Digest of the shipped worker definition bundle; consumers advertise it back during negotiation. */
export function workerDefinitionBundleDigest(): string {
  return loadWorkerValidators().bundleDigest;
}

export function workerContractSchemaId(): string {
  return loadWorkerValidators().schemaId;
}

export interface WorkerPayloadValidation {
  valid: boolean;
  errors: string[];
}

// 05 §5.1: complete JSON payloads are bounded independently of field limits.
export const WORKER_MAX_JSON_BYTES = 262_144;
export const WORKER_MAX_NESTING_DEPTH = 16;

function workerSemanticErrors(value: unknown): string[] {
  const ancestors = new Set<object>();
  function visit(node: unknown, depth: number): string | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (depth > WORKER_MAX_NESTING_DEPTH) return `JSON nesting depth exceeds ${WORKER_MAX_NESTING_DEPTH}`;
    if (ancestors.has(node)) return 'Worker JSON must not contain cycles';
    ancestors.add(node);
    for (const child of Object.values(node)) {
      const error = visit(child, depth + 1);
      if (error) return error;
    }
    ancestors.delete(node);
    return undefined;
  }
  // Root object/array is depth 1; scalar leaves do not add a nesting level.
  const depthError = visit(value, 1);
  if (depthError) return [depthError];
  try {
    const bytes = JSON.stringify(value);
    if (bytes === undefined) return ['Worker payload must be JSON serializable'];
    if (Buffer.byteLength(bytes, 'utf8') > WORKER_MAX_JSON_BYTES) return [`Serialized UTF-8 JSON exceeds ${WORKER_MAX_JSON_BYTES} bytes`];
  } catch {
    return ['Worker payload must be JSON serializable'];
  }
  return [];
}

/** Validate a worker payload against its bundled definition. Closed shapes reject unknown fields. */
export function validateWorkerPayload(definition: WorkerDefinitionName, value: unknown): WorkerPayloadValidation {
  const semanticErrors = workerSemanticErrors(value);
  if (semanticErrors.length) return { valid: false, errors: semanticErrors };
  const validate = loadWorkerValidators().validators.get(definition);
  if (!validate) throw new WorkerContractError('OG_CONTRACT_INVALID', `Unknown worker definition '${definition}'.`);
  const valid = validate(value) as boolean;
  const errors = valid ? [] : (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`);
  return { valid, errors };
}

export function assertValidWorkerPayload(definition: WorkerDefinitionName, value: unknown): void {
  const { valid, errors } = validateWorkerPayload(definition, value);
  if (!valid) throw new WorkerContractError('OG_CONTRACT_INVALID', `Invalid ${definition}: ${errors.join('; ') || 'shape mismatch'}.`);
}

/**
 * Fail-closed negotiation before any task data handoff. Absent or unknown
 * required features, incompatible digests/revisions, or codecs without
 * lossless round trips yield OG_CONTRACT_UNSUPPORTED.
 */
export function workerSupportBlockers(consumer: WorkerConsumerSupport, required: WorkerNegotiationRequest): string[] {
  const blockers: string[] = [];
  if (consumer.revision !== WORKER_CONTRACT_REVISION) blockers.push(`unsupported revision ${String(consumer.revision)}; required ${WORKER_CONTRACT_REVISION}`);
  if (consumer.bundleDigest !== required.bundleDigest) blockers.push('definition-bundle digest mismatch');
  if (consumer.lossless !== true) blockers.push('codec does not guarantee lossless round trips');
  if (!Array.isArray(consumer.features)) blockers.push('absent consumer feature metadata');
  else {
    for (const feature of required.requiredFeatures) {
      if (!(WORKER_KNOWN_FEATURES as readonly string[]).includes(feature)) blockers.push(`unknown required feature '${feature}'`);
      else if (!consumer.features.includes(feature)) blockers.push(`missing required feature '${feature}'`);
    }
  }
  return blockers;
}

export function negotiateWorkerSupport(consumer: WorkerConsumerSupport, required: WorkerNegotiationRequest): WorkerNegotiationVerdict {
  return workerSupportBlockers(consumer, required).length ? 'OG_CONTRACT_UNSUPPORTED' : 'supported';
}

/** Block old consumers before payload handling or spawn. */
export function assertWorkerConsumerSupported(consumer: WorkerConsumerSupport, required: WorkerNegotiationRequest): void {
  const blockers = workerSupportBlockers(consumer, required);
  if (blockers.length) throw new WorkerContractError('OG_CONTRACT_UNSUPPORTED', `OG_CONTRACT_UNSUPPORTED: ${blockers.join('; ')}.`);
}

export interface WorkerPayloadGate {
  consumer: WorkerConsumerSupport;
  requiredFeatures?: readonly string[];
  bundleDigest?: string;
}

function gateRequest(gate: WorkerPayloadGate): WorkerNegotiationRequest {
  return {
    requiredFeatures: [...(gate.requiredFeatures ?? WORKER_BASELINE_FEATURES)],
    bundleDigest: gate.bundleDigest ?? workerDefinitionBundleDigest(),
  };
}

/** Trusted registration for the codec only; runtime consumers remain unqualified. */
function canonicalWorkerSupport(): WorkerConsumerSupport {
  return { revision: WORKER_CONTRACT_REVISION, bundleDigest: workerDefinitionBundleDigest(), features: [...WORKER_KNOWN_FEATURES], lossless: true };
}

function workerDispatchRecord(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Invalid workerDispatch: must be an object.');
  }
  return value as RecordValue;
}

/**
 * Existing Mission/native owners call this before cloning, projection or launch.
 * Only the canonical codec has qualified worker preservation. An open native
 * extension map never qualifies an executor, renderer or runtime by itself.
 */
export function assertMissionWorkerHandoff(input: unknown, consumer: MissionSource | string): void {
  const seen = new Set<object>();
  const seenRecords = new Set<object>();
  function visitExtensions(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return;
    seen.add(value);
    const record = value as RecordValue;
    if (Object.hasOwn(record, 'aiwg.worker-dispatch')) {
      const dispatch = workerDispatchRecord(record['aiwg.worker-dispatch']);
      if (dispatch.version !== WORKER_CONTRACT_REVISION) {
        throw new WorkerContractError('OG_CONTRACT_UNSUPPORTED', `OG_CONTRACT_UNSUPPORTED: unsupported worker revision ${String(dispatch.version)}.`);
      }
      const support = canonicalWorkerSupport();
      assertWorkerConsumerSupported({ ...support, lossless: consumer === 'canonical', ...(consumer === 'canonical' ? {} : { features: [] }) }, {
        requiredFeatures: Array.isArray(dispatch.requiredFeatures) ? dispatch.requiredFeatures : [...WORKER_BASELINE_FEATURES],
        bundleDigest: workerDefinitionBundleDigest(),
      });
      assertValidWorkerPayload('workerDispatch', dispatch);
    }
    // aiwg.source.* contains preserved native extension maps and records.
    // Other vendor values and output data are opaque, even if their keys
    // happen to match a worker extension name.
    for (const [key, child] of Object.entries(record)) if (key.startsWith('aiwg.source.')) {
      visitExtensions(child);
      visitRecord(child);
    }
  }
  function visitRecord(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seenRecords.has(value)) return;
    seenRecords.add(value);
    const record = value as RecordValue;
    // All mission-v1 carriers: /extensions and /status/artifacts/*/extensions.
    visitExtensions(record.extensions);
    const status = record.status as RecordValue | undefined;
    if (Array.isArray(status?.artifacts)) for (const artifact of status.artifacts) visitRecord(artifact);
    // Native protocols carry extensions in metadata and top-level artifacts.
    visitExtensions(record.metadata);
    if (Array.isArray(record.artifacts)) for (const artifact of record.artifacts) visitRecord(artifact);
  }
  visitRecord(input);
}

function assertWorkerPayloadHandoff(definition: WorkerDefinitionName, value: unknown, gate?: WorkerPayloadGate): void {
  const consumer = gate?.consumer ?? canonicalWorkerSupport();
  const request = gate ? gateRequest(gate) : { requiredFeatures: [...WORKER_BASELINE_FEATURES], bundleDigest: workerDefinitionBundleDigest() };
  assertWorkerConsumerSupported(consumer, request);
  if (definition === 'workerDispatch') {
    const dispatch = workerDispatchRecord(value);
    if (dispatch.version !== WORKER_CONTRACT_REVISION) throw new WorkerContractError('OG_CONTRACT_UNSUPPORTED', 'OG_CONTRACT_UNSUPPORTED: unsupported worker revision.');
    // Payload requirements are authoritative even if a caller supplies a gate
    // with a weaker list. Negotiation cannot be bypassed through options.
    assertWorkerConsumerSupported(consumer, {
      ...request,
      requiredFeatures: [...new Set([...request.requiredFeatures, ...(Array.isArray(dispatch.requiredFeatures) ? dispatch.requiredFeatures : [])])],
    });
  }
  assertValidWorkerPayload(definition, value);
}

/**
 * Validate and losslessly clone a worker payload for transmission. When a
 * consumer gate is absent, the trusted codec registration is used. Unsupported
 * consumers are blocked before validation/cloning. Decoding mirrors encoding:
 * no normalization is applied,
 * so decode(encode(value)) is deep-equal to value.
 */
export function encodeWorkerPayload<T = unknown>(definition: WorkerDefinitionName, value: T, gate?: WorkerPayloadGate): T {
  assertWorkerPayloadHandoff(definition, value, gate);
  return structuredClone(value);
}

export function decodeWorkerPayload<T = unknown>(definition: WorkerDefinitionName, value: T, gate?: WorkerPayloadGate): T {
  assertWorkerPayloadHandoff(definition, value, gate);
  return structuredClone(value);
}

/** In-memory codec snapshot, not a new persisted contract or storage owner. */
export interface WorkerPayloadSnapshot {
  readonly definition: WorkerDefinitionName;
  readonly bytes: string;
  readonly artifact: Readonly<WorkerArtifact>;
  readonly previousRecord: Readonly<WorkerArtifact> | null;
}

/**
 * 05 §5.1 / 06 §7: retain hashed bytes and link a successor rather than rewrite
 * the pending version. Tier 0 callers can keep these in context; Tier 1 owners
 * persist them in existing Mission/Flow/Ralph artifacts (S2+).
 */
export function encodeWorkerPayloadSnapshot<T>(definition: WorkerDefinitionName, value: T, previous?: WorkerPayloadSnapshot): WorkerPayloadSnapshot {
  const encoded = encodeWorkerPayload(definition, value);
  if (previous) {
    if (previous.definition !== definition || `sha256:${createHash('sha256').update(previous.bytes, 'utf8').digest('hex')}` !== previous.artifact.digest) {
      throw new WorkerContractError('OG_CONTRACT_INVALID', 'Prior worker snapshot definition or digest does not match its preserved bytes.');
    }
    const prior = decodeWorkerPayload(definition, JSON.parse(previous.bytes)) as RecordValue;
    const next = encoded as RecordValue;
    for (const identity of ['taskId', 'requestId', 'invocationId', 'briefDigest']) {
      if (prior[identity] !== next[identity]) throw new WorkerContractError('OG_CONTRACT_INVALID', `Worker successor changes ${identity}.`);
    }
    if (definition === 'workerDispatch') {
      const link = next.previousRecord as WorkerArtifact | null;
      if (link?.digest !== previous.artifact.digest || link?.ref !== previous.artifact.ref) {
        throw new WorkerContractError('OG_CONTRACT_INVALID', 'Worker dispatch successor must link previousRecord to its prior snapshot.');
      }
    }
  }
  const bytes = JSON.stringify(encoded);
  const digest = `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
  return Object.freeze({ definition, bytes, artifact: Object.freeze({ ref: `artifact:${digest}`, digest }), previousRecord: previous ? Object.freeze({ ...previous.artifact }) : null });
}
