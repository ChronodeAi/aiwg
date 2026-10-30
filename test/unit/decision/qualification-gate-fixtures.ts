import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calibrationArtifactDigest } from '../../../src/decision/calibration/registry.js';
import type { CalibrationArtifact } from '../../../src/decision/calibration/types.js';
import {
  DECISION_GATE_SUITES, loadManifestDigest, qualificationOutcomesDigest,
  type QualificationGateArtifactFlag, type QualificationLoadResult, type QualificationReviewRecord,
} from '../../../src/decision/qualification/gate-evidence.js';
import { expectedQualificationCaseIds } from '../../../src/decision/qualification/manifest.js';
import { freezeBinaryBenchmarkPlan, freezeQualificationSplit } from '../../../src/decision/qualification/quality.js';
import { decisionLoadArrivals, decisionStagedLoadResultRecord, type DecisionLoadManifestV3, type DecisionLoadObservations } from '../../../src/decision/qualification/load.js';
import type { QualificationCase, QualificationEvidence } from '../../../src/decision/qualification/types.js';

/**
 * Synthetic gate artifacts for runner-mechanics tests only. They satisfy the
 * artifact validators so a test can reach PROMOTE; they are not release evidence.
 */
const hash = (value: string) => `sha256:${value.repeat(64)}` as const;

/** All 67 cases, with each suite's required named evidence attached to that suite's first case. */
export function syntheticCases(): QualificationCase[] {
  const named = new Map<string, Set<string>>();
  for (const suite of Object.values(DECISION_GATE_SUITES)) {
    const ids = named.get(suite.caseIds[0]!) ?? new Set<string>();
    for (const id of suite.evidenceIds ?? []) ids.add(id);
    named.set(suite.caseIds[0]!, ids);
  }
  return expectedQualificationCaseIds().map(id => ({
    id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const, mandatory: true, candidateTests: [],
    ...(named.get(id)?.size ? { evidenceIds: [...named.get(id)!].sort() } : {}),
  }));
}

export interface GateArtifactRun {
  runId: string;
  sourceCommit: string;
  generatedAt: string;
  /** Expected outcomes the reviewer signs; defaults to every case passing. */
  evidence?: Array<Pick<QualificationEvidence, 'caseId' | 'executable' | 'outcome' | 'testEvidenceIds'>>;
  cases?: QualificationCase[];
}

export function syntheticSplitPlan() {
  const ids = (prefix: string) => Array.from({ length: 4 }, (_, index) => `${prefix}-${index}`);
  const splits = [freezeQualificationSplit('tuning', ids('tune')), freezeQualificationSplit('calibration', ids('cal')),
    freezeQualificationSplit('test', ids('test'))];
  const labels = splits.flatMap(split => split.ids.map((id, index) => ({ id, label: (index % 2) as 0 | 1, slice: 'synthetic' })));
  return freezeBinaryBenchmarkPlan(splits, labels, { minimumOverallN: 4, minimumSliceN: 4,
    maximumSelectiveRisk: 0.5, maximumReviewRate: 0.5, maximumBrier: 0.5 });
}

