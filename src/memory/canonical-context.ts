import {
  existsSync,
  mkdirSync,
  linkSync,
  statSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { validateMaintenancePlan, type MaintenanceOperation } from './maintenance-contract.js';
import { loadMemoryRecord, memoryRecordId, type MemoryRecord } from './maintenance-record.js';

export type CanonicalMaintenanceMetadata = Pick<MemoryRecord,
  'version' | 'scope' | 'placement' | 'lifecycle' | 'authority' | 'aliases'
  | 'supersedes' | 'mergedFrom' | 'splitFrom' | 'tombstone'> & {
    category?: string;
    history?: Array<{ record: MemoryRecord; disposition: CanonicalContextEntry['disposition']; recordedAt: string; category?: string }>;
  };


const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const LocatorSchema = z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value));
export const CanonicalContextTargetSchema = z.enum([
  'project-fact', 'preference', 'goal', 'project', 'person', 'decision', 'operating-rule',
]);
export const CanonicalContextClassificationSchema = z.enum(['public', 'internal']);

export const CanonicalContextProposalSchema = z.object({
  target: CanonicalContextTargetSchema,
  key: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
  value: z.string().min(1).max(8192),
  sourceRef: LocatorSchema,
  sourceDigest: DigestSchema.nullable().default(null),
  reviewer: z.string().min(1).max(128),
  reason: z.string().min(1).max(1024),
  scope: z.string().min(1).max(128),
  classification: CanonicalContextClassificationSchema,
  reviewAt: z.string().datetime().nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
}).strict();

export type CanonicalContextProposal = z.infer<typeof CanonicalContextProposalSchema>;

export interface CanonicalContextEntry extends CanonicalContextProposal {
  entryId: string;
  status: 'active' | 'superseded' | 'revoked';
  createdAt: string;
  updatedAt: string;
  supersedes: string | null;
  disposition: { reviewer: string; reason: string; recordedAt: string } | null;
  importedFromWorkspace: string | null;
  maintenance?: CanonicalMaintenanceMetadata;
}

export interface CanonicalContextStore {
  schemaVersion: 'aiwg.canonical-context.v1';
  workspaceId: string;
  revision: number;
  entries: Record<string, CanonicalContextEntry>;
  maintenanceReceipts?: Record<string, CanonicalContextReceipt>;
}

export interface CanonicalContextPreview {
  schemaVersion: 'aiwg.canonical-context-preview.v1';
  operationId: string;
  operation: 'upsert' | 'revoke' | 'import' | 'maintenance';
  workspaceId: string;
  storeDigest: string;
  duplicate: boolean;
  confirmationRequired: true;
  diff: Array<{ field: string; before: string | null; after: string | null }>;
  conflicts: Array<{ entryId: string; valueDigest: string }>;
  proposedEntryId: string | null;
  importCount: number;
}

export interface CanonicalContextReceipt {
  schemaVersion: 'aiwg.canonical-context-receipt.v1';
  receiptId: string;
  operationId: string;
  operation: CanonicalContextPreview['operation'];
  workspaceId: string;
  entryIds: string[];
  revision: number;
  duplicate: boolean;
  completedAt: string;
}

export interface CanonicalContextExport {
  schemaVersion: 'aiwg.canonical-context-export.v1';
  sourceWorkspaceId: string;
  exportedAt: string;
  entries: CanonicalContextEntry[];
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalLocator(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
  } catch {
    // Opaque locator.
  }
  return value;
}

function assertSafeProposal(proposal: CanonicalContextProposal): void {
  const content = `${proposal.key}\n${proposal.value}\n${proposal.sourceRef}`;
  if (/(?:ignore|disregard) (?:all |the )?(?:previous|prior) instructions|system prompt|developer message|(?:run|execute) (?:a )?(?:shell|command)/i.test(content)) {
    throw new Error('canonical context proposal contains instruction-like material');
  }
  if (/(?:^|[?&;:\s])(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)\s*[:=]\s*[^\s&;]+/i.test(content)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    throw new Error('canonical context proposal contains unsafe material');
  }
  if (/^(?:system|developer|provider|agent)(?:\.|$)/.test(proposal.key)) {
    throw new Error('canonical context cannot override a higher-authority namespace');
  }
}

