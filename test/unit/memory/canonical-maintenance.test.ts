import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanonicalContextRepository, canonicalMemoryRecord, type CanonicalContextProposal } from '../../../src/memory/canonical-context.js';
import { CanonicalMaintenanceOwner } from '../../../src/memory/canonical-maintenance.js';
import { loadMetadataIndex } from '../../../src/artifacts/index-reader.js';
import type { MaintenanceOperation } from '../../../src/memory/maintenance-contract.js';
import type { MaintenancePlan } from '../../../src/memory/maintenance-contract.js';
import { MaintenancePlanSchema } from '../../../src/memory/maintenance-contract.js';
import { maintenanceOperationKey, verifyMaintenancePlan } from '../../../src/memory/maintenance.js';

let root: string;
let repository: CanonicalContextRepository;
let owner: CanonicalMaintenanceOwner;
const proposal: CanonicalContextProposal = {
  target: 'decision', key: 'database', value: 'Use the existing database.',
  sourceRef: 'decision.md', sourceDigest: null, reviewer: 'operator', reason: 'Reviewed decision',
  scope: 'project', classification: 'internal', reviewAt: null, expiresAt: null,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-canonical-maintenance-'));
  repository = new CanonicalContextRepository(root);
  repository.confirm({ preview: repository.previewUpsert(proposal), proposal });
  owner = new CanonicalMaintenanceOwner(root, { verifyRetrieval: async () => true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function operation(op: MaintenanceOperation['op'], overrides: Partial<MaintenanceOperation> = {}): Promise<MaintenanceOperation> {
  const record = (await owner.records())[0];
  const to = { placement: record.placement, lifecycle: record.lifecycle };
  if (op === 'demote') to.placement = 'indexed';
  if (op === 'promote') to.placement = 'resident';
  if (op === 'retire') to.lifecycle = 'retired';
  if (['supersede', 'merge', 'split'].includes(op)) to.lifecycle = 'superseded';
  if (op === 'restore') to.lifecycle = 'active';
  return {
    op, target: { id: record.id, digest: record.digest, version: record.version },
    precondition: { digest: record.digest, version: record.version },
    from: { placement: record.placement, lifecycle: record.lifecycle }, to,
    scope: record.scope, rationale: 'Reviewed maintenance', uncertainty: 'Reviewed synthetic fixture',
    impactedLinks: [], sessionEffect: 'next-session',
    owner: { name: owner.name, handle: record.aliases[0], snapshot: await owner.snapshot() },
    review: { reviewer: 'operator', retirementBasis: 'review' }, ...overrides,
  };
}

describe('canonical maintenance owner', () => {
  it.each(['recategorize', 'demote', 'retire', 'restore', 'merge', 'split', 'supersede'] as const)('verifies %s with exact receipts, history and no index refresh', async name => {
    if (name === 'restore') await owner.apply(await operation('retire'), 'prior-retirement');
    if (name === 'merge') {
      const second = { ...proposal, key: 'other', value: 'Second reviewed decision' };
      repository.confirm({ preview: repository.previewUpsert(second), proposal: second });
    }
    const op = await operation(name);
    if (name === 'recategorize') op.category = 'reviewed';
    if (['merge', 'split', 'supersede'].includes(name)) {
      op.replacements = [{ key: 'replacement', value: 'Reviewed replacement' }];
      if (name === 'split') op.replacements.push({ key: 'second', value: 'Second reviewed replacement' });
      if (name === 'merge') {
        const related = (await owner.records())[1];
        op.related = [{ id: related.id, digest: related.digest, version: related.version }];
      }
    }
    const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [op] };
    const key = maintenanceOperationKey(plan, 0); await owner.apply(MaintenancePlanSchema.parse(plan).operations[0], key);
    const snapshot = await owner.snapshot();
    const indexFile = join(root, '.aiwg/.index/metadata.json');
    const stale = JSON.stringify({ entries: { aggregate: { path: '.aiwg/context/compound-memory/context.json' } } });
    writeFileSync(indexFile, stale);
    expect((await verifyMaintenancePlan(plan, [owner])).findings).toEqual([]);
    expect(await owner.snapshot()).toBe(snapshot);
    expect(readFileSync(indexFile, 'utf8')).toBe(stale);
    expect(existsSync(join(root, '.aiwg/context/compound-memory/.lock'))).toBe(false);
    const state = repository.read();
    state.entries[op.owner!.handle].maintenance!.history = [];
    if (name === 'recategorize') state.entries[op.owner!.handle].maintenance!.category = 'drift';
    writeFileSync(join(root, '.aiwg/context/compound-memory/context.json'), JSON.stringify(state));
    const findings = (await verifyMaintenancePlan(plan, [owner])).findings.join(' ');
    expect(findings).toMatch(/history/);
    if (name === 'recategorize') expect(findings).toMatch(/category/);
  });
  it('previews read-only, demotes and promotes without changing scope, authority or source content', async () => {
    const before = (await owner.records())[0];
    const request = await operation('demote');
    const snapshot = await owner.snapshot();
    await owner.validate(request);
    expect(await owner.snapshot()).toBe(snapshot);
    await owner.apply(request, 'demotion');
    expect(repository.residentEntries()).toEqual([]);
    expect(repository.export().entries[0].value).toBe(proposal.value);
    expect((await owner.records())[0]).toMatchObject({ placement: 'indexed', scope: before.scope, authority: before.authority });
    await owner.apply(await operation('promote'), 'promotion');
    expect(repository.residentEntries()).toHaveLength(1);
  });

  it('requires retrieval before resident removal, including retirement', async () => {
    const unverified = new CanonicalMaintenanceOwner(root);
    const before = await owner.snapshot();
    await expect(unverified.apply(await operation('demote'), 'unsafe')).rejects.toThrow(/retrieval/i);
    await expect(unverified.apply(await operation('retire'), 'unsafe-retire')).rejects.toThrow(/retrieval/i);
    expect(await owner.snapshot()).toBe(before);
    expect(await owner.receipt('unsafe')).toBeUndefined();
  });

  it('recategorizes through the canonical owner and retains authority', async () => {
    const before = (await owner.records())[0];
    await owner.apply(await operation('recategorize', { category: 'storage' }), 'category');
    expect(Object.values(repository.read().entries)[0].maintenance?.category).toBe('storage');
    expect((await owner.records())[0]).toMatchObject({ authority: before.authority, scope: before.scope, placement: before.placement });
  });

  it.each(['supersede', 'split'] as const)('preserves immutable original value and %s lineage', async op => {
    const original = (await owner.records())[0];
    const replacements = [{ key: 'new.database', value: 'Reviewed replacement decision.' }];
    if (op === 'split') replacements.push({ key: 'database.history', value: 'Retained decision history.' });
    await owner.apply(await operation(op, { replacements }), op);
    const records = await owner.records();
    expect(records.find(record => record.id === original.id)).toMatchObject({ lifecycle: 'superseded', tombstone: { digest: original.digest } });
    expect(Object.values(repository.read().entries)[0].value).toBe(proposal.value);
    for (const record of records.filter(record => record.lifecycle === 'active')) {
      expect(op === 'split' ? record.splitFrom : record.supersedes).toEqual([original.id]);
      expect(record.authority).toEqual(original.authority);
      expect(record.aliases).toContain(original.id);
    }
  });

  it('starts replacement lineage and observation from the new canonical identity', async () => {
    const state = repository.read();
    const entry = Object.values(state.entries)[0];
    const original = canonicalMemoryRecord(entry);
    const { version, scope, placement, lifecycle, authority, aliases, supersedes, tombstone } = original;
    entry.updatedAt = '2025-01-01T00:00:00.000Z';
    entry.maintenance = { version, scope, placement, lifecycle, authority, aliases, supersedes, tombstone,
      mergedFrom: ['legacy-merge'], splitFrom: ['legacy-split'] };
    writeFileSync(join(root, '.aiwg/context/compound-memory/context.json'), JSON.stringify(state));
    await owner.apply(await operation('supersede', {
      replacements: [{ key: 'fresh.database', value: 'Fresh canonical decision' }],
    }), 'fresh-replacement');
    const successor = (await owner.records()).find(record => record.lifecycle === 'active')!;
    expect(successor).toMatchObject({ supersedes: [original.id], mergedFrom: [], splitFrom: [],
      observation: { status: 'on-disk', evidence: { source: successor.sourcePath } } });
    expect(successor.observation.evidence?.at).not.toBe(entry.updatedAt);
  });

  it('refreshes stale private aggregate index entries after apply and receipt recovery', async () => {
    const indexDirectory = join(root, '.aiwg/.index');
    const aggregate = '.aiwg/context/compound-memory/context.json';
    const seedStaleIndex = () => {
      mkdirSync(indexDirectory, { recursive: true });
      for (const graph of ['', 'project']) {
        mkdirSync(join(indexDirectory, graph), { recursive: true });
        writeFileSync(join(indexDirectory, graph, 'metadata.json'), JSON.stringify({ entries: { [aggregate]: { path: aggregate } } }));
      }
    };
    seedStaleIndex();
    const request = await operation('recategorize', { category: 'storage' });
    await owner.apply(request, 'publish-index');
    expect(loadMetadataIndex(root)?.entries[aggregate]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(indexDirectory, 'project/metadata.json'), 'utf8')).entries[aggregate]).toBeUndefined();
    seedStaleIndex();
    expect(await owner.receipt('publish-index')).toBeDefined();
    expect(loadMetadataIndex(root)?.entries[aggregate]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(indexDirectory, 'project/metadata.json'), 'utf8')).entries[aggregate]).toBeUndefined();
  });

  it('merges reviewed exact-version sources through the same owner', async () => {
    const second = { ...proposal, key: 'database.policy', value: 'Keep database history.' };
    repository.confirm({ preview: repository.previewUpsert(second), proposal: second });
    const records = await owner.records();
    const other = records[1];
    await owner.apply(await operation('merge', {
      related: [{ id: other.id, digest: other.digest, version: other.version }],
      replacements: [{ key: 'database.combined', value: 'Use the existing database and retain history.' }],
    }), 'merge');
    const merged = (await owner.records()).find(record => record.lifecycle === 'active')!;
    expect(merged.mergedFrom).toEqual(records.map(record => record.id));
    expect((await owner.records()).filter(record => record.lifecycle === 'superseded')).toHaveLength(2);
  });

  it('rejects stale related sources without committing any mutation', async () => {
    const second = { ...proposal, key: 'database.other', value: 'Another database decision.' };
    repository.confirm({ preview: repository.previewUpsert(second), proposal: second });
    const other = (await owner.records())[1];
    await expect(owner.apply(await operation('merge', {
      related: [{ id: other.id, digest: other.digest, version: other.version + 1 }],
      replacements: [{ key: 'combined', value: 'Combined decision.' }],
    }), 'stale-merge')).rejects.toThrow(/stale/i);
    expect(await owner.receipt('stale-merge')).toBeUndefined();
  });

  it('retires with a tombstone, retains sources, prevents legacy upsert resurrection and restores explicitly', async () => {
    writeFileSync(join(root, 'decision.md'), 'Original source retained');
    await owner.apply(await operation('retire'), 'retire');
    expect((await owner.records())[0]).toMatchObject({ lifecycle: 'retired', tombstone: { reason: 'Reviewed maintenance', reviewer: 'operator' } });
    expect(readFileSync(join(root, 'decision.md'), 'utf8')).toBe('Original source retained');
    expect(repository.residentEntries()).toEqual([]);
    expect(() => repository.previewUpsert(proposal)).toThrow(/restore/);
    const exported = repository.export();
    expect(exported.entries[0].status).toBe('revoked');
    // Re-importing history cannot reactivate the retained canonical identity.
    repository.confirm({ preview: repository.previewImport(exported), bundle: exported });
    expect(repository.residentEntries()).toEqual([]);
    const retired = (await owner.records())[0];
    await owner.apply(await operation('restore'), 'restore');
    expect(repository.residentEntries()).toHaveLength(1);
    expect((await owner.records())[0].tombstone).toBeUndefined();
    const restored = Object.values(repository.read().entries)[0];
    expect(restored.maintenance?.history?.find(item => item.record.lifecycle === 'retired')).toMatchObject({
      record: { tombstone: retired.tombstone },
      disposition: { reviewer: 'operator', reason: 'Reviewed maintenance' },
    });
    await owner.apply(await operation('recategorize', { category: 'restored' }), 'after-restore');
    expect(Object.values(repository.read().entries)[0].maintenance?.history?.find(item => item.record.lifecycle === 'retired')?.record.tombstone).toEqual(retired.tombstone);
  });

  it('retains adopted metadata history through native upsert and revoke operations', async () => {
    await owner.apply(await operation('recategorize', { category: 'storage' }), 'adopt');
    const changed = { ...proposal, value: 'Use the reviewed replacement database.' };
    repository.confirm({ preview: repository.previewUpsert(changed), proposal: changed });
    const state = repository.read();
    const original = Object.values(state.entries).find(entry => entry.value === proposal.value)!;
    expect(original.maintenance?.history).toHaveLength(2);
    expect(original.maintenance?.tombstone?.disposition).toBe('superseded');
    const originalRevoke = { entryId: original.entryId, reviewer: 'operator', reason: 'Retain original disposition' };
    repository.confirm({ preview: repository.previewRevoke(originalRevoke.entryId, originalRevoke.reviewer, originalRevoke.reason), revoke: originalRevoke });
    expect(repository.read().entries[original.entryId].maintenance?.history?.at(-1)?.record.tombstone?.disposition).toBe('superseded');
    const replacement = Object.values(state.entries).find(entry => entry.value === changed.value)!;
    const revoke = { entryId: replacement.entryId, reviewer: 'operator', reason: 'Withdrawn after review' };
    repository.confirm({ preview: repository.previewRevoke(revoke.entryId, revoke.reviewer, revoke.reason), revoke });
    const adopted = repository.read().entries[replacement.entryId];
    expect(adopted.maintenance?.history).toHaveLength(1);
    expect(adopted.maintenance?.authority).toEqual(original.maintenance?.authority);
    expect(adopted.maintenance?.supersedes).toEqual([canonicalMemoryRecord(original).id]);
    expect(adopted.maintenance?.tombstone?.reason).toBe(revoke.reason);
  });

  it('restores superseded history while preserving successor lineage aliases', async () => {
    const original = (await owner.records())[0];
    await owner.apply(await operation('supersede', {
      replacements: [{ key: 'replacement.database', value: 'Replacement decision.' }],
    }), 'supersede');
    await owner.apply(await operation('restore'), 'restore-original');
    const records = await owner.records();
    expect(records.find(record => record.id === original.id)?.lifecycle).toBe('active');
    // A subsequent reviewed operation resolves canonical identities without alias ambiguity.
    await owner.validate(await operation('recategorize', { category: 'history' }));
  });

  it('rejects age retirement for a pinned constraint', async () => {
    const state = repository.read();
    const entry = Object.values(state.entries)[0];
    const record = canonicalMemoryRecord(entry);
    const { version, scope, placement, lifecycle, authority, aliases, supersedes, mergedFrom, splitFrom } = record;
    entry.maintenance = { version, scope, placement, lifecycle, authority: { ...authority, protection: 'pinned' }, aliases, supersedes, mergedFrom, splitFrom };
    writeFileSync(join(root, '.aiwg/context/compound-memory/context.json'), JSON.stringify(state));
    await expect(owner.apply(await operation('retire', {
      review: { reviewer: 'operator', retirementBasis: 'age' },
    }), 'age')).rejects.toThrow(/pinned/i);
    expect(repository.residentEntries()).toHaveLength(1);
  });

  it('rejects stale snapshots, altered values, concurrent locks and implicit scope changes', async () => {
    const stale = await operation('recategorize', { category: 'storage' });
    await owner.apply(await operation('recategorize', { category: 'decision' }), 'first');
    await expect(owner.apply(stale, 'stale')).rejects.toThrow(/stale/i);
    const fresh = await operation('recategorize', { category: 'storage' });
    const state = repository.read();
    Object.values(state.entries)[0].value = 'Changed outside owner.';
    writeFileSync(join(root, '.aiwg/context/compound-memory/context.json'), JSON.stringify(state));
    await expect(owner.apply(fresh, 'edited')).rejects.toThrow(/stale/i);
    const locked = await operation('recategorize', { category: 'storage' });
    const lockPath = join(root, '.aiwg/context/compound-memory/.lock');
    writeFileSync(lockPath, 'another owner');
    await expect(owner.apply(locked, 'locked')).rejects.toThrow(/EEXIST/);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);
    await expect(owner.apply(await operation('recategorize', { category: 'storage', scope: 'global' }), 'scope')).rejects.toThrow(/scope/);
  });

  it('persists receipt with owner mutation and resumes without a second revision', async () => {
    const request = await operation('recategorize', { category: 'storage' });
    const first = await owner.apply(request, 'crashed-before-coordinator-receipt');
    const revision = repository.read().revision;
    const recovered = new CanonicalMaintenanceOwner(root);
    expect(await recovered.receipt('crashed-before-coordinator-receipt')).toEqual(first);
    expect(await recovered.apply(request, 'crashed-before-coordinator-receipt')).toEqual(first);
    expect(repository.read().revision).toBe(revision);
  });

  it('recovers a provably dead local owner lock and preserves unknown or foreign owners', async () => {
    const lockPath = join(root, '.aiwg/context/compound-memory/.lock');
    const request = await operation('recategorize', { category: 'storage' });
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('synthetic dead process'), { code: 'ESRCH' });
    });
    writeFileSync(lockPath, JSON.stringify({ pid: 987654, host: 'foreign-test-host' }));
    await expect(owner.apply(request, 'foreign')).rejects.toThrow(/EEXIST/);
    expect(probe).not.toHaveBeenCalled();
    writeFileSync(lockPath, '');
    await expect(owner.apply(request, 'unknown')).rejects.toThrow(/EEXIST/);
    expect(probe).not.toHaveBeenCalled();
    writeFileSync(lockPath, JSON.stringify({ pid: 987654, host: hostname() }));
    await owner.apply(request, 'recovered');
    expect(probe).toHaveBeenCalledWith(987654, 0);
    expect(existsSync(lockPath)).toBe(false);
    expect(await owner.receipt('recovered')).toBeDefined();
  });

  it.each(['', '{incomplete owner', 'null', '[]', '{}', '{"pid":0,"host":"local"}'])('recovers an aged unreadable lock left in the legacy create/write crash window: %j', async content => {
    const lockPath = join(root, '.aiwg/context/compound-memory/.lock');
    const request = await operation('recategorize', { category: 'storage' });
    writeFileSync(lockPath, content);
    await expect(owner.apply(request, 'too-fresh')).rejects.toThrow(/EEXIST/);
    const old = new Date(Date.now() - 61_000);
    utimesSync(lockPath, old, old);
    await owner.apply(request, 'recovered-crash-window');
    expect(existsSync(lockPath)).toBe(false);
    expect(await owner.receipt('recovered-crash-window')).toBeDefined();
  });

  it('recovers an aged legacy empty lock for the synchronous upsert path too', () => {
    const lockPath = join(root, '.aiwg/context/compound-memory/.lock');
    writeFileSync(lockPath, '');
    const changed = { ...proposal, key: 'legacy-recovery', value: 'Recovered legacy upsert' };
    const preview = repository.previewUpsert(changed);
    expect(() => repository.confirm({ preview, proposal: changed })).toThrow(/EEXIST/);
    const old = new Date(Date.now() - 61_000);
    utimesSync(lockPath, old, old);
    expect(repository.confirm({ preview, proposal: changed }).operation).toBe('upsert');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('publishes complete owner identity before the lock becomes visible', async () => {
    const lockPath = join(root, '.aiwg/context/compound-memory/.lock');
    const verified = new CanonicalMaintenanceOwner(root, { verifyRetrieval: async () => {
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({ pid: process.pid, host: hostname() });
      return true;
    } });
    await verified.apply(await operation('demote'), 'atomic-owner');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim a live owner lock', async () => {
    const lockPath = join(root, '.aiwg/context/compound-memory/.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname() }));
    await expect(owner.apply(await operation('recategorize', { category: 'storage' }), 'live')).rejects.toThrow(/EEXIST/);
    expect(existsSync(lockPath)).toBe(true);
    expect(await owner.receipt('live')).toBeUndefined();
  });

  it('requires exact current preview confirmation', async () => {
    const request = await operation('recategorize', { category: 'storage' });
    const preview = repository.previewMaintenance(request);
    await expect(repository.confirmMaintenance({
      preview: { ...preview, diff: [] }, operation: request, key: 'altered',
    })).rejects.toThrow(/exact current/);
    expect(await owner.receipt('altered')).toBeUndefined();
  });
});
