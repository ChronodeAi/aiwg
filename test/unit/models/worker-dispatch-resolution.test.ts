import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerInputs, modelsHandler } from '../../../src/cli/handlers/models.js';
import { resolveWorkerPlan } from '../../../src/models/resolver.js';
import * as workerInstallation from '../../../src/models/worker-installation.mjs';
import { WORKER_DISPATCH_ENABLE_COMMAND, WORKER_DISPATCH_READINESS_COMMAND } from '../../../src/models/worker-dispatch-offer.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(workerDispatch?: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-dispatch-resolution-'));
  roots.push(root);
  const cwd = path.join(root, 'project');
  const configDir = path.join(root, 'host-config');
  await Promise.all([mkdir(path.join(cwd, '.aiwg'), { recursive: true }), mkdir(configDir, { mode: 0o700 })]);
  await writeFile(path.join(cwd, '.aiwg', 'aiwg.config'), JSON.stringify({
    version: '1', parallelism: workerDispatch === undefined ? {} : { worker_dispatch: workerDispatch },
  }));
  const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
  vi.stubEnv('AIWG_HOME', frameworkRoot);
  vi.stubEnv('AIWG_CONFIG', configDir);
  const args = ['resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
    '--brief', path.join(cwd, 'brief.txt'), '--workdir', cwd,
    '--final-output', path.join(cwd, 'final.json'), '--transport', 'shell', '--format', 'shell'];
  await writeFile(path.join(cwd, 'brief.txt'), 'Bounded offline task');
  return { args, rawArgs: ['models', ...args], cwd, frameworkRoot };
}

describe('models resolve dispatch gate before installation qualification (#3070)', () => {
  it.each([false, undefined])('refuses dispatch off (%s) without calling the installation loader', async workerDispatch => {
    const ctx = await project(workerDispatch);
    const load = vi.spyOn(workerInstallation, 'loadRecordedWorkerInstallations');
    const { snapshot, drivers } = await loadWorkerInputs(ctx);
    expect(load).not.toHaveBeenCalled();
    expect(snapshot.installations).toEqual({});
    expect(drivers).toEqual({});
    expect(resolveWorkerPlan(snapshot, workerResolutionFixture().request)).toMatchObject({
      status: 'disabled', diagnostics: [expect.objectContaining({
        pointer: '/parallelism/worker_dispatch', message: expect.stringContaining(WORKER_DISPATCH_ENABLE_COMMAND),
      })],
    });
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await modelsHandler.execute(ctx);
    expect(result.exitCode).toBe(2);
    expect(load).not.toHaveBeenCalled();
    const refusal = JSON.parse(output.mock.calls[0][0]);
    expect(refusal.status).toBe('blocked');
    expect(refusal.diagnostics[0].message).toContain('parallelism.worker_dispatch');
    expect(refusal.diagnostics[0].message).toContain(WORKER_DISPATCH_ENABLE_COMMAND);
    expect(refusal.diagnostics[0].message).toContain(WORKER_DISPATCH_READINESS_COMMAND);
  });

  it('still raises the qualification error with dispatch on and no recorded installation', async () => {
    const ctx = await project(true);
    const load = vi.spyOn(workerInstallation, 'loadRecordedWorkerInstallations');
    await expect(loadWorkerInputs(ctx)).rejects.toMatchObject({
      code: 'OG_ADAPTER_UNQUALIFIED', message: 'Trusted installation qualification is required',
    });
    expect(load).toHaveBeenCalledOnce();
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await modelsHandler.execute(ctx)).exitCode).toBe(2);
    const refusal = JSON.parse(output.mock.calls[0][0]);
    expect(refusal.status).toBe('blocked');
    expect(refusal.diagnostics[0]).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED' });
  });
});
