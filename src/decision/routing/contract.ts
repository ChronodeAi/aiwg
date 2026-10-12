import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../../security/artifact-trust.js';
import { admitEntry } from '../entry.js';
import type { JevRoutingEvidence, RoutingDigest, RoutingPolicy, RoutingPreregistration, RoutingTask } from './types.js';

export class RoutingContractError extends Error {
  constructor(message: string, readonly layer: 'admission' | 'schema' | 'semantic' = 'semantic', readonly details: readonly string[] = []) {
    super(message);
    this.name = 'RoutingContractError';
  }
}

export const ROUTING_SCHEMA_FILES = {
  policy: 'DecisionRoutingPolicy.v1.schema.json',
  task: 'DecisionRoutingTask.v1.schema.json',
  receipt: 'DecisionRouteReceipt.v1.schema.json',
  shadowReport: 'DecisionRoutingShadowReport.v1.schema.json',
} as const;
/** `jevEvidence` is the receipt schema's closed evidence definition, applied to raw Jev output. */
export type RoutingSchemaKind = keyof typeof ROUTING_SCHEMA_FILES | 'jevEvidence' | 'preregistration' | 'observation';

/** Floors below which no preregistration is accepted (#2620 review: n=2 per arm is not evidence). */
export const ROUTING_MINIMUM_OVERALL_N = 30;
export const ROUTING_MINIMUM_SLICE_N = 10;

let validators: Map<RoutingSchemaKind, ValidateFunction> | null = null;

function validator(kind: RoutingSchemaKind): ValidateFunction {
  if (!validators) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
      .find(path => existsSync(resolve(path, ROUTING_SCHEMA_FILES.policy)));
    if (!dir) throw new Error('Decision routing schema directory is unavailable');
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const compiled = new Map<RoutingSchemaKind, ValidateFunction>((Object.keys(ROUTING_SCHEMA_FILES) as Array<keyof typeof ROUTING_SCHEMA_FILES>).map(name => [
      name,
      ajv.compile(JSON.parse(readFileSync(resolve(dir, ROUTING_SCHEMA_FILES[name]), 'utf8')) as object),
    ]));
    compiled.set('jevEvidence', ajv.getSchema('https://aiwg.io/schemas/decision/DecisionRouteReceipt.v1.schema.json#/$defs/jevEvidence')!);
    compiled.set('preregistration', ajv.getSchema('https://aiwg.io/schemas/decision/DecisionRoutingShadowReport.v1.schema.json#/$defs/preregistration')!);
    compiled.set('observation', ajv.getSchema('https://aiwg.io/schemas/decision/DecisionRoutingShadowReport.v1.schema.json#/$defs/observation')!);
    validators = compiled;
  }
  return validators.get(kind)!;
}

