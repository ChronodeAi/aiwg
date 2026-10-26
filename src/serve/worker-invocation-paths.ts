/** Inspect worker paths and read bounded briefs without following symlinks. */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { workerConfigDigest } from '../config/aiwg-config.js';
import type { WorkerCommandPlan, WorkerInvocationDriver } from './worker-invocation.js';

export async function inspectWorkerPath(filename: string, kind: 'file' | 'directory' | 'output'): Promise<boolean> {
  if (!path.isAbsolute(filename) || filename.includes('\0')) throw new Error('Absolute NUL-free paths are required');
  if (filename.split('/').includes('..')) throw new Error('Worker path traversal is not allowed');
  const normalized = path.resolve(filename);
  let current = normalized;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (canonical !== current) throw new Error(`Symlink path is not allowed: ${filename}`);
      if (current !== normalized) return false;
      const stat = await lstat(normalized);
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Expected an unaliased ${kind}: ${filename}`);
      }
      return true;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
const inspectPath = inspectWorkerPath;

export async function readBrief(filename: string): Promise<Buffer | null> {
  if (!await inspectPath(filename, 'file')) return null;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new Error('Brief must be a bounded regular file (256 KiB)');
    const buffer = Buffer.alloc(262145);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 262144) throw new Error('Brief exceeds 256 KiB');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** Canonical containment shared by launch metadata and saved-plan authority. */
const beneath = (root: string, filename: string): boolean => {
  const r = path.relative(root, filename);
  return r === '' || !r.startsWith('..') && !path.isAbsolute(r);
};
async function resolveRealish(target: string): Promise<string> {
  const parts = target.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const candidate = i === 0 ? '/' : `/${parts.slice(0, i).join('/')}`;
    try {
      const real = await realpath(candidate);
      const remainder = parts.slice(i).join('/');
      return remainder ? path.join(real, remainder) : real;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
export async function realBeneath(root: string, filename: string): Promise<boolean> {
  const [realRoot, realFilename] = await Promise.all([resolveRealish(root), resolveRealish(filename)]);
  return beneath(realRoot, realFilename);
}

/** The persisted conductor plan, never worker-supplied JSON, owns the minted ID. */
export async function assertConductorWorkerPlan(saved: WorkerCommandPlan, filename: string | undefined,
  drivers: Record<string, WorkerInvocationDriver>): Promise<void> {
  if (!filename) throw new Error('Conductor-owned saved plan is required to verify invocation identity');
  const invocation = saved.invocation;
  if (!invocation?.cwd) throw new Error('Conductor plan has no worker cwd');
  const roots = [invocation.cwd, ...(drivers[invocation.selected.cli]?.qualification.installation?.workerWritableRoots ?? [])];
  for (const root of roots) {
    if (await realBeneath(root, filename)) throw new Error('Invocation plan must be outside worker-writable roots');
  }
  if (!await inspectWorkerPath(filename, 'file')) throw new Error('Conductor-owned saved plan is missing');
  // Pin every ancestor, just as launch input reads do, and refuse aliased files.
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const components = filename.split('/').filter(Boolean), leaf = components.pop()!;
    for (const component of components) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    const handle = await open(`/proc/self/fd/${directory.fd}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.size > 1048576) {
        throw new Error('Conductor-owned saved plan must be bounded, unaliased and owned');
      }
      const bytes = Buffer.alloc(1048577);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 1048576 || workerConfigDigest(JSON.parse(bytes.subarray(0, length).toString('utf8'))) !== workerConfigDigest(saved)) {
        throw new Error('Invocation identity differs from conductor-owned saved plan');
      }
    } finally { await handle.close(); }
  } finally { await directory.close(); }
}
