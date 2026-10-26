import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLocalExecutorToken, localExecutorServeHandler } from '../../../src/cli/handlers/local-executor.js';

let root: string;
const token = 'synthetic-executor-secret';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-executor-input-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('local executor optional bearer sources', () => {
  it('retains environment and no-source registration behavior without prompting', async () => {
    const prompt = vi.fn();
    await expect(resolveLocalExecutorToken([], { environment: {}, isTTY: true, prompt })).resolves.toBeUndefined();
    await expect(resolveLocalExecutorToken([], { environment: { AIWG_EXECUTOR_TOKEN: token }, isTTY: true, prompt })).resolves.toBe(token);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('resolves stdin, private file, store and named environment sources', async () => {
    const file = path.join(root, 'input'); fs.writeFileSync(file, token, { mode: 0o600 });
    await expect(resolveLocalExecutorToken(['--token-stdin'], { isTTY: false, readStdin: async () => token })).resolves.toBe(token);
    await expect(resolveLocalExecutorToken(['--token-file', file])).resolves.toBe(token);
    const readStore = vi.fn(async () => token);
    await expect(resolveLocalExecutorToken(['--token-store', 'executor'], { readStore })).resolves.toBe(token);
    expect(readStore).toHaveBeenCalledWith('executor');
    await expect(resolveLocalExecutorToken(['--token-env', 'EXAMPLE'], { environment: { EXAMPLE: token } })).resolves.toBe(token);
  });

  it('uses standard explicit precedence and never falls back from a missing selected source', async () => {
    await expect(resolveLocalExecutorToken(['--token-stdin', '--token-store', 'unused'], {
      isTTY: false, readStdin: async () => token, readStore: async () => { throw new Error('should not read store'); },
    })).resolves.toBe(token);
    await expect(resolveLocalExecutorToken(['--token-env', 'MISSING'], { environment: { AIWG_EXECUTOR_TOKEN: token } })).rejects.toThrow(/--token-env received no key/);
    await expect(resolveLocalExecutorToken(['--token-interactive'], { isTTY: false })).rejects.toThrow(/--token-stdin.*--token-file.*--token-store/);
  });

  it.each(['group', 'other', 'symlink', 'owner'])('refuses a %s private-file violation without disclosing its value', async kind => {
    const file = path.join(root, 'input'); const target = path.join(root, 'target');
    fs.writeFileSync(target, token, { mode: 0o600 });
    if (kind === 'symlink') fs.symlinkSync(target, file);
    else {
      fs.writeFileSync(file, token, { mode: 0o600 });
      if (kind === 'group') fs.chmodSync(file, 0o640);
      if (kind === 'other') fs.chmodSync(file, 0o604);
    }
    if (kind === 'owner') vi.spyOn(process, 'getuid').mockReturnValue(fs.statSync(target).uid + 1);
    await expect(resolveLocalExecutorToken(['--token-file', file])).rejects.toThrow(/group or other|symlink|not owned/);
  });

  it('returns source errors before startup imports or identity generation', async () => {
    const log = vi.spyOn(console, 'log'); const error = vi.spyOn(console, 'error');
    const result = await localExecutorServeHandler.execute({ args: ['serve', '--token-file', path.join(root, 'missing')], rawArgs: [], cwd: root, frameworkRoot: root });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/--token-file: file does not exist/);
    expect(JSON.stringify([result, log.mock.calls, error.mock.calls])).not.toContain(token);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('redacts a registration-issued bearer reflected by server startup errors', async () => {
    vi.stubEnv('AIWG_EXECUTOR_TOKEN', '');
    const runtime = path.join(root, 'tools', 'ralph-external'); fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'executor-shim.mjs'), `
      export class ExecutorShim {
        async register() { return 'synthetic-issued-executor-secret'; }
        async deregister() {}
      }
      export async function startExecutorServer(shim, options) { throw new Error('Startup reflected ' + options.token); }
    `);
    fs.writeFileSync(path.join(runtime, 'daemon-supervisor.mjs'), 'export class DaemonSupervisor {}');
    const log = vi.spyOn(console, 'log'); const error = vi.spyOn(console, 'error');
    const result = await localExecutorServeHandler.execute({
      args: ['serve', '--executor-id', 'synthetic-executor'], rawArgs: [], cwd: root, frameworkRoot: root,
    });
    expect(result).toEqual({ exitCode: 1, message: 'Failed to start executor server: Startup reflected [REDACTED]' });
    expect(JSON.stringify([result, log.mock.calls, error.mock.calls])).not.toContain('synthetic-issued-executor-secret');
  });

});
