import { z } from 'zod';
import { dateTime } from '../schema/zod-validation.mjs';

export const MemoryScopeSchema = z.enum(['global', 'project', 'provider-native', 'loaded/session']);
export const MemoryPlacementSchema = z.enum(['resident', 'indexed', 'task-context', 'archived']);
export const MemoryLifecycleSchema = z.enum(['active', 'superseded', 'retired', 'quarantined', 'purged']);
export const MemoryAuthoritySchema = z.strictObject({
  owner: z.string().min(1),
  source: z.enum(['operator', 'reviewer', 'import', 'generated-output-proposed']),
  protection: z.enum(['pinned', 'unprotected']),
});
export const MemoryObservationSchema = z.strictObject({
  status: z.enum(['observed', 'inferred', 'on-disk', 'absent', 'inaccessible', 'opaque', 'unknown']),
  evidence: z.strictObject({
    source: z.string().min(1),
    at: dateTime(),
    session: z.string().min(1).nullable(),
    provider: z.string().min(1).nullable(),
    version: z.string().min(1).nullable(),
  }),
}).superRefine((observation, context) => {
  if (observation.status === 'observed'
    && (!observation.evidence.session || !observation.evidence.provider || !observation.evidence.version)) {
    context.addIssue({ code: 'custom', message: 'Observed live context requires session, provider and version evidence' });
  }
});

export const MemoryTaxonomySchema = z.strictObject({
  schemaVersion: z.literal('aiwg.memory-taxonomy.v1'),
  scope: MemoryScopeSchema,
  placement: MemoryPlacementSchema,
  lifecycle: MemoryLifecycleSchema,
  authority: MemoryAuthoritySchema,
  observation: MemoryObservationSchema,
});

export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type MemoryPlacement = z.infer<typeof MemoryPlacementSchema>;
export type MemoryLifecycle = z.infer<typeof MemoryLifecycleSchema>;
export type MemoryAuthority = z.infer<typeof MemoryAuthoritySchema>;
export type MemoryObservation = z.infer<typeof MemoryObservationSchema>;
export type MemoryTaxonomy = z.infer<typeof MemoryTaxonomySchema>;
export type MemoryAxes = Pick<MemoryTaxonomy, 'scope' | 'placement' | 'lifecycle' | 'authority'>;

/** A taxonomy transition changes exactly the selected axis; it grants no mutation authority. */
export function transitionMemoryAxis<T extends MemoryAxes, K extends keyof MemoryAxes>(
  item: T, axis: K, value: MemoryAxes[K],
): T {
  const schemas = {
    scope: MemoryScopeSchema,
    placement: MemoryPlacementSchema,
    lifecycle: MemoryLifecycleSchema,
    authority: MemoryAuthoritySchema,
  };
  return { ...item, [axis]: schemas[axis].parse(value) };
}
