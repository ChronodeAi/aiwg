import { readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveParallelism, validateParallelismConfig, workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { expandWorkerGroupTemplates } from '../../../src/config/worker-group-templates.js';
import { diagnoseDirectWorkerReadiness } from '../../../src/models/worker-direct-readiness.js';
import { diagnoseWorkerHealthReadiness } from '../../../src/models/worker-health-readiness.js';
import { managedProjectAdmissionPolicy } from '../../../src/serve/shared-host-scheduler.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { workerTemplateProject } from '../../fixtures/worker-template-project.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const f = await workerTemplateProject(); roots.push(f.root);
  vi.stubEnv('AIWG_HOME', f.builtin); vi.stubEnv('AIWG_CONFIG', f.user);
  return f;
}

describe('T-OG-13 constrained group templates', () => {
  it('G01 expands nested templates before reference validation without mutating inputs', async () => {
    const f = await setup(); const before = structuredClone(f.parallelism);
    expect(validateParallelismConfig(f.parallelism)).toEqual([]);
    const resolved = resolveParallelism(f.parallelism, 'codex');
    expect(resolved.groups!.workers).toMatchObject({ maxParallel: 1, efforts: ['medium'], members: [{ id: 'primary' }, { id: 'alternate' }] });
    expect(f.parallelism).toEqual(before);
    const models = await new ConfigLoader(f.root).load(f.parallelism);
    const origins = models.workerPolicyOrigins!['/parallelism/groups/workers/template'];
    expect(origins.map(origin => origin.pointer)).toEqual([
      '/parallelism/groupTemplates/bounded', '/parallelism/groupTemplates/focused', '/parallelism/groups/workers',
    ]);
    expect(origins[0]).toMatchObject({ source: f.configFile, digest: workerConfigDigest(f.parallelism.groupTemplates!.bounded),
      contribution: f.parallelism.groupTemplates!.bounded });
    expect(await readdir(f.root)).toEqual(expect.arrayContaining(['builtin', 'user', 'models.json', '.aiwg']));
    expect(await readdir(f.root + '/.aiwg')).toEqual(['aiwg.config']);
  });

  it.each([
    ['concurrency', { maxParallel: 3 }], ['effort', { efforts: ['medium', 'ultra'] }],
    ['data', { dataPolicy: { allowUnknown: true } }], ['retention', { dataPolicy: { maxRetentionDays: 31 } }],
    ['processing', { dataPolicy: { allowedProcessing: ['local', 'remote'] } }],
    ['member', { members: [{ id: 'extra', cli: 'codex', model: 'extra', roles: ['coding'] }] }],
    ['rebind', { members: [{ id: 'primary', cli: 'claude', model: 'other', roles: ['coding'] }] }],
    ['execution', { execution: { network: 'allowlisted' } }],
  ])('G02 rejects attempted %s widening', async (_name, override) => {
    const f = await setup();
    f.parallelism.groupTemplates!.bounded.dataPolicy = { allowedProcessing: ['local'], allowUnknown: false, maxRetentionDays: 30 };
    f.parallelism.groupTemplates!.bounded.execution = { network: 'deny' };
    Object.assign(f.parallelism.groups!.workers, override);
    expect(validateParallelismConfig(f.parallelism).join(';')).toMatch(/OG_POLICY_RELAXATION/);
    await expect(new ConfigLoader(f.root).load(f.parallelism)).rejects.toThrow('OG_POLICY_RELAXATION');
  });

  it.each(['missing', 'cycle', 'unused-cycle', 'bad-shape', 'missing-members', 'wrong-type'])('G03 rejects %s templates', async kind => {
    const f = await setup();
    if (kind === 'missing') f.parallelism.groups!.workers.template = 'absent';
    if (kind === 'cycle') f.parallelism.groupTemplates!.bounded.template = 'focused';
    if (kind === 'unused-cycle') f.parallelism.groupTemplates!.unused = { template: 'unused' };
    if (kind === 'bad-shape') (f.parallelism.groupTemplates as any).bounded = { members: 'invalid' };
    if (kind === 'missing-members') f.parallelism.groupTemplates = { focused: { maxParallel: 1 } };
    if (kind === 'wrong-type') (f.parallelism.groups!.workers as any).maxParallel = '1';
    expect(validateParallelismConfig(f.parallelism).length).toBeGreaterThan(0);
  });

  it('G04 rejects inherited model data conflicts and never caches failed candidates', async () => {
    const f = await setup(); const loader = new ConfigLoader(f.root);
    const previous = await loader.load(f.parallelism);
    await writeFile(f.user + '/models.json', JSON.stringify({ defaults: { workerSelection: { dataPolicy: { allowedProcessing: ['local'] } } } }));
    await expect(loader.load(f.parallelism)).rejects.toThrow('OG_POLICY_RELAXATION');
    await expect(loader.load(f.parallelism)).rejects.toThrow('OG_POLICY_RELAXATION');
    expect(previous.workerPolicyOrigins!['/parallelism/groups/workers/template']).toHaveLength(3);
    f.parallelism.groupTemplates!.bounded.dataPolicy!.allowedProcessing = ['local'];
    expect((await loader.load(f.parallelism)).workerPolicyOrigins!['/parallelism/groups/workers/template'][0].digest)
      .not.toBe(previous.workerPolicyOrigins!['/parallelism/groups/workers/template'][0].digest);
  });

  it('G05 retains legacy disabled dispatch and rejects hidden invalid declaration keys', async () => {
    const f = await setup(); f.parallelism.worker_dispatch = false;
    expect(resolveParallelism(f.parallelism).groups).toBeUndefined();
    (f.parallelism.groupTemplates!.bounded as any).unknown = true;
    expect(validateParallelismConfig(f.parallelism).join(';')).toContain('additional properties');
    expect(expandWorkerGroupTemplates(f.parallelism).origins).toHaveProperty('/parallelism/groups/workers/template');
  });

  it.each([64, 70])('enforces full %i-template ancestry in either declaration order', async length => {
    const f = await setup();
    const entries = Array.from({ length }, (_, index) => [
      `t${index}`, index === 0 ? structuredClone(f.parallelism.groupTemplates!.bounded) : { template: `t${index - 1}` },
    ] as const);
    const results: string[][] = [];
    for (const declarations of [entries, [...entries].reverse()]) {
      f.parallelism.groupTemplates = Object.fromEntries(declarations);
      f.parallelism.groups = { workers: { template: `t${length - 1}` } };
      const errors = validateParallelismConfig(f.parallelism);
      results.push(errors);
      if (length === 64) {
        expect.soft(errors).toEqual([]);
        const loaded = await new ConfigLoader(f.root).load(f.parallelism);
        expect(loaded.workerPolicyOrigins!['/parallelism/groups/workers/template']).toHaveLength(65);
      } else {
        expect.soft(errors.join(';')).toContain('excessive template nesting');
        await expect.soft(new ConfigLoader(f.root).load(f.parallelism)).rejects.toThrow('excessive template nesting');
      }
    }
    expect(results[0]).toEqual(results[1]);
  });

  it.each(['constructor', '__proto__', 'prototype', 'toString'])('looks up only own template declarations for %s', async name => {
    const f = await setup();
    const base = structuredClone(f.parallelism.groupTemplates!.bounded);
    f.parallelism.groupTemplates = { [name]: base };
    f.parallelism.groups = { workers: { template: name } };
    expect(expandWorkerGroupTemplates(f.parallelism).errors).toEqual([]);
    expect(expandWorkerGroupTemplates(f.parallelism).parallelism!.groups!.workers.members).toEqual(base.members);
    f.parallelism.groupTemplates = Object.create({ [name]: base });
    expect(expandWorkerGroupTemplates(f.parallelism).errors.join(';')).toContain('Unknown template');
    expect(Object.prototype.constructor).toBe(Object);
  });


  it('preserves an own __proto__ group key during expansion', async () => {
    const f = await setup();
    f.parallelism.groups = { ['__proto__']: { template: 'focused' } };
    const expanded = expandWorkerGroupTemplates(f.parallelism).parallelism!.groups!;
    expect(Object.hasOwn(expanded, '__proto__')).toBe(true);
    expect(expanded.__proto__.members).toEqual(f.parallelism.groupTemplates!.bounded.members);
    expect(Object.getPrototypeOf(expanded)).toBeNull();
  });

  it('retains readiness repair context for members inherited from templates', async () => {
    const f = await setup();
    const snapshot = f.fixture.snapshot;
    snapshot.models = await new ConfigLoader(f.root).load(f.parallelism);
    snapshot.installations = {};
    const direct = await diagnoseDirectWorkerReadiness({ parallelism: f.parallelism,
      registry: snapshot.registry, configFile: f.configFile, projectRoot: f.root,
      resolverSnapshot: { config: snapshot.config, models: snapshot.models, catalog: snapshot.catalog,
        modelDigests: snapshot.modelDigests, now: f.fixture.request.now } });
    expect(direct.findings).toContainEqual(expect.objectContaining({ kind: 'dispatch',
      configFile: f.configFile, configKey: '/parallelism/clis/codex',
      members: ['workers/alternate', 'workers/primary'], eligibility: 'blocked' }));
    expect(direct.findings.find(row => row.kind === 'dispatch')?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED', members: ['workers/alternate', 'workers/primary'] }));
    const health = diagnoseWorkerHealthReadiness(snapshot, f.fixture.request, { configFile: f.configFile });
    for (const member of ['primary', 'alternate']) expect(health.findings).toContainEqual(
      expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED', configFile: f.configFile,
        configKey: `/parallelism/groups/workers/members/${member}`, members: [`workers/${member}`] }));
  });

  it('combines inherited admission caps and membership with the starvation threshold', async () => {
    const f = await setup();
    f.parallelism.worker_mode = 'managed';
    f.parallelism.admission = { starvationSeconds: 7 };
    const policy = managedProjectAdmissionPolicy(f.root, f.parallelism, workerConfigDigest(f.parallelism), 4);
    expect(policy.starvationThresholdMs).toBe(7000);
    expect(Object.values(policy.managed!.dimensionCaps!)).toContain(1);
    expect(policy.managed!.members).toEqual({ 'workers/primary': { cli: 'codex' }, 'workers/alternate': { cli: 'codex' } });
    delete f.parallelism.admission.starvationSeconds;
    expect(managedProjectAdmissionPolicy(f.root, f.parallelism, workerConfigDigest(f.parallelism), 4).starvationThresholdMs).toBe(120000);
  });

});
