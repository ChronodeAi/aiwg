import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResourceCredentialProvider, prepareResourceCredentials } from "../../../src/auth/resource-credentials.js";
import { MemoryCredentialStore } from "../../../src/auth/credential-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function privateFile(value = 'synthetic-release-bearer'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-resource-credentials-'));
  roots.push(root);
  const file = path.join(root, 'token');
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}
function authStore(): MemoryCredentialStore {
  const store = new MemoryCredentialStore();
  store.value = { accessToken: "aiwg_at_stored", refreshToken: "aiwg_rt_stored", tokenType: "Bearer", scope: [], expiresAt: "2030-01-01T00:00:00Z" };
  return store;
}

describe("resource credential precedence", () => {
  it("preserves legacy private file, environment, auth store, and optional public lookup", async () => {
    const store = authStore();
    const load = vi.spyOn(store, 'load');
    expect(await createResourceCredentialProvider({ AIWG_RESOURCE_TOKEN_FILE: privateFile(), AIWG_RESOURCE_TOKEN: "env-fixture" }, store)()).toBe('synthetic-release-bearer');
    expect(await createResourceCredentialProvider({ AIWG_RESOURCE_TOKEN: " env-fixture\n" }, store)()).toBe('env-fixture');
    expect(load).not.toHaveBeenCalled();
    expect(await createResourceCredentialProvider({}, store)()).toBe('aiwg_at_stored');
    expect(await createResourceCredentialProvider({}, new MemoryCredentialStore())()).toBeNull();
    // An empty compatibility file has always skipped the env token and tried login.
    expect(await createResourceCredentialProvider({ AIWG_RESOURCE_TOKEN_FILE: privateFile(''), AIWG_RESOURCE_TOKEN: 'ignored' }, store)()).toBe('aiwg_at_stored');
  });

  it('never implicitly prompts or consumes stdin, even at a terminal', async () => {
    const prompt = vi.fn();
    const readStdin = vi.fn();
    const credentials = await prepareResourceCredentials(['--offline'], {}, new MemoryCredentialStore(), { isTTY: true, prompt, readStdin });
    expect(await credentials.credentialProvider()).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('retains public fallback only for an unavailable native helper', async () => {
    const store = authStore();
    vi.spyOn(store, 'load').mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'ENOENT' })).mockRejectedValueOnce(new Error('corrupt credentials'));
    expect(await createResourceCredentialProvider({}, store)()).toBeNull();
    await expect(createResourceCredentialProvider({}, store)()).rejects.toThrow('corrupt credentials');
  });

  it('selects the five sources in standard order, once, before all compatibility sources', async () => {
    const sources = { interactive: true, stdin: true, file: 'unused', store: 'release', env: 'RELEASE' };
    const deps = { isTTY: true, stdinIsTTY: false, prompt: vi.fn(async () => 'prompt-fixture'), readStdin: vi.fn(async () => 'stdin-fixture'), readFile: vi.fn(async () => 'file-fixture'), readStore: vi.fn(async () => 'store-fixture') };
    const store = authStore();
    const load = vi.spyOn(store, 'load');
    for (const [source, expected] of [
      [sources, 'prompt-fixture'],
      [{ ...sources, interactive: false }, 'stdin-fixture'],
      [{ file: 'unused', store: 'release', env: 'RELEASE' }, 'file-fixture'],
      [{ store: 'release', env: 'RELEASE' }, 'store-fixture'],
      [{ env: 'RELEASE' }, 'env-fixture'],
    ] as const) {
      const provider = createResourceCredentialProvider({ RELEASE: 'env-fixture', AIWG_RESOURCE_TOKEN_FILE: '/must-not-be-read', AIWG_RESOURCE_TOKEN: 'legacy' }, store, source, deps);
      expect(await provider()).toBe(expected);
      expect(await provider()).toBe(expected);
    }
    for (const reader of [deps.prompt, deps.readStdin, deps.readFile, deps.readStore]) expect(reader).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('strips reference flags before positional parsing and helper forwarding', async () => {
    const prepared = await prepareResourceCredentials(['--resource-token-env=RELEASE', 'search', '--resource-token-store', 'release', '--json'], {}, authStore(), { readStore: async () => 'store-fixture' });
    expect(prepared.args).toEqual(['search', '--json']);
    expect(prepared.omitEnv).toEqual(['AIWG_RESOURCE_TOKEN', 'RELEASE']);
    expect(await prepared.credentialProvider()).toBe('store-fixture');
    const terminated = await prepareResourceCredentials(['search', '--', '--resource-token-file', 'literal'], {}, authStore());
    expect(terminated.args).toEqual(['search', '--', '--resource-token-file', 'literal']);
  });

  it('fails explicit empty, invalid or missing input without fallback or disclosure', async () => {
    const store = authStore();
    const load = vi.spyOn(store, 'load');
    for (const source of [{ stdin: true }, { store: 'release' }, { env: 'MISSING' }, { env: 'bad=value' }]) {
      const provider = createResourceCredentialProvider({ AIWG_RESOURCE_TOKEN: 'legacy' }, store, source, { isTTY: false, readStdin: async () => '', readStore: async () => { throw new Error('synthetic-release-bearer'); } });
      await expect(provider()).rejects.toThrow(/--resource-token-/);
      await expect(provider()).rejects.not.toThrow('synthetic-release-bearer');
    }
    expect(load).not.toHaveBeenCalled();
    await expect(prepareResourceCredentials(['--resource-token-interactive'], {}, store, { isTTY: false })).rejects.toThrow(/--resource-token-interactive.*--resource-token-stdin.*--resource-token-file.*--resource-token-store.*--resource-token-env/);
    for (const args of [['--resource-token-file'], ['--resource-token-env='], ['--resource-token-store', 'one', '--resource-token-store', 'two']]) {
      await expect(prepareResourceCredentials(args, {}, store)).rejects.toThrow(/--resource-token-/);
    }
  });

  it.each(['explicit', 'legacy'])('refuses insecure %s files with clear errors and no value', async kind => {
    if (process.platform === 'win32') return;
    const file = privateFile();
    const provider = (selected = file) => kind === 'explicit'
      ? createResourceCredentialProvider({}, authStore(), { file: selected })()
      : createResourceCredentialProvider({ AIWG_RESOURCE_TOKEN_FILE: selected }, authStore())();
    for (const mode of [0o640, 0o604]) {
      chmodSync(file, mode);
      await expect(provider()).rejects.toThrow(/group or other access/);
      await expect(provider()).rejects.not.toThrow('synthetic-release-bearer');
    }
    chmodSync(file, 0o600);
    symlinkSync(file, `${file}.symlink`);
    await expect(provider(`${file}.symlink`)).rejects.toThrow(/symlink/);
    if (process.getuid) {
      const uid = process.getuid();
      const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      await expect(provider()).rejects.toThrow(/not owned by the current user/);
      spy.mockRestore();
    }
    linkSync(file, `${file}.hardlink`);
    await expect(provider()).rejects.toThrow(/hard link/);
  });
});
