// Mission worker payload validation, negotiation and immutable snapshots.
import { stableJson } from './worker-contract-json.js';
import { prepareWorkerAcceptance, workerReviewEvidenceErrors, assertWorkerReviewSuccessor, type WorkerAcceptanceContext } from './worker-review-gate.js';
import { workerSemanticErrors, contractValidationPointer } from './worker-contract-diagnostics.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  WORKER_BASELINE_FEATURES,
  WORKER_CONTRACT_REVISION,
  WORKER_DEFINITIONS,
  WORKER_DEFINITION_PRODUCERS,
  WORKER_KNOWN_FEATURES,
  WorkerContractError,
  type MissionSource,
  type WorkerConsumerSupport,
  type WorkerArtifact,
  type WorkerDefinitionName,
  type WorkerNegotiationRequest,
  type WorkerNegotiationVerdict,
  type WorkerDefinitionProducer,
  type WorkerClaims,
  type WorkerExecution,
  type WorkerBrief,
  type WorkerDirectBrief,
  type WorkerVerification,
  type WorkerDirectVerification,
  type WorkerEffectiveHealth,
  type WorkerResolvedInvocation,
} from './types.js';

type RecordValue = Record<string, unknown>;
export * from './canonical-codecs.js';
export * from './health-trace-codecs.js';

// Worker dispatch payloads (05 §5.1). Validators compile lazily from the
// production schemas/mission-v1.schema.json owner, so codecs cannot drift
// from the shipped contract. Nothing here instantiates a Mission runtime.

interface WorkerValidatorSet {
  schemaId: string;
  schema: Record<string, unknown>;
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
    const ajv = addFormats(new Ajv2020({ strict: true, strictRequired: false, allErrors: true }));
    ajv.addSchema(schema);
    const validators = new Map<WorkerDefinitionName, ValidateFunction>();
    for (const definition of WORKER_DEFINITIONS) validators.set(definition, ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` }));
    cachedWorkerValidators = { schema, schemaId: schema.$id, bundleDigest: workerBundleDigestFor(schema), validators };
  }
  return cachedWorkerValidators;
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

/** Validate a worker payload against its bundled definition. Closed shapes reject unknown fields. */
export function validateWorkerPayload(definition: WorkerDefinitionName, value: unknown): WorkerPayloadValidation {
  const semanticErrors = workerSemanticErrors(value, WORKER_MAX_JSON_BYTES, WORKER_MAX_NESTING_DEPTH);
  if (semanticErrors.length) return { valid: false, errors: semanticErrors };
  const validate = loadWorkerValidators().validators.get(definition);
  if (!validate) throw new WorkerContractError('OG_CONTRACT_INVALID', `Unknown worker definition '${definition}'.`);
  const valid = validate(value) as boolean;
  const errors = valid ? [] : (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`);
  if (valid) {
    const checkHealth = (health: WorkerEffectiveHealth): void => {
      if (health.checkSeconds > health.startupSeconds) errors.push('Health checkSeconds must not exceed startupSeconds');
      if (health.quietSeconds >= health.stallSeconds) errors.push('Health quietSeconds must be less than stallSeconds');
    };
    if (definition === 'workerVerification' || definition === 'workerDirectVerification') errors.push(...workerReviewEvidenceErrors(value as WorkerVerification));
    if (definition === 'workerResult' || definition === 'workerDirectResult') errors.push(...workerReviewEvidenceErrors((value as { verification: WorkerVerification }).verification));
    if (definition === 'workerEffectiveHealth') checkHealth(value as WorkerEffectiveHealth);
    if (definition === 'workerResolvedInvocation') {
      // Legacy and preparatory descriptors may omit health. Preserve that
      // omission in codecs; resolution and observers supply runtime defaults.
      const health = (value as WorkerResolvedInvocation).health;
      if (health !== undefined) checkHealth(health);
    }
  }
  return { valid: valid && errors.length === 0, errors };
}

export function assertValidWorkerPayload(definition: WorkerDefinitionName, value: unknown): void {
  const { valid, errors } = validateWorkerPayload(definition, value);
  if (!valid) {
    const { schema, validators } = loadWorkerValidators();
    throw Object.assign(new WorkerContractError('OG_CONTRACT_INVALID', `Invalid ${definition}: ${errors.join('; ') || 'shape mismatch'}.`),
      { pointer: contractValidationPointer(definition, workerSemanticErrors(value, WORKER_MAX_JSON_BYTES, WORKER_MAX_NESTING_DEPTH).length
        ? null : validators.get(definition)?.errors, schema) });
  }
}

