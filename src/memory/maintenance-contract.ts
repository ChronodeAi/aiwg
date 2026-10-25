import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { indexMemoryAliases, MemoryDigestSchema, type MemoryRecord } from './maintenance-record.js';
import { MemoryLifecycleSchema, MemoryPlacementSchema, MemoryScopeSchema } from './taxonomy.js';

export const MaintenanceOpSchema = z.enum([
  'promote', 'demote', 'recategorize', 'merge', 'split', 'supersede', 'retire', 'restore',
]);
const VersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const TargetSchema = z.object({ id: z.string().min(1), digest: MemoryDigestSchema, version: VersionSchema }).strict();
const StateSchema = z.object({ placement: MemoryPlacementSchema, lifecycle: MemoryLifecycleSchema }).strict();
export const MaintenanceOperationSchema = z.object({
  op: MaintenanceOpSchema,
  target: TargetSchema,
  related: z.array(TargetSchema).optional(),
  owner: z.object({ name: z.string().min(1), handle: z.string().min(1), snapshot: MemoryDigestSchema }).strict().optional(),
  review: z.object({ reviewer: z.string().min(1), retirementBasis: z.enum(['age', 'review']) }).strict().optional(),
  category: z.string().min(1).optional(),
  replacements: z.array(z.object({ key: z.string().min(1), value: z.string().min(1), sourcePath: z.string().min(1).optional(), category: z.string().min(1).optional() }).strict()).optional(),
  from: StateSchema,
  to: StateSchema,
  scope: MemoryScopeSchema,
  rationale: z.string().min(1),
  uncertainty: z.string().min(1),
  impactedLinks: z.array(z.string().min(1)),
  sessionEffect: z.enum(['current', 'next-session']),
  precondition: z.object({ digest: MemoryDigestSchema, version: VersionSchema }).strict(),
}).strict().superRefine((operation, context) => {
  if (operation.from.placement !== operation.to.placement && operation.from.lifecycle !== operation.to.lifecycle) {
    context.addIssue({ code: 'custom', message: 'An operation cannot implicitly change a second axis' });
  }
  if (operation.target.digest !== operation.precondition.digest || operation.target.version !== operation.precondition.version) {
    context.addIssue({ code: 'custom', message: 'Target and precondition must identify the same revision' });
  }
  const lineage = ['merge', 'split', 'supersede'].includes(operation.op);
  if (!lineage && (operation.related?.length || operation.replacements?.length)) {
    context.addIssue({ code: 'custom', message: 'Only lineage operations accept replacements or related inputs' });
  }
  if (operation.replacements && ((['merge', 'supersede'].includes(operation.op) && operation.replacements.length !== 1)
    || (operation.op === 'split' && operation.replacements.length < 2))) {
    context.addIssue({ code: 'custom', message: 'Lineage operation requires the exact replacement count' });
  }
  if (operation.related?.length && operation.op !== 'merge') context.addIssue({ code: 'custom', message: 'Only merge accepts related inputs' });
  if (['promote', 'demote', 'recategorize'].includes(operation.op) && operation.from.lifecycle !== operation.to.lifecycle) {
    context.addIssue({ code: 'custom', message: 'Placement and category operations cannot change lifecycle' });
  }
  if (!['promote', 'demote'].includes(operation.op) && operation.from.placement !== operation.to.placement) {
    context.addIssue({ code: 'custom', message: 'Lifecycle and category operations cannot change placement' });
  }
  const rank = { archived: 0, indexed: 1, 'task-context': 2, resident: 3 };
  if ((operation.op === 'promote' && rank[operation.to.placement] <= rank[operation.from.placement])
    || (operation.op === 'demote' && rank[operation.to.placement] >= rank[operation.from.placement])) {
    context.addIssue({ code: 'custom', message: 'Promotion or demotion must move in the requested placement direction' });
  }
  if (lineage && (operation.from.lifecycle !== 'active' || operation.to.lifecycle !== 'superseded')) {
    context.addIssue({ code: 'custom', message: 'Lineage operations supersede active originals' });
  }
  if (operation.from.lifecycle === 'purged') context.addIssue({ code: 'custom', message: 'Purged sources cannot be maintained' });
  if (operation.to.lifecycle === 'purged') {
    context.addIssue({ code: 'custom', message: 'Maintenance cannot purge sources' });
  }
});

