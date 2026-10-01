import { describe, expect, it } from 'vitest';
import {
  runRoutingPilot,
  type RouteCandidate,
  type RoutingAttemptBudget,
  type RoutingDispatchResult,
  type RoutingPolicy,
  type RoutingRuntimeOptions,
  type RoutingTask,
} from '../../../src/decision/index.js';
import { candidate, failure, ledger, policy, success, task, withOps } from './routing-fixtures.js';

type Reserve = NonNullable<RoutingRuntimeOptions['reserve']>;
type Dispatch = NonNullable<RoutingRuntimeOptions['dispatch']>;

const OTHER_PROVIDER = { provider: 'anthropic', backend: 'chat', requested: 'backup-model', pinnedVersion: 'backup-2026-09' };

/** Two-route deterministic chain on a 1_000 micros run budget. */
function chainPolicy(backupCost: number): RoutingPolicy {
  return policy({
    candidates: [
      withOps('primary', { costMicrosPerAttempt: 100, maxAttempts: 1 }),
      withOps('backup', { costMicrosPerAttempt: backupCost }, { model: { ...OTHER_PROVIDER } }),
    ],
    defaultRouteId: 'primary',
    deterministicFallbackRouteId: 'backup',
  });
}

function chainTask(): RoutingTask {
  return task({ allowlist: ['primary', 'backup'], providers: ['openai', 'anthropic'] });
}

