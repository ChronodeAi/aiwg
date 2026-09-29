import { describe, expect, it, vi } from 'vitest';
import {
  buildRoutingShadowReport,
  checkRoutingSchema,
  evaluateRoutingEligibility,
  freezeRoutingPreregistration,
  runRoutingControlDrill,
  runRoutingPilot,
  routingDigest,
  validateRoutingPolicy,
  type AliasEvent,
  type DecisionChampionChallenger,
  type DecisionDriftResponse,
  type DriftSignal,
  type RoutingPin,
} from '../../../src/decision/index.js';
import { records } from './ensemble-fixtures.js';
import {
  EVALUATED_AT, HOLDOUT_AT, REGISTERED_AT, candidate, evidence, failure, hash, heldoutTasks, integrity, ledger,
  pairedObservations, policy, success, task, thresholds, withOps,
} from './routing-fixtures.js';

describe('D28 routing pilot (#2620)', () => {
  it('ROUTE-HARD-01 evaluates hard constraints before Jev and hides ineligible routes from evidence', async () => {
    const p = policy({ defaultRouteId: 'cheap', deterministicFallbackRouteId: 'cheap', candidates: [
      candidate('cheap'),
      candidate('private', { policy: { ...candidate('private').policy, privacy: ['restricted'] } }),
      candidate('tooly', { permissions: { ...candidate('tooly').permissions, tools: [] } }),
      withOps('unknown-cost', { costMicrosPerAttempt: null }),
    ] });
    const evidenceSpy = vi.fn(async request => {
      expect(request.candidates.map((item: { id: string }) => item.id)).toEqual(['cheap']);
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
    expect(receipt.counterfactual).toMatchObject({ status: 'selected', routeId: 'cheap' });
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

  it('ROUTE-HARD-02 rejects forged Jev route IDs as review and never selects them', async () => {
    const p = policy({ defaultRouteId: 'safe', deterministicFallbackRouteId: 'safe', candidates: [
      candidate('safe'),
      candidate('admin', { permissions: { ...candidate('admin').permissions, tools: ['read', 'write-secret'], secrets: ['prod'], actions: ['deploy'] } }),
    ] });
    const receipt = await runRoutingPilot(p, task({ allowlist: ['safe', 'admin'] }), {
      enabled: true,
      evidence: async () => evidence([
        { routeId: 'safe', taskFit: 0.1, reasoningNeed: 0.1 },
        { routeId: 'admin', taskFit: 1, reasoningNeed: 1 },
      ]),
    });
    expect(receipt.counterfactual).toMatchObject({ status: 'review', reason: 'malformed-jev-evidence', routeId: null });
    expect(receipt.selectedRouteId).toBe('safe');
    expect(receipt.excluded).toEqual([{ routeId: 'admin', reasons: ['permission-denied'] }]);
  });

  it('ROUTE-HARD-03 hard constraints dominate every fit and cost result', () => {
    const matrix: Array<[string, Parameters<typeof candidate>[1], string]> = [
      ['privacy', { policy: { ...candidate('x').policy, privacy: ['restricted'] } }, 'privacy-denied'],
      ['authorization', { policy: { ...candidate('x').policy, authorizationScopes: [] } }, 'authorization-denied'],
      ['region', { policy: { ...candidate('x').policy, regions: ['eu'] } }, 'region-denied'],
      ['tools', { permissions: { ...candidate('x').permissions, tools: [] } }, 'tool-denied'],
      ['context', { policy: { ...candidate('x').policy, contextBytes: 10 } }, 'context-denied'],
      ['allowlist', { policy: { ...candidate('x').policy, allowlisted: false } }, 'allowlist-denied'],
      ['budget', { operations: { ...candidate('x').operations, costMicrosPerAttempt: 1_000 } }, 'budget-denied'],
      ['deadline', { operations: { ...candidate('x').operations, deadlineMs: 1_500 } }, 'deadline-denied'],
      ['health', { operations: { ...candidate('x').operations, health: 'outage' } }, 'health-denied'],
      ['executable', { policy: { ...candidate('x').policy, executable: false } }, 'not-executable'],
    ];
    for (const [, patch, reason] of matrix) {
      // The excluded route is the cheapest, fastest and best-fitting on paper.
      const best = candidate('best', { ...patch });
      const result = evaluateRoutingEligibility(policy({ candidates: [best, candidate('other')], defaultRouteId: 'other', deterministicFallbackRouteId: null }),
        task({ allowlist: ['best', 'other'], maxCostMicros: 900, deadlineMs: 1_000 }));
      expect(result.excluded).toEqual([{ routeId: 'best', reasons: [reason] }]);
      expect(result.eligible.map(item => item.candidate.id)).toEqual(['other']);
    }
  });

  it('ROUTE-REVIEW-01 routes empty eligible sets and uncalibrated evidence to review without Jev-selected dispatch', async () => {
    const evidenceSpy = vi.fn(async () => evidence());
    const dispatch = vi.fn(async () => failure('failed'));
    const empty = await runRoutingPilot(policy(), task({ allowlist: [] }), { enabled: true, evidence: evidenceSpy, dispatch, ...ledger() });
    expect(empty.status).toBe('no-route');
    expect(empty.reason).toBe('empty-eligible-set');
    expect(evidenceSpy).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();

    const uncalibrated = await runRoutingPilot(policy(), task(), {
      enabled: true,
      evidence: async () => ({ ...evidence(), calibration: 'uncalibrated' }),
    });
    expect(uncalibrated.counterfactual).toMatchObject({ status: 'review', reason: 'uncalibrated-evidence' });
  });

  it('ROUTE-OFF-01 is default-off: no hook runs and the receipt selects nothing', async () => {
    const hooks = { evidence: vi.fn(), dispatch: vi.fn(), reserve: vi.fn(), release: vi.fn() };
    for (const [p, enabled] of [[policy({ mode: 'disabled' }), true], [policy(), undefined]] as const) {
      const receipt = await runRoutingPilot(p, task(), { enabled, ...hooks });
      expect(receipt.status).toBe('disabled');
      expect(receipt.selectedRouteId).toBeNull();
      expect(receipt.attempts).toEqual([]);
    }
    for (const hook of Object.values(hooks)) expect(hook).not.toHaveBeenCalled();
  });

  it('ROUTE-FALLBACK-01 reserves before dispatch and falls back once to an eligible other-provider route', async () => {
    const other = { provider: 'anthropic', backend: 'chat', requested: 'backup-model', pinnedVersion: 'backup-2026-09' };
    const p = policy({ defaultRouteId: 'cheap', deterministicFallbackRouteId: 'backup', candidates: [
      candidate('cheap'),
      withOps('backup', { costMicrosPerAttempt: 200 }, { model: other }),
      withOps('open-circuit', { health: 'circuit-open' }),
    ] });
    const hooks = ledger();
    const calls = hooks.calls;
    const delay = vi.fn(async () => undefined);
    const receipt = await runRoutingPilot(p, task({ allowlist: ['cheap', 'backup', 'open-circuit'], providers: ['openai', 'anthropic'] }), {
      enabled: true,
      now: () => 1_000,
      reserve: hooks.reserve,
      release: hooks.release,
      delay,
      dispatch: async ({ candidate: selected }) => {
        calls.push(`dispatch:${selected.id}`);
        return selected.id === 'cheap' ? failure('rate-limit', 10) : success(selected);
      },
    });
    expect(calls).toEqual(['reserve:cheap:1', 'dispatch:cheap', 'release:cheap:1:10', 'reserve:backup:2', 'dispatch:backup', 'release:backup:2:200']);
    expect(receipt.selectedRouteId).toBe('backup');
    expect(receipt.attempts.map(item => [item.routeId, item.reason])).toEqual([['cheap', 'rate-limit'], ['backup', 'none']]);
    expect(receipt.fallbacks).toEqual(['cheap']);
    expect(receipt.budget).toEqual({ limitMicros: 1_000, spentMicros: 210 });
    expect(receipt.usage.costMicros).toBe(210);
    expect(receipt.actual).toEqual({ workerId: 'backup-worker', provider: 'anthropic', model: 'backup-2026-09' });
    expect(receipt.excluded).toEqual([{ routeId: 'open-circuit', reasons: ['health-denied'] }]);
    expect(delay).toHaveBeenCalledExactlyOnceWith(10, expect.any(AbortSignal));
  });

  it('ROUTE-REPORT-01 applies preregistered gates without upgrading integrity HOLD', () => {
    const tasks = heldoutTasks();
    const preregistration = freezeRoutingPreregistration({
      policy: { id: 'routing-pilot', version: '1.0.0', digest: hash('9') },
      baselineArm: 'fixed', registeredAt: REGISTERED_AT, tasks, thresholds: thresholds(),
    });
    const report = buildRoutingShadowReport({
      id: 'routing-shadow-1', preregistration, trustedPreregistrationDigest: preregistration.digest,
      holdoutAccessedAt: HOLDOUT_AT, evaluatedAt: EVALUATED_AT,
      observations: pairedObservations(tasks, (_item, index) => (index < 12 ? { success: false, rework: true, fallback: true } : {})),
      integrity: integrity('HOLD'),
    });
    expect(report.decision).toBe('HOLD');
    expect(report.reasons).toEqual(expect.arrayContaining(['failure-rate', 'fallback-rate', 'net-economics', 'quality-non-inferiority', 'rework-rate']));
    expect(report.comparisons.economics.netSavingsMicros).toBeLessThan(0);
    expect(report.arms.map(item => item.arm)).toEqual(['fixed', 'heuristic', 'jev-assisted']);
  });

  it('ROUTE-D17-01 restores the prior routing policy via D17 APIs without changing active pins', async () => {
    const record = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09')!;
    const driftPolicy = records<DecisionDriftResponse>('drift-response.v1.valid.json').get('triage-drift-response')!;
    const history: AliasEvent[] = [{
      revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest, actualModel: record.champion.actualModel,
      recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null,
    }, {
      // D17 rollback only undoes this record's own promotion, so the drill starts from a promoted challenger.
      revision: 2, alias: record.alias, actualIdentityDigest: record.challenger.identityDigest, actualModel: record.challenger.actualModel,
      recordedAt: '2026-09-15T00:00:00.000Z', kind: 'promoted', promotionEligibilityId: record.eligibilityId,
    }];
    const signal: DriftSignal = {
      source: 'label-drift', id: 'label-drift-1', alias: record.alias, metric: 'label-error-rate-delta-v1', valueBps: 500,
      sampleN: 250, thresholdsVersion: driftPolicy.thresholds.version, observedAt: '2026-09-29T00:00:00.000Z',
    };
    const rollback = vi.fn((alias: string, _targetRevision: number, _approval: string, at: string): AliasEvent => ({
      revision: 3, alias, actualIdentityDigest: record.rollbackTarget.identityDigest, actualModel: record.champion.actualModel,
      recordedAt: at, kind: 'rolled-back', promotionEligibilityId: null,
    }));
    const pins: RoutingPin[] = [{ id: 'routing-pilot', version: '1.0.0', digest: hash('1') }, { id: 'routing-pilot', version: '1.1.0', digest: hash('2') }];
    const runs = [{ runId: 'run-a', policy: pins[1]!, aliasRevision: 2, identityDigest: record.challenger.identityDigest }];
    const result = await runRoutingControlDrill({
      championChallenger: record, driftPolicy, driftSignal: signal, approvalReference: 'review-2620',
      gateway: {
        aliasHistory: () => history,
        promoteAlias: () => { throw new Error('promotion is out of scope for rollback drill'); },
        rollbackAlias: rollback,
      },
      control: {
        policyHistory: () => [...pins],
        restorePolicy: target => { pins.push(target); return target; },
        openJevCircuit: () => undefined,
        activeRunPins: () => runs,
      },
      at: '2026-09-29T00:00:00.000Z',
    });
    expect(result.driftResponse).toBe('restore-champion');
    expect(rollback).toHaveBeenCalledWith(record.alias, record.rollbackTarget.aliasRevision, 'review-2620', '2026-09-29T00:00:00.000Z');
    expect(pins.at(-1)).toEqual(pins[0]);
    expect(result.activeRunPins).toEqual(runs);
  });

  it('ROUTE-SCHEMA-01 validates closed routing policy shape', () => {
    expect(() => validateRoutingPolicy(policy())).not.toThrow();
    expect(() => validateRoutingPolicy({ ...policy(), extra: true })).toThrow(/schema/);
    expect(routingDigest(policy())).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validateRoutingPolicy(policy()).digest).toBe(validateRoutingPolicy(policy({ candidates: [...policy().candidates].reverse() })).digest);
  });
});
