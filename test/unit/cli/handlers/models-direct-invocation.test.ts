import { copyNode } from '../../../helpers/copy-node.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsHandler, modelsHandler } from '../../../../src/cli/handlers/models.js';
import { parseWorkerCommandArgs, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../../src/serve/worker-invocation.js';
import { qualifyWorkerInvocationProfile, requiredWorkerControls } from '../../../../src/models/provider-policy.js';
import { ProviderAdapter, workerNegativeFixtureDigest, workerNegativeFixtureSuite } from '../../../../tools/ralph-external/lib/provider-adapter.mjs';
import { McpServerRegistry, workerServerDigest } from '../../../../src/mcp/registry.js';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';
import { fixtureJson } from '../../../conformance/mission-v1/worker-contract-fixtures.js';
import { workerInputSchema } from '../../../fixtures/ralph-worker-protocol.mjs';

const roots: string[] = [];
const digest = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;
const execute = promisify(execFile);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(provider = 'codex', transport: 'shell' | 'mcp' = 'shell') {
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-direct-')); roots.push(root);
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value`;
  const brief = path.join(root, "brief '雪\n.md");
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  await writeFile(brief, payload);
  await mkdir(path.join(root, '.aiwg'));
  await writeFile(path.join(root, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
  await writeFile(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: f.projectPolicy } }));
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.id = provider;
  if (f.snapshot.registry.providers[provider]) f.snapshot.registry.providers[provider].workerAdapter = adapter;
  else {
    f.snapshot.registry.workerAdapters = { [provider]: adapter };
    f.snapshot.config.parallelism!.clis = { [provider]: { adapter: `workerAdapters:${provider}`, accountScope: 'synthetic', quotaScope: 'fixture' } };
  }
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(m => { m.cli = provider; });
  f.snapshot.config.parallelism!.groups!.workers.execution = { transport };
  if (provider !== 'codex') delete f.snapshot.registry.providers.codex.workerAdapter;
  const binding = f.snapshot.installations.codex;
  binding.boundary = { kind: 'os', identity: 'fixture:enforcing-boundary', digest: digest('boundary'), controls: ['sandbox'] };
  f.snapshot.installations = { [provider]: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = provider;
  discovery.models.forEach(row => { row.worker!.cliId = provider; });
  f.snapshot.catalog.discovery!.instances = { [provider]: discovery };
  const profile = adapter.invocationProfiles![binding.profile];
  profile.transport = transport;
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  const inputSchema = structuredClone(workerInputSchema);
  const outputSchema = { type: 'object' };
  if (transport === 'mcp') {
    profile.mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: digest(inputSchema),
      outputSchemaDigest: digest(outputSchema), sessionIsolation: 'per-call', cancel: 'uncertain' };
    binding.mcp = profile.mcp;
  }
  const buildInvocation = vi.fn(async (input: Parameters<WorkerInvocationDriver['buildInvocation']>[0]) => transport === 'shell' ? {
    argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', input.selected.model,
      '--effort', input.selected.effort.value!, '--sandbox', input.permissions.sandbox!, '--approval', input.permissions.approval!,
      '--final-output', input.finalPath, '--', payload], stdin: 'brief-text' as const, envNames: profile.envAllowlist,
  } : { mcp: { serverRef: profile.mcp!.serverRef, tool: profile.mcp!.tool, inputSchemaDigest: profile.mcp!.inputSchemaDigest, outputSchemaDigest: profile.mcp!.outputSchemaDigest, sessionIsolation: profile.mcp!.sessionIsolation, arguments: { invocationId: 'fixture-task', workspace: input.cwd,
    selection: { provider: input.selected.inferenceProvider, model: input.selected.model, effort: input.selected.effort.value },
    brief: input.brief }, timeoutSeconds: input.limits.wallSeconds } });
  const drivers: Record<string, WorkerInvocationDriver> = { [provider]: { qualification: {
    adapter, adapterId: provider, cliVersion: '1.0.0', boundary: binding.boundary,
    ...(transport === 'mcp' ? { mcp: binding.mcp, mcpSchemas: { input: inputSchema, output: outputSchema } } : {}),
  }, buildInvocation, mcpRegistry: { get: async name => ({ name, type: 'stdio', command: 'fixture-only' }) },
    mcpProfile: { servers: ['fixture-server'] } } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport };
  const handler = createModelsHandler({ load: async () => ({ snapshot: f.snapshot, drivers }), now: () => f.request.now });
  const call = async (format = 'json', extra: string[] = []) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = ['resolve', ...Object.entries(request).map(([k, v]) => `--${k.replace('_', '-')}=${v}`),
      ...(format === 'alias' ? ['--json'] : [`--format=${format}`]), ...extra];
    const result = await handler.execute({ args, rawArgs: ['models', ...args], cwd: root, frameworkRoot: process.cwd() });
    const stdout = String(log.mock.calls.at(-1)?.[0] ?? '');
    const stderr = String(err.mock.calls.at(-1)?.[0] ?? '');
    const output = stdout || stderr; log.mockRestore(); err.mockRestore();
    return { result, output, stdout, stderr, plan: format === 'shell' && result.exitCode === 0 && transport === 'shell' ? null : JSON.parse(output) };
  };
  return { ...f, now: f.request.now, root, payload, request, drivers, adapter, binding, profile, call, buildInvocation };
}

/** Exercise the real #2885 inspector/recheck with frozen synthetic host evidence. */
async function installedFixture(transport: 'shell' | 'mcp' = 'shell', provider = 'codex') {
  const f = await fixture('codex', transport);
  const initial = (await f.call()).plan;
  if (provider !== 'codex') {
    f.adapter.id = provider;
    if (f.snapshot.registry.providers[provider]) f.snapshot.registry.providers[provider].workerAdapter = f.adapter;
    else {
      f.snapshot.registry.workerAdapters = { [provider]: f.adapter };
      f.snapshot.config.parallelism!.clis = { [provider]: { adapter: `workerAdapters:${provider}`, accountScope: 'synthetic', quotaScope: 'fixture' } };
    }
    delete f.snapshot.registry.providers.codex.workerAdapter;
    f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = provider; });
    f.snapshot.installations = { [provider]: f.binding };
    const discovery = f.snapshot.catalog.discovery!.instances!.codex;
    discovery.provider = provider; discovery.models.forEach(row => { row.worker!.cliId = provider; });
    f.snapshot.catalog.discovery!.instances = { [provider]: discovery };
    f.drivers[provider] = f.drivers.codex; delete f.drivers.codex;
    f.drivers[provider].qualification.adapterId = provider;
  }
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const installationRoot = path.join(f.root, 'installed');
  await mkdir(installationRoot, { mode: 0o755 });
  const executable = await copyNode(installationRoot);
  const source = 'export const interfaceVersion = 1; export function register(factory) {}';
  await writeFile(path.join(installationRoot, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(installationRoot, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
  const cli = path.join(installationRoot, 'ralph-worker-cli.mjs');
  const protocol = path.join(installationRoot, 'ralph-worker-protocol.mjs');
  for (const filename of [cli, protocol]) await writeFile(filename, await readFile(path.resolve('test/fixtures', path.basename(filename))), { mode: 0o644 });
  class InstalledAdapter extends ProviderAdapter {
    getName() { return provider; }
    buildWorkerArgs(input: any, _profile: unknown, permissions: any) { return [cli, '--model', input.selected.model, '--effort', input.selected.effort.value,
      '--sandbox', permissions.sandbox, '--approval', permissions.approval, '--final-output', input.finalPath]; }
  }
  const owner = new InstalledAdapter();
  const permissions = initial.selected.permissions;
  const controls = requiredWorkerControls({ policy: initial.policy, permissions, effort: initial.selected.effort });
  f.binding.boundary!.controls = controls;
  for (const control of Object.values(f.profile.controls)) Object.assign(control, { support: 'external', mapping: 'synthetic host boundary' });
  f.profile.envAllowlist = []; f.adapter.invocation.envAllowlist = [];
  f.adapter.invocation.stdin = 'closed';
  f.adapter.invocation.versionArgv = [cli, '--qualification-version'];
  const registry = new McpServerRegistry(path.join(f.root, 'registry'));
  let serverDigest: string | undefined;
  if (transport === 'mcp') {
    await registry.add({ name: f.profile.mcp!.serverRef, type: 'stdio', command: executable, args: [cli], cwd: f.request.workdir });
    serverDigest = workerServerDigest((await registry.get(f.profile.mcp!.serverRef))!);
    f.drivers[provider].mcpRegistry = registry;
  }
  const installation: any = { adapter: f.adapter, profile: f.binding.profile, cliVersion: '1.0.0',
    policy: initial.policy, permissions, effort: initial.selected.effort, requiredControls: controls,
    executable, cwd: f.request.workdir, workerWritableRoots: [f.request.workdir],
    inputRoots: [f.root], outputRoots: [f.root], boundary: f.binding.boundary,
    effectiveConfigDigest: digest(initial.policy), accountScope: f.binding.accountScope, runtimeFiles: [cli, protocol],
    environment: {}, mcp: f.profile.mcp, mcpServerDigest: serverDigest,
    modules: [{ reference: f.adapter.runtimeDriver, packageRoot: installationRoot, packageName: 'fixture-driver',
      packageVersion: '1.0.0', modulePath: 'driver.mjs', interfaceVersion: 1,
      sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`, adapterIds: [provider], platforms: ['linux'] }] };
  const scope = await owner.inspectWorkerInstallation(installation);
  f.profile.installationQualification = { scopeDigest: scope.scopeDigest, fixtureDigest: await workerNegativeFixtureDigest(),
    verifiedAt: f.now!, evidenceRef: 'fixture:host-negative-evidence' };
  installation.evidence = { ...f.profile.installationQualification,
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(name => [name, 'passed'])) };
  f.drivers[provider].qualification.installation = installation;
  f.drivers[provider].prepareWorkerInvocation = owner.prepareWorkerInvocation.bind(owner);
  if (transport === 'shell') f.drivers[provider].buildInvocation = async input => ({
    argv: [executable, ...owner.buildWorkerArgs(input, f.profile, input.permissions)], stdin: 'closed', envNames: [] });
  if (transport === 'mcp') await registry.recordWorkerQualification(f.profile.mcp!.serverRef, {
    adapter: f.adapter, profile: f.binding.profile, cliVersion: '1.0.0', requiredControls: controls,
    policy: initial.policy, permissions, effort: initial.selected.effort, boundary: f.binding.boundary,
    authorizedServerDigest: serverDigest!, mcp: f.profile.mcp!, installationQualification: {
      ...f.profile.installationQualification, status: 'ENABLED', platform: 'linux', cliVersion: '1.0.0', serverDigest,
    },
  });
  return { ...f, owner, installation, installationRoot, registry };
}

