/** Materialize and remove bounded worker artifacts through pinned, symlink-free directories. */
import { constants } from 'node:fs';
import { open, mkdir, lstat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';

const { validateWorkerArtifacts } = await importImpl(import.meta.url, 'serve/worker-artifacts.mjs');
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

export async function materializeWorkerArtifacts(invocation, runDir) {
  const artifacts = validateWorkerArtifacts(invocation);
  const targets = new Map(artifacts.map(artifact => [artifact.name, artifact.location === 'workspace-relative'
    ? path.join(invocation.cwd, artifact.relativePath) : path.join(runDir, `artifact-${artifact.name}`)]));
  const argv = invocation.argv.map(token => {
    if (!token.includes('${artifact:')) return token;
    const match = /^\$\{artifact:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}$/.exec(token);
    if (!match || !targets.has(match[1])) throw new Error('Undeclared worker artifact placeholder');
    return targets.get(match[1]);
  });
  const handles = [], created = [], directories = [];
  let cleaned = false;
  const remember = handle => { handles.push(handle); return handle; };
  const childPath = (parent, name) => `/proc/self/fd/${parent.fd}/${name}`;
  // Every ancestor is opened with O_NOFOLLOW; subsequent operations remain
  // relative to its descriptor even if a worker renames/replaces that ancestor.
  async function pinDirectory(filename) {
    if (!path.isAbsolute(filename) || path.normalize(filename) !== filename || filename.includes('\0')) throw new Error('Invalid worker artifact root');
    let directory = remember(await open('/', directoryFlags));
    for (const component of filename.split('/').filter(Boolean)) {
      directory = remember(await open(childPath(directory, component), directoryFlags));
    }
    return directory;
  }
  async function workspaceParent(root, relativePath) {
    let directory = root;
    for (const component of relativePath.split('/').slice(0, -1)) {
      const target = childPath(directory, component);
      let made = false;
      try { await mkdir(target, { mode: 0o700 }); made = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const next = remember(await open(target, directoryFlags));
      if (made) directories.push({ target, stat: await next.stat() });
      directory = next;
    }
    return directory;
  }
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const errors = [];
    try {
      for (const entry of created.reverse()) {
        try {
          const current = await lstat(entry.target);
          if (!sameFile(current, entry.stat)) throw new Error('Worker artifact changed before cleanup; replacement preserved');
          await unlink(entry.target);
        } catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
      }
      for (const entry of directories.reverse()) {
        try {
          if (!sameFile(await lstat(entry.target), entry.stat)) throw new Error('Worker artifact directory changed before cleanup; replacement preserved');
          await rmdir(entry.target);
        } catch (error) {
          // Preserve directories containing unrelated or worker-created files.
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) errors.push(error);
        }
      }
    } finally {
      for (const handle of handles.reverse()) {
        try { await handle.close(); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Worker artifact cleanup failed');
  };
  try {
    const run = await pinDirectory(runDir);
    const stat = await run.stat();
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Worker artifact directory must be private and owned');
    let workspace;
    for (const artifact of artifacts) {
      let parent = run;
      let leaf = `artifact-${artifact.name}`;
      if (artifact.location === 'workspace-relative') {
        workspace ??= await pinDirectory(invocation.cwd);
        parent = await workspaceParent(workspace, artifact.relativePath);
        leaf = path.basename(artifact.relativePath);
      }
      const target = childPath(parent, leaf);
      let handle;
      try { handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw Object.assign(new Error(`Worker artifact collision: ${targets.get(artifact.name)} (existing file preserved)`), { code: 'EEXIST' });
        throw error;
      }
      try {
        created.push({ target, stat: await handle.stat() });
        await handle.writeFile(artifact.content); await handle.sync();
      } finally { await handle.close(); }
    }
    return { argv, cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Worker artifact creation and cleanup failed'); }
    throw error;
  }
}
