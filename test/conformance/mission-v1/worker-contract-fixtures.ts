import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const fixtureRoot = path.resolve('test/conformance/mission-v1/fixtures/worker-contracts');
export function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function fixtureJson(file: string): any {
  return readJson(path.join(fixtureRoot, file));
}

// Test-only application of the frozen patches to their existing owners. No new
// schema ID, production capability advertisement, loader, or managed service.
export function contractSchemas(): Record<string, any> {
  const config = readJson('vscode-extension/schemas/aiwg.config.v1.json');
  const parallelism = fixtureJson('parallelism.fragment.json');
  const { definitions, $schema: _configDialect, ...parallelismBody } = parallelism;
  config.properties.parallelism = parallelismBody;
  config.definitions = { ...config.definitions, ...definitions };

  const models = readJson('schemas/models/model-config-compatibility.v1.schema.json');
  const { $defs: modelDefs, $schema: _modelDialect, ...selection } = fixtureJson('worker-selection.fragment.json');
  models.properties.defaults.properties.workerSelection = selection;
  models.$defs = { ...models.$defs, ...modelDefs };

  const capability = readJson('schemas/models/provider-model-capabilities.v1.schema.json');
  const { $defs: adapterDefs, $schema: _adapterDialect, ...adapter } = fixtureJson('worker-adapter.fragment.json');
  Object.assign(capability.properties, fixtureJson('capability-root.patch.json').properties);
  capability.properties.providers.additionalProperties.properties.workerAdapter = { $ref: '#/$defs/workerAdapter' };
  capability.$defs = { ...capability.$defs, ...adapterDefs, workerAdapter: adapter };

  const mission = readJson('schemas/mission-v1.schema.json');
  Object.assign(mission.$defs, fixtureJson('mission-definitions.patch.json').$defs);
  mission.$defs.extensions.properties = { 'aiwg.worker-dispatch': { $ref: '#/$defs/workerDispatch' } };

  const catalog = readJson('schemas/models/model-catalog.v1.schema.json');
  const { $schema: _observationDialect, ...observation } = fixtureJson('worker-observation.fragment.json');
  catalog.$defs.workerObservation = observation;
  return { config, models, capability, mission, catalog };
}

export function validators() {
  // Match each owner's dialect; formats are checked offline, including dates.
  const draft07 = addFormats(new Ajv({ strict: false, allErrors: true }));
  const draft2020 = addFormats(new Ajv2020({ strict: false, allErrors: true }));
  const schemas = contractSchemas();
  draft07.addSchema(schemas.config);
  for (const key of ['models', 'capability', 'mission', 'catalog']) draft2020.addSchema(schemas[key]);
  return { draft07, draft2020, schemas };
}

export interface ContractVector {
  id: string;
  definition: string;
  value?: any;
  base?: string;
  patch?: Array<{ op: 'add' | 'replace' | 'remove'; path: string; value?: any }>;
  valid: boolean;
  pack: string;
  errorKeyword?: string;
}

// Small fixture materializer for the RFC 6902 operations used by this corpus.
// Keep negative values as deltas so positive siblings remain easy to review.
export function materialize(vector: ContractVector, vectors: ContractVector[]): any {
  if (!vector.base) return structuredClone(vector.value);
  const base = vectors.find(item => item.id === vector.base);
  if (!base) throw new Error(`Missing vector base: ${vector.base}`);
  const value = materialize(base, vectors);
  for (const patch of vector.patch ?? []) {
    const parts = patch.path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const key = parts.pop()!;
    const parent = parts.reduce((node, part) => node[part], value);
    if (patch.op === 'remove') delete parent[key];
    else if (Array.isArray(parent) && key === '-') parent.push(structuredClone(patch.value));
    else parent[key] = structuredClone(patch.value);
  }
  return value;
}
