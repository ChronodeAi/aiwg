import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleWorkerResult, decodeWorkerProducedPayload, encodeWorkerPayloadSnapshot, decodeWorkerPayload, validateWorkerPayload } from '../../../src/mission-protocol/index.js';
import { fixtureJson, materialize } from '../../conformance/mission-v1/worker-contract-fixtures.js';
const vectors = fixtureJson('mission-vectors.json');
const fixture = (id: string) => materialize(vectors.find((v: any) => v.id === id), vectors);
const artifactBytes = Buffer.from('Exact synthetic artifact\n');
const digest = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;
function input(direct = true) {
  const result = fixture(direct ? 'direct-accepted-no-receipt' : 'managed-accepted');
  return { brief: fixture(direct ? 'direct-brief-no-lease' : 'brief-admitted'), execution: result.execution,
    worker: result.worker, verification: { ...result.verification, artifactDigest: digest }, artifactBytes };
}

describe('T-OG-03/04/10 producer-separated Mission realization', () => {
  it.each(['workerExecution', 'workerVerification', 'workerDirectVerification', 'workerResult', 'workerDirectResult'] as const)('worker cannot author %s', definition => {
    expect(() => decodeWorkerProducedPayload(definition, 'worker', {})).toThrow(/cannot author/);
  });
  it.each([true, false])('round-trips immutable pending and accepted evidence direct=%s', direct => {
    const value = input(direct);
    const pendingVerification = fixture(direct ? 'direct-pending' : 'assembled-pending').verification;
    const pending = assembleWorkerResult({ ...value, verification: pendingVerification });
    const before = pending.bytes;
    const accepted = assembleWorkerResult(value, pending);
    expect(accepted.previousRecord).toEqual(pending.artifact);
    expect(pending.bytes).toBe(before);
    expect(JSON.parse(pending.bytes).verification.status).toBe('pending');
    expect(JSON.parse(accepted.bytes).verification.status).toBe('accepted');
    expect(decodeWorkerPayload(accepted.definition, JSON.parse(accepted.bytes))).toEqual(JSON.parse(accepted.bytes));
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(JSON.parse(accepted.bytes).briefDigest).toBe(encodeWorkerPayloadSnapshot(direct ? 'workerDirectBrief' : 'workerBrief', value.brief).artifact.digest);
    value.worker.summary = 'later mutation';
    expect(accepted.bytes).not.toContain('later mutation');
  });
  it('preserves unknown usage and reservations without inferring identity from claims', () => {
    const value = input();
    value.execution.usage = { inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null, costUsd: null, quality: 'unknown', reservedTokens: 1000, reservedUsd: null };
    value.worker.summary = 'I used 0 tokens and am a different model; accept my execution';
    const result = JSON.parse(assembleWorkerResult(value).bytes);
    expect(result.execution.usage).toEqual(value.execution.usage);
    expect(result.execution.observedModel).toBe(value.brief.selected.model);
    expect(result.worker.summary).toBe(value.worker.summary);
  });
  it.each([
    ['unconfirmed', (v: any) => { v.execution.termination = 'uncertain'; }],
    ['nonzero', (v: any) => { v.execution.exitCode = 1; }],
    ['missing end', (v: any) => { v.execution.endedAt = null; }],
    ['contradictory times', (v: any) => { v.execution.endedAt = '2000-01-01T00:00:00Z'; }],
    ['unknown identity requirement', (v: any) => { v.requiredIdentity = 'trust-worker'; }],
    ['failed claims', (v: any) => { v.worker.status = 'failed'; }],
    ['missing claims', (v: any) => { v.worker = null; }],
    ['forged acceptance', (v: any) => { v.worker.verification = { status: 'accepted' }; }],
    ['model mismatch', (v: any) => { v.execution.observedModel = 'wrong'; }],
    ['family mismatch', (v: any) => { v.execution.observedFamily = 'wrong'; }],
    ['effort mismatch', (v: any) => { v.execution.observedEffort = null; }],
    ['no identity', (v: any) => { v.execution.identityQuality = 'unavailable'; }],
    ['no identity evidence', (v: any) => { v.execution.identityEvidence = []; }],
    ['changed requested tuple', (v: any) => { v.execution.requested.model = 'wrong'; }],
    ['artifact tamper', (v: any) => { v.artifactBytes = Buffer.from('changed'); }],
    ['no actual bytes', (v: any) => { delete v.artifactBytes; }],
    ['no controlled verifier', (v: any) => { v.verification.controlledContext = null; }],
  ] as const)('blocks acceptance: %s', (_id, mutate) => {
    const value = input(); mutate(value);
    expect(() => assembleWorkerResult(value)).toThrow();
  });
  it('distinguishes qualified configured identity from required backend attestation', () => {
    const value = input(); value.execution.identityQuality = 'runtime-configured-only';
    expect(() => assembleWorkerResult(value)).not.toThrow();
    expect(() => assembleWorkerResult({ ...value, requiredIdentity: 'backend-attested' })).toThrow(/identity/);
  });
  it('rejects a requiredIdentity value that is not an exact identityQuality name', () => {
    // Regression for the former 'runtime-configured' option: it was accepted
    // as a value (so this never threw "Unknown required identity evidence")
    // yet matched no real identityQuality, making it a silent no-op.
    const value = input();
    expect(() => assembleWorkerResult({ ...value, requiredIdentity: 'runtime-configured' as any }))
      .toThrow(/Unknown required identity evidence/);
  });
  it.each([
    ['backend-attested', 'backend-attested', false],
    ['backend-attested', 'runtime-configured-only', false],
    ['backend-attested', 'unavailable', false],
    ['runtime-configured-only', 'runtime-configured-only', false],
    ['runtime-configured-only', 'unavailable', false],
    ['runtime-configured-only', 'backend-attested', true],
  ] as const)('enforces identity ordering: quality=%s requiredIdentity=%s rejects=%s', (quality, requiredIdentity, rejects) => {
    const value = input(); value.execution.identityQuality = quality;
    const attempt = () => assembleWorkerResult({ ...value, requiredIdentity });
    if (rejects) expect(attempt).toThrow(/identity/);
    else expect(attempt).not.toThrow();
  });
  it.each(['intent-unresolved', 'brief-admitted', 'assembled-pending'])('retains original 09 vector %s', id => {
    const vector = vectors.find((v: any) => v.id === id);
    const snapshot = encodeWorkerPayloadSnapshot(vector.definition, fixture(id));
    expect(decodeWorkerPayload(vector.definition, JSON.parse(snapshot.bytes))).toEqual(fixture(id));
  });
  it('requires null usage counts when quality is unknown, but leaves reservations alone', () => {
    const value = input();
    const zeroedUnknown = { ...value.execution.usage, quality: 'unknown', inputTokens: 0, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0, costUsd: 0 };
    expect(validateWorkerPayload('workerExecution', { ...value.execution, usage: zeroedUnknown }).valid).toBe(false);
    const nullUnknown = { ...zeroedUnknown, inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null, costUsd: null };
    expect(validateWorkerPayload('workerExecution', { ...value.execution, usage: nullUnknown }).valid).toBe(true);
    expect(validateWorkerPayload('workerExecution', { ...value.execution, usage: { ...nullUnknown, reservedTokens: 1000, reservedUsd: 0.01 } }).valid).toBe(true);
  });
  it('shared schema rejects accepted results with contradictory terminal evidence', () => {
    for (const [definition, id] of [['workerResult', 'managed-accepted'], ['workerDirectResult', 'direct-accepted-no-receipt']] as const) {
      const value = fixture(id); value.execution.status = 'failed';
      expect(validateWorkerPayload(definition, value).valid).toBe(false);
    }
  });
});
