import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKER_BASELINE_FEATURES,
  WORKER_MAX_JSON_BYTES,
  decodeMission,
  decodeWorkerPayload,
  encodeMission,
  encodeWorkerPayload,
  encodeWorkerPayloadSnapshot,
  validateWorkerPayload,
  workerDefinitionBundleDigest,
  type CanonicalMission,
  type MissionTarget,
  type WorkerDefinitionName,
} from '../../../src/mission-protocol/index.js';
import { fixtureJson, materialize, validators, type ContractVector } from '../../conformance/mission-v1/worker-contract-fixtures.js';

const vectors: ContractVector[] = fixtureJson('mission-vectors.json');
const fixture = (id: string) => materialize(vectors.find(vector => vector.id === id)!, vectors);
const mission = (): CanonicalMission => fixtureJson('legacy-vectors.json').find((vector: any) => vector.owner === 'mission').value;
const nativeTargets: MissionTarget[] = ['mission-plan', 'mission-ledger', 'mission-control-session', 'executor-v1', 'fleet-workload-v1', 'a2a', 'uhp-2026-08-11', 'graph-flow-v1', 'cockpit', 'activity-v1'];

// Enumerate carriers from the actual schema, so another use of the shared
// extensions definition must be covered before the codec advertises support.
function extensionCarriers(schema: any, path = ''): string[] {
  if (schema.$ref === '#/$defs/extensions') return [path];
  return [
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => extensionCarriers(child, `${path}/${key}`)),
    ...(schema.items ? extensionCarriers(schema.items, `${path}/*`) : []),
  ];
}
const carriers = extensionCarriers(validators().schemas.mission);
function boundMission(carrier: string, dispatch: any): CanonicalMission {
  const record = mission();
  let cursor: any = record;
  const tokens = carrier.slice(1).split('/');
  for (const token of tokens.slice(0, -1)) {
    if (token === '*') {
      cursor[0] = { id: 'synthetic-artifact', kind: 'other' };
      cursor = cursor[0];
    } else cursor = cursor[token];
  }
  cursor[tokens.at(-1)!] = { 'aiwg.worker-dispatch': dispatch };
  return record;
}