/** The producer is supplied by trusted calling code, never read from payload data. */
export function decodeWorkerProducedPayload<T>(definition: WorkerDefinitionName, producer: WorkerDefinitionProducer, value: T): T {
  if (WORKER_DEFINITION_PRODUCERS[definition] !== producer) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', `Producer ${producer} cannot author ${definition}.`);
  }
  return decodeWorkerPayload(definition, value);
}

/** Shared CLI/MCP terminal gate. Transport observations are adapter-owned. */
export interface WorkerTerminalObservation {
  transport: 'shell' | 'mcp';
  status: WorkerExecution['status'];
  termination: WorkerExecution['termination'];
  exitCode: number | null;
  isError?: boolean;
}

export function assertWorkerTerminal(observation: WorkerTerminalObservation): void {
  if (!observation || !['shell', 'mcp'].includes(observation.transport)
    || observation.status !== 'completed' || observation.termination !== 'confirmed'
    || (observation.transport === 'shell' ? observation.exitCode !== 0 : observation.exitCode !== null && observation.exitCode !== 0)
    || (observation.isError !== undefined && observation.isError !== false)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Worker terminal evidence is missing, erroneous or uncertain; exit zero alone is insufficient.');
  }
}

/**
 * #2915 (evidence contract): the ATTEMPT succeeded/failed/was-uncertain is a
 * separate, launcher-owned fact from whether the WORKER's descendant tree is
 * confirmed stopped (`termination`/`descendants`). `assertWorkerTerminal`
 * above requires `termination === 'confirmed'`, which degraded-isolation
 * shell attempts (no systemd unit; descendant stop is never kernel-confirmed)
 * and most MCP attempts (a response proves request completion, never
 * descendant termination) can never satisfy — so recovery success could
 * never be recorded for them even when the attempt itself plainly succeeded
 * (#2915 final review, finding 4: "degraded success never closes the
 * scope"). `assertWorkerAttemptTerminal` is the attempt-terminal sibling:
 * it requires `attemptOutcome === 'succeeded'` (a fact the launcher/adapter
 * computed from its OWN observed evidence — direct-child clean exit plus a
 * strictly-valid final, or a transport-correlated MCP response plus a
 * strictly-valid final; never a worker claim) instead of confirmed
 * descendant termination. It never manufactures or implies confirmed
 * termination — `termination`/`descendants` on the same result are
 * untouched by this assertion and remain whatever the launcher separately
 * observed.
 */
export interface WorkerAttemptTerminalObservation {
  transport: 'shell' | 'mcp';
  status: WorkerExecution['status'];
  attemptOutcome: 'succeeded' | 'failed' | 'uncertain';
  exitCode: number | null;
  isError?: boolean;
}

export function assertWorkerAttemptTerminal(observation: WorkerAttemptTerminalObservation): void {
  if (!observation || !['shell', 'mcp'].includes(observation.transport)
    || observation.status !== 'completed' || observation.attemptOutcome !== 'succeeded'
    || (observation.transport === 'shell' ? observation.exitCode !== 0 : observation.exitCode !== null && observation.exitCode !== 0)
    || (observation.isError !== undefined && observation.isError !== false)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Worker attempt evidence is missing, erroneous or uncertain; exit zero alone is insufficient.');
  }
}

/**
 * Assemble detached, immutable evidence from separately attributed producers.
 * artifactBytes are read by the conductor from the exact artifact (or protected
 * canonical tree manifest) being verified/integrated, never a worker digest.
 * This is a shared value operation; no Mission/lease/store is needed in direct mode.
 */
// Ordered weakest-to-strongest, matching WorkerExecution['identityQuality'] exactly
// (05 §5.1 / BLOCKER #2890): a required tier is satisfied by that tier or any
// stronger one. Keep this the single source of truth for both the valid-value
// check and the ordering comparison below, so a renamed/added quality tier
// cannot silently resurrect the former `requiredIdentity: 'runtime-configured'`
// no-op (the option never matched any real `identityQuality` value).
const IDENTITY_QUALITY_ORDER = ['unavailable', 'runtime-configured-only', 'backend-attested'] as const;

