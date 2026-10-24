import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMaintenancePlan, maintenanceOperationKey, maintenancePlanDigest, MaintenanceApplyError, previewMaintenancePlan } from '../../../src/memory/maintenance.js';
import { parseMemoryMaintenanceOptions, runMemoryMaintenanceCli } from '../../../src/memory/maintenance-cli.js';
import type { MaintenanceOwner } from '../../../src/memory/maintenance-owner.js';
import type { MaintenancePlan } from '../../../src/memory/maintenance-contract.js';
import { memoryRecordId, type MemoryRecord } from '../../../src/memory/maintenance-record.js';
import { CanonicalContextRepository } from '../../../src/memory/canonical-context.js';
import { CanonicalMaintenanceOwner } from '../../../src/memory/canonical-maintenance.js';
import { LineMaintenanceOwner } from '../../../src/memory/line-maintenance.js';
import { runLineMemory } from '../../../agentic/code/addons/line-memory/commands/line-memory.mjs';
import { sha256 } from '../../../src/memory/context-pack.js';

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-coordinator-')); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture(name = 'synthetic-owner') {
  const item: MemoryRecord = {
    schemaVersion: 'aiwg.memory-record.v1', id: memoryRecordId(`${name}.md`, sha256(name)), sourcePath: `${name}.md`, digest: sha256(name), version: 1,
    scope: 'project', placement: 'indexed', lifecycle: 'active', authority: { owner: name, source: 'reviewer', protection: 'unprotected' },
    aliases: [name], supersedes: [], mergedFrom: [], splitFrom: [],
    observation: { status: 'on-disk', evidence: { source: name, at: '2026-10-24T00:00:00.000Z', session: null, provider: null, version: null } },
  };
  let snapshot = sha256(name);
  const receipts = new Map<string, unknown>();
  const owner: MaintenanceOwner = {
    name, records: async () => [item], snapshot: async () => snapshot,
    validate: async op => { if (op.owner?.snapshot !== snapshot) throw new Error('Stale owner snapshot'); },
    apply: vi.fn(async (_operation, key) => {
      const prior = receipts.get(key); if (prior) return prior;
      item.version++; snapshot = sha256(`${name}:changed`);
      const receipt = { owner: name, version: item.version }; receipts.set(key, receipt); return receipt;
    }),
    receipt: async key => receipts.get(key),
  };
  const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [{
    op: 'recategorize', target: { id: item.id, digest: item.digest, version: 1 },
    from: { placement: 'indexed', lifecycle: 'active' }, to: { placement: 'indexed', lifecycle: 'active' },
    scope: 'project', rationale: 'Reviewed category', uncertainty: 'No live observation', impactedLinks: [], sessionEffect: 'next-session',
    precondition: { digest: item.digest, version: 1 }, owner: { name, handle: name, snapshot },
    review: { reviewer: 'operator', retirementBasis: 'review' }, category: 'decision',
  }] };
  return { owner, plan, item };
}

