// Protocol copy tests cover interruption and changes between planning and mutation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemAdapter } from '../../../src/storage/backends/fs.js';
import { migrationEndpoint } from '../../../src/storage/migration-adapter.js';
import { StorageMigrationCoordinator, type MigrationCopyCheckpoint } from '../../../src/storage/migration-protocol.js';

describe('storage migration copy plan', () => {
  let root: string;
  let sourceRoot: string;
  let destinationRoot: string;
  let durable: MigrationCopyCheckpoint | undefined;
  const endpoint = (location: string) => migrationEndpoint(new FilesystemAdapter(location), {
    backend: 'fs', instance: location, tenant: 'test', subsystem: 'memory', schemaVersion: '1',
  });
  const setup = () => ({ source: endpoint(sourceRoot), destination: endpoint(destinationRoot),
    checkpoint: durable, save: async (value: MigrationCopyCheckpoint) => { durable = structuredClone(value); } });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiwg-protocol-copy-'));
    sourceRoot = join(root, 'source');
    destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot);
    await mkdir(destinationRoot);
    durable = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('resumes from a durable checkpoint after the caller stops between copies', async () => {
    await writeFile(join(sourceRoot, 'a.md'), 'a');
    await writeFile(join(sourceRoot, 'b.md'), 'b');
    await expect(StorageMigrationCoordinator.copy({ ...setup(), report: async () => {
      throw new Error('simulated process interruption');
    } })).rejects.toThrow('simulated process interruption');
    expect(durable?.records.map(item => item.identity.path)).toEqual(['a.md']);
    expect(existsSync(join(destinationRoot, 'b.md'))).toBe(false);
    await writeFile(join(sourceRoot, 'a.md'), 'changed after checkpoint');
    const resumed = await StorageMigrationCoordinator.copy(setup());
    expect(await readFile(join(destinationRoot, 'a.md'), 'utf8')).toBe('changed after checkpoint');
    expect(resumed.receipt.recopied).toEqual([{ path: 'a.md', reason: 'source changed since checkpoint' }]);
    expect(resumed.receipt.copied).toEqual([{ path: 'b.md', reason: 'not yet migrated' }]);
  });

  it('stops if persistence fails and safely repeats a write committed without a checkpoint', async () => {
    await writeFile(join(sourceRoot, 'a.md'), 'a');
    await writeFile(join(sourceRoot, 'b.md'), 'b');
    const request = setup();
    let saves = 0;
    await expect(StorageMigrationCoordinator.copy({ ...request, save: async value => {
      if (++saves === 2) throw new Error('checkpoint store unavailable');
      await request.save(value);
    } })).rejects.toThrow('checkpoint store unavailable');
    expect(await readFile(join(destinationRoot, 'a.md'), 'utf8')).toBe('a');
    expect(existsSync(join(destinationRoot, 'b.md'))).toBe(false);
    expect(durable?.records).toHaveLength(0);
    const resumed = await StorageMigrationCoordinator.copy(setup());
    expect(resumed.receipt.copied).toHaveLength(2);
    expect(resumed.records).toHaveLength(2);
  });

  it('revokes a planned delete when the source reappears', async () => {
    await writeFile(join(sourceRoot, 'a.md'), 'a');
    await StorageMigrationCoordinator.copy(setup());
    await rm(join(sourceRoot, 'a.md'));
    const request = setup();
    const original = request.source.readRecord;
    vi.spyOn(request.source, 'readRecord').mockImplementation(async path => {
      await writeFile(join(sourceRoot, path), 'reappeared');
      return original(path);
    });
    const deleted = vi.spyOn(request.destination, 'commitBatch');
    const result = await StorageMigrationCoordinator.copy(request);
    expect(result.plan[0].deleteAuthorized).toBe(true);
    expect(result.receipt.skipped).toEqual([{ path: 'a.md', reason: 'delete not authorized: source reappeared or plan denies deletion' }]);
    expect(deleted).not.toHaveBeenCalled();
    expect(await readFile(join(destinationRoot, 'a.md'), 'utf8')).toBe('a');
  });

  it('skips a planned delete if its destination changes before execution', async () => {
    await writeFile(join(sourceRoot, 'a.md'), 'a');
    await StorageMigrationCoordinator.copy(setup());
    await rm(join(sourceRoot, 'a.md'));
    const request = setup();
    vi.spyOn(request.source, 'readRecord').mockImplementation(async () => {
      await writeFile(join(destinationRoot, 'a.md'), 'destination changed after plan');
      return null;
    });
    const result = await StorageMigrationCoordinator.copy(request);
    expect(result.receipt.deleted).toEqual([]);
    expect(result.receipt.skipped).toEqual([{ path: 'a.md', reason: 'destination changed after plan; retry to replan' }]);
    expect(await readFile(join(destinationRoot, 'a.md'), 'utf8')).toBe('destination changed after plan');
  });

  it('reports a source changed during planning as skipped and copies it on retry', async () => {
    await writeFile(join(sourceRoot, 'a.md'), 'a');
    const request = setup();
    const original = request.source.readRecord;
    vi.spyOn(request.source, 'readRecord').mockImplementation(async path => {
      await writeFile(join(sourceRoot, path), 'changed while planning');
      return original(path);
    });
    const result = await StorageMigrationCoordinator.copy(request);
    expect(result.receipt.skipped).toEqual([{ path: 'a.md', reason: 'source changed after plan; retry to replan' }]);
    expect(existsSync(join(destinationRoot, 'a.md'))).toBe(false);
    await StorageMigrationCoordinator.copy(setup());
    expect(await readFile(join(destinationRoot, 'a.md'), 'utf8')).toBe('changed while planning');
  });

  it('refuses corrupt batch receipts without checkpointing completion', async () => {
    await writeFile(join(sourceRoot, 'a.md'), 'a');
    const request = setup();
    vi.spyOn(request.destination, 'commitBatch').mockResolvedValue({
      batchId: 'bad', committed: true, highWaterMark: '1', recordReceipts: [],
    });
    const result = await StorageMigrationCoordinator.copy(request);
    expect(result.records).toEqual([]);
    expect(result.receipt.errored).toEqual([{ path: 'a.md', reason: 'destination returned an invalid batch receipt' }]);
  });

  it('does not let an unplanned source tombstone bypass delete authorization', async () => {
    await writeFile(join(sourceRoot, 'a.md'), 'a');
    const request = setup();
    const record = await request.source.readRecord('a.md');
    vi.spyOn(request.source, 'readRecord').mockResolvedValue({
      ...record!, tombstone: { deletedAt: '2026-10-27T00:00:00Z' },
    });
    const commit = vi.spyOn(request.destination, 'commitBatch');
    const result = await StorageMigrationCoordinator.copy(request);
    expect(commit).not.toHaveBeenCalled();
    expect(result.receipt.skipped).toEqual([{ path: 'a.md', reason: 'delete not authorized: source tombstone is not a planned delete' }]);
  });

});