function ensureStorageInsideProject(projectRoot: string, target: string): void {
  const root = realpathSync(projectRoot);
  const lexicalRoot = resolve(projectRoot);
  const candidate = resolve(target);
  if (candidate !== lexicalRoot && !candidate.startsWith(`${lexicalRoot}${sep}`)) {
    throw new Error('canonical context storage must remain inside the project');
  }
  let ancestor = candidate;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    throw new Error('canonical context storage cannot traverse a link outside the project');
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, filePath);
}

function workspaceIdentity(projectRoot: string): string {
  const root = realpathSync(projectRoot);
  return sha256(relative(dirname(root), root));
}

function stableEntryId(proposal: CanonicalContextProposal): string {
  return sha256(JSON.stringify({
    target: proposal.target,
    key: proposal.key,
    value: proposal.value,
    sourceRef: proposal.sourceRef,
    sourceDigest: proposal.sourceDigest,
    scope: proposal.scope,
    classification: proposal.classification,
  }));
}

function proposalFromEntry(entry: CanonicalContextEntry): CanonicalContextProposal {
  return CanonicalContextProposalSchema.parse({
    target: entry.target,
    key: entry.key,
    value: entry.value,
    sourceRef: entry.sourceRef,
    sourceDigest: entry.sourceDigest,
    reviewer: entry.reviewer,
    reason: entry.reason,
    scope: entry.scope,
    classification: entry.classification,
    reviewAt: entry.reviewAt,
    expiresAt: entry.expiresAt,
  });
}

function storeDigest(store: CanonicalContextStore): string {
  return sha256(JSON.stringify(store));
}

/** Project the canonical owner data without creating a second record store. */
export function canonicalMemoryRecord(entry: CanonicalContextEntry): MemoryRecord {
  const sourcePath = `.aiwg/context/compound-memory/context.json#${entry.entryId}`;
  const digest = sha256(entry.value);
  const id = memoryRecordId(sourcePath, digest);
  const lifecycle = entry.maintenance?.lifecycle
    ?? (entry.status === 'revoked' ? 'retired' : entry.status);
  const tombstone = lifecycle === 'active' ? undefined : entry.maintenance?.tombstone ?? {
    id, digest, disposition: lifecycle,
    reason: entry.disposition?.reason ?? entry.reason,
    reviewer: entry.disposition?.reviewer ?? entry.reviewer,
    at: entry.disposition?.recordedAt ?? entry.updatedAt,
  };
  return loadMemoryRecord({
    schemaVersion: 'aiwg.memory-record.v1', id, sourcePath, digest,
    version: entry.maintenance?.version ?? 1,
    aliases: [...new Set([entry.entryId, ...(entry.maintenance?.aliases ?? [])])],
    supersedes: entry.maintenance?.supersedes ?? [],
    mergedFrom: entry.maintenance?.mergedFrom ?? [],
    splitFrom: entry.maintenance?.splitFrom ?? [],
    scope: entry.maintenance?.scope ?? 'project',
    placement: entry.maintenance?.placement ?? 'resident', lifecycle,
    authority: entry.maintenance?.authority ?? {
      owner: 'compound-memory', source: 'reviewer', protection: 'unprotected',
    },
    observation: {
      status: 'on-disk', evidence: {
        source: sourcePath, at: entry.updatedAt, session: null, provider: null, version: null,
      },
    },
    ...(entry.importedFromWorkspace ? { sourceWorkspaceId: entry.importedFromWorkspace } : {}),
    ...(tombstone ? { tombstone } : {}),
  });
}

function maintenanceMetadata(
  record: MemoryRecord, category?: string, prior?: CanonicalContextEntry, recordedAt?: string,
): CanonicalMaintenanceMetadata {
  const { version, scope, placement, lifecycle, authority, aliases, supersedes, mergedFrom, splitFrom, tombstone } = record;
  return { version, scope, placement, lifecycle, authority, aliases, supersedes, mergedFrom, splitFrom,
    ...(tombstone ? { tombstone } : {}), ...(category ? { category } : {}),
    ...(prior ? { history: [...(prior.maintenance?.history ?? []), {
      record: canonicalMemoryRecord(prior), disposition: prior.disposition,
      recordedAt: recordedAt ?? prior.updatedAt,
      ...(prior.maintenance?.category ? { category: prior.maintenance.category } : {}),
    }] } : {}),
  };
}

