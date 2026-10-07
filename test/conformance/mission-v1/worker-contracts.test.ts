import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeMission, encodeMission } from '../../../src/mission-protocol/index.js';
import { resolveParallelism } from '../../../src/config/aiwg-config.js';
import { validateUserProjectModelConfig } from '../../../src/models/provider-policy.js';
import { fixtureJson, fixtureRoot, materialize, readJson, validators, type ContractVector } from './worker-contract-fixtures.js';

const { draft07, draft2020, schemas } = validators();
const vectors: ContractVector[] = fixtureJson('mission-vectors.json');

describe('B-OG-01 frozen Mission definitions (T-OG-08/14/15/17)', () => {
  it.each(vectors)('$pack $id: shape validity=$valid', vector => {
    const value = materialize(vector, vectors);
    const validate = draft2020.compile({ $ref: `${schemas.mission.$id}#/$defs/${vector.definition}` });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(vector.valid);
    if (vector.errorKeyword) expect(validate.errors?.some(error => error.keyword === vector.errorKeyword)).toBe(true);
  });

  it('retains owner IDs/dialects and freezes source digests without reading the proposal at test time', () => {
    const manifest = fixtureJson('manifest.json');
    for (const fragment of manifest.fragments) {
      const bytes = readFileSync(path.join(fixtureRoot, fragment.file));
      expect(createHash('sha256').update(bytes).digest('hex'), fragment.file).toBe(fragment.sha256);
      const owner = readJson(fragment.owner);
      expect(Object.values(schemas).some(schema => schema.$id === owner.$id)).toBe(true);
    }
    expect(schemas.mission.$id).toBe('https://aiwg.io/schemas/mission.aiwg.io/v1');
    expect(schemas.config.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schemas.mission.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('every existing consumer and shared producer has an owning draft, source owner and versioned definition', () => {
    const inventory = fixtureJson('consumer-inventory.json');
    const existing = readJson(inventory.existingInventory);
    expect(new Set(inventory.consumers.map((c: any) => c.id)).size).toBe(inventory.consumers.length);
    for (const consumer of existing.consumers) expect(inventory.consumers.find((c: any) => c.id === consumer.id)?.path).toBe(consumer.inventoryMatch);
    for (const consumer of inventory.consumers) {
      expect(existsSync(consumer.path), consumer.id).toBe(true);
      expect(consumer.owner, consumer.id).toMatch(/B-OG-\d+/);
      expect(consumer.checkpoint.length).toBeGreaterThan(0);
      for (const definition of consumer.definitions) expect(schemas.mission.$defs[definition], consumer.id).toBeDefined();
      expect(consumer.advertisedWorkerSupport).toBe(false);
    }
  });

  it('validates a dispatch extension while keeping unrelated vendor extensions open', () => {
    const legacy = fixtureJson('legacy-vectors.json').find((v: any) => v.owner === 'mission').value;
    const record = { ...legacy, extensions: { ...legacy.extensions, 'aiwg.worker-dispatch': materialize(vectors.find(v => v.id === 'dispatch-roundtrip')!, vectors) } };
    const validate = draft2020.getSchema(schemas.mission.$id)!;
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    record.extensions['aiwg.worker-dispatch'].requiredFeatures.push('worker.future.v2');
    expect(validate(record)).toBe(false);
  });

  it.each(vectors.filter(v => v.valid && v.definition === 'workerDispatch'))('canonical codec preserves $id without advertising managed support', vector => {
    const legacy = fixtureJson('legacy-vectors.json').find((v: any) => v.owner === 'mission').value;
    const record = { ...legacy, extensions: { ...legacy.extensions, 'aiwg.worker-dispatch': materialize(vector, vectors) } };
    const roundtrip = decodeMission(encodeMission(record, 'canonical').value, 'canonical');
    expect(roundtrip.value).toEqual(record);
    expect(roundtrip.lossReport).toEqual([]);
    expect(createHash('sha256').update(JSON.stringify(roundtrip.value)).digest('hex'))
      .toBe(createHash('sha256').update(JSON.stringify(record)).digest('hex'));
  });

  it('resolves the same Mission brief/result references offline from Flow value schemas in both dialects', () => {
    const inputRef = `${schemas.mission.$id}#/$defs/workerDirectBrief`;
    const outputRef = `${schemas.mission.$id}#/$defs/workerDirectResult`;
    // Draft-07 graphs carry a 2020-12 value reference as data. Dispatching
    // validation to the referenced owner's validator avoids mixing dialects.
    const graph = readJson('agentic/code/addons/composition-engine/schemas/flow-graph.schema.json');
    draft07.addSchema(graph);
    const input = { name: 'brief', schema: { $ref: inputRef }, value: materialize(vectors.find(v => v.id === 'direct-brief-no-lease')!, vectors) };
    const output = { name: 'result', schema: { $ref: outputRef } };
    for (const [binding, definition] of [[input, 'inputBinding'], [output, 'outputBinding']] as const) {
      const validateBinding = draft07.compile({ $ref: `${graph.$id}#/definitions/${definition}` });
      expect(validateBinding(binding), JSON.stringify(validateBinding.errors)).toBe(true);
    }
    for (const [schema, id] of [[input.schema, 'direct-brief-no-lease'], [output.schema, 'direct-accepted-no-receipt']] as const) {
      const validate = draft2020.compile(schema);
      expect(validate(materialize(vectors.find(v => v.id === id)!, vectors)), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ version: 1 })).toBe(false);
    }
    expect(graph.$id).toBe('https://aiwg.io/schemas/flow/graph/v1alpha1/flow-graph.schema.json');
  });
});

describe('legacy and shared schema compatibility (T-OG-01/14)', () => {
  it.each(fixtureJson('legacy-vectors.json'))('$id still validates against its existing owner', vector => {
    const original = readJson(vector.owner === 'config' ? 'vscode-extension/schemas/aiwg.config.v1.json' : `schemas/${vector.owner === 'mission' ? 'mission-v1.schema.json' : 'models/model-config-compatibility.v1.schema.json'}`);
    const engine = vector.owner === 'config' ? draft07 : draft2020;
    const legacyId = `${original.$id}/fixture-legacy`;
    const validateOriginal = engine.getSchema(legacyId) ?? engine.compile({ ...original, $id: legacyId });
    expect(validateOriginal(vector.value), JSON.stringify(validateOriginal.errors)).toBe(vector.valid);
    const validatePatched = engine.getSchema(schemas[vector.owner].$id)!;
    expect(validatePatched(vector.value), JSON.stringify(validatePatched.errors)).toBe(vector.valid);
    if (vector.owner === 'models') expect(validateUserProjectModelConfig(vector.value).valid).toBe(vector.valid);
    if (vector.owner === 'config') expect(resolveParallelism(vector.value.parallelism, 'claude')).toMatchObject(vector.value.parallelism);
  });

  it.each(fixtureJson('shared-vectors.json'))('$pack $id: shape validity=$valid', vector => {
    const validate = vector.owner === 'adapter' || vector.owner === 'observation'
      ? draft2020.compile({ $ref: vector.owner === 'adapter' ? `${schemas.capability.$id}#/$defs/workerAdapter` : `${schemas.catalog.$id}#/$defs/workerObservation` })
      : (vector.owner === 'config' ? draft07 : draft2020).getSchema(schemas[vector.owner].$id)!;
    expect(validate(vector.value), JSON.stringify(validate.errors)).toBe(vector.valid);
  });

  it('keeps the current capability registry annotation and catalog under the closed owner', () => {
    const registry = readJson('agentic/code/providers/model-capabilities.v1.json');
    const validate = draft2020.getSchema(schemas.capability.$id)!;
    expect(validate(registry), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...registry, $schema: 'https://untrusted.invalid/new-schema' })).toBe(false);
    expect(validate({ ...registry, unexpectedRoot: {} })).toBe(false);
    const validateCatalog = draft2020.getSchema(schemas.catalog.$id)!;
    const { $schema: annotation, ...catalogPayload } = readJson('agentic/code/providers/model-catalog.v1.json');
    // The existing catalog owner does not declare its checked-in editor
    // annotation. Freeze that known discrepancy for B-OG-29, rather than open
    // the closed schema or silently claim the complete annotated file passes.
    expect(annotation).toBe('../../../schemas/models/model-catalog.v1.schema.json');
    expect(validateCatalog(catalogPayload), JSON.stringify(validateCatalog.errors)).toBe(true);
  });
});

describe('frozen consumer negotiation oracle (T-OG-14; runtime owned by #2879)', () => {
  it.each(fixtureJson('negotiation-vectors.json'))('$id => $expected before any task transmission', vector => {
    const { consumer } = vector;
    const knownFeatures = [...schemas.mission.$defs.workerDispatch.properties.requiredFeatures.items.enum, 'worker-flow-values.v1'];
    const supported = consumer.revision === 1 && consumer.bundleDigest === vector.bundleDigest && consumer.lossless === true && Array.isArray(consumer.features)
      && vector.requiredFeatures.every((feature: string) => knownFeatures.includes(feature) && consumer.features.includes(feature));
    expect(supported ? 'supported' : 'OG_CONTRACT_UNSUPPORTED').toBe(vector.expected);
  });
});
