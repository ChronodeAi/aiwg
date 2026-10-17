import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareWorkerInstallationStore } from '../../../src/models/worker-installation.mjs';

vi.mock('node:fs/promises', { spy: true });
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('qualification store permission repair', () => {
  it('refuses another owner with the path and never chmods it', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-owner-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const { lstat: original } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      return args[0] === root ? Object.assign(Object.create(stat), { uid: process.getuid!() + 1 }) : stat;
    });
    const open = vi.spyOn(fs, 'open');
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Installation store path is owned by another user: ${root}`);
    expect(open).not.toHaveBeenCalled();
  });

  it('never repairs a writable store file or a symlinked directory', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-path-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const filename = path.join(root, 'worker-installations.json');
    await fs.writeFile(filename, '{}');
    await fs.chmod(filename, 0o666);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Untrusted installation store permissions: ${filename}`);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o666);
    const link = `${root}-link`;
    roots.push(link);
    await fs.symlink(root, link);
    vi.stubEnv('AIWG_CONFIG', link);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow('Symlinked installation store');
  });
});
