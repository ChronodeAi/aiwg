// Covers empty recovery and conservative cleanup of unpublished worker lock owners.
import { mkdtemp, mkdir, writeFile, readFile, readlink, unlink, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireWorkerWriteLock, workerWriteLock } from '../../../src/config/worker-owner-lock.js';
import { recoverWorkerAdoption } from '../../../src/config/worker-adoption.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-worker-owner-')); roots.push(root);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, 'artifacts'));
  return root;
}

it.each(['missing', 'dangling', 'missing owner'])('reports nothing to recover for a %s lock', async state => {
  const root = await fixture();
  const path = workerWriteLock(root);
  if (state !== 'missing') {
    await mkdir(join(path, '..'), { recursive: true });
    const directory = `${path}.${randomUUID()}`;
    if (state === 'missing owner') await mkdir(directory);
    await symlink(basename(directory), path);
  }
  await expect(recoverWorkerAdoption(root, { digest: 'unused' })).rejects.toThrow(/no interrupted apply; nothing to recover/i);
});

it('sweeps only unreferenced, provably dead owner directories on acquire', async () => {
  const root = await fixture();
  const lease = await acquireWorkerWriteLock(root);
  const path = workerWriteLock(root);
  const aliveDirectory = join(path, '..', await readlink(path));
  const owner = JSON.parse(await readFile(join(aliveDirectory, 'owner.json'), 'utf8'));
  await unlink(path); // Simulate an unpublished directory while its owner is still alive.
  const orphan = async (details: object | null) => {
    const directory = `${path}.${randomUUID()}`;
    await mkdir(directory);
    if (details) await writeFile(join(directory, 'owner.json'), JSON.stringify({ ...owner, generation: randomUUID(), ...details }));
    return directory;
  };
  const dead = await orphan({ start: 'old-boot:old-process' });
  const remote = await orphan({ host: `${owner.host}-remote`, start: 'old-boot:old-process' });
  const unverifiable = await orphan({ start: null });
  const missingStart = await orphan({ start: undefined });
  const incomplete = await orphan(null);
  const unrelated = `${path}.backup`;
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'owner.json'), JSON.stringify({ ...owner, start: 'old-boot:old-process' }));
  // Follow successor generations: the original owner is dead but its successor is alive.
  const successor = await orphan({ start: 'old-boot:old-process' });
  const original = JSON.parse(await readFile(join(successor, 'owner.json'), 'utf8'));
  await symlink(JSON.stringify({ ...owner, generation: randomUUID() }), join(successor, `next-${original.generation}`));
  const next = await acquireWorkerWriteLock(root);
  expect(existsSync(dead)).toBe(false);
  for (const directory of [aliveDirectory, remote, unverifiable, missingStart, incomplete, successor, unrelated]) expect(existsSync(directory)).toBe(true);
  await next.release();
  await expect(lease.release()).rejects.toThrow(/ownership lost/);
});

it('preserves a referenced dead owner for authorized recovery', async () => {
  const root = await fixture();
  const lease = await acquireWorkerWriteLock(root, true);
  const file = join(lease.path, 'owner.json');
  const owner = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...owner, start: 'old-boot:old-process' }));
  await expect(acquireWorkerWriteLock(root)).rejects.toThrow(/locked/);
  expect(existsSync(file)).toBe(true);
});