describe('routing fallback budget cap (#2789)', () => {
  it('ROUTE-CAP-01 caps a different-provider fallback at the remaining budget after an observed overrun', async () => {
    const p = chainPolicy(100);
    const seenReserve: Array<{ routeId: string; ordinal: number; budget: RoutingAttemptBudget | undefined }> = [];
    const seenDispatch: Array<{ routeId: string; costCeilingMicros: number | undefined }> = [];
    const hooks = ledger();
    const receipt = await runRoutingPilot(p, chainTask(), {
      enabled: true,
      now: () => 1_000,
      delay: async () => undefined,
      reserve: (async (route: RouteCandidate, ordinal: number, budget: RoutingAttemptBudget) => {
        seenReserve.push({ routeId: route.id, ordinal, budget });
        return hooks.reserve(route, ordinal);
      }) as Reserve,
      release: hooks.release,
      dispatch: (async (request: Parameters<Dispatch>[0]) => {
        seenDispatch.push({ routeId: request.candidate.id, costCeilingMicros: request.costCeilingMicros });
        if (request.candidate.id === 'primary') return failure('timeout', 800);
        // A cap-honouring provider spends at most the authorized ceiling, never its uncapped cost.
        const cost = Math.min(500, request.costCeilingMicros ?? Number.POSITIVE_INFINITY);
        return { ...success(request.candidate), costMicros: cost };
      }) as Dispatch,
    });
    // 800 spent leaves 200 of the 1_000 budget: the fallback is admitted, capped at 200.
    expect(seenReserve).toEqual([
      { routeId: 'primary', ordinal: 1, budget: { remainingBudgetMicros: 1_000, costCeilingMicros: 1_000, estimatedCostMicros: 100 } },
      { routeId: 'backup', ordinal: 2, budget: { remainingBudgetMicros: 200, costCeilingMicros: 200, estimatedCostMicros: 100 } },
    ]);
    expect(seenDispatch).toEqual([
      { routeId: 'primary', costCeilingMicros: 1_000 },
      { routeId: 'backup', costCeilingMicros: 200 },
    ]);
    expect(receipt.selectedRouteId).toBe('backup');
    expect(receipt.budget).toEqual({ limitMicros: 1_000, spentMicros: 1_000 });
    expect(receipt.fallbacks).toEqual(['primary']);
  });

  it('ROUTE-CAP-02 refuses a fallback whose estimate exceeds the remaining budget before dispatch', async () => {
    const p = chainPolicy(300);
    const dispatched: string[] = [];
    const hooks = ledger();
    const receipt = await runRoutingPilot(p, chainTask(), {
      enabled: true,
      now: () => 1_000,
      delay: async () => undefined,
      reserve: hooks.reserve,
      release: hooks.release,
      dispatch: (async ({ candidate: selected }: Parameters<Dispatch>[0]) => {
        dispatched.push(selected.id);
        if (selected.id === 'primary') return failure('timeout', 800);
        return success(selected) as RoutingDispatchResult;
      }) as Dispatch,
    });
    // 800 spent leaves 200, below the 300 fallback estimate: no fallback dispatch, no reservation.
    expect(dispatched).toEqual(['primary']);
    expect(hooks.calls).toEqual(['reserve:primary:1', 'release:primary:1:800']);
    expect(receipt.skipped).toEqual([{ routeId: 'backup', reason: 'budget-exhausted' }]);
    expect(receipt.budget).toEqual({ limitMicros: 1_000, spentMicros: 800 });
    expect(receipt.status).toBe('review');
    expect(receipt.reason).toBe('budget-exhausted');
  });

  it('ROUTE-CAP-03 a cap-enforcing reserve denies uncapped admission, so the fallback is refused before dispatch', async () => {
    const p = chainPolicy(100);
    const dispatched: string[] = [];
    const reserveCalls: Array<{ routeId: string; capped: boolean }> = [];
    const receipt = await runRoutingPilot(p, chainTask(), {
      enabled: true,
      now: () => 1_000,
      delay: async () => undefined,
      reserve: (async (route: RouteCandidate, ordinal: number, budget?: RoutingAttemptBudget) => {
        const capped = budget !== undefined
          && Number.isSafeInteger(budget.remainingBudgetMicros)
          && Number.isSafeInteger(budget.costCeilingMicros)
          && budget.costCeilingMicros <= budget.remainingBudgetMicros;
        reserveCalls.push({ routeId: route.id, capped });
        return capped;
      }) as Reserve,
      release: async () => undefined,
      dispatch: (async ({ candidate: selected }: Parameters<Dispatch>[0]) => {
        dispatched.push(selected.id);
        if (selected.id === 'primary') return failure('timeout', 100);
        return success(selected) as RoutingDispatchResult;
      }) as Dispatch,
    });
    // Without the remaining-cost cap in the reservation contract the fallback cannot be admitted.
    expect(reserveCalls.map(item => [item.routeId, item.capped])).toEqual([['primary', true], ['backup', true]]);
    expect(dispatched).toEqual(['primary', 'backup']);
    expect(receipt.selectedRouteId).toBe('backup');
    expect(receipt.budget).toEqual({ limitMicros: 1_000, spentMicros: 200 });
  });

  it('ROUTE-CAP-04 disabled routing still calls no hook and selects nothing', async () => {
    const hooks = ledger();
    const receipt = await runRoutingPilot(chainPolicy(100), chainTask(), {
      enabled: undefined,
      reserve: hooks.reserve,
      release: hooks.release,
      dispatch: (async ({ candidate: selected }: Parameters<Dispatch>[0]) => success(selected)) as Dispatch,
    });
    expect(receipt.status).toBe('disabled');
    expect(receipt.selectedRouteId).toBeNull();
    expect(receipt.attempts).toEqual([]);
    expect(hooks.calls).toEqual([]);
  });

  it('ROUTE-CAP-05 an unknown-cost overrun stops the run without dispatching a fallback', async () => {
    const dispatched: string[] = [];
    const hooks = ledger();
    const receipt = await runRoutingPilot(chainPolicy(100), chainTask(), {
      enabled: true,
      now: () => 1_000,
      delay: async () => undefined,
      reserve: hooks.reserve,
      release: hooks.release,
      dispatch: (async ({ candidate: selected }: Parameters<Dispatch>[0]) => {
        dispatched.push(selected.id);
        if (selected.id === 'primary') return failure('timeout', null);
        return success(selected) as RoutingDispatchResult;
      }) as Dispatch,
    });
    // Null means unknown, never zero: with no enforceable remaining cap the fallback is refused.
    expect(dispatched).toEqual(['primary']);
    expect(receipt.status).toBe('review');
    expect(receipt.reason).toBe('cost-unknown');
    expect(receipt.budget).toEqual({ limitMicros: 1_000, spentMicros: null });
  });
});
