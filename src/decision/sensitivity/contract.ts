import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../../security/artifact-trust.js';
import { admitEntry } from '../entry.js';
import type { JsonValue } from '../types.js';
import type { SensitivityPlan, SensitivityReport, SensitivityDigest } from './types.js';

export class SensitivityContractError extends Error {
  constructor(message: string, readonly layer: 'admission' | 'schema' | 'semantic' = 'semantic', readonly details: readonly string[] = []) {
    super(message);
    this.name = 'SensitivityContractError';
  }
}

export const SENSITIVITY_SCHEMA_FILES = {
  plan: 'DecisionSensitivityPlan.v1.schema.json',
  report: 'DecisionSensitivityReport.v1.schema.json',
} as const;
export type SensitivitySchemaKind = keyof typeof SENSITIVITY_SCHEMA_FILES;

let validators: Map<SensitivitySchemaKind, ValidateFunction> | null = null;

function schemaValidator(kind: SensitivitySchemaKind): ValidateFunction {
  if (!validators) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
      .find(path => existsSync(resolve(path, SENSITIVITY_SCHEMA_FILES.plan)));
    if (!dir) throw new Error('Decision sensitivity schema directory is unavailable');
    const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
    validators = new Map((Object.keys(SENSITIVITY_SCHEMA_FILES) as SensitivitySchemaKind[]).map(name => [
      name,
      ajv.compile(JSON.parse(readFileSync(resolve(dir, SENSITIVITY_SCHEMA_FILES[name]), 'utf8')) as object),
    ]));
  }
  return validators.get(kind)!;
}

