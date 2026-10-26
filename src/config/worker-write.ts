// Shares atomic replacement and serialization across worker configuration owners.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile, rename, unlink, stat, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { projectControlPath } from './project-artifacts.js';

const maintenance = new AsyncLocalStorage<boolean>();
export const runWorkerMaintenance = <T>(body: () => Promise<T>): Promise<T> => maintenance.run(true, body);
export const isWorkerMaintenance = (): boolean => maintenance.getStore() === true;
export const workerWriteLock = (project: string): string => projectControlPath(project, 'aiwg.config.apply-lock');
export function workerDispatchBlocked(project: string): boolean {
  try { statSync(join(workerWriteLock(project), 'blocked')); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function atomicConfigWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  let mode = 0o600;
  try { mode = (await stat(file)).mode; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function acquireWorkerWriteLock(project: string): Promise<string> {
  const lock = workerWriteLock(project);
  await mkdir(dirname(lock), { recursive: true });
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Worker configuration is locked; dispatch remains closed if blocked: ${lock}. Inspect the retained recovery.json before recovery.`);
    throw error;
  }
  return lock;
}
export async function withWorkerWriteLock<T>(project: string, body: () => Promise<T>): Promise<T> {
  const lock = await acquireWorkerWriteLock(project);
  try { return await body(); } finally { await rm(lock, { recursive: true }); }
}