describe('maintenance coordinator', () => {
  it('publishes journals despite a stale temporary file from a reused process id', async () => {
    const dir = root(); const { plan, owner } = fixture();
    const journal = path.join(dir, '.aiwg/memory/maintenance', `${maintenancePlanDigest(plan).replace(':', '_')}.json`);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const stale = `${journal}.${process.pid}.tmp`;
    fs.writeFileSync(stale, 'interrupted prior process');
    const receipt = await applyMaintenancePlan(plan, { root: dir, owners: [owner], confirmedDigest: maintenancePlanDigest(plan) });
    expect(receipt.partial).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(journal, 'utf8'))).toEqual(receipt);
    expect(fs.readFileSync(stale, 'utf8')).toBe('interrupted prior process');
  });
  it('preview is read-only and exact digest confirmation precedes any mutation', async () => {
    const dir = root(); const { plan, owner } = fixture();
    await previewMaintenancePlan(plan, [owner]); expect(fs.readdirSync(dir)).toEqual([]);
    await expect(applyMaintenancePlan(plan, { root: dir, owners: [owner], confirmedDigest: sha256('other') })).rejects.toThrow(/exact plan/);
    expect(fs.readdirSync(dir)).toEqual([]); expect(owner.apply).not.toHaveBeenCalled();
  });
  it('recovers owner commits after interruption before coordinator journaling and resumes once', async () => {
    const dir = root(); const a = fixture('a'); const b = fixture('b');
    const plan = { ...a.plan, operations: [...a.plan.operations, ...b.plan.operations] };
    const options = { root: dir, owners: [a.owner, b.owner], confirmedDigest: maintenancePlanDigest(plan) };
    let failure: MaintenanceApplyError | undefined;
    try { await applyMaintenancePlan(plan, { ...options, afterOwner: () => { throw new Error('Injected process interruption'); } }); }
    catch (error) { failure = error as MaintenanceApplyError; }
    expect(failure).toBeInstanceOf(MaintenanceApplyError);
    expect(failure!.receipt.partial).toEqual({ completed: [maintenanceOperationKey(plan, 0)], pending: [maintenanceOperationKey(plan, 1)] });
    expect(b.owner.apply).not.toHaveBeenCalled();
    const resumed = await applyMaintenancePlan(plan, options);
    expect(resumed.partial).toBeUndefined(); expect(resumed.resumedFrom).toContain('.json');
    expect(a.owner.apply).toHaveBeenCalledTimes(1); expect(b.owner.apply).toHaveBeenCalledTimes(1);
    const duplicate = await applyMaintenancePlan(plan, options);
    expect(duplicate.ownerReceipts).toHaveLength(2); expect(b.owner.apply).toHaveBeenCalledTimes(1);
  });
  it('reports remote index failure as pending and resumes without repeating completed owners', async () => {
    const dir = root(); const a = fixture('a'); const b = fixture('b');
    const plan = { ...a.plan, operations: [...a.plan.operations, ...b.plan.operations] };
    const original = b.owner.apply; b.owner.apply = vi.fn().mockRejectedValueOnce(new Error('remote index unavailable')).mockImplementation(original);
    const options = { root: dir, owners: [a.owner, b.owner], confirmedDigest: maintenancePlanDigest(plan) };
    await expect(applyMaintenancePlan(plan, options)).rejects.toMatchObject({ receipt: { partial: { completed: [maintenanceOperationKey(plan, 0)], pending: [maintenanceOperationKey(plan, 1)] } } });
    expect((await applyMaintenancePlan(plan, options)).partial).toBeUndefined(); expect(a.owner.apply).toHaveBeenCalledTimes(1);
  });
  it('rejects active workspace lock and stale preconditions', async () => {
    const dir = root(); const { plan, owner, item } = fixture();
    fs.mkdirSync(path.join(dir, '.aiwg/memory/maintenance'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.aiwg/memory/maintenance/.lock'), JSON.stringify({ pid: process.pid }));
    await expect(applyMaintenancePlan(plan, { root: dir, owners: [owner], confirmedDigest: maintenancePlanDigest(plan) })).rejects.toThrow(/Concurrent/);
    fs.unlinkSync(path.join(dir, '.aiwg/memory/maintenance/.lock')); item.version++;
    await expect(applyMaintenancePlan(plan, { root: dir, owners: [owner], confirmedDigest: maintenancePlanDigest(plan) })).rejects.toThrow(/Stale/);
    expect(owner.apply).not.toHaveBeenCalled();
  });
  it('fails closed before resident removal unless indexed retrieval succeeds', async () => {
    const { plan, owner, item } = fixture(); item.placement = 'resident';
    Object.assign(plan.operations[0], { op: 'demote', from: { placement: 'resident', lifecycle: 'active' } });
    await expect(previewMaintenancePlan(plan, [owner])).rejects.toThrow(/retrieval/);
    owner.verifyRetrieval = async () => true;
    await expect(previewMaintenancePlan(plan, [owner])).resolves.toEqual(plan);
  });
  it('refuses implicit global scope and claims of current-session mutation', async () => {
    const { plan, owner } = fixture(); plan.operations[0].scope = 'global';
    await expect(previewMaintenancePlan(plan, [owner])).rejects.toThrow(/project scope/);
    plan.operations[0].scope = 'project'; plan.operations[0].sessionEffect = 'current';
    await expect(previewMaintenancePlan(plan, [owner])).rejects.toThrow(/next-session/);
  });
});