export const MaintenancePlanSchema = z.object({
  schemaVersion: z.literal('aiwg.maintenance-plan.v1'),
  operations: z.array(MaintenanceOperationSchema),
}).strict();
export const ProviderCopiesSchema = z.object({
  status: z.enum(['current', 'stale', 'not-applicable']),
  regenerate: z.literal('aiwg regenerate --workspace --provider generic'),
}).strict();
export type ProviderCopies = z.infer<typeof ProviderCopiesSchema>;

export const MaintenanceReceiptSchema = z.object({
  schemaVersion: z.literal('aiwg.maintenance-receipt.v1'),
  planDigest: MemoryDigestSchema,
  ownerReceipts: z.array(z.unknown()),
  partial: z.object({ completed: z.array(z.string().min(1)), pending: z.array(z.string().min(1)) }).strict().optional(),
  resumedFrom: z.string().min(1).optional(),
  providerCopies: ProviderCopiesSchema.optional(),
}).strict();

export type MaintenanceOp = z.infer<typeof MaintenanceOpSchema>;
export type MaintenanceOperation = z.infer<typeof MaintenanceOperationSchema>;
export type MaintenancePlan = z.infer<typeof MaintenancePlanSchema>;
export type MaintenanceReceipt = z.infer<typeof MaintenanceReceiptSchema>;

/** Validate a preview against current owner metadata. Does not apply, retire or restore anything.
 * Retirement defaults to age eligibility; explicit review policy is supplied by the caller.
 */
export function validateMaintenancePlan(
  input: unknown,
  records: readonly MemoryRecord[],
  policy: { retirementBasis: 'age' | 'review' } = { retirementBasis: 'age' },
): MaintenancePlan {
  const plan = MaintenancePlanSchema.parse(input);
  const index = indexMemoryAliases(records);
  const targets = new Set<string>();
  for (const operation of plan.operations) {
    const record = index.get(operation.target.id);
    if (!record) throw new Error('Maintenance target is missing');
    if (targets.has(record.id)) throw new Error('Multiple operations require separate revision previews for the same target');
    targets.add(record.id);
    if (operation.precondition.digest !== record.digest || operation.precondition.version !== record.version) {
      throw new Error('Stale memory digest or version precondition');
    }
    if (record.version >= Number.MAX_SAFE_INTEGER) throw new Error('Maintenance revision is exhausted');
    if (operation.scope !== record.scope) throw new Error('Maintenance cannot implicitly change scope');
    if (operation.from.placement !== record.placement || operation.from.lifecycle !== record.lifecycle) {
      throw new Error('Stale memory placement or lifecycle precondition');
    }
    if (policy.retirementBasis === 'age' && record.authority.protection === 'pinned'
      && (operation.op === 'retire' || operation.to.lifecycle === 'retired')) {
      throw new Error('Pinned rare obligations cannot be retired by age');
    }
    if (operation.op === 'retire' && operation.to.lifecycle !== 'retired') throw new Error('Retire requires retired lifecycle');
    if (operation.op === 'supersede' && operation.to.lifecycle !== 'superseded') throw new Error('Supersede requires superseded lifecycle');
    if (operation.op === 'restore' && operation.to.lifecycle !== 'active') throw new Error('Restore requires active lifecycle');
  }
  for (const operation of plan.operations) {
    for (const input of operation.related ?? []) {
      const record = index.get(input.id);
      const target = index.get(operation.target.id)!;
      if (!record) throw new Error('Related maintenance target is missing');
      if (targets.has(record.id)) throw new Error('Multiple operations overlap a maintenance target');
      targets.add(record.id);
      if (input.digest !== record.digest || input.version !== record.version) throw new Error('Stale related digest or version precondition');
      if (record.scope !== target.scope || !isDeepStrictEqual(record.authority, target.authority)) {
        throw new Error('Merge cannot implicitly change scope or authority');
      }
      if (record.lifecycle !== 'active') throw new Error('Merge inputs must be active');
    }
  }
  return plan;
}