export class CanonicalContextRepository {
  private readonly root: string;
  private readonly statePath: string;
  private readonly receiptRoot: string;
  private readonly lockPath: string;
  readonly workspaceId: string;

  constructor(projectRoot: string) {
    this.root = resolve(projectRoot, '.aiwg/context/compound-memory');
    this.statePath = resolve(this.root, 'context.json');
    this.receiptRoot = resolve(this.root, 'receipts');
    this.lockPath = resolve(this.root, '.lock');
    ensureStorageInsideProject(projectRoot, this.root);
    this.workspaceId = workspaceIdentity(projectRoot);
  }

  read(): CanonicalContextStore {
    if (!existsSync(this.statePath)) {
      return {
        schemaVersion: 'aiwg.canonical-context.v1',
        workspaceId: this.workspaceId,
        revision: 0,
        entries: {},
      };
    }
    const store = JSON.parse(readFileSync(this.statePath, 'utf8')) as CanonicalContextStore;
    if (store.schemaVersion !== 'aiwg.canonical-context.v1'
      || store.workspaceId !== this.workspaceId
      || !Number.isSafeInteger(store.revision)
      || typeof store.entries !== 'object'
      || Array.isArray(store.entries)) {
      throw new Error('canonical context store identity or schema is invalid');
    }
    return store;
  }

  snapshot(): string { return storeDigest(this.read()); }

  /** Input to regenerated resident context. History remains available through export(). */
  residentEntries(): CanonicalContextEntry[] {
    return Object.values(this.read().entries).filter(entry => {
      const record = canonicalMemoryRecord(entry);
      return record.lifecycle === 'active' && record.placement === 'resident';
    });
  }

  maintenanceReceipt(key: string, operation?: MaintenanceOperation): CanonicalContextReceipt | undefined {
    const receipt = this.read().maintenanceReceipts?.[key];
    if (receipt && operation && receipt.operationId !== sha256(JSON.stringify({ operation, snapshot: operation.owner?.snapshot }))) {
      throw new Error('Maintenance receipt key conflicts with another operation');
    }
    return receipt;
  }

