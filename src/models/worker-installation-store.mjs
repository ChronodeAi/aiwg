// Own trusted approval-store I/O, locking, pruning, and explicit approval management.
import { constants } from 'node:fs';
import { open, realpath, lstat, stat, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const installedModuleMaxBytes = 5 * 1024 * 1024;

// Resolve existing ancestors too: a not-yet-created output can traverse a symlink.
export async function canonicalFuturePath(filename) {
  try { return await realpath(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling link is not a new output: following it may leave the scope.
    try { if ((await lstat(filename)).isSymbolicLink()) throw new Error('Dangling worker path'); }
    catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(filename));
  }
}

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function readInstalledFile(filename) {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Installed module inputs must be regular files');
    if (stat.size > installedModuleMaxBytes) throw new Error('Installed module input exceeds maxBytes (5 MiB)');
    // Bound the actual read too: an fstat size check alone allows concurrent growth.
    const bytes = Buffer.alloc(installedModuleMaxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > installedModuleMaxBytes) throw new Error('Installed module input exceeds maxBytes (5 MiB)');
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export function installationStorePath() {
  const root = process.env.AIWG_CONFIG || path.join(homedir(), '.config/aiwg');
  if (!path.isAbsolute(root)) throw new Error('Installation store must be absolute');
  return path.join(root, 'worker-installations.json');
}

// HOME is the operator's trust boundary; custom stores outside it are checked
// back to /. O_NOFOLLOW on the store itself does not protect its ancestors.
export async function assertTrustedStoreAncestors(directory) {
  const home = path.resolve(homedir());
  const boundary = inside(home, directory) ? home : path.parse(directory).root;
  // The store directory itself is checked by the caller.
  if (directory === boundary) return;
  const ancestors = [];
  for (let target = path.dirname(directory); ; target = path.dirname(target)) {
    ancestors.push(target);
    if (target === boundary) break;
  }
  for (const target of ancestors.reverse()) {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022
      || process.getuid && stat.uid !== 0 && stat.uid !== process.getuid()) {
      throw new Error(`Untrusted installation store ancestor: ${target}`);
    }
  }
}

export async function assertTrustedStore(filename, writableRoots, repairDirectory = false, apply = false) {
  const changes = [];
  const canonical = await canonicalFuturePath(filename);
  if (canonical !== filename) throw new Error('Symlinked installation store');
  for (const root of writableRoots) {
    if (inside(await realpath(root), canonical)) throw new Error('Worker-writable installation store');
  }
  for (const target of [path.dirname(filename), filename]) {
    try {
      const stat = await lstat(target);
      if (process.getuid && stat.uid !== process.getuid()) throw new Error(`Installation store path is owned by another user: ${target}`);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1
        || target === path.dirname(filename) && !stat.isDirectory()
        || target === filename && !stat.isFile()) throw new Error(`Untrusted installation store permissions: ${target}`);
      if (stat.mode & 0o022) {
        if (!repairDirectory || target !== path.dirname(filename) || !process.getuid) {
          throw new Error(`Untrusted installation store permissions: ${target}`);
        }
        await assertTrustedStoreAncestors(target);
        changes.push({ path: target, action: 'chmod go-w' });
        if (apply) {
          const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
          try {
            const current = await handle.stat();
            if (current.uid !== process.getuid() || current.ino !== stat.ino || current.dev !== stat.dev) {
              throw new Error(`Installation store directory changed: ${target}`);
            }
            await handle.chmod(current.mode & ~0o022);
          } finally { await handle.close(); }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return changes;
}

/** Qualification's confirmed write may secure its own directory; ordinary readers never repair. */
export async function prepareWorkerInstallationStore({ workerWritableRoots, apply = false }) {
  return assertTrustedStore(installationStorePath(), workerWritableRoots, true, apply);
}

export async function readInstallationStore(filename, expectedDigest) {
  try {
    const bytes = await readInstalledFile(filename);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('Installation store binding changed');
    const stored = JSON.parse(bytes.toString('utf8'));
    if (stored.version !== 1 || !Array.isArray(stored.registrations) || stored.registrations.length > 128) {
      throw new Error('Unsupported installation record');
    }
    return { stored, digest };
  } catch (error) {
    if (error.code === 'ENOENT' && expectedDigest === undefined) return { stored: { version: 1, registrations: [] }, digest: null };
    throw error;
  }
}

// Serialize readers and writers; a stale lock fails closed and is never stolen.
export async function withWorkerInstallationStore(writableRoots, operation) {
  const filename = installationStorePath();
  await assertTrustedStore(filename, writableRoots);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const lockPath = `${filename}.lock`;
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt === 99) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    await assertTrustedStore(filename, writableRoots);
    const { stored } = await readInstallationStore(filename);
    return await operation({ filename, stored });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function writeWorkerInstallationStore(filename, stored, writableRoots) {
  await assertTrustedStore(filename, writableRoots);
  const temporary = `${filename}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function workspaceIdentity(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return workspace;
  try { return await realpath(workspace); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return path.resolve(workspace);
  }
}

async function workspaceDeleted(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  try { return !(await stat(workspace)).isDirectory(); }
  catch (error) {
    // Permission and I/O failures do not establish that a workspace was deleted.
    return error.code === 'ENOENT' || error.code === 'ENOTDIR';
  }
}

export async function retainWorkerApprovals(registrations, record) {
  const retained = [];
  for (const entry of registrations) {
    if (await workspaceDeleted(entry.installation?.cwd)) continue;
    const workspace = await workspaceIdentity(entry.installation?.cwd).catch(() => entry.installation?.cwd);
    if (entry.cli !== record.cli || workspace !== record.installation.cwd) retained.push(entry);
  }
  if (retained.length >= 128) throw new Error('Worker installation store is full (128 workspace approvals); run aiwg doctor --probe-workers --forget-approval <workspace-path> [--cli <name>] --yes before qualifying another workspace');
  return [...retained, record];
}

/** Offline inventory of recorded authority; never load a driver or validate launch eligibility. */
export async function listWorkerApprovals({ cwd, cli }) {
  return withWorkerInstallationStore([cwd], async ({ stored }) => {
    const approvals = [];
    for (const entry of stored.registrations) {
      if (cli && entry.cli !== cli) continue;
      approvals.push({ cli: entry.cli, workspace: entry.installation?.cwd ?? null,
        workspaceExists: !(await workspaceDeleted(entry.installation?.cwd)) });
    }
    return approvals;
  });
}

/** Explicit revocation by exact canonical workspace, including workspaces already deleted. */
export async function forgetWorkerApproval({ cwd, workspace, cli, yes }) {
  if (yes !== true) throw new Error('Forgetting worker approvals requires --yes');
  const target = await workspaceIdentity(path.resolve(cwd, workspace));
  return withWorkerInstallationStore([cwd], async ({ filename, stored }) => {
    const removed = [];
    const retained = [];
    for (const entry of stored.registrations) {
      const identity = await workspaceIdentity(entry.installation?.cwd);
      if (identity === target && (!cli || entry.cli === cli)) {
        removed.push({ cli: entry.cli, workspace: entry.installation.cwd });
      } else retained.push(entry);
    }
    if (!removed.length) throw new Error(`No worker approval found for ${target}${cli ? ` (CLI ${cli})` : ''}`);
    stored.registrations = retained;
    await writeWorkerInstallationStore(filename, stored, [cwd]);
    return removed;
  });
}
