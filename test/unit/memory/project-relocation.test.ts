// Relocation preserves notes and registry state through the registry and CLI owners.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../../../src/memory/cli.js';
import { registerProjectMemory, relocateProjectMemory, lookupProjectMemory } from '../../../src/memory/project-registry.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

async function snapshot(root: string): Promise<Record<string, Buffer | null>> {
  const result: Record<string, Buffer | null> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result[entry.name] = null;
      for (const [key, value] of Object.entries(await snapshot(full))) {
        result[path.join(entry.name, key)] = value;
      }
    } else if (entry.isSymbolicLink()) result[entry.name] = Buffer.from(`symlink:${await fs.readlink(full)}`);
    else result[entry.name] = await fs.readFile(full);
  }
  return result;
}

describe.each(['registry', 'CLI'] as const)('project relocation via %s (#3741)', surface => {
  let tmp: string;
  let oldRoot: string;
  let nextRoot: string;
  let output: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-relocation-'));
    vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', path.join(tmp, 'registry'));
    oldRoot = path.join(tmp, 'old');
    nextRoot = path.join(tmp, 'destination');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await registerProjectMemory({ id: 'demo', workspaceRoot: path.join(tmp, 'workspace'),
      memoryRoot: oldRoot, gitRemotes: [] });
    await fs.writeFile(path.join(oldRoot, 'memory/note.md'), Buffer.from([0, 10, 128, 255]));
    await fs.mkdir(path.join(oldRoot, 'artifacts/nested'));
    await fs.writeFile(path.join(oldRoot, 'artifacts/nested/retained.txt'), 'retained');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function relocate(target = nextRoot) {
    if (surface === 'registry') return relocateProjectMemory('demo', target);
    await main(['project', 'relocate', 'demo', target, '--json']);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  }

  it.each(['note', 'empty-subdirectory', 'missing-source'])(
    'refuses a non-empty destination (%s) without changing either tree or registry', async kind => {
      await fs.mkdir(nextRoot);
      if (kind === 'empty-subdirectory') await fs.mkdir(path.join(nextRoot, 'owned'));
      else await fs.writeFile(path.join(nextRoot, '.owned-note'), 'destination note');
      if (kind === 'missing-source') await fs.rm(oldRoot, { recursive: true });
      const before = await snapshot(tmp);
      const error = await relocate().then(() => undefined, err => err as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(oldRoot);
      expect(error?.message).toContain(nextRoot);
      expect(await snapshot(tmp)).toEqual(before);
      expect(fs.rename).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
    });

  it.each(['absent', 'empty'])( 'moves every owned file to an %s destination', async kind => {
    if (kind === 'empty') await fs.mkdir(nextRoot);
    const before = await snapshot(oldRoot);
    const entry = await relocate();
    expect(entry.memoryRoot).toBe(nextRoot);
    expect(await snapshot(nextRoot)).toEqual(before);
    await expect(fs.stat(oldRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lookupProjectMemory({ id: 'demo' })).toEqual({ status: 'found', entry, matchedBy: 'id' });
  });

  it.each(['file', 'dangling-symlink'])('refuses a %s destination without changing any state', async kind => {
    if (kind === 'file') await fs.writeFile(nextRoot, 'owned destination');
    else await fs.symlink(path.join(tmp, 'missing-target'), nextRoot);
    const before = await snapshot(tmp);
    await expect(relocate()).rejects.toThrow(
      `Cannot relocate project memory from '${oldRoot}' to '${nextRoot}': destination is not empty`,
    );
    expect(await snapshot(tmp)).toEqual(before);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('removes newly created empty parents when rename fails', async () => {
    nextRoot = path.join(tmp, 'new-parent', 'nested', 'destination');
    const before = await snapshot(tmp);
    const failure = Object.assign(new Error('fixture: EXDEV'), { code: 'EXDEV' });
    vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    await expect(relocate()).rejects.toBe(failure);
    expect(fs.rename).toHaveBeenCalledWith(oldRoot, nextRoot);
    expect(await snapshot(tmp)).toEqual(before);
    expect(output).not.toHaveBeenCalled();
  });

  it('retains pre-existing parents and new parents populated during a failed rename', async () => {
    const retained = path.join(tmp, 'retained');
    await fs.mkdir(retained);
    nextRoot = path.join(retained, 'new-parent', 'nested', 'destination');
    const before = await snapshot(tmp);
    const failure = new Error('fixture: rename failed after another writer added a file');
    vi.mocked(fs.rename).mockImplementationOnce(async () => {
      await fs.writeFile(path.join(retained, 'new-parent', 'witness'), 'concurrent content');
      throw failure;
    });
    await expect(relocate()).rejects.toBe(failure);
    expect(await snapshot(tmp)).toEqual({ ...before,
      'retained/new-parent': null,
      'retained/new-parent/witness': Buffer.from('concurrent content'),
    });
  });

  it.each([
    ['EXDEV', false], ['EACCES', false], ['EXDEV', true], ['EACCES', true],
  ])('preserves source and registry when rename fails with %s (empty target=%s)', async (code, empty) => {
    if (empty) await fs.mkdir(nextRoot);
    const before = await snapshot(tmp);
    const failure = Object.assign(new Error(`fixture: ${code}`), { code });
    vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    await expect(relocate()).rejects.toBe(failure);
    expect(fs.rename).toHaveBeenCalledWith(oldRoot, nextRoot);
    expect(await snapshot(tmp)).toEqual(before);
    expect(output).not.toHaveBeenCalled();
    expect(await lookupProjectMemory({ id: 'demo' })).toMatchObject({ status: 'found', entry: { memoryRoot: oldRoot } });
  });

  it('keeps notes when the destination is the same normalized path', async () => {
    const before = await snapshot(oldRoot);
    expect((await relocate(path.join(oldRoot, 'nested', '..'))).memoryRoot).toBe(oldRoot);
    expect(await snapshot(oldRoot)).toEqual(before);
    expect(fs.rename).not.toHaveBeenCalled();
  });
});
