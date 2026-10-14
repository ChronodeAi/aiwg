import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Extracted from MCP artifact access; default diagnostics and write semantics
// remain compatible. Storage opts into hardlink refusal and root creation.
function assertArtifactContained(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Artifact path must stay beneath the artifact root');
  }
}

function assertIdentity(info) {
  if (!info || !Number.isSafeInteger(info.dev) || info.dev < 0
    || !Number.isSafeInteger(info.ino) || info.ino <= 0
    || !Number.isSafeInteger(info.nlink) || info.nlink <= 0) {
    throw new Error('Artifact identity cannot be verified');
  }
}

function rootedArtifactAccess() {
  return process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY;
}

/** A root pinned as missing must be created by us, never adopted later. */
async function createArtifactRoot(store) {
  let parent;
  let directory;
  let verified = false;
  try {
    let entry = store.configured;
    if (rootedArtifactAccess()) {
      parent = await fs.open(store.projectRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (await fs.realpath(`/proc/self/fd/${parent.fd}`) !== store.projectRoot) {
        throw new Error('Project root changed during artifact creation');
      }
      entry = `/proc/self/fd/${parent.fd}/.aiwg`;
    }
    // EEXIST is a refusal, including a symlink or directory installed since pinning.
    await fs.mkdir(entry);
    const created = await fs.lstat(entry);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('Artifact root changed during creation');
    // Windows cannot open directory handles through fs.open; its fallback
    // uses static identity checks, as do the subsequent artifact operations.
    if (process.platform !== 'win32') {
      directory = await fs.open(entry, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    }
    const opened = directory ? await directory.stat() : await fs.stat(entry);
    const current = await fs.lstat(entry);
    if (current.isSymbolicLink() || !opened.isDirectory()
      || opened.dev !== created.dev || opened.ino !== created.ino
      || opened.dev !== current.dev || opened.ino !== current.ino
      || await fs.realpath(store.configured) !== store.root) {
      throw new Error('Artifact root changed during creation');
    }
    assertIdentity(opened);
    store.identity = opened;
    verified = true;
  } finally {
    const closed = await Promise.allSettled([...(directory ? [directory.close()] : []), ...(parent ? [parent.close()] : [])]);
    const failure = closed.find(result => result.status === 'rejected');
    if (verified && failure) throw failure.reason;
  }
}

/** Pin once. Artifacts bootstrap only their default; storage opts into configured-root creation. */
async function pinArtifactRoot(configured, projectRoot, options = {}) {
  try {
    const root = await fs.realpath(configured);
    const identity = await fs.stat(root);
    const store = { configured, projectRoot, root, identity, ...options };
    await verifyArtifactRoot(store);
    return store;
  } catch (error) {
    if (error.code === 'ENOENT' && options.createMissing) {
      try { return await pinMissingRoot(configured, options); }
      catch (missingError) { return { configured, projectRoot, root: configured, ...options, error: missingError }; }
    }
    if (error.code === 'ENOENT' && projectRoot && configured === path.join(projectRoot, '.aiwg')) {
      const existing = await fs.lstat(configured).catch(missing => {
        if (missing.code !== 'ENOENT') throw missing;
      });
      if (!existing) return { configured, projectRoot, root: configured, identity: null };
      // A symlink (or other unexpected node) present where the default root
      // should be created must not become the containment root later.
      return {
        configured,
        projectRoot,
        root: configured,
        error: new Error('Default artifact root is not a creatable directory'),
      };
    }
    // Keep discovery available, but never adopt a store that was unavailable
    // at startup (including a dangling alias) on a later request.
    return { configured, projectRoot, root: configured, error };
  }
}

async function verifyArtifactRoot(store) {
  if (store.error) throw store.error;
  const canonical = await fs.realpath(store.configured);
  const current = await fs.stat(store.configured);
  assertIdentity(current);
  assertIdentity(store.identity);
  if (canonical !== store.root || !current.isDirectory()
    || current.dev !== store.identity.dev || current.ino !== store.identity.ino) {
    throw new Error('Artifact root changed since it was pinned');
  }
}

async function pinnedArtifactRoot(store, write) {
  if (store.error) throw store.error;
  if (!store.identity) {
    if (!write) throw new Error('Default artifact root has not been created');
    // Serialize first-write initialization so concurrent requests share one
    // identity. Creation still rejects symlinks and uses a project descriptor.
    store.initialization ||= store.creationAnchor ? createMissingRoot(store) : createArtifactRoot(store);
    await store.initialization;
  }
  await verifyArtifactRoot(store);
  return store.root;
}

export function validateContainedPath(artifactPath) {
  if (typeof artifactPath !== 'string' || !artifactPath || path.isAbsolute(artifactPath) || path.win32.isAbsolute(artifactPath)
    || /^[A-Za-z]:/.test(artifactPath)
    || (process.platform === 'win32' && artifactPath.split(/[\\/]/).some(part => part !== '.'
      && (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))
    || artifactPath.split(/[\\/]/).includes('..')) {
    throw new Error('Artifact path must be relative and contain no .. segments');
  }
}

/** Resolve existing aliases before creating anything; dangling symlinks fail closed. */
async function resolveArtifactPath(store, artifactPath, { write = false } = {}) {
  validateContainedPath(artifactPath);
  if (write && store.protectLocationPointer !== false && artifactPath.split(/[\\/]/).some(part => /^\.aiwg-location[. ]*(?::.*)?$/i.test(part))) {
    throw new Error('Refusing to write an artifact location pointer');
  }
  const root = await pinnedArtifactRoot(store, write);
  const target = path.resolve(root, artifactPath);
  assertArtifactContained(root, target);
  if (!rootedArtifactAccess()) {
    let componentPath = root;
    for (const component of path.relative(root, target).split(path.sep)) {
      componentPath = path.join(componentPath, component);
      const info = await fs.lstat(componentPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (info?.isSymbolicLink()) throw new Error('Refusing artifact symlink component');
    }
  }
  let ancestor = path.dirname(target);
  const missing = [];
  while (true) {
    try {
      // lstat distinguishes a missing directory from a dangling symlink.
      await fs.lstat(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const realAncestor = await fs.realpath(ancestor).catch(error => {
    error.containmentRefusal = true;
    throw error;
  });
  if (realAncestor !== root) assertArtifactContained(root, realAncestor);
  const fullPath = path.resolve(realAncestor, ...missing, path.basename(target));
  assertArtifactContained(root, fullPath);
  let info;
  try {
    info = await fs.lstat(fullPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (info) {
    if (write && info.isSymbolicLink()) throw new Error('Refusing to write through an artifact symlink');
    const realTarget = await fs.realpath(fullPath).catch(error => {
      error.containmentRefusal = true;
      throw error;
    });
    assertArtifactContained(root, realTarget);
    if (!write) return { root, fullPath: realTarget };
  }
  return { root, fullPath };
}

/**
 * Linux procfs descriptor paths anchor each lookup to an opened directory.
 * Other platforms use static containment checks. Writes use a fresh inode;
 * failed verification closes handles without unsafe pathname cleanup.
 * Concurrent same-user relocation after verification is not a sandbox boundary.
 */
async function openArtifact(store, artifactPath, { write = false, append = false, remove = false, listing = false } = {}) {
  const mutate = write || append || remove;
  const create = write || append;
  const { root, fullPath } = await resolveArtifactPath(store, artifactPath, { write: mutate });
  if (!rootedArtifactAccess()) return openStaticArtifact(store, root, fullPath, { write, append, remove, listing });
  const directories = [];
  let file;
  let transferred = false;
  const descriptorPath = handle => `/proc/self/fd/${handle.fd}`;
  async function verify(handle, { rootHandle = false, directory = false, entry } = {}) {
    const actual = await fs.realpath(descriptorPath(handle));
    if (rootHandle) {
      if (actual !== root) throw new Error('Artifact root changed during access');
    } else {
      assertArtifactContained(root, actual);
    }
    const [opened, current] = await Promise.all([handle.stat(), fs.lstat(entry || actual)]);
    if (rootHandle) {
      await verifyArtifactRoot(store);
      if (opened.dev !== store.identity.dev || opened.ino !== store.identity.ino) {
        throw new Error('Artifact root changed since it was pinned');
      }
    }
    assertIdentity(opened);
    assertIdentity(current);
    if (current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino
      || (directory ? !opened.isDirectory() : !opened.isFile())) {
      throw new Error('Artifact changed during access or is not a regular file/directory');
    }
    if (!directory && (opened.nlink > 1 || current.nlink > 1)) {
      throw new Error('Refusing multiply-linked artifact file');
    }
    return actual;
  }
  async function close() {
    const closed = await Promise.allSettled([...(file ? [file.close()] : []), ...directories.map(handle => handle.close())]);
    const failure = closed.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  try {
    let parent = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directories.push(parent);
    await verify(parent, { rootHandle: true, directory: true });
    const components = path.relative(root, fullPath).split(path.sep);
    const name = components.pop();
    for (const component of components) {
      const entry = path.join(descriptorPath(parent), component);
      let child;
      try {
        child = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (!create || error.code !== 'ENOENT') throw error;
        await verify(parent, { rootHandle: directories.length === 1, directory: true });
        try {
          await fs.mkdir(entry);
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
        child = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      directories.push(child);
      await verify(child, { directory: true });
      parent = child;
    }
    const parentOptions = { rootHandle: directories.length === 1, directory: true };
    await verify(parent, parentOptions);
    const destination = path.join(descriptorPath(parent), name);
    async function verifyDestination() {
      const info = await fs.lstat(destination).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (info && (info.isSymbolicLink() || !info.isFile())) {
        throw new Error('Refusing to replace an artifact symlink or nonregular file');
      }
      if (info) {
        assertIdentity(info);
        if ((store.rejectLinkedWrites || append || remove) && info.nlink > 1) {
          throw new Error('Refusing multiply-linked artifact file');
        }
      }
      return info;
    }
    if (listing) {
      transferred = true;
      return { close, async entries() {
        await verify(directories[0], { rootHandle: true, directory: true });
        await verify(parent, parentOptions);
        const entries = await directoryEntries(descriptorPath(parent));
        await verify(parent, parentOptions);
        return entries;
      } };
    }
    const targetInfo = mutate ? await verifyDestination() : undefined;
    if (remove) {
      if (!targetInfo) throw Object.assign(new Error('Artifact file not found'), { code: 'ENOENT' });
      // Deletion requires directory permission, not read permission on the leaf.
      transferred = true;
      return { close, async unlink() {
        await verify(directories[0], { rootHandle: true, directory: true });
        await verify(parent, parentOptions);
        const current = await verifyDestination();
        if (!current || current.dev !== targetInfo.dev || current.ino !== targetInfo.ino) throw new Error('Artifact changed during access');
        await fs.unlink(destination);
      } };
    }
    const finalMode = targetInfo ? targetInfo.mode & 0o7777 : 0o666 & ~process.umask();
    const entry = write ? path.join(descriptorPath(parent), `.aiwg-write-${randomUUID()}.tmp`) : destination;
    file = await fs.open(entry,
      (write ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        : append ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
        : constants.O_RDONLY)
      | constants.O_NOFOLLOW | constants.O_NONBLOCK, append ? 0o666 : 0o600);
    await verify(file, { entry });
    transferred = true;
    return {
      handle: file,
      fullPath,
      close,
      async appendContent(content) {
        await verify(directories[0], { rootHandle: true, directory: true });
        await verify(parent, parentOptions);
        await verify(file, { entry });
        await file.writeFile(content, 'utf8');
      },
      async commit() {
        await verify(directories[0], { rootHandle: true, directory: true });
        await verify(file, { entry });
        await verify(parent, parentOptions);
        await verifyDestination();
        await file.chmod(finalMode);
        await fs.rename(entry, destination);
      },
    };
  } finally {
    if (!transferred) await Promise.allSettled([close()]);
  }
}

/** Static checks for platforms without Linux descriptor paths. */
async function openStaticArtifact(store, root, fullPath, { write, append, remove, listing }) {
  const create = write || append;
  // Inspect the lexical path as well as the resolved path: contained aliases
  // must not hide symlink components on this fallback.
  async function check(target, { allowMissing = false } = {}) {
    const relative = path.relative(root, target);
    assertArtifactContained(root, target);
    let current = root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      const info = await fs.lstat(current).catch(error => {
        if (!allowMissing || error.code !== 'ENOENT') throw error;
      });
      if (!info) continue;
      if (info.isSymbolicLink()) throw new Error('Refusing artifact symlink component');
      assertIdentity(info);
      assertArtifactContained(root, await fs.realpath(current));
    }
  }
  if (listing) {
    const directory = path.dirname(fullPath);
    if (directory !== root) await check(directory);
    const identity = await fs.lstat(directory);
    assertIdentity(identity);
    if (!identity.isDirectory()) throw new Error('Artifact must be a directory');
    async function verifyDirectory() {
      await verifyArtifactRoot(store);
      if (directory !== root) await check(directory);
      const current = await fs.lstat(directory);
      assertIdentity(current);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Artifact changed during access');
    }
    return { close: async () => {}, async entries() {
      await verifyDirectory();
      const entries = await directoryEntries(directory);
      await verifyDirectory();
      return entries;
    } };
  }
  await check(fullPath, { allowMissing: create });
  if (create) await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const target = await fs.lstat(fullPath).catch(error => {
    if (!create || error.code !== 'ENOENT') throw error;
  });
  if (target && (!target.isFile() || target.isSymbolicLink())) throw new Error('Artifact must be a regular file');
  if (target) assertIdentity(target);
  if (target && (!write || store.rejectLinkedWrites) && target.nlink > 1) throw new Error('Refusing multiply-linked artifact file');
  if (remove) {
    return { close: async () => {}, async unlink() {
      await verifyArtifactRoot(store);
      await check(fullPath);
      const current = await fs.lstat(fullPath);
      assertIdentity(current);
      if (!current.isFile() || current.nlink > 1 || current.dev !== target.dev || current.ino !== target.ino) {
        throw new Error('Refusing nonregular or multiply-linked artifact file');
      }
      await fs.unlink(fullPath);
    } };
  }
  const entry = write ? path.join(path.dirname(fullPath), `.aiwg-write-${randomUUID()}.tmp`) : fullPath;
  const finalMode = target ? target.mode & 0o7777 : 0o666 & ~process.umask();
  const handle = await fs.open(entry, (write ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    : append ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    : constants.O_RDONLY) | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0), append ? 0o666 : 0o600);
  try {
    const opened = await handle.stat();
    assertIdentity(opened);
    const current = await fs.lstat(entry);
    assertIdentity(current);
    await verifyArtifactRoot(store);
    if (target && !write && (opened.dev !== target.dev || opened.ino !== target.ino)) throw new Error('Artifact changed during access');
    if (opened.dev !== current.dev || opened.ino !== current.ino || current.isSymbolicLink()) throw new Error('Artifact changed during access');
    if (!opened.isFile() || opened.nlink > 1) throw new Error('Refusing nonregular or multiply-linked artifact file');
    async function verifyFile() {
      await verifyArtifactRoot(store);
      await check(fullPath);
      const current = await fs.lstat(entry);
      const actual = await handle.stat();
      assertIdentity(current); assertIdentity(actual);
      if (!current.isFile() || current.nlink > 1 || actual.nlink > 1
        || current.dev !== actual.dev || current.ino !== actual.ino
        || actual.dev !== opened.dev || actual.ino !== opened.ino) {
        throw new Error('Refusing nonregular or multiply-linked artifact file');
      }
    }
    return {
      handle, fullPath, close: () => handle.close(),
      async appendContent(content) { await verifyFile(); await handle.writeFile(content, 'utf8'); },
      async commit() {
        await verifyArtifactRoot(store);
        await check(fullPath, { allowMissing: true });
        const destination = await fs.lstat(fullPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (destination) {
          assertIdentity(destination);
          if (!destination.isFile()) throw new Error('Artifact must be a regular file');
          if (store.rejectLinkedWrites && destination.nlink > 1) throw new Error('Refusing multiply-linked artifact file');
        }
        const temporary = await fs.lstat(entry);
        const actual = await handle.stat();
        assertIdentity(temporary); assertIdentity(actual);
        if (temporary.isSymbolicLink() || actual.nlink > 1 || temporary.nlink > 1
          || actual.dev !== temporary.dev || actual.ino !== temporary.ino
          || actual.dev !== opened.dev || actual.ino !== opened.ino) throw new Error('Artifact changed during access');
        await handle.chmod(finalMode);
        await fs.rename(entry, fullPath);
      },
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Pin the existing ancestor of a configured, not-yet-created storage root. */
async function pinMissingRoot(configured, options) {
  let ancestor = configured;
  const components = [];
  while (true) {
    const info = await fs.lstat(ancestor).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info) break; // Includes dangling aliases: realpath below must refuse them.
    components.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  if (!components.length) throw new Error('Default artifact root is not a creatable directory');
  const root = await fs.realpath(ancestor);
  const identity = await fs.stat(ancestor);
  assertIdentity(identity);
  if (!identity.isDirectory()) throw new Error('Artifact root must be a directory');
  return {
    configured, root: path.join(root, ...components), identity: null, ...options,
    creationAnchor: { configured: ancestor, root, identity }, components,
  };
}

/** Create through the pinned ancestor; never adopt an installed final root. */
async function createMissingRoot(store) {
  const anchor = store.creationAnchor;
  const handles = [];
  let parentPath = anchor.root;
  async function verifyAnchor() {
    const current = await fs.stat(anchor.configured);
    assertIdentity(current);
    if (await fs.realpath(anchor.configured) !== anchor.root || !current.isDirectory()
      || current.dev !== anchor.identity.dev || current.ino !== anchor.identity.ino) {
      throw new Error('Artifact root changed since it was pinned');
    }
  }
  async function verifyDirectory(handle, expected, entry) {
    const opened = handle ? await handle.stat() : await fs.lstat(entry);
    const current = await fs.lstat(entry);
    assertIdentity(opened); assertIdentity(current);
    if (!opened.isDirectory() || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino
      || await fs.realpath(handle ? `/proc/self/fd/${handle.fd}` : entry) !== expected) {
      throw new Error('Artifact root changed during creation');
    }
    return opened;
  }
  try {
    await verifyAnchor();
    let parent;
    if (rootedArtifactAccess()) {
      parent = await fs.open(anchor.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
      const opened = await verifyDirectory(parent, anchor.root, anchor.root);
      if (opened.dev !== anchor.identity.dev || opened.ino !== anchor.identity.ino) throw new Error('Artifact root changed since it was pinned');
    }
    for (const [index, component] of store.components.entries()) {
      await verifyAnchor();
      if (parent) await verifyDirectory(parent, parentPath, parentPath);
      const entry = path.join(parent ? `/proc/self/fd/${parent.fd}` : parentPath, component);
      const expected = path.join(parentPath, component);
      try { await fs.mkdir(entry); }
      catch (error) {
        // Other subsystem adapters may have created shared parents. The final
        // missing root is exclusive; pre-existing parents still need checks.
        if (error.code !== 'EEXIST' || index === store.components.length - 1) throw error;
      }
      const created = await fs.lstat(entry);
      assertIdentity(created);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('Artifact root changed during creation');
      const child = rootedArtifactAccess()
        ? await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : undefined;
      if (child) handles.push(child);
      const opened = await verifyDirectory(child, expected, entry);
      if (opened.dev !== created.dev || opened.ino !== created.ino) throw new Error('Artifact root changed during creation');
      parent = child; parentPath = expected;
      if (index === store.components.length - 1) store.identity = opened;
    }
    await verifyArtifactRoot(store);
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    const failure = closed.find(result => result.status === 'rejected');
    if (store.identity && failure) throw failure.reason;
  }
}

/** Child metadata is read through the same verified directory used by listing. */
async function directoryEntries(directory) {
  const results = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    // Never emit or descend through a symlink, even a contained alias.
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const info = await fs.lstat(path.join(directory, entry.name));
    assertIdentity(info);
    if (info.isSymbolicLink()) throw new Error('Artifact changed during listing');
    if (entry.isDirectory() !== info.isDirectory() || entry.isFile() !== info.isFile()) throw new Error('Artifact changed during listing');
    if (info.isFile() && info.nlink > 1) continue;
    results.push({ name: entry.name, directory: info.isDirectory(), size: info.size, modifiedAt: info.mtime });
  }
  return results;
}

/** Missing storage roots retain null/no-op/empty semantics without being adopted. */
async function absentRoot(store) {
  if (store.error) throw store.error;
  if (store.identity) { await verifyArtifactRoot(store); return false; }
  return true;
}

async function withAccess(store, relative, options, use, missing) {
  validateContainedPath(relative);
  if (!options.write && !options.append && await absentRoot(store)) return missing;
  let access;
  try {
    access = await openArtifact(store, relative, options);
    return await use(access);
  } catch (error) {
    if (!options.write && !options.append && error.code === 'ENOENT' && !error.containmentRefusal) {
      // Root removal/replacement is never converted to an ordinary missing leaf.
      await verifyArtifactRoot(store);
      return missing;
    }
    throw error;
  } finally { if (access) await access.close(); }
}

export async function readContainedFile(store, relative) {
  return withAccess(store, relative, {}, access => access.handle.readFile('utf8'), null);
}
export async function writeContainedFile(store, relative, content) {
  return withAccess(store, relative, { write: true }, async access => {
    await access.handle.writeFile(content, 'utf8');
    await access.commit();
  });
}
export async function appendContainedFile(store, relative, content) {
  return withAccess(store, relative, { append: true }, access => access.appendContent(content));
}
export async function deleteContainedFile(store, relative) {
  return withAccess(store, relative, { remove: true }, access => access.unlink());
}
export async function listContainedFiles(store, prefix = '') {
  if (typeof prefix !== 'string') throw new Error('Artifact list prefix must be a string');
  if (prefix) validateContainedPath(prefix);
  if (await absentRoot(store)) return [];
  const results = [];
  async function walk(relative = '') {
    const access = await openArtifact(store, `${relative ? `${relative}/` : ''}.aiwg-list`, { listing: true });
    try {
      for (const entry of await access.entries()) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.directory) {
          if (!prefix || rel.startsWith(prefix) || prefix.startsWith(`${rel}/`)) await walk(rel);
        } else if (!prefix || rel.startsWith(prefix)) results.push({ path: rel, size: entry.size, modifiedAt: entry.modifiedAt });
      }
    } finally { await access.close(); }
  }
  await walk();
  return results;
}

export { pinArtifactRoot as pinContainedRoot, openArtifact as openContainedFile };
