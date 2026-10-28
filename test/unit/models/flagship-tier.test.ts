// Exercises flagship election and preserves explicit project worker model bindings.
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeModelTier } from '../../../src/models/router.js';
import { compileModelPolicy, loadProviderModelCatalog, validateCanonicalModelPolicy } from '../../../src/models/provider-policy.js';
import { resolveDynamicModelCatalog } from '../../../src/models/model-discovery.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';
import { buildWrapperRouteEnvelope } from '../../../src/models/wrapper-route.js';
import { handleStewardModels } from '../../../src/cli/handlers/steward-models.js';
import type { ProviderInventory } from '../../../src/providers/provider-inventory.js';
import type { CapabilityMatrix } from '../../../src/providers/capability-matrix.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const root = path.resolve(import.meta.dirname, '../../..');
const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function temporary() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-flagship-')); scratch.push(dir); return dir;
}
const capability = { type: 'agent' as const, name: 'architect', id: 'aiwg:agent:architect',
  source: { path: 'synthetic.md', scope: 'packaged' as const, provenance: 'corpus' as const } };

describe('flagship election boundary (#2643)', () => {
  it.each(['flagship', 'max-quality'] as const)('accepts and normalizes %s in schema and validator', async tier => {
    const schema = JSON.parse(await readFile(path.join(root, 'schemas/models/model-policy.v1.schema.json'), 'utf8'));
    const policy = { role: 'coding', tier };
    expect(new Ajv2020({ strict: true }).compile(schema)(policy)).toBe(true);
    expect(validateCanonicalModelPolicy(policy)).toMatchObject({ valid: true, policy: { tier: 'flagship' } });
  });

  it.each([false, true])('caps unelected flagship requests, including unattended=%s', unattended => {
    for (const request of [{ defaultTier: 4 as const }, { requestedTier: 'flagship' as const }, { requestedTier: 'max-quality' as const }]) {
      expect(routeModelTier({ ...request, unattended, premiumAuthorized: true, maxAutoTier: 4 }).modelTier).toBe('premium');
    }
    expect(routeModelTier({ defaultTier: 3, complex: true, highImpact: true, premiumAuthorized: true }).modelTier).toBe('premium');
  });

  it.each([false, true])('requires election or an exact allowlist target in unattended=%s', unattended => {
    expect(routeModelTier({ requestedTier: 'flagship', unattended, election: 'user' }))
      .toMatchObject({ tier: 4, modelTier: 'flagship', requiresConfirmation: false });
    expect(routeModelTier({ requestedTier: 'flagship', unattended, agentName: 'architect', flagshipAllowlist: ['architect'] }).modelTier).toBe('flagship');
    expect(routeModelTier({ requestedTier: 'flagship', agentName: 'architect', flagshipAllowlist: ['arch*'] }).modelTier).toBe('premium');
    expect(routeModelTier({ deterministic: true, requestedTier: 'flagship', election: 'user' }).modelTier).toBeNull();
  });

  it('blocks flagship bindings and exact overrides without election', () => {
    for (const tier of ['flagship', 'max-quality'] as const) {
      expect(() => compileModelPolicy({ provider: 'codex', artifact: 'agent', policy: { role: 'coding', tier } })).toThrow('user-elected only');
    }
    expect(() => compileModelPolicy({ provider: 'codex', artifact: 'agent',
      policy: { role: 'coding', tier: 'standard', override: 'gpt-6-astra' } })).toThrow('user-elected only');
    const catalog = structuredClone(loadProviderModelCatalog());
    catalog.providers.codex.tiers!.standard = { id: 'synthetic-flagship', status: 'active', selection: 'user-elected' };
    expect(() => compileModelPolicy({ provider: 'codex', artifact: 'agent', catalog,
      policy: { role: 'coding', tier: 'standard' } })).toThrow('user-elected only');
  });

  it('routes explicit flagship wrappers and honors capability allowlists', () => {
    const request = { provider: 'codex' as const, capability, assignment: 'Bounded analysis.', launchMechanism: 'manual' as const,
      requestedTier: 'flagship' as const };
    expect(buildWrapperRouteEnvelope(request).tier).toBe('premium');
    for (const authority of [{ election: 'user' as const }, { flagshipAllowlist: ['architect'] }]) {
      expect(buildWrapperRouteEnvelope({ ...request, ...authority })).toMatchObject({ tier: 'flagship', role: 'reasoning', model: { effectiveModel: 'gpt-6-astra' } });
    }
  });

  it('labels flagship entries in steward human and JSON output', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleStewardModels(['models', '--json'], {} as CapabilityMatrix);
    const result = JSON.parse(output.mock.calls[0][0]);
    expect(result.tiers.codex.flagship).toMatchObject({ id: 'gpt-6-astra', selection: 'user-elected', label: 'user-elected only' });
    output.mockClear();
    await handleStewardModels(['models'], {} as CapabilityMatrix);
    expect(output.mock.calls.flat().join('\n')).toContain('claude flagship: claude-fable-5-1 (user-elected only)');
  });

  it('preserves the verified ladder through offline dynamic discovery', async () => {
    const dir = await temporary();
    const models = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].map(id => ({ id, isDefault: id === 'gpt-6-astra' }));
    const catalog = await resolveDynamicModelCatalog({ aiwgRoot: root, homeDir: dir, allowNetwork: false,
      inventory: { providers: [{ id: 'codex', available: true, evidence: [] }] } as unknown as ProviderInventory,
      now: () => new Date('2026-10-27T12:00:00Z'), nativeDiscoverers: {
        codex: async () => ({ provider: 'codex', source: 'native', observedAt: '2026-10-27T12:00:00Z', runtimeVersion: 'codex-cli 0.165.0', accountScope: 'local-account', models }),
      } });
    expect(catalog.providers.codex.roles).toMatchObject({ reasoning: { id: 'gpt-6.1-sol' }, coding: { id: 'gpt-6.1-terra' }, efficiency: { id: 'gpt-6-luna' } });
    const parsed = loadProviderModelCatalog();
    for (const provider of ['claude', 'codex'] as const) {
      expect(parsed.providers[provider].verified_at).toBe('2026-10-27');
      expect(parsed.providers[provider].evidence).toContain('Conductor-verified');
      expect(parsed.providers[provider].tiers!.flagship.selection).toBe('user-elected');
    }
  });

  it('blocks flagship worker pins unless the user elects them', () => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.groups!.workers.members[0].model = 'gpt-6-astra';
    const row = f.snapshot.catalog.discovery!.instances!.codex.models[0];
    row.id = row.apiModelId = 'gpt-6-astra';
    const request = { ...f.request, group: 'workers', member: 'primary', authority: { premiumAuthorized: true, maxAutoTier: 4 as const } };
    const blocked = resolveWorkerPlan(f.snapshot, request);
    expect(blocked.selected).toBeNull();
    expect(blocked.exclusions.flatMap(entry => entry.diagnostics).some(entry => entry.message === 'Flagship models are user-elected only')).toBe(true);
    for (const authority of [{ election: 'user' as const }, { agentName: 'architect', flagshipAllowlist: ['architect'] }]) {
      expect(resolveWorkerPlan(f.snapshot, { ...request, authority }).selected?.model).toBe('gpt-6-astra');
    }
  });

  it('keeps the project default coding worker on gpt-6.1-sol', async () => {
    const dir = await temporary();
    const projectModels = await readFile(path.join(root, 'models.json'), 'utf8');
    const projectConfig = JSON.parse(await readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8'));
    await writeFile(path.join(dir, 'models.json'), projectModels);
    await mkdir(path.join(dir, 'empty-user'));
    vi.stubEnv('AIWG_CONFIG', path.join(dir, 'empty-user'));
    const models = await new ConfigLoader(dir, { aiwgHome: root }).load(projectConfig.parallelism);
    const f = workerResolutionFixture();
    f.snapshot.models = models;
    f.snapshot.config.parallelism!.groups = structuredClone(projectConfig.parallelism.groups);
    f.snapshot.config.parallelism!.groups.harness.execution = { sandbox: 'workspace-write', approval: 'never', transport: 'shell' };
    const discovery = f.snapshot.catalog.discovery!.instances!.codex;
    const template = discovery.models[0];
    discovery.models = ['gpt-6.1-sol', 'gpt-6-luna'].map(id => ({ ...structuredClone(template), id, apiModelId: id }));
    const plan = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', group: 'harness' });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.exclusions).toHaveLength(2);
    expect(plan.exclusions.every(entry => entry.model === 'gpt-6-luna'
      && entry.diagnostics[0].message === 'Member does not cover requested role')).toBe(true);
    expect(plan.selected?.model).toBe('gpt-6.1-sol');
  });
});
