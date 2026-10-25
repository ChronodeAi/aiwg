import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dump } from 'js-yaml';
import { ARTIFACT_MEMORY_HISTORY_LIMIT, ArtifactMaintenanceOwner } from '../../../src/artifacts/memory-maintenance.js';
import { buildIndex, parseFrontmatter } from '../../../src/artifacts/index-builder.js';
import { loadMetadataIndex } from '../../../src/artifacts/index-reader.js';
import { getFortemiCoreSyncStatus, syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { discoverCapability, queryIndex, showArtifact } from '../../../src/artifacts/query-engine.js';
import type { MaintenanceOperation } from '../../../src/memory/maintenance-contract.js';
import type { MemoryRecord } from '../../../src/memory/maintenance-record.js';
import { sha256 } from '../../../src/memory/context-pack.js';
import { applyMaintenancePlan, MaintenanceApplyError, maintenancePlanDigest, maintenanceOperationKey, verifyMaintenancePlan } from '../../../src/memory/maintenance.js';
import type { MaintenancePlan } from '../../../src/memory/maintenance-contract.js';
import { MaintenancePlanSchema } from '../../../src/memory/maintenance-contract.js';

let root: string;
let owner: ArtifactMaintenanceOwner;
const first = '.aiwg/wiki/first.md';
const second = '.aiwg/wiki/second.md';
const bodies = { [first]: '# Amber decision\nRetain mandatory connection constraints.\n', [second]: '# Violet decision\nKeep retry bounds.\n' };
const now = () => new Date('2026-10-24T10:00:00.000Z');
async function operation(op: MaintenanceOperation['op'], sourcePath = first): Promise<MaintenanceOperation> {
  const record = (await owner.records()).find(item => item.sourcePath === sourcePath)!;
  return {
    op, target: { id: record.id, digest: record.digest, version: record.version },
    owner: { name: owner.name, handle: record.sourcePath, snapshot: await owner.snapshot() },
    review: { reviewer: 'synthetic operator', retirementBasis: 'review' },
    from: { placement: record.placement, lifecycle: record.lifecycle },
    to: { placement: record.placement, lifecycle: op === 'retire' ? 'retired' : op === 'restore' ? 'active'
      : ['merge', 'split', 'supersede'].includes(op) ? 'superseded' : record.lifecycle },
    scope: record.scope, rationale: 'Reviewed synthetic maintenance', uncertainty: 'No live session observation',
    impactedLinks: [sourcePath], sessionEffect: 'next-session', precondition: { digest: record.digest, version: record.version },
  };
}
function source(sourcePath = first) { return parseFrontmatter(fs.readFileSync(path.join(root, sourcePath), 'utf8')); }
function record(sourcePath = first): MemoryRecord { return source(sourcePath).data.memoryRecord as MemoryRecord; }
async function rebuild() {
  await buildIndex(root, { force: true, quiet: true, workers: 0 });
  await buildIndex(root, { graph: 'project', force: true, quiet: true, workers: 0 });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-artifact-maintenance-'));
  fs.mkdirSync(path.join(root, '.aiwg/wiki'), { recursive: true });
  for (const [file, body] of Object.entries(bodies)) fs.writeFileSync(path.join(root, file), `---\ntype: skill\nname: ${file === first ? 'amber' : 'violet'}\n---\n${body}`);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await rebuild();
  owner = new ArtifactMaintenanceOwner(root, { now });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('semantic-memory owner maintenance', () => {
  it.each(['recategorize', 'demote', 'retire', 'restore', 'merge', 'split', 'supersede'] as const)('verifies %s receipts, source history and all published index revisions read-only', async name => {
    if (name === 'restore') await owner.apply(await operation('retire'), 'prior-retirement');
    if (name === 'demote') {
      const promote = await operation('promote'); promote.to.placement = 'resident'; await owner.apply(promote, 'prior-promotion');
    }
    const op = await operation(name);
    if (name === 'recategorize') op.category = 'reviewed';
    if (name === 'demote') op.to.placement = 'indexed';
    if (['merge', 'split', 'supersede'].includes(name)) {
      op.replacements = [{ key: 'replacement', value: '# Reviewed replacement\n', sourcePath: '.aiwg/wiki/replacement.md' }];
      if (name === 'split') op.replacements.push({ key: 'second', value: '# Second reviewed replacement\n', sourcePath: '.aiwg/wiki/second-replacement.md' });
      if (name === 'merge') {
        const related = (await owner.records()).find(item => item.sourcePath === second)!;
        op.related = [{ id: related.id, digest: related.digest, version: related.version }];
      }
    }
    const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [op] };
    await owner.apply(MaintenancePlanSchema.parse(plan).operations[0], maintenanceOperationKey(plan, 0));
    const snapshot = await owner.snapshot();
    expect((await verifyMaintenancePlan(plan, [owner])).findings).toEqual([]);
    expect(await owner.snapshot()).toBe(snapshot);
    const metadataFile = path.join(root, '.aiwg/.index/project/metadata.json');
    const index = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    index.entries[first].memoryRecord.version++;
    const stale = JSON.stringify(index); fs.writeFileSync(metadataFile, stale);
    expect((await verifyMaintenancePlan(plan, [owner])).findings.join(' ')).toMatch(/Published index revision/);
    expect(fs.readFileSync(metadataFile, 'utf8')).toBe(stale);
    const current = source();
    const journal = current.data.memoryMaintenance as { history: MemoryRecord[] };
    journal.history = [];
    fs.writeFileSync(path.join(root, first), `---\n${dump(current.data, { noRefs: true, lineWidth: -1 })}---\n${current.body}`);
    expect((await verifyMaintenancePlan(plan, [owner])).findings.join(' ')).toMatch(/history/);
  });
  it('reports source body drift and forged operation receipts without mutating malformed state', async () => {
    const op = await operation('recategorize'); op.category = 'reviewed';
    const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [op] };
    await owner.apply(MaintenancePlanSchema.parse(plan).operations[0], maintenanceOperationKey(plan, 0));
    const current = source();
    const journal = current.data.memoryMaintenance as { receipts: Array<{ operationDigest: string }> };
    journal.receipts[0].operationDigest = sha256('another operation');
    fs.writeFileSync(path.join(root, first), `---\n${dump(current.data, { noRefs: true, lineWidth: -1 })}---\n${current.body}Changed source body\n`);
    const before = fs.readFileSync(path.join(root, first), 'utf8');
    const findings = (await verifyMaintenancePlan(plan, [owner])).findings.join(' ');
    expect(findings).toMatch(/drifted/); expect(findings).toMatch(/exact reviewed operation/);
    expect(fs.readFileSync(path.join(root, first), 'utf8')).toBe(before);
    fs.writeFileSync(path.join(root, first), `---\n${dump({ ...current.data, memoryMaintenance: { receipts: 'malformed' } })}---\n${current.body}`);
    await expect(verifyMaintenancePlan(plan, [owner])).rejects.toThrow(/Invalid artifact maintenance journal/);
  });
  it('keeps unrelated maintenance available when a source has quarantined memory metadata', async () => {
    const malformed = source(second);
    fs.writeFileSync(path.join(root, second), `---\n${dump({ ...malformed.data, memoryRecord: { schemaVersion: 'broken' } })}---\n${malformed.body}`);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await rebuild();
    await owner.apply(await operation('retire'), 'quarantined-neighbor');
    expect(record().lifecycle).toBe('retired');
    expect(loadMetadataIndex(root)?.entries[second]).toBeDefined();
    expect(source(second).body).toBe(bodies[second]);
    expect(warnings.mock.calls.some(([message]) => String(message).includes('quarantined'))).toBe(true);
  });
  it('bounds retained frontmatter revisions and chains a digest of trimmed history across retries', async () => {
    const initial = (await owner.records()).find(item => item.sourcePath === first)!;
    const history = Array.from({ length: ARTIFACT_MEMORY_HISTORY_LIMIT + 2 }, (_, index) => ({ ...initial, version: index + 1 }));
    const current = { ...initial, version: history.length + 1 };
    const original = source();
    fs.writeFileSync(path.join(root, first), `---\n${dump({ ...original.data, memoryRecord: current,
      memoryMaintenance: { receipts: [], history } }, { noRefs: true, lineWidth: -1 })}---\n${original.body}`);
    await rebuild();
    let fail = true;
    owner = new ArtifactMaintenanceOwner(root, { now, rebuild: async () => { if (fail) throw new Error('publication interrupted'); await rebuild(); } });
    const preview = await operation('recategorize'); preview.category = 'reviewed';
    await expect(owner.apply(preview, 'bounded')).rejects.toThrow('publication interrupted');
    const compact = source().data.memoryMaintenance as { history: MemoryRecord[]; trimmedHistory: { count: number; digest: string } };
    expect(compact.history.map(item => item.version)).toEqual(Array.from({ length: ARTIFACT_MEMORY_HISTORY_LIMIT }, (_, index) => index + 4));
    expect(compact.trimmedHistory).toEqual({ count: 3, digest: sha256(JSON.stringify({ previous: null, records: history.slice(0, 3) })) });
    fail = false;
    await owner.apply(preview, 'bounded');
    expect(source().data.memoryMaintenance).toMatchObject({ history: compact.history, trimmedHistory: compact.trimmedHistory });
    const next = await operation('recategorize'); next.category = 'reviewed-again';
    await owner.apply(next, 'bounded-next');
    const final = source().data.memoryMaintenance as typeof compact;
    expect(final.history).toHaveLength(ARTIFACT_MEMORY_HISTORY_LIMIT);
    expect(final.trimmedHistory.count).toBe(4);
    expect(final.trimmedHistory.digest).toBe(sha256(JSON.stringify({ previous: compact.trimmedHistory, records: [compact.history[0]] })));
    expect(source().body).toBe(bodies[first]);
  });

  it('gives replacement records fresh lineage and on-disk observations', async () => {
    const initial = (await owner.records()).find(item => item.sourcePath === first)!;
    const original = source();
    const stamped: MemoryRecord = { ...initial, mergedFrom: ['old-merge'], splitFrom: ['old-split'], supersedes: ['old-supersession'],
      observation: { status: 'observed', evidence: { source: 'old-runtime', at: '2020-01-01T00:00:00.000Z', session: 'old-session', provider: 'old-provider', version: 'v0' } } };
    fs.writeFileSync(path.join(root, first), `---\n${dump({ ...original.data, memoryRecord: stamped }, { noRefs: true, lineWidth: -1 })}---\n${original.body}`);
    await rebuild();
    const preview = await operation('supersede');
    const replacementPath = '.aiwg/wiki/new.md';
    preview.replacements = [{ key: 'new', sourcePath: replacementPath, value: '# Newly reviewed fact\n' }];
    await owner.apply(preview, 'fresh-replacement');
    expect(record(replacementPath)).toMatchObject({ supersedes: [initial.id], mergedFrom: [], splitFrom: [],
      observation: { status: 'on-disk', evidence: { source: replacementPath, at: now().toISOString(), session: null, provider: null, version: null } } });
    expect(record()).toMatchObject({ mergedFrom: ['old-merge'], splitFrom: ['old-split'], observation: stamped.observation });
  });
  it('promotes, demotes and recategorizes through canonical source metadata without changing authority or scope', async () => {
    const before = (await owner.records())[0];
    const promote = await operation('promote');
    promote.to.placement = 'resident';
    await owner.apply(promote, 'promote');
    expect(record().placement).toBe('resident');
    const demote = await operation('demote');
    demote.to.placement = 'indexed';
    expect(await owner.verifyRetrieval(demote)).toBe(true);
    await owner.apply(demote, 'demote');
    const category = await operation('recategorize');
    category.category = 'reviewed-decisions';
    await owner.apply(category, 'category');
    expect(source().data.memoryCategory).toBe('reviewed-decisions');
    expect(record()).toMatchObject({ authority: before.authority, scope: before.scope, version: 4, placement: 'indexed' });
    expect(source().body).toBe(bodies[first]);
  });

  it('retires with a tombstone, keeps original source and excludes rebuilt query/discovery results; restore reverses it', async () => {
    await owner.apply(await operation('retire'), 'retire');
    expect(fs.existsSync(path.join(root, first))).toBe(true);
    expect(record().tombstone).toMatchObject({ reason: 'Reviewed synthetic maintenance', reviewer: 'synthetic operator', disposition: 'retired' });
    expect(source().body).toBe(bodies[first]);
    expect(loadMetadataIndex(root)?.entries[first].memoryRecord?.lifecycle).toBe('retired');
    vi.mocked(console.log).mockClear();
    await queryIndex(root, { text: 'Amber' }, { backend: 'local', json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string).results).toHaveLength(0);
    await rebuild(); // Regeneration consumes canonical lifecycle, retaining history without resurrecting it.
    expect(loadMetadataIndex(root)?.entries[first].memoryRecord?.lifecycle).toBe('retired');
    const output = vi.mocked(console.log);
    output.mockClear();
    await queryIndex(root, { text: 'Amber' }, { backend: 'local', json: true });
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).results).toHaveLength(0);
    output.mockClear();
    await discoverCapability(root, { phrase: 'Amber', graph: 'project', backend: 'local', json: true });
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).results).toHaveLength(0);
    output.mockClear();
    await showArtifact(root, { name: 'amber', graph: 'project', backend: 'local', json: true, body: true });
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).content).toContain(bodies[first]);
    await owner.apply(await operation('restore'), 'restore');
    expect(record().lifecycle).toBe('active');
    expect(record().tombstone).toBeUndefined();
    expect(source().body).toBe(bodies[first]);
    const history = (source().data.memoryMaintenance as { history: MemoryRecord[] }).history;
    expect(history.find(item => item.lifecycle === 'retired')?.tombstone).toMatchObject({ disposition: 'retired', reviewer: 'synthetic operator' });
  });

  it.each(['supersede', 'split', 'merge'] as const)('%s preserves originals, aliases and replacement lineage', async op => {
    const preview = await operation(op);
    const original = (await owner.records()).find(item => item.sourcePath === first)!;
    preview.replacements = [{ key: 'replacement-a', sourcePath: '.aiwg/wiki/replacement-a.md', value: '# Replacement A\nReviewed combined facts.\n' }];
    if (op === 'split') preview.replacements.push({ key: 'replacement-b', sourcePath: '.aiwg/wiki/replacement-b.md', value: '# Replacement B\nOther retained facts.\n' });
    const related = (await owner.records()).find(item => item.sourcePath === second)!;
    if (op === 'merge') preview.related = [{ id: related.id, digest: related.digest, version: related.version }];
    await owner.apply(preview, op);
    expect(record().lifecycle).toBe('superseded');
    expect(source().body).toBe(bodies[first]);
    expect(record().aliases).toContain(first);
    const replacement = record('.aiwg/wiki/replacement-a.md');
    const lineage = op === 'split' ? replacement.splitFrom : op === 'merge' ? replacement.mergedFrom : replacement.supersedes;
    expect(lineage).toContain(original.id);
    expect(replacement.authority).toEqual(original.authority);
    expect(replacement.scope).toBe(original.scope);
    if (op === 'merge') { expect(lineage).toContain(related.id); expect(record(second).lifecycle).toBe('superseded'); }
    if (op === 'split') expect(record('.aiwg/wiki/replacement-b.md').splitFrom).toContain(original.id);
  });

  it('rejects stale body digests, whole-owner concurrent plans and mismatched scope', async () => {
    const stale = await operation('retire');
    fs.appendFileSync(path.join(root, first), 'New operator fact.\n');
    await expect(owner.apply(stale, 'stale')).rejects.toThrow(/Stale/);
    await rebuild();
    const scope = await operation('retire'); scope.scope = 'global';
    await expect(owner.apply(scope, 'scope')).rejects.toThrow(/scope/);
    const concurrent = await operation('retire', second);
    const fresh = await operation('recategorize'); fresh.category = 'new-category';
    await owner.apply(fresh, 'fresh');
    await expect(owner.apply(concurrent, 'concurrent')).rejects.toThrow(/Stale/);
  });

  it('refuses pinned mandatory constraints for age retirement', async () => {
    fs.writeFileSync(path.join(root, first), `---\npinned: true\n---\n${bodies[first]}`);
    await rebuild();
    const preview = await operation('retire'); preview.review!.retirementBasis = 'age';
    await expect(owner.apply(preview, 'age')).rejects.toThrow(/Pinned/);
    expect(source().data.memoryRecord).toBeUndefined();
    expect(source().body).toBe(bodies[first]);
  });

  it('verifies a published digest and rejects missing or stale indexes before resident removal', async () => {
    const promote = await operation('promote'); promote.to.placement = 'resident';
    await owner.apply(promote, 'promote');
    const demote = await operation('demote'); demote.to.placement = 'indexed';
    for (const indexPath of ['.aiwg/.index/metadata.json', '.aiwg/.index/project/metadata.json']) {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, indexPath), 'utf8'));
      metadata.entries[first].memoryRecord.digest = sha256('wrong body');
      fs.writeFileSync(path.join(root, indexPath), JSON.stringify(metadata));
    }
    demote.owner!.snapshot = await owner.snapshot();
    expect(await owner.verifyRetrieval(demote)).toBe(false);
    await expect(owner.apply(demote, 'demote')).rejects.toThrow(/Indexed retrieval/);
    expect(record().placement).toBe('resident');
  });

  it('recovers an index failure with a pending journal and no premature receipt, then resumes idempotently', async () => {
    syncFortemiCoreIndex(root);
    expect(getFortemiCoreSyncStatus(root).stale).toBe(false);
    let fail = true;
    owner = new ArtifactMaintenanceOwner(root, { now, rebuild: async () => {
      if (fail) throw new Error('remote index unavailable');
      await rebuild();
    } });
    const preview = await operation('split');
    preview.replacements = [
      { key: 'one', sourcePath: '.aiwg/wiki/one.md', value: '# One\nFirst retained fact.\n' },
      { key: 'two', sourcePath: '.aiwg/wiki/two.md', value: '# Two\nSecond retained fact.\n' },
    ];
    await expect(owner.apply(preview, 'recover')).rejects.toThrow('remote index unavailable');
    expect(record().lifecycle).toBe('superseded');
    expect(await owner.receipt('recover')).toBeUndefined();
    expect(await owner.pending(preview)).toBe(true);
    expect(getFortemiCoreSyncStatus(root)).toMatchObject({ stale: true, sourceIndexNewer: true });
    vi.mocked(console.log).mockClear();
    await queryIndex(root, { text: 'Amber' }, { backend: 'local', json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string).results).toHaveLength(0);
    vi.mocked(console.log).mockClear();
    await discoverCapability(root, { phrase: 'Amber', graph: 'project', backend: 'fortemi-core', json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string).results).toHaveLength(0);
    const other = await operation('retire', second);
    await expect(owner.apply(other, 'other')).rejects.toThrow(/pending/);
    fail = false;
    const receipt = await owner.apply(preview, 'recover');
    expect(await owner.receipt('recover')).toEqual(receipt);
    expect(await owner.pending(preview)).toBe(false);
    const snapshot = await owner.snapshot();
    expect(await owner.apply(preview, 'recover')).toEqual(receipt);
    expect(await owner.snapshot()).toBe(snapshot);
    expect(record().version).toBe(2);
    expect(record('.aiwg/wiki/one.md').version).toBe(1);
  });

  it('rejects an owner lock held by another maintenance operation without touching sources', async () => {
    const preview = await operation('retire');
    fs.mkdirSync(path.join(root, '.aiwg/.index/.semantic-maintenance.lock'));
    await expect(owner.apply(preview, 'locked')).rejects.toThrow(/lock/);
    expect(source().data.memoryRecord).toBeUndefined();
  });

  it('reports index failure truthfully through the coordinator and resumes the exact pending plan', async () => {
    let fail = true;
    owner = new ArtifactMaintenanceOwner(root, { now, rebuild: async () => {
      if (fail) throw new Error('index publication interrupted');
      await rebuild();
    } });
    const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [await operation('retire')] };
    const options = { root, owners: [owner], confirmedDigest: maintenancePlanDigest(plan) };
    try { await applyMaintenancePlan(plan, options); throw new Error('Expected maintenance failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(MaintenanceApplyError);
      expect((error as MaintenanceApplyError).receipt.partial).toMatchObject({ completed: [], pending: [expect.any(String)] });
    }
    expect(record().lifecycle).toBe('retired');
    fail = false;
    const receipt = await applyMaintenancePlan(plan, options);
    expect(receipt.partial).toBeUndefined();
    expect(receipt.ownerReceipts).toHaveLength(1);
    expect(receipt.resumedFrom).toContain('.aiwg/memory/maintenance/');
    expect(record().version).toBe(2);
    expect((source().data.memoryMaintenance as { history: MemoryRecord[] }).history).toHaveLength(1);
  });

  it.each(['authority', 'metadata'])('rejects concurrent source %s changes while recovering an interrupted index publication', async field => {
    owner = new ArtifactMaintenanceOwner(root, { now, rebuild: async () => { throw new Error('index unavailable'); } });
    const preview = await operation('retire');
    await expect(owner.apply(preview, 'pending')).rejects.toThrow('index unavailable');
    const changed = source();
    if (field === 'authority') (changed.data.memoryRecord as MemoryRecord).authority.protection = 'pinned';
    else changed.data.title = 'Concurrent operator review';
    fs.writeFileSync(path.join(root, first), `---\n${dump(changed.data, { noRefs: true, lineWidth: -1 })}---\n${changed.body}`);
    await expect(owner.apply(preview, 'pending')).rejects.toThrow(/changed during pending/);
    expect(source().data).toEqual(changed.data);
    expect(await owner.receipt('pending')).toBeUndefined();
  });

  it('rejects replacement source overwrite and source paths outside the canonical artifact root', async () => {
    const preview = await operation('supersede');
    preview.replacements = [{ key: 'overwrite', sourcePath: second, value: 'New replacement' }];
    await expect(owner.apply(preview, 'overwrite')).rejects.toThrow(/overwrite/);
    preview.replacements = [{ key: 'outside', sourcePath: 'AGENTS.md', value: 'New replacement' }];
    await expect(owner.apply(preview, 'outside')).rejects.toThrow(/canonical/);
    expect(source(second).body).toBe(bodies[second]);
  });
});
