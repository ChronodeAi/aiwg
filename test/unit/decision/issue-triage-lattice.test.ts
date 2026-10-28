// Synthetic held-out issue-triage inputs for the shared outcome regression table.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIssueTriageEvaluationReport, issueTriageArtifactDigest, pinIssueTriageCalibration,
  validateIssueTriageEvaluationReport } from '../../../src/decision/issue-triage/index.js';
import type { IssueTriageCalibrationRequestRule, IssueTriageCandidateLineage, IssueTriageEvaluationInput,
  IssueTriageEvaluationManifest, IssueTriageEvaluationSample, IssueTriageModelResponse,
  IssueTriagePilotPack, IssueTriageValidatedResponse } from '../../../src/decision/issue-triage/types.js';
import { freezeQualificationSplit, type QualificationSplit } from '../../../src/decision/qualification/quality.js';

const ROOT = resolve(__dirname, '../../..');
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(ROOT, 'test/fixtures/decision/issue-triage', name), 'utf8')) as T;

/** The evaluated pack is the registered fixture pack itself, which the fixture manifest pins by digest. */
const evaluatedPack = (): IssueTriagePilotPack => fixture<IssueTriagePilotPack>('pilot-pack.v1.valid.json');
const pinOf = (pinned: IssueTriagePilotPack) => ({ id: pinned.id, version: pinned.version, digest: issueTriageArtifactDigest(pinned) });
const manifest = (pinned: IssueTriagePilotPack = evaluatedPack()): IssueTriageEvaluationManifest => ({
  ...fixture<IssueTriageEvaluationManifest>('evaluation-manifest.v1.valid.json'),
  pilotPack: pinOf(pinned),
});

const response = (overrides: Partial<IssueTriageModelResponse> = {}): IssueTriageModelResponse => ({
  issueId: 'ISSUE-100',
  issueType: 'bug',
  area: 'decision-engine',
  urgency: 'high',
  completeness: 'complete',
  clarificationNeed: 'not-needed',
  duplicate: { issueId: 'ISSUE-1', rank: 1 },
  uncertaintyProfile: 'typesafe-distribution-v1',
  accepted: true,
  actualModel: 'jev-2026-09-01',
  requestedModel: 'jev-latest',
  latencyMs: 25,
  usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
  usageReceipts: [{ kind: 'jev', requestId: 'req-1', inputTokens: 100, outputTokens: 20, costUsd: 0.01 }],
  calls: { jev: 1, fallbackModel: 0 },
  retries: 0,
  fallbacks: 0,
  cacheHit: false,
  ...overrides,
});

const SLICES = ['bug-supported', 'decision-engine-supported', 'complete-supported', 'authority-injection-supported', 'new-category-supported'];

interface SampleOptions {
  duplicates: number;
  slices?: (index: number) => string[];
  mutate?: (sample: IssueTriageEvaluationSample, index: number) => void;
}

function sampleLineage(index: number): IssueTriageCandidateLineage {
  const candidates = ['a', 'b', 'c'].map((suffix, position) => ({
    issueId: `OLD-${index}-${suffix}`,
    repository: 'aiwg',
    title: `Older issue ${index}${suffix}`,
    rank: position + 1,
    score: 0.6 - position * 0.2,
    sourceDigest: issueTriageArtifactDigest({ index, suffix }),
  }));
  return { generator: 'deterministic-token-overlap-v1', queryDigest: issueTriageArtifactDigest({ index }), candidates, noneOutcome: 'none' };
}

function cascadeOf(base: IssueTriageModelResponse): IssueTriageValidatedResponse {
  return { ...base, acceptance: { acceptedScoring: true, reason: 'compatible', driftEvent: null, compatibility: null } };
}

function buildSamples(count: number, options: SampleOptions): IssueTriageEvaluationSample[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `S-${String(index).padStart(3, '0')}`;
    const duplicate = index < options.duplicates;
    const dup = duplicate ? { issueId: `OLD-${index}-a`, rank: 1 } : { issueId: 'none' as const, rank: null };
    const sample: IssueTriageEvaluationSample = {
      id,
      lineage: sampleLineage(index),
      label: {
        id,
        issueType: 'bug',
        area: 'decision-engine',
        urgency: 'high',
        completeness: 'complete',
        clarificationNeed: 'not-needed',
        duplicateOf: duplicate ? `OLD-${index}-a` : 'none',
        slices: options.slices ? options.slices(index) : [...SLICES],
        useful: true,
        reviewerWouldOverride: false,
        reviewerTimeBaselineMinutes: 4,
        reviewerTimeCascadeMinutes: 2,
      },
      baseline: response({
        issueId: id, duplicate: dup, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, usageReceipts: [],
        calls: { jev: 0, fallbackModel: 0 },
      }),
      cascade: cascadeOf(response({
        issueId: id, duplicate: dup,
        usageReceipts: [{ kind: 'jev', requestId: `req-${id}`, inputTokens: 100, outputTokens: 20, costUsd: 0.01 }],
      })),
    };
    options.mutate?.(sample, index);
    return sample;
  });
}

