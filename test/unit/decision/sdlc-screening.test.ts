import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DecisionReviewService, FileDecisionReviewStore, type ReviewScope,
  applySdlcScreeningToGateOutcome,
  buildSdlcScreeningReleaseReport,
  evaluateSdlcEvidenceScreening,
  evaluateSdlcScreeningPreregistration,
  sdlcScreeningDecisionArtifacts,
  sdlcScreeningReviewInputFromReceipt,
  type JsonValue,
} from '../../../src/decision/index.js';
import {
  HELDOUT_NOW, anchored, calibration, citationObservation, citationSubject, criterionItem, criterionObservation,
  criterionSubject, digest, heldoutRecords, preregistration, request, trust, verifiedIntegrity,
} from './sdlc-screening-fixtures.js';

const schema = (name: string) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  (addFormats as unknown as (value: Ajv2020) => void)(ajv);
  return ajv.compile(JSON.parse(readFileSync(new URL(`../../../schemas/decision/${name}`, import.meta.url), 'utf8')) as object);
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('SDLC evidence screening (#2622)', () => {
  it('publishes closed bounded definitions and rulesets for citation and criterion subjects', () => {
    const artifacts = sdlcScreeningDecisionArtifacts();
    expect(artifacts.rulesets.map(item => item.metadata.id)).toEqual(['sdlc-screening.citation', 'sdlc-screening.phase-criterion']);
    const choices = Object.fromEntries(artifacts.definitions
      .filter(item => item.spec.answer.kind === 'choice')
      .map(item => [item.metadata.id, item.spec.answer.kind === 'choice' ? item.spec.answer.options.map(option => option.id) : []]));
    expect(choices['sdlc-screening.citation.support']).toEqual(['supports', 'does-not-support', 'contradicts', 'unclear']);
    expect(choices['sdlc-screening.criterion.relevance']).toEqual(['relevant', 'irrelevant', 'unclear']);
    expect(choices['sdlc-screening.criterion.completeness']).toEqual(['complete', 'incomplete', 'unclear']);
    expect(choices['sdlc-screening.criterion.contradiction']).toEqual(['none', 'present', 'unclear']);
    expect(choices['sdlc-screening.criterion.ambiguity']).toEqual(['low', 'high', 'unclear']);
    expect(choices['sdlc-screening.criterion.reviewer-attention']).toEqual(['needed', 'not-needed']);
    expect(artifacts.definitions.find(item => item.metadata.id === 'sdlc-screening.citation.injection')?.spec.answer.kind).toBe('truth-probability');
    // Callers get a copy: mutating it cannot change the rulesets used for screening.
    artifacts.rulesets[0]!.spec.rules = [];
    expect(sdlcScreeningDecisionArtifacts().rulesets[0]!.spec.rules.length).toBeGreaterThan(0);
  });

  it('screens a citation only after deterministic locator and provenance checks pass', () => {
    const ready = evaluateSdlcEvidenceScreening(request(citationSubject(), citationObservation(), { mode: 'shadow' }), trust());
    expect(ready).toMatchObject({
      route: 'ADVISORY_READY',
      deterministic: { status: 'pass', findings: [] },
      semantic: { accepted: true, reason: 'citation-supported' },
      gatePolicy: { id: 'policy:sdlc-gates' },
      action: { status: 'unexecuted' },
      trace: { redaction: 'metadata-only' },
    });

    const unverified = evaluateSdlcEvidenceScreening(request(
      citationSubject({ provenanceVerified: false, publicationAuthorized: false }), citationObservation()), trust());
    expect(unverified).toMatchObject({ route: 'REVIEW', deterministic: { status: 'review' }, reviewRequired: true });
    expect(unverified?.reviewReasons).toEqual(expect.arrayContaining(['source-provenance-unverified', 'publication-not-authorized']));
  });

  it('routes unknown IDs and subject mismatches to review/fail receipts without throwing', () => {
    expect(evaluateSdlcEvidenceScreening(request({ ...citationSubject(), sourceId: 'source:invented' }, citationObservation()), trust()))
      .toMatchObject({ route: 'REVIEW', deterministic: { findings: [{ reason: 'unknown-id' }] } });
    expect(evaluateSdlcEvidenceScreening(request(citationSubject(), citationObservation({ claimId: 'claim:other' })), trust()))
      .toMatchObject({ route: 'REVIEW', deterministic: { findings: [{ reason: 'subject-isolation-violated' }] } });
    expect(evaluateSdlcEvidenceScreening(request(citationSubject(), { ...citationObservation(), confidenceBps: Number.NaN }), trust()))
      .toMatchObject({ route: 'FAIL', deterministic: { findings: [{ reason: 'invalid-observation' }] } });
  });

  it('keeps prompt-injection or authority text advisory and review-routed', () => {
    const receipt = evaluateSdlcEvidenceScreening(request(citationSubject(),
      citationObservation({ injection: 'yes', support: 'supports', confidenceBps: 10_000 }), { mode: 'shadow' }), trust());
    expect(receipt).toMatchObject({
      route: 'REVIEW',
      semantic: { accepted: false, reason: 'prompt-injection-flagged' },
      action: { status: 'unexecuted' },
    });
  });

  it('keeps untrusted, restricted or digest-mismatched evidence out of advisory-ready routing', () => {
    const untrusted = evaluateSdlcEvidenceScreening(request(
      citationSubject({ trust: 'untrusted', sensitivity: 'restricted', contentDigest: digest('2') }), citationObservation()), trust());
    expect(untrusted?.route).toBe('REVIEW');
    expect(untrusted?.reviewReasons).toEqual(expect.arrayContaining(['evidence-trust-mismatch', 'content-digest-mismatch']));
  });

  it('property-checks that failed required evidence cannot become ready for any bounded model output', () => {
    const relevance = ['relevant', 'irrelevant', 'unclear'] as const;
    const completeness = ['complete', 'incomplete', 'unclear'] as const;
    const contradiction = ['none', 'present', 'unclear'] as const;
    const ambiguity = ['low', 'high', 'unclear'] as const;
    const reviewerAttention = ['needed', 'not-needed'] as const;
    for (const rel of relevance) for (const comp of completeness) for (const con of contradiction) {
      for (const amb of ambiguity) for (const attention of reviewerAttention) for (const confidenceBps of [0, 7_999, 8_000, 10_000]) {
        const receipt = evaluateSdlcEvidenceScreening(request(criterionSubject(true),
          criterionObservation({ relevance: rel, completeness: comp, contradiction: con, ambiguity: amb, reviewerAttention: attention, confidenceBps })), trust());
        expect(receipt?.route, `${rel}/${comp}/${con}/${amb}/${attention}/${confidenceBps}`).not.toBe('ADVISORY_READY');
        expect(receipt?.deterministic.status).toBe('fail');
      }
    }
  });

  it('uses policy-defined required evidence instead of caller required flags or bundle omissions', () => {
    const spoofed = criterionSubject(false);
    spoofed.evidence = spoofed.evidence.map(item => item.id === 'test:security'
      ? { ...item, required: false, present: true, passed: false } : item);
    expect(evaluateSdlcEvidenceScreening(request(spoofed, criterionObservation()), trust()))
      .toMatchObject({ route: 'FAIL', deterministic: { status: 'fail' } });

    const omitted = criterionSubject(false);
    omitted.evidence = omitted.evidence.filter(item => item.id !== 'approval:release');
    const omittedReceipt = evaluateSdlcEvidenceScreening(request(omitted,
      criterionObservation({}, omitted.evidence.map(item => item.id))), trust());
    expect(omittedReceipt?.route).toBe('REVIEW');
    expect(omittedReceipt?.reviewReasons).toContain('required-evidence-missing');
  });

  it('rejects evidence owned by another criterion and treats expiry at now as expired', () => {
    const mixed = criterionSubject(false);
    mixed.evidence[0] = criterionItem('artifact:g3');
    const receipt = evaluateSdlcEvidenceScreening(request(mixed,
      criterionObservation({}, mixed.evidence.map(item => item.id)), { nowEpochMs: 2_000 }), trust());
    expect(receipt?.route).toBe('REVIEW');
    expect(receipt?.reviewReasons).toEqual(expect.arrayContaining(['foreign-evidence', 'required-evidence-missing', 'evidence-expired']));
  });

  it('routes low-margin or calibration-incompatible semantic observations to review through the published ruleset', () => {
    const low = evaluateSdlcEvidenceScreening(request(criterionSubject(false), criterionObservation({ confidenceBps: 7_999 })), trust());
    expect(low).toMatchObject({ route: 'REVIEW', semantic: { accepted: false, reason: 'evidence-not-accepted' } });
    const unapproved = evaluateSdlcEvidenceScreening(request(criterionSubject(false), criterionObservation()),
      trust({ calibration: calibration({ approved: false }) }));
    expect(unapproved).toMatchObject({ route: 'REVIEW', semantic: { accepted: false, reason: 'calibration-require-approval' } });
  });

  it('shadow and disabled modes never alter a host-supplied gate outcome or publication state', () => {
    // AIWG has no programmatic SDLC phase-gate evaluator; the host owns the outcome value.
    const current = { gate: 'G2', status: 'fail', reasons: ['test-failed'] } as unknown as JsonValue;
    const snapshot = JSON.stringify(current);
    const audit = [{ id: 'existing-gate-receipt', version: '1', digest: digest('1') }];
    const disabled = applySdlcScreeningToGateOutcome(current, 'disabled', audit, null);
    expect(JSON.stringify(disabled.outcome)).toBe(snapshot);
    expect(disabled).not.toHaveProperty('alternateScreening');
    expect(disabled.auditReceipts).toEqual(audit);

    const receipt = evaluateSdlcEvidenceScreening(request(criterionSubject(false), criterionObservation(), { mode: 'shadow' }), trust());
    expect(receipt?.route).toBe('ADVISORY_READY');
    const shadow = applySdlcScreeningToGateOutcome(current, 'shadow', audit, receipt);
    expect(JSON.stringify(shadow.outcome)).toBe(snapshot);
    expect(shadow.publication).toBe('unchanged');
    expect(shadow.alternateScreening?.route).toBe('ADVISORY_READY');
    // The returned outcome is a copy: mutating it cannot touch the host's object.
    (shadow.outcome as { status: string }).status = 'pass';
    expect(JSON.stringify(current)).toBe(snapshot);
    expect(evaluateSdlcEvidenceScreening(request(criterionSubject(false), criterionObservation(), { mode: 'disabled' }))).toBeNull();
  });

  it('computes held-out metrics from records and cannot promote while paired non-inferiority is pending', () => {
    const plan = preregistration();
    const result = evaluateSdlcScreeningPreregistration(plan, anchored(plan), heldoutRecords(), HELDOUT_NOW);
    // Every preregistered threshold is satisfied by the fixture except the pending paired interval.
    expect(result.reasons).toEqual(['quality-non-inferiority-pending-paired-interval']);
    expect(result.decision).toBe('insufficient-evidence');
    expect(result.heldout).toMatchObject({
      totalSupport: 180, gateBlockingSliceSupport: 60,
      classes: { support: { n: 30, precisionBps: 10_000, recallBps: 10_000 } },
      falseSupport: { events: 0, n: 120 }, falseReady: { events: 0, n: 180 },
      costUsd: { netSavings: expect.closeTo(1.62, 6) },
    });
    const release = buildSdlcScreeningReleaseReport({ preregistration: plan, trustedPreregistrationDigest: anchored(plan),
      heldout: heldoutRecords(), integrity: verifiedIntegrity(), nowEpochMs: HELDOUT_NOW });
    expect(release.decision).toBe('HOLD');
    expect(release.reasons).toEqual(['quality-non-inferiority-pending-paired-interval']);
    expect(evaluateSdlcScreeningPreregistration(plan, anchored(plan), null, HELDOUT_NOW)).toMatchObject({
      decision: 'insufficient-evidence', reasons: ['heldout-records-missing'] });
    expect(() => evaluateSdlcScreeningPreregistration({ ...plan, minimumTotalSupport: -1 }, anchored(plan), null, HELDOUT_NOW))
      .toThrow('minimums');
  });

  it('never upgrades upstream integrity HOLD or ROLLBACK', () => {
    const plan = preregistration();
    const build = (integrity = verifiedIntegrity()) => buildSdlcScreeningReleaseReport({
      preregistration: plan, trustedPreregistrationDigest: anchored(plan), heldout: heldoutRecords(), integrity, nowEpochMs: HELDOUT_NOW });
    expect(build(verifiedIntegrity({ release_gate: { decision: 'HOLD', reasons: ['upstream'] } }))).toMatchObject({
      decision: 'HOLD', reasons: expect.arrayContaining(['upstream-integrity-hold']) });
    expect(build(verifiedIntegrity({ release_gate: { decision: 'ROLLBACK', reasons: [] } })).decision).toBe('ROLLBACK');
    expect(build(verifiedIntegrity({ integrity_state: 'compromised', compromise_labels: ['golden.json'] })).decision).toBe('ROLLBACK');
  });

  it('keeps the closed request, preregistration and release schemas in step with the runtime shapes', () => {
    const requestSchema = schema('SdlcEvidenceScreening.v1.schema.json');
    for (const input of [request(citationSubject(), citationObservation()), request(criterionSubject(false), criterionObservation())]) {
      expect(requestSchema(input), JSON.stringify(requestSchema.errors)).toBe(true);
    }
    expect(requestSchema({ ...request(criterionSubject(false), criterionObservation()), gatePolicy: {} })).toBe(false);
    const plan = preregistration();
    const preregistrationSchema = schema('SdlcScreeningPreregistration.v1.schema.json');
    expect(preregistrationSchema(plan), JSON.stringify(preregistrationSchema.errors)).toBe(true);
    const releaseSchema = schema('SdlcScreeningRelease.v1.schema.json');
    for (const heldout of [heldoutRecords(), null]) {
      const release = buildSdlcScreeningReleaseReport({ preregistration: plan, trustedPreregistrationDigest: anchored(plan),
        heldout, integrity: verifiedIntegrity(), nowEpochMs: HELDOUT_NOW });
      expect(releaseSchema(release), JSON.stringify(releaseSchema.errors)).toBe(true);
    }
  });

  it('creates D13 durable review input that survives restart and cannot execute twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-screening-review-'));
    roots.push(root);
    const receipt = evaluateSdlcEvidenceScreening(request(citationSubject({ retrieved: false }), citationObservation(), { mode: 'shadow' }), trust());
    expect(receipt?.reviewRequired).toBe(true);
    const input = sdlcScreeningReviewInputFromReceipt(receipt!, {
      enabled: false, reviewId: 'sdlc-screening-review', continuationId: 'continue-gate',
      resumeToken: 'resume-token', expiresAtEpochMs: 10_000, riskTier: 'medium',
      rationale: 'Review missing source retrieval before gate transition',
      requesterPresentation: { raw: 'do not copy this confidential text into D13' },
    });
    expect(input).not.toBeNull();
    expect(input?.policyPins.map(pin => pin.id)).toEqual(['sdlc-evidence-screening', 'policy:sdlc-gates']);
    expect(input?.presentation).toMatchObject({ redaction: 'metadata-only', requesterPresentationDigest: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(input?.presentation)).not.toContain('confidential text');
    const key = new Uint8Array(32).fill(5);
    const store = () => new FileDecisionReviewStore(root, key);
    const requester: ReviewScope = { tenantId: 'tenant', projectId: 'project',
      actor: { id: 'requester', roles: ['requester'], authorityContext: 'fixture/v1' } };
    const reviewer: ReviewScope = { ...requester, actor: { id: 'reviewer', roles: ['reviewer'], authorityContext: 'fixture/v1' } };
    const auth = { authorize: () => true, eligible: () => true, eligibleApproval: () => true, authorizeAction: () => true };
    let now = 1_000;
    await new DecisionReviewService(store(), auth, () => now).create(requester, input!);
    await new DecisionReviewService(store(), auth, () => now).decide(reviewer, 'sdlc-screening-review', 'approve', 'synthetic approval');
    now += 1;
    let calls = 0;
    const execute = async () => { calls += 1; return { gateTransition: 'not-executed-by-screening' }; };
    const restarted = new DecisionReviewService(store(), auth, () => now);
    const first = await restarted.resume(reviewer, 'sdlc-screening-review', 'resume-token', execute);
    const second = await new DecisionReviewService(store(), auth, () => now).resume(reviewer, 'sdlc-screening-review', 'resume-token', execute);
    expect(calls).toBe(1);
    expect(second.effectId).toBe(first.effectId);
    expect((await store().read('sdlc-screening-review', 'tenant', 'project'))?.status).toBe('completed');
  });
});
