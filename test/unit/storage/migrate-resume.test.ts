// CLI regression coverage for protocol-backed migration resume and delete authorization.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/storage/cli.js';
import { FilesystemAdapter, LogseqAdapter, initStorage, resetStorage } from '../../../src/storage/index.js';
import { StorageMigrationCoordinator, type MigrationCopyCheckpoint } from '../../../src/storage/migration-protocol.js';

describe('storage migrate protocol resume (#3702)', () => {
  let root: string;
  let source: string;
  let destination: string;
  let output: string[];
  const args = () => ['migrate', 'memory', '--from', `fs:${source}`, '--to', `fs:${destination}`];
  const outputPath = (label: string) => output.find(line => line.startsWith(`${label}: `))!.slice(label.length + 2);
  const checkpoint = async () => JSON.parse(await readFile(outputPath('Migration checkpoint'), 'utf8')) as MigrationCopyCheckpoint;
  const receipt = async () => JSON.parse(await readFile(outputPath('Migration receipt'), 'utf8'));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiwg-migration-resume-'));
    source = join(root, 'source');
    destination = join(root, 'destination');
    await mkdir(source);
    await mkdir(destination);
    resetStorage();
    await initStorage(root);
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...values) => { output.push(values.join(' ')); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetStorage();
    await rm(root, { recursive: true, force: true });
  });

  it('checkpoints an interrupted copy, then recopies a changed source and completes pending paths', async () => {
    for (const path of ['a.md', 'b.md', 'c.md']) await writeFile(join(source, path), path);
    const original = FilesystemAdapter.prototype.write;
    const interrupted = vi.spyOn(FilesystemAdapter.prototype, 'write').mockImplementation(async function(path, value, meta) {
      if (path !== 'a.md') throw new Error('simulated interruption mid-copy');
      return original.call(this, path, value, meta);
    });
    const coordinator = vi.spyOn(StorageMigrationCoordinator, 'copy');
    await expect(main(args(), root)).rejects.toThrow('2 entries failed to migrate');
    expect(coordinator).toHaveBeenCalledOnce();
    expect((await checkpoint()).records.map(item => item.identity.path)).toEqual(['a.md']);
    expect((await receipt()).errored).toEqual([
      { path: 'b.md', reason: 'simulated interruption mid-copy' },
      { path: 'c.md', reason: 'simulated interruption mid-copy' },
    ]);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe('a.md');
    expect(existsSync(join(destination, 'b.md'))).toBe(false);
    interrupted.mockRestore();
    await writeFile(join(source, 'a.md'), 'changed after checkpoint');
    output.length = 0;
    await main(args(), root);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe('changed after checkpoint');
    expect(await readFile(join(destination, 'b.md'), 'utf8')).toBe('b.md');
    expect(await receipt()).toMatchObject({
      recopied: [{ path: 'a.md', reason: 'source changed since checkpoint' }],
      copied: [{ path: 'b.md', reason: 'not yet migrated' }, { path: 'c.md', reason: 'not yet migrated' }],
      skipped: [], deleted: [], errored: [],
    });
    expect(output.join('\n')).toContain('copied=3 skipped=0 unsupported=0 errored=0 total=3 recopied=1 deleted=0');
  });

  it('propagates an authorized delete while reporting changed and unowned destinations as skipped', async () => {
    await writeFile(join(source, 'owned.md'), 'owned');
    await writeFile(join(source, 'edited.md'), 'original');
    await main(args(), root);
    await rm(join(source, 'owned.md'));
    await rm(join(source, 'edited.md'));
    await writeFile(join(destination, 'edited.md'), 'destination edit');
    await writeFile(join(destination, 'unowned.md'), 'keep me');
    output.length = 0;
    await main(args(), root);
    expect(existsSync(join(destination, 'owned.md'))).toBe(false);
    expect(await readFile(join(destination, 'edited.md'), 'utf8')).toBe('destination edit');
    expect(await readFile(join(destination, 'unowned.md'), 'utf8')).toBe('keep me');
    expect(await receipt()).toMatchObject({
      deleted: [{ path: 'owned.md', reason: 'source removed; unchanged migration-owned destination' }],
      skipped: [
        { path: 'edited.md', reason: 'delete not authorized: destination changed since checkpoint' },
        { path: 'unowned.md', reason: 'delete not authorized: destination has no live migration receipt' },
      ],
    });
    expect((await checkpoint()).plan).toContainEqual(expect.objectContaining({ path: 'owned.md', deleteAuthorized: true }));
    expect((await checkpoint()).plan).toContainEqual(expect.objectContaining({ path: 'edited.md', deleteAuthorized: false }));
    output.length = 0;
    const deletion = vi.spyOn(FilesystemAdapter.prototype, 'delete');
    await main(args(), root);
    expect(deletion).not.toHaveBeenCalled();
    expect((await receipt()).deleted).toEqual([]);
  });

  it('reruns idempotently with no writes or deletes and explains unchanged skips', async () => {
    await writeFile(join(source, 'a.md'), 'unchanged');
    await main(args(), root);
    const first = await checkpoint();
    const log = await readFile(outputPath('Migration log'), 'utf8');
    const write = vi.spyOn(FilesystemAdapter.prototype, 'write');
    const remove = vi.spyOn(FilesystemAdapter.prototype, 'delete');
    output.length = 0;
    await main(args(), root);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect((await checkpoint()).records).toEqual(first.records);
    expect(await readFile(outputPath('Migration log'), 'utf8')).toBe(log);
    expect(await receipt()).toMatchObject({ copied: [], recopied: [], deleted: [],
      skipped: [{ path: 'a.md', reason: 'already migrated, skipped' }] });
    expect(output.join('\n')).toContain('copied=0 skipped=1');
  });

  it('recopies content that reverts to an older receipt digest', async () => {
    for (const content of ['first', 'second', 'first']) {
      await writeFile(join(source, 'a.md'), content);
      await main(args(), root);
      expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe(content);
    }
    expect((await checkpoint()).records).toHaveLength(3);
    expect((await receipt()).recopied).toEqual([{ path: 'a.md', reason: 'source changed since checkpoint' }]);
  });

  it('repairs missing or changed destinations instead of trusting only source receipts', async () => {
    await writeFile(join(source, 'a.md'), 'source');
    await main(args(), root);
    await rm(join(destination, 'a.md'));
    await main(args(), root);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe('source');
    expect((await receipt()).recopied).toEqual([{ path: 'a.md', reason: 'destination changed since checkpoint' }]);
    await writeFile(join(destination, 'a.md'), 'destination edit');
    await main(args(), root);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe('source');
  });

  it('recopies legacy pathname-only log entries instead of trusting them', async () => {
    await writeFile(join(source, 'a.md'), 'old');
    await main(args(), root);
    const path = outputPath('Migration checkpoint');
    await rm(path);
    await writeFile(outputPath('Migration log'), JSON.stringify({ path: 'a.md', ts: new Date().toISOString() }) + '\n');
    await writeFile(join(source, 'a.md'), 'new');
    await main(args(), root);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe('new');
    expect((await receipt()).copied).toEqual([{ path: 'a.md', reason: 'not yet migrated' }]);
  });

  it('fails closed on a checkpoint bound to different endpoints', async () => {
    await writeFile(join(source, 'a.md'), 'source');
    await main(args(), root);
    const data = await checkpoint();
    data.destination.instance = 'another destination';
    await writeFile(outputPath('Migration checkpoint'), JSON.stringify(data));
    const write = vi.spyOn(FilesystemAdapter.prototype, 'write');
    await expect(main(args(), root)).rejects.toThrow('checkpoint does not match migration endpoints');
    expect(write).not.toHaveBeenCalled();
  });

  it('preserves checkpoint and receipt files during dry-run', async () => {
    await writeFile(join(source, 'a.md'), 'source');
    await main(args(), root);
    const path = outputPath('Migration checkpoint');
    const before = await readFile(path, 'utf8');
    const beforeReceipt = await readFile(outputPath('Migration receipt'), 'utf8');
    await writeFile(join(source, 'a.md'), 'changed');
    await main([...args(), '--dry-run'], root);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readFile(outputPath('Migration receipt'), 'utf8')).toBe(beforeReceipt);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe('source');
    expect(output.join('\n')).toContain('a.md (would copy)');
  });

  it('detects content changes with the same size and modification time', async () => {
    const path = join(source, 'a.md');
    await writeFile(path, 'one');
    const before = await stat(path);
    await main(args(), root);
    await writeFile(path, 'two');
    await utimes(path, before.atime, before.mtime);
    await main(args(), root);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toBe('two');
    expect((await receipt()).recopied).toEqual([{ path: 'a.md', reason: 'source changed since checkpoint' }]);
  });

  it('uses the stored destination digest for transformed Logseq content and authorized deletes', async () => {
    await writeFile(join(source, 'a.md'), '---\ntitle: Example\n---\n# Body\n');
    const command = ['migrate', 'memory', '--from', `fs:${source}`, '--to', `logseq:${destination}`];
    await main(command, root);
    expect(await readFile(join(destination, 'a.md'), 'utf8')).toContain('title:: Example');
    const first = await checkpoint();
    expect(first.records[0].contentDigest).not.toBe(first.records[0].destinationRevision);
    const write = vi.spyOn(LogseqAdapter.prototype, 'write');
    await main(command, root);
    expect(write).not.toHaveBeenCalled();
    expect((await receipt()).skipped).toEqual([{ path: 'a.md', reason: 'already migrated, skipped' }]);
    await rm(join(source, 'a.md'));
    await main(command, root);
    expect(existsSync(join(destination, 'a.md'))).toBe(false);
    expect((await receipt()).deleted).toHaveLength(1);
  });

  it('binds checkpoints and delete authority to the full destination folder', async () => {
    await writeFile(join(source, 'a.md'), 'source');
    const command = ['migrate', 'memory', '--from', `fs:${source}`, '--to', `obsidian:${destination}`, '--to-folder'];
    await main([...command, 'one'], root);
    const firstPath = outputPath('Migration checkpoint');
    output.length = 0;
    await main([...command, 'two'], root);
    expect(outputPath('Migration checkpoint')).not.toBe(firstPath);
    expect(await readFile(join(destination, 'one', 'a.md'), 'utf8')).toBe('source');
    expect(await readFile(join(destination, 'two', 'a.md'), 'utf8')).toBe('source');
    await rm(join(source, 'a.md'));
    await main([...command, 'two'], root);
    expect(existsSync(join(destination, 'two', 'a.md'))).toBe(false);
    expect(await readFile(join(destination, 'one', 'a.md'), 'utf8')).toBe('source');
  });

});
