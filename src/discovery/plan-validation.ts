import { z } from 'zod';
import { redactText } from '../governance/redaction.js';
import type { DiscoveryInventory } from './types.js';
import { SETUP_PLAN_SCHEMA_VERSION, type CredentialReference, type PlanValue, type SetupPlan } from './plan-types.js';

const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const observation = z.enum(['yes', 'no', 'unknown']);
export const planIdSchema = text.max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const referenceSchema = z.object({
  kind: z.literal('credential-ref'), source: z.enum(['env', 'file', 'stdin-at-apply']), name: text,
}).strict() satisfies z.ZodType<CredentialReference>;
const valueSchema: z.ZodType<PlanValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(valueSchema), z.record(valueSchema),
]));
const projectSchema = z.object({
  root: text, sources: z.array(z.enum(['workspace', 'registry', 'selected'])),
  vcs: z.enum(['git', 'worktree', 'none', 'unknown']), layout: z.enum(['project', 'package', 'monorepo', 'ambiguous']),
  packageManifest: text.nullable(), workspacePatterns: z.array(z.string()), packageRoots: z.array(text),
  aiwg: z.object({ directory: z.boolean(), configFile: text.nullable(), contextFile: text.nullable() }).strict(),
  providerFiles: z.array(z.object({ provider: text, path: text, kind: z.enum(['config', 'context', 'artifacts']) }).strict()),
}).strict();
const toolSchema = z.object({
  executable: text, path: text.nullable(), installed: observation, configured: observation,
  authenticated: observation, qualified: observation, version: text.nullable(), evidence: z.array(z.string()),
}).strict();
const inventorySchema = z.object({
  projects: z.array(projectSchema), tools: z.array(toolSchema),
  diagnostics: z.array(z.object({
    code: z.enum(['depth-limit', 'entry-limit', 'time-limit', 'file-limit', 'inaccessible', 'invalid-metadata',
      'symlink-skipped', 'outside-root', 'ambiguous', 'excluded', 'home-scan-refused']),
    path: z.string(), message: z.string(),
  }).strict()),
  limits: z.object({ maxDepth: z.number().nonnegative(), maxEntries: z.number().nonnegative(),
    timeBudgetMs: z.number().nonnegative(), maxFileBytes: z.number().nonnegative() }).strict(),
  stats: z.object({ entriesInspected: z.number().nonnegative(), elapsedMs: z.number().nonnegative(), truncated: z.boolean() }).strict(),
}).strict() satisfies z.ZodType<DiscoveryInventory>;
const factSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), root: text, field: projectSchema.keyof() }).strict(),
  z.object({ kind: z.literal('tool'), executable: text, field: toolSchema.keyof() }).strict(),
  z.object({ kind: z.literal('path'), workspace: text, path: text }).strict(),
]);
const planSchema = z.object({
  schemaVersion: z.literal(SETUP_PLAN_SCHEMA_VERSION), id: planIdSchema, inventoryId: text,
  createdAt: timestamp, updatedAt: timestamp,
  answers: z.record(z.object({ value: valueSchema,
    source: z.enum(['explicit-flag', 'existing-setting', 'interview', 'default', 'discovered']), answeredAt: timestamp }).strict()),
  recommendations: z.array(z.object({ questionId: text, value: valueSchema, reason: text }).strict()),
  unresolvedChoices: z.array(z.object({ questionId: text,
    options: z.array(z.object({ label: text, value: valueSchema }).strict()).min(1),
    default: valueSchema, whyItMatters: text, deferredAt: timestamp.optional() }).strict()),
  actions: z.array(z.object({ id: text, workspace: text, provider: text, scope: z.enum(['project', 'user']),
    kind: text, dependsOn: z.array(factSchema) }).strict()),
  receipts: z.array(z.object({ workspace: text, actions: z.record(z.object({
    status: z.enum(['applied', 'failed', 'skipped']), startedAt: timestamp, completedAt: timestamp,
    message: z.string().optional(),
  }).strict()) }).strict()),
  inventory: inventorySchema,
}).strict() satisfies z.ZodType<SetupPlan>;

