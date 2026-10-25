import { z } from 'zod';
import { load } from 'js-yaml';
import type { MemoryIntakeReceipt } from './intake.js';
import { sha256 } from './context-pack.js';
import { MemoryLifecycleSchema, MemoryTaxonomySchema } from './taxonomy.js';

export const MemoryDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const HandleSchema = z.string().min(1);
const HandlesSchema = z.array(HandleSchema).refine(values => new Set(values).size === values.length, 'Duplicate handles');

export const MemoryTombstoneSchema = z.object({
  id: HandleSchema,
  digest: MemoryDigestSchema,
  disposition: MemoryLifecycleSchema.exclude(['active']),
  reason: z.string().min(1),
  reviewer: z.string().min(1),
  at: z.string().datetime(),
  successor: HandleSchema.optional(),
}).strict();

export const MemoryRecordSchema = MemoryTaxonomySchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal('aiwg.memory-record.v1'),
  id: MemoryDigestSchema,
  sourcePath: z.string().min(1).refine(value => !/[\r\n\0]/.test(value)),
  digest: MemoryDigestSchema,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  aliases: HandlesSchema,
  supersedes: HandlesSchema,
  mergedFrom: HandlesSchema,
  splitFrom: HandlesSchema,
  sourceWorkspaceId: HandleSchema.optional(),
  tombstone: MemoryTombstoneSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.lifecycle === 'retired' && !record.tombstone) {
    context.addIssue({ code: 'custom', message: 'Retired memory requires an owner tombstone', path: ['tombstone'] });
  }
});

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
export type MemoryTombstone = z.infer<typeof MemoryTombstoneSchema>;

/** Locator spelling is significant. Compatibility spellings belong in aliases. */
export function memoryRecordId(sourcePath: string, digest: string): string {
  MemoryDigestSchema.parse(digest);
  return sha256(JSON.stringify({ sourcePath, digest }));
}

/** Refuse unknown versions rather than silently assigning current semantics. */
export function loadMemoryRecord(input: unknown): MemoryRecord {
  const record = MemoryRecordSchema.parse(input);
  if (record.id !== memoryRecordId(record.sourcePath, record.digest)) {
    throw new Error('Memory record identity does not match locator and digest');
  }
  if (record.aliases.includes(record.id)) throw new Error('Memory record cannot alias itself');
  if (record.tombstone && (record.tombstone.id !== record.id || record.tombstone.digest !== record.digest
    || record.tombstone.disposition !== record.lifecycle)) {
    throw new Error('Memory tombstone must match its record identity and lifecycle');
  }
  return record;
}

export function indexMemoryAliases(records: readonly MemoryRecord[]): ReadonlyMap<string, MemoryRecord> {
  const index = new Map<string, MemoryRecord>();
  const parsed = records.map(loadMemoryRecord);
  const canonicalIds = new Set<string>();
  for (const record of parsed) {
    if (index.has(record.id)) throw new Error(`Memory alias collision: ${record.id}`);
    index.set(record.id, record);
    canonicalIds.add(record.id);
  }
  for (const record of parsed) {
    for (const handle of record.aliases) {
      const prior = index.get(handle);
      if (prior) {
        // Prior IDs may be compatibility aliases on successors, but an exact
        // canonical ID must still address its immutable retained history.
        const lineage = [...record.supersedes, ...record.mergedFrom, ...record.splitFrom];
        if (canonicalIds.has(handle) && lineage.includes(handle)) continue;
        throw new Error(`Memory alias collision: ${handle}`);
      }
      index.set(handle, record);
    }
  }
  return index;
}

/** Explicit metadata projection from the existing intake v1 receipt; no owner data is rewritten. */
export function memoryRecordFromIntake(
  receipt: MemoryIntakeReceipt,
  owner: string,
): MemoryRecord {
  if (receipt.schemaVersion !== 'aiwg.compound-memory.intake-receipt.v1') {
    throw new Error('Unsupported memory intake receipt version');
  }
  return loadMemoryRecord({
    schemaVersion: 'aiwg.memory-record.v1',
    id: memoryRecordId(receipt.sourceLocator, receipt.sourceDigest),
    sourcePath: receipt.sourceLocator,
    digest: receipt.sourceDigest,
    version: 1,
    aliases: [receipt.receiptId],
    supersedes: [], mergedFrom: [], splitFrom: [],
    scope: 'project', placement: 'indexed', lifecycle: 'active',
    authority: { owner, source: 'import', protection: 'unprotected' },
    observation: {
      status: 'on-disk',
      evidence: { source: receipt.receiptId, at: receipt.registeredAt, session: null, provider: null, version: null },
    },
  });
}

/** Validate supplied include edges only. Discovery and file loading belong to the audit owner. */
export function detectMemoryIncludeCycles(graph: Readonly<Record<string, readonly string[]>>): string[][] {
  const done = new Set<string>();
  const stack: string[] = [];
  const active = new Map<string, number>();
  const cycles: string[][] = [];
  function visit(locator: string): void {
    const position = active.get(locator);
    if (position !== undefined) {
      cycles.push([...stack.slice(position), locator]);
      return;
    }
    if (done.has(locator)) return;
    active.set(locator, stack.length);
    stack.push(locator);
    for (const included of Object.hasOwn(graph, locator) ? graph[locator] : []) visit(included);
    stack.pop();
    active.delete(locator);
    done.add(locator);
  }
  for (const locator of Object.keys(graph).sort()) visit(locator);
  return cycles;
}

/** Shared canonical Markdown parsing for inventory and the existing artifact owner. */
export function parseMemoryMarkdown(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  const data = load(match[1]) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Memory source frontmatter must be an object');
  return { data: data as Record<string, unknown>, body: match[2] };
}