describe('S1 installation owner handoff (T-OG-15/17)', () => {
  it('qualifies its own single-link executable with trusted permissions', async () => {
    const f = await installedFixture();
    const executable = await stat(f.installation.executable);
    expect(f.installation.executable).toBe(path.join(f.installationRoot, 'node'));
    expect(executable.mode & 0o777).toBe(0o755);
    expect(executable.nlink).toBe(1);
    expect((await f.call()).result.exitCode).toBe(0);
  });

  it('renders a nonlaunching plan carrying rechecked installation qualification', async () => {
    const f = await installedFixture();
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.selected.qualificationDigest).toBe(f.installation.evidence.scopeDigest);
    expect(result.plan.invocation.argv).toContain(f.installation.permissions.sandbox);
    expect(result.plan.invocation.argv).toContain(f.installation.permissions.approval);
    await expect(readFile(f.request.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(f.installationRoot, 'driver.mjs'), '// changed');
    const changed = await f.call();
    expect(changed.plan.invocation).toBeUndefined();
    expect(changed.plan.status).toBe('blocked');
  });

  it('requires the installation owner and rejects changed argv', async () => {
    const f = await installedFixture();
    const prepare = f.drivers.codex.prepareWorkerInvocation;
    delete f.drivers.codex.prepareWorkerInvocation;
    expect((await f.call()).plan.invocation).toBeUndefined();
    f.drivers.codex.prepareWorkerInvocation = prepare;
    const build = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async input => ({ ...await build(input), argv: [process.execPath, '--eval', 'arbitrary'] });
    const changed = await f.call();
    expect(changed.plan.invocation).toBeUndefined();
    expect(changed.plan.diagnostics.at(-1)).toMatchObject({ code: 'OG_PIN_MISMATCH' });
  });

  it('rechecks MCP descriptors against the qualified installation registration', async () => {
    const f = await installedFixture('mcp');
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.mcp.serverRef).toBe(f.profile.mcp!.serverRef);
    await f.registry.update(f.profile.mcp!.serverRef, { args: ['changed'] });
    const changed = await f.call();
    expect(changed.plan.invocation).toBeUndefined();
    expect(changed.plan.diagnostics.at(-1)).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED' });
  });
});

