import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DecisionReviewService, FileDecisionReviewStore, type ReviewScope,
  SDLC_SCREENING_PREREGISTRATION_VERSION,
  SDLC_SCREENING_SCHEMA_VERSION,
  applySdlcScreeningToGateOutcome,
  buildSdlcScreeningReleaseReport,
  evaluateSdlcEvidenceScreening,
  evaluateSdlcScreeningPreregistration,
  sdlcScreeningDecisionArtifacts,
  sdlcScreeningReviewInputFromReceipt,
  type SdlcCitationObservation,
  type SdlcCitationSubject,
  type SdlcPhaseCriterionObservation,
  type SdlcPhaseCriterionSubject,
  type SdlcScreeningHeldoutReport,
  type SdlcScreeningInventory,
  type SdlcScreeningPreregistration,
} from '../../../src/decision/index.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const digest = (char: string) => `sha256:${char.repeat(64)}` as `sha256:${string}`;
const inventory: SdlcScreeningInventory = {
  claimIds: ['claim:port'],
  requirementIds: ['FR-022'],
  sourceIds: ['source:atlas'],
  locators: ['doc:atlas#port'],
  criterionIds: ['G2.security-evidence'],
  evidenceIds: ['artifact:threat-model', 'test:security', 'approval:release', 'sig:artifact', 'schema:gate'],
};

const citationSubject = (overrides: Partial<SdlcCitationSubject['evidence'][number]> = {}): SdlcCitationSubject => ({
  kind: 'citation',
  subjectId: 'citation:claim:port/source:atlas',
  claimId: 'claim:port',
  requirementIds: ['FR-022'],
  sourceId: 'source:atlas',
  locator: 'doc:atlas#port',
  evidence: [{
    id: 'source:atlas', version: '1.0.0', digest: digest('a'),
    locator: 'doc:atlas#port', locatorExists: true, retrieved: true,
    contentDigest: digest('b'), provenanceVerified: true, publicationAuthorized: true,
    trust: 'verified', sensitivity: 'internal', ...overrides,
  }],
});

const citationObservation = (overrides: Partial<SdlcCitationObservation> = {}): SdlcCitationObservation => ({
  kind: 'citation',
  claimId: 'claim:port',
  sourceId: 'source:atlas',
  locator: 'doc:atlas#port',
  support: 'supports',
  supportStrengthBps: 9_200,
  injection: 'no',
  confidenceBps: 9_100,
  model: 'offline:bounded',
  attempts: 1,
  ...overrides,
});

const criterionSubject = (failed = false): SdlcPhaseCriterionSubject => ({
  kind: 'phase-criterion',
  subjectId: 'criterion:G2.security-evidence',
  criterionId: 'G2.security-evidence',
  requirementIds: ['FR-022'],
  evidence: [
    { id: 'artifact:threat-model', version: '1', digest: digest('c'), type: 'artifact', required: true, present: true, passed: true },
    { id: 'test:security', version: '1', digest: digest('d'), type: 'test-result', required: true, present: true, passed: !failed },
    { id: 'approval:release', version: '1', digest: digest('e'), type: 'approval', required: true, present: true, passed: true, expiresAtEpochMs: 2_000 },
    { id: 'sig:artifact', version: '1', digest: digest('f'), type: 'signature', required: true, present: true, passed: true },
    { id: 'schema:gate', version: '1', digest: digest('0'), type: 'schema', required: true, present: true, passed: true },
  ],
});