export function assembleWorkerResult(input: WorkerAcceptanceContext & {
  brief: WorkerBrief | WorkerDirectBrief;
  execution: WorkerExecution;
  worker: WorkerClaims | null;
  verification: WorkerVerification | WorkerDirectVerification;
  artifactBytes?: Uint8Array;
  requiredIdentity?: WorkerExecution['identityQuality'];
}, previous?: WorkerPayloadSnapshot): WorkerPayloadSnapshot {
  if (input.requiredIdentity !== undefined && !(IDENTITY_QUALITY_ORDER as readonly string[]).includes(input.requiredIdentity)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Unknown required identity evidence.');
  }
  const direct = 'mode' in input.brief && input.brief.mode === 'direct';
  const briefDefinition = direct ? 'workerDirectBrief' : 'workerBrief';
  const brief = decodeWorkerProducedPayload(briefDefinition, 'conductor', input.brief);
  const execution = decodeWorkerProducedPayload('workerExecution', 'adapter', input.execution);
  const worker = input.worker === null ? null : decodeWorkerProducedPayload('workerClaims', 'worker', input.worker);
  // Shape-check before relational checks; telemetry is derived only by trusted assembly.
  const verificationInput = structuredClone(input.verification);
  if (verificationInput.status === 'accepted' && verificationInput.reviewRounds?.length) {
    verificationInput.roundsToClean ??= verificationInput.reviewRounds.length;
    verificationInput.headSha ??= input.headSha;
  }
  const shapedVerification = decodeWorkerProducedPayload(direct ? 'workerDirectVerification' : 'workerVerification', 'verifier', verificationInput);
  const verification = prepareWorkerAcceptance(brief, execution, shapedVerification, input);
  if (stableJson(execution.requested) !== stableJson(brief.selected)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Adapter requested identity differs from the bound brief.');
  }
  if (verification.status === 'accepted') {
    if (execution.status !== 'completed' || execution.termination !== 'confirmed'
      || execution.endedAt === null || Date.parse(execution.endedAt) < Date.parse(execution.startedAt) || execution.failure !== null
      || (execution.exitCode !== null && execution.exitCode !== 0) || worker?.status !== 'completed') {
      throw new WorkerContractError('OG_CONTRACT_INVALID', 'Acceptance requires completed claims and confirmed successful execution.');
    }
    if (execution.identityQuality === 'unavailable' || !execution.identityEvidence.length
      || (input.requiredIdentity !== undefined
        && IDENTITY_QUALITY_ORDER.indexOf(execution.identityQuality) < IDENTITY_QUALITY_ORDER.indexOf(input.requiredIdentity))
      || execution.observedModel !== brief.selected.model || execution.observedFamily !== brief.selected.family
      || stableJson(execution.observedEffort) !== stableJson(brief.selected.effort)) {
      throw new WorkerContractError('OG_CONTRACT_INVALID', 'Acceptance requires matching qualified observed identity.');
    }
    if (!(input.artifactBytes instanceof Uint8Array)
      || `sha256:${createHash('sha256').update(input.artifactBytes).digest('hex')}` !== verification.artifactDigest) {
      throw new WorkerContractError('OG_CONTRACT_INVALID', 'Verified artifact digest differs from the exact artifact bytes.');
    }
  }
  const briefSnapshot = encodeWorkerPayloadSnapshot(briefDefinition, brief);
  return encodeWorkerPayloadSnapshot(direct ? 'workerDirectResult' : 'workerResult', {
    version: WORKER_CONTRACT_REVISION,
    taskId: brief.intent.taskId,
    invocationId: brief.invocationId,
    briefDigest: briefSnapshot.artifact.digest,
    execution, worker, verification,
    ...(direct ? { mode: 'direct' } : {}),
  }, previous);
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

/** Build registration metadata for the features explicitly qualified by an owner. */
export function workerConsumerSupport(features: readonly string[]): WorkerConsumerSupport {
  for (const feature of features) if (!(WORKER_KNOWN_FEATURES as readonly string[]).includes(feature)) {
    throw new WorkerContractError('OG_CONTRACT_UNSUPPORTED', `OG_CONTRACT_UNSUPPORTED: unknown consumer feature '${feature}'.`);
  }
  return { revision: WORKER_CONTRACT_REVISION, bundleDigest: workerDefinitionBundleDigest(), features: [...features], lossless: true };
}

/** Trusted registration for the codec only; runtime consumers remain unqualified. */
function canonicalWorkerSupport(): WorkerConsumerSupport {
  return workerConsumerSupport(WORKER_KNOWN_FEATURES);
}

function workerDispatchRecord(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Invalid workerDispatch: must be an object.');
  }
  return value as RecordValue;
}

/**
 * Existing Mission/native owners call this before cloning, projection or launch.
 * Only the canonical codec is qualified by default. Other owners must provide
 * explicit support; an open extension map or consumer name is insufficient.
 */
export function assertMissionWorkerHandoff(input: unknown, consumer: MissionSource | string, workerConsumer?: WorkerConsumerSupport): void {
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
      const support = workerConsumer ?? (consumer === 'canonical' ? canonicalWorkerSupport() : {
        revision: WORKER_CONTRACT_REVISION, bundleDigest: workerDefinitionBundleDigest(), features: [], lossless: false,
      });
      assertWorkerConsumerSupported(support, {
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
    if (definition === 'workerResult' || definition === 'workerDirectResult') {
      assertWorkerReviewSuccessor(prior.verification as WorkerVerification, next.verification as WorkerVerification);
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
