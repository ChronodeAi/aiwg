import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { ModelResolver, resolveWorkerPlan } from '../../../src/models/resolver.js';
import { assertWorkerRoleEffort, mergeWorkerSelection, validateUserProjectModelConfig, validateWorkerPolicyRoute, workerModelKey } from '../../../src/models/provider-policy.js';
import { parseWorkerCommandArgs, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerTemplateProject } from '../../fixtures/worker-template-project.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const f = await workerTemplateProject(); roots.push(f.root);
  vi.stubEnv('AIWG_HOME', f.builtin); vi.stubEnv('AIWG_CONFIG', f.user);
  const guidance = f.fixture.projectPolicy.roleGuidance!;
  guidance.maintenance = { ...guidance.coding, baseRole: 'coding', effortLadder: ['medium'] };
  f.fixture.projectPolicy.taskClasses = { maintenance: 'maintenance' };
  await f.write();
  return f;
}
async function loaded(f: Awaited<ReturnType<typeof setup>>) {
  const loader = new ConfigLoader(f.root);
  f.fixture.snapshot.models = await loader.load(f.parallelism);
  f.fixture.snapshot.modelDigests = loader.getInputDigests()!;
  return f.fixture.snapshot;
}

describe('T-OG-13 constrained project rubrics', () => {
  it('R01 accepts a declared alias and retains base qualification, ceilings and origins', async () => {
    const f = await setup(); const snapshot = await loaded(f);
    const plan = resolveWorkerPlan(snapshot, { ...f.fixture.request, role: 'maintenance', taskClass: 'maintenance' });
    expect(plan.status).toBe('eligible');
    expect(plan.role).toBe('maintenance');
    expect(plan.selected).toMatchObject({ member: 'primary', effort: 'medium', effectiveMaxParallel: 1 });
    expect(plan.eligible.every(tuple => tuple.effort === 'medium')).toBe(true);
    expect(plan.origins!['/defaults/workerSelection/roleGuidance/maintenance/baseRole'][0]).toMatchObject({ source: f.modelsFile, contribution: 'coding' });
    snapshot.catalog.discovery!.instances!.codex.models.forEach(row => { row.worker!.qualification.roles = ['reasoning']; });
    expect(resolveWorkerPlan(snapshot, { ...f.fixture.request, role: 'maintenance', taskClass: 'maintenance' }).selected).toBeNull();
  });

  it.each([
    ['unknown', { baseRole: undefined }], ['alias-chain', { baseRole: 'maintenance' }],
    ['groups', { groups: ['unbounded'] }], ['effort', { initialEffort: 'ultra', effortLadder: ['ultra'] }],
    ['tier', { tier: 'economy' }], ['null-effort', { initialEffort: null, effortLadder: [], allowNotApplicableEffort: true }],
    ['none-effort', { initialEffort: 'none', effortLadder: [] }], ['escalation', { maxEscalations: 99 }],
  ])('R02 rejects %s alias widening', async (_name, change) => {
    const f = await setup(); Object.assign(f.fixture.projectPolicy.roleGuidance!.maintenance, change);
    expect(validateUserProjectModelConfig({ defaults: { workerSelection: f.fixture.projectPolicy } }).valid).toBe(false);
    await f.write(); await expect(new ConfigLoader(f.root).load(f.parallelism)).rejects.toThrow();
  });

  it('R03 restricts alias declarations to projects and rejects missing base guidance', async () => {
    const f = await setup();
    const policy = f.fixture.projectPolicy;
    const result = mergeWorkerSelection([{ source: 'user', authority: 'user', digest: 'synthetic', policy }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_POLICY_RELAXATION' }));
    delete policy.roleGuidance!.coding;
    await f.write(); await expect(new ConfigLoader(f.root).load(f.parallelism)).rejects.toThrow('Alias base role has no guidance');
  });

  it.each(['constructor', '__proto__', 'prototype', ...Object.getOwnPropertyNames(Object.prototype).filter(key => !['constructor', '__proto__'].includes(key))])(
    'rejects reserved alias %s without pollution or excluded-group eligibility', async role => {
      const constructors = Object.getOwnPropertyDescriptors(Object);
      const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
      try {
        const f = await setup();
        const coding = { groups: ['workers'], tier: 'standard' as const, initialEffort: 'medium', effortLadder: ['medium'] };
        const alias = { ...coding, baseRole: 'coding' as const, groups: ['excluded'] };
        const project = { roleGuidance: { [role]: alias } };
        f.parallelism.groups!.excluded = { template: 'focused' };
        await writeFile(f.user + '/models.json', JSON.stringify({ defaults: { workerSelection: { roleGuidance: { coding } } } }));
        await writeFile(f.modelsFile, JSON.stringify({ defaults: { workerSelection: project } }));
        await expect.soft(new ConfigLoader(f.root).load(f.parallelism)).rejects.toThrow(/Reserved worker role alias key/);
        expect.soft(Object.prototype.constructor).toBe(Object);
        expect.soft(Object.getOwnPropertyDescriptors(Object)).toEqual(constructors);
        expect.soft(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
        const merged = mergeWorkerSelection([
          { source: 'user', authority: 'user', digest: 'synthetic', policy: { roleGuidance: { coding } } },
          { source: 'project', authority: 'project', digest: 'synthetic', policy: project },
        ]);
        expect.soft(merged.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_CONFIG_REFERENCE' }));
        f.fixture.snapshot.models.defaults.workerSelection = merged.policy;
        const plan = resolveWorkerPlan(f.fixture.snapshot, { ...f.fixture.request, taskClass: undefined, role, group: 'excluded' });
        expect.soft(plan.status).not.toBe('eligible');
        expect.soft(plan.selected).toBeNull();
        expect.soft(Object.getOwnPropertyDescriptors(Object)).toEqual(constructors);
        expect.soft(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
      } finally {
        // A failing pre-fix run must not leak mutated built-ins into neighbouring cases.
        for (const [target, before] of [[Object, constructors], [Object.prototype, prototype]] as const) {
          for (const key of Object.getOwnPropertyNames(target)) if (!Object.hasOwn(before, key)) Reflect.deleteProperty(target, key);
          Object.defineProperties(target, before);
        }
      }
    },
  );

  it('requires own guidance at resolution and provider policy lookups', () => {
    const f = workerResolutionFixture();
    const coding = f.projectPolicy.roleGuidance!.coding;
    const policy = f.snapshot.models.defaults.workerSelection!;
    policy.roleGuidance = Object.create({ inherited: { ...coding, baseRole: 'coding' }, coding });
    const plan = resolveWorkerPlan(f.snapshot, { ...f.request, taskClass: undefined, role: 'inherited', group: 'workers' });
    expect.soft(plan.selected).toBeNull();
    expect.soft(() => assertWorkerRoleEffort(policy, 'inherited')).toThrow(/Missing role guidance/);
    expect.soft(validateWorkerPolicyRoute({ policy, role: 'inherited', inferenceProvider: 'vendor',
      apiModelId: 'synthetic/a%b', selectedModel: 'synthetic/a%b', effort: 'medium',
      identityEvidence: 'runtime-configured', observation: f.observation, now: new Date(f.request.now!),
    })).toContainEqual(expect.objectContaining({ code: 'OG_CONFIG_REFERENCE', message: 'Role guidance is unavailable' }));
  });

  it('merges data-class dictionaries safely and rejects inherited class lookups', () => {
    const before = Object.getOwnPropertyDescriptors(Object);
    try {
      const f = workerResolutionFixture();
      const policy = f.snapshot.models.defaults.workerSelection!;
      const merged = mergeWorkerSelection([{ source: 'project', authority: 'project', digest: 'synthetic',
        policy: { ...policy, dataClasses: { constructor: { allowedProcessing: ['local'] } } },
      }]);
      expect.soft(Object.getOwnPropertyDescriptors(Object)).toEqual(before);
      expect.soft(Object.getPrototypeOf(merged.policy.dataClasses)).toBeNull();
      expect.soft(Object.hasOwn(merged.policy.dataClasses!, 'constructor')).toBe(true);
      policy.dataClasses = {};
      expect(validateWorkerPolicyRoute({ policy, role: 'coding', inferenceProvider: 'vendor',
        apiModelId: 'synthetic/a%b', selectedModel: 'synthetic/a%b', effort: 'medium', dataClass: 'constructor',
        identityEvidence: 'runtime-configured', observation: f.observation, now: new Date(f.request.now!),
      })).toContainEqual(expect.objectContaining({ code: 'OG_DATA_POLICY', message: 'Unknown data class' }));
    } finally {
      for (const key of Object.getOwnPropertyNames(Object)) if (!Object.hasOwn(before, key)) Reflect.deleteProperty(Object, key);
      Object.defineProperties(Object, before);
    }
  });

  it('R08 inherits omitted escalation controls from the base role', async () => {
    const f = await setup();
    Object.assign(f.fixture.projectPolicy.roleGuidance!.coding, { maxEscalations: 0, escalateAfter: 4, deescalateAfter: 3 });
    await f.write();
    expect((await loaded(f)).models.defaults.workerSelection!.roleGuidance!.maintenance)
      .toMatchObject({ maxEscalations: 0, escalateAfter: 4, deescalateAfter: 3 });
  });

  it('R04 rejects aliases that widen an inherited base restriction', async () => {
    const f = await setup();
    const coding = f.fixture.projectPolicy.roleGuidance!.coding;
    await writeFile(f.user + '/models.json', JSON.stringify({ defaults: { workerSelection: { roleGuidance: { coding } } } }));
    delete f.fixture.projectPolicy.roleGuidance!.coding;
    f.fixture.projectPolicy.roleGuidance!.maintenance.effortLadder = ['medium', 'ultra'];
    await f.write(); await expect(new ConfigLoader(f.root).load(f.parallelism)).rejects.toThrow('Alias effort choices widen base role');
  });

  it('R05 reordered denied models remain excluded for aliases and conductor choices', async () => {
    const f = await setup();
    const template = f.parallelism.groupTemplates!.bounded;
    template.members = [template.members![1], template.members![0]];
    template.members[1].priority = 0;
    f.fixture.projectPolicy.guards = { deniedModels: [workerModelKey('vendor', 'synthetic/a%b')] };
    const guidance = f.fixture.projectPolicy.roleGuidance!;
    guidance.coding.groups = ['workers', 'alternate'];
    guidance.maintenance.groups = ['alternate', 'workers'];
    f.parallelism.groups!.alternate = { template: 'focused' };
    await f.write(); const snapshot = await loaded(f);
    const request = { ...f.fixture.request, role: 'maintenance', taskClass: 'maintenance' };
    const plan = resolveWorkerPlan(snapshot, request);
    expect(plan.selected).toMatchObject({ group: 'alternate', member: 'alternate' });
    expect(plan.eligible.some(tuple => tuple.model === 'synthetic/a%b')).toBe(false);
    expect(plan.exclusions.filter(tuple => tuple.model === 'synthetic/a%b').every(tuple => tuple.diagnostics.some(d => d.code === 'OG_MODEL_UNAPPROVED'))).toBe(true);
    expect(resolveWorkerPlan(snapshot, { ...request, choice: { group: 'workers', member: 'primary', model: 'synthetic/a%b', effort: 'medium', rationale: 'prefer first' } }).selected).toBeNull();
  });

  it('R06 retains base wrapper pins and rejects conflicting task roles', async () => {
    const f = await setup(); const snapshot = await loaded(f);
    snapshot.models.agentOverrides['aiwg-model-coding-worker'] = { 'model-override': 'absent' };
    expect(resolveWorkerPlan(snapshot, { ...f.fixture.request, role: 'maintenance', taskClass: 'maintenance' }).selected).toBeNull();
    expect(resolveWorkerPlan(snapshot, { ...f.fixture.request, role: 'maintenance' }).diagnostics).toContainEqual(expect.objectContaining({ pointer: '/request/taskClass' }));
  });

  it('R07 group effort and data restrictions remain request eligibility boundaries', async () => {
    const f = await setup(); f.parallelism.groupTemplates!.bounded.dataPolicy!.allowedProcessing = ['local'];
    await f.write(); const snapshot = await loaded(f);
    const row = snapshot.catalog.discovery!.instances!.codex.models[0];
    row.worker!.dataUse.processing = 'remote';
    const plan = resolveWorkerPlan(snapshot, f.fixture.request);
    expect(plan.eligible.some(tuple => tuple.member === 'primary')).toBe(false);
    expect(plan.exclusions.flatMap(tuple => tuple.diagnostics)).toContainEqual(expect.objectContaining({ code: 'OG_DATA_POLICY' }));
    const high = resolveWorkerPlan(snapshot, { ...f.fixture.request, effort: 'high' });
    expect(high.selected).toBeNull();
    expect(high.exclusions.flatMap(tuple => tuple.diagnostics)).toContainEqual(expect.objectContaining({ code: 'OG_EFFORT_DENIED' }));
  });
});

it.each(['codex', 'pi'])('T-OG-15/T-OG-19 D01 resolves template/alias shell handoff for %s without managed state', async provider => {
  const f = await setup();
  const template = f.parallelism.groupTemplates!.bounded;
  template.members!.forEach(member => { member.cli = provider; });
  const snapshot = await loaded(f);
  const adapter = snapshot.registry.providers.codex.workerAdapter!;
  adapter.id = provider; snapshot.registry.providers[provider].workerAdapter = adapter;
  if (provider !== 'codex') delete snapshot.registry.providers.codex.workerAdapter;
  const binding = snapshot.installations.codex;
  binding.boundary = { kind: 'os', identity: 'fixture:boundary', digest: 'sha256:' + 'a'.repeat(64), controls: ['sandbox'] };
  snapshot.installations = { [provider]: binding };
  const discovery = snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = provider; discovery.models.forEach(row => { row.worker!.cliId = provider; });
  snapshot.catalog.discovery!.instances = { [provider]: discovery };
  const brief = join(f.root, 'brief.md'); await writeFile(brief, 'A bounded synthetic task.');
  const workdir = join(f.root, 'tree'); await mkdir(workdir);
  const request = parseWorkerCommandArgs(['--role', 'maintenance', '--task', 'maintenance', '--group', 'workers',
    '--brief', brief, '--workdir', workdir, '--final-output', join(f.root, 'final.json')]);
  const driver: WorkerInvocationDriver = { qualification: { adapter, adapterId: provider, cliVersion: '1.0.0', boundary: binding.boundary },
    buildInvocation: async input => ({ argv: [process.execPath, resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', input.selected.model,
      '--effort', input.selected.effort.value!, '--final-output', input.finalPath], stdin: 'brief-text', envNames: [] }) };
  const plan = await resolveWorkerInvocation(snapshot, request, { [provider]: driver }, f.fixture.request.now);
  expect(plan.status, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: plan.exclusions })).toBe('eligible');
  expect(plan.invocation?.shellCommand).toContain('ralph-worker-cli.mjs');
  expect(plan.invocation?.effectiveCaps.parallel).toBe(1);
  expect(plan.invocation?.health?.origins).toBeDefined();
  expect(await readdir(join(f.root, '.aiwg'))).toEqual(['aiwg.config']);
  expect((await new ModelResolver({}, f.root).resolveWorker({ ...f.fixture.request, role: 'maintenance', taskClass: 'maintenance' }, { ...snapshot })).selected?.effort).toBe('medium');
});