function splitsFor(samples: readonly IssueTriageEvaluationSample[]): QualificationSplit[] {
  return [
    freezeQualificationSplit('tuning', ['TUNE-1', 'TUNE-2']),
    freezeQualificationSplit('calibration', ['CAL-1', 'CAL-2']),
    freezeQualificationSplit('test', samples.map(sample => sample.id)),
  ];
}

function gatedManifest(splits: readonly QualificationSplit[], thresholds: Partial<IssueTriageEvaluationManifest['thresholds']> = {},
  slices?: IssueTriageEvaluationManifest['slices'], pinned: IssueTriagePilotPack = evaluatedPack()): IssueTriageEvaluationManifest {
  const base = manifest(pinned);
  return {
    ...base,
    dataset: {
      ...base.dataset,
      splitDigests: {
        tuning: splits.find(split => split.name === 'tuning')!.digest,
        calibration: splits.find(split => split.name === 'calibration')!.digest,
        test: splits.find(split => split.name === 'test')!.digest,
      },
    },
    slices: slices ?? base.slices,
    thresholds: {
      ...base.thresholds,
      maximumFalseDuplicateRate: 0.05,
      maximumFalseAutoRate: 0.05,
      qualityNonInferiorityMargin: -0.05,
      minimumAcceptedCoverage: 0.5,
      confidenceInterval: { method: 'wilson', level: 0.95 },
      minimumTotalSamples: 20,
      minimumPerSliceSamples: 1,
      minimumDuplicateSamples: 30,
      minimumDuplicateRecall: 0.8,
      benefit: { mustBePositive: true, metric: 'reviewer-time' },
      ...thresholds,
    },
  };
}

const reportCalibration = (): IssueTriageEvaluationInput['calibration'] => ({
  requestedModel: 'jev-latest', compatibleActualModels: ['jev-2026-09-01'], uncertaintyProfile: 'typesafe-distribution-v1',
});

/** Preregistered rule for per-sample calibration requests: runId binds each request to its sample. */
const calibrationRequestRule: IssueTriageCalibrationRequestRule = {
  requestedAlias: 'jev-latest',
  runIdPrefix: 'run-',
  calibrationArtifactId: 'triage-cal-1',
  notBefore: '2026-09-01T00:00:00.000Z',
};

function reportInput(samples: IssueTriageEvaluationSample[], thresholds: Partial<IssueTriageEvaluationManifest['thresholds']> = {},
  extra: { pack?: IssueTriagePilotPack; slices?: IssueTriageEvaluationManifest['slices']; splits?: QualificationSplit[];
    calibration?: IssueTriageEvaluationInput['calibration'] } = {}): IssueTriageEvaluationInput {
  const calibration = extra.calibration ?? reportCalibration();
  const manifest = gatedManifest(splitsFor(samples), thresholds, extra.slices, extra.pack ?? evaluatedPack());
  if (calibration.registry) {
    manifest.calibration = pinIssueTriageCalibration(calibration.registry.registry, calibration.registry.policy, calibrationRequestRule);
  }
  return {
    id: 'triage-report',
    manifest,
    pack: extra.pack ?? evaluatedPack(),
    samples,
    splits: extra.splits ?? splitsFor(samples),
    calibration,
    upstreamDecision: 'PROMOTE',
  };
}

describe('issue triage shared lattice (#2829)', () => {
  it('preserves every upstream and finding combination', () => {
    const samples = buildSamples(120, { duplicates: 40 });
    for (const upstreamDecision of ['PROMOTE', 'HOLD', 'ROLLBACK'] as const) for (const insufficient of [false, true]) {
      const input = { ...reportInput(samples, insufficient ? { minimumTotalSamples: 200 } : {}), upstreamDecision };
      const observed = buildIssueTriageEvaluationReport(input);
      expect(observed.decision).toBe(upstreamDecision === 'ROLLBACK' ? 'ROLLBACK'
        : upstreamDecision === 'HOLD' || insufficient ? 'HOLD' : 'PROMOTE');
      expect(() => validateIssueTriageEvaluationReport(observed, { inputs: input,
        trustedManifestDigest: issueTriageArtifactDigest(input.manifest) })).not.toThrow();
    }
  });
});