export function routingDigest(value: unknown): RoutingDigest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function compareRoutingKeys(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Deep-freezes a structured clone so no caller or callback can widen a trusted value in place. */
export function frozenRoutingClone<T>(value: T): T {
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
  };
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

export function checkRoutingSchema(kind: RoutingSchemaKind, value: unknown): void {
  try { admitEntry(value); } catch { throw new RoutingContractError(`${kind} admission denied`, 'admission'); }
  const check = validator(kind);
  if (!check(value)) {
    throw new RoutingContractError(`${kind} does not match its v1 schema`, 'schema',
      (check.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`));
  }
}

function semantic(problems: string[], message: string): void {
  if (problems.length) throw new RoutingContractError(`${message}: ${problems[0]}`, 'semantic', problems);
}

/** Returns a deep-frozen copy; the digest covers candidates in canonical ID order, so it does not depend on input order. */
export function validateRoutingPolicy(value: unknown): { policy: RoutingPolicy; digest: RoutingDigest } {
  checkRoutingSchema('policy', value);
  const input = value as RoutingPolicy;
  const policy = frozenRoutingClone({ ...input, candidates: [...input.candidates].sort((a, b) => compareRoutingKeys(a.id, b.id)) });
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const candidate of policy.candidates) {
    if (ids.has(candidate.id)) problems.push(`route ${candidate.id} is duplicated`);
    ids.add(candidate.id);
    if (candidate.operations.maxAttempts > policy.ceilings.maxAttempts) problems.push(`route ${candidate.id} exceeds policy attempt ceiling`);
    if (candidate.operations.deadlineMs > policy.ceilings.deadlineMs) problems.push(`route ${candidate.id} exceeds policy deadline ceiling`);
    if (candidate.operations.costMicrosPerAttempt !== null && candidate.operations.costMicrosPerAttempt > policy.ceilings.maxCostMicros) {
      problems.push(`route ${candidate.id} exceeds policy cost ceiling`);
    }
  }
  for (const routeId of [policy.defaultRouteId, policy.deterministicFallbackRouteId].filter(Boolean)) {
    if (!ids.has(routeId!)) problems.push(`configured route ${routeId} is not declared`);
  }
  if (Object.values(policy.utility).some(value => !Number.isFinite(value) || value < 0)) problems.push('utility weights must be finite non-negative numbers');
  if (policy.ceilings.maxFallbacks >= policy.ceilings.maxAttempts) problems.push('maxFallbacks must be below maxAttempts');
  semantic(problems, 'routing policy rejected');
  return { policy, digest: routingDigest(policy) };
}

/** Closed task schema plus semantic checks; unknown, missing or non-finite requirements fail closed. */
export function validateRoutingTask(value: unknown): RoutingTask {
  checkRoutingSchema('task', value);
  return value as RoutingTask;
}

/** Closed evidence schema plus finiteness; NaN and Infinity cannot pass a JSON schema number check reliably. */
export function validateJevRoutingEvidence(value: unknown): JevRoutingEvidence {
  checkRoutingSchema('jevEvidence', value);
  const evidence = value as JevRoutingEvidence;
  const numbers = [evidence.taskComplexity, evidence.ambiguity, ...evidence.distributions.flatMap(item => [item.taskFit, item.reasoningNeed])];
  if (!numbers.every(item => Number.isFinite(item) && item >= 0 && item <= 1)) {
    throw new RoutingContractError('Jev routing evidence must be finite within [0, 1]', 'semantic');
  }
  return evidence;
}

type PreregistrationFields = Omit<RoutingPreregistration, 'schemaVersion' | 'digest'>;

/** Freeze the paired task set, slices and every promotion threshold before any holdout access. */
export function freezeRoutingPreregistration(input: PreregistrationFields): RoutingPreregistration {
  const fields = {
    schemaVersion: 'decision-routing-preregistration/v1' as const,
    policy: input.policy,
    baselineArm: input.baselineArm,
    registeredAt: input.registeredAt,
    tasks: [...(input.tasks ?? [])].map(item => ({ id: item.id, slice: item.slice })).sort((a, b) => compareRoutingKeys(a.id, b.id)),
    thresholds: input.thresholds,
  };
  const value = { ...fields, digest: routingDigest(fields) };
  checkPreregistration(value);
  return value;
}

/** A separately anchored digest is required, as for evaluatePreregisteredBinaryBenchmark. */
export function verifyRoutingPreregistration(value: unknown, trustedDigest: RoutingDigest): RoutingPreregistration {
  checkPreregistration(value);
  const preregistration = value as RoutingPreregistration;
  const { digest, ...fields } = preregistration;
  if (digest !== trustedDigest || digest !== routingDigest(fields)) {
    throw new RoutingContractError('routing preregistration does not match its trusted digest', 'semantic');
  }
  return preregistration;
}

function checkPreregistration(value: unknown): void {
  try { checkRoutingSchema('preregistration', value); } catch (error) {
    throw new RoutingContractError('routing preregistration rejected: invalid schema', 'schema', error instanceof RoutingContractError ? error.details : []);
  }
  const preregistration = value as RoutingPreregistration;
  const problems: string[] = [];
  const ids = preregistration.tasks.map(item => item.id);
  if (new Set(ids).size !== ids.length) problems.push('task IDs must be unique');
  if (ids.some((id, index) => index > 0 && compareRoutingKeys(ids[index - 1]!, id) >= 0)) problems.push('tasks must be sorted by id');
  const { thresholds } = preregistration;
  if (thresholds.minimumOverallN < ROUTING_MINIMUM_OVERALL_N || thresholds.minimumSliceN < ROUTING_MINIMUM_SLICE_N) problems.push('sample floors are below the pilot minimum');
  if (ids.length < thresholds.minimumOverallN) problems.push('fewer registered tasks than minimumOverallN');
  if (!Number.isFinite(Date.parse(preregistration.registeredAt))) problems.push('registeredAt is not a timestamp');
  if (problems.length) throw new RoutingContractError(`routing preregistration rejected: ${problems[0]}`, 'semantic', problems);
}
