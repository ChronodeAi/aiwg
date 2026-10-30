import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { WORKER_DEFINITIONS, WorkerContractError, assembleWorkerResult, decodeWorkerPayload, encodeWorkerPayload } from '../../../src/mission-protocol/index.js';
import { reviewFinding, reviewHead, workerReviewFixture } from '../../fixtures/worker-review.js';
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
    else for (const codec of [encodeWorkerPayload, decodeWorkerPayload]) {
      expect(() => codec(definition, value)).toThrowError(WorkerContractError);
      expect(() => codec(definition, value)).toThrowError(expect.objectContaining({ code: 'OG_CONTRACT_INVALID' }));
    }
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

describe.each([true, false])('T-OG-04/07/14 runtime review acceptance, direct=%s', direct => {
  it('accepts a clean different-family review bound to the trusted current head', () => {
    const value = workerReviewFixture(direct);
    const result = assembleWorkerResult(value);
    expect(result.definition).toBe(direct ? 'workerDirectResult' : 'workerResult');
    const record = decodeWorkerPayload(result.definition, JSON.parse(result.bytes));
    expect(record.verification).toMatchObject({ status: 'accepted', headSha: reviewHead, roundsToClean: 1, findingsLedger: [] });
    expect(value.verification.headSha).toBeUndefined();
    expect(value.verification.roundsToClean).toBeUndefined();
  });

  const refusals: Array<[string, (value: ReturnType<typeof workerReviewFixture>) => void, RegExp]> = [
    ['stale review head', value => {
      // Internally coherent evidence reaches the trusted-head gate after shape validation.
      value.verification.reviewRounds[0].headSha = 'b'.repeat(40);
      value.verification.headSha = 'b'.repeat(40);
    }, /stale head/],
    ['stale acceptance head', value => { value.verification.headSha = 'b'.repeat(40); }, /final headSha/],
    ['same observed family across different CLIs', value => {
      value.reviewLineage.reviewers[0].family = value.reviewLineage.writer.family;
      value.reviewLineage.reviewers[0].cliId = 'another-cli';
    }, /different observed family/],
    ['missing lineage', value => { delete (value as any).reviewLineage; }, /reviewer lineage/],
    ['missing writer lineage', value => { delete (value.reviewLineage as any).writer; }, /observed source lineage/],
    ['missing reviewer lineage', value => { value.reviewLineage.reviewers = []; }, /reviewer lineage/],
    ['open class A blocker', value => { value.verification.findingsLedger = [reviewFinding('A', 'blocker')]; }, /class A/],
    ['open class A major', value => { value.verification.findingsLedger = [reviewFinding('A', 'major')]; }, /class A/],
  ];
  it.each(refusals)('refuses %s with a typed contract error', (_name, mutate, diagnostic) => {
    const value = workerReviewFixture(direct);
    mutate(value);
    expect(() => assembleWorkerResult(value)).toThrowError(WorkerContractError);
    expect(() => assembleWorkerResult(value)).toThrowError(expect.objectContaining({
      code: 'OG_CONTRACT_INVALID', message: expect.stringMatching(diagnostic),
    }));
  });
});
