import { createHash } from 'node:crypto';
import {
  CalibrationRegistry, SDLC_GATE_EVIDENCE_POLICY_KIND, SDLC_SCREENING_HELDOUT_RECORDS_VERSION,
  SDLC_SCREENING_PREREGISTRATION_VERSION, SDLC_SCREENING_SCHEMA_VERSION, artifactPin, calibrationArtifactDigest,
  freezeQualificationSplit, sdlcScreeningPreregistrationDigest,
  type CalibrationArtifact, type CalibrationIdentity, type QualificationIntegrityMetadata, type QualificationSplit,
  type SdlcCitationObservation, type SdlcCitationSubject, type SdlcGateEvidencePolicy, type SdlcPhaseCriterionObservation,
  type SdlcPhaseCriterionSubject, type SdlcScreeningHeldoutRecords, type SdlcScreeningHeldoutSample,
  type SdlcScreeningInventory, type SdlcScreeningPreregistration, type SdlcScreeningRequest, type SdlcScreeningTrustContext,
} from '../../../src/decision/index.js';
import { canonicalJson } from '../../../src/security/artifact-trust.js';

export const digest = (char: string) => `sha256:${char.repeat(64)}` as `sha256:${string}`;
export const contentDigest = (content: string) =>
  `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}` as `sha256:${string}`;
export const MODEL = 'offline:bounded';
export const SOURCE_CONTENT = 'The service listens on port 8443 (verified text).';

export const inventory: SdlcScreeningInventory = {
  claimIds: ['claim:port'],
  requirementIds: ['FR-022'],
  sourceIds: ['source:atlas'],
  locators: ['doc:atlas#port'],
  criterionIds: ['G2.security-evidence', 'G3.release-evidence'],
  evidenceIds: ['artifact:threat-model', 'test:security', 'approval:release', 'sig:artifact', 'schema:gate', 'artifact:g3', 'artifact:extra'],
};

export const G2_REQUIRED = ['artifact:threat-model', 'test:security', 'approval:release', 'sig:artifact', 'schema:gate'];

export const gatePolicy = (required: string[] = G2_REQUIRED): SdlcGateEvidencePolicy => ({
  kind: SDLC_GATE_EVIDENCE_POLICY_KIND,
  metadata: { id: 'policy:sdlc-gates', version: '1.0.0' },
  spec: {
    requiredEvidenceByCriterion: { 'G2.security-evidence': required, 'G3.release-evidence': ['artifact:g3'] },
    evidenceSubjects: {
      'artifact:threat-model': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
      'test:security': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
      'approval:release': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
      'sig:artifact': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
      'schema:gate': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
      'artifact:extra': { kind: 'phase-criterion', criterionId: 'G2.security-evidence' },
      'artifact:g3': { kind: 'phase-criterion', criterionId: 'G3.release-evidence' },
      'source:atlas': { kind: 'citation', claimId: 'claim:port', sourceId: 'source:atlas', locator: 'doc:atlas#port',
        trust: 'verified', sensitivity: 'internal' },
    },
  },
});

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const identity = (actualModel = MODEL): CalibrationIdentity => ({
  provider: 'jev', backend: 'api', actualModel, primitive: 'choice', definitionDigest: hash('a'), adapterVersion: 'prompt-v1',
  dataset: { id: 'sdlc', hash: hash('b') }, slice: { id: 'gate', hash: hash('c') },
  calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') },
});

