import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { WORKER_DEFINITIONS, decodeWorkerPayload, encodeWorkerPayload } from '../../../src/mission-protocol/index.js';
import { fixtureJson, materialize, type ContractVector } from './worker-contract-fixtures.js';

const original: ContractVector[] = fixtureJson('mission-vectors.json');
const additions: ContractVector[] = fixtureJson('delegation-vectors.json');
const schema = JSON.parse(readFileSync('schemas/mission-v1.schema.json', 'utf8'));
const ajv = addFormats(new Ajv2020({ strict: true, strictRequired: false, allErrors: true }));
ajv.addSchema(schema);

describe('T-OG-01/04/14 Mission delegation contract (#3167)', () => {
  it('compiles every worker definition with strict keywords and types', () => {
    for (const definition of WORKER_DEFINITIONS) expect(() => ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` })).not.toThrow();
  });
  it.each(additions)('$id schema validity=$valid', vector => {
    const base = original.find(candidate => candidate.id === vector.base)!;
    const value = materialize(vector, [...original, ...additions]);
    const definition = base.definition as typeof WORKER_DEFINITIONS[number];
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(vector.valid);
    if (vector.valid) expect(decodeWorkerPayload(definition, encodeWorkerPayload(definition, value))).toEqual(value);
  });
  it.each([
    ['workerVerification/$defs/finding', { id: 'f', class: 'D', severity: 'major', round: 1, status: 'open', summary: 'x' }],
    ['workerVerification/$defs/finding', { id: 'f', class: 'A', severity: 'major', round: 0, status: 'open', summary: 'x' }],
    ['workerVerification/$defs/finding', { id: 'f', class: 'A', severity: 'major', round: 1, status: 'out-of-scope', summary: 'x' }],
    ['workerVerification/$defs/reviewRound', { round: 1, headSha: 'not-a-sha', reviewerObservationRef: 'fixture:reviewer', artifact: { ref: 'x', digest: `sha256:${'a'.repeat(64)}` } }],
  ])('rejects malformed %s', (definition, value) => {
    expect(ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` })(value)).toBe(false);
  });
});
