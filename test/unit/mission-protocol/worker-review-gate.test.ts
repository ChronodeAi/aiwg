import { describe, expect, it } from 'vitest';
import {
  assembleWorkerResult, decodeWorkerPayload, encodeWorkerPayloadSnapshot, validateWorkerPayload,
} from '../../../src/mission-protocol/index.js';
import { workerReviewFixture, reviewArtifact, reviewFinding, reviewHead } from '../../fixtures/worker-review.js';

const accepted = (value: ReturnType<typeof workerReviewFixture>, previous?: ReturnType<typeof assembleWorkerResult>) =>
  JSON.parse(assembleWorkerResult(value, previous).bytes);

describe('T-OG-04/07/14 delegation and exact-head acceptance (#3167)', () => {
  it.each([true, false])('accepts a different observed family on the exact head, direct=%s', direct => {
    const value = workerReviewFixture(direct);
    const record = accepted(value);
    expect(record.verification).toMatchObject({ status: 'accepted', headSha: reviewHead, roundsToClean: 1, findingsLedger: [] });
    expect(decodeWorkerPayload(direct ? 'workerDirectResult' : 'workerResult', record)).toEqual(record);
    expect(value.verification.roundsToClean).toBeUndefined();
  });
  it.each([
    ['same family', (v: any) => { v.reviewLineage.reviewers[0].family = v.reviewLineage.writer.family; }],
    ['same family across CLIs', (v: any) => { v.reviewLineage.reviewers[0].family = v.reviewLineage.writer.family; v.reviewLineage.reviewers[0].cliId = 'another-cli'; }],
    ['stale head', (v: any) => { v.verification.reviewRounds[0].headSha = 'b'.repeat(40); }],
    ['missing head', (v: any) => { delete v.headSha; }],
    ['forged acceptance head', (v: any) => { v.verification.headSha = 'b'.repeat(40); }],
    ['missing lineage', (v: any) => { delete v.reviewLineage; }],
    ['missing writer', (v: any) => { delete v.reviewLineage.writer; }],
    ['missing reviewer list', (v: any) => { delete v.reviewLineage.reviewers; }],
    ['missing reviewer', (v: any) => { v.reviewLineage.reviewers = []; }],
    ['wrong reviewer reference', (v: any) => { v.verification.reviewRounds[0].reviewerObservationRef = 'missing'; }],
    ['ambiguous reviewer', (v: any) => { v.reviewLineage.reviewers.push(v.reviewLineage.reviewers[0]); }],
    ['unknown writer family', (v: any) => { v.reviewLineage.writer.family = 'unknown'; }],
    ['unknown reviewer family', (v: any) => { v.reviewLineage.reviewers[0].family = 'unknown'; }],
    ['malformed reviewer lineage', (v: any) => { delete v.reviewLineage.reviewers[0].provenance; }],
    ['unbound writer', (v: any) => { v.reviewLineage.writer.family = 'other-writer'; }],
    ['missing final review', (v: any) => { delete v.verification.reviewRounds; }],
    ['missing ledger', (v: any) => { delete v.verification.findingsLedger; }],
    ['forged count', (v: any) => { v.verification.roundsToClean = 99; }],
    ['missing design review', (v: any) => { v.brief.designReviewRequired = true; }],
  ])('refuses %s', (_name, mutate) => {
    const value = workerReviewFixture(); mutate(value);
    expect(() => assembleWorkerResult(value)).toThrow();
  });
  it.each(['writer', 'reviewer'])('refuses conflicting %s lineage', side => {
    const value = workerReviewFixture();
    const observation = side === 'writer' ? value.reviewLineage.writer : value.reviewLineage.reviewers[0];
    observation.conflicts = [{ field: '/family', evidence: ['a', 'b'].map(family => ({ value: family,
      source: 'fixture:conflict', pointer: '/family', observedAt: observation.observedAt, digest: reviewArtifact.digest })) }];
    expect(() => assembleWorkerResult(value)).toThrow(/lineage|family/);
  });
  it('requires design-review evidence only when the brief flag is true', () => {
    const value = workerReviewFixture();
    value.brief.designReviewRequired = true;
    value.brief.designReviewArtifact = reviewArtifact;
    expect(accepted(value).verification.status).toBe('accepted');
  });
  it.each([
    ['A', 'blocker', 'open', false], ['A', 'major', 'open', false],
    ['A', 'minor', 'open', true], ['A', 'info', 'open', true], ['A', 'major', 'resolved', true],
    ['B', 'blocker', 'open', true], ['B', 'major', 'open', true], ['C', 'blocker', 'open', true], ['C', 'major', 'open', true],
  ])('ledger class=%s severity=%s status=%s accepts=%s', (classification, severity, status, allows) => {
    const value = workerReviewFixture(); value.verification.findingsLedger = [reviewFinding(classification, severity, status)];
    if (allows) expect(accepted(value).verification.findingsLedger).toEqual(value.verification.findingsLedger);
    else expect(() => assembleWorkerResult(value)).toThrow(/class A/);
  });
  it('does not bypass a required family check through advisory independentReview', () => {
    const value = workerReviewFixture(); value.brief.intent.verification.independentReview = 'advisory';
    value.reviewLineage.reviewers[0].family = value.reviewLineage.writer.family;
    expect(() => assembleWorkerResult(value)).toThrow(/family/);
  });
  it('counts clean rounds with no findings and retains open findings until resolved', () => {
    const value = workerReviewFixture();
    value.verification.status = 'pending';
    value.verification.findingsLedger = [reviewFinding()];
    const first = assembleWorkerResult(value);
    value.verification.reviewRounds.push({ ...value.verification.reviewRounds[0], round: 2, headSha: 'b'.repeat(40) });
    value.verification.findingsLedger[0].status = 'resolved';
    const second = assembleWorkerResult(value, first);
    value.verification.reviewRounds.push({ ...value.verification.reviewRounds[0], round: 3 });
    value.verification.status = 'accepted';
    const record = accepted(value, second);
    expect(record.verification.roundsToClean).toBe(3);
    expect(record.verification.findingsLedger[0]).toMatchObject({ round: 1, status: 'resolved' });
    expect(JSON.parse(first.bytes).verification.findingsLedger[0].status).toBe('open');
    expect(second.previousRecord).toEqual(first.artifact);
  });
  it.each(['drop finding', 'reclassify finding', 'drop round', 'rewrite round'])('preserves history: %s', change => {
    const value = workerReviewFixture(); value.verification.status = 'pending';
    value.verification.findingsLedger = [reviewFinding()];
    const first = assembleWorkerResult(value);
    if (change === 'drop finding') value.verification.findingsLedger = [];
    if (change === 'reclassify finding') value.verification.findingsLedger[0].class = 'B';
    if (change === 'drop round') { value.verification.reviewRounds = []; value.verification.findingsLedger = []; }
    if (change === 'rewrite round') value.verification.reviewRounds[0].headSha = 'b'.repeat(40);
    expect(() => assembleWorkerResult(value, first)).toThrow(/successor/);
  });
  it.each(['gap', 'duplicate finding', 'future finding', 'A waived', 'pending count'])('rejects invalid ledger telemetry: %s', change => {
    const value = workerReviewFixture(); value.verification.status = 'pending';
    value.verification.findingsLedger = [reviewFinding()];
    if (change === 'gap') value.verification.reviewRounds[0].round = 2;
    if (change === 'duplicate finding') value.verification.findingsLedger.push(reviewFinding());
    if (change === 'future finding') value.verification.findingsLedger[0].round = 2;
    if (change === 'A waived') value.verification.findingsLedger[0].status = 'out-of-scope';
    if (change === 'pending count') value.verification.roundsToClean = 1;
    expect(validateWorkerPayload('workerDirectVerification', value.verification).valid).toBe(false);
  });
  it('checks the exact oracle exit statuses and evidence without executing commands', () => {
    const value = workerReviewFixture();
    value.brief.verificationOracle = [{ command: 'fake-check --negative', expectedExitCode: 7 }];
    expect(() => assembleWorkerResult(value)).toThrow(/verificationOracle/);
    value.verification.oracleResults = [{ command: 'fake-check --negative', exitCode: 0, evidence: reviewArtifact }];
    expect(() => assembleWorkerResult(value)).toThrow(/verificationOracle/);
    value.verification.oracleResults[0].exitCode = 7;
    expect(accepted(value).verification.oracleResults).toEqual(value.verification.oracleResults);
    value.verification.oracleResults.push(value.verification.oracleResults[0]);
    expect(() => assembleWorkerResult(value)).toThrow(/unique/);
  });
  it('blocks class A findings even on an advisory legacy acceptance', () => {
    const value = workerReviewFixture();
    value.brief.intent.verification = { ...value.brief.intent.verification, independentReview: 'advisory', differentFamily: 'prefer' };
    value.verification.reviewRounds = [];
    value.verification.findingsLedger = [reviewFinding()];
    expect(() => assembleWorkerResult(value)).toThrow();
  });
  it('acceptance records cannot bypass the open finding check through direct encoding', () => {
    const record = accepted(workerReviewFixture());
    record.verification.findingsLedger = [reviewFinding()];
    expect(() => encodeWorkerPayloadSnapshot('workerDirectResult', record)).toThrow(/class A/);
  });
});
