import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  loadProviderModelCapabilities, parseProviderModelCapabilities, WorkerAdapterSchema,
  resolveWorkerAdapter, resolveWorkerInstallation, qualifyWorkerInvocationProfile,
} from '../../../src/models/provider-policy.js';
import { fixtureJson, materialize, validators, type ContractVector } from '../../conformance/mission-v1/worker-contract-fixtures.js';

const adapter = () => structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
const registry = () => ({ ...structuredClone(loadProviderModelCapabilities()), workerAdapters: { fixture: adapter() } });
const vectors: ContractVector[] = fixtureJson('adapter-vectors.json');
const { draft2020, schemas } = validators();
const validate = draft2020.compile({ $ref: `${schemas.capability.$id}#/$defs/workerAdapter` });

describe('S1 production capability contracts (T-OG-03/14/15/17/19)', () => {
  it('ships the frozen adapter/profile definitions without changing their vocabulary', () => {
    const { $schema: _dialect, $defs, ...body } = fixtureJson('worker-adapter.fragment.json');
    // Declare required properties for strictRequired without changing the frozen constraints.
    body.properties.qualification.allOf[0].then.properties = { fixtureDigest: {}, verifiedAt: {}, evidenceRef: {} };
    $defs.invocationProfile.allOf[0].then.properties = { mcp: {} };
    const controls = $defs.invocationProfile.properties.controls;
    controls.properties = Object.fromEntries(controls.required.map((name: string) => [name, {
      $ref: '#/$defs/invocationProfile/properties/controls/additionalProperties',
    }]));
    expect(schemas.capability.$defs.workerAdapter).toEqual(body);
    for (const [name, definition] of Object.entries($defs)) expect(schemas.capability.$defs[name]).toEqual(definition);
    for (const [name, definition] of Object.entries(fixtureJson('capability-root.patch.json').properties)) expect(schemas.capability.properties[name]).toEqual(definition);
  });
  it('compiles the shipped capability schema in strict mode', () => {
    const strict = addFormats(new Ajv2020({ strict: true }));
    expect(() => strict.compile(schemas.capability)).not.toThrow();
  });
  it.each(vectors)('$pack $id', vector => {
    const value = materialize(vector, vectors);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(vector.valid);
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(vector.valid);
  });

  it('preserves the closed root, annotation and nested profile controls losslessly', () => {
    const value = registry();
    expect(parseProviderModelCapabilities(value)).toEqual(value);
    value.$schema = 'https://aiwg.io/schemas/models/provider-model-capabilities.v1.schema.json';
    expect(parseProviderModelCapabilities(value)).toEqual(value);
    for (const bad of [{ ...value, $schema: 'https://untrusted.invalid' }, { ...value, surprise: true },
      { ...value, providers: { ...value.providers, ollama: value.providers.claude } },
      { ...value, workerAdapters: { '../bad': adapter() } },
      { ...value, workerAdapters: { first: adapter(), second: adapter() } },
      { ...value, workerAdapters: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`a${i}`, { ...adapter(), id: `a${i}` }])) }]) {
      expect(() => parseProviderModelCapabilities(bad)).toThrow();
    }
  });

  it('native providers remain deployment enums; custom providers are inference identities', () => {
    const value = registry();
    value.workerAdapters.fixture.provider = 'synthetic-inference';
    value.providers.muse.workerAdapter = { ...adapter(), id: 'native-muse', provider: 'meta' };
    const parsed = parseProviderModelCapabilities(value);
    expect(resolveWorkerAdapter(parsed, 'workerAdapters:fixture').provider).toBe('synthetic-inference');
    expect(resolveWorkerAdapter(parsed, 'providers:muse').provider).toBe('meta');
  });

  it.each(['builtin:codex', 'fixture', 'providers.fixture', 'providers:Muse', 'Providers:muse',
    'workerAdapters:fixture:extra', 'workerAdapters:../fixture', 'workerAdapters:fixture\n', 'providers:ollama', 'providers:codex'])('rejects exact-reference violation %j', reference => {
    expect(() => resolveWorkerAdapter(registry(), reference)).toThrow();
  });

  it('inherits the process default; explicit executable wins and endpoint is forbidden', () => {
    const value = registry();
    expect(resolveWorkerInstallation(value, { adapter: 'workerAdapters:fixture' }).executable).toBe('fixture-worker');
    expect(resolveWorkerInstallation(value, { adapter: 'workerAdapters:fixture', executable: '/approved/bin/worker' }).executable).toBe('/approved/bin/worker');
    for (const extra of [{ endpoint: 'http://localhost' }, { executable: '' }, { executable: 'x\0' },
      { executable: 'worker', endpoint: 'http://localhost' }]) {
      expect(() => resolveWorkerInstallation(value, { adapter: 'workerAdapters:fixture', ...extra })).toThrow();
    }
  });

  it('HTTP requires an endpoint and forbids an executable without contacting the endpoint', () => {
    const value = registry();
    value.workerAdapters.fixture = materialize(vectors[0], vectors);
    expect(resolveWorkerInstallation(value, { adapter: 'workerAdapters:fixture', endpoint: 'http://127.0.0.1:1' }).endpoint).toBe('http://127.0.0.1:1');
    for (const extra of [{}, { executable: 'worker' }, { endpoint: 'file:///tmp/worker' }, { endpoint: 'http://user:pass@localhost' },
      { executable: 'worker', endpoint: 'http://localhost' }]) {
      expect(() => resolveWorkerInstallation(value, { adapter: 'workerAdapters:fixture', ...extra })).toThrow();
    }
  });

  it('version/transport qualification cannot silently drop required controls', () => {
    const value = adapter();
    const selection = { profile: 'fixture-shell', transport: 'shell' as const, cliVersion: '1.2.3', requiredControls: ['model'], policy: {}, permissions: { sandbox: 'workspace-write' as const }, effort: null };
    for (const [name, control] of Object.entries(value.invocationProfiles['fixture-shell'].controls) as any) {
      if (!['effort', 'stepCap'].includes(name)) control.support = 'native';
    }
    expect(() => qualifyWorkerInvocationProfile(value, selection)).toThrow('unqualified');
    value.qualification = { status: 'qualified', fixtureDigest: `sha256:${'1'.repeat(64)}`, verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:only' };
    expect(qualifyWorkerInvocationProfile(value, selection)).toEqual(value.invocationProfiles['fixture-shell']);
    for (const extra of [{ cliVersion: '2.0.0' }, { cliVersion: 'invalid' }, { transport: 'mcp' as const },
      { profile: 'unknown' }, { requiredControls: ['stepCap'] }, { requiredControls: ['undeclared'] }]) {
      expect(() => qualifyWorkerInvocationProfile(value, { ...selection, ...extra })).toThrow();
    }
    value.invocationProfiles['fixture-shell'].controls.model.support = 'unqualified';
    expect(() => qualifyWorkerInvocationProfile(value, selection)).toThrow('Required worker control');
  });

  it('MCP pins registered server/tool/schema and isolation without any MC dependency', () => {
    const value = materialize(vectors[1], vectors);
    value.qualification = { status: 'qualified', fixtureDigest: `sha256:${'1'.repeat(64)}`, verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:only' };
    const profile = value.invocationProfiles['fixture-shell'];
    for (const control of Object.values(profile.controls) as any[]) control.support = 'native';
    const selection = { profile: 'fixture-shell', transport: 'mcp' as const, cliVersion: '1.2.3', mcp: profile.mcp };
    expect(qualifyWorkerInvocationProfile(value, selection)).toEqual(profile);
    expect(() => qualifyWorkerInvocationProfile(value, { ...selection, mcp: undefined })).toThrow();
    for (const key of Object.keys(profile.mcp)) {
      expect(() => qualifyWorkerInvocationProfile(value, { ...selection, mcp: { ...profile.mcp, [key]: 'changed' } })).toThrow('qualification changed');
    }
  });

  it.each(['claude', 'muse', 'hermes', 'external-control', 'external-permission'])
    ('requires installation qualification for a caller-asserted %s sandbox boundary', provider => {
      const value = adapter();
      value.provider = ['external-control', 'external-permission'].includes(provider) ? 'codex' : provider;
      value.qualification = { status: 'qualified', fixtureDigest: `sha256:${'1'.repeat(64)}`,
        verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:only' };
      const profile = value.invocationProfiles['fixture-shell'];
      for (const control of Object.values(profile.controls) as any[]) control.support = 'native';
      if (provider === 'external-control') profile.controls.sandbox.support = 'external';
      const selection = { profile: 'fixture-shell', transport: 'shell' as const, cliVersion: '1.2.3',
        permissions: { sandbox: provider === 'external-permission' ? 'external' as const : 'workspace-write' as const },
        boundary: { kind: 'os' as const, identity: 'caller-asserted', digest: `sha256:${'1'.repeat(64)}`, controls: ['sandbox'] } };
      expect(() => qualifyWorkerInvocationProfile(value, selection)).toThrow(/sandbox.*installation qualification/i);
    });
});

describe('coordinated shared vocabulary amendments (#2991/#2998)', () => {
  it('reports the version-pattern compile error at registry load', () => {
    const value = registry();
    value.workerAdapters.fixture.invocation.versionPattern = '^(a*)$';
    expect(() => parseProviderModelCapabilities(value)).toThrow('Unsafe worker version pattern');
  });
  it('freezes all four stdin kinds, including installed adapter frames', () => {
    expect(schemas.capability.$defs.process.properties.stdin.enum).toEqual(['closed', 'brief-json', 'brief-text', 'adapter-frame']);
  });
  it.each(['(a+)+', '^((a))$', '^(a|aa){1,100}$', '^(a*)$', '^(a)\\1$', '^([a-z]{1,999})$', '^([a-z]{1,10})(?=x)$', '^([0-9]{1,10})['])
    ('rejects unsafe or invalid version pattern %s at registry load', versionPattern => {
      const value = registry();
      value.workerAdapters.fixture.invocation.versionPattern = versionPattern;
      expect(() => parseProviderModelCapabilities(value)).toThrow();
    });
});
