import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  qualifyWorkerInvocationProfile, WorkerAdapterSchema, type WorkerAdapterMetadata,
  assertWorkerHealthQualification, workerHealthScopeDigest, workerModelKey,
  type WorkerProfileHealth, type WorkerHealthQualificationScope,
} from '../../../src/models/provider-policy.js';
import { fixtureJson, readJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';

function adapter(): WorkerAdapterMetadata {
  const value = structuredClone(fixtureJson('shared-vectors.json')
    .find((vector: any) => vector.id === 'adapter-process-shape').value);
  value.qualification = {
    status: 'qualified', fixtureDigest: `sha256:${'a'.repeat(64)}`,
    verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only',
  };
  for (const control of Object.values(value.invocationProfiles!['fixture-shell'].controls)) control.support = 'native';
  return value;
}
const selection = { profile: 'fixture-shell', transport: 'shell' as const, cliVersion: '1.2.3' };
const evidence = {
  scopeDigest: `sha256:${'a'.repeat(64)}`, fixtureDigest: `sha256:${'b'.repeat(64)}`,
  verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:installation-only',
};

describe('S1 installation metadata and required control guards (T-OG-03/10/14)', () => {
  it('compiles the production owner strictly and preserves scoped qualification losslessly', () => {
    const schema = readJson('schemas/models/provider-model-capabilities.v1.schema.json');
    const ajv = addFormats(new Ajv2020({ strict: true }));
    ajv.addSchema(schema);
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/workerAdapter` });
    const value = adapter();
    value.invocationProfiles!['fixture-shell'].installationQualification = evidence;
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(WorkerAdapterSchema.parse(value)).toEqual(value);
  });

  it.each([
    { scopeDigest: 'wrong' }, { fixtureDigest: 'wrong' }, { verifiedAt: 'not-a-date' },
    { evidenceRef: '' }, { unexpected: true },
    { scopeDigest: undefined }, { fixtureDigest: undefined },
    { verifiedAt: undefined }, { evidenceRef: undefined },
  ])('rejects malformed scoped qualification %j', patch => {
    const value = adapter();
    value.invocationProfiles!['fixture-shell'].installationQualification = { ...evidence, ...patch } as any;
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['children', 'nestedAgentsControllable'], ['fallback', 'nativeFallbackControllable'],
  ] as const)('requires adapter enforcement for the %s control', (control, capability) => {
    const value = adapter();
    value.invocationProfiles!['fixture-shell'].controls[control] = {
      support: 'external', mapping: 'fixture:enforcing-boundary', evidence: 'fixture:negative-tested',
    };
    value.capabilities[capability] = false;
    expect(() => qualifyWorkerInvocationProfile(value, { ...selection, requiredControls: [control] }))
      .toThrow(`Required worker control is unqualified: ${control}`);
    // Missing policy cannot waive controls through omission.
    expect(() => qualifyWorkerInvocationProfile(value, selection)).toThrow(`Required worker control is unqualified: ${control}`);
    value.capabilities[capability] = true;
    expect(qualifyWorkerInvocationProfile(value, { ...selection, requiredControls: [control] }))
      .toEqual(value.invocationProfiles!['fixture-shell']);
    value.invocationProfiles!['fixture-shell'].controls[control].support = 'unqualified';
    expect(() => qualifyWorkerInvocationProfile(value, { ...selection, requiredControls: [control] }))
      .toThrow(`Required worker control is unqualified: ${control}`);
  });
});

function healthProfile() {
  const value = adapter();
  const profile = value.invocationProfiles!['fixture-shell'];
  const scope: WorkerHealthQualificationScope = { profileRef: 'fixture-shell', cliVersion: '1.2.3',
    accountScope: 'synthetic-account', inferenceProvider: 'synthetic', model: 'synthetic/model', effort: 'high' };
  const health: WorkerProfileHealth = { version: 1, handshake: 'semantic', outputFraming: 'jsonl',
    signalParser: 'provider-fixture-health-v1', sessionLogLocator: null,
    progressEvidence: ['distinct completed item'], stopEvidence: 'owned observed exit',
    fixtureRef: 'fixture:synthetic-health', qualifiedAt: '2026-10-08T00:00:00Z',
    statusOperation: null, cancelOperation: null, coverage: 'full', qualificationTarget: 'semantic',
    evidenceGrades: ['R'], qualificationOwner: 'B-OG-50',
    provenance: [{ kind: 'synthetic', ref: 'fixture:synthetic-only', observedAt: '2026-10-08T00:00:00Z', cliVersion: null }],
    qualification: { status: 'synthetic', scopeDigest: null, cliVersion: scope.cliVersion,
      accountScope: scope.accountScope, profileRef: scope.profileRef,
      modelKey: workerModelKey(scope.inferenceProvider, scope.model), effort: scope.effort, authorizedLive: false } };
  profile.health = health;
  health.qualification!.scopeDigest = workerHealthScopeDigest(profile, scope);
  return { value, profile, health, scope };
}

describe('S1 scoped health evidence metadata (T-OG-19/23)', () => {
  it('preserves typed health evidence under the strict existing schema', () => {
    const { value, profile, scope } = healthProfile();
    const schema = readJson('schemas/models/provider-model-capabilities.v1.schema.json');
    const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));
    ajv.addSchema(schema);
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/workerAdapter` });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(WorkerAdapterSchema.parse(value)).toEqual(value);
    expect(() => assertWorkerHealthQualification(profile, scope)).not.toThrow();
    expect(profile.health!.qualification!.status).toBe('synthetic');
  });

  it.each(['cliVersion', 'accountScope', 'profileRef', 'model', 'inferenceProvider', 'effort'] as const)
    ('invalidates health evidence after %s changes', field => {
      const { profile, scope } = healthProfile();
      expect(() => assertWorkerHealthQualification(profile, { ...scope, [field]: 'synthetic-changed' })).toThrow('scope changed');
    });

  it.each(['parser', 'framing', 'locator', 'controls'] as const)('invalidates %s profile drift', field => {
    const { profile, scope } = healthProfile();
    if (field === 'parser') profile.health!.signalParser = 'provider-other-health-v1';
    if (field === 'framing') profile.health!.outputFraming = 'plain';
    if (field === 'locator') profile.health!.sessionLogLocator = 'other-locator';
    if (field === 'controls') profile.controls.model.mapping = 'changed';
    expect(() => assertWorkerHealthQualification(profile, scope)).toThrow('scope changed');
  });

  it('does not upgrade synthetic qualification into separately authorized live evidence', () => {
    const { value, profile, health, scope } = healthProfile();
    health.qualification!.status = 'live-qualified';
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(false);
    expect(() => assertWorkerHealthQualification(profile, scope)).toThrow('live authorization');
    health.qualification!.authorizedLive = true;
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(true);
    expect(() => assertWorkerHealthQualification(profile, scope)).not.toThrow();
  });

  it('requires a dated scoped observation before asserting qualified health', () => {
    const { value, profile, health, scope } = healthProfile();
    health.qualifiedAt = null;
    health.qualification!.scopeDigest = workerHealthScopeDigest(profile, scope);
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(false);
    expect(() => assertWorkerHealthQualification(profile, scope)).toThrow('scope changed');
  });

  it('supports explicit unavailable and older profile health without inventing qualification', () => {
    const { value, profile, health, scope } = healthProfile();
    health.handshake = 'process-only'; health.coverage = 'degraded'; health.qualifiedAt = null;
    health.qualification = { status: 'unqualified', scopeDigest: null, cliVersion: null,
      accountScope: null, profileRef: null, modelKey: null, effort: null, authorizedLive: false };
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(true);
    expect(() => assertWorkerHealthQualification(profile, scope)).not.toThrow();
    health.coverage = 'full';
    expect(() => assertWorkerHealthQualification(profile, scope)).toThrow('Unqualified worker health');
    delete profile.health;
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(true);
    expect(() => assertWorkerHealthQualification(profile, scope)).not.toThrow();
  });

  it.each([
    ['coverage', 'guessed'], ['qualificationOwner', 'unowned'], ['evidenceGrades', ['Z']],
    ['provenance', [{ kind: 'worker-output', ref: 'forged', observedAt: '2026-10-08T00:00:00Z', cliVersion: null }]],
    ['unexpected', true], ['qualifiedAt', 'not-a-date'],
  ])('rejects malformed health field %s', (field, patch) => {
    const { value, health } = healthProfile();
    (health as any)[field] = patch;
    expect(WorkerAdapterSchema.safeParse(value).success).toBe(false);
  });
});