describe('T-OG-15 models resolve direct invocation', () => {
  it('shell and JSON use one descriptor, preserve all bytes and launch nothing until copied', async () => {
    const f = await fixture();
    const json = await f.call();
    expect(json.result.exitCode, json.output).toBe(0);
    const invocation = json.plan.invocation;
    expect(invocation.selected.effort).toEqual({ support: 'explicit', value: 'medium' });
    expect(invocation.readiness).toBe('launchable');
    const shell = await f.call('shell');
    expect(shell.output).toBe(invocation.shellCommand);
    expect((await f.call('alias')).plan).toEqual(json.plan);
    expect(await readdir(path.join(f.root, '.aiwg'))).toEqual(['aiwg.config']);
    await expect(readFile(invocation.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const config = path.join(f.root, 'fake.json'); const record = path.join(f.root, 'record.json');
    await writeFile(config, JSON.stringify({ recordPath: record, scenario: 'success' }));
    await execute('/bin/sh', ['-c', shell.output], { env: { AIWG_FAKE_WORKER_CONFIG: config, UNRELATED_SECRET: 'not-forwarded' }, timeout: 5000 });
    expect(JSON.parse(await readFile(record, 'utf8'))).toMatchObject({ argv: invocation.argv.slice(2), cwd: f.request.workdir,
      stdin: f.payload, outputPaths: { final: invocation.finalPath } });
    expect(JSON.parse(await readFile(record, 'utf8')).envNames).not.toContain('UNRELATED_SECRET');
    await expect(readFile(path.join(f.root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['ultra', 'contributor', 'stale', 'missing-controls', 'missing-installation'])(`denied %s returns no command`, async kind => {
    const f = await fixture();
    if (kind === 'ultra') f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.initialEffort = 'ultra';
    if (kind === 'ultra') f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.effortLadder = ['ultra'];
    if (kind === 'contributor') f.snapshot.catalog.discovery!.instances!.codex.models.forEach(row => { row.worker!.dataUse.productImprovement = true; });
    if (kind === 'stale') f.snapshot.catalog.discovery!.instances!.codex.models.forEach(row => { row.worker!.observedAt = '2026-09-01T00:00:00Z'; });
    if (kind === 'missing-controls') f.profile.controls.sandbox.support = 'unqualified';
    if (kind === 'missing-installation') f.snapshot.installations = {};
    const result = await f.call('shell');
    expect(result.result.exitCode, result.output).toBe(2);
    expect(result.plan.invocation).toBeUndefined();
    expect(f.buildInvocation).not.toHaveBeenCalled();
  });

  it('checks current brief and profile digests, including mutations during preparation', async () => {
    const f = await fixture();
    const first = (await f.call()).plan;
    const expected = { digests: first.digests, briefDigest: first.invocation.briefDigest };
    await writeFile(f.request.brief, 'changed');
    let result = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now, expected);
    expect(result.invocation).toBeUndefined(); expect(result.diagnostics.at(-1)?.pointer).toBe('/request/brief');
    await writeFile(f.request.brief, f.payload);
    f.binding.cliVersion = '1.0.1';
    result = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now, expected);
    expect(result.invocation).toBeUndefined(); expect(result.diagnostics.some(d => d.pointer === '/request/expectedDigests')).toBe(true);
  });

  it('rejects symlinks and preserves a nonlaunchable preparatory plan for future brief/workdir', async () => {
    const f = await fixture();
    await rm(f.request.brief); await symlink(path.join(f.root, 'models.json'), f.request.brief);
    expect((await f.call()).result.exitCode).toBe(2);
    await rm(f.request.brief);
    f.request.final_output = path.join(f.root, 'future', 'result.json');
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(2);
    expect(result.plan.invocation).toMatchObject({ readiness: 'preparatory', briefDigest: null });
  });

  it.each(['--unknown=x', '--constructor=x', '--__proto__=x', '--toString=x', '--valueOf=x', '--hasOwnProperty=x', '--transport=acp', '--format=fish', '--group=workers; touch injected'])('rejects %s before loading', async flag => {
    const load = vi.fn(); const handler = createModelsHandler({ load });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['resolve', '--role=coding', '--task=implementation', '--group=workers',
      '--brief=/fixture/brief', '--workdir=/fixture/tree', '--final-output=/fixture/final', flag];
    expect((await handler.execute({ args, rawArgs: args, cwd: '/unused', frameworkRoot: '/unused' })).exitCode).toBe(2);
    expect(load).not.toHaveBeenCalled(); log.mockRestore();
  });

  it.each(['shell', 'json'])('rejects an equals-bearing executable in %s format', async format => {
    const f = await fixture();
    f.drivers.codex.buildInvocation = async () => ({ argv: ['/no/such/a=b', '/bin/echo', 'wrong-executable'], stdin: 'closed', envNames: [] });
    const result = await f.call(format);
    expect(result.result.exitCode).toBe(2);
    expect(result.plan.invocation).toBeUndefined();
  });

  it('keeps a preparatory shell plan off stdout and explains preparation on stderr', async () => {
    const f = await fixture();
    await rm(f.request.brief);
    const result = await f.call('shell');
    expect(result.result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).diagnostics).toContainEqual(expect.objectContaining({
      code: 'OG_CONFIG_REFERENCE', pointer: '/request/brief', message: expect.stringMatching(/prepar|resolve again/i),
    }));
  });

  it.each([
    ['brief digest', 'OG_PIN_MISMATCH', '/request/brief'],
    ['path', 'OG_CONFIG_REFERENCE', '/request/brief'],
    ['model', 'OG_MODEL_UNAPPROVED', '/parallelism/clis/codex/invocationProfile'],
    ['effort', 'OG_EFFORT_DENIED', '/parallelism/clis/codex/invocationProfile'],
    ['internal', 'OG_ADAPTER_UNQUALIFIED', '/parallelism/clis/codex/invocationProfile'],
  ])('emits a scoped, sanitized diagnostic for %s', async (kind, code, pointer) => {
    const f = await fixture();
    const secret = 'sensitive-internal-canary';
    let expected;
    if (kind === 'brief digest') expected = { digests: {}, briefDigest: digest('wrong') };
    if (kind === 'path') f.request.brief = secret;
    if (['model', 'effort', 'internal'].includes(kind)) {
      const { prepareWorkerInvocation } = await import('../../../../src/serve/worker-invocation.js');
      f.drivers.codex.prepareWorkerInvocation = async (invocation, qualification) => {
        if (kind === 'internal') throw new Error(secret);
        if (kind === 'model') invocation.selected.model = 'muse-spark-1.3-contributor';
        if (kind === 'effort') invocation.selected.effort.value = 'ultra';
        return prepareWorkerInvocation(invocation, qualification);
      };
    }
    const plan = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now, expected);
    expect(plan.invocation).toBeUndefined();
    expect(plan.diagnostics.at(-1)).toMatchObject({ code, pointer });
    expect(JSON.stringify(plan.diagnostics)).not.toContain(secret);
  });

  it('rejects unknown legacy resolve flags too', async () => {
    expect((await modelsHandler.execute({ args: ['resolve', '--unknown'], rawArgs: [], cwd: '/unused', frameworkRoot: '/unused' })).exitCode).toBe(2);
  });
});

describe('T-OG-19 all IN providers and T-OG-17 descriptors', () => {
  const providers = fixtureJson('provider-coverage.json').rows.filter((row: any) => row.scope === 'IN').map((row: any) => row.provider);
  it.each(providers)('handles eligible %s without a hardcoded provider filter', async provider => {
    const f = await installedFixture('shell', provider);
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.selected.cli).toBe(provider);
  });
  it('T-OG-17 same selected tuple and brief produce equivalent fake shell/MCP claims', async () => {
    const f = await fixture('codex');
    const shell = (await f.call()).plan.invocation;
    const binding = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: digest(workerInputSchema),
      outputSchemaDigest: digest({ type: 'object' }), sessionIsolation: 'per-call' as const, cancel: 'uncertain' as const };
    f.profile.transport = 'mcp'; f.profile.mcp = binding; f.binding.mcp = binding;
    f.snapshot.config.parallelism!.groups!.workers.execution = { transport: 'mcp' };
    const q = f.drivers.codex.qualification;
    q.mcp = binding; q.mcpSchemas = { input: workerInputSchema, output: { type: 'object' } };
    const worker = { invocationId: 'parity', workspace: f.request.workdir, brief: f.payload,
      selection: { provider: shell.selected.inferenceProvider, model: shell.selected.model, effort: shell.selected.effort.value } };
    const { cancel: _cancel, ...descriptor } = binding;
    f.drivers.codex.buildInvocation = async () => ({ mcp: { ...descriptor, arguments: worker, timeoutSeconds: 60 } });
    const mcp = await resolveWorkerInvocation(f.snapshot, { ...f.request, transport: 'mcp' }, f.drivers, f.now);
    expect(mcp.invocation, JSON.stringify(mcp.diagnostics)).toBeDefined();
    expect(mcp.invocation!.selected).toEqual(shell.selected);
    const config = path.join(f.root, 'parity-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(f.root, 'shell-record.json'), scenario: 'success', worker }));
    await execute('/bin/sh', ['-c', shell.shellCommand], { env: { AIWG_FAKE_WORKER_CONFIG: config }, timeout: 5000 });
    const shellClaims = JSON.parse(await readFile(shell.finalPath, 'utf8')).result;
    await writeFile(config, JSON.stringify({ recordPath: path.join(f.root, 'mcp-record.jsonl'), scenario: 'success' }));
    const pending = execute(process.execPath, [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], {
      env: { AIWG_FAKE_WORKER_CONFIG: config }, timeout: 5000,
    });
    const received = new Promise<void>((resolve, reject) => {
      let buffer = '';
      pending.child.stdout!.on('data', chunk => { buffer += chunk; if (buffer.trim().split('\n').length >= 2) resolve(); });
      pending.child.once('close', () => reject(new Error('Fake MCP subprocess closed before protocol output; no replay')));
    });
    pending.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: mcp.invocation!.mcp!.tool, arguments: mcp.invocation!.mcp!.arguments } }) + '\n');
    await received; pending.child.stdin!.end();
    const messages = (await pending).stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(digest(messages[0].result.tools[0].inputSchema)).toBe(binding.inputSchemaDigest);
    expect(messages[1].result.structuredContent).toEqual(shellClaims);
  });

  it('returns pinned MCP server/tool/arguments and detects schema replacement', async () => {
    const f = await installedFixture('mcp', 'muse');
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.shellCommand).toBeUndefined();
    expect(result.plan.invocation.mcp).toMatchObject({ serverRef: 'fixture-server', tool: 'fixture-worker',
      arguments: { workspace: f.request.workdir, brief: f.payload, selection: { model: 'synthetic/a%b', effort: 'medium' } } });
    f.drivers.muse.qualification.mcpSchemas!.input = { type: 'string' };
    expect((await f.call()).plan.invocation).toBeUndefined();
  });
});