const sensitiveKey = /(?:password|passwd|token|secret|api[_-]?key|credential|authorization|cookie|private[_-]?key|connection[_-]?string)/i;
const secretError = () => new Error('Setup plan contains secret-looking material; use a credential-ref (env, file, or stdin-at-apply).');

/** Scan the exact JSON snapshot, including keys and free-form evidence/messages. Never echo rejected values. */
export function assertPlanRedacted(input: unknown): void {
  let nodes = 0;
  const scanText = (value: string): void => {
    const result = redactText(value, { organizationPatterns: [
      { id: 'jwt', pattern: '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{8,}\\b' },
      { id: 'extra-token', pattern: '\\b(?:aiwg_(?:at|rt)_|npm_|hf_|xai-|AIza)[A-Za-z0-9_-]{8,}\\b' },
    ] });
    if (result.sensitivity !== 'none') throw secretError();
    // Scan disjoint runs rather than retrying lookaheads at every word boundary.
    for (const candidate of value.match(/[A-Za-z0-9_+=-]{32,}/g) ?? []) {
      if (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /[0-9]/.test(candidate)) throw secretError();
    }
  };
  const isReference = (value: unknown): boolean => referenceSchema.safeParse(value).success;
  const visit = (value: unknown, depth: number, answerMap = false): void => {
    if (++nodes > 100_000 || depth > 64) throw new Error('Setup plan exceeds redaction structure limits.');
    if (typeof value === 'string') scanText(value);
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const object = value as Record<string, unknown>;
    if (object.kind === 'credential-ref' && !isReference(object)) throw secretError();
    // Answers and recommendations can carry sensitive question IDs as data.
    if (typeof object.questionId === 'string' && sensitiveKey.test(object.questionId)) {
      const values = [object.value, object.default,
        ...(Array.isArray(object.options) ? object.options.map(option => (option as Record<string, unknown>)?.value) : [])];
      if (values.some(candidate => candidate !== undefined && candidate !== null && !isReference(candidate))) throw secretError();
    }
    for (const [key, child] of Object.entries(object)) {
      scanText(key);
      if (sensitiveKey.test(key) && child !== null && child !== undefined && !isReference(child)) {
        // A sensitive answer ID may wrap a reference with source/timestamp metadata.
        const answer = child && typeof child === 'object' ? child as Record<string, unknown> : null;
        if (!answerMap || !answer || !Object.hasOwn(answer, 'value') ||
          (answer.value !== null && !isReference(answer.value))) throw secretError();
      }
      visit(child, depth + 1, depth === 0 && key === 'answers');
    }
  };
  visit(input, 0);
}

export function validateSetupPlan(input: unknown): SetupPlan {
  assertPlanRedacted(input);
  const parsed = planSchema.safeParse(input);
  // Zod errors can include credential-bearing keys/values: keep diagnostics structural.
  if (!parsed.success) throw new Error('Invalid setup plan v1 shape; check required fields, timestamps, and action dependencies.');
  const plan = parsed.data;
  const ids = new Set(plan.actions.map(action => action.id));
  if (ids.size !== plan.actions.length) throw new Error('Setup plan action IDs must be unique.');
  if (new Set(plan.receipts.map(receipt => receipt.workspace)).size !== plan.receipts.length) {
    throw new Error('Setup plan workspace receipts must be unique.');
  }
  for (const receipt of plan.receipts) for (const [id, result] of Object.entries(receipt.actions)) {
    if (!plan.actions.some(action => action.id === id && action.workspace === receipt.workspace)) {
      throw new Error('Setup plan receipt must refer to an action in the same workspace.');
    }
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) throw new Error('Setup plan receipt timestamps are out of order.');
  }
  if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) throw new Error('Setup plan timestamps are out of order.');
  return plan;
}