export function syntheticCalibration(splitDigest: `sha256:${string}`, overrides: Partial<Omit<CalibrationArtifact, 'digest'>> = {}): CalibrationArtifact {
  const payload: Omit<CalibrationArtifact, 'digest'> = {
    schemaVersion: 'decision-calibration-artifact/v1', id: 'calibration:synthetic-gate',
    identity: { provider: 'jev', backend: 'api', actualModel: 'jev-synthetic', primitive: 'choice', definitionDigest: hash('a'),
      adapterVersion: 'prompt-v1', dataset: { id: 'synthetic', hash: hash('b') }, slice: { id: 'synthetic', hash: hash('c') },
      calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') } },
    splitProvenance: { id: 'synthetic-split', hash: splitDigest, holdoutAccessedAt: null },
    profile: { minimumTotalSamples: 10, minimumPerSliceSamples: 4, powerRule: null,
      confidenceInterval: { method: 'bootstrap-bca', level: 0.95 }, maximumCalibrationError: 0.1,
      maximumSelectiveRisk: 0.1, expiresAfterDays: 30 },
    metrics: { totalSamples: 12, perSliceSamples: 4, calibrationError: 0.05, selectiveRisk: 0.05,
      confidenceIntervals: { ece: { lower: 0.01, upper: 0.08 } } },
    effectiveAt: '2026-09-01T00:00:00.000Z', limitations: ['Synthetic runner-mechanics fixture; not release evidence.'],
    approval: { state: 'approved', reference: 'approval:synthetic' }, ...overrides,
  };
  return { ...payload, digest: calibrationArtifactDigest(payload) };
}

export function syntheticLoadResult(observations?: Record<string, number>): QualificationLoadResult {
  const manifest = { schema: 'decision-load-manifest/v1' as const, mode: 'offline-fake-provider',
    bounds: { maximumActiveCalls: 3, maximumQueuedCalls: 128, maximumRetryAmplificationRatio: 1.25 } };
  return { schemaVersion: 'decision-load-result/v1', manifestDigest: loadManifestDigest(manifest), manifest,
    mode: manifest.mode, observations: observations ?? { maximumActiveCalls: 3, maximumQueuedCalls: 40, maximumRetryAmplificationRatio: 1 },
    recordedAt: '2026-09-02T00:00:00.000Z' };
}

/** Declared live-shaped synthetic data for validator mechanics; this never dispatches calls. */
export function syntheticStagedLoadResult(sourceCommit: string, execution: 'live' | 'offline-fake-provider' = 'live',
  observations: Partial<DecisionLoadObservations> = {}) {
  const manifestBytes = readFileSync(new URL('../../../docs/decision/load-manifest.v3.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestBytes) as DecisionLoadManifestV3;
  if (manifest.schema !== 'decision-load-manifest/v3') throw new Error('synthetic staged fixture requires manifest v3');
  const phases = ['shadow', 'canary', 'rollback'] as const;
  const window = manifest.duration.loadSeconds + manifest.duration.spikeSeconds + manifest.duration.soakSeconds;
  const phaseStartMs = { shadow: 0, canary: manifest.rollout.shadowSeconds * 1000,
    rollback: (manifest.rollout.shadowSeconds + window) * 1000 };
  const stages = phases.map(phase => {
    const windowSeconds = phase === 'canary' ? window : phase === 'shadow' ? manifest.rollout.shadowSeconds : manifest.rollout.rollbackSeconds;
    const arrivals = decisionLoadArrivals(manifest, windowSeconds);
    const atTimes = new Map<number, number>();
    for (const arrival of arrivals) atTimes.set(arrival.atMs, (atTimes.get(arrival.atMs) ?? 0) + 1);
    return { phase, profileVersion: phase === 'rollback' ? manifest.rollout.previousProfileVersion : manifest.profileVersion,
      windowSeconds, observations: { arrivals: arrivals.length, attempts: arrivals.length, completed: arrivals.length,
        failed: 0, shed: 0, cancelled: 0, shedReasons: {}, maximumActiveCalls: Math.max(0, ...atTimes.values()),
        maximumQueuedCalls: 0, maximumEligibleLaneWaitMs: 0, retryAmplificationRatio: 1,
        maximumCancellationLatencyMs: 0, quietPrincipalAdmissionRatio: 1, noisyPrincipalAdmissionRatio: 1,
        virtualDurationMs: windowSeconds * 1000, ...observations },
      resources: { heapUsedMiB: 1, residentMemoryMiB: 1, cpuPercentOneCore: 1, cpuSource: 'thread' as const },
      scopes: Object.fromEntries(['workspace', ...Object.keys(manifest.providers).map(id => `provider.${id}`),
        ...manifest.principals.map(principal => `principal.${principal.id}`)].map(id => [id, { active: 1, queued: 0 }])),
    };
  });
  const receipts = stages.flatMap(({ phase, windowSeconds }) => decisionLoadArrivals(manifest, windowSeconds).map(arrival => {
    const costUsd = arrival.tokens * 0.042 / 1_000_000;
    return { phase, arrivalOrdinal: arrival.ordinal, principalId: arrival.principalId, providerId: arrival.providerId, attempt: 1,
      admittedAtMs: phaseStartMs[phase] + arrival.atMs, settledAtMs: phaseStartMs[phase] + arrival.atMs + 1,
      tokens: arrival.tokens, costUsd,
      admission: { decision: 'admit' as const, reason: 'admitted' as const, queueDelayMs: 0, active: 1, queued: 0,
        estimatedTokens: arrival.tokens, estimatedCostUsd: costUsd, retryPressure: 0, breakerState: 'closed' as const },
      status: 'success' as const, reason: 'none' as const, usage: { inputTokens: arrival.tokens, outputTokens: 0, costUsd },
    };
  }));
  const elapsedMs = (window + manifest.rollout.shadowSeconds + manifest.rollout.rollbackSeconds) * 1000;
  const samples = Array.from({ length: Math.floor(elapsedMs / manifest.sampleIntervalMs) + 1 }, (_, index) => ({
    atMs: index * manifest.sampleIntervalMs, residentMemoryMiB: 1, heapUsedMiB: 1, cpuPercentOneCore: 1, active: 0, queued: 0,
  }));
  const previousDigest = loadManifestDigest({ workspace: manifest.rollout.workspace, providers: manifest.rollout.providers });
  const activeDigest = loadManifestDigest({ workspace: manifest.workspace, providers: manifest.providers });
  return decisionStagedLoadResultRecord({ manifestBytes, execution, mode: 'staged-provider', sourceCommit, dirty: false,
    host: { hostname: 'synthetic', cpuClass: 'synthetic-16-core', memoryGiB: 30, networkPath: 'synthetic-offline',
      node: process.version, platform: process.platform, arch: process.arch },
    pricing: { jev_input_per_mtok: 0.042, jev_output_per_mtok: 0, source: 'typesafe-docs',
      checked_at: '2026-10-25', jev_model: 'jev-1.14.0' },
    stages, receipts,
    samples,
    profileHistory: [
      { schema: 'decision-admission-profile-change/v1', workspaceId: 'synthetic', kind: 'initial',
        previousProfileVersion: null, profileVersion: manifest.rollout.previousProfileVersion, digest: previousDigest, atEpochMs: 0 },
      { schema: 'decision-admission-profile-change/v1', workspaceId: 'synthetic', kind: 'change',
        previousProfileVersion: manifest.rollout.previousProfileVersion, profileVersion: manifest.profileVersion, digest: activeDigest, atEpochMs: 0 },
      { schema: 'decision-admission-profile-change/v1', workspaceId: 'synthetic', kind: 'rollback',
        previousProfileVersion: manifest.profileVersion, profileVersion: manifest.rollout.previousProfileVersion, digest: previousDigest, atEpochMs: phaseStartMs.rollback },
    ], breakerTransitions: [], reservedUsage: { calls: receipts.length, tokens: receipts.reduce((sum, receipt) => sum + receipt.tokens, 0),
      usd: receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0) },
    stop: null, startedAtMs: 0, elapsedMs,
  });
}

export function syntheticReview(run: GateArtifactRun, overrides: Partial<QualificationReviewRecord> = {}): QualificationReviewRecord {
  const cases = run.cases ?? syntheticCases();
  const evidence = run.evidence ?? cases.map(item => ({ caseId: item.id, executable: true, outcome: 'pass' as const,
    testEvidenceIds: [...(item.evidenceIds ?? [])].sort() }));
  return { schemaVersion: 'decision-qualification-review/v1', runId: run.runId, sourceCommit: run.sourceCommit,
    outcomesDigest: qualificationOutcomesDigest({ runId: run.runId, sourceCommit: run.sourceCommit,
      evidence: evidence.map(item => ({ ...item, artifact: null, digest: null })) }),
    reviewer: 'synthetic-reviewer', decision: 'approve', recordedAt: '2026-09-03T00:00:00.000Z', ...overrides };
}

/** Writes one valid artifact per artifact-backed flag and returns the plan input. */
export async function writeGateArtifacts(dir: string, run: GateArtifactRun,
  omit: readonly QualificationGateArtifactFlag[] = []): Promise<Partial<Record<QualificationGateArtifactFlag, string>>> {
  const plan = syntheticSplitPlan();
  const values: Record<QualificationGateArtifactFlag, unknown> = {
    'immutable-splits': plan,
    'calibration-qualified': syntheticCalibration(plan.digest),
    'load-manifest-qualified': syntheticStagedLoadResult(run.sourceCommit),
    'review-decision-recorded': syntheticReview(run),
  };
  const paths: Partial<Record<QualificationGateArtifactFlag, string>> = {};
  for (const [flag, value] of Object.entries(values) as Array<[QualificationGateArtifactFlag, unknown]>) {
    if (omit.includes(flag)) continue;
    const path = join(dir, `${flag}.source.json`);
    await writeFile(path, `${JSON.stringify(value)}\n`);
    paths[flag] = path;
  }
  return paths;
}
