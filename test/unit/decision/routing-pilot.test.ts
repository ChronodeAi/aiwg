import { describe, expect, it, vi } from 'vitest';
import {
  buildRoutingShadowReport,
  checkRoutingSchema,
  runRoutingControlDrill,
  runRoutingPilot,
  routingDigest,
  validateRoutingPolicy,
  type AliasEvent,
  type DecisionChampionChallenger,
  type DecisionDriftResponse,
  type DriftSignal,
  type JevRoutingEvidence,
  type RouteCandidate,
  type RoutingEvalIntegrityMetadata,
  type RoutingPolicy,
  type RoutingShadowArmObservation,
  type RoutingTask,
} from '../../../src/decision/index.js';
import { records } from './ensemble-fixtures.js';

const hash = (char: string) => `sha256:${(/[0-9a-f]/.test(char) ? char : 'a').repeat(64)}` as const;

function candidate(id: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    id,
    binding: { id: `${id}-binding`, version: '1.0.0', digest: hash(id[0] ?? 'a') },
    model: { provider: 'openai', backend: 'chat', requested: `${id}-model`, pinnedVersion: `${id}-2026-09` },
    subagent: { id: `${id}-worker`, version: '1.0.0', digest: hash(id[1] ?? 'b') },
    capabilities: ['code', 'docs'],
    permissions: { tools: ['read'], network: false, filesystem: 'read', secrets: [], actions: ['advise'] },
    policy: {
      privacy: ['internal'],
      authorizationScopes: ['issue-worker'],
      regions: ['us'],
      contextBytes: 16_000,
      allowlisted: true,
      executable: true,
    },
    operations: {
      health: 'healthy',
      latencyMsP95: 100,
      priceCatalogVersion: 'prices-2026-09',
      costMicrosPerAttempt: 100,
      maxAttempts: 1,
      deadlineMs: 500,
    },
    ...overrides,
  };
}

function policy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    schemaVersion: 'decision-routing-policy/v1',
    id: 'routing-pilot',
    version: '1.0.0',
    mode: 'shadow',
    policyVersion: 'routing-shadow-2026-09',
    candidates: [candidate('cheap'), candidate('reasoning', {
      capabilities: ['code', 'docs', 'deep-reasoning'],
      operations: { ...candidate('reasoning').operations, latencyMsP95: 250, costMicrosPerAttempt: 500 },
    })],
    defaultRouteId: 'reasoning',
    deterministicFallbackRouteId: 'reasoning',
    utility: { taskFit: 100, complexityFit: 25, ambiguityPenalty: 10, latencyPenalty: 0.001, costPenalty: 0.001, healthPenalty: 50 },
    ceilings: { maxAttempts: 3, maxFallbacks: 2, maxCostMicros: 1_000, deadlineMs: 2_000, retryDelayMs: 10, unknownCost: 'reject' },
    jevEvidence: { enabled: true, calibrationRequired: true, compatibleProfiles: ['typesafe-route-fit-v1'], uncertaintyThresholdBps: 500 },
    ...overrides,
  };
}

function task(overrides: Partial<RoutingTask['requirements']> = {}): RoutingTask {
  return {
    id: 'task-1',
    description: 'Update decision docs and tests',
    requirements: {
      capabilities: ['code'],
      privacy: 'internal',
      authorizationScopes: ['issue-worker'],
      region: 'us',
      tools: ['read'],
      contextBytes: 1_024,
      allowlist: ['cheap', 'reasoning'],
      maxCostMicros: 1_000,
      deadlineMs: 2_000,
      ...overrides,
    },
    state: { text: 'safe synthetic task text', secret: 'must-not-cross' },
    projection: {
      version: '1.0.0', provider: 'jev', model: 'router', origin: 'https://api.typesafe.ai', region: 'us',
      purpose: 'routing', allowIncompleteContext: false,
      fields: [{ pointer: '/text', output: 'text', source: 'unit-test', subject: 'task-1', trust: 'untrusted',
        sensitivity: 'internal', purpose: 'routing', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'],
        exportPolicy: 'sanitized', deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['jev'],
        allowedModels: ['router'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] }],
    },
  };
}

function evidence(distributions: JevRoutingEvidence['distributions'] = [
  { routeId: 'cheap', taskFit: 0.9, reasoningNeed: 0.3 },
  { routeId: 'reasoning', taskFit: 0.85, reasoningNeed: 0.9 },
]): JevRoutingEvidence {
  return {
    schemaVersion: 'decision-routing-jev-evidence/v1',
    provider: 'jev',
    model: 'router',
    profile: 'typesafe-route-fit-v1',
    calibration: 'calibrated',
    provenance: { adapterVersion: '1.0.0', requestDigest: hash('1'), responseDigest: hash('2') },
    taskComplexity: 0.35,
    ambiguity: 0.1,
    distributions,
  };
}

