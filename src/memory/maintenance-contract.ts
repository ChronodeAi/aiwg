import { z } from 'zod';
import { indexMemoryAliases, MemoryDigestSchema, type MemoryRecord } from './maintenance-record.js';
import { MemoryLifecycleSchema, MemoryPlacementSchema, MemoryScopeSchema } from './taxonomy.js';

export const MaintenanceOpSchema = z.enum([
  'promote', 'demote', 'recategorize', 'merge', 'split', 'supersede', 'retire', 'restore',
]);
const VersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const StateSchema = z.object({ placement: MemoryPlacementSchema, lifecycle: MemoryLifecycleSchema }).strict();
export const MaintenanceOperationSchema = z.object({
  op: MaintenanceOpSchema,
  target: z.object({ id: z.string().min(1), digest: MemoryDigestSchema, version: VersionSchema }).strict(),
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
  if (operation.to.lifecycle === 'purged') {
    context.addIssue({ code: 'custom', message: 'Maintenance cannot purge sources' });
  }
});

export const MaintenancePlanSchema = z.object({
  schemaVersion: z.literal('aiwg.maintenance-plan.v1'),
  operations: z.array(MaintenanceOperationSchema),
}).strict();
export const MaintenanceReceiptSchema = z.object({
  schemaVersion: z.literal('aiwg.maintenance-receipt.v1'),
  planDigest: MemoryDigestSchema,
  ownerReceipts: z.array(z.unknown()),
  partial: z.object({ completed: z.array(z.string().min(1)), pending: z.array(z.string().min(1)) }).strict().optional(),
  resumedFrom: z.string().min(1).optional(),
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
  return plan;
}
