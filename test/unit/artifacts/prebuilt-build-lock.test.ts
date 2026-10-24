import { describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { acquireDirectoryLock, DirectoryLockContentionError } from '../../../src/artifacts/prebuilt-build-lock.js';

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000, stdio: 'ignore' });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(() => process.kill(child.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  return child.pid;
}

describe('prebuilt package build lock', () => {
  it('lets the release index build reclaim a dead owner on this host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-prebuilt-lock-build-'));
    const repo = path.resolve(import.meta.dirname, '../../..');
    const lockPath = path.join(root, 'prebuilt/fortemi-core/.framework-build.lock');
    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, 'owner'), `${deadPid()}:dead-build:${os.hostname()}\n`);
      await mkdir(path.join(root, 'tools/release'), { recursive: true });
      await copyFile(path.join(repo, 'tools/release/build-fortemi-core-indices.mjs'), path.join(root, 'tools/release/build-fortemi-core-indices.mjs'));
      await symlink(path.join(repo, 'src'), path.join(root, 'src'), 'junction');
      await writeFile(path.join(root, 'package.json'), '{"name":"aiwg","version":"1.0.0","type":"module"}\n');
      for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
        await mkdir(path.join(root, 'agentic/code', kind), { recursive: true });
      }
      await writeFile(path.join(root, 'agentic/code/agents/example.md'), '---\nname: example\ndescription: Fixture agent\n---\n# Example\n');

      const build = spawnSync(process.execPath, [
        '--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href,
        'tools/release/build-fortemi-core-indices.mjs',
      ], {
        cwd: root, timeout: 20_000, stdio: 'inherit',
        env: { ...process.env, AIWG_ROOT: root, HOME: root, XDG_DATA_HOME: path.join(root, 'data'),
          XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
          AIWG_ARTIFACTS_PATH: '', AIWG_PROJECT_ARTIFACTS_PATH: '', AIWG_PROJECT_AIWG_DIR: '' },
      });
      expect(build.error).toBeUndefined();
      expect(build.status).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(root, 'prebuilt/fortemi-core/framework/manifest.json'), 'utf8'));
      expect(manifest.item_count).toBeGreaterThan(0);
      const exported = JSON.parse(await readFile(path.join(root, 'prebuilt/fortemi-core/framework/aiwg-fortemi-index-v2.json'), 'utf8'));
      expect(exported.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'example' })]));
      await expect(readFile(path.join(lockPath, 'owner'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['live', 'other-host', 'legacy', 'malformed'] as const)(
    'retains a %s owner even when dead-owner recovery is enabled', async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-prebuilt-lock-retained-'));
      const lockPath = path.join(root, '.framework-build.lock');
      const owner = kind === 'live' ? `${process.pid}:live:${os.hostname()}\n`
        : kind === 'other-host' ? `${deadPid()}:remote:${os.hostname()}-other\n`
        : kind === 'legacy' ? `${deadPid()}:legacy\n` : `invalid:unknown:${os.hostname()}\n`;
      try {
        await mkdir(lockPath);
        await writeFile(path.join(lockPath, 'owner'), owner);
        await expect(acquireDirectoryLock(lockPath, { reclaimDeadOwner: true, timeoutMs: 30, pollMs: 5 }))
          .rejects.toBeInstanceOf(DirectoryLockContentionError);
        expect(await readFile(path.join(lockPath, 'owner'), 'utf8')).toBe(owner);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('serializes concurrent package readers and builders', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-prebuilt-lock-'));
    const lockPath = path.join(root, '.framework-build.lock');
    try {
      const releaseFirst = await acquireDirectoryLock(lockPath);
      let secondAcquired = false;
      const second = acquireDirectoryLock(lockPath, { timeoutMs: 2_000, pollMs: 10 })
        .then((release) => {
          secondAcquired = true;
          return release;
        });

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(secondAcquired).toBe(false);
      await releaseFirst();

      const releaseSecond = await second;
      expect(secondAcquired).toBe(true);
      await releaseSecond();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('times out without deleting another process owner lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-prebuilt-lock-timeout-'));
    const lockPath = path.join(root, '.framework-build.lock');
    try {
      const release = await acquireDirectoryLock(lockPath);
      await expect(acquireDirectoryLock(lockPath, { timeoutMs: 30, pollMs: 5 }))
        .rejects.toThrow(/timed out waiting for build lock/);
      await release();
      const releaseAfter = await acquireDirectoryLock(lockPath, { timeoutMs: 30, pollMs: 5 });
      await releaseAfter();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
