import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, linkSync, utimesSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { ContextWriteJournal, writeContextFileSync } from '../../../src/smiths/context-pipeline/context-file-safety.js';
import { generate } from '../../../src/smiths/context-pipeline/generator.js';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import type { Platform } from '../../../src/agents/types.js';

const { beforeOpen, afterTruncate, beforeRename, writeOverride, host } = vi.hoisted(() => ({ beforeOpen: vi.fn(), afterTruncate: vi.fn(), beforeRename: vi.fn(), writeOverride: vi.fn(), host: { fallback: false, windows: false } }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, get constants() {
    if (!host.windows) return actual.constants;
    const { O_NOFOLLOW: _nofollow, O_DIRECTORY: _directory, ...portable } = actual.constants;
    return portable;
  }, mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
    if (host.windows && String(args[0]) === parse(String(args[0])).root) throw Object.assign(new Error('synthetic Windows root mkdir'), { code: 'EPERM' });
    return actual.mkdirSync(...args);
  }, statSync: (...args: Parameters<typeof actual.statSync>) => {
    if (host.fallback && String(args[0]).startsWith('/proc/self/fd/')) throw Object.assign(new Error('synthetic missing procfs'), { code: 'ENOENT' });
    return actual.statSync(...args);
  }, writeSync: (...args: Parameters<typeof actual.writeSync>) => writeOverride(...args) ?? actual.writeSync(...args), ftruncateSync: (...args: Parameters<typeof actual.ftruncateSync>) => {
    actual.ftruncateSync(...args);
    afterTruncate(...args);
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    beforeRename(...args);
    actual.renameSync(...args);
  }, openSync: (...args: Parameters<typeof actual.openSync>) => {
    beforeOpen(...args);
    return actual.openSync(...args);
  } };
});

