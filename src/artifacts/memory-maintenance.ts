import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dump, load } from 'js-yaml';
import { resolveProjectAiwgDir } from '../config/project-artifacts.js';
import { sha256 } from '../memory/context-pack.js';
import { indexMemoryAliases, loadMemoryRecord, memoryRecordId, type MemoryRecord } from '../memory/maintenance-record.js';
import { validateMaintenancePlan, type MaintenanceOperation } from '../memory/maintenance-contract.js';
import type { MaintenanceOwner } from '../memory/maintenance-owner.js';
import { getProjectIndexRoot, type ArtifactIndex, type MetadataEntry } from './types.js';
import { acquireDirectoryLock } from './prebuilt-build-lock.js';

interface Source {
  file: string;
  sourcePath: string;
  entry: MetadataEntry;
  data: Record<string, unknown>;
  body: string;
  record: MemoryRecord;
}
interface Update {
  sourcePath: string;
  record: MemoryRecord;
  previous?: MemoryRecord;
  sourceMetadataDigest: string;
  hadRecord?: boolean;
  previousCategory?: unknown;
  category?: string;
  replacementKey?: string;
}
interface OwnerReceipt {
  owner: string;
  key: string;
  operationDigest: string;
  records: Array<{ id: string; sourcePath: string; digest: string; version: number }>;
  sessionEffect: 'current' | 'next-session';
}
interface Pending {
  key: string;
  operationDigest: string;
  updates: Update[];
  receipt: OwnerReceipt;
}
interface OwnerMetadata {
  receipts: OwnerReceipt[];
  history?: MemoryRecord[];
  trimmedHistory?: { count: number; digest: string };
  pending?: Pending;
}
/** Bound source frontmatter while retaining a verifiable chain of older revisions. */
export const ARTIFACT_MEMORY_HISTORY_LIMIT = 16;
function boundedHistory(journal: OwnerMetadata, previous?: MemoryRecord): Pick<OwnerMetadata, 'history' | 'trimmedHistory'> {
  const history = [...(journal.history ?? [])];
  if (previous && !history.some(item => item.id === previous.id && item.version === previous.version)) history.push(previous);
  const trimmed = history.splice(0, Math.max(0, history.length - ARTIFACT_MEMORY_HISTORY_LIMIT));
  const trimmedHistory = trimmed.length ? {
    count: (journal.trimmedHistory?.count ?? 0) + trimmed.length,
    digest: sha256(JSON.stringify({ previous: journal.trimmedHistory ?? null, records: trimmed })),
  } : journal.trimmedHistory;
  return { history, ...(trimmedHistory ? { trimmedHistory } : {}) };
}
export interface ArtifactMaintenanceOptions {
  /** Existing index builder by default; injectable for deterministic failure/recovery tests. */
  rebuild?: (root: string, graphs: readonly string[]) => Promise<void>;
  now?: () => Date;
}

