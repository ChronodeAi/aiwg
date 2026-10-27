import { AsyncResource } from 'node:async_hooks';
import { createMcAdmissionScheduler } from '../../../src/cli/handlers/mc-admission.js';
import { bindManagedAdmissionPolicy, FileAdmissionStore, managedProjectAdmissionPolicy, projectAdmissionAuthority } from '../../../src/serve/shared-host-scheduler.js';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyConfig, writeAiwgConfig, readAiwgConfig, workerActivationDigests, workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { applyWorkerAdoption, proposeWorkerAdoption, recoverWorkerAdoption, type AdoptionOptions } from '../../../src/config/worker-adoption.js';
import { workerDispatchBlocked, workerWriteLock } from '../../../src/config/worker-write.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { main } from '../../../src/config/cli.js';
import { modelsHandler } from '../../../src/cli/handlers/models.js';
import { resolveDynamicModelCatalog } from '../../../src/models/model-discovery.js';
import { assertWorkerActivationCurrent } from '../../../src/config/worker-activation-gate.js';

const fault = vi.hoisted(() => ({ restoring: false, failRestore: '', failAfterRename: '', restored: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: any, to: any) => {
    if (fault.restoring) { fault.restored.push(String(to)); if (String(to) === fault.failRestore) throw new Error('synthetic restore failure'); }
    await actual.rename(from, to);
    if (String(to) === fault.failAfterRename) { fault.failAfterRename = ''; throw new Error('synthetic failure after rename'); }
  } };
});

const roots: string[] = [];
const regenerate = vi.fn(async () => {});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-reviewed-'));
  roots.push(root);
  const builtinFile = join(root, 'install/agentic/code/frameworks/sdlc-complete/config/models-v2.json');
  await mkdir(join(root, 'install/agentic/code/frameworks/sdlc-complete/config'), { recursive: true });
  const user = join(root, 'user');
  const compatibility = join(root, 'corpus');
  await mkdir(user); await mkdir(compatibility);
  vi.stubEnv('AIWG_HOME', join(root, 'install'));
  vi.stubEnv('AIWG_CONFIG', user);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', compatibility);
  await writeFile(builtinFile, JSON.stringify({ version: '2.0', defaults: { provider: 'codex', tier: 'standard' }, tiers: {}, providers: {} }));
  const config = { ...emptyConfig(), providers: ['codex'], parallelism: { worker_dispatch: true, worker_mode: 'managed' as const } };
  await writeAiwgConfig(root, config);
  await writeFile(join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {} } }));
  const changes = { parallelism: { ...config.parallelism, max_parallel_subagents: 2 }, workerSelection: { guards: { denySelfDelegation: true } } };
  const proposal = await proposeWorkerAdoption(root, changes);
  return { root, builtinFile, compatibility, config, changes, proposal, options: { regenerate } as AdoptionOptions };
}
async function bytes(files: string[]) { return Promise.all(files.map(file => readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)))); }
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); regenerate.mockClear();
  Object.assign(fault, { restoring: false, failRestore: '', failAfterRename: '', restored: [] });
  for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); }
});