  previewMaintenance(operation: MaintenanceOperation): CanonicalContextPreview {
    const store = this.read();
    if (!operation.owner || operation.owner.name !== 'compound-memory' || !operation.review) {
      throw new Error('Canonical maintenance requires an owner binding and explicit review');
    }
    if (operation.owner.snapshot !== storeDigest(store)) throw new Error('Stale canonical owner snapshot');
    const entry = store.entries[operation.owner.handle];
    if (!entry) throw new Error('Canonical maintenance entry was not found');
    const record = canonicalMemoryRecord(entry);
    if (record.authority.owner !== 'compound-memory') throw new Error('Canonical maintenance cannot mutate another authority owner');
    if (operation.target.id !== record.id && !record.aliases.includes(operation.target.id)) {
      throw new Error('Canonical maintenance target does not match its owner handle');
    }
    validateMaintenancePlan({ schemaVersion: 'aiwg.maintenance-plan.v1', operations: [operation] },
      Object.values(store.entries).map(canonicalMemoryRecord), { retirementBasis: operation.review.retirementBasis });
    if (operation.sessionEffect !== 'next-session') {
      throw new Error('Canonical maintenance can only promise next-session effect');
    }
    if (operation.op !== 'merge' && operation.related?.length) throw new Error('Only merge may bind additional sources');
    if (operation.op === 'restore' && (record.lifecycle === 'active'
      || Object.values(store.entries).some(candidate => candidate.entryId !== entry.entryId
        && candidate.target === entry.target && candidate.key === entry.key && candidate.status === 'active'))) {
      throw new Error('Restore requires inactive history without an active conflicting entry');
    }
    if (operation.op === 'recategorize' && !operation.category) throw new Error('Recategorize requires category');
    if (operation.op === 'promote' || operation.op === 'demote') {
      const ranks = { archived: 0, indexed: 1, 'task-context': 2, resident: 3 };
      const direction = ranks[operation.to.placement] - ranks[operation.from.placement];
      if ((operation.op === 'promote' && direction <= 0) || (operation.op === 'demote' && direction >= 0)
        || operation.to.lifecycle !== operation.from.lifecycle) {
        throw new Error('Placement maintenance requires the requested promotion or demotion');
      }
    } else if (operation.to.placement !== operation.from.placement) {
      throw new Error('Lifecycle and category maintenance cannot implicitly change placement');
    }
    if (operation.op === 'recategorize' && operation.to.lifecycle !== record.lifecycle) {
      throw new Error('Recategorize cannot implicitly change lifecycle');
    }
    const replacements = operation.replacements ?? [];
    if (['supersede', 'merge', 'split'].includes(operation.op)) {
      if (operation.to.lifecycle !== 'superseded') throw new Error('Replacement requires superseded lifecycle');
      if ((operation.op === 'split' && replacements.length < 2)
        || (operation.op !== 'split' && replacements.length !== 1)) {
        throw new Error('Replacement operation requires the exact replacement count');
      }
      const keys = new Set<string>();
      for (const replacement of replacements) {
        const proposal = CanonicalContextProposalSchema.parse({
          ...proposalFromEntry(entry), key: replacement.key, value: replacement.value,
          sourceRef: canonicalLocator(replacement.sourcePath ?? entry.sourceRef),
          sourceDigest: replacement.sourcePath ? null : entry.sourceDigest,
          reviewer: operation.review.reviewer, reason: operation.rationale,
        });
        assertSafeProposal(proposal);
        const replacementId = stableEntryId(proposal);
        if (keys.has(replacement.key) || store.entries[replacementId]) {
          throw new Error('Replacement must have a unique new identity');
        }
        keys.add(replacement.key);
        if (Object.values(store.entries).some(candidate => candidate.status === 'active'
          && candidate.entryId !== entry.entryId && candidate.key === replacement.key
          && candidate.target === entry.target && !(operation.related ?? []).some(binding => binding.id === candidate.entryId
            || binding.id === canonicalMemoryRecord(candidate).id))) {
          throw new Error('Replacement conflicts with an unreviewed active canonical entry');
        }
      }
    } else if (replacements.length) throw new Error('This operation cannot replace canonical values');
    if (operation.op === 'merge' && this.mergeEntries(store, operation).length < 2) {
      throw new Error('Merge requires additional reviewed canonical sources');
    }
    return {
      schemaVersion: 'aiwg.canonical-context-preview.v1', operation: 'maintenance',
      operationId: sha256(JSON.stringify({ operation, snapshot: storeDigest(store) })),
      workspaceId: this.workspaceId, storeDigest: storeDigest(store), duplicate: false,
      confirmationRequired: true, conflicts: [], proposedEntryId: entry.entryId,
      importCount: 0, diff: [{ field: entry.entryId, before: JSON.stringify(operation.from), after: JSON.stringify(operation.to) }],
    };
  }

  private mergeEntries(store: CanonicalContextStore, operation: MaintenanceOperation): CanonicalContextEntry[] {
    const target = store.entries[operation.owner!.handle];
    const related = operation.related ?? [];
    const sources = [target];
    for (const binding of related) {
      const source = Object.values(store.entries).find(candidate => {
        const record = canonicalMemoryRecord(candidate);
        return record.id === binding.id || record.aliases.includes(binding.id);
      });
      if (!source || sources.includes(source)) throw new Error('Merge source is missing or duplicated');
      const record = canonicalMemoryRecord(source);
      if (record.digest !== binding.digest || record.version !== binding.version) throw new Error('Stale merge source digest or version');
      sources.push(source);
    }
    for (const entry of sources) {
      const record = canonicalMemoryRecord(entry);
      const base = canonicalMemoryRecord(target);
      if (record.lifecycle !== 'active' || record.scope !== base.scope
        || !isDeepStrictEqual(record.authority, base.authority)
        || record.placement !== base.placement || entry.scope !== target.scope || entry.classification !== target.classification) {
        throw new Error('Merge sources must preserve scope, authority, placement and active lifecycle');
      }
    }
    return sources;
  }

