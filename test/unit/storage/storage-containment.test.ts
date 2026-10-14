import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilesystemAdapter } from '../../../src/storage/backends/fs.js';

const host = process;
describe.each(['linux', 'darwin', 'win32'])('filesystem containment (%s access)', platform => {
  let base: string, root: string, outside: string, adapter: FilesystemAdapter;
  beforeEach(async () => {
    base = await fs.mkdtemp(join(tmpdir(), 'aiwg-storage-containment-'));
    root = join(base, 'store'); outside = join(base, 'store-outside');
    await fs.mkdir(root); await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'sentinel'), 'outside bytes');
    vi.stubGlobal('process', new Proxy(host, { get: (target, key) => key === 'platform' ? platform : Reflect.get(target, key) }));
    adapter = new FilesystemAdapter(root);
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await fs.rm(base, { recursive: true, force: true }); });
  function call(op: string, path: string) {
    switch (op) {
      case 'read': return adapter.read(path);
      case 'write': return adapter.write(path, 'replacement');
      case 'append': return adapter.append(path, 'appended');
      case 'delete': return adapter.delete(path);
      default: return adapter.list(path);
    }
  }
  async function sentinel() {
    const s = await fs.stat(join(outside, 'sentinel'));
    return { bytes: await fs.readFile(join(outside, 'sentinel'), 'utf8'), ino: s.ino, dev: s.dev, nlink: s.nlink, mode: s.mode };
  }
  it.each(['read', 'write', 'append', 'delete', 'list'])('%s rejects lexical escapes and preserves the outside inode', async op => {
    const before = await sentinel();
    for (const path of ['../store-outside/sentinel', join(outside, 'sentinel'), 'a/../../store-outside/sentinel', 'C:sentinel', 'C:\\sentinel', '\\\\host\\share', '..\\sentinel']) {
      await expect(call(op, path)).rejects.toThrow();
      expect(await sentinel()).toEqual(before);
    }
  });
  it.each(['read', 'write', 'append', 'delete'])('%s refuses escaping/dangling symlinks, including directory ancestors', async op => {
    await fs.symlink(join(outside, 'sentinel'), join(root, 'escape'));
    await fs.symlink(outside, join(root, 'dir'), 'dir');
    await fs.symlink(join(outside, 'missing'), join(root, 'dangling'));
    const before = await sentinel();
    for (const path of ['escape', 'dir/sentinel', 'dir/new/deep/file', 'dangling', 'dangling/new/file']) {
      await expect(call(op, path)).rejects.toThrow();
      expect(await sentinel()).toEqual(before);
      expect(await fs.readdir(outside)).toEqual(['sentinel']);
    }
  });
  it.each(['read', 'write', 'append', 'delete'])('%s refuses hardlinks without changing outside link metadata', async op => {
    await fs.link(join(outside, 'sentinel'), join(root, 'linked'));
    const before = await sentinel();
    await expect(call(op, 'linked')).rejects.toThrow(/linked/);
    expect(await sentinel()).toEqual(before);
  });
  it.each(['read', 'write', 'append', 'delete', 'list'])('%s refuses root replacement and alias retarget', async op => {
    const alias = join(base, 'alias'); await fs.symlink(root, alias, 'dir');
    adapter = new FilesystemAdapter(alias);
    await adapter.write('inside', 'inside'); // establish accepted alias
    await fs.unlink(alias); await fs.symlink(outside, alias, 'dir');
    const before = await sentinel();
    await expect(call(op, op === 'list' ? '' : 'sentinel')).rejects.toThrow(/root changed/);
    expect(await sentinel()).toEqual(before);
    adapter = new FilesystemAdapter(root); await adapter.read('inside');
    await fs.rename(root, join(base, 'held')); await fs.mkdir(root);
    await expect(call(op, op === 'list' ? '' : 'new')).rejects.toThrow(/root changed/);
  });
  it('lists by string prefix without emitting symlinks or hardlinks', async () => {
    await adapter.write('a/file', 'a'); await adapter.write('ab/file', 'ab');
    await fs.symlink(outside, join(root, 'adir'), 'dir');
    await fs.symlink(join(root, 'a/file'), join(root, 'alias'));
    await fs.link(join(outside, 'sentinel'), join(root, 'alink'));
    const before = await sentinel();
    expect((await adapter.list('a')).map(e => e.path).sort()).toEqual(['a/file', 'ab/file']);
    expect((await adapter.list('a/')).map(e => e.path)).toEqual(['a/file']);
    expect(await sentinel()).toEqual(before);
  });
  it('preserves missing semantics, modes, ordinary names and fresh external root creation', async () => {
    adapter = new FilesystemAdapter(join(base, 'external/new/store'));
    expect(await adapter.read('missing/deep')).toBeNull();
    await adapter.delete('missing/deep'); expect(await adapter.list('')).toEqual([]);
    await adapter.append('./a/./file', 'one'); await adapter.append('a/file', 'two');
    expect(await adapter.read('a/file')).toBe('onetwo');
    const file = join(base, 'external/new/store/a/file');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o666 & ~process.umask());
    for (const mode of [0o600, 0o644, 0o755]) {
      await fs.chmod(file, mode); await adapter.write('a/file', 'new'); await adapter.append('a/file', '!');
      expect((await fs.stat(file)).mode & 0o777).toBe(mode);
    }
    await adapter.write('.aiwg-location', 'ordinary storage metadata');
    expect(await adapter.read('.aiwg-location')).toBe('ordinary storage metadata');
    if (platform !== 'win32') for (const name of ['trailing.', 'trailing ', 'time:12']) { await adapter.write(name, 'x'); expect(await adapter.read(name)).toBe('x'); }
  });
  it('refuses final symlinks and directories for mutation, allowing Linux contained reads', async () => {
    await fs.mkdir(join(root, 'directory')); await adapter.write('file', 'inside'); await fs.symlink(join(root, 'file'), join(root, 'alias'));
    if (platform === 'linux') expect(await adapter.read('alias')).toBe('inside');
    else await expect(adapter.read('alias')).rejects.toThrow();
    for (const op of ['write', 'append', 'delete']) {
      await expect(call(op, 'alias')).rejects.toThrow();
      await expect(call(op, 'directory')).rejects.toThrow();
    }
  });
  it('deletes an unreadable owned leaf without requiring a read handle', async () => {
    await adapter.write('unreadable', 'inside');
    await fs.chmod(join(root, 'unreadable'), 0o000);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file).endsWith('/unreadable')) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return open(file, flags, mode);
    });
    await expect(adapter.delete('unreadable')).resolves.toBeUndefined();
    await expect(fs.lstat(join(root, 'unreadable'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps failed partial overwrites private and preserves the original mode/content', async () => {
    await adapter.write('private', 'original'); await fs.chmod(join(root, 'private'), 0o600);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const h = await open(file, flags, mode);
      if (String(file).endsWith('.tmp')) {
        const write = h.writeFile.bind(h);
        vi.spyOn(h, 'writeFile').mockImplementation(async () => { await write('partial'); throw new Error('ENOSPC'); });
      }
      return h;
    });
    await expect(adapter.write('private', 'new')).rejects.toThrow('ENOSPC');
    expect(await fs.readFile(join(root, 'private'), 'utf8')).toBe('original');
    expect((await fs.stat(join(root, 'private'))).mode & 0o777).toBe(0o600);
    const leftovers = (await fs.readdir(root)).filter(name => name.startsWith('.aiwg-write-'));
    expect(leftovers).toHaveLength(1);
    expect((await fs.stat(join(root, leftovers[0]))).mode & 0o777).toBe(0o600);
  });
  it.each(['write', 'append', 'delete'])('%s rechecks hardlinks immediately before mutation', async op => {
    await adapter.write('file', 'inside');
    const lstat = fs.lstat.bind(fs); let checks = 0; let linked = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = String(args[0]);
      if (value.endsWith('/file') && ++checks === (platform === 'linux' ? 3 : 4)) {
        await fs.link(join(root, 'file'), join(outside, 'late-link')); linked = true;
      }
      return lstat(...args as Parameters<typeof lstat>);
    });
    await expect(call(op, 'file')).rejects.toThrow(/linked/);
    expect(linked).toBe(true);
    expect(await fs.readFile(join(outside, 'late-link'), 'utf8')).toBe('inside');
    expect((await fs.stat(join(outside, 'late-link'))).nlink).toBe(2);
  });
  it('does not adopt a missing root substituted before its first write', async () => {
    const missing = join(base, 'missing'); adapter = new FilesystemAdapter(missing);
    expect(await adapter.read('absent')).toBeNull();
    await fs.symlink(outside, missing, 'dir'); const before = await sentinel();
    await expect(adapter.write('sentinel', 'changed')).rejects.toThrow();
    expect(await sentinel()).toEqual(before);
  });
  it('refuses an unverifiable inode identity', async () => {
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const s = await stat(...args as Parameters<typeof stat>); Object.defineProperty(s, 'ino', { value: 0 }); return s;
    });
    adapter = new FilesystemAdapter(root);
    await expect(adapter.write('file', 'x')).rejects.toThrow(/identity/);
  });
  if (platform === 'linux') it('anchors append to the parent and closes descriptors on refusal', async () => {
    await adapter.write('parent/file', 'original');
    const open = fs.open.bind(fs); const opened: { close: () => Promise<void> }[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const h = await open(file, flags, mode); opened.push(h); const close = h.close.bind(h); vi.spyOn(h, 'close').mockImplementation(close);
      if (String(file).endsWith('/file')) await fs.rename(join(root, 'parent'), join(outside, 'moved'));
      return h;
    });
    await expect(adapter.append('parent/file', 'new')).rejects.toThrow();
    expect(await fs.readFile(join(outside, 'moved/file'), 'utf8')).toBe('original');
    expect(opened.length).toBeGreaterThan(0);
    for (const h of opened) expect(h.close).toHaveBeenCalledOnce();
    expect(constants.O_APPEND).toBeGreaterThan(0);
  });
});
