import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pinContainedRoot, openContainedFile, appendContainedFile, writeContainedFile,
} from '../../../src/utils/contained-filesystem.mjs';

const host = process;
describe.each(['linux', 'darwin', 'win32'])('birth time identity (%s access)', platform => {
  let base, root, rule, onOpen, handles;
  const options = { createMissing: true, protectLocationPointer: false, rejectLinkedWrites: true };
  beforeEach(async () => {
    base = await fs.mkdtemp(join(tmpdir(), 'aiwg-contained-identity-'));
    root = join(base, 'store');
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'file'), 'original');
    await fs.mkdir(join(root, 'dir'));
    handles = [];
    rule = () => 1n;
    onOpen = () => {};
    vi.stubGlobal('process', new Proxy(host, { get: (target, key) => key === 'platform' ? platform : Reflect.get(target, key) }));
    // Keep real dev/ino and node types, but model generations one nanosecond apart.
    // Every stat source is intercepted, including FileHandle.stat and procfs paths.
    async function identity(info, kind, file) {
      const canonical = await fs.realpath(file);
      Object.defineProperty(info, 'birthtimeNs', { value: rule(kind, canonical), configurable: true });
      return info;
    }
    for (const kind of ['stat', 'lstat']) {
      const original = fs[kind].bind(fs);
      vi.spyOn(fs, kind).mockImplementation(async (file, ...args) => identity(await original(file, ...args), kind, file));
    }
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      handles.push(handle);
      const canonical = await fs.realpath(file);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async (...args) => identity(await stat(...args), 'fstat', canonical));
      onOpen(canonical);
      return handle;
    });
  });
  afterEach(async () => {
    await Promise.allSettled(handles.map(handle => handle.close()));
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    await fs.rm(base, { recursive: true, force: true });
  });

  it('rejects a new root generation at the same canonical path and inode', async () => {
    const store = await pinContainedRoot(root);
    rule = (kind, file) => file === root ? 2n : 1n;
    await expect(appendContainedFile(store, 'file', 'changed')).rejects.toThrow(/root changed/);
    expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('original');
  });

  it.each([[0n, 0n], [undefined, undefined], [0n, undefined]])('supports unavailable birth times (%s, %s)', async (before, after) => {
    rule = () => before;
    const store = await pinContainedRoot(root);
    rule = () => after;
    await appendContainedFile(store, 'file', '!');
    expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('original!');
  });

  it.each([[0n, 1n], [1n, 0n], [undefined, 1n], [1n, undefined]])('refuses one-sided birth time changes (%s, %s)', async (before, after) => {
    rule = () => before;
    const store = await pinContainedRoot(root);
    rule = () => after;
    await expect(appendContainedFile(store, 'file', 'changed')).rejects.toThrow(/root changed/);
  });

  it.each(['created', 'current'])('checks the default root against its %s generation', async side => {
    root = join(base, '.aiwg');
    const store = await pinContainedRoot(root, base);
    let reads = 0;
    rule = (kind, file) => {
      if (file !== root) return 1n;
      if (kind === 'lstat') reads++;
      if (side === 'created') return reads === 1 && kind === 'lstat' ? 1n : 2n;
      return kind === 'lstat' && reads >= 2 ? 2n : 1n;
    };
    await expect(writeContainedFile(store, 'new', 'changed')).rejects.toThrow(/root changed during creation/);
  });

  it('checks a pinned missing-root ancestor before creation', async () => {
    const missing = join(root, 'missing');
    const store = await pinContainedRoot(missing, undefined, options);
    rule = (kind, file) => file === root ? 2n : 1n;
    await expect(appendContainedFile(store, 'file', 'changed')).rejects.toThrow(/root changed/);
    await expect(fs.access(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not join a missing-root cohort with a reused ancestor inode', async () => {
    const missing = join(root, 'missing');
    const old = await pinContainedRoot(missing, undefined, options);
    rule = (kind, file) => file === root ? 2n : 1n;
    const fresh = await pinContainedRoot(missing, undefined, options);
    expect(fresh).not.toBe(old);
    await appendContainedFile(fresh, 'file', 'fresh');
    await expect(appendContainedFile(old, 'file', 'changed')).rejects.toThrow(/root changed/);
  });

  it('rechecks the observed ancestor after joining in-progress creation', async () => {
    const progress = join(root, 'progress');
    const missing = join(progress, 'deep/store');
    const first = await pinContainedRoot(missing, undefined, options);
    let entered, release;
    const created = new Promise(resolve => { entered = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      if (String(args[0]).endsWith('/progress')) { entered(); await resume; }
      return result;
    });
    const append = appendContainedFile(first, 'file', 'fresh');
    try {
      await created;
      let reads = 0;
      rule = (kind, file) => {
        if (kind !== 'stat' || file !== progress) return 1n;
        release();
        return ++reads === 1 ? 1n : 2n;
      };
      const second = await pinContainedRoot(missing, undefined, options);
      await append;
      await expect(appendContainedFile(second, 'file', 'changed')).rejects.toThrow(/root changed/);
      expect(reads).toBe(2);
      expect(await fs.readFile(join(missing, 'file'), 'utf8')).toBe('fresh');
    } finally { release(); await Promise.allSettled([append]); }
  });

  it.each(['created', 'current'])('checks a newly created storage directory against its %s generation', async side => {
    const missing = join(root, 'missing');
    const store = await pinContainedRoot(missing, undefined, options);
    let reads = 0;
    rule = (kind, file) => {
      if (file !== missing) return 1n;
      if (kind === 'lstat') reads++;
      if (side === 'created') return reads === 1 && kind === 'lstat' ? 1n : 2n;
      return kind === 'lstat' && reads >= (platform === 'linux' ? 2 : 3) ? 2n : 1n;
    };
    await expect(appendContainedFile(store, 'file', 'changed')).rejects.toThrow(/root changed during creation/);
  });

  if (platform === 'linux') {
    it('checks the opened root against the pinned generation', async () => {
      const store = await pinContainedRoot(root);
      rule = (kind, file) => file === root && kind !== 'stat' ? 2n : 1n;
      await expect(openContainedFile(store, 'file')).rejects.toThrow(/root changed/);
    });
    it.each(['file', 'dir'])('checks the opened %s against the directory entry generation', async name => {
      const store = await pinContainedRoot(root);
      rule = (kind, file) => file === join(root, name) && kind === 'fstat' ? 2n : 1n;
      await expect(openContainedFile(store, name === 'dir' ? 'dir/new' : 'file', { append: true })).rejects.toThrow(/changed during access/);
    });
    it('checks the opened creation ancestor against its pinned generation', async () => {
      const store = await pinContainedRoot(join(root, 'missing'), undefined, options);
      rule = (kind, file) => file === root && kind !== 'stat' ? 2n : 1n;
      await expect(appendContainedFile(store, 'file', 'changed')).rejects.toThrow(/root changed/);
    });
  }

  it('rechecks the deletion target generation immediately before unlink', async () => {
    const store = await pinContainedRoot(root);
    const access = await openContainedFile(store, 'file', { remove: true });
    rule = (kind, file) => file === join(root, 'file') ? 2n : 1n;
    await expect(access.unlink()).rejects.toThrow();
    expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('original');
  });

  if (platform !== 'linux') {
    it('rechecks the listed directory generation', async () => {
      const store = await pinContainedRoot(root);
      const access = await openContainedFile(store, 'dir/.aiwg-list', { listing: true });
      rule = (kind, file) => file === join(root, 'dir') ? 2n : 1n;
      await expect(access.entries()).rejects.toThrow(/changed during access/);
    });
    it.each(['target', 'current'])('checks the opened file against its %s generation', async side => {
      const store = await pinContainedRoot(root);
      let opened = false;
      onOpen = file => { if (file === join(root, 'file')) opened = true; };
      rule = (kind, file) => file === join(root, 'file') && opened && (side === 'target' || kind === 'lstat') ? 2n : 1n;
      await expect(openContainedFile(store, 'file', { append: true })).rejects.toThrow(/changed during access/);
      expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('original');
    });
    it.each(['entry', 'opened'])('rechecks the append handle against the %s generation', async side => {
      const store = await pinContainedRoot(root);
      const access = await openContainedFile(store, 'file', { append: true });
      rule = (kind, file) => file === join(root, 'file') && (side === 'opened' || kind === 'lstat') ? 2n : 1n;
      await expect(access.appendContent('changed')).rejects.toThrow(/nonregular or multiply-linked/);
      expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('original');
    });
    it.each(['entry', 'opened'])('rechecks the overwrite handle against the %s generation', async side => {
      const store = await pinContainedRoot(root);
      const access = await openContainedFile(store, 'file', { write: true });
      await access.handle.writeFile('changed');
      rule = (kind, file) => file.endsWith('.tmp') && (side === 'opened' || kind === 'lstat') ? 2n : 1n;
      await expect(access.commit()).rejects.toThrow(/changed during access/);
      expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('original');
    });
  }
});