let root: string;
let journal: ContextWriteJournal;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-context-journal-'));
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(name, root);
  journal = new ContextWriteJournal();
});
afterEach(() => {
  journal.dispose();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.each(['descriptor', 'fallback'])('deploy-owned context write journal (%s)', backend => {
  beforeEach(() => { host.fallback = backend === 'fallback'; });
  afterEach(() => { host.fallback = false; host.windows = false; });
  it('records completed writes before the step throws, including bytes and mode', () => {
    const file = join(root, 'AGENTS.md');
    const original = Buffer.from([0, 255, 13, 10, 9]);
    writeFileSync(file, original, { mode: 0o640 });
    expect(() => {
      writeContextFileSync(file, 'first pass');
      writeContextFileSync(file, 'second pass');
      writeContextFileSync(join(root, 'WARP.md'), 'new file');
      throw new Error('write then throw');
    }).toThrow('write then throw');
    expect(journal.rollback().conflicts).toEqual([]);
    expect(readFileSync(file)).toEqual(original);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(existsSync(join(root, 'WARP.md'))).toBe(false);
  });

  it('journals a short write followed by an I/O error', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const file = join(root, 'AGENTS.md');
    writeFileSync(file, 'original bytes');
    writeOverride.mockImplementationOnce((fd, buffer, offset, _length, position) => actual.writeSync(fd, buffer, offset, 2, position));
    writeOverride.mockImplementationOnce(() => { throw new Error('synthetic I/O failure'); });
    expect(() => writeContextFileSync(file, 'deploy bytes')).toThrow('synthetic I/O failure');
    expect(readFileSync(file, 'utf8')).toBe('deiginal bytes');
    expect(journal.rollback().conflicts).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('original bytes');
  });

  it('keeps an operator edit and refuses to reclaim ownership in a later pass', () => {
    const file = join(root, 'AGENTS.md');
    writeFileSync(file, 'before');
    writeContextFileSync(file, 'deploy');
    writeFileSync(file, 'operator edit');
    expect(() => writeContextFileSync(file, 'later deploy pass')).toThrow('Context changed during deployment');
    expect(journal.rollback().conflicts).toEqual([{ path: file, reason: 'Context changed since deployment wrote it' }]);
    expect(readFileSync(file, 'utf8')).toBe('operator edit');
  });

  it('never claims an operator edit made immediately after the completed write', () => {
    const file = join(root, 'AGENTS.md');
    writeFileSync(file, 'before');
    afterTruncate.mockImplementationOnce(() => writeFileSync(file, 'operator after write'));
    expect(() => writeContextFileSync(file, 'deployment')).toThrow('Context');
    expect(journal.rollback().conflicts).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('operator after write');
  });

  it('keeps a newly created file swapped immediately before rollback removal', () => {
    const file = join(root, 'AGENTS.md');
    writeContextFileSync(file, 'deployment');
    beforeRename.mockImplementationOnce(() => {
      unlinkSync(file);
      writeFileSync(file, 'operator replacement');
    });
    expect(journal.rollback().conflicts).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('operator replacement');
  });

  it.each(['mode', 'identity', 'symlink', 'ancestor'])('keeps %s changes during rollback', change => {
    const parent = join(root, 'provider');
    mkdirSync(parent);
    const file = join(parent, 'AGENTS.md');
    writeFileSync(file, 'before');
    writeContextFileSync(file, 'deployment');
    if (change === 'mode') chmodSync(file, 0o600);
    if (change === 'identity') { unlinkSync(file); writeFileSync(file, 'deployment'); }
    if (change === 'symlink') { unlinkSync(file); writeFileSync(join(root, 'outside'), 'operator'); symlinkSync(join(root, 'outside'), file); }
    if (change === 'ancestor') { renameSync(parent, join(root, 'original-parent')); mkdirSync(parent); writeFileSync(file, 'operator'); }
    const result = journal.rollback();
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(change === 'mode' || change === 'identity' ? 'deployment' : 'operator');
  });

  it.each(['file link', 'ancestor link', 'hard link', 'unreadable', 'unwritable'])('refuses a %s before writing', target => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const original = join(outside, 'AGENTS.md');
    writeFileSync(original, 'operator');
    let file = original;
    if (target === 'file link') { file = join(root, 'AGENTS.md'); symlinkSync(original, file); }
    if (target === 'ancestor link') { symlinkSync(outside, join(root, 'provider')); file = join(root, 'provider/AGENTS.md'); }
    if (target === 'hard link') linkSync(original, join(root, 'hard-link'));
    if (target === 'unreadable') chmodSync(file, 0o200);
    if (target === 'unwritable') chmodSync(file, 0o400);
    expect(() => writeContextFileSync(file, 'deployment')).toThrow();
    chmodSync(original, 0o600);
    expect(readFileSync(original, 'utf8')).toBe('operator');
    expect(journal.rollback()).toEqual({ restored: [], conflicts: [] });
  });

  it.each(['write', 'restore'])('refuses a file symlink swapped in just before target open during %s', operation => {
    host.windows = backend === 'fallback';
    const file = join(root, 'AGENTS.md');
    const outside = join(root, 'outside');
    writeFileSync(file, 'before');
    writeFileSync(outside, 'outside operator');
    if (operation === 'restore') writeContextFileSync(file, 'deployment');
    let swapped = false;
    beforeOpen.mockImplementation((target, flags) => {
      if (!swapped && typeof target === 'string' && target.endsWith('/AGENTS.md') && typeof flags === 'number' && (flags & constants.O_RDWR)) {
        swapped = true;
        unlinkSync(file);
        symlinkSync(outside, file);
      }
    });
    if (operation === 'write') expect(() => writeContextFileSync(file, 'deployment')).toThrow();
    else expect(journal.rollback().conflicts).toHaveLength(1);
    expect(swapped).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside operator');
  });

  it.each(['write', 'restore'])('does not follow an ancestor swapped after checking during %s', operation => {
    const parent = join(root, 'provider');
    const outside = join(root, 'outside');
    mkdirSync(parent);
    mkdirSync(outside);
    const file = join(parent, 'AGENTS.md');
    writeFileSync(file, 'before');
    writeFileSync(join(outside, 'AGENTS.md'), 'outside operator');
    if (operation === 'restore') writeContextFileSync(file, 'deployment');
    let swapped = false;
    beforeOpen.mockImplementation((target, flags) => {
      if (!swapped && typeof target === 'string' && target.endsWith('/AGENTS.md') && typeof flags === 'number' && (flags & constants.O_RDWR)) {
        swapped = true;
        renameSync(parent, join(root, 'pinned-parent'));
        symlinkSync(outside, parent, 'dir');
      }
    });
    if (operation === 'write') expect(() => writeContextFileSync(file, 'deployment')).toThrow('Context ancestor changed');
    else expect(journal.rollback().conflicts).toHaveLength(1);
    expect(swapped).toBe(true);
    expect(readFileSync(join(outside, 'AGENTS.md'), 'utf8')).toBe('outside operator');
    expect(readFileSync(join(root, 'pinned-parent/AGENTS.md'), 'utf8')).toBe(operation === 'write' ? 'before' : 'deployment');
  });

  it('writes and restores normally without Windows-absent flags', () => {
    host.windows = true;
    host.fallback = true;
    expect(constants).not.toHaveProperty('O_NOFOLLOW');
    expect(constants).not.toHaveProperty('O_DIRECTORY');
    const file = join(root, 'nested/AGENTS.md');
    writeContextFileSync(file, 'deployment');
    expect(readFileSync(file, 'utf8')).toBe('deployment');
    expect(journal.rollback()).toEqual({ restored: [file], conflicts: [] });
    expect(existsSync(file)).toBe(false);
  });

  it.each(['write', 'restore'])('keeps a same-byte edit with changed mtime before %s', operation => {
    const file = join(root, 'AGENTS.md');
    writeContextFileSync(file, 'deployment');
    const edited = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, edited, edited);
    if (operation === 'write') expect(() => writeContextFileSync(file, 'later deploy')).toThrow('Context changed during deployment');
    expect(journal.rollback().conflicts).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('deployment');
  });

  it('keeps a concurrent edit detected immediately after restore', () => {
    const file = join(root, 'AGENTS.md');
    writeFileSync(file, 'before');
    writeContextFileSync(file, 'deployment');
    afterTruncate.mockImplementationOnce(() => writeFileSync(file, 'operator during restore'));
    expect(journal.rollback().conflicts).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('operator during restore');
  });

  it.each(PROVIDER_IDS)('restores actual generator outputs for %s after a late failure', async provider => {
    // Config/home-sensitive generation runs only against synthetic project data.
    const file = join(root, 'WORKSPACE.md');
    const original = Buffer.from('# Workspace\r\n<!-- aiwg-managed -->\r\noperator bytes\r\n');
    writeFileSync(file, original, { mode: 0o600 });
    const result = await generate({ projectPath: root, provider: provider as Platform, sections: [], detectExistingFiles: true });
    expect(result.normalizedAiwgMdPath).toBeTruthy();
    const rollback = journal.rollback();
    expect(rollback.conflicts).toEqual([]);
    expect(readFileSync(file)).toEqual(original);
    for (const output of [result.aiwgMdPath, result.agentsMdPath, result.normalizedAiwgMdPath, ...result.twinPaths, ...result.contextRegistrationPaths, ...(result.claudeMdHookPath ? [result.claudeMdHookPath] : [])].filter(Boolean)) {
      expect(existsSync(output), output).toBe(false);
    }
  });
});