function parseSource(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  const data = load(match[1]) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Memory source frontmatter must be an object');
  return { data: data as Record<string, unknown>, body: match[2] };
}
function ownerMetadata(data: Record<string, unknown>): OwnerMetadata {
  if (data.memoryMaintenance === undefined) return { receipts: [] };
  const value = data.memoryMaintenance as OwnerMetadata;
  if (!value || !Array.isArray(value.receipts)) throw new Error('Invalid artifact maintenance journal');
  return value;
}
function atomicSource(file: string, data: Record<string, unknown>, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `---\n${dump(data, { noRefs: true, lineWidth: -1 })}---\n${body}`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function sourceMetadataDigest(data: Record<string, unknown>): string {
  const { memoryRecord: _record, memoryMaintenance: _journal, memoryCategory: _category, ...source } = data;
  return sha256(JSON.stringify(source));
}

/** Semantic memory maintenance edits canonical sources, then republishes the existing artifact index. */
export class ArtifactMaintenanceOwner implements MaintenanceOwner {
  readonly name = 'semantic-memory';
  private readonly root: string;
  private readonly options: ArtifactMaintenanceOptions;

  constructor(projectRoot: string, options: ArtifactMaintenanceOptions = {}) {
    this.root = path.resolve(projectRoot);
    this.options = options;
  }

  private indexes(): Array<{ graph: string; file: string; index: ArtifactIndex }> {
    const directory = getProjectIndexRoot(this.root);
    if (!fs.existsSync(directory)) return [];
    const files = [{ graph: '', file: path.join(directory, 'metadata.json') },
      ...fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith('.'))
        .map(item => ({ graph: item.name, file: path.join(directory, item.name, 'metadata.json') }))];
    return files.filter(item => fs.existsSync(item.file)).map(item => ({ ...item,
      index: JSON.parse(fs.readFileSync(item.file, 'utf8')) as ArtifactIndex }));
  }

  private resolveSource(sourcePath: string): string {
    if (!sourcePath || /[\r\n\0]/.test(sourcePath)) throw new Error('Invalid semantic-memory source path');
    const full = path.resolve(this.root, sourcePath);
    const artifactRoot = resolveProjectAiwgDir(this.root);
    if (!full.startsWith(`${artifactRoot}${path.sep}`)) throw new Error('Semantic-memory changes require canonical project artifact sources');
    // Reject symlink escapes, including a replacement's nearest existing parent.
    let existing = full;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const real = fs.realpathSync(existing);
    if (real !== artifactRoot && !real.startsWith(`${fs.realpathSync(artifactRoot)}${path.sep}`)) {
      throw new Error('Semantic-memory source escapes the canonical artifact root');
    }
    if (!full.endsWith('.md')) throw new Error('Semantic-memory maintenance requires Markdown canonical sources');
    const logical = path.relative(artifactRoot, full).replace(/\\/g, '/');
    if (/^(?:context\/compound-memory|memory\/line-memory)(?:\/|\.)/.test(logical)) {
      throw new Error('Another lifecycle owner controls this memory source');
    }
    return full;
  }

  private sourceFor(entry: MetadataEntry): Source | undefined {
    let file: string;
    try {
      const full = entry.path.startsWith('.aiwg/')
        ? path.join(resolveProjectAiwgDir(this.root), entry.path.slice('.aiwg/'.length))
        : path.resolve(this.root, entry.path);
      file = this.resolveSource(path.relative(this.root, full));
    } catch { return undefined; }
    if (!fs.existsSync(file)) return undefined;
    const sourcePath = path.relative(this.root, file).replace(/\\/g, '/');
    const { data, body } = parseSource(fs.readFileSync(file, 'utf8'));
    const digest = sha256(body);
    let stamped: MemoryRecord | undefined;
    if (data.memoryRecord !== undefined) {
      try { stamped = loadMemoryRecord(data.memoryRecord); }
      catch {
        console.warn(`Semantic-memory: ${sourcePath}: invalid memoryRecord metadata quarantined; source is not a maintenance target`);
        return undefined;
      }
    }
    const record = stamped ?? loadMemoryRecord({
      schemaVersion: 'aiwg.memory-record.v1', id: memoryRecordId(sourcePath, digest), sourcePath, digest,
      version: 1, aliases: [...new Set([sourcePath, entry.path])], supersedes: [], mergedFrom: [], splitFrom: [],
      scope: 'project', placement: 'indexed', lifecycle: 'active',
      authority: { owner: this.name, source: 'import', protection: data.pinned === true ? 'pinned' : 'unprotected' },
      observation: { status: 'on-disk', evidence: { source: sourcePath,
        at: fs.statSync(file).mtime.toISOString(), session: null, provider: null, version: null } },
    });
    if (record.sourcePath !== sourcePath || record.digest !== digest || record.authority.owner !== this.name) {
      throw new Error('Canonical semantic-memory source identity or digest has changed');
    }
    return { file, sourcePath, entry, data, body, record };
  }

  private sources(): Source[] {
    const sources = new Map<string, Source>();
    for (const { index } of this.indexes()) {
      for (const entry of Object.values(index.entries)) {
        const source = this.sourceFor(entry);
        if (source) sources.set(source.sourcePath, source);
      }
    }
    return [...sources.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  }

  async records(): Promise<MemoryRecord[]> { return this.sources().map(source => source.record); }
  async snapshot(): Promise<string> {
    return sha256(JSON.stringify({ indexes: this.indexes().map(item => [item.graph, item.index]),
      sources: this.sources().map(source => [source.sourcePath, fs.readFileSync(source.file, 'utf8')]) }));
  }

  private target(operation: MaintenanceOperation): Source {
    const source = this.sources().find(item => item.record.id === operation.target.id || item.record.aliases.includes(operation.target.id)
      || item.sourcePath === operation.owner?.handle);
    if (!source) throw new Error('Semantic-memory maintenance target is missing');
    if (operation.owner?.handle !== source.sourcePath || operation.owner.name !== this.name) {
      throw new Error('Semantic-memory owner binding does not match the exact source');
    }
    if (source.record.id !== operation.target.id && !source.record.aliases.includes(operation.target.id)) {
      throw new Error('Stale semantic-memory source digest');
    }
    return source;
  }

  async validate(operation: MaintenanceOperation): Promise<void> {
    const source = this.target(operation);
    for (const item of this.sources()) {
      const journal = ownerMetadata(item.data).pending;
      if (journal && journal.operationDigest !== sha256(JSON.stringify(operation))) {
        throw new Error('Another semantic-memory transaction is pending');
      }
    }
    const pending = ownerMetadata(source.data).pending;
    if (pending) {
      if (pending.operationDigest !== sha256(JSON.stringify(operation))) throw new Error('Another semantic-memory transaction is pending');
      return;
    }
    if (operation.owner?.snapshot !== await this.snapshot()) throw new Error('Stale semantic-memory owner snapshot');
    const records = await this.records();
    validateMaintenancePlan({ schemaVersion: 'aiwg.maintenance-plan.v1', operations: [operation] }, records,
      { retirementBasis: operation.review?.retirementBasis ?? 'age' });
    if (!operation.review?.reviewer) throw new Error('Semantic-memory operations require an exact-plan reviewer');
    if (operation.op === 'recategorize' && !operation.category) throw new Error('Recategorize requires an explicit category');
    if (['merge', 'split', 'supersede'].includes(operation.op) && !operation.replacements?.length) {
      throw new Error('Semantic-memory lineage operations require explicit replacements');
    }
    if (operation.op === 'split' && operation.replacements!.length < 2) throw new Error('Split requires at least two replacements');
    if (operation.op === 'merge' && !operation.related?.length) throw new Error('Merge requires reviewed input revisions');
    if (['merge', 'split', 'supersede'].includes(operation.op) && source.record.lifecycle !== 'active') {
      throw new Error('Lineage operations require active originals');
    }
    const seen = new Set([source.record.id]);
    for (const related of operation.related ?? []) {
      const record = records.find(item => item.id === related.id);
      if (!record || seen.has(record.id) || record.digest !== related.digest || record.version !== related.version) {
        throw new Error('Stale or duplicate merge input revision');
      }
      if (record.scope !== source.record.scope || !isDeepStrictEqual(record.authority, source.record.authority)) {
        throw new Error('Merge cannot implicitly change scope or authority');
      }
      if (record.placement !== source.record.placement || record.lifecycle !== source.record.lifecycle) {
        throw new Error('Merge inputs require the same reviewed placement and lifecycle');
      }
      seen.add(record.id);
    }
    const paths = new Set<string>();
    const keys = new Set<string>();
    for (const replacement of operation.replacements ?? []) {
      if (keys.has(replacement.key)) throw new Error('Replacement keys must be unique');
      keys.add(replacement.key);
      if (!replacement.sourcePath) throw new Error('Semantic-memory replacements require an explicit canonical sourcePath');
      const file = this.resolveSource(replacement.sourcePath);
      if (fs.existsSync(file) || paths.has(file)) throw new Error('Replacement cannot overwrite an original source');
      paths.add(file);
    }
  }

  async verifyRetrieval(operation: MaintenanceOperation): Promise<boolean> {
    const candidates = this.indexes().flatMap(({ index }) => Object.values(index.entries).map(entry => this.sourceFor(entry)))
      .filter((source): source is Source => !!source && source.record.lifecycle === 'active' && source.record.placement !== 'archived');
    for (const target of [operation.target, ...(operation.related ?? [])]) {
      const found = candidates.some(source => {
        const referenced = operation.impactedLinks.includes(source.sourcePath) || operation.impactedLinks.includes(source.entry.path)
          || operation.impactedLinks.includes(source.record.id);
        const ownDemotion = operation.op === 'demote' && source.record.id === target.id;
        if ((!referenced && !ownDemotion) || source.record.digest !== target.digest) return false;
        // Compare the published index revision and source body, not merely an existing locator.
        if (source.entry.memoryRecord && (source.entry.memoryRecord.digest !== source.record.digest
          || source.entry.memoryRecord.version !== source.record.version || source.entry.memoryRecord.lifecycle !== 'active')) return false;
        if (!source.entry.memoryRecord && source.entry.checksum !== sha256(fs.readFileSync(source.file, 'utf8')).slice(7, 23)) return false;
        if (operation.to.lifecycle !== 'active' && [operation.target.id, ...(operation.related ?? []).map(item => item.id)].includes(source.record.id)) return false;
        return true;
      });
      if (!found) return false;
    }
    return true;
  }

  private transaction(operation: MaintenanceOperation, key: string, source: Source): Pending {
    const at = (this.options.now?.() ?? new Date()).toISOString();
    const lineage = [source.record.id, ...(operation.related ?? []).map(item => item.id)];
    const replacements: Update[] = (operation.replacements ?? []).map(replacement => {
      const sourcePath = path.relative(this.root, this.resolveSource(replacement.sourcePath!)).replace(/\\/g, '/');
      const digest = sha256(replacement.value);
      return { sourcePath, replacementKey: replacement.key, category: replacement.category ?? operation.category,
        sourceMetadataDigest: sourceMetadataDigest({}),
        record: loadMemoryRecord({ ...source.record, id: memoryRecordId(sourcePath, digest), sourcePath, digest, version: 1,
          placement: source.record.placement, lifecycle: 'active', aliases: [sourcePath, replacement.key], tombstone: undefined,
          supersedes: operation.op === 'supersede' ? lineage : [], mergedFrom: operation.op === 'merge' ? lineage : [],
          splitFrom: operation.op === 'split' ? lineage : [],
          observation: { status: 'on-disk', evidence: { source: sourcePath, at, session: null, provider: null, version: null } },
        }) };
    });
    const originals = [source, ...this.sources().filter(item => (operation.related ?? []).some(related => related.id === item.record.id))];
    const updates: Update[] = originals.map(original => {
      const lifecycle = ['merge', 'split', 'supersede'].includes(operation.op) ? 'superseded' : operation.to.lifecycle;
      const record: MemoryRecord = { ...original.record, version: original.record.version + 1,
        placement: operation.to.placement, lifecycle,
        ...(lifecycle === 'active' ? { tombstone: undefined } : { tombstone: {
          id: original.record.id, digest: original.record.digest, disposition: lifecycle,
          reason: operation.rationale, reviewer: operation.review!.reviewer, at,
          ...(replacements[0] ? { successor: replacements[0].record.id } : {}),
        } }),
      };
      return { sourcePath: original.sourcePath, record: loadMemoryRecord(record), previous: original.record, category: operation.category,
        sourceMetadataDigest: sourceMetadataDigest(original.data), hadRecord: original.data.memoryRecord !== undefined,
        previousCategory: original.data.memoryCategory };
    });
    updates.push(...replacements);
    const changed = new Set(updates.map(update => update.record.id));
    indexMemoryAliases([...this.sources().map(item => item.record).filter(record => !changed.has(record.id)),
      ...updates.map(update => update.record)]);
    return { key, operationDigest: sha256(JSON.stringify(operation)), updates,
      receipt: { owner: this.name, key, operationDigest: sha256(JSON.stringify(operation)),
        records: updates.map(({ record }) => ({ id: record.id, sourcePath: record.sourcePath, digest: record.digest, version: record.version })),
        sessionEffect: operation.sessionEffect } };
  }

  /** Publish dispositions before a potentially failing rebuild; queries only read metadata. */
  private publishDispositions(updates: readonly Update[]): void {
    for (const { file, index } of this.indexes()) {
      let changed = false;
      for (const entry of Object.values(index.entries)) {
        const entryFile = entry.path.startsWith('.aiwg/')
          ? path.join(resolveProjectAiwgDir(this.root), entry.path.slice('.aiwg/'.length))
          : path.resolve(this.root, entry.path);
        const update = updates.find(item => path.resolve(this.root, item.sourcePath) === entryFile);
        if (!update) continue;
        entry.memoryRecord = update.record;
        changed = true;
      }
      if (!changed) continue;
      // Fortemi cache freshness is bound to builtAt. Disposition publication is
      // a new metadata revision even if the subsequent rebuild fails.
      const previousTime = Date.parse(index.builtAt);
      index.builtAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(index)}\n`, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  }

  async apply(operation: MaintenanceOperation, key: string): Promise<unknown> {
    const release = await acquireDirectoryLock(path.join(getProjectIndexRoot(this.root), '.semantic-maintenance.lock'),
      { timeoutMs: 0, reclaimDeadOwner: true });
    try {
      const existing = await this.receipt(key);
      if (existing) {
        if ((existing as OwnerReceipt).operationDigest !== sha256(JSON.stringify(operation))) throw new Error('Receipt key belongs to a different operation');
        return existing;
      }
      await this.validate(operation);
      const source = this.target(operation);
      const metadata = ownerMetadata(source.data);
      const pending = metadata.pending ?? this.transaction(operation, key, source);
      if (pending.key !== key || pending.operationDigest !== sha256(JSON.stringify(operation))) {
        throw new Error('Pending semantic-memory transaction belongs to a different exact plan');
      }
      if (!metadata.pending) {
        if (operation.from.placement === 'resident' && (operation.to.placement !== 'resident' || operation.to.lifecycle !== 'active')
          && !await this.verifyRetrieval(operation)) {
          throw new Error('Indexed retrieval must be verified before resident removal');
        }
        const current = parseSource(fs.readFileSync(source.file, 'utf8'));
        if (sha256(current.body) !== source.record.digest || JSON.stringify(current.data) !== JSON.stringify(source.data)) {
          throw new Error('Canonical source changed before the owner transaction started');
        }
        atomicSource(source.file, { ...source.data, memoryMaintenance: { ...metadata, pending } }, source.body);
      }
      for (const update of pending.updates) {
        const file = this.resolveSource(update.sourcePath);
        const replacement = operation.replacements?.find(item => item.key === update.replacementKey);
        const current = fs.existsSync(file) ? parseSource(fs.readFileSync(file, 'utf8')) : undefined;
        const body = current?.body ?? replacement?.value;
        if (body === undefined || sha256(body) !== update.record.digest) throw new Error('Source changed during pending semantic-memory transaction');
        if (sourceMetadataDigest(current?.data ?? {}) !== update.sourceMetadataDigest) {
          throw new Error('Source metadata changed during pending semantic-memory transaction');
        }
        const currentRecord = current?.data.memoryRecord === undefined ? undefined : loadMemoryRecord(current.data.memoryRecord);
        const before = !update.hadRecord && currentRecord === undefined
          || update.previous && JSON.stringify(currentRecord) === JSON.stringify(update.previous);
        const after = JSON.stringify(currentRecord) === JSON.stringify(update.record);
        if (!before && !after) throw new Error('Source authority or revision changed during pending semantic-memory transaction');
        const currentCategory = current?.data.memoryCategory;
        if (JSON.stringify(currentCategory) !== JSON.stringify(update.previousCategory)
          && JSON.stringify(currentCategory) !== JSON.stringify(update.category ?? update.previousCategory)) {
          throw new Error('Source category changed during pending semantic-memory transaction');
        }
        const journal = ownerMetadata(current?.data ?? {});
        atomicSource(file, { ...(current?.data ?? {}), memoryRecord: update.record,
          memoryMaintenance: { ...journal, ...boundedHistory(journal, update.previous) },
          ...(update.category === undefined ? {} : { memoryCategory: update.category }) }, body);
      }
      this.publishDispositions(pending.updates);
      const graphs = this.indexes().map(item => item.graph);
      if (this.options.rebuild) await this.options.rebuild(this.root, graphs);
      else {
        const { buildIndex } = await import('./index-builder.js');
        for (const graph of graphs) await buildIndex(this.root, { ...(graph ? { graph } : {}), force: true, quiet: true });
      }
      for (const update of pending.updates) {
        const current = parseSource(fs.readFileSync(this.resolveSource(update.sourcePath), 'utf8'));
        if (sha256(current.body) !== update.record.digest || sourceMetadataDigest(current.data) !== update.sourceMetadataDigest
          || JSON.stringify(loadMemoryRecord(current.data.memoryRecord)) !== JSON.stringify(update.record)) {
          throw new Error('Canonical source changed during index publication; owner receipt remains pending');
        }
      }
      const anchor = parseSource(fs.readFileSync(source.file, 'utf8'));
      atomicSource(source.file, { ...anchor.data, memoryMaintenance: {
        ...boundedHistory(ownerMetadata(anchor.data)),
        receipts: [...metadata.receipts, pending.receipt],
      } }, anchor.body);
      return pending.receipt;
    } finally { await release(); }
  }

  async receipt(key: string): Promise<unknown | undefined> {
    for (const source of this.sources()) {
      const receipt = ownerMetadata(source.data).receipts.find(item => item.key === key);
      if (receipt) return receipt;
    }
    return undefined;
  }

  async pending(operation: MaintenanceOperation): Promise<boolean> {
    return ownerMetadata(this.target(operation).data).pending?.operationDigest === sha256(JSON.stringify(operation));
  }
}