export function calibration(options: { approved?: boolean; model?: string } = {}): SdlcScreeningTrustContext['calibration'] {
  const payload: Omit<CalibrationArtifact, 'digest'> = {
    schemaVersion: 'decision-calibration-artifact/v1', id: 'cal-sdlc', identity: identity(),
    splitProvenance: { id: 'split-1', hash: hash('e'), holdoutAccessedAt: '2026-09-02T00:00:00.000Z' },
    profile: { minimumTotalSamples: 100, minimumPerSliceSamples: 40, powerRule: null,
      confidenceInterval: { method: 'wilson', level: 0.95 }, maximumCalibrationError: 0.08,
      maximumSelectiveRisk: 0.05, expiresAfterDays: 30 },
    metrics: { totalSamples: 200, perSliceSamples: 80, calibrationError: 0.04, selectiveRisk: 0.02,
      confidenceIntervals: { ece: { lower: 0.02, upper: 0.06 } } },
    effectiveAt: '2026-09-01T00:00:00.000Z',
    limitations: ['Synthetic SDLC screening calibration fixture.'],
    approval: options.approved === false ? { state: 'observed', reference: null } : { state: 'approved', reference: 'review-29' },
  };
  const registry = new CalibrationRegistry();
  registry.registerArtifact({ ...payload, digest: calibrationArtifactDigest(payload) });
  registry.observeAlias('jev-latest', identity(), '2026-09-01T00:00:00.000Z');
  return {
    registry,
    request: { runId: 'sdlc-run', requestedAlias: 'jev-latest', actualIdentity: identity(options.model ?? MODEL),
      calibrationArtifactId: 'cal-sdlc', at: '2026-09-10T00:00:00.000Z' },
    policy: { unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' },
  };
}

export const trust = (overrides: Partial<SdlcScreeningTrustContext> = {}): SdlcScreeningTrustContext => {
  const policy = gatePolicy();
  return { gatePolicyPin: artifactPin(policy), gatePolicies: [policy], calibration: calibration(), ...overrides };
};

export const citationSubject = (overrides: Partial<SdlcCitationSubject['evidence'][number]> = {}): SdlcCitationSubject => ({
  kind: 'citation',
  subjectId: 'citation:claim:port/source:atlas',
  claimId: 'claim:port',
  requirementIds: ['FR-022'],
  sourceId: 'source:atlas',
  locator: 'doc:atlas#port',
  evidence: [{
    id: 'source:atlas', version: '1.0.0', digest: digest('a'),
    locator: 'doc:atlas#port', locatorExists: true, retrieved: true,
    content: SOURCE_CONTENT, contentDigest: contentDigest(SOURCE_CONTENT), provenanceVerified: true, publicationAuthorized: true,
    trust: 'verified', sensitivity: 'internal', ...overrides,
  }],
});

/** A native provider distribution with `selectedBps` on the selected option and the rest spread evenly. */
export function nativeDistribution(options: readonly string[], selected: string, selectedBps: number): Record<string, number> {
  const others = options.filter(option => option !== selected);
  const remaining = (10_000 - selectedBps) / 10_000;
  return Object.fromEntries(options.map(option => [option, option === selected ? selectedBps / 10_000 : remaining / others.length]));
}

export const SUPPORT_OPTIONS = ['supports', 'does-not-support', 'contradicts', 'unclear'] as const;
export const CRITERION_OPTIONS = {
  relevance: ['relevant', 'irrelevant', 'unclear'],
  completeness: ['complete', 'incomplete', 'unclear'],
  contradiction: ['none', 'present', 'unclear'],
  ambiguity: ['low', 'high', 'unclear'],
  reviewerAttention: ['needed', 'not-needed'],
} as const;

export const citationObservation = (overrides: Partial<SdlcCitationObservation> = {}): SdlcCitationObservation => {
  const support = overrides.support ?? 'supports';
  const confidenceBps = overrides.confidenceBps ?? 9_100;
  return {
    kind: 'citation', claimId: 'claim:port', sourceId: 'source:atlas', locator: 'doc:atlas#port',
    support, supportDistribution: nativeDistribution(SUPPORT_OPTIONS, support, confidenceBps),
    supportStrengthBps: 9_200, injection: 'no', confidenceBps, model: MODEL, attempts: 1, ...overrides,
  };
};

export const criterionItem = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, version: '1', digest: digest('c'),
  type: (id.startsWith('test') ? 'test-result' : id.startsWith('approval') ? 'approval' : id.startsWith('sig') ? 'signature'
    : id.startsWith('schema') ? 'schema' : 'artifact') as SdlcPhaseCriterionSubject['evidence'][number]['type'],
  required: true, present: true, passed: true, ...overrides,
}) as SdlcPhaseCriterionSubject['evidence'][number];

export const criterionSubject = (failed = false): SdlcPhaseCriterionSubject => ({
  kind: 'phase-criterion',
  subjectId: 'criterion:G2.security-evidence',
  criterionId: 'G2.security-evidence',
  requirementIds: ['FR-022'],
  evidence: [
    criterionItem('artifact:threat-model'),
    criterionItem('test:security', { passed: !failed }),
    criterionItem('approval:release', { expiresAtEpochMs: 2_000 }),
    criterionItem('sig:artifact'),
    criterionItem('schema:gate'),
  ],
});

export const criterionObservation = (
  overrides: Partial<SdlcPhaseCriterionObservation> = {},
  evidenceIds: string[] = G2_REQUIRED,
): SdlcPhaseCriterionObservation => {
  const answers = {
    relevance: overrides.relevance ?? 'relevant', completeness: overrides.completeness ?? 'complete',
    contradiction: overrides.contradiction ?? 'none', ambiguity: overrides.ambiguity ?? 'low',
    reviewerAttention: overrides.reviewerAttention ?? 'not-needed',
  } as const;
  const confidenceBps = overrides.confidenceBps ?? 9_300;
  return {
    kind: 'phase-criterion', criterionId: 'G2.security-evidence', evidenceIds, ...answers,
    distributions: Object.fromEntries(Object.entries(answers).map(([field, value]) =>
      [field, nativeDistribution(CRITERION_OPTIONS[field as keyof typeof CRITERION_OPTIONS], value, confidenceBps)])),
    confidenceBps, model: MODEL, attempts: 1, ...overrides,
  };
};

