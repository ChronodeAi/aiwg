import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { namedSensitiveStore, readPrivateValueFile, resolveSensitiveInput, sensitiveInputOptions } from '../../../src/auth/sensitive-input.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture() { const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-sensitive-input-')); roots.push(root); return path.join(root, 'private'); }

describe('standard sensitive input', () => {
  it('selects interactive entry, stdin, file, store and env in that order without reading lower sources', async () => {
    const sources = { interactive: true, stdin: true, file: 'fixture', store: 'example', env: 'EXAMPLE', prefix: 'token' };
    const prompt = vi.fn(async () => 'fixture-prompt');
    const readStdin = vi.fn(async () => 'fixture-stdin');
    const readFile = vi.fn(async () => 'fixture-file');
    const readStore = vi.fn(async () => 'fixture-store');
    const readEnv = vi.fn(() => 'fixture-env');
    const deps = { isTTY: true, prompt, readStdin, readFile, readStore, readEnv };
    expect(await resolveSensitiveInput(sources, deps)).toBe('fixture-prompt');
    expect(readStdin).not.toHaveBeenCalled();
    expect(await resolveSensitiveInput({ ...sources, interactive: false }, { ...deps, isTTY: false })).toBe('fixture-stdin');
    expect(readFile).not.toHaveBeenCalled();
    expect(await resolveSensitiveInput({ ...sources, interactive: false, stdin: false }, deps)).toBe('fixture-file');
    expect(readStore).not.toHaveBeenCalled();
    expect(await resolveSensitiveInput({ store: 'example', env: 'EXAMPLE' }, deps)).toBe('fixture-store');
    expect(readEnv).not.toHaveBeenCalled();
    expect(await resolveSensitiveInput({ env: 'EXAMPLE' }, deps)).toBe('fixture-env');
  });

  it('prompts with no source at a terminal; headless names every option without consuming stdin', async () => {
    const readStdin = vi.fn(async () => 'ignored');
    expect(await resolveSensitiveInput({}, { isTTY: true, prompt: async () => 'fixture-hidden' })).toBe('fixture-hidden');
    await expect(resolveSensitiveInput({ prefix: 'token' }, { isTTY: false, readStdin })).rejects.toThrow(/--token-interactive.*--token-stdin.*--token-file.*--token-store.*--token-env/);
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('names raw entries in the existing OS store without touching OAuth entries', () => {
    expect(namedSensitiveStore('fixture-entry').metadata.location).toContain('aiwg.sensitive-values/fixture-entry');
    expect(() => namedSensitiveStore('bad\nname')).toThrow('store name');
  });

  it('never falls back from a selected empty source and refuses interactive stdin', async () => {
    const readEnv = vi.fn(() => 'fallback');
    await expect(resolveSensitiveInput({ stdin: true, env: 'EXAMPLE' }, { isTTY: false, readStdin: async () => '', readEnv })).rejects.toThrow('received no key');
    expect(readEnv).not.toHaveBeenCalled();
    await expect(resolveSensitiveInput({ stdin: true }, { isTTY: true })).rejects.toThrow('requires piped input');
  });

  it('validates reference options and refuses multiline values without echoing input', async () => {
    expect(sensitiveInputOptions(['--token-file', 'fixture', '--token-store', 'entry'], 'token')).toEqual({ prefix: 'token', file: 'fixture', store: 'entry' });
    expect(sensitiveInputOptions(['--token-env=EXAMPLE'], 'token')).toEqual({ prefix: 'token', env: 'EXAMPLE' });
    expect(() => sensitiveInputOptions(['--token-env', '--other'], 'token')).toThrow('--token-env requires a value');
    await expect(resolveSensitiveInput({ env: 'bad=value' }, { isTTY: false })).rejects.toThrow('shell variable name');
    await expect(resolveSensitiveInput({ stdin: true }, { isTTY: false, readStdin: async () => 'fixture-one\nfixture-two' })).rejects.toThrow('one non-empty line');
    await expect(resolveSensitiveInput({ store: 'entry' }, { isTTY: false, readStore: async () => { throw new Error('fixture-sensitive-value'); } })).rejects.toThrow('--value-store: native store entry could not be read.');
  });

  it('reads a private regular file and refuses group or other access', async () => {
    const file = fixture();
    writeFileSync(file, 'fixture-file-value\n', { mode: 0o600 });
    expect(await readPrivateValueFile(file)).toBe('fixture-file-value');
    if (process.platform !== 'win32') {
      for (const mode of [0o640, 0o604, 0o610]) {
        chmodSync(file, mode);
        await expect(readPrivateValueFile(file)).rejects.toThrow('group or other access');
      }
    }
  });

  it('refuses a file owned by a different user before reading its content', async () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
    const file = fixture();
    writeFileSync(file, 'fixture-value', { mode: 0o600 });
    const current = process.getuid();
    vi.spyOn(process, 'getuid').mockReturnValue(current + 1);
    await expect(readPrivateValueFile(file)).rejects.toThrow('not owned by the current user');
  });

  it('refuses symlinks, extra hard links, directories and missing files', async () => {
    const file = fixture();
    writeFileSync(file, 'fixture-value', { mode: 0o600 });
    symlinkSync(file, `${file}.symlink`);
    await expect(readPrivateValueFile(`${file}.symlink`)).rejects.toThrow('symlink');
    linkSync(file, `${file}.hardlink`);
    await expect(readPrivateValueFile(file)).rejects.toThrow('hard link');
    mkdirSync(`${file}.dir`);
    await expect(readPrivateValueFile(`${file}.dir`)).rejects.toThrow('not a regular file');
    await expect(readPrivateValueFile(`${file}.missing`)).rejects.toThrow('does not exist');
  });
});