export function checkSensitivitySchema(kind: SensitivitySchemaKind, value: unknown): void {
  try { admitEntry(value); } catch { throw new SensitivityContractError(`${kind} admission denied`, 'admission'); }
  const check = schemaValidator(kind);
  if (!check(value)) {
    throw new SensitivityContractError(`${kind} does not match its v1 schema`, 'schema',
      (check.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`));
  }
}

export function sensitivityDigest(value: unknown): SensitivityDigest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function validateSensitivityPlan(value: unknown): SensitivityPlan {
  checkSensitivitySchema('plan', value);
  const plan = value as SensitivityPlan;
  const problems: string[] = [];
  if (plan.mode !== 'disabled' && plan.mode !== 'shadow') problems.push('sensitivity mode must be disabled or shadow');
  if (plan.sourceSubject.tenantId !== plan.tenantId || plan.sourceSubject.workspaceId !== plan.workspaceId
    || plan.sourceSubject.projectId !== plan.projectId) problems.push('source subject must be in the plan tenant/workspace/project');
  if (Date.parse(plan.authorization.expiresAt) <= Date.parse(plan.authorization.approvedAt)) problems.push('authorization expiry must follow approval');
  if (plan.variants.length > plan.budgets.maxVariants) problems.push('variant count exceeds maxVariants');
  if (plan.baselineStability.enabled && plan.baselineStability.repeats > plan.budgets.maxBackendCalls) {
    problems.push('baseline stability repeats exceed backend-call budget');
  }
  if (plan.analysisKind === 'policy-replay' && plan.baselineStability.enabled && plan.baselineStability.repeats > 0) {
    problems.push('baseline stability repeats require input reevaluation');
  }
  if (plan.analysisKind === 'policy-replay' && plan.budgets.maxBackendCalls !== 0) {
    problems.push('policy replay must reserve zero backend calls');
  }
  if (plan.analysisKind === 'input-reevaluation' && plan.privacy.egress !== 'no-external-egress') {
    problems.push('input reevaluation must use no-external-egress in the offline analyzer');
  }
  const allowed = new Set(plan.allowedPaths);
  const domains = new Map(plan.pathDomains.map(domain => [domain.path, domain]));
  for (const path of plan.allowedPaths) {
    if (!domains.has(path)) problems.push(`allowed path ${path} has no D10-approved value domain`);
    if (hasForbiddenPointerSegment(path)) problems.push(`allowed path ${path} contains a prohibited pointer segment`);
    if (forbiddenAuthorityPath(path)) problems.push(`path ${path} can alter model, credential, executor, permission or legal authority`);
    if (plan.analysisKind === 'policy-replay' && !policyReplayPath(path)) problems.push(`policy replay path ${path} is not deterministic policy`);
    if (plan.analysisKind === 'input-reevaluation' && !path.startsWith('/input/')) problems.push(`input reevaluation path ${path} must be under /input`);
  }
  const ids = new Set<string>();
  const precisionPaths = new Map<string, number[]>();
  for (const variant of plan.variants) {
    if (ids.has(variant.id)) problems.push(`variant ${variant.id} is duplicated`);
    if (/^baseline-/i.test(variant.id)) problems.push(`variant ${variant.id} uses a reserved baseline identifier`);
    ids.add(variant.id);
    for (const change of variant.changes) {
      if (!allowed.has(change.path)) problems.push(`variant ${variant.id} changes undeclared path ${change.path}`);
      if (hasForbiddenPointerSegment(change.path)) problems.push(`variant ${variant.id} uses prohibited pointer segment at ${change.path}`);
      if (looksExecutable(change.value)) problems.push(`variant ${variant.id} contains executable or locator-like value at ${change.path}`);
      if (plan.analysisKind === 'policy-replay' && changesTargetIdentity(change.value)) {
        problems.push(`variant ${variant.id} would change target identity at ${change.path}`);
      }
      const domain = domains.get(change.path);
      if (domain && !domain.values.some(value => canonicalJson(value) === canonicalJson(change.value))) {
        problems.push(`variant ${variant.id} value is outside the approved domain for ${change.path}`);
      }
      const action = actionValue(change.value);
      if (action && !plan.authorization.authorizedActions.includes(action)) problems.push(`variant ${variant.id} names unauthorized action ${action}`);
      const label = labelValue(change.value);
      if (label && !plan.authorization.authorizedLabels.includes(label)) problems.push(`variant ${variant.id} names unauthorized label ${label}`);
      if (typeof change.value === 'number') {
        const list = precisionPaths.get(change.path) ?? [];
        list.push(change.value);
        precisionPaths.set(change.path, list);
        const bps = Math.round(change.value);
        if (Math.abs(change.value - bps) > 0 || bps % plan.privacy.summaryPrecisionBps !== 0) {
          problems.push(`variant ${variant.id} uses precision finer than the report policy at ${change.path}`);
        }
      }
    }
  }
  if (plan.probeControl.prohibitMembershipQueries) {
    for (const path of plan.allowedPaths) {
      if (/member|membership|exists|subject|user|account/i.test(path)) problems.push(`membership-style path ${path} is prohibited`);
    }
  }
  if (plan.privacy.differencing === 'deny') {
    for (const [path, values] of precisionPaths) {
      const unique = [...new Set(values)].sort((a, b) => a - b);
      if (unique.length > 2) problems.push(`path ${path} looks like repeated threshold probing`);
    }
  }
  if (problems.length) throw new SensitivityContractError(`sensitivity plan rejected: ${problems[0]}`, 'semantic', problems);
  return plan;
}

export function validateSensitivityReport(value: unknown): SensitivityReport {
  checkSensitivitySchema('report', value);
  const report = value as SensitivityReport;
  const { digest, ...payload } = report;
  const problems: string[] = [];
  if (sensitivityDigest(payload) !== digest) problems.push('report digest does not match its content');
  if (report.actionAuthorization !== 'not-authorized') problems.push('sensitivity report cannot authorize actions');
  if (report.semantics !== 'associative-sensitivity-not-causal') problems.push('sensitivity report cannot claim causal explanation');
  if (report.rows.some(row => row.inference === 'new-invocation' && !row.freshInvocationId)) problems.push('new invocations must name a fresh invocation ID');
  if (report.rows.some(row => row.changes.some(change => rawValueLeak(change as unknown as Record<string, unknown>)))) {
    problems.push('report changes must not contain raw values');
  }
  if (problems.length) throw new SensitivityContractError(`sensitivity report rejected: ${problems[0]}`, 'semantic', problems);
  return report;
}

// Binding changes are limited to acceptance policy and fallback routing below a single target;
// replacing a target, the target list or a whole evaluation could swap the executor.
function policyReplayPath(path: string): boolean {
  return path.startsWith('/ruleset/spec/rules/') || path === '/ruleset/spec/defaultOutcome'
    || path === '/ruleset/spec/failureOutcome' || path === '/ruleset/spec/conflict'
    || /^\/binding\/spec\/evaluations\/[^/]+\/(?:targets\/\d+\/acceptance|fallbackOn)(?:\/.*)?$/.test(path);
}

function forbiddenAuthorityPath(path: string): boolean {
  return /(?:^|\/)(model|requestedModel|credentialRef|credential|executor|permission|permissions|legalCandidates|subagent|adapter|adapterVersion)(?:$|\/)/i.test(path);
}

const TARGET_IDENTITY_KEYS = new Set(['adapter', 'adapterVersion', 'model', 'requestedModel', 'subagent', 'credentialRef']);

function changesTargetIdentity(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(changesTargetIdentity);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => TARGET_IDENTITY_KEYS.has(key) || changesTargetIdentity(item));
  }
  return false;
}

function hasForbiddenPointerSegment(path: string): boolean {
  return path.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .some(part => part === '__proto__' || part === 'constructor' || part === 'prototype');
}

function looksExecutable(value: JsonValue): boolean {
  if (typeof value === 'string') return /(?:\$\{|=>|function\s*\(|require\s*\(|process\.env|https?:\/\/|bearer\s+|-----BEGIN|vault:|secret:)/i.test(value);
  if (Array.isArray(value)) return value.some(looksExecutable);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) =>
    /credential|secret|token|password|privateKey/i.test(key) || looksExecutable(item));
  return false;
}

function actionValue(value: JsonValue): string | null {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.action === 'string' ? value.action : null;
}

function labelValue(value: JsonValue): string | null {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.label === 'string' ? value.label : null;
}

function rawValueLeak(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, 'value') || Object.hasOwn(value, 'raw') || Object.hasOwn(value, 'state') || Object.hasOwn(value, 'prompt');
}
