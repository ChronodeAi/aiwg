import { mkdtemp, mkdir, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelResolver, resolveWorkerPlan } from '../../../src/models/resolver.js';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

describe('T-OG-15 S1 resolution from current files without managed services', () => {
  it('D01 reloads user/project files and blocks stale decisions without creating managed state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-resolution-2883-'));
    roots.push(root);
    const builtin = join(root, 'builtin');
    const user = join(root, 'user');
    const project = join(root, 'project');
    await mkdir(join(builtin, 'agentic/code/frameworks/sdlc-complete/config'), { recursive: true });
    await mkdir(user);
    await mkdir(project);
    vi.stubEnv('AIWG_HOME', builtin);
    vi.stubEnv('AIWG_CONFIG', user);
    const f = workerResolutionFixture();
    await writeFile(join(builtin, 'agentic/code/frameworks/sdlc-complete/config/models-v2.json'), JSON.stringify({
      version: '2.0', defaults: { provider: 'codex', tier: 'standard' }, providers: {}, tiers: {},
    }));
    await writeFile(join(project, 'models.json'), JSON.stringify({ defaults: { workerSelection: f.projectPolicy } }));
    const resolver = new ModelResolver({}, project);
    const initial = await resolver.resolveWorker(f.request, f.snapshot);
    expect(initial.status).toBe('eligible');
    expect(initial.mode).toBe('direct');
    expect(initial.digests.userModelsDigest).toBe(workerConfigDigest(null));
    f.request.expectedDigests = initial.digests;
    expect((await resolver.resolveWorker(f.request, f.snapshot)).status).toBe('eligible');
    await writeFile(join(user, 'models.json'), JSON.stringify({ defaults: { workerSelection: { guards: { deniedEfforts: ['high'] } } } }));
    expect((await resolver.resolveWorker(f.request, f.snapshot)).selected).toBeNull();
    delete f.request.expectedDigests;
    const current = await resolver.resolveWorker(f.request, f.snapshot);
    expect(current.eligible.map(t => t.effort)).toEqual(['medium', 'medium']);
    expect(current.origins?.['/defaults/workerSelection/guards/deniedEfforts'].at(-1)?.source).toBe(join(user, 'models.json'));
    await writeFile(join(project, 'models.json'), '{invalid');
    await expect(resolver.resolveWorker(f.request, f.snapshot)).rejects.toThrow('Invalid project model config');
    expect(await readdir(project)).toEqual(['models.json']); // No MC, scheduler, Mission, or receipt directories.
  });
});

describe('T-OG-17 S1 shared selection mapping, not MCP execution qualification', () => {
  it('D02 preserves tuple/identity across shell and MCP and rejects schema drift', () => {
    const f = workerResolutionFixture();
    const shell = resolveWorkerPlan(f.snapshot, f.request);
    const profile = f.snapshot.registry.providers.codex.workerAdapter!.invocationProfiles!['fixture-shell'];
    const mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: workerConfigDigest({ input: 'v1' }),
      outputSchemaDigest: workerConfigDigest({ output: 'v1' }), sessionIsolation: 'per-call' as const, cancel: 'uncertain' as const };
    profile.transport = 'mcp';
    profile.mcp = structuredClone(mcp);
    f.snapshot.installations.codex.mcp = structuredClone(mcp);
    f.snapshot.config.parallelism!.groups!.workers.execution = { transport: 'mcp' };
    f.request.transport = 'mcp';
    const plan = resolveWorkerPlan(f.snapshot, f.request);
    expect(plan.status, JSON.stringify(plan.exclusions)).toBe('eligible');
    expect(plan.selected).toMatchObject({ group: shell.selected!.group, member: shell.selected!.member,
      model: shell.selected!.model, effort: shell.selected!.effort, identityEvidence: 'runtime-configured' });
    f.snapshot.installations.codex.mcp.inputSchemaDigest = workerConfigDigest({ input: 'changed' });
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
  });
});

describe('T-OG-19 S1 provider-neutral resolver coverage; synthetic is not live-qualified', () => {
  // Every registry provider can be evaluated. This deliberately does not promote
  // excluded or documentation-only providers into real worker qualification.
  it.each(PROVIDER_IDS.filter(id => id !== 'generic'))('D03 %s requires qualified evidence rather than a CLI-name guess', provider => {
    const f = workerResolutionFixture();
    const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
    f.snapshot.registry.providers[provider].workerAdapter = structuredClone(adapter);
    const discovery = f.snapshot.catalog.discovery!.instances!.codex;
    for (const row of discovery.models) row.worker!.cliId = provider;
    f.snapshot.catalog.discovery!.instances = { [provider]: discovery };
    f.snapshot.installations = { [provider]: f.snapshot.installations.codex };
    for (const member of f.snapshot.config.parallelism!.groups!.workers.members) member.cli = provider;
    const plan = resolveWorkerPlan(f.snapshot, f.request);
    expect(plan.status, JSON.stringify(plan.exclusions)).toBe('eligible');
    expect(plan.selected?.inferenceProvider).toBe('vendor');
    expect(plan.selected?.family).toBe('synthetic-family');
    f.snapshot.registry.providers[provider].workerAdapter!.qualification.status = 'unqualified';
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
  });

  it('D04 generic/inference names do not become canonical CLI installations', () => {
    const f = workerResolutionFixture();
    for (const cli of ['generic', 'openai']) {
      f.snapshot.config.parallelism!.groups!.workers.members.forEach(m => { m.cli = cli; });
      expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
    }
  });
});