function integrity(decision: RoutingEvalIntegrityMetadata['release_gate']['decision'] = 'PROMOTE'): RoutingEvalIntegrityMetadata {
  return {
    sample_n: 4,
    uncertainty: { method: 'wilson', level: 0.95 },
    paired_baseline: { arm: 'fixed' },
    integrity_mode: 'isolated',
    fresh_workspace_required: true,
    fresh_workspace_verified: true,
    integrity_state: 'verified',
    trusted_score_source: 'signed-runner',
    compromise_labels: [],
    weak_signal_reason: null,
    release_gate: { decision, reasons: [] },
  };
}

describe('D28 routing pilot (#2620)', () => {
  it('ROUTE-HARD-01 evaluates hard constraints before Jev and hides ineligible routes from evidence', async () => {
    const p = policy({ defaultRouteId: 'cheap', deterministicFallbackRouteId: 'cheap', candidates: [
      candidate('cheap'),
      candidate('private', { policy: { ...candidate('private').policy, privacy: ['restricted'] } }),
      candidate('tooly', { permissions: { ...candidate('tooly').permissions, tools: [] } }),
      candidate('unknown-cost', { operations: { ...candidate('unknown-cost').operations, costMicrosPerAttempt: null } }),
    ] });
    const evidenceSpy = vi.fn(async request => {
      expect(request.candidates.map(item => item.id)).toEqual(['cheap']);
      expect(JSON.stringify(request)).not.toContain('must-not-cross');
      return evidence([{ routeId: 'cheap', taskFit: 0.8, reasoningNeed: 0.2 }]);
    });
    const receipt = await runRoutingPilot(p, task({ allowlist: ['cheap', 'private', 'tooly', 'unknown-cost'] }), {
      enabled: true,
      now: () => 1_000,
      evidence: evidenceSpy,
    });
    expect(receipt.status).toBe('selected');
    expect(() => checkRoutingSchema('receipt', receipt)).not.toThrow();
    expect(receipt.selectedRouteId).toBe('cheap');
    expect(receipt.candidatePins.find(item => item.routeId === 'cheap')).toMatchObject({
      binding: { id: 'cheap-binding' },
      health: 'healthy',
      priceCatalogVersion: 'prices-2026-09',
      costMicrosPerAttempt: 100,
    });
    expect(receipt.excluded.map(item => [item.routeId, item.reasons[0]])).toEqual([
      ['private', 'privacy-denied'],
      ['tooly', 'tool-denied'],
      ['unknown-cost', 'budget-denied'],
    ]);
    expect(evidenceSpy).toHaveBeenCalledOnce();
  });

  it('ROUTE-HARD-02 rejects forged Jev route IDs and cannot grant missing permissions', async () => {
    const p = policy({ defaultRouteId: 'safe', deterministicFallbackRouteId: 'safe', candidates: [
      candidate('safe'),
      candidate('admin', { permissions: { ...candidate('admin').permissions, tools: ['read', 'write-secret'], secrets: ['prod'], actions: ['deploy'] } }),
    ] });
    const t = task({ tools: ['read'], allowlist: ['safe'] });
    const receipt = await runRoutingPilot(p, t, {
      enabled: true,
      evidence: async () => evidence([
        { routeId: 'safe', taskFit: 0.1, reasoningNeed: 0.1 },
        { routeId: 'admin', taskFit: 1, reasoningNeed: 1 },
      ]),
    });
    expect(receipt.status).toBe('review');
    expect(receipt.reason).toBe('malformed-jev-evidence');
    expect(receipt.selectedRouteId).toBeNull();
    expect(receipt.excluded).toEqual([{ routeId: 'admin', reasons: ['allowlist-denied'] }]);
  });

  it('ROUTE-DET-01 selects deterministically for normalized evidence regardless of candidate order', async () => {
    const first = await runRoutingPilot(policy(), task(), { enabled: true, now: () => 1, evidence: async () => evidence() });
    const reversed = policy({ candidates: [...policy().candidates].reverse() });
    const second = await runRoutingPilot(reversed, task(), {
      enabled: true,
      now: () => 1,
      evidence: async () => evidence([...evidence().distributions].reverse()),
    });
    expect(first.selectedRouteId).toBe('cheap');
    expect(second.selectedRouteId).toBe('cheap');
    expect(first.status).toBe(second.status);
  });

  it('ROUTE-REVIEW-01 routes empty eligible sets and uncalibrated evidence to review without dispatch', async () => {
    const evidenceSpy = vi.fn(async () => evidence());
    const dispatch = vi.fn(async () => { throw new Error('dispatch must not run'); });
    const empty = await runRoutingPilot(policy(), task({ allowlist: [] }), {
      enabled: true,
      evidence: evidenceSpy,
      dispatch,
    });
    expect(empty.status).toBe('no-route');
    expect(empty.reason).toBe('empty-eligible-set');
    expect(evidenceSpy).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();

    const uncalibrated = await runRoutingPilot(policy(), task(), {
      enabled: true,
      evidence: async () => ({ ...evidence(), calibration: 'uncalibrated' }),
      dispatch,
    });
    expect(uncalibrated.status).toBe('review');
    expect(uncalibrated.reason).toBe('ambiguous-or-uncalibrated');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ROUTE-OFF-01 is default-off and preserves the existing deterministic route', async () => {
    const existingRoute = () => policy().deterministicFallbackRouteId;
    const before = existingRoute();
    const receipt = await runRoutingPilot(policy({ mode: 'disabled' }), task(), {
      evidence: async () => { throw new Error('must not call Jev while disabled'); },
      dispatch: async () => { throw new Error('must not dispatch while disabled'); },
    });
    const after = existingRoute();
    expect(receipt.status).toBe('disabled');
    expect(receipt.selectedRouteId).toBe('reasoning');
    expect(after).toBe(before);
  });

  it('ROUTE-FALLBACK-01 reserves before dispatch and bounds rate-limit fallback attempts', async () => {
    const p = policy({ defaultRouteId: 'backup', deterministicFallbackRouteId: 'backup', candidates: [
      candidate('cheap'),
      candidate('backup', { operations: { ...candidate('backup').operations, costMicrosPerAttempt: 200 } }),
      candidate('open-circuit', { operations: { ...candidate('open-circuit').operations, health: 'circuit-open' } }),
    ] });
    const calls: string[] = [];
    const delay = vi.fn(async () => undefined);
    const receipt = await runRoutingPilot(p, task({ allowlist: ['cheap', 'backup', 'open-circuit'] }), {
      enabled: true,
      now: () => 1_000,
      reserve: async candidate => { calls.push(`reserve:${candidate.id}`); return true; },
      evidence: async () => evidence([
        { routeId: 'cheap', taskFit: 0.95, reasoningNeed: 0.2 },
        { routeId: 'backup', taskFit: 0.9, reasoningNeed: 0.2 },
      ]),
      delay,
      dispatch: async ({ candidate: selected }) => {
        calls.push(`dispatch:${selected.id}`);
        return selected.id === 'cheap'
          ? { status: 'failure', reason: 'rate-limit', actualProvider: null, actualModel: null, workerId: null,
            inputTokens: 1, outputTokens: 0, costMicros: 10, latencyMs: 5, verified: null, outcomeLabel: null }
          : { status: 'success', reason: 'none', actualProvider: 'openai', actualModel: selected.model.pinnedVersion, workerId: selected.subagent!.id,
            inputTokens: 2, outputTokens: 3, costMicros: 200, latencyMs: 20, verified: true, outcomeLabel: 'ok' };
      },
    });
    expect(calls).toEqual(['reserve:backup', 'reserve:cheap', 'dispatch:cheap', 'dispatch:backup']);
    expect(receipt.selectedRouteId).toBe('backup');
    expect(receipt.attempts.map(item => [item.routeId, item.reason])).toEqual([['cheap', 'rate-limit'], ['backup', 'none']]);
    expect(receipt.excluded).toEqual([{ routeId: 'open-circuit', reasons: ['health-denied'] }]);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it('ROUTE-REPORT-01 applies preregistered quality and net-economics gates without upgrading integrity', () => {
    const thresholds = {
      minimumOverallN: 2,
      minimumSliceN: 1,
      ciMethod: 'wilson' as const,
      ciLevel: 0.95,
      qualityNonInferiorityMargin: 0.01,
      maxFailureRate: 0.1,
      maxReworkRate: 0.1,
      maxFallbackRate: 0.2,
      budgetComplianceRequired: true,
      positiveNetEconomicsRequired: true,
    };
    const obs: RoutingShadowArmObservation[] = [
      { arm: 'fixed', taskId: 'a', slice: 'docs', success: true, rework: false, fallback: false, humanOverride: false, providerCalls: 1, inputTokens: 10, outputTokens: 5, totalCostMicros: 100, latencyMs: 10, accepted: true, policyViolation: false },
      { arm: 'fixed', taskId: 'b', slice: 'code', success: true, rework: false, fallback: false, humanOverride: false, providerCalls: 1, inputTokens: 10, outputTokens: 5, totalCostMicros: 100, latencyMs: 10, accepted: true, policyViolation: false },
      { arm: 'heuristic', taskId: 'a', slice: 'docs', success: true, rework: false, fallback: false, humanOverride: false, providerCalls: 1, inputTokens: 10, outputTokens: 5, totalCostMicros: 100, latencyMs: 10, accepted: true, policyViolation: false },
      { arm: 'heuristic', taskId: 'b', slice: 'code', success: true, rework: false, fallback: false, humanOverride: false, providerCalls: 1, inputTokens: 10, outputTokens: 5, totalCostMicros: 100, latencyMs: 10, accepted: true, policyViolation: false },
      { arm: 'jev-assisted', taskId: 'a', slice: 'docs', success: true, rework: false, fallback: false, humanOverride: false, providerCalls: 2, inputTokens: 12, outputTokens: 5, totalCostMicros: 150, latencyMs: 12, accepted: true, policyViolation: false },
      { arm: 'jev-assisted', taskId: 'b', slice: 'code', success: false, rework: true, fallback: true, humanOverride: true, providerCalls: 2, inputTokens: 12, outputTokens: 5, totalCostMicros: 150, latencyMs: 12, accepted: true, policyViolation: false },
    ];
    const report = buildRoutingShadowReport({
      id: 'routing-shadow-1',
      policy: { id: 'routing-pilot', version: '1.0.0', digest: hash('9') },
      thresholds,
      registeredAt: '2026-09-01T00:00:00.000Z',
      holdoutAccessedAt: null,
      observations: obs,
      integrity: integrity('HOLD'),
    });
    expect(report.decision).toBe('HOLD');
    expect(report.reasons).toEqual(expect.arrayContaining(['failure-rate', 'net-economics', 'quality-non-inferiority']));
    expect(report.comparisons.netSavingsMicros).toBe(-100);
  });

  it('ROUTE-D17-01 uses D17 drift and rollback APIs for future runs without changing active pins', async () => {
    const record = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09')!;
    const driftPolicy = records<DecisionDriftResponse>('drift-response.v1.valid.json').get('triage-drift-response')!;
    const history: AliasEvent[] = [{
      revision: 1,
      alias: record.alias,
      actualIdentityDigest: record.champion.identityDigest,
      actualModel: record.champion.actualModel,
      recordedAt: '2026-09-01T00:00:00.000Z',
      kind: 'observed',
      promotionEligibilityId: null,
    }, {
      // D17 rollback only undoes this record's own promotion, so the drill starts from a promoted challenger.
      revision: 2,
      alias: record.alias,
      actualIdentityDigest: record.challenger.identityDigest,
      actualModel: record.challenger.actualModel,
      recordedAt: '2026-09-15T00:00:00.000Z',
      kind: 'promoted',
      promotionEligibilityId: record.eligibilityId,
    }];
    const signal: DriftSignal = {
      source: 'label-drift',
      id: 'label-drift-1',
      alias: record.alias,
      metric: 'label-error-rate-delta-v1',
      valueBps: 500,
      sampleN: 250,
      thresholdsVersion: driftPolicy.thresholds.version,
      observedAt: '2026-09-29T00:00:00.000Z',
    };
    const rollback = vi.fn((alias: string, targetRevision: number, _approval: string, at: string): AliasEvent => ({
      revision: 3, alias, actualIdentityDigest: record.rollbackTarget.identityDigest, actualModel: record.champion.actualModel,
      recordedAt: at, kind: 'rolled-back', promotionEligibilityId: null,
    }));
    const result = await runRoutingControlDrill({
      championChallenger: record,
      driftPolicy,
      driftSignal: signal,
      aliasHistory: history,
      activeRunIds: ['run-a', 'run-b'],
      approvalReference: 'review-2620',
      gateway: {
        aliasHistory: () => history,
        promoteAlias: () => { throw new Error('promotion is out of scope for rollback drill'); },
        rollbackAlias: rollback,
      },
      at: '2026-09-29T00:00:00.000Z',
    });
    expect(result.driftResponse).toBe('restore-champion');
    expect(rollback).toHaveBeenCalledWith(record.alias, record.rollbackTarget.aliasRevision, 'review-2620', '2026-09-29T00:00:00.000Z');
    expect(result.runPins).toEqual([
      { runId: 'run-a', aliasRevision: 1, identityDigest: record.champion.identityDigest },
      { runId: 'run-b', aliasRevision: 1, identityDigest: record.champion.identityDigest },
    ]);
  });

  it('ROUTE-SCHEMA-01 validates closed routing policy shape', () => {
    expect(() => validateRoutingPolicy(policy())).not.toThrow();
    expect(() => validateRoutingPolicy({ ...policy(), extra: true })).toThrow(/schema/);
    expect(routingDigest(policy())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
