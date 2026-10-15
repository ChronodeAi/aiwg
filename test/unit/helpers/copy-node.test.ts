import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyNode } from '../../helpers/copy-node.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('fixture Node executable', () => {
  it('copies writable, hardlinked toolcache bytes into a private single-link executable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiwg-copy-node-')); roots.push(root);
    const source = path.join(root, 'toolcache-node');
    await writeFile(source, 'synthetic executable bytes');
    await chmod(source, 0o777);
    await link(source, path.join(root, 'toolcache-alias'));
    const installed = path.join(root, 'installed'); await mkdir(installed);
    const executable = await copyNode(installed, source);
    const copied = await stat(executable);
    expect(copied.mode & 0o777).toBe(0o755);
    expect(copied.nlink).toBe(1);
    expect(copied.ino).not.toBe((await stat(source)).ino);
    expect(await readFile(executable, 'utf8')).toBe('synthetic executable bytes');
    expect((await stat(source)).mode & 0o777).toBe(0o777);
    expect((await stat(source)).nlink).toBe(2);
  });
});
