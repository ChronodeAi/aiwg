import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelsHandler } from '../../../../src/cli/handlers/models.js';
import { ConfigLoader } from '../../../../src/models/config-loader.js';
import { requiredWorkerControls } from '../../../../src/models/provider-policy.js';
import { resolveWorkerPlan } from '../../../../src/models/resolver.js';
import { hasProvider as hasInstalledProvider } from '../../../../src/models/worker-installation.mjs';
import { qualificationDigest } from '../../../../src/models/qualification-digest.mjs';
import { ProviderAdapter, workerNegativeFixtureDigest, workerNegativeFixtureSuite } from '../../../../tools/ralph-external/lib/provider-adapter.mjs';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function productionFixture() {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-production-worker-')); roots.push(root);
  const cwd = path.join(root, 'project');
  const workdir = path.join(cwd, 'worktree');
  const configDir = path.join(root, 'host-config');
  const installed = path.join(root, 'installed');
  const frameworkRoot = path.join(root, 'framework');
  await Promise.all([mkdir(path.join(cwd, '.aiwg'), { recursive: true }), mkdir(workdir, { recursive: true }),
    mkdir(configDir, { mode: 0o700 }), mkdir(installed, { mode: 0o755 }), mkdir(path.join(root, 'home')),
    mkdir(path.join(frameworkRoot, 'agentic/code/providers'), { recursive: true }),
    mkdir(path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/config'), { recursive: true })]);
  vi.stubEnv('HOME', path.join(root, 'home')); vi.stubEnv('AIWG_CONFIG', configDir); vi.stubEnv('AIWG_HOME', frameworkRoot);
  const f = workerResolutionFixture();
  const now = new Date().toISOString();
  const id = `fixture-${path.basename(root).toLowerCase()}`;
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.id = id; adapter.runtimeDriver = `installed:${id}`;
  adapter.qualification.verifiedAt = now;
  const binding = f.snapshot.installations.codex;
  const profile = adapter.invocationProfiles![binding.profile];
  profile.envAllowlist = []; adapter.invocation.envAllowlist = []; adapter.invocation.stdin = 'closed';
  delete f.snapshot.registry.providers.codex.workerAdapter;
  f.snapshot.registry.workerAdapters = { [id]: adapter };
  f.snapshot.installations = { [id]: binding };
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = id; });
  f.snapshot.config.parallelism!.clis = { [id]: { adapter: `workerAdapters:${id}`, accountScope: binding.accountScope, quotaScope: 'fixture' } };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  for (const row of discovery.models) {
    row.worker!.cliId = id; row.worker!.observedAt = now; row.worker!.fetchedAt = now; row.worker!.verifiedAt = now;
    row.worker!.qualification.verifiedAt = now;
  }
  discovery.observedAt = now; f.snapshot.catalog.discovery!.instances = { [id]: discovery };
  await writeFile(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
  await writeFile(path.join(cwd, 'models.json'), JSON.stringify({ defaults: { workerSelection: f.projectPolicy } }));
  await writeFile(path.join(frameworkRoot, 'agentic/code/providers/model-catalog.v1.json'), JSON.stringify(f.snapshot.catalog));
  await writeFile(path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/config/models-v2.json'),
    JSON.stringify({ version: '2.0', defaults: { provider: 'codex', tier: 'standard' }, tiers: {}, providers: {}, agentRoleAssignments: {}, shorthand: {} }));
  const loader = new ConfigLoader(cwd);
  f.snapshot.models = await loader.load(f.snapshot.config.parallelism); f.snapshot.modelDigests = loader.getInputDigests()!;
  binding.boundary = { kind: 'os', identity: 'fixture:host', digest: qualificationDigest('fixture:host'), controls: [] };
  const initial = resolveWorkerPlan(f.snapshot, { ...f.request, now, role: 'coding', group: 'workers' });
  expect(initial.selected, JSON.stringify(initial)).not.toBeNull();
  const permissions = initial.selected!.permissions;
  const controls = requiredWorkerControls({ policy: initial.policy, permissions, effort: 'medium' });
  binding.boundary.controls = controls;
  for (const control of Object.values(profile.controls)) Object.assign(control, { support: 'external', mapping: 'host fixture boundary' });
  const cli = path.join(installed, 'ralph-worker-cli.mjs');
  const protocol = path.join(installed, 'ralph-worker-protocol.mjs');
  for (const filename of [cli, protocol]) await writeFile(filename, await readFile(path.resolve('test/fixtures', path.basename(filename))), { mode: 0o644 });
  adapter.invocation.versionArgv = [cli, '--qualification-version'];
  const args = (input: any, _profile: any, permissions: any) => [cli, '--model', input.selected.model, '--effort', input.selected.effort.value,
    '--sandbox', permissions.sandbox, '--approval', permissions.approval, '--final-output', input.finalPath];
  const source = `export const interfaceVersion = 1; export function register(factory) { const cli = ${JSON.stringify(cli)}; factory(${JSON.stringify(id)}, () => ({ getName: () => ${JSON.stringify(id)}, buildWorkerArgs: ${args.toString()} })); }`;
  await writeFile(path.join(installed, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }), { mode: 0o644 });
  class Owner extends ProviderAdapter { getName() { return id; } buildWorkerArgs = args; }
  const owner = new Owner();
  const installation: any = { adapter, profile: binding.profile, cliVersion: binding.cliVersion, now: Date.parse(now),
    policy: initial.policy, permissions, effort: 'medium', requiredControls: controls, executable: process.execPath,
    cwd: workdir, workerWritableRoots: [cwd], inputRoots: [cwd], outputRoots: [cwd], boundary: binding.boundary,
    effectiveConfigDigest: qualificationDigest(initial.policy), accountScope: binding.accountScope,
    runtimeFiles: [cli, protocol], environment: {}, modules: [{ reference: adapter.runtimeDriver, packageRoot: installed,
      packageName: id, packageVersion: '1.0.0', modulePath: 'driver.mjs', interfaceVersion: 1,
      sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`, adapterIds: [id], platforms: ['linux'] }] };
  const scope = await owner.inspectWorkerInstallation(installation);
  profile.installationQualification = { scopeDigest: scope.scopeDigest, fixtureDigest: await workerNegativeFixtureDigest(),
    verifiedAt: now, evidenceRef: 'fixture:host-negative-evidence' };
  installation.evidence = { ...profile.installationQualification,
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(name => [name, 'passed'])) };
  const brief = path.join(cwd, 'brief.txt'); await writeFile(brief, 'Do the synthetic task.');
  const finalPath = path.join(workdir, 'final.json');
  const record = { cli: id, binding, adapter, installation };
  const call = async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['resolve', '--role=coding', '--group=workers', '--task=implementation', `--brief=${brief}`, `--workdir=${workdir}`, `--final-output=${finalPath}`, '--format=json'];
    const result = await modelsHandler.execute({ args, rawArgs: ['models', ...args], cwd, frameworkRoot });
    const output = String(log.mock.calls.at(-1)?.[0]); log.mockRestore(); return { result, output, plan: JSON.parse(output) };
  };
  return { ...f, call, record, configDir, finalPath, installed, owner };
}

describe('models resolve production installation loading', () => {
  it('renders a qualified installed fake CLI through the production handler', async () => {
    const f = await productionFixture();
    await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [f.record] }), { mode: 0o600 });
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.argv).toContain(path.join(f.installed, 'ralph-worker-cli.mjs'));
    expect(result.plan.invocation.selected.qualificationDigest).toBe(f.record.installation.evidence.scopeDigest);
    await expect(readFile(f.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(f.installed, 'driver.mjs'), '// changed');
    expect((await f.call()).result.exitCode).toBe(2);
  });
  it.each(['boundary', 'expired', 'negative-case', 'duplicate', 'worker-writable-store', 'hardlinked-store'])(
    'refuses %s host records before loading the installed driver', async kind => {
      const f = await productionFixture();
      if (kind === 'boundary') f.record.binding.boundary = { ...f.record.binding.boundary!, digest: qualificationDigest('changed') };
      if (kind === 'expired') {
        f.record.installation.evidence.verifiedAt = '2001-01-01T00:00:00Z';
        f.record.adapter.invocationProfiles![f.record.binding.profile].installationQualification!.verifiedAt = '2001-01-01T00:00:00Z';
      }
      if (kind === 'negative-case') f.record.installation.evidence.cases['forbidden-write'] = 'failed';
      const records = kind === 'duplicate' ? [f.record, f.record] : [f.record];
      const storeDir = kind === 'worker-writable-store' ? f.record.installation.cwd : f.configDir;
      vi.stubEnv('AIWG_CONFIG', storeDir);
      await writeFile(path.join(storeDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: records }), { mode: 0o600 });
      if (kind === 'hardlinked-store') await link(path.join(storeDir, 'worker-installations.json'), path.join(f.record.installation.cwd, 'host-alias.json'));
      const result = await f.call();
      expect(result.result.exitCode).toBe(2);
      expect(result.plan.invocation).toBeUndefined();
      expect(hasInstalledProvider(f.record.adapter.id)).toBe(false);
      expect(result.output).toContain('OG_ADAPTER_UNQUALIFIED');
    });

  it('records bounded fake qualification without environment values, then resolves it', async () => {
    const f = await productionFixture();
    const name = 'AIWG_SYNTHETIC_WORKER_ENV';
    const value = 'synthetic-only-environment-value';
    // The fixture CLI's fake wire protocol (test/fixtures/ralph-worker-protocol.mjs)
    // requires AIWG_FAKE_WORKER_CONFIG to name its synthetic settings file for any
    // invocation, including the bounded version probe this records against — it is
    // required test plumbing, not qualification input under test.
    const fakeWorkerConfig = path.join(f.installed, 'qualification-version-fixture.json');
    await writeFile(fakeWorkerConfig, JSON.stringify({ version: '1.0.0' }));
    vi.stubEnv(name, value);
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', fakeWorkerConfig);
    f.record.adapter.invocation.envAllowlist = [name, 'AIWG_FAKE_WORKER_CONFIG'];
    const profile = f.record.adapter.invocationProfiles![f.record.binding.profile];
    profile.envAllowlist = [name, 'AIWG_FAKE_WORKER_CONFIG'];
    f.record.installation.environment = { [name]: value, AIWG_FAKE_WORKER_CONFIG: fakeWorkerConfig };
    const scope = await f.owner.inspectWorkerInstallation(f.record.installation);
    f.record.installation.evidence.scopeDigest = scope.scopeDigest;
    profile.installationQualification!.scopeDigest = scope.scopeDigest;
    const qualified = await f.owner.recordWorkerInstallation(f.record);
    expect(qualified).toMatchObject({ status: 'ENABLED' });
    const stored = await readFile(path.join(f.configDir, 'worker-installations.json'), 'utf8');
    expect(stored).not.toContain(value);
    expect(JSON.parse(stored).registrations[0].installation.environmentNames).toEqual([name, 'AIWG_FAKE_WORKER_CONFIG']);
    expect(JSON.parse(stored).registrations[0].installation.environment).toBeUndefined();
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.envNames).toEqual([name, 'AIWG_FAKE_WORKER_CONFIG']);
  });

  it('refuses to record missing negative qualification evidence', async () => {
    const f = await productionFixture();
    delete f.record.installation.evidence;
    const result = await f.owner.recordWorkerInstallation(f.record);
    expect(result.status).toBe('DISABLED');
    await expect(readFile(path.join(f.configDir, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explains how to qualify when the trusted host store has no installation', async () => {
    const f = await productionFixture();
    const result = await f.call();
    expect(result.result.exitCode).toBe(2);
    expect(result.output).toContain('recordWorkerInstallation');
    expect(result.output).toContain('OG_ADAPTER_UNQUALIFIED');
  });
});