const criterionObservation = (overrides: Partial<SdlcPhaseCriterionObservation> = {}): SdlcPhaseCriterionObservation => ({
  kind: 'phase-criterion',
  criterionId: 'G2.security-evidence',
  evidenceIds: ['artifact:threat-model', 'test:security', 'approval:release', 'sig:artifact', 'schema:gate'],
  relevance: 'relevant',
  completeness: 'complete',
  contradiction: 'none',
  ambiguity: 'low',
  reviewerAttention: 'not-needed',
  confidenceBps: 9_300,
  model: 'offline:bounded',
  attempts: 1,
  ...overrides,
});

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
    expect(choices['sdlc-screening.criterion.reviewer-attention']).toEqual(['needed', 'not-needed']);
    expect(artifacts.definitions.find(item => item.metadata.id === 'sdlc-screening.citation.injection')?.spec.answer.kind).toBe('truth-probability');
  });

  it('screens a citation only after deterministic locator and provenance checks pass', () => {
    const ready = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory,
      subject: citationSubject(), observation: citationObservation(), nowEpochMs: 1_000,
    });
    expect(ready).toMatchObject({
      route: 'ADVISORY_READY',
      deterministic: { status: 'pass', findings: [] },
      semantic: { accepted: true, reason: 'citation-supported' },
      action: { status: 'unexecuted' },
      trace: { redaction: 'metadata-only' },
    });

    const unverified = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory,
      subject: citationSubject({ provenanceVerified: false, publicationAuthorized: false }),
      observation: citationObservation(), nowEpochMs: 1_000,
    });
    expect(unverified).toMatchObject({ route: 'REVIEW', deterministic: { status: 'review' }, reviewRequired: true });
    expect(unverified?.reviewReasons).toEqual(expect.arrayContaining(['source-provenance-unverified', 'publication-not-authorized']));
  });

  it('rejects unknown IDs and prevents observations from moving to a different subject', () => {
    expect(() => evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory,
      subject: { ...citationSubject(), sourceId: 'source:invented' }, observation: citationObservation(),
      nowEpochMs: 1_000,
    })).toThrow('unknown-id');
    expect(() => evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory,
      subject: citationSubject(), observation: citationObservation({ claimId: 'claim:other' }),
      nowEpochMs: 1_000,
    })).toThrow('Observation subject mismatch');
  });

  it('keeps prompt-injection or authority text advisory and review-routed', () => {
    const receipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory,
      subject: citationSubject(),
      observation: citationObservation({ injection: 'yes', support: 'supports', confidenceBps: 10_000 }),
      nowEpochMs: 1_000,
    });
    expect(receipt).toMatchObject({
      route: 'REVIEW',
      semantic: { accepted: false, reason: 'prompt-injection-flagged' },
      action: { status: 'unexecuted' },
    });
  });

  it('property-checks that failed required evidence cannot become ready for any bounded model output', () => {
    const relevance = ['relevant', 'irrelevant', 'unclear'] as const;
    const completeness = ['complete', 'incomplete', 'unclear'] as const;
    const contradiction = ['none', 'present', 'unclear'] as const;
    const ambiguity = ['low', 'high', 'unclear'] as const;
    const reviewerAttention = ['needed', 'not-needed'] as const;
    for (const rel of relevance) for (const comp of completeness) for (const con of contradiction) {
      for (const amb of ambiguity) for (const attention of reviewerAttention) for (const confidenceBps of [0, 7_999, 8_000, 10_000]) {
        const receipt = evaluateSdlcEvidenceScreening({
          schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory,
          subject: criterionSubject(true),
          observation: criterionObservation({ relevance: rel, completeness: comp, contradiction: con, ambiguity: amb, reviewerAttention: attention, confidenceBps }),
          nowEpochMs: 1_000,
        });
        expect(receipt?.route, `${rel}/${comp}/${con}/${amb}/${attention}/${confidenceBps}`).not.toBe('ADVISORY_READY');
        expect(receipt?.deterministic.status).toBe('fail');
      }
    }
  });

  it('preserves the current gate and publication path in disabled and shadow modes', () => {
    const current = { gate: 'G2', status: 'fail', reason: 'test-failed' } as const;
    const audit = [{ id: 'existing-gate-receipt', version: '1', digest: digest('1') }];
    const disabled = applySdlcScreeningToGateOutcome(current, 'disabled', audit, null);
    expect(JSON.stringify(disabled.outcome)).toBe(JSON.stringify(current));
    expect(disabled.publication).toBe('unchanged');
    expect(disabled.auditReceipts).toEqual(audit);

    const receipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory,
      subject: criterionSubject(false), observation: criterionObservation(), nowEpochMs: 1_000,
    });
    const shadow = applySdlcScreeningToGateOutcome(current, 'shadow', audit, receipt);
    expect(JSON.stringify(shadow.outcome)).toBe(JSON.stringify(current));
    expect(shadow.alternateScreening?.route).toBe('ADVISORY_READY');
  });

  it('scaffolds held-out preregistration and cannot promote missing slice support or integrity HOLD/ROLLBACK', () => {
    const preregistration: SdlcScreeningPreregistration = {
      schemaVersion: SDLC_SCREENING_PREREGISTRATION_VERSION,
      planId: 'D29-offline-shadow-v1',
      frozenAt: '2026-09-29T00:00:00.000Z',
      maximumFalseSupportRateBps: 200,
      maximumFalseReadyRateBps: 100,
      minimumTotalSupport: 50,
      minimumGateBlockingSliceSupport: 20,
      confidenceInterval: { method: 'wilson', levelBps: 9_500 },
      qualityNonInferiorityBps: 0,
      efficiencyClaim: { enabled: true, minimumPositiveTotalEconomicsUsd: 1 },
    };
    expect(evaluateSdlcScreeningPreregistration(preregistration, null)).toEqual({
      decision: 'insufficient-evidence',
      reasons: ['heldout-report-missing'],
    });
    const thinReport: SdlcScreeningHeldoutReport = {
      schemaVersion: 'decision-sdlc-screening-heldout-report/v1',
      support: { n: 10, value: 0.9, precisionBps: 9_000, recallBps: 9_000 },
      contradiction: { n: 10, value: 0.9, precisionBps: 9_000, recallBps: 9_000 },
      unclear: { n: 10, value: 0.9, precisionBps: 9_000, recallBps: 9_000 },
      calibrationRiskCoverage: { n: 10, value: 0.8 },
      falseSupportRateBps: 50,
      falseReadyRateBps: 50,
      reviewerAgreementRateBps: 9_000,
      reviewerOverrideRateBps: 200,
      slices: { artifact: { n: 10, value: 0.8 } },
      latencyMs: { n: 10, value: 100 },
      tokens: { n: 10, value: 1000 },
      costUsd: { n: 10, value: 0.1 },
      reviewLoad: { n: 10, value: 0.5 },
      gateBlockingSliceSupport: 1,
      totalSupport: 10,
      positiveTotalEconomicsUsd: null,
    };
    expect(evaluateSdlcScreeningPreregistration(preregistration, thinReport).decision).toBe('insufficient-evidence');
    const integrity: QualificationIntegrityMetadata = {
      sample_n: 100, uncertainty: { ci: 'synthetic' }, paired_baseline: { id: 'baseline' },
      integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: true,
      integrity_state: 'verified', trusted_score_source: 'trusted-offline', compromise_labels: [],
      weak_signal_reason: null, release_gate: { decision: 'HOLD', reasons: ['upstream'] },
    };
    const release = buildSdlcScreeningReleaseReport({ preregistration, heldout: thinReport, integrity });
    expect(release.decision).toBe('HOLD');
    expect(release.reasons).toEqual(expect.arrayContaining(['gate-blocking-slice-support-missing', 'positive-total-economics-missing', 'upstream-integrity-hold']));
    expect(buildSdlcScreeningReleaseReport({ preregistration, heldout: thinReport,
      integrity: { ...integrity, release_gate: { decision: 'ROLLBACK', reasons: [] } } }).decision).toBe('ROLLBACK');
  });

  it('creates D13 durable review input that survives restart and cannot execute twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-screening-review-'));
    roots.push(root);
    const receipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory,
      subject: citationSubject({ retrieved: false }), observation: citationObservation(),
      nowEpochMs: 1_000,
    });
    expect(receipt?.reviewRequired).toBe(true);
    const input = sdlcScreeningReviewInputFromReceipt(receipt!, {
      enabled: true, reviewId: 'sdlc-screening-review', continuationId: 'continue-gate',
      resumeToken: 'resume-token', expiresAtEpochMs: 10_000, riskTier: 'medium',
      rationale: 'Review missing source retrieval before gate transition',
    });
    expect(input).not.toBeNull();
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
