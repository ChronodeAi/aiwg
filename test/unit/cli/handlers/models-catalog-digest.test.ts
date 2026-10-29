import { idleHostResourceReaders } from '../../../fixtures/host-resources.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsHandler, loadWorkerInputs as loadHostWorkerInputs } from '../../../../src/cli/handlers/models.js';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { ConfigLoader } from '../../../../src/models/config-loader.js';
import * as discovery from '../../../../src/models/model-discovery.js';
import { loadRecordedWorkerInstallations } from '../../../../src/models/worker-installation.mjs';
import { revalidateWorkerInvocationPlan, type WorkerInvocationDriver } from '../../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Unexpected process spawn'); }),
}));
vi.mock('../../../../src/providers/provider-inventory.js', () => ({
  collectProviderInventory: vi.fn(async () => ({ providers: [] })),
}));
vi.mock('../../../../src/models/worker-installation.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/models/worker-installation.mjs')>(),
  loadRecordedWorkerInstallations: vi.fn(),
}));

const loadWorkerInputs = (ctx: Parameters<typeof loadHostWorkerInputs>[0]) => loadHostWorkerInputs(ctx, idleHostResourceReaders());
const modelsHandler = createModelsHandler({ load: loadWorkerInputs });
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(cached = false) {
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'catalog-digest-')); roots.push(root);
  const cwd = path.join(root, 'project');
  const frameworkRoot = path.join(root, 'framework');
  const staticFile = path.join(frameworkRoot, 'agentic/code/providers/model-catalog.v1.json');
  const cacheFile = path.join(root, '.cache/aiwg/model-catalog.v1.json');
  await Promise.all([mkdir(path.dirname(staticFile), { recursive: true }),
    mkdir(path.dirname(cacheFile), { recursive: true }), mkdir(path.join(cwd, '.aiwg'), { recursive: true })]);
  vi.stubEnv('HOME', root); vi.stubEnv('AIWG_CONFIG', path.join(root, 'host-config'));
  vi.stubEnv('AIWG_HOME', frameworkRoot);
  await writeFile(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
  await writeFile(staticFile, JSON.stringify({ version: '1.0.0', providers: {} }));
  vi.spyOn(ConfigLoader.prototype, 'load').mockImplementation(async () => structuredClone(f.snapshot.models));
  vi.spyOn(ConfigLoader.prototype, 'getInputDigests').mockImplementation(() => structuredClone(f.snapshot.modelDigests));
  const resolveCatalog = discovery.resolveDynamicModelCatalog;
  vi.spyOn(discovery, 'resolveDynamicModelCatalog').mockImplementation(options => resolveCatalog({ ...options, homeDir: root }));
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const binding = f.snapshot.installations.codex;
  const driver: WorkerInvocationDriver = {
    qualification: { adapter, adapterId: adapter.id, cliVersion: binding.cliVersion },
    buildInvocation: vi.fn(async input => ({ argv: ['/fixture/worker', '--model', input.selected.model,
      '--effort', input.selected.effort.value!, '--sandbox', input.permissions.sandbox!, '--approval', input.permissions.approval!,
      '--final-output', input.finalPath], stdin: 'closed', envNames: [] })),
  };
  vi.mocked(loadRecordedWorkerInstallations).mockImplementation(async () => ({
    registry: structuredClone(f.snapshot.registry), installations: structuredClone(f.snapshot.installations),
    observations: structuredClone(f.snapshot.catalog.discovery!.instances!), drivers: { codex: driver },
  }));
  if (cached) await writeFile(cacheFile, JSON.stringify(f.snapshot.catalog));
  const brief = path.join(root, 'brief.txt'); await writeFile(brief, 'Synthetic task.');
  const args = ['resolve', '--role=coding', '--group=workers', '--task=implementation', `--brief=${brief}`,
    `--workdir=${cwd}`, `--final-output=${path.join(cwd, 'final.json')}`, '--format=json'];
  const ctx: HandlerContext = { args, rawArgs: ['models', ...args], cwd, frameworkRoot };
  const call = async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await modelsHandler.execute(ctx);
      const plan = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(result.exitCode, JSON.stringify(plan)).toBe(0);
      return plan;
    } finally { log.mockRestore(); }
  };
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(f.request.now));
  return { ...f, ctx, call, staticFile, cacheFile };
}

describe('catalog facts pinned across worker input reloads', () => {
  it('keeps catalog and plan digests stable across uncached resolves at different wall clocks', async () => {
    const f = await fixture();
    await expect(readFile(f.cacheFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const firstInputs = await loadWorkerInputs(f.ctx);
    const first = await f.call();
    vi.setSystemTime(Date.now() + 2000);
    const secondInputs = await loadWorkerInputs(f.ctx);
    const second = await f.call();
    expect(firstInputs.snapshot.catalog.discovery!.fetchedAt).not.toBe(secondInputs.snapshot.catalog.discovery!.fetchedAt);
    expect(secondInputs.snapshot.catalog.discovery!.instances).toEqual(firstInputs.snapshot.catalog.discovery!.instances);
    expect(second.digests).toEqual(first.digests);
    expect(second.invocation.catalogDigest).toBe(first.invocation.catalogDigest);
    expect(second.invocation.expiresAt).not.toBe(first.invocation.expiresAt);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('revalidates a saved uncached plan with freshly reloaded launcher inputs and still enforces expiry', async () => {
    const f = await fixture();
    const saved = JSON.parse(JSON.stringify(await f.call()));
    vi.setSystemTime(Date.now() + 2000);
    const { snapshot, drivers } = await loadWorkerInputs(f.ctx);
    await expect(revalidateWorkerInvocationPlan(saved, snapshot, drivers)).resolves.toEqual(saved.invocation);
    vi.setSystemTime(new Date(saved.invocation.expiresAt));
    await expect(revalidateWorkerInvocationPlan(saved, snapshot, drivers)).rejects.toThrow('fresh launchable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects a real catalog fact change after reload (cached: %s)', async cached => {
    const f = await fixture(cached);
    const saved = await f.call();
    const before = await loadWorkerInputs(f.ctx);
    expect(before.snapshot.catalog.discovery!.source).toBe(cached ? 'cache' : 'static');
    const filename = cached ? f.cacheFile : f.staticFile;
    const catalog = JSON.parse(await readFile(filename, 'utf8'));
    // A fact outside the selected installation must also remain pinned.
    catalog.providers.codex = { roles: { coding: { id: 'synthetic-new-model', status: 'active' } } };
    await writeFile(filename, JSON.stringify(catalog));
    vi.setSystemTime(Date.now() + 2000);
    const current = await f.call();
    expect(current.digests.catalogDigest).not.toBe(saved.digests.catalogDigest);
    const { snapshot, drivers } = await loadWorkerInputs(f.ctx);
    await expect(revalidateWorkerInvocationPlan(saved, snapshot, drivers)).rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