describe('T-OG-13 reviewed worker adoption FR-OG-056', () => {
  it.each(['exact', 'standing'])('A01 accepts %s authorization and publishes checked copies before reopening', async kind => {
    const f = await fixture();
    const authority = kind === 'exact' ? { digest: f.proposal.digest } : { project: f.root, revision: 0, fields: ['/parallelism/max_parallel_subagents', '/workerSelection/guards/denySelfDelegation'] };
    await applyWorkerAdoption(f.root, f.proposal, authority, f.options);
    const cfg = await readAiwgConfig(f.root);
    expect(cfg?.parallelism?.activation).toMatchObject({ revision: 1, snapshotRef: f.proposal.digest });
    expect(await readFile(join(f.root, '.aiwg/aiwg.config'), 'utf8')).toBe(await readFile(join(f.compatibility, 'aiwg.config'), 'utf8'));
    expect(regenerate).toHaveBeenCalledOnce();
    expect(workerDispatchBlocked(f.root)).toBe(false);
    expect(cfg?.parallelism?.activation?.projectModelsDigest).toBe(workerConfigDigest(JSON.parse(await readFile(join(f.root, 'models.json'), 'utf8'))));
  });

  it('A01 shares reader normalization when activating minimal forward-compatible config', async () => {
    const f = await fixture();
    const minimal = JSON.stringify({ version: '1', parallelism: f.config.parallelism });
    await writeFile(join(f.root, '.aiwg/aiwg.config'), minimal);
    await writeFile(join(f.compatibility, 'aiwg.config'), minimal);
    const proposal = await proposeWorkerAdoption(f.root, f.changes);
    await applyWorkerAdoption(f.root, proposal, { digest: proposal.digest }, f.options);
    const config = (await readAiwgConfig(f.root))!;
    expect(config.parallelism!.activation!.configDigest).toBe(workerActivationDigests(config).configDigest);
    expect(() => assertWorkerActivationCurrent(f.root, config.parallelism!.activation)).not.toThrow();
  });

  it('A01 serializes competing applies and rejects replay of an already-applied review', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([1, 2].map(() => applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, f.options)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await readAiwgConfig(f.root))?.parallelism?.activation?.revision).toBe(1);
    await expect(applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, f.options)).rejects.toThrow(/Stale proposal/);
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'wrong-digest', 'wrong-field', 'wrong-revision', 'wrong-project'])('A02 rejects %s authority before any write', async kind => {
    const f = await fixture();
    const authority = kind === 'missing' ? undefined : kind === 'wrong-digest' ? { digest: 'sha256:unreviewed' } : {
      project: kind === 'wrong-project' ? join(f.root, 'other') : f.root, revision: kind === 'wrong-revision' ? 1 : 0,
      fields: kind === 'wrong-field' ? ['/parallelism/max_parallel_subagents'] : ['/parallelism', '/workerSelection'],
    };
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    await expect(applyWorkerAdoption(f.root, f.proposal, authority, f.options)).rejects.toThrow(/authorization/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    expect(existsSync(workerWriteLock(f.root))).toBe(false);
  });

  it.each([0, 1, 2, 3, 4])('A03 rejects stale participating input %i before even acquiring a write lock', async index => {
    const f = await fixture();
    const input = f.proposal.inputs[index];
    await writeFile(input.file, (input.bytes ?? '{}') + ' ');
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    await expect(applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, f.options)).rejects.toThrow(/Stale proposal/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    expect(existsSync(workerWriteLock(f.root))).toBe(false);
  });

  it('A03 rejects a changed base activation revision and a modified review', async () => {
    const f = await fixture();
    const changed = structuredClone(f.proposal); changed.after.workerSelection = { guards: { denySelfDelegation: false } };
    await expect(applyWorkerAdoption(f.root, changed, { digest: f.proposal.digest }, f.options)).rejects.toThrow(/digest mismatch/);
    const cfg = JSON.parse(f.proposal.inputs[0].bytes!); cfg.parallelism.activation = { revision: 2 };
    await writeFile(f.proposal.inputs[0].file, JSON.stringify(cfg));
    await expect(applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, f.options)).rejects.toThrow(/Stale proposal/);
  });

  it.each(['models', 'config:0', 'config:1', 'activation'])('A04 restores ALL bytes after interruption at %s with dispatch refused', async step => {
    const f = await fixture();
    const externalRead = new AsyncResource('independent-dispatch');
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    const checkpoint = async (current: string) => {
      expect(workerDispatchBlocked(f.root)).toBe(true);
      expect(() => assertWorkerActivationCurrent(f.root)).toThrow(/closed/);
      await expect(externalRead.runInAsyncScope(() => new ConfigLoader(f.root).load(f.config.parallelism))).rejects.toThrow(/closed/);
      if (current === step) throw new Error('synthetic interruption');
    };
    await expect(applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, { ...f.options, checkpoint })).rejects.toThrow(/restored and revalidated/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    expect(workerDispatchBlocked(f.root)).toBe(false);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('A04 keeps dispatch closed while a reviewed apply changes managed mode to direct', async () => {
    const f = await fixture();
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    const proposal = await proposeWorkerAdoption(f.root, { parallelism: { worker_dispatch: true, worker_mode: 'direct' } });
    const reader = new AsyncResource('independent-direct-dispatch');
    await expect(applyWorkerAdoption(f.root, proposal, { digest: proposal.digest }, { ...f.options, checkpoint: async step => {
      if (step !== 'config:0') return;
      await expect(reader.runInAsyncScope(() => new ConfigLoader(f.root).load({ worker_dispatch: true, worker_mode: 'direct' }))).rejects.toThrow(/closed/);
      throw new Error('synthetic mode-transition interruption');
    } })).rejects.toThrow(/restored and revalidated/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
  });

  it('A04 restores absence of an optional project model file after a partial apply', async () => {
    const f = await fixture();
    await rm(join(f.root, 'models.json'));
    const proposal = await proposeWorkerAdoption(f.root, f.changes);
    const before = await bytes(proposal.inputs.map(input => input.file));
    await expect(applyWorkerAdoption(f.root, proposal, { digest: proposal.digest }, { ...f.options,
      checkpoint: async step => { if (step === 'config:0') throw new Error('synthetic interruption'); },
    })).rejects.toThrow(/restored and revalidated/);
    expect(await bytes(proposal.inputs.map(input => input.file))).toEqual(before);
    expect(existsSync(join(f.root, 'models.json'))).toBe(false);
  });

  it.each([1, 0, 4])('A04 restores a file even if write %i renamed before reporting failure', async index => {
    const f = await fixture();
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    fault.failAfterRename = f.proposal.inputs[index].file;
    await expect(applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, f.options)).rejects.toThrow(/restored and revalidated/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it('A04 attempts every restore even when one restore fails and keeps the persistent block', async () => {
    const f = await fixture();
    const originalConfig = f.proposal.inputs[0].bytes;
    fault.failRestore = f.proposal.inputs[0].file;
    await expect(applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, { ...f.options,
      checkpoint: async step => { if (step === 'config:0') { fault.restoring = true; throw new Error('interrupt'); } },
    })).rejects.toThrow(/Dispatch remains closed/);
    expect(fault.restored).toEqual([f.proposal.inputs[1].file, f.proposal.inputs[0].file, f.proposal.inputs[4].file]);
    expect(await readFile(f.proposal.inputs[0].file, 'utf8')).not.toBe(originalConfig);
    expect(workerDispatchBlocked(f.root)).toBe(true);
    await expect(new ConfigLoader(f.root).load(f.changes.parallelism)).rejects.toThrow(/closed/);
    fault.failRestore = ''; fault.restoring = false;
    await recoverWorkerAdoption(f.root, { digest: f.proposal.digest }, f.options);
    expect(await readFile(f.proposal.inputs[0].file, 'utf8')).toBe(originalConfig);
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it('A05 regeneration failure restores the pair and keeps dispatch closed until authorized recovery', async () => {
    const f = await fixture();
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    await expect(applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, { regenerate: async () => { throw new Error('synthetic guidance failure'); } })).rejects.toThrow(/guidance failure.*Dispatch remains closed/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    expect(workerDispatchBlocked(f.root)).toBe(true);
    await expect(new ConfigLoader(f.root).load(f.config.parallelism)).rejects.toThrow(/closed/);
    await expect(recoverWorkerAdoption(f.root, { digest: 'wrong' }, f.options)).rejects.toThrow(/dispatch remains closed/);
    await recoverWorkerAdoption(f.root, { digest: f.proposal.digest }, f.options);
    expect(regenerate).toHaveBeenCalledOnce();
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it('A06 direct config and models edits remain independent of activation markers', async () => {
    const f = await fixture();
    await writeAiwgConfig(f.root, { ...f.config, parallelism: { worker_dispatch: true, worker_mode: 'direct' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['set', '--target', f.root, '--project', 'parallelism.max_parallel_subagents', '3']);
    await modelsHandler.execute({ args: ['set-default', 'economy'], rawArgs: [], cwd: f.root, frameworkRoot: f.root });
    expect((await readAiwgConfig(f.root))?.parallelism?.activation).toBeUndefined();
    expect(JSON.parse(await readFile(join(f.root, 'models.json'), 'utf8')).defaults.tier).toBe('economy');
    expect(existsSync(workerWriteLock(f.root))).toBe(false);
  });

  it('A04 closes already-created managed schedulers and fences their old revision after apply', async () => {
    const f = await fixture();
    await applyWorkerAdoption(f.root, f.proposal, { digest: f.proposal.digest }, f.options);
    const config = (await readAiwgConfig(f.root))!;
    const policy = managedProjectAdmissionPolicy(f.root, config.parallelism!, workerConfigDigest(config.parallelism!.activation), 2);
    bindManagedAdmissionPolicy(new FileAdmissionStore(projectAdmissionAuthority(f.root).path), policy);
    const scheduler = await createMcAdmissionScheduler(f.root, config);
    const request = { requestId: 'before', orchestratorId: 'fixture', environment: 'fixture', provider: 'codex', runtimeKind: 'host' as const,
      priority: 1, submittedAt: new Date().toISOString(), queueTimeoutMs: 60_000, managed: { kind: 'native' as const } };
    const admitted = scheduler.submit(request);
    const proposal = await proposeWorkerAdoption(f.root, { parallelism: { ...f.changes.parallelism, max_parallel_subagents: 3 } });
    await applyWorkerAdoption(f.root, proposal, { digest: proposal.digest }, { ...f.options, checkpoint: async step => {
      if (step !== 'blocked') return;
      expect(() => scheduler.submit({ ...request, requestId: 'during' })).toThrow(/closed/);
      expect(() => scheduler.claimLaunch('before', admitted.leaseGeneration!)).toThrow(/closed/);
      await expect(writeAiwgConfig(f.root, config)).rejects.toThrow(/locked/);
      await expect(modelsHandler.execute({ args: ['set-default', 'economy'], rawArgs: [], cwd: f.root, frameworkRoot: f.root })).rejects.toThrow(/locked/);
    } });
    expect(() => scheduler.submit({ ...request, requestId: 'after' })).toThrow(/activation changed/);
    expect(scheduler.snapshot().records.during).toBeUndefined();
  });

  it('A08 respects the existing models handler dry-run context before reading or applying a review', async () => {
    const f = await fixture();
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    await expect(modelsHandler.execute({ args: ['set', '--apply', 'unread-review.json', '--authorize', f.proposal.digest], rawArgs: [], cwd: f.root, frameworkRoot: f.root, dryRun: true })).rejects.toThrow(/dry-run/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    expect(existsSync(workerWriteLock(f.root))).toBe(false);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('A08 existing dotted config edits can propose without writing preferences', async () => {
    const f = await fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = join(f.root, 'review.json');
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    await main(['set', '--project', '--target', f.root, 'parallelism.max_parallel_subagents', '2', `--propose=${file}`]);
    const proposal = JSON.parse(await readFile(file, 'utf8'));
    expect(proposal.after.parallelism.max_parallel_subagents).toBe(2);
    expect(proposal.before.workerSelection).toEqual(proposal.after.workerSelection);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    await expect(main(['set', '--project', '--target', f.root, 'parallelism.__proto__.polluted', 'true', '--propose', file])).rejects.toThrow(/safe parallelism/);
    expect(({} as any).polluted).toBeUndefined();
  });

  it.each(['exact', 'standing'])('A08 existing config/models flags apply %s authority headlessly with real regeneration', async kind => {
    const f = await fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const proposalFile = join(f.root, 'review.json');
    const policyFile = join(f.root, 'worker-selection.json');
    await writeFile(policyFile, JSON.stringify(f.changes.workerSelection));
    const result = await modelsHandler.execute({ args: ['set', '--worker-selection', policyFile, '--propose', proposalFile], rawArgs: [], cwd: f.root, frameworkRoot: f.root });
    expect(result.exitCode).toBe(0);
    const proposal = JSON.parse(await readFile(proposalFile, 'utf8'));
    expect((await readAiwgConfig(f.root))?.parallelism?.activation).toBeUndefined();
    const authorityFile = join(f.root, 'authority.json');
    await writeFile(authorityFile, JSON.stringify({ project: f.root, revision: 0, fields: ['/workerSelection/guards/denySelfDelegation'] }));
    await main(['set', '--project', '--target', f.root, `--apply=${proposalFile}`, ...(kind === 'exact' ? ['--authorize', proposal.digest] : ['--standing-authorization', authorityFile])]);
    expect((await readAiwgConfig(f.root))?.parallelism?.activation?.revision).toBe(1);
    expect(await readFile(join(f.root, 'WORKSPACE.md'), 'utf8')).toContain('AIWG:workspace-context');
    expect(await readFile(join(f.root, 'AGENTS.md'), 'utf8')).toContain('WORKSPACE.md');
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it('A07 a real fact refresh cannot authorize or apply a pending proposal', async () => {
    const f = await fixture();
    const before = await bytes(f.proposal.inputs.map(input => input.file));
    const install = join(f.root, 'install');
    await mkdir(join(install, 'agentic/code/providers'), { recursive: true });
    await writeFile(join(install, 'agentic/code/providers/model-catalog.v1.json'), JSON.stringify({ version: '1.0', providers: {} }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '2.0', providers: {} })));
    const catalog = await resolveDynamicModelCatalog({ aiwgRoot: install, homeDir: f.root, cacheFile: join(f.root, 'cache.json'),
      inventory: { generatedAt: new Date(0).toISOString(), projectDir: f.root, providers: [] } as any,
      remoteUrl: 'https://fixture.invalid/models.json', allowNetwork: true, forceRefresh: true, fetchImpl: fetchImpl as any, nativeDiscoverers: {} });
    expect(catalog.version).toBe('2.0'); expect(fetchImpl).toHaveBeenCalledOnce();
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(before);
    await expect(applyWorkerAdoption(f.root, f.proposal, undefined, f.options)).rejects.toThrow(/authorization/);
    await expect(modelsHandler.execute({ args: ['refresh', '--apply', 'proposal.json', '--authorize', f.proposal.digest], rawArgs: [], cwd: f.root, frameworkRoot: install })).rejects.toThrow(/refresh cannot authorize/);
    expect(regenerate).not.toHaveBeenCalled();
  });
});