describe('existing Mission worker consumer boundaries', () => {
  it('enumerates every schema-defined extension carrier', () => {
    expect(carriers).toEqual(['/status/artifacts/*/extensions', '/extensions']);
  });

  describe.each(carriers)('%s schema carrier', carrier => {
    it.each([
      ['unsupported revision', { version: 999 }],
      ['unknown required feature', { requiredFeatures: [...WORKER_BASELINE_FEATURES, 'worker.future.v999'] }],
    ])('blocks %s through canonical encode/decode and all native projections, including A2A', (_reason, delta) => {
      const record = boundMission(carrier, { ...fixture('dispatch-roundtrip'), ...delta });
      const clone = vi.spyOn(globalThis, 'structuredClone');
      expect(() => encodeMission(record, 'canonical')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
      expect(() => decodeMission(record, 'canonical')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
      for (const target of nativeTargets) expect(() => encodeMission(record, target, { allowLoss: true })).toThrow(/OG_CONTRACT_UNSUPPORTED/);
      expect(clone).not.toHaveBeenCalled();
    });

    it.each(['dispatch-roundtrip', 'dispatch-health-feature'])('negotiates and preserves valid %s bytes', id => {
      const record = boundMission(carrier, fixture(id));
      const roundtrip = decodeMission(encodeMission(record, 'canonical').value, 'canonical').value;
      expect(roundtrip).toEqual(record);
      expect(JSON.stringify(roundtrip)).toBe(JSON.stringify(record));
    });

    it('validates closed dispatch shapes before cloning', () => {
      const record = boundMission(carrier, { ...fixture('dispatch-roundtrip'), workerSuppliedAuthority: true });
      expect(() => encodeMission(record, 'canonical')).toThrow(/Invalid workerDispatch/);
      expect(() => decodeMission(record, 'canonical')).toThrow(/Invalid workerDispatch/);
    });
  });

  it('preserves ordinary output and vendor data containing worker-like keys', () => {
    const record = mission();
    const data = { properties: { 'aiwg.worker-dispatch': { type: 'string' } }, extensions: { 'aiwg.worker-dispatch': { type: 'string' } } };
    record.status.partialOutput = data;
    record.extensions = { 'vendor.synthetic': data };
    expect(decodeMission(encodeMission(record, 'canonical').value, 'canonical').value).toEqual(record);
    expect(() => encodeMission(record, 'a2a', { allowLoss: true })).not.toThrow();
  });

  it.each([
    ['unsupported revision', { version: 999 }],
    ['unknown required feature', { requiredFeatures: [...WORKER_BASELINE_FEATURES, 'worker.future.v999'] }],
  ])('blocks %s inside encodeMission and decodeMission before clone', (_reason, delta) => {
    const record = mission();
    record.extensions = { 'aiwg.worker-dispatch': { ...fixture('dispatch-roundtrip'), ...delta } };
    const clone = vi.spyOn(globalThis, 'structuredClone');
    expect(() => encodeMission(record, 'canonical')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => decodeMission(record, 'canonical')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(clone).not.toHaveBeenCalled();
  });

  it('validates extension shape inside both existing canonical owners', () => {
    const record = mission();
    record.extensions = { 'aiwg.worker-dispatch': { ...fixture('dispatch-roundtrip'), workerSuppliedAuthority: true } };
    expect(() => encodeMission(record, 'canonical')).toThrow(/Invalid workerDispatch/);
    expect(() => decodeMission(record, 'canonical')).toThrow(/Invalid workerDispatch/);
  });

  it.each(nativeTargets)('blocks unqualified %s projection and native decode before payload handling', target => {
    const record = mission();
    const dispatch = fixture('dispatch-roundtrip');
    record.extensions = { 'aiwg.worker-dispatch': dispatch };
    expect(() => encodeMission(record, target, { allowLoss: true })).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    for (const carrier of ['extensions', 'metadata']) {
      expect(() => decodeMission({ id: 'synthetic', goal: 'Synthetic', [carrier]: { 'aiwg.worker-dispatch': dispatch } }, target)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    }
  });

  it('blocks a worker extension inside a preserved native carrier', () => {
    const record = mission();
    record.extensions = { 'aiwg.source.executor-v1': { metadata: { 'aiwg.worker-dispatch': { ...fixture('dispatch-roundtrip'), version: 999 } } } };
    expect(() => encodeMission(record, 'canonical')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => decodeMission(record, 'canonical')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
  });

  it.each(['dispatch-roundtrip', 'dispatch-health-feature'])('canonical owners negotiate and preserve %s with unrelated vendor data', id => {
    const record = mission();
    record.extensions = { ...record.extensions, 'aiwg.worker-dispatch': fixture(id), 'vendor.synthetic': { literal: '雪' } };
    const roundtrip = decodeMission(encodeMission(record, 'canonical').value, 'canonical');
    expect(roundtrip.value).toEqual(record);
    expect(JSON.stringify(roundtrip.value)).toBe(JSON.stringify(record));
  });

  it('cannot weaken dispatch requirements through the optional payload gate', () => {
    const dispatch = { ...fixture('dispatch-roundtrip'), requiredFeatures: [...WORKER_BASELINE_FEATURES, 'worker.future.v999'] };
    const gate = { consumer: { revision: 1, bundleDigest: workerDefinitionBundleDigest(), features: [...WORKER_BASELINE_FEATURES], lossless: true }, requiredFeatures: [] };
    expect(() => encodeWorkerPayload('workerDispatch', dispatch, gate)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => decodeWorkerPayload('workerDispatch', dispatch, gate)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
  });
});

function resultBytes(id: string, totalBytes: number, unicode: boolean) {
  const value = fixture(id);
  value.worker.limitations = Array.from({ length: 32 }, () => 'x');
  let remaining = totalBytes - Buffer.byteLength(JSON.stringify(value), 'utf8');
  for (let index = 0; remaining > 0 && index < 32; index++) {
    const extra = Math.min(8191, remaining);
    value.worker.limitations[index] += unicode ? '雪'.repeat(Math.floor(extra / 3)) + 'x'.repeat(extra % 3) : 'x'.repeat(extra);
    remaining -= extra;
  }
  expect(remaining).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(totalBytes);
  return value;
}

describe('05 §5.1 aggregate bounds before cloning/transmission', () => {
  const { draft2020, schemas } = validators();
  it.each([
    ['workerDirectResult', 'direct-pending', false],
    ['workerDirectResult', 'direct-pending', true],
    ['workerResult', 'assembled-pending', false],
    ['workerResult', 'assembled-pending', true],
  ] as const)('%s unicode=%s accepts the UTF-8 limit and blocks limit+1', (definition, id, unicode) => {
    const limit = resultBytes(id, WORKER_MAX_JSON_BYTES, unicode);
    const over = resultBytes(id, WORKER_MAX_JSON_BYTES + 1, unicode);
    const shape = draft2020.compile({ $ref: `${schemas.mission.$id}#/$defs/${definition}` });
    expect(shape(over), JSON.stringify(shape.errors)).toBe(true); // Each individual field is legal.
    expect(validateWorkerPayload(definition, limit).valid).toBe(true);
    expect(decodeWorkerPayload(definition, encodeWorkerPayload(definition, limit))).toEqual(limit);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    expect(validateWorkerPayload(definition, over)).toEqual({ valid: false, errors: ['Serialized UTF-8 JSON exceeds 262144 bytes'] });
    expect(() => encodeWorkerPayload(definition, over)).toThrow(/262144 bytes/);
    expect(() => decodeWorkerPayload(definition, over)).toThrow(/262144 bytes/);
    expect(clone).not.toHaveBeenCalled();
  });

  it.each([16, 17, 32])('checks resolved MCP invocation nesting depth %s at the production owner', depth => {
    const value = fixture('resolved-mcp');
    let node: Record<string, unknown> = value.mcp.arguments;
    // invocation = 1, mcp = 2, arguments = 3; scalar leaf adds no level.
    for (let level = 3; level < depth; level++) {
      const child = {};
      node.nested = child;
      node = child;
    }
    node.leaf = 'synthetic';
    const shape = draft2020.compile({ $ref: `${schemas.mission.$id}#/$defs/workerResolvedInvocation` });
    expect(shape(value), JSON.stringify(shape.errors)).toBe(true);
    expect(validateWorkerPayload('workerResolvedInvocation', value).valid).toBe(depth <= 16);
    if (depth === 16) expect(decodeWorkerPayload('workerResolvedInvocation', encodeWorkerPayload('workerResolvedInvocation', value))).toEqual(value);
    else {
      const clone = vi.spyOn(globalThis, 'structuredClone');
      expect(() => encodeWorkerPayload('workerResolvedInvocation', value)).toThrow(/nesting depth exceeds 16/);
      expect(() => decodeWorkerPayload('workerResolvedInvocation', value)).toThrow(/nesting depth exceeds 16/);
      expect(clone).not.toHaveBeenCalled();
    }
  });
});

describe('05 §5.1 / 06 §7 immutable pending → accepted snapshots', () => {
  it.each([
    ['workerDirectResult', 'direct-pending', 'direct-accepted-no-receipt'],
    ['workerResult', 'assembled-pending', 'managed-accepted'],
  ] as const)('%s retains pending bytes/digest and links accepted successor without storage', (definition, pendingId, acceptedId) => {
    const original = fixture(pendingId);
    const pendingBytes = JSON.stringify(original);
    const pending = encodeWorkerPayloadSnapshot(definition, original);
    const accepted = encodeWorkerPayloadSnapshot(definition, fixture(acceptedId), pending);
    expect(pending.bytes).toBe(pendingBytes);
    expect(pending.artifact.digest).toBe(`sha256:${createHash('sha256').update(pendingBytes).digest('hex')}`);
    expect(pending.previousRecord).toBeNull();
    expect(accepted.previousRecord).toEqual(pending.artifact);
    expect(accepted.artifact.digest).not.toBe(pending.artifact.digest);
    expect(JSON.parse(pending.bytes).verification.status).toBe('pending');
    expect(JSON.parse(accepted.bytes).verification.status).toBe('accepted');
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.artifact)).toBe(true);
    expect(original).toEqual(fixture(pendingId));
    expect(decodeWorkerPayload(definition, JSON.parse(accepted.bytes))).toEqual(fixture(acceptedId));
  });

  it('links result updates through existing dispatch and canonical Mission owners', () => {
    const pending = encodeWorkerPayloadSnapshot('workerResult', fixture('assembled-pending'));
    const accepted = encodeWorkerPayloadSnapshot('workerResult', fixture('managed-accepted'), pending);
    const dispatch = { ...fixture('dispatch-roundtrip'), result: pending.artifact };
    const prior = encodeWorkerPayloadSnapshot('workerDispatch', dispatch);
    const next = { ...dispatch, result: accepted.artifact, previousRecord: prior.artifact };
    const successor = encodeWorkerPayloadSnapshot('workerDispatch', next, prior);
    const record = mission();
    record.extensions = { 'aiwg.worker-dispatch': JSON.parse(successor.bytes) };
    const roundtrip = decodeMission(encodeMission(record, 'canonical').value, 'canonical').value;
    expect(roundtrip.extensions?.['aiwg.worker-dispatch']).toEqual(next);
    expect(JSON.parse(prior.bytes).result).toEqual(pending.artifact);
    expect(JSON.parse(successor.bytes).previousRecord).toEqual(prior.artifact);
    expect(prior.bytes).toBe(JSON.stringify(dispatch));
    expect(() => encodeWorkerPayloadSnapshot('workerDispatch', { ...next, previousRecord: null }, prior)).toThrow(/must link previousRecord/);
  });

  it('rejects a tampered previous digest and cross-invocation successors', () => {
    const pending = encodeWorkerPayloadSnapshot('workerDirectResult', fixture('direct-pending'));
    expect(() => encodeWorkerPayloadSnapshot('workerDirectResult', fixture('direct-accepted-no-receipt'), { ...pending, bytes: `${pending.bytes} ` })).toThrow(/preserved bytes/);
    expect(() => encodeWorkerPayloadSnapshot('workerDirectResult', { ...fixture('direct-accepted-no-receipt'), invocationId: 'other' }, pending)).toThrow(/changes invocationId/);
    expect(() => encodeWorkerPayloadSnapshot('workerResult' as WorkerDefinitionName, fixture('managed-accepted'), pending)).toThrow(/definition or digest/);
  });
});
