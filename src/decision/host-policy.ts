import type { DecisionEvaluationRequest } from './types.js';

const HOST_POLICY_KEYS = [
  'batching',
  'batchReceipts',
  'context',
  'scheduler',
  'compileCache',
  'resultCache',
  'providerPrefix',
] as const;

export type DecisionHostPolicyKey = typeof HOST_POLICY_KEYS[number];
export type DecisionHostPolicyRefs = Partial<Record<DecisionHostPolicyKey, string>>;
export type DecisionHostPolicyRegistry = {
  [K in DecisionHostPolicyKey]?: Record<string, NonNullable<DecisionEvaluationRequest[K]>>
};
export type DecisionHostPolicyResolution = Pick<DecisionEvaluationRequest, DecisionHostPolicyKey>;

const KEY_SET = new Set<string>(HOST_POLICY_KEYS);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertDecisionHostPolicyRefs(value: unknown): asserts value is DecisionHostPolicyRefs {
  if (!isRecord(value)) throw new Error('hostPolicies must be an object of named trusted host-policy references');
  for (const [key, ref] of Object.entries(value)) {
    if (!KEY_SET.has(key)) throw new Error(`Unsupported decision host policy '${key}'. Supported policies: ${HOST_POLICY_KEYS.join(', ')}`);
    if (typeof ref !== 'string' || !ref.trim()) throw new Error(`hostPolicies.${key} must name a trusted host policy`);
  }
}

export function resolveDecisionHostPolicies(refs: unknown, registry: DecisionHostPolicyRegistry = {}): Partial<DecisionHostPolicyResolution> {
  if (refs === undefined) return {};
  assertDecisionHostPolicyRefs(refs);
  const resolved: Partial<DecisionHostPolicyResolution> = {};
  for (const [key, ref] of Object.entries(refs) as Array<[DecisionHostPolicyKey, string]>) {
    const group = hasOwn(registry, key) ? registry[key] : undefined;
    const policy = group && hasOwn(group, ref) ? group[ref] : undefined;
    if (!policy) throw new Error(`Unknown trusted decision host policy '${key}:${ref}'`);
    (resolved as Record<DecisionHostPolicyKey, unknown>)[key] = policy;
  }
  return resolved;
}

export function assertNoInlineDecisionHostPolicies(config: Record<string, unknown>): void {
  for (const key of HOST_POLICY_KEYS) {
    if (key in config) throw new Error(`Unsupported inline decision runtime option '${key}'. Use hostPolicies.${key} to select a trusted host policy`);
  }
}

export function assertDecisionEvaluateDispatcherConfig(config: unknown): asserts config is Record<string, unknown> {
  if (!isRecord(config)) throw new Error('decision-evaluate request must be a JSON object');
  assertNoInlineDecisionHostPolicies(config);
  const allowed = new Set([
    'rulesetPath', 'bindingPath', 'definitionPaths', 'inputPath', 'runId', 'invocationId',
    'receiptDirectory', 'receiptIntegrityKeyRef', 'receiptIntegrityKeyEncoding',
    'credentials', 'adapterOptions', 'adapterModules', 'projectionPolicyPath', 'hostPolicies',
  ]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new Error(`Unsupported decision-evaluate request field '${key}'`);
  }
  if ('hostPolicies' in config) assertDecisionHostPolicyRefs(config.hostPolicies);
}
