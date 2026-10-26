/** Inspect worker paths and read bounded briefs without following symlinks. */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';

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

