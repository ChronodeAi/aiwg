import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadMetadataIndex } from '../../../src/artifacts/index-reader.js';
import { LineMaintenanceOwner } from '../../../src/memory/line-maintenance.js';
import type { MaintenanceOperation, MaintenanceOp } from '../../../src/memory/maintenance-contract.js';
import type { MemoryRecord } from '../../../src/memory/maintenance-record.js';
import { sha256 } from '../../../src/memory/context-pack.js';
import { maintenanceOperationKey, verifyMaintenancePlan } from '../../../src/memory/maintenance.js';
import type { MaintenancePlan } from '../../../src/memory/maintenance-contract.js';
import { MaintenancePlanSchema } from '../../../src/memory/maintenance-contract.js';
import { assertProjectRelativePath, runLineMemory } from '../../../agentic/code/addons/line-memory/commands/line-memory.mjs';

let root: string;
const handle = 'lm_11111111-1111-4111-a111-111111111111';
const second = 'lm_22222222-2222-4222-a222-222222222222';
const meta = '.aiwg/memory/line-memory.meta.json';
const memory = '.aiwg/memory/line-memory.txt';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-line-maintenance-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function seed(options: { pinned?: boolean; second?: boolean; maxLines?: number } = {}): void {
  fs.mkdirSync(path.join(root, '.aiwg/memory'), { recursive: true });
  const entries: Record<string, unknown> = {};
  for (const [id, value] of [[handle, 'Keep a verified source'], ...(options.second ? [[second, 'Keep a second source']] : [])]) {
    entries[id] = { id, value, digest: sha256(value), status: 'active', sources: [{ ref: 'source.md', reviewer: 'operator' }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      maintenance: { authority: { owner: 'line-memory', source: 'operator', protection: options.pinned ? 'pinned' : 'unprotected' } } };
  }
  fs.writeFileSync(path.join(root, meta), JSON.stringify({ version: 1, entries }));
  fs.writeFileSync(path.join(root, memory), `Keep a verified source\n${options.second ? 'Keep a second source\n' : ''}`);
  fs.writeFileSync(path.join(root, 'source.md'), 'Original source must survive retirement');
  if (options.maxLines) fs.writeFileSync(path.join(root, '.aiwg/memory/line-memory.config.json'), JSON.stringify({ maxLines: options.maxLines }));
}
function metadata(): any { return JSON.parse(fs.readFileSync(path.join(root, meta), 'utf8')); }
function owner(verifyRetrieval = async () => true): LineMaintenanceOwner { return new LineMaintenanceOwner(root, { verifyRetrieval }); }
async function operation(op: MaintenanceOp, store = owner(), item?: MemoryRecord): Promise<MaintenanceOperation> {
  const record = item ?? (await store.records())[0];
  return {
    op, target: { id: record.id, digest: record.digest, version: record.version },
    precondition: { digest: record.digest, version: record.version },
    from: { placement: record.placement, lifecycle: record.lifecycle },
    to: { placement: record.placement, lifecycle: op === 'retire' ? 'retired' : op === 'restore' ? 'active'
      : ['merge', 'split', 'supersede'].includes(op) ? 'superseded' : record.lifecycle },
    owner: { name: 'line-memory', handle: record.aliases[0], snapshot: await store.snapshot() },
    review: { reviewer: 'operator', retirementBasis: 'review' },
    scope: record.scope, rationale: 'Operator reviewed exact memory transition', uncertainty: 'Session load is unknown',
    impactedLinks: ['artifact-index:source.md'], sessionEffect: 'next-session',
  };
}

describe('line-memory maintenance through its existing lifecycle owner', () => {
  it.each(['recategorize', 'demote', 'retire', 'restore', 'merge', 'split', 'supersede'] as const)('verifies %s receipts, retained history and publication without writes', async name => {
    seed({ second: name === 'merge' });
    const store = owner();
    if (name === 'restore') await store.apply(await operation('retire', store), 'prior-retirement');
    const op = await operation(name, store);
    if (name === 'demote') op.to.placement = 'indexed';
    if (name === 'recategorize') op.category = 'reviewed';
    if (['merge', 'split', 'supersede'].includes(name)) {
      op.replacements = [{ key: 'replacement', value: 'Reviewed replacement' }];
      if (name === 'split') op.replacements.push({ key: 'second', value: 'Second reviewed replacement' });
      if (name === 'merge') {
        const related = (await store.records())[1];
        op.related = [{ id: related.id, digest: related.digest, version: related.version }];
      }
    }
    const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [op] };
    await store.apply(MaintenancePlanSchema.parse(plan).operations[0], maintenanceOperationKey(plan, 0));
    const snapshot = await store.snapshot();
    const indexFile = path.join(root, '.aiwg/.index/metadata.json');
    const index = fs.readFileSync(indexFile, 'utf8');
    expect((await verifyMaintenancePlan(plan, [store])).findings).toEqual([]);
    expect(await store.snapshot()).toBe(snapshot);
    expect(fs.readFileSync(indexFile, 'utf8')).toBe(index);
    expect(fs.existsSync(path.join(root, '.aiwg/memory/line-memory.lock'))).toBe(false);
    const state = metadata();
    state.entries[handle].maintenance.history = [];
    if (name === 'recategorize') state.entries[handle].maintenance.category = 'drift';
    fs.writeFileSync(path.join(root, meta), JSON.stringify(state));
    const findings = (await verifyMaintenancePlan(plan, [store])).findings.join(' ');
    expect(findings).toMatch(/history/);
    if (name === 'recategorize') expect(findings).toMatch(/category/);
  });
  it('keeps receipt reads and stale resident publication checks strictly read-only', async () => {
    seed(); const store = owner(); const op = await operation('retire', store);
    const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [op] };
    const key = maintenanceOperationKey(plan, 0); await store.apply(MaintenancePlanSchema.parse(plan).operations[0], key);
    const indexFile = path.join(root, '.aiwg/.index/metadata.json');
    const stale = JSON.stringify({ entries: { [meta]: { path: meta } } });
    fs.writeFileSync(indexFile, stale);
    fs.writeFileSync(path.join(root, memory), 'Keep a verified source\n');
    expect(await store.receipt(key, { readOnly: true })).toBeDefined();
    expect((await verifyMaintenancePlan(plan, [store])).findings.join(' ')).toMatch(/Resident publication/);
    expect(fs.readFileSync(indexFile, 'utf8')).toBe(stale);
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toBe('Keep a verified source\n');
  });
  it('reads missing stores and legacy facts without creating metadata or locks', async () => {
    expect(await owner().records()).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.mkdirSync(path.join(root, '.aiwg/memory'), { recursive: true });
    fs.writeFileSync(path.join(root, memory), 'Legacy fact\n');
    expect((await owner().records())[0].aliases[0]).toMatch(/^lm_/);
    expect(await owner().snapshot()).toEqual(await owner().snapshot());
    expect(fs.existsSync(path.join(root, meta))).toBe(false);
    expect(fs.existsSync(path.join(root, '.aiwg/memory/line-memory.lock'))).toBe(false);
  });

  it('refuses project memory paths escaping through symlinks', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-line-maintenance-external-'));
    try {
      fs.mkdirSync(path.join(root, '.aiwg'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, '.aiwg/memory'), 'dir');
      fs.writeFileSync(path.join(outside, 'line-memory.txt'), 'External private fact\n');
      await expect(owner().records()).rejects.toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual(['line-memory.txt']);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it.each(['ENOENT', 'ENOTDIR'])('resolves the surviving project ancestor when a concurrent lock vanishes with %s', code => {
    fs.mkdirSync(path.join(root, '.aiwg/memory'), { recursive: true });
    const lock = path.join(root, '.aiwg/memory/line-memory.lock');
    fs.writeFileSync(lock, 'Concurrent owner');
    let disappeared = false;
    const resolveRealPath = (candidate: string): string => {
      if (candidate === lock && !disappeared) {
        disappeared = true;
        fs.rmSync(lock);
        throw Object.assign(new Error('Concurrent lock removal'), { code });
      }
      return fs.realpathSync(candidate);
    };
    expect(assertProjectRelativePath(root, '.aiwg/memory/line-memory.lock', resolveRealPath)).toBe(lock);
    expect(disappeared).toBe(true);
  });

  it('demotes and promotes without changing source, scope or authority', async () => {
    seed();
    const store = owner();
    const original = (await store.records())[0];
    const demote = await operation('demote', store);
    demote.to.placement = 'indexed';
    await store.apply(demote, 'demote');
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toBe('');
    expect(metadata().entries[handle].value).toBe('Keep a verified source');
    const indexed = (await store.records())[0];
    expect(indexed).toMatchObject({ id: original.id, scope: original.scope, authority: original.authority, placement: 'indexed', lifecycle: 'active' });
    const promote = await operation('promote', store);
    promote.to.placement = 'resident';
    await store.apply(promote, 'promote');
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toBe('Keep a verified source\n');
    expect((await store.records())[0].authority).toEqual(original.authority);
  });

  it('compares merge authority independent of key order and keeps successor lineage and observation fresh', async () => {
    seed({ second: true });
    const before = metadata();
    before.entries[handle].maintenance.mergedFrom = ['sha256:' + '1'.repeat(64)];
    before.entries[handle].maintenance.splitFrom = ['sha256:' + '2'.repeat(64)];
    const originalAuthority = before.entries[second].maintenance.authority;
    before.entries[second].maintenance.authority = {
      protection: originalAuthority.protection, source: originalAuthority.source, owner: originalAuthority.owner,
    };
    fs.writeFileSync(path.join(root, meta), JSON.stringify(before));
    const store = owner();
    const records = await store.records();
    const merge = await operation('merge', store, records[0]);
    merge.related = [{ id: records[1].id, digest: records[1].digest, version: records[1].version }];
    merge.replacements = [{ key: 'merged', value: 'New consolidated fact' }];
    await store.apply(merge, 'authority-order');
    const successor = (await store.records()).find(record => record.lifecycle === 'active')!;
    expect(successor.mergedFrom).toEqual(records.map(record => record.id));
    expect(successor.splitFrom).toEqual([]);
    expect(successor.supersedes).toEqual([]);
    expect(successor.observation.evidence?.at).not.toBe(records[0].observation.evidence?.at);
    expect(successor.observation.evidence?.source).toBe(successor.sourcePath);
  });

  it('recategorizes in the owner sidecar without changing axes', async () => {
    seed();
    const store = owner();
    const op = await operation('recategorize', store);
    op.category = 'project-guidance';
    await store.apply(op, 'category');
    expect(metadata().entries[handle].maintenance.category).toBe('project-guidance');
    expect((await store.records())[0]).toMatchObject({ placement: 'resident', lifecycle: 'active', scope: 'project' });
  });

  it.each(['supersede', 'split', 'merge'] as const)('retains immutable originals, aliases and lineage on %s', async opName => {
    seed({ second: opName === 'merge' });
    const store = owner();
    const original = (await store.records())[0];
    const op = await operation(opName, store);
    op.replacements = [{ key: 'first', value: 'Replacement source fact' }, ...(opName === 'split' ? [{ key: 'second', value: 'Another replacement fact' }] : [])];
    if (opName === 'merge') {
      const related = (await store.records())[1];
      op.related = [{ id: related.id, digest: related.digest, version: related.version }];
    }
    await store.apply(op, `replace-${opName}`);
    const records = await store.records();
    const retained = records.find(item => item.id === original.id)!;
    expect(retained).toMatchObject({ lifecycle: 'superseded', aliases: [handle] });
    expect(metadata().entries[handle].value).toBe('Keep a verified source');
    const successors = records.filter(item => item.lifecycle === 'active');
    const field = opName === 'supersede' ? 'supersedes' : opName === 'merge' ? 'mergedFrom' : 'splitFrom';
    expect(successors).toHaveLength(opName === 'split' ? 2 : 1);
    for (const item of successors) {
      expect(item[field]).toContain(original.id);
      expect(item.authority).toEqual(original.authority);
      expect(item.scope).toBe(original.scope);
    }
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).not.toContain('Keep a verified source');
  });

  it('retires with a tombstone, retains source files and restores the same handle with history', async () => {
    seed();
    const store = owner();
    const retire = await operation('retire', store);
    await store.apply(retire, 'retire');
    const retired = (await store.records())[0];
    expect(retired.tombstone).toMatchObject({ id: retired.id, digest: retired.digest, disposition: 'retired', reviewer: 'operator' });
    expect(fs.readFileSync(path.join(root, 'source.md'), 'utf8')).toBe('Original source must survive retirement');
    expect(metadata().entries[handle].value).toBe('Keep a verified source');
    await store.apply(await operation('restore', store), 'restore');
    expect((await store.records())[0]).toMatchObject({ id: retired.id, aliases: [handle], lifecycle: 'active', version: 3 });
    expect(metadata().entries[handle].maintenance.history[1].tombstone.disposition).toBe('retired');
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toBe('Keep a verified source\n');
  });

  it('rejects stale content, stale configuration and concurrent exact previews', async () => {
    seed();
    const store = owner();
    const stale = await operation('retire', store);
    fs.appendFileSync(path.join(root, memory), 'Concurrent write\n');
    await expect(store.apply(stale, 'stale')).rejects.toThrow(/Stale/);
    const configStale = await operation('retire', store);
    fs.writeFileSync(path.join(root, '.aiwg/memory/line-memory.config.json'), JSON.stringify({ maxLines: 201 }));
    await expect(store.apply(configStale, 'stale-config')).rejects.toThrow(/Stale/);
    const a = await operation('recategorize', store); a.category = 'a';
    const b = await operation('recategorize', store); b.category = 'b';
    const results = await Promise.allSettled([store.apply(a, 'a'), store.apply(b, 'b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('commits durable owner receipts and resumes the exact operation idempotently', async () => {
    seed();
    const store = owner();
    const op = await operation('retire', store);
    const receipt = await store.apply(op, 'crashed-after-owner');
    const disk = fs.readFileSync(path.join(root, meta), 'utf8');
    expect(await owner().receipt('crashed-after-owner')).toEqual(receipt);
    expect(await owner().apply(op, 'crashed-after-owner')).toEqual(receipt);
    expect(fs.readFileSync(path.join(root, meta), 'utf8')).toBe(disk);
    await expect(store.apply({ ...op, rationale: 'Changed review' }, 'crashed-after-owner')).rejects.toThrow(/collision/);
  });

  it('refreshes stale private aggregate index entries after apply and receipt recovery', async () => {
    seed();
    const store = owner();
    const indexDirectory = path.join(root, '.aiwg/.index');
    const seedStaleIndex = () => {
      fs.mkdirSync(indexDirectory, { recursive: true });
      for (const graph of ['', 'project']) {
        fs.mkdirSync(path.join(indexDirectory, graph), { recursive: true });
        fs.writeFileSync(path.join(indexDirectory, graph, 'metadata.json'), JSON.stringify({ entries: { [meta]: { path: meta } } }));
      }
    };
    seedStaleIndex();
    const request = await operation('recategorize', store); request.category = 'storage';
    await store.apply(request, 'publish-index');
    expect(loadMetadataIndex(root)?.entries[meta]).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(indexDirectory, 'project/metadata.json'), 'utf8')).entries[meta]).toBeUndefined();
    seedStaleIndex();
    expect(await store.receipt('publish-index')).toBeDefined();
    expect(loadMetadataIndex(root)?.entries[meta]).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(indexDirectory, 'project/metadata.json'), 'utf8')).entries[meta]).toBeUndefined();
  });

  it('recovers a prepared owner transaction after interruption between file writes', async () => {
    seed();
    const store = owner();
    const op = await operation('retire', store);
    const before = fs.readFileSync(path.join(root, meta), 'utf8');
    const receipt = await store.apply(op, 'interrupted-owner');
    const after = fs.readFileSync(path.join(root, meta), 'utf8');
    fs.writeFileSync(path.join(root, meta), before);
    const transactions = path.join(root, '.aiwg/memory/transactions');
    fs.mkdirSync(transactions, { recursive: true });
    fs.writeFileSync(path.join(transactions, 'interrupted.json'), JSON.stringify({
      schemaVersion: 'aiwg.line-memory.transaction.v1', memoryPath: memory, metadataPath: meta,
      memoryContent: '', metadataContent: after,
    }));
    expect(await store.pending(op)).toBe(true);
    expect(await store.pending({ ...op, rationale: 'Different operation' })).toBe(false);
    await expect(store.validate(op)).resolves.toBeUndefined();
    expect(await store.apply(op, 'interrupted-owner')).toEqual(receipt);
    expect((await store.records())[0].lifecycle).toBe('retired');
    expect(fs.readdirSync(transactions)).toEqual([]);
  });

  it('prevents import and stale resident reconciliation from resurrecting retired facts', async () => {
    seed();
    const store = owner();
    await store.apply(await operation('retire', store), 'retire');
    expect((await runLineMemory('import', ['Keep a verified source', '--source-ref', 'source.md',
      '--reviewer', 'operator', '--confirm'], root)).exitCode).toBe(1);
    fs.writeFileSync(path.join(root, memory), 'Keep a verified source\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await runLineMemory('list', ['--json', '--no-touch'], root)).exitCode).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).entries).toEqual([]);
    expect((await store.records())[0].lifecycle).toBe('retired');
    expect(Object.keys(metadata().entries)).toEqual([handle]);
  });

  it('verifies retrieval under the owner lock before removing any resident text', async () => {
    seed();
    let called = false;
    const store = owner(async () => {
      called = true;
      expect(fs.existsSync(path.join(root, '.aiwg/memory/line-memory.lock'))).toBe(true);
      expect(fs.readFileSync(path.join(root, memory), 'utf8')).toContain('Keep a verified source');
      return false;
    });
    const op = await operation('demote', store); op.to.placement = 'indexed';
    const before = fs.readFileSync(path.join(root, meta), 'utf8');
    await expect(store.apply(op, 'offline-index')).rejects.toThrow(/retrieval/);
    expect(called).toBe(true);
    expect(fs.readFileSync(path.join(root, meta), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toContain('Keep a verified source');
  });

  it('refuses pinned age retirement and implicit scope changes', async () => {
    seed({ pinned: true });
    const store = owner();
    const op = await operation('retire', store); op.review!.retirementBasis = 'age';
    await expect(store.apply(op, 'age')).rejects.toThrow(/Pinned/);
    op.review!.retirementBasis = 'review'; op.scope = 'global';
    await expect(store.apply(op, 'scope')).rejects.toThrow(/scope/);
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toContain('Keep a verified source');
  });

  it('preserves pinned mandatory facts during native recency pruning', async () => {
    seed({ pinned: true, maxLines: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await runLineMemory('add', ['New unprotected fact'], root)).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toBe('Keep a verified source\n');
    expect((await owner().records()).find(item => item.aliases.includes(handle))!.lifecycle).toBe('active');
  });

  it('keeps maintenance revisions and tombstones consistent when native archive is used later', async () => {
    seed();
    const store = owner();
    const op = await operation('recategorize', store); op.category = 'reviewed';
    await store.apply(op, 'category');
    expect((await runLineMemory('archive', [handle, '--confirm', '--reviewer', 'operator'], root)).exitCode).toBe(0);
    expect((await store.records())[0]).toMatchObject({ lifecycle: 'retired', version: 3,
      tombstone: { disposition: 'retired', reviewer: 'operator' } });
    expect(metadata().entries[handle].maintenance.tombstone.disposition).toBe('retired');
  });

  it('refuses a split exceeding resident capacity instead of pruning unrelated facts', async () => {
    seed({ second: true, maxLines: 2 });
    const store = owner();
    const op = await operation('split', store);
    op.replacements = [{ key: 'one', value: 'First split fact' }, { key: 'two', value: 'Second split fact' }];
    await expect(store.apply(op, 'capacity')).rejects.toThrow(/capacity/);
    expect(fs.readFileSync(path.join(root, memory), 'utf8')).toBe('Keep a verified source\nKeep a second source\n');
  });
});