describe('maintenance CLI', () => {
  it.each([
    ['plan', ['--wat']], ['apply', ['--plan']], ['apply', ['--plan', 'x', '--yes=false']],
    ['apply', ['--plan', 'x', '--plan', 'y']], ['apply', ['--plan', 'x', '--yes', '--confirm', 'x']],
    ['plan', ['--input', 'x', '--preview', '--out', 'y']], ['apply', ['--plan', 'x', '--preview', '--yes']],
    ['apply', ['--help', '-h']], ['apply', ['positional']],
  ])('strictly rejects invalid %s flags %j', (command, args) => { expect(() => parseMemoryMaintenanceOptions(command, args)).toThrow(); });
  it('writes only a plan file, previews without writes, and requires explicit headless confirmation', async () => {
    const dir = root(); const { owner } = fixture(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMemoryMaintenanceCli('plan', ['--owner', owner.name, '--target', owner.name, '--op', 'recategorize', '--category', 'decision', '--rationale', 'Reviewed', '--reviewer', 'operator', '--out', 'plan.json', '--json'], { root: dir, owners: [owner] });
    expect(fs.readdirSync(dir)).toEqual(['plan.json']);
    await runMemoryMaintenanceCli('apply', ['--plan', 'plan.json', '--preview'], { root: dir, owners: [owner] });
    expect(fs.readdirSync(dir)).toEqual(['plan.json']);
    await expect(runMemoryMaintenanceCli('apply', ['--plan', 'plan.json'], { root: dir, owners: [owner], isTTY: false })).rejects.toThrow(/Noninteractive/);
    await runMemoryMaintenanceCli('apply', ['--plan', 'plan.json', '--yes', '--json'], { root: dir, owners: [owner] });
    expect(owner.apply).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalled();
  });
  it('requires typed digest at a TTY and restore only accepts reviewed restore operations', async () => {
    const dir = root(); const { owner, plan } = fixture(); vi.spyOn(console, 'log').mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
    await expect(runMemoryMaintenanceCli('apply', ['--plan', 'plan.json'], { root: dir, owners: [owner], isTTY: true, confirm: async () => 'yes' })).rejects.toThrow(/exact plan/);
    await expect(runMemoryMaintenanceCli('restore', ['--plan', 'plan.json', '--yes'], { root: dir, owners: [owner] })).rejects.toThrow(/only restore/);
    expect(owner.apply).not.toHaveBeenCalled();
  });
});


describe('coordinated existing owner transactions', () => {
  it('resumes a real line-memory and canonical-context plan after interruption between owners', async () => {
    const dir = root(); vi.spyOn(console, 'log').mockImplementation(() => {});
    const handle = 'lm_11111111-1111-4111-a111-111111111111';
    expect((await runLineMemory('import', ['Retain bounded retry limits', '--handle', handle, '--source-ref', 'decision.md', '--reviewer', 'operator', '--confirm'], dir)).exitCode).toBe(0);
    const repository = new CanonicalContextRepository(dir);
    const proposal = { target: 'project-fact' as const, key: 'retry-limit', value: 'Retain retry limits', sourceRef: 'decision.md', sourceDigest: null,
      reviewer: 'operator', reason: 'Reviewed source', scope: 'project', classification: 'internal' as const, reviewAt: null, expiresAt: null };
    repository.confirm({ preview: repository.previewUpsert(proposal), proposal });
    const owners = [new LineMaintenanceOwner(dir), new CanonicalMaintenanceOwner(dir)];
    const operations = await Promise.all(owners.map(async owner => {
      const record = (await owner.records())[0];
      return { op: 'recategorize' as const, target: { id: record.id, digest: record.digest, version: record.version },
        precondition: { digest: record.digest, version: record.version },
        from: { placement: record.placement, lifecycle: record.lifecycle }, to: { placement: record.placement, lifecycle: record.lifecycle },
        scope: record.scope, rationale: 'Reviewed organization', uncertainty: 'No live observation', impactedLinks: [], sessionEffect: 'next-session' as const,
        owner: { name: owner.name, handle: record.aliases[0], snapshot: await owner.snapshot() }, review: { reviewer: 'operator', retirementBasis: 'review' as const }, category: 'decision' };
    }));
    const plan: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations };
    const options = { root: dir, owners, confirmedDigest: maintenancePlanDigest(plan) };
    await expect(applyMaintenancePlan(plan, { ...options, afterOwner: () => { throw new Error('Crash between owners'); } })).rejects.toMatchObject({ receipt: { partial: { completed: [maintenanceOperationKey(plan, 0)], pending: [maintenanceOperationKey(plan, 1)] } } });
    const resumed = await applyMaintenancePlan(plan, options);
    expect(resumed.partial).toBeUndefined(); expect(resumed.ownerReceipts).toHaveLength(2);
    expect((await owners[0].records())[0].version).toBe(2); expect((await owners[1].records())[0].version).toBe(2);
    expect(repository.read().revision).toBe(2);
  });
});
