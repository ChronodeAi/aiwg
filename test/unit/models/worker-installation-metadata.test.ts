import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  qualifyWorkerInvocationProfile, WorkerAdapterSchema, type WorkerAdapterMetadata,
} from '../../../src/models/provider-policy.js';
import { fixtureJson, readJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';

function adapter(): WorkerAdapterMetadata {
  const value = structuredClone(fixtureJson('shared-vectors.json')
    .find((vector: any) => vector.id === 'adapter-process-shape').value);
  value.qualification = {
    status: 'qualified', fixtureDigest: `sha256:${'a'.repeat(64)}`,
    verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only',
  };
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
    // A task that does not require the control preserves the existing contract.
    expect(qualifyWorkerInvocationProfile(value, selection)).toEqual(value.invocationProfiles!['fixture-shell']);
    value.capabilities[capability] = true;
    expect(qualifyWorkerInvocationProfile(value, { ...selection, requiredControls: [control] }))
      .toEqual(value.invocationProfiles!['fixture-shell']);
    value.invocationProfiles!['fixture-shell'].controls[control].support = 'unqualified';
    expect(() => qualifyWorkerInvocationProfile(value, { ...selection, requiredControls: [control] }))
      .toThrow(`Required worker control is unqualified: ${control}`);
  });
});