describe('#2956 controls come from resolved permissions, never caller waivers', () => {
  it.each(['claude', 'muse', 'hermes'])('%s requires an enforcing boundary even with requiredControls=[model]', async provider => {
    const f = await fixture(provider);
    for (const policySource of [true, false]) {
      const selection = { profile: f.binding.profile, transport: 'shell' as const, cliVersion: '1.0.0',
        requiredControls: ['model'], boundary: { kind: 'native' as const },
        ...(policySource ? { policy: f.snapshot.models.defaults.workerSelection, permissions: { sandbox: 'workspace-write' as const }, effort: 'medium' } : {}) };
      expect(() => qualifyWorkerInvocationProfile(f.adapter, selection)).toThrow(/sandbox.*external/);
    }
    f.binding.boundary = { ...f.binding.boundary!, kind: 'native' };
    const result = await f.call();
    expect(result.plan.invocation).toBeUndefined(); expect(f.buildInvocation).not.toHaveBeenCalled();
  });
  it('parses premium authorization for one request and rejects values or duplicates', () => {
    const args = fixtureJson('public-vocabulary.json').cli.cases[0].argv.slice(2);
    expect(parseWorkerCommandArgs([...args, '--authorize-premium']).authority).toEqual({ premiumAuthorized: true, maxAutoTier: 3 });
    expect(parseWorkerCommandArgs(args).authority).toBeUndefined();
    expect(() => parseWorkerCommandArgs([...args, '--authorize-premium=false'])).toThrow('Unsupported');
    expect(() => parseWorkerCommandArgs([...args, '--authorize-premium', '--authorize-premium'])).toThrow('Duplicate');
  });
  it('requires the strictest set without policy and preserves additions', () => {
    expect(requiredWorkerControls({ requiredControls: ['model'] })).toEqual([
      'model', 'effort', 'sandbox', 'approval', 'workdir', 'finalOutput', 'stdin', 'structuredOutput', 'stepCap', 'trust', 'children', 'fallback',
    ]);
    expect(parseWorkerCommandArgs(fixtureJson('public-vocabulary.json').cli.cases[0].argv.slice(2))).toMatchObject({ role: 'coding', format: 'shell' });
  });
});