export const request = (
  subject: SdlcScreeningRequest['subject'],
  observation: SdlcScreeningRequest['observation'],
  overrides: Partial<SdlcScreeningRequest> = {},
): SdlcScreeningRequest => ({
  schemaVersion: SDLC_SCREENING_SCHEMA_VERSION, mode: 'advisory', inventory, gatePolicyPin: artifactPin(gatePolicy()),
  subject, ...(observation ? { observation } : {}), nowEpochMs: 1_000, ...overrides,
});

// Held-out fixtures: 120 citation samples across two slices plus 60 criterion samples.
export const HELDOUT_NOW = Date.parse('2026-10-15T00:00:00.000Z');

export function heldoutSamples(): SdlcScreeningHeldoutSample[] {
  const samples: SdlcScreeningHeldoutSample[] = [];
  const labels = ['supports', 'contradicts', 'unclear', 'does-not-support'] as const;
  for (let index = 0; index < 120; index++) {
    const gold = labels[index % labels.length]!;
    const ready = gold === 'supports';
    samples.push({
      id: `c-${String(index).padStart(3, '0')}`, kind: 'citation', slice: index % 2 ? 'citation:web' : 'citation:repo',
      gold: { ready, support: gold },
      candidate: { route: ready ? 'ADVISORY_READY' : 'REVIEW', support: gold, readyProbability: ready ? 0.9 : 0.1,
        latencyMs: 100 + index, inputTokens: 100, outputTokens: 10, costUsd: 0.001, calls: 1, retries: 0, fallbacks: 0 },
      baseline: { correct: true, costUsd: 0.01 },
      reviewer: { agreed: true, overridden: false },
    });
  }
  for (let index = 0; index < 60; index++) {
    const ready = index % 2 === 0;
    samples.push({
      id: `g-${String(index).padStart(3, '0')}`, kind: 'phase-criterion', slice: 'gate:blocking',
      gold: { ready, support: null },
      candidate: { route: ready ? 'ADVISORY_READY' : 'REVIEW', support: null, readyProbability: ready ? 0.9 : 0.1,
        latencyMs: 200, inputTokens: 100, outputTokens: 10, costUsd: 0.001, calls: 1, retries: 0, fallbacks: 0 },
      baseline: { correct: true, costUsd: 0.01 },
      reviewer: null,
    });
  }
  return samples;
}

export function heldoutSplits(ids: readonly string[]): QualificationSplit[] {
  return [
    freezeQualificationSplit('tuning', ['tune-1']),
    freezeQualificationSplit('calibration', ['cal-1']),
    freezeQualificationSplit('test', ids),
  ];
}

export function heldoutRecords(samples = heldoutSamples(), evaluatedAt = '2026-10-01T00:00:00.000Z'): SdlcScreeningHeldoutRecords {
  return { schemaVersion: SDLC_SCREENING_HELDOUT_RECORDS_VERSION, evaluatedAt, splits: heldoutSplits(samples.map(sample => sample.id)), samples };
}

export function preregistration(overrides: Partial<SdlcScreeningPreregistration> = {}): SdlcScreeningPreregistration {
  const test = heldoutSplits(heldoutSamples().map(sample => sample.id)).find(split => split.name === 'test')!;
  return {
    schemaVersion: SDLC_SCREENING_PREREGISTRATION_VERSION,
    planId: 'D29-offline-shadow-v1',
    frozenAt: '2026-09-29T00:00:00.000Z',
    heldoutSplitDigest: test.digest,
    slices: ['citation:repo', 'citation:web', 'gate:blocking'],
    gateBlockingSlices: ['gate:blocking'],
    maximumFalseSupportRateBps: 500,
    maximumFalseReadyRateBps: 500,
    minimumTotalSupport: 100,
    minimumSliceSupport: 20,
    minimumGateBlockingSliceSupport: 40,
    confidenceInterval: { method: 'wilson', levelBps: 9_500 },
    // All-concordant 180 pairs give a Newcombe 95% lower bound of -209 bps, so the margin is 300.
    qualityNonInferiorityBps: 300,
    efficiencyClaim: { enabled: true, minimumPositiveTotalEconomicsUsd: 0.5 },
    ...overrides,
  };
}

export const anchored = (plan: SdlcScreeningPreregistration) => sdlcScreeningPreregistrationDigest(plan);

export const verifiedIntegrity = (overrides: Partial<QualificationIntegrityMetadata> = {}): QualificationIntegrityMetadata => ({
  sample_n: 180, uncertainty: { ci: [0.9, 0.97] }, paired_baseline: { id: 'baseline' },
  integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: true,
  integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [],
  weak_signal_reason: null, release_gate: { decision: 'PROMOTE', reasons: [] }, ...overrides,
});
