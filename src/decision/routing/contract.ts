import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../../security/artifact-trust.js';
import { admitEntry } from '../entry.js';
import type { RoutingDigest, RoutingPolicy, RoutingPromotionThresholds, RoutingShadowReport } from './types.js';

export class RoutingContractError extends Error {
  constructor(message: string, readonly layer: 'admission' | 'schema' | 'semantic' = 'semantic', readonly details: readonly string[] = []) {
    super(message);
    this.name = 'RoutingContractError';
  }
}

export const ROUTING_SCHEMA_FILES = {
  policy: 'DecisionRoutingPolicy.v1.schema.json',
  receipt: 'DecisionRouteReceipt.v1.schema.json',
  shadowReport: 'DecisionRoutingShadowReport.v1.schema.json',
} as const;
export type RoutingSchemaKind = keyof typeof ROUTING_SCHEMA_FILES;

let validators: Map<RoutingSchemaKind, ValidateFunction> | null = null;

function validator(kind: RoutingSchemaKind): ValidateFunction {
  if (!validators) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
      .find(path => existsSync(resolve(path, ROUTING_SCHEMA_FILES.policy)));
    if (!dir) throw new Error('Decision routing schema directory is unavailable');
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    validators = new Map((Object.keys(ROUTING_SCHEMA_FILES) as RoutingSchemaKind[]).map(name => [
      name,
      ajv.compile(JSON.parse(readFileSync(resolve(dir, ROUTING_SCHEMA_FILES[name]), 'utf8')) as object),
    ]));
  }
  return validators.get(kind)!;
}

export function routingDigest(value: unknown): RoutingDigest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
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

export function validateRoutingPolicy(value: unknown): { policy: RoutingPolicy; digest: RoutingDigest } {
  checkRoutingSchema('policy', value);
  const policy = value as RoutingPolicy;
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
  if (policy.jevEvidence.calibrationRequired && !policy.jevEvidence.compatibleProfiles.length) problems.push('calibrated evidence requires compatible profiles');
  semantic(problems, 'routing policy rejected');
  return { policy, digest: routingDigest(policy) };
}

export function routingThresholdsDigest(thresholds: RoutingPromotionThresholds): RoutingDigest {
  return routingDigest(thresholds);
}

export function validateRoutingShadowReport(value: unknown): RoutingShadowReport {
  checkRoutingSchema('shadowReport', value);
  const report = value as RoutingShadowReport;
  const { digest, ...payload } = report;
  const problems: string[] = [];
  if (digest !== routingDigest(payload)) problems.push('shadow report digest mismatch');
  if (report.preregistration.thresholdsDigest !== routingThresholdsDigest(report.thresholds)) problems.push('threshold preregistration digest mismatch');
  if (report.integrity.release_gate.decision === 'HOLD' && report.decision === 'PROMOTE') problems.push('integrity HOLD cannot be upgraded');
  if (report.integrity.release_gate.decision === 'ROLLBACK' && report.decision !== 'ROLLBACK') problems.push('integrity ROLLBACK cannot be upgraded');
  semantic(problems, 'routing shadow report rejected');
  return report;
}