  private publishOwnerLock(lockPath: string): void {
    // Publish complete owner identity with one link syscall. A crash before this
    // point leaves only an unrelated temporary file, never an empty owner lock.
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx', mode: 0o600 });
      linkSync(temporary, lockPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private openOwnerLock(lockPath = this.lockPath, depth = 0): void {
    try { return this.publishOwnerLock(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || depth >= 8) throw error;
      // The same atomic lease protocol protects recovery for sync legacy and
      // async maintenance callers, including recovery after a dead reclaimer.
      const recoveryPath = `${lockPath}.recovery`;
      this.openOwnerLock(recoveryPath, depth + 1);
      try {
        let owner: { pid?: number; host?: string } | undefined;
        try { owner = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof owner; }
        catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return this.publishOwnerLock(lockPath);
        }
        if (!owner || typeof owner !== 'object' || Array.isArray(owner)
          || typeof owner.host !== 'string' || !owner.host
          || !Number.isSafeInteger(owner.pid) || owner.pid! < 1) {
          // A legacy writer could crash after exclusive create and before writing.
          // Give fresh/partially written locks a bounded grace period.
          if (Date.now() - statSync(lockPath).mtimeMs < 60_000) throw error;
        } else {
          if (owner.host !== hostname()) throw error;
          try { process.kill(owner.pid!, 0); throw error; }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
        }
        unlinkSync(lockPath);
        return this.publishOwnerLock(lockPath);
      } finally { unlinkSync(recoveryPath); }
    }
  }

  async confirmMaintenance(input: { preview: CanonicalContextPreview; operation: MaintenanceOperation; key: string; verifyRetrieval?: (operation: MaintenanceOperation) => Promise<boolean> }): Promise<CanonicalContextReceipt> {
    mkdirSync(this.root, { recursive: true });
    this.openOwnerLock();
    try {
      const store = this.read();
      const prior = store.maintenanceReceipts?.[input.key];
      if (prior) {
        if (prior.operationId !== input.preview.operationId) throw new Error('Maintenance receipt key conflicts with another operation');
        return prior;
      }
      const preview = this.previewMaintenance(input.operation);
      if (JSON.stringify(preview) !== JSON.stringify(input.preview)) {
        throw new Error('Confirmation requires the exact current canonical maintenance preview');
      }
      const removesResident = input.operation.from.placement === 'resident'
        && (input.operation.to.placement !== 'resident' || input.operation.to.lifecycle !== 'active');
      if (removesResident && !input.verifyRetrieval) {
        throw new Error('compound-memory resident removal is unsupported: no owner-native indexed retrieval projection is available');
      }
      if (removesResident && !await input.verifyRetrieval!(input.operation)) {
        throw new Error('Indexed retrieval must be verified before resident removal');
      }
      if (this.snapshot() !== preview.storeDigest) throw new Error('Stale canonical owner snapshot after retrieval verification');
      const now = new Date().toISOString();
      const entry = store.entries[input.operation.owner!.handle];
      const original = canonicalMemoryRecord(entry);
      const sources = input.operation.op === 'merge' ? this.mergeEntries(store, input.operation) : [entry];
      const newIds: string[] = [];
      for (const replacement of input.operation.replacements ?? []) {
        const proposal = CanonicalContextProposalSchema.parse({
          ...proposalFromEntry(entry), key: replacement.key, value: replacement.value,
          sourceRef: canonicalLocator(replacement.sourcePath ?? entry.sourceRef),
          sourceDigest: replacement.sourcePath ? null : entry.sourceDigest,
          reviewer: input.operation.review!.reviewer, reason: input.operation.rationale,
        });
        const entryId = stableEntryId(proposal);
        const next: CanonicalContextEntry = {
          ...proposal, entryId, status: 'active', createdAt: now, updatedAt: now,
          supersedes: entry.entryId, disposition: null, importedFromWorkspace: entry.importedFromWorkspace,
        };
        const nextRecord = canonicalMemoryRecord(next);
        nextRecord.scope = original.scope;
        nextRecord.authority = { ...original.authority };
        nextRecord.placement = original.placement;
        nextRecord.aliases = [...new Set([...nextRecord.aliases, ...sources.map(source => canonicalMemoryRecord(source).id)])];
        const lineage = sources.map(source => canonicalMemoryRecord(source).id);
        if (input.operation.op === 'merge') nextRecord.mergedFrom = lineage;
        else if (input.operation.op === 'split') nextRecord.splitFrom = lineage;
        else nextRecord.supersedes = lineage;
        next.maintenance = maintenanceMetadata(nextRecord, replacement.category ?? entry.maintenance?.category);
        store.entries[entryId] = next;
        newIds.push(entryId);
      }
      for (const source of sources) {
        const record = canonicalMemoryRecord(source);
        record.version += 1;
        record.placement = input.operation.to.placement;
        record.lifecycle = input.operation.to.lifecycle;
        if (record.lifecycle !== 'active') {
          record.tombstone = {
            id: record.id, digest: record.digest, disposition: record.lifecycle,
            reviewer: input.operation.review!.reviewer, reason: input.operation.rationale, at: now,
            ...(newIds[0] ? { successor: canonicalMemoryRecord(store.entries[newIds[0]]).id } : {}),
          };
        } else delete record.tombstone;
        source.maintenance = maintenanceMetadata(record, input.operation.category ?? source.maintenance?.category, source, now);
        source.status = record.lifecycle === 'active' ? 'active' : record.lifecycle === 'superseded' ? 'superseded' : 'revoked';
        source.updatedAt = now;
        source.disposition = record.lifecycle === 'active' ? null : {
          reviewer: input.operation.review!.reviewer, reason: input.operation.rationale, recordedAt: now,
        };
      }
      store.revision += 1;
      const receipt: CanonicalContextReceipt = {
        schemaVersion: 'aiwg.canonical-context-receipt.v1',
        receiptId: sha256(`${preview.operationId}\0${store.revision}`), operationId: preview.operationId,
        operation: 'maintenance', workspaceId: this.workspaceId,
        entryIds: [...sources.map(source => source.entryId), ...newIds],
        revision: store.revision, duplicate: false, completedAt: now,
      };
      store.maintenanceReceipts = { ...store.maintenanceReceipts, [input.key]: receipt };
      // Mutation and recovery receipt are a single atomic owner commit.
      writeJsonAtomic(this.statePath, store);
      return receipt;
    } finally {
      unlinkSync(this.lockPath);
    }
  }

  previewUpsert(raw: CanonicalContextProposal): CanonicalContextPreview {
    const proposal = CanonicalContextProposalSchema.parse({
      ...raw,
      sourceRef: canonicalLocator(raw.sourceRef),
    });
    assertSafeProposal(proposal);
    const store = this.read();
    const entryId = stableEntryId(proposal);
    const active = Object.values(store.entries).find(entry => (
      entry.status === 'active' && entry.target === proposal.target && entry.key === proposal.key
    ));
    const prior = Object.values(store.entries).filter(entry => entry.target === proposal.target && entry.key === proposal.key);
    if ((!active && prior.some(entry => canonicalMemoryRecord(entry).lifecycle === 'retired'))
      || (active && canonicalMemoryRecord(active).placement !== 'resident' && active.entryId !== entryId)) {
      throw new Error('Canonical retired or demoted content requires reviewed maintenance or restore');
    }
    const duplicate = active?.entryId === entryId;
    const conflicts = active && !duplicate
      ? [{ entryId: active.entryId, valueDigest: sha256(active.value) }]
      : [];
    const diff = duplicate ? [] : [
      { field: `${proposal.target}.${proposal.key}`, before: active?.value ?? null, after: proposal.value },
    ];
    const snapshot = storeDigest(store);
    return {
      schemaVersion: 'aiwg.canonical-context-preview.v1',
      operationId: sha256(JSON.stringify({ operation: 'upsert', proposal, snapshot })),
      operation: 'upsert',
      workspaceId: this.workspaceId,
      storeDigest: snapshot,
      duplicate,
      confirmationRequired: true,
      diff,
      conflicts,
      proposedEntryId: entryId,
      importCount: 0,
    };
  }

  previewRevoke(entryId: string, reviewer: string, reason: string): CanonicalContextPreview {
    const store = this.read();
    const entry = store.entries[entryId];
    if (!entry) throw new Error('canonical context entry was not found');
    const duplicate = entry.status === 'revoked';
    const snapshot = storeDigest(store);
    return {
      schemaVersion: 'aiwg.canonical-context-preview.v1',
      operationId: sha256(JSON.stringify({ operation: 'revoke', entryId, reviewer, reason, snapshot })),
      operation: 'revoke',
      workspaceId: this.workspaceId,
      storeDigest: snapshot,
      duplicate,
      confirmationRequired: true,
      diff: duplicate ? [] : [{ field: `${entry.target}.${entry.key}`, before: entry.value, after: null }],
      conflicts: [],
      proposedEntryId: entryId,
      importCount: 0,
    };
  }

  export(): CanonicalContextExport {
    const store = this.read();
    return {
      schemaVersion: 'aiwg.canonical-context-export.v1',
      sourceWorkspaceId: store.workspaceId,
      exportedAt: new Date().toISOString(),
      entries: Object.values(store.entries).sort((left, right) => left.entryId.localeCompare(right.entryId)),
    };
  }

  previewImport(bundle: CanonicalContextExport, allowCrossWorkspace = false): CanonicalContextPreview {
    if (bundle.schemaVersion !== 'aiwg.canonical-context-export.v1' || !Array.isArray(bundle.entries)) {
      throw new Error('canonical context import schema is invalid');
    }
    if (bundle.sourceWorkspaceId !== this.workspaceId && !allowCrossWorkspace) {
      throw new Error('cross-workspace context import requires explicit authorization');
    }
    for (const entry of bundle.entries) assertSafeProposal(proposalFromEntry(entry));
    const store = this.read();
    const conflicts = bundle.entries.flatMap(imported => Object.values(store.entries)
      .filter(entry => entry.status === 'active'
        && imported.status === 'active'
        && entry.target === imported.target
        && entry.key === imported.key
        && entry.value !== imported.value)
      .map(entry => ({ entryId: entry.entryId, valueDigest: sha256(entry.value) })));
    const snapshot = storeDigest(store);
    return {
      schemaVersion: 'aiwg.canonical-context-preview.v1',
      operationId: sha256(JSON.stringify({
        operation: 'import',
        bundleDigest: sha256(JSON.stringify(bundle)),
        allowCrossWorkspace,
        snapshot,
      })),
      operation: 'import',
      workspaceId: this.workspaceId,
      storeDigest: snapshot,
      duplicate: bundle.entries.every(entry => Boolean(store.entries[entry.entryId])),
      confirmationRequired: true,
      diff: bundle.entries
        .filter(entry => !store.entries[entry.entryId])
        .map(entry => ({ field: `${entry.target}.${entry.key}`, before: null, after: entry.value })),
      conflicts,
      proposedEntryId: null,
      importCount: bundle.entries.length,
    };
  }

  confirm(input: {
    preview: CanonicalContextPreview;
    proposal?: CanonicalContextProposal;
    revoke?: { entryId: string; reviewer: string; reason: string };
    bundle?: CanonicalContextExport;
    allowCrossWorkspace?: boolean;
  }): CanonicalContextReceipt {
    mkdirSync(this.root, { recursive: true });
    this.openOwnerLock();
    try {
      const requestedReceiptPath = resolve(
        this.receiptRoot,
        `${input.preview.operationId.replace(':', '_')}.json`,
      );
      if (existsSync(requestedReceiptPath)) {
        return {
          ...(JSON.parse(readFileSync(requestedReceiptPath, 'utf8')) as CanonicalContextReceipt),
          duplicate: true,
        };
      }
      const current = input.preview.operation === 'upsert' && input.proposal
        ? this.previewUpsert(input.proposal)
        : input.preview.operation === 'revoke' && input.revoke
          ? this.previewRevoke(input.revoke.entryId, input.revoke.reviewer, input.revoke.reason)
          : input.preview.operation === 'import' && input.bundle
            ? this.previewImport(input.bundle, input.allowCrossWorkspace)
            : null;
      if (!current || current.operationId !== input.preview.operationId) {
        throw new Error('confirmation requires the exact current canonical-context preview');
      }
      const receiptPath = requestedReceiptPath;
      const store = this.read();
      const now = new Date().toISOString();
      const changed: string[] = [];
      if (current.operation === 'upsert' && input.proposal && current.proposedEntryId) {
        const proposal = CanonicalContextProposalSchema.parse({
          ...input.proposal,
          sourceRef: canonicalLocator(input.proposal.sourceRef),
        });
        if (!current.duplicate) {
          const active = Object.values(store.entries).find(entry => (
            entry.status === 'active' && entry.target === proposal.target && entry.key === proposal.key
          ));
          if (active) {
            const record = canonicalMemoryRecord(active);
            record.version += 1;
            record.lifecycle = 'superseded';
            record.tombstone = { id: record.id, digest: record.digest, disposition: 'superseded',
              reviewer: proposal.reviewer, reason: proposal.reason, at: now };
            active.maintenance = maintenanceMetadata(record, active.maintenance?.category, active, now);
            active.status = 'superseded';
            active.updatedAt = now;
            active.disposition = { reviewer: proposal.reviewer, reason: proposal.reason, recordedAt: now };
            changed.push(active.entryId);
          }
          store.entries[current.proposedEntryId] = {
            ...proposal,
            entryId: current.proposedEntryId,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            supersedes: active?.entryId ?? null,
            disposition: null,
            importedFromWorkspace: null,
          };
          if (active?.maintenance) {
            const successor = canonicalMemoryRecord(store.entries[current.proposedEntryId]);
            const predecessor = canonicalMemoryRecord(active);
            successor.scope = predecessor.scope;
            successor.authority = { ...predecessor.authority };
            successor.placement = predecessor.placement;
            successor.supersedes = [predecessor.id];
            successor.aliases.push(predecessor.id);
            store.entries[current.proposedEntryId].maintenance = maintenanceMetadata(successor, active.maintenance.category);
            if (active.maintenance.tombstone) active.maintenance.tombstone.successor = successor.id;
          }
          changed.push(current.proposedEntryId);
        }
      } else if (current.operation === 'revoke' && input.revoke) {
        const entry = store.entries[input.revoke.entryId];
        if (!current.duplicate) {
          const record = canonicalMemoryRecord(entry);
          record.version += 1;
          record.lifecycle = 'retired';
          record.tombstone = { id: record.id, digest: record.digest, disposition: 'retired',
            reviewer: input.revoke.reviewer, reason: input.revoke.reason, at: now };
          entry.maintenance = maintenanceMetadata(record, entry.maintenance?.category, entry, now);
          entry.status = 'revoked';
          entry.updatedAt = now;
          entry.disposition = {
            reviewer: input.revoke.reviewer,
            reason: input.revoke.reason,
            recordedAt: now,
          };
          changed.push(entry.entryId);
        }
      } else if (current.operation === 'import' && input.bundle) {
        for (const imported of input.bundle.entries) {
          if (store.entries[imported.entryId]) continue;
          store.entries[imported.entryId] = {
            ...imported,
            importedFromWorkspace: input.bundle.sourceWorkspaceId,
          };
          changed.push(imported.entryId);
        }
      }
      if (changed.length > 0) {
        store.revision += 1;
        writeJsonAtomic(this.statePath, store);
      }
      const receipt: CanonicalContextReceipt = {
        schemaVersion: 'aiwg.canonical-context-receipt.v1',
        receiptId: sha256(`${current.operationId}\0${store.revision}`),
        operationId: current.operationId,
        operation: current.operation,
        workspaceId: this.workspaceId,
        entryIds: changed,
        revision: store.revision,
        duplicate: current.duplicate,
        completedAt: now,
      };
      writeJsonAtomic(receiptPath, receipt);
      return receipt;
    } finally {
      unlinkSync(this.lockPath);
    }
  }
}
