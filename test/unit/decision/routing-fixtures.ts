import type {
  JevRoutingEvidence,
  RouteCandidate,
  RoutingDispatchResult,
  RoutingEvalIntegrityMetadata,
  RoutingPolicy,
  RoutingPromotionThresholds,
  RoutingShadowArmObservation,
  RoutingTask,
} from '../../../src/decision/index.js';

export const hash = (char: string) => `sha256:${(/[0-9a-f]/.test(char) ? char : 'a').repeat(64)}` as const;

export function candidate(id: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
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

export function withOps(id: string, operations: Partial<RouteCandidate['operations']>, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  const base = candidate(id, overrides);
  return { ...base, operations: { ...base.operations, ...operations } };
}

export function policy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
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

export function task(overrides: Partial<RoutingTask['requirements']> = {}, extra: Partial<RoutingTask> = {}): RoutingTask {
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
      providers: ['openai'],
      authorized: { tools: ['read'], network: false, filesystem: 'read', secrets: [], actions: ['advise'] },
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
    ...extra,
  };
}

export function evidence(distributions: JevRoutingEvidence['distributions'] = [
  { routeId: 'cheap', taskFit: 0.9, reasoningNeed: 0.3 },
  { routeId: 'reasoning', taskFit: 0.85, reasoningNeed: 0.9 },
], overrides: Partial<JevRoutingEvidence> = {}): JevRoutingEvidence {
  return {
    schemaVersion: 'decision-routing-jev-evidence/v1',
    provider: 'jev',
    model: 'router',
    profile: 'typesafe-route-fit-v1',
    calibration: 'calibrated',
    provenance: { adapterVersion: '1.0.0', requestDigest: hash('1'), responseDigest: hash('2') },
    taskComplexity: 0.35,
    ambiguity: 0.01,
    distributions,
    ...overrides,
  };
}

export function success(selected: RouteCandidate, overrides: Partial<RoutingDispatchResult> = {}): RoutingDispatchResult {
  return {
    status: 'success', reason: 'none', actualProvider: selected.model.provider, actualModel: selected.model.pinnedVersion,
    workerId: selected.subagent?.id ?? null, inputTokens: 2, outputTokens: 3,
    costMicros: selected.operations.costMicrosPerAttempt, latencyMs: 20, verified: true, outcomeLabel: 'ok', ...overrides,
  };
}

export function failure(reason: RoutingDispatchResult['reason'], costMicros: number | null = 0): RoutingDispatchResult {
  return { status: 'failure', reason, actualProvider: null, actualModel: null, workerId: null,
    inputTokens: 1, outputTokens: 0, costMicros, latencyMs: 5, verified: null, outcomeLabel: null };
}

/** Mandatory reservation hooks that always admit and record every call. */
export function ledger() {
  const calls: string[] = [];
  return {
    calls,
    reserve: async (route: RouteCandidate, ordinal: number) => { calls.push(`reserve:${route.id}:${ordinal}`); return true; },
    release: async (route: RouteCandidate, ordinal: number, charged: number | null) => { calls.push(`release:${route.id}:${ordinal}:${charged}`); },
  };
}

export function integrity(decision: RoutingEvalIntegrityMetadata['release_gate']['decision'] = 'PROMOTE', sampleN = 40): RoutingEvalIntegrityMetadata {
  return {
    sample_n: sampleN,
    uncertainty: { method: 'newcombe-10', levelBps: 9500 },
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

export function thresholds(overrides: Partial<RoutingPromotionThresholds> = {}): RoutingPromotionThresholds {
  return {
    minimumOverallN: 30,
    minimumSliceN: 10,
    ciMethod: 'newcombe-10',
    ciLevelBps: 9500,
    qualityNonInferiorityMarginBps: 1000,
    maxFailureRate: 0.2,
    maxReworkRate: 0.2,
    maxFallbackRate: 0.2,
    maxHumanOverrideRate: 0.2,
    maxLatencyP95IncreaseMs: 50,
    maxProviderCallsPerTask: 2,
    failurePenaltyMicros: 1_000,
    humanOverridePenaltyMicros: 500,
    budgetComplianceRequired: true,
    positiveNetEconomicsRequired: true,
    ...overrides,
  };
}

export const REGISTERED_AT = '2026-09-01T00:00:00.000Z';
export const HOLDOUT_AT = '2026-09-10T00:00:00.000Z';
export const EVALUATED_AT = '2026-09-11T00:00:00.000Z';

export function heldoutTasks(n = 40): Array<{ id: string; slice: string }> {
  return Array.from({ length: n }, (_, index) => ({ id: `t${String(index).padStart(3, '0')}`, slice: index % 2 ? 'code' : 'docs' }));
}

export function observation(arm: RoutingShadowArmObservation['arm'], item: { id: string; slice: string },
  overrides: Partial<RoutingShadowArmObservation> = {}): RoutingShadowArmObservation {
  return {
    arm, taskId: item.id, slice: item.slice, success: true, rework: false, fallback: false, humanOverride: false,
    providerCalls: 1, inputTokens: 10, outputTokens: 5, attemptCostMicros: arm === 'jev-assisted' ? 60 : 100,
    reworkCostMicros: 0, budgetMicros: 1_000, latencyMs: 10, accepted: true, policyViolation: false, ...overrides,
  };
}

/** A fully paired corpus: every held-out task observed once in each arm. */
export function pairedObservations(tasks = heldoutTasks(), candidate: (item: { id: string; slice: string }, index: number) =>
  Partial<RoutingShadowArmObservation> = () => ({})): RoutingShadowArmObservation[] {
  return tasks.flatMap((item, index) => [
    observation('fixed', item), observation('heuristic', item), observation('jev-assisted', item, candidate(item, index)),
  ]);
}
