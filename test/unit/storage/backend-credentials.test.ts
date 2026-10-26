import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import type { SensitiveInputDependencies } from '../../../src/auth/sensitive-input.js';
import { LogseqAdapter } from '../../../src/storage/backends/logseq.js';

const secret = 'logseq-fixture-token';
const roots: string[] = [];
let graph: string;
let output: string[];
let http: ReturnType<typeof vi.fn>;
let spawn: ReturnType<typeof vi.spyOn>;
let execFile: ReturnType<typeof vi.spyOn>;
function fixture(value = secret): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-storage-credential-'));
  roots.push(root);
  const file = path.join(root, 'private');
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}
beforeEach(() => {
  graph = path.dirname(fixture());
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { output.push(String(value)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(value => { output.push(String(value)); return true; });
  spawn = vi.spyOn(childProcess, 'spawn');
  execFile = vi.spyOn(childProcess, 'execFile');
  http = vi.fn(async () => new Response('null', { status: 200 }));
  vi.stubGlobal('fetch', http);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(reference?: string, dependencies: SensitiveInputDependencies = {}): Promise<unknown> {
  return new LogseqAdapter({ type: 'logseq', graph, apiTokenEnv: reference }, dependencies).init();
}
function assertPrivate() {
  expect(output.join('')).not.toContain(secret);
  // Logseq uses in-process HTTP calls. Store IO is injected.
  expect(spawn).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
  expect(JSON.stringify(process.argv)).not.toContain(secret);
}
async function failure(operation: Promise<unknown>, pattern: RegExp) {
  const error = await operation.then(() => undefined, (error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toMatch(pattern);
  expect(`${error!.stack} ${JSON.stringify(error)}`).not.toContain(secret);
  assertPrivate();
}

describe('Logseq storage credential references (#3079)', () => {
  it('reads a private file without exposing the value on argv or output', async () => {
    await run(`file:${fixture()}`);
    expect(http.mock.calls.at(-1)?.[1].headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    assertPrivate();
  });

  it('uses only the selected native store entry without prompting or falling back', async () => {
    const readStore = vi.fn(async () => secret);
    const prompt = vi.fn(async () => { throw new Error('unexpected prompt'); });
    await run('store:fixture-storage', { readStore, prompt, isTTY: true, environment: { LOGSEQ_API_TOKEN: 'unused' } });
    expect(readStore).toHaveBeenCalledExactlyOnceWith('fixture-storage');
    expect(prompt).not.toHaveBeenCalled();
    await failure(run('store:fixture-storage', { readStore: async () => null }), /no key/);
    await failure(run('store:fixture-storage', { readStore: async () => { throw new Error(secret); } }), /store entry could not be read/);
    assertPrivate();
  });

  it.each([0o640, 0o604])('rejects private-file mode %s', async mode => {
    const file = fixture();
    chmodSync(file, mode);
    await failure(run(`file:${file}`), /group or other access/);
    expect(http).not.toHaveBeenCalled();
  });

  it('rejects symlinks and hard links before delivering a credential', async () => {
    const file = fixture();
    symlinkSync(file, `${file}.symlink`);
    await failure(run(`file:${file}.symlink`), /symlink/);
    linkSync(file, `${file}.hardlink`);
    await failure(run(`file:${file}`), /hard link/);
  });

  it('rejects files owned by another user', async () => {
    const file = fixture();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await failure(run(`file:${file}`), /not owned by the current user/);
  });

  it('preserves the legacy environment value and default selector', async () => {
    await run(undefined, { environment: { LOGSEQ_API_TOKEN: secret } });
    expect(http.mock.calls.at(-1)?.[1].headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    assertPrivate();
  });

  it('names the configuration choices for a missing explicit environment value', async () => {
    await failure(run('FIXTURE_MISSING', { environment: {} }), /ENV_NAME.*file:ABSOLUTE_PATH.*store:NAME/);
  });
});

describe('Logseq storage error boundaries (#3079)', () => {
  it('keeps the optional Logseq missing-token fallback and ignores unused references', async () => {
    await run(undefined, { environment: {} });
    expect(output.join('')).toContain('LOGSEQ_API_TOKEN is not set');
    await new LogseqAdapter({ type: 'logseq', graph, useApi: false, apiTokenEnv: 'file:/missing' }).init();
    expect(http).not.toHaveBeenCalled();
  });

  it('keeps reflected Logseq HTTP errors out of its fallback warning', async () => {
    http.mockRejectedValueOnce(new Error(secret));
    await run(`file:${fixture()}`);
    expect(output.join('')).toContain('not reachable');
    assertPrivate();
  });
});
