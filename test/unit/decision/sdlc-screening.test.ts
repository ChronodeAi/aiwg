import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateQualification } from '../../../src/decision/qualification/gates.js';
import type { QualificationRunManifest } from '../../../src/decision/qualification/types.js';
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
  type SdlcGateEvidencePolicy,
  type JsonValue,
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
  criterionIds: ['G2.security-evidence', 'G3.release-evidence'],
  evidenceIds: ['artifact:threat-model', 'test:security', 'approval:release', 'sig:artifact', 'schema:gate', 'artifact:g3'],
};
const gatePolicy = (overrides: Partial<SdlcGateEvidencePolicy> = {}): SdlcGateEvidencePolicy => ({
  id: 'policy:sdlc-gates', version: '1.0.0', digest: digest('9'),
  requiredEvidenceByCriterion: {
    'G2.security-evidence': ['artifact:threat-model', 'test:security', 'approval:release', 'sig:artifact', 'schema:gate'],
    'G3.release-evidence': ['artifact:g3'],
  },
  evidenceSubjects: {
    'artifact:threat-model': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
    'test:security': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
    'approval:release': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
    'sig:artifact': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
    'schema:gate': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
    'artifact:g3': { kind: 'phase-criterion', criterionId: 'G3.release-evidence' },
    'source:atlas': { kind: 'citation', claimId: 'claim:port', sourceId: 'source:atlas', locator: 'doc:atlas#port' },
  },
  ...overrides,
});

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
    expect(choices['sdlc-screening.criterion.ambiguity']).toEqual(['low', 'high', 'unclear']);
    expect(choices['sdlc-screening.criterion.reviewer-attention']).toEqual(['needed', 'not-needed']);
    expect(artifacts.definitions.find(item => item.metadata.id === 'sdlc-screening.citation.injection')?.spec.answer.kind).toBe('truth-probability');
  });

  it('screens a citation only after deterministic locator and provenance checks pass', () => {
    const ready = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory, gatePolicy: gatePolicy(),
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
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory, gatePolicy: gatePolicy(),
      subject: citationSubject({ provenanceVerified: false, publicationAuthorized: false }),
      observation: citationObservation(), nowEpochMs: 1_000,
    });
    expect(unverified).toMatchObject({ route: 'REVIEW', deterministic: { status: 'review' }, reviewRequired: true });
    expect(unverified?.reviewReasons).toEqual(expect.arrayContaining(['source-provenance-unverified', 'publication-not-authorized']));
  });

  it('routes unknown IDs and subject mismatches to review/fail receipts without throwing', () => {
    expect(evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory, gatePolicy: gatePolicy(),
      subject: { ...citationSubject(), sourceId: 'source:invented' }, observation: citationObservation(),
      nowEpochMs: 1_000,
    })).toMatchObject({ route: 'REVIEW', deterministic: { findings: [{ reason: 'unknown-id' }] } });
    expect(evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory, gatePolicy: gatePolicy(),
      subject: citationSubject(), observation: citationObservation({ claimId: 'claim:other' }),
      nowEpochMs: 1_000,
    })).toMatchObject({ route: 'REVIEW', deterministic: { findings: [{ reason: 'subject-isolation-violated' }] } });
    expect(evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy(),
      subject: citationSubject(), observation: { ...citationObservation(), confidenceBps: Number.NaN },
      nowEpochMs: 1_000,
    })).toMatchObject({ route: 'FAIL', deterministic: { findings: [{ reason: 'invalid-observation' }] } });
  });

  it('keeps prompt-injection or authority text advisory and review-routed', () => {
    const receipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory, gatePolicy: gatePolicy(),
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

  it('keeps untrusted, restricted or digest-mismatched evidence out of advisory-ready routing', () => {
    const content = 'verified text';
    const untrusted = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy(),
      subject: citationSubject({ trust: 'untrusted', sensitivity: 'restricted', content, contentDigest: digest('2') }),
      observation: citationObservation(), nowEpochMs: 1_000,
    });
    expect(untrusted?.route).toBe('REVIEW');
    expect(untrusted?.reviewReasons).toEqual(expect.arrayContaining(['evidence-untrusted', 'evidence-restricted', 'content-digest-mismatch']));
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
          schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy(),
          subject: criterionSubject(true),
          observation: criterionObservation({ relevance: rel, completeness: comp, contradiction: con, ambiguity: amb, reviewerAttention: attention, confidenceBps }),
          nowEpochMs: 1_000,
        });
        expect(receipt?.route, `${rel}/${comp}/${con}/${amb}/${attention}/${confidenceBps}`).not.toBe('ADVISORY_READY');
        expect(receipt?.deterministic.status).toBe('fail');
      }
    }
  });

  it('uses policy-defined required evidence instead of caller required flags or bundle omissions', () => {
    const spoofed = criterionSubject(false);
    spoofed.evidence = spoofed.evidence.map(item => item.id === 'test:security'
      ? { ...item, required: false, present: true, passed: false } : item);
    const spoofedReceipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy(),
      subject: spoofed, observation: criterionObservation(), nowEpochMs: 1_000,
    });
    expect(spoofedReceipt).toMatchObject({ route: 'FAIL', deterministic: { status: 'fail' } });

    const omitted = criterionSubject(false);
    omitted.evidence = omitted.evidence.filter(item => item.id !== 'approval:release');
    const omittedReceipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy(),
      subject: omitted, observation: { ...criterionObservation(), evidenceIds: omitted.evidence.map(item => item.id) },
      nowEpochMs: 1_000,
    });
    expect(omittedReceipt?.route).toBe('REVIEW');
    expect(omittedReceipt?.reviewReasons).toContain('required-evidence-missing');
  });

  it('rejects evidence owned by another criterion and treats expiry at now as expired', () => {
    const mixed = criterionSubject(false);
    mixed.evidence[0] = { id: 'artifact:g3', version: '1', digest: digest('2'), type: 'artifact', required: true, present: true, passed: true };
    const receipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy({
        requiredEvidenceByCriterion: { ...gatePolicy().requiredEvidenceByCriterion,
          'G2.security-evidence': ['artifact:g3', 'test:security', 'approval:release', 'sig:artifact', 'schema:gate'] },
      }),
      subject: mixed, observation: { ...criterionObservation(), evidenceIds: mixed.evidence.map(item => item.id) },
      nowEpochMs: 2_000,
    });
    expect(receipt?.route).toBe('REVIEW');
    expect(receipt?.reviewReasons).toEqual(expect.arrayContaining(['subject-isolation-violated', 'evidence-expired']));
  });

  it('routes low-margin or calibration-incompatible semantic observations to review through the published ruleset', () => {
    const low = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy(),
      subject: criterionSubject(false), observation: criterionObservation({ confidenceBps: 7_999 }), nowEpochMs: 1_000,
    });
    expect(low).toMatchObject({ route: 'REVIEW', semantic: { accepted: false, reason: 'evidence-not-accepted' } });
    const incompatible = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicy: gatePolicy(),
      subject: criterionSubject(false), observation: criterionObservation(), nowEpochMs: 1_000,
      calibrationCompatibility: { action: 'defer', reasons: ['calibration-missing'] },
    });
    expect(incompatible).toMatchObject({ route: 'REVIEW', semantic: { accepted: false, reason: 'calibration-defer' } });
  });

  it('preserves the current gate and publication path in disabled and shadow modes', () => {
    const manifest: QualificationRunManifest = {
      schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'sdlc-screening-byte-identity',
      generatedAt: '2026-09-29T00:00:00.000Z', sourceCommit: 'abc', dirty: false,
      cases: [{ id: 'C01', kind: 'baseline', mandatory: true, candidateTests: [] }],
      evidence: [{ caseId: 'C01', executable: true, outcome: 'fail', artifact: 'C01.json', digest: digest('3') }],
      evidenceFlags: {},
    };
    const current = evaluateQualification(manifest) as unknown as JsonValue;
    const audit = [{ id: 'existing-gate-receipt', version: '1', digest: digest('1') }];
    const disabled = applySdlcScreeningToGateOutcome(current, 'disabled', audit, null);
    expect(JSON.stringify(disabled.outcome)).toBe(JSON.stringify(current));
    expect(disabled.publication).toBe('unchanged');
    expect(disabled.auditReceipts).toEqual(audit);

    const receipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory, gatePolicy: gatePolicy(),
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
      evaluatedAt: '2026-09-30T00:00:00.000Z',
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
    expect(() => evaluateSdlcScreeningPreregistration({ ...preregistration, minimumTotalSupport: -1 }, thinReport))
      .toThrow('minimums');
    const nanReport = { ...thinReport, falseReadyRateBps: Number.NaN };
    expect(evaluateSdlcScreeningPreregistration(preregistration, nanReport)).toMatchObject({
      decision: 'insufficient-evidence', reasons: expect.arrayContaining(['heldout-report-invalid']),
    });
    const zeroSlice = { ...thinReport, totalSupport: 100, gateBlockingSliceSupport: 20,
      positiveTotalEconomicsUsd: 2, slices: { artifact: { n: 0, value: 0.9 } } };
    expect(buildSdlcScreeningReleaseReport({ preregistration, heldout: zeroSlice,
      integrity: { ...integrity, release_gate: { decision: 'PROMOTE', reasons: [] }, sample_n: 0,
        integrity_mode: 'standard', trusted_score_source: 'local-unverified', uncertainty: null,
        fresh_workspace_required: true, fresh_workspace_verified: false, weak_signal_reason: 'weak' } }).decision)
      .toBe('HOLD');
  });

  it('creates D13 durable review input that survives restart and cannot execute twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-screening-review-'));
    roots.push(root);
    const receipt = evaluateSdlcEvidenceScreening({
      schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'shadow', inventory, gatePolicy: gatePolicy(),
      subject: citationSubject({ retrieved: false }), observation: citationObservation(),
      nowEpochMs: 1_000,
    });
    expect(receipt?.reviewRequired).toBe(true);
    const input = sdlcScreeningReviewInputFromReceipt(receipt!, {
      enabled: false, reviewId: 'sdlc-screening-review', continuationId: 'continue-gate',
      resumeToken: 'resume-token', expiresAtEpochMs: 10_000, riskTier: 'medium',
      rationale: 'Review missing source retrieval before gate transition',
      requesterPresentation: { raw: 'do not copy this confidential text into D13' },
    });
    expect(input).not.toBeNull();
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
