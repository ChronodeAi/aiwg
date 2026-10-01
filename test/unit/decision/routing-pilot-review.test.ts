import { describe, expect, it, vi } from 'vitest';
import {
  buildRoutingShadowReport,
  checkRoutingSchema,
  freezeRoutingPreregistration,
  routingDigest,
  runRoutingControlDrill,
  runRoutingPilot,
  RoutingControlDrillError,
  validateRoutingPolicy,
  validateRoutingShadowReport,
  type AliasEvent,
  type DecisionChampionChallenger,
  type DecisionDriftResponse,
  type DriftSignal,
  type JevRoutingEvidence,
  type RouteCandidate,
  type RoutingActiveRunPin,
  type RoutingDispatchResult,
  type RoutingPin,
  type RoutingPolicy,
  type RoutingRuntimeOptions,
  type RoutingShadowArmObservation,
  type RoutingTask,
} from '../../../src/decision/index.js';
import { records } from './ensemble-fixtures.js';
import {
  EVALUATED_AT, HOLDOUT_AT, REGISTERED_AT, candidate, evidence, failure, hash, heldoutTasks, integrity, ledger,
  observation, pairedObservations, policy, success, task, thresholds, withOps,
} from './routing-fixtures.js';

type Dispatch = NonNullable<RoutingRuntimeOptions['dispatch']>;

/** Shadow run with mandatory reservation hooks and a recording dispatcher. */
async function shadowRun(p: RoutingPolicy, t: RoutingTask, options: RoutingRuntimeOptions & { dispatched?: string[] } = {}) {
  const dispatched = options.dispatched ?? [];
  const hooks = ledger();
  const receipt = await runRoutingPilot(p, t, {
    enabled: true,
    now: () => 1_000,
    reserve: hooks.reserve,
    release: hooks.release,
    delay: async () => undefined,
    dispatch: async ({ candidate: selected }) => { dispatched.push(selected.id); return success(selected); },
    ...options,
  });
  return { receipt, dispatched, hooks };
}

function expectValidReceipt(receipt: unknown): void {
  expect(() => checkRoutingSchema('receipt', receipt)).not.toThrow();
  const { digest, ...payload } = receipt as { digest: string };
  expect(digest).toBe(routingDigest(payload));
}

describe('D28 routing pilot review regressions (#2620)', () => {
  describe('F01-F03, F12 Jev evidence validation', () => {
    it.each([
      ['NaN taskFit', Number.NaN],
      ['negative taskFit', -5],
      ['huge taskFit', 1e12],
      ['infinite taskFit', Number.POSITIVE_INFINITY],
    ])('ROUTE-F01 %s never reaches ranking and still returns a receipt', async (_label, taskFit) => {
      const dispatched: string[] = [];
      const { receipt } = await shadowRun(policy(), task(), {
        dispatched,
        evidence: async () => evidence([
          { routeId: 'cheap', taskFit, reasoningNeed: 0.3 },
          { routeId: 'reasoning', taskFit: 0.85, reasoningNeed: 0.9 },
        ]),
      });
      expectValidReceipt(receipt);
      expect(receipt.counterfactual).toMatchObject({ status: 'review', reason: 'malformed-jev-evidence', routeId: null, ranking: [] });
      expect(receipt.jev).toBeNull();
      // Only the authoritative deterministic route executed, once.
      expect(dispatched).toEqual(['reasoning']);
      expect(receipt.selectedRouteId).toBe('reasoning');
    });

    it.each([
      ['empty distributions', [] as JevRoutingEvidence['distributions'], 'malformed-jev-evidence'],
      ['partial distributions', [{ routeId: 'cheap', taskFit: 0.9, reasoningNeed: 0.3 }], 'incomplete-jev-evidence'],
      ['duplicate route IDs', [
        { routeId: 'cheap', taskFit: 0.1, reasoningNeed: 0.3 },
        { routeId: 'cheap', taskFit: 0.99, reasoningNeed: 0.3 },
        { routeId: 'reasoning', taskFit: 0.5, reasoningNeed: 0.9 },
      ], 'duplicate-jev-route'],
    ])('ROUTE-F02 %s go to review without a Jev selection', async (_label, distributions, reason) => {
      const { receipt, dispatched } = await shadowRun(policy(), task(), { evidence: async () => evidence(distributions) });
      expectValidReceipt(receipt);
      expect(receipt.counterfactual).toMatchObject({ status: 'review', reason, routeId: null });
      expect(dispatched).toEqual(['reasoning']);
    });

    it('ROUTE-F03 ambiguity above uncertaintyThresholdBps falls back to the deterministic route, never the Jev pick', async () => {
      const { receipt } = await shadowRun(policy(), task(), { evidence: async () => evidence(undefined, { ambiguity: 1 }) });
      expect(receipt.counterfactual).toMatchObject({ status: 'deterministic-fallback', reason: 'ambiguous-evidence', routeId: 'reasoning' });
      const atThreshold = await shadowRun(policy(), task(), { evidence: async () => evidence(undefined, { ambiguity: 0.05 }) });
      expect(atThreshold.receipt.counterfactual).toMatchObject({ status: 'selected', routeId: 'cheap' });
      const above = await shadowRun(policy(), task(), { evidence: async () => evidence(undefined, { ambiguity: 0.0501 }) });
      expect(above.receipt.counterfactual.status).toBe('deterministic-fallback');
    });

    it.each(['unknown', 'uncalibrated'] as const)('ROUTE-F03 calibration %s is review and calibration cannot be made optional', async calibration => {
      const { receipt } = await shadowRun(policy(), task(), { evidence: async () => evidence(undefined, { calibration }) });
      expect(receipt.counterfactual).toMatchObject({ status: 'review', reason: 'uncalibrated-evidence', routeId: null });
      expect(() => validateRoutingPolicy(policy({
        jevEvidence: { ...policy().jevEvidence, calibrationRequired: false as true },
      }))).toThrow(/schema/);
    });

    it.each([
      ['null distributions', { distributions: null }],
      ['null distribution item', { distributions: [null] }],
      ['foreign provider', { provider: 'other' }],
      ['wrong model', { model: 'unprojected-model' }],
      ['permission injection', { permissions: { tools: ['write'] } }],
      ['null evidence', null],
    ])('ROUTE-F12 %s evidence is schema-rejected to review with a receipt', async (_label, patch) => {
      const { receipt, dispatched } = await shadowRun(policy(), task(), {
        evidence: async () => (patch === null ? null : { ...evidence(), ...patch }) as unknown as JevRoutingEvidence,
      });
      expectValidReceipt(receipt);
      expect(receipt.counterfactual).toMatchObject({ status: 'review', reason: 'malformed-jev-evidence', routeId: null });
      expect(dispatched).toEqual(['reasoning']);
    });
  });

  describe('F04-F07 disabled, shadow and task validation', () => {
    it('ROUTE-F04 a disabled receipt never names an ineligible fallback route', async () => {
      const p = policy({ candidates: [candidate('cheap'), candidate('reasoning', { policy: { ...candidate('reasoning').policy, privacy: ['restricted'] } })] });
      const receipt = await runRoutingPilot({ ...p, mode: 'disabled' }, task());
      expect(receipt.status).toBe('disabled');
      expect(receipt.selectedRouteId).toBeNull();
      expectValidReceipt(receipt);
      const { receipt: shadow, dispatched } = await shadowRun(p, task(), { evidence: async () => evidence() });
      expect(shadow.status).toBe('no-route');
      expect(shadow.reason).toBe('deterministic-route-ineligible');
      expect(shadow.selectedRouteId).toBeNull();
      expect(dispatched).toEqual([]);
    });

    it.each([
      ['policy disabled', policy({ mode: 'disabled' }), true],
      ['runtime not enabled', policy(), undefined],
    ])('ROUTE-F05 %s performs no observable action', async (_label, p, enabled) => {
      const reserve = vi.fn(async () => true);
      const release = vi.fn(async () => undefined);
      const evidenceSpy = vi.fn(async () => evidence());
      const dispatch = vi.fn(async () => failure('failed'));
      const delay = vi.fn(async () => undefined);
      const timer = vi.fn(async () => undefined);
      const receipt = await runRoutingPilot(p, task(), { enabled, reserve, release, evidence: evidenceSpy, dispatch, delay, timer });
      expect(receipt.status).toBe('disabled');
      for (const hook of [reserve, release, evidenceSpy, dispatch, delay, timer]) expect(hook).not.toHaveBeenCalled();
    });

    it('ROUTE-F05 reserves only the attempted route and releases every reservation', async () => {
      const { hooks } = await shadowRun(policy(), task(), { evidence: async () => evidence() });
      expect(hooks.calls).toEqual(['reserve:reasoning:1', 'release:reasoning:1:500']);
    });

    it('ROUTE-F05 dispatch without mandatory reservation hooks fails closed', async () => {
      const dispatch = vi.fn(async ({ candidate: selected }: Parameters<Dispatch>[0]) => success(selected));
      const receipt = await runRoutingPilot(policy(), task(), { enabled: true, dispatch });
      expect(receipt.status).toBe('review');
      expect(receipt.reason).toBe('reservation-unavailable');
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('ROUTE-F06 shadow executes only the existing deterministic route and records Jev as counterfactual', async () => {
      const dispatched: string[] = [];
      const { receipt } = await shadowRun(policy(), task(), { dispatched, evidence: async () => evidence() });
      expect(receipt.counterfactual).toMatchObject({ status: 'selected', routeId: 'cheap', ranking: ['cheap', 'reasoning'] });
      expect(dispatched).toEqual(['reasoning']);
      expect(receipt.selectedRouteId).toBe('reasoning');
      expect(receipt.selectionReason).toBe('deterministic-authoritative');
      expect(() => validateRoutingPolicy({ ...policy(), mode: 'enforce' })).toThrow(/schema/);
    });

    it.each([
      ['missing maxCostMicros', (t: RoutingTask) => { delete (t.requirements as Partial<RoutingTask['requirements']>).maxCostMicros; }],
      ['missing deadlineMs', (t: RoutingTask) => { delete (t.requirements as Partial<RoutingTask['requirements']>).deadlineMs; }],
      ['missing contextBytes', (t: RoutingTask) => { delete (t.requirements as Partial<RoutingTask['requirements']>).contextBytes; }],
      ['NaN budget', (t: RoutingTask) => { t.requirements.maxCostMicros = Number.NaN; }],
      ['unknown requirement', (t: RoutingTask) => { (t.requirements as unknown as Record<string, unknown>).gpu = true; }],
      ['missing authorization ceiling', (t: RoutingTask) => { delete (t.requirements as Partial<RoutingTask['requirements']>).authorized; }],
    ])('ROUTE-F07 task with %s fails closed before any hook', async (_label, mutate) => {
      const t = task();
      mutate(t);
      const evidenceSpy = vi.fn(async () => evidence());
      const { receipt, dispatched, hooks } = await shadowRun(policy(), t, { evidence: evidenceSpy });
      expect(receipt.status).toBe('review');
      expect(receipt.reason).toBe('invalid-task');
      expect(receipt.eligibleRouteIds).toEqual([]);
      expect(dispatched).toEqual([]);
      expect(hooks.calls).toEqual([]);
      expect(evidenceSpy).not.toHaveBeenCalled();
      expectValidReceipt(receipt);
    });
  });

  describe('F08-F10 cumulative budget, deadline, circuits and dispatch results', () => {
    it('ROUTE-F08 enforces cumulative budget before dispatch across retries and fallbacks', async () => {
      const p = policy({
        candidates: [withOps('primary', { costMicrosPerAttempt: 900, maxAttempts: 3 }), withOps('secondary', { costMicrosPerAttempt: 900 }, {
          model: { provider: 'anthropic', backend: 'chat', requested: 'secondary-model', pinnedVersion: 'secondary-2026-09' },
        })],
        defaultRouteId: 'primary', deterministicFallbackRouteId: 'secondary',
      });
      const dispatched: string[] = [];
      const { receipt, hooks } = await shadowRun(p, task({ allowlist: ['primary', 'secondary'], providers: ['openai', 'anthropic'] }), {
        dispatched,
        dispatch: async ({ candidate: selected }) => { dispatched.push(selected.id); return failure('timeout', 900); },
      });
      expect(dispatched).toEqual(['primary']);
      expect(receipt.budget).toEqual({ limitMicros: 1_000, spentMicros: 900 });
      expect(receipt.reason).toBe('budget-exhausted');
      expect(receipt.skipped).toEqual([{ routeId: 'primary', reason: 'budget-exhausted' }, { routeId: 'secondary', reason: 'budget-exhausted' }]);
      expect(hooks.calls).toEqual(['reserve:primary:1', 'release:primary:1:900']);
    });

    it('ROUTE-F08 prices a retry at the highest observed cost, not the stale estimate', async () => {
      const p = policy({ candidates: [withOps('cheap', { costMicrosPerAttempt: 100, maxAttempts: 3 })],
        defaultRouteId: 'cheap', deterministicFallbackRouteId: null });
      const dispatched: string[] = [];
      const { receipt } = await shadowRun(p, task({ allowlist: ['cheap'] }), {
        dispatched,
        dispatch: async ({ candidate: selected }) => { dispatched.push(selected.id); return failure('timeout', 800); },
      });
      expect(dispatched).toEqual(['cheap']);
      expect(receipt.budget).toEqual({ limitMicros: 1_000, spentMicros: 800 });
      expect(receipt.skipped).toEqual([{ routeId: 'cheap', reason: 'budget-exhausted' }]);
      expect(receipt.reason).toBe('budget-exhausted');
    });

    it('ROUTE-F08 a same-provider fallback is priced at the provider\'s highest observed cost', async () => {
      const p = policy({ candidates: [withOps('first', { costMicrosPerAttempt: 100 }), withOps('second', { costMicrosPerAttempt: 100 })],
        defaultRouteId: 'first', deterministicFallbackRouteId: 'second' });
      const dispatched: string[] = [];
      const { receipt } = await shadowRun(p, task({ allowlist: ['first', 'second'] }), {
        dispatched,
        dispatch: async ({ candidate: selected }) => { dispatched.push(selected.id); return failure('timeout', 700); },
      });
      expect(dispatched).toEqual(['first']);
      expect(receipt.skipped).toEqual([{ routeId: 'second', reason: 'budget-exhausted' }]);
    });

    it('ROUTE-F08 deadline is min(task, policy) on the injected clock and aborts a hung dispatch', async () => {
      let clock = 1_000;
      const seen: Array<{ deadline: number; aborted: () => boolean }> = [];
      const timer = vi.fn(async () => { clock += 100; });
      const { receipt } = await shadowRun(policy({ candidates: [withOps('cheap', { deadlineMs: 100 }), withOps('reasoning', { deadlineMs: 100 })] }),
        task({ deadlineMs: 150 }), {
          now: () => clock,
          timer,
          dispatch: ({ deadlineEpochMs, signal }) => {
            seen.push({ deadline: deadlineEpochMs, aborted: () => signal.aborted });
            return new Promise<RoutingDispatchResult>(() => undefined);
          },
        });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.deadline).toBe(1_100);
      expect(seen[0]!.aborted()).toBe(true);
      expect(timer).toHaveBeenCalledWith(100, expect.any(AbortSignal));
      expect(receipt.attempts).toMatchObject([{ routeId: 'reasoning', status: 'failed', reason: 'timeout' }]);
      expect(receipt.status).toBe('review');
      expect(receipt.deadlineEpochMs).toBe(1_150);
    });

    it('ROUTE-F08 honours per-route maxAttempts', async () => {
      const p = policy({ candidates: [withOps('cheap', { maxAttempts: 2 })], defaultRouteId: 'cheap', deterministicFallbackRouteId: null });
      const dispatched: string[] = [];
      const { receipt } = await shadowRun(p, task({ allowlist: ['cheap'] }), {
        dispatched,
        dispatch: async ({ candidate: selected }) => { dispatched.push(selected.id); return failure('timeout', 10); },
      });
      expect(dispatched).toEqual(['cheap', 'cheap']);
      expect(receipt.reason).toBe('fallbacks-exhausted');
      expect(receipt.budget.spentMicros).toBe(20);
    });

    it('ROUTE-F09 an outage opens the provider circuit so same-provider fallbacks are skipped', async () => {
      const p = policy({
        candidates: [withOps('down-a', {}), withOps('down-b', {}), withOps('other', {}, {
          model: { provider: 'anthropic', backend: 'chat', requested: 'other-model', pinnedVersion: 'other-2026-09' },
        })],
        defaultRouteId: 'down-a', deterministicFallbackRouteId: 'down-b',
      });
      const dispatched: string[] = [];
      const { receipt } = await shadowRun(p, task({ allowlist: ['down-a', 'down-b', 'other'], providers: ['openai', 'anthropic'] }), {
        dispatched,
        dispatch: async ({ candidate: selected }) => { dispatched.push(selected.id); return failure('outage'); },
      });
      expect(dispatched).toEqual(['down-a']);
      expect(receipt.skipped).toEqual([{ routeId: 'down-b', reason: 'circuit-open' }]);
      expect(receipt.status).toBe('review');
    });

    it('ROUTE-F09 fallbacks re-check hard constraints and apply bounded default backoff', async () => {
      const p = policy({
        candidates: [withOps('first', {}), withOps('second', {}, {
          model: { provider: 'anthropic', backend: 'chat', requested: 'second-model', pinnedVersion: 'second-2026-09' },
        })],
        defaultRouteId: 'first', deterministicFallbackRouteId: 'second',
      });
      const t = task({ allowlist: ['first', 'second'], providers: ['openai', 'anthropic'] });
      const started = Date.now();
      const receipt = await runRoutingPilot(p, t, {
        enabled: true, ...ledger(),
        dispatch: async ({ candidate: selected }) => selected.id === 'first' ? failure('rate-limit') : success(selected),
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(9);
      expect(receipt.selectedRouteId).toBe('second');

      // A fallback whose health is now circuit-open in the trusted snapshot is skipped, not dispatched.
      const blocked = policy({ ...p, candidates: [p.candidates[0]!, withOps('second', { health: 'circuit-open' }, {
        model: { provider: 'anthropic', backend: 'chat', requested: 'second-model', pinnedVersion: 'second-2026-09' },
      })] });
      const dispatched: string[] = [];
      const second = await shadowRun(blocked, t, {
        dispatched,
        dispatch: async ({ candidate: selected }) => { dispatched.push(selected.id); return failure('rate-limit'); },
      });
      expect(dispatched).toEqual(['first']);
      expect(second.receipt.excluded).toEqual([{ routeId: 'second', reasons: ['health-denied'] }]);
      expect(second.receipt.reason).toBe('fallbacks-exhausted');
    });

    it.each([
      ['null result', null, 'invalid-dispatch-result', 'invalid-result'],
      ['extra field', { extra: true }, 'invalid-dispatch-result', 'invalid-result'],
      ['provider substitution', { actualProvider: 'evil' }, 'model-substitution', 'substituted'],
      ['model substitution', { actualModel: 'gpt-huge' }, 'model-substitution', 'substituted'],
      ['unknown actual model', { actualModel: null }, 'actual-model-unknown', 'substituted'],
      ['cost above budget', { costMicros: 10_000_000 }, 'budget-exceeded', 'none'],
      ['unknown cost', { costMicros: null }, 'cost-unknown', 'none'],
    ])('ROUTE-F10 %s is validated and flagged', async (_label, patch, reason, attemptReason) => {
      const { receipt } = await shadowRun(policy(), task(), {
        dispatch: async ({ candidate: selected }) => (patch === null ? null : { ...success(selected), ...patch }) as RoutingDispatchResult,
      });
      expectValidReceipt(receipt);
      expect(receipt.status).toBe('review');
      expect(receipt.reason).toBe(reason);
      expect(receipt.attempts).toHaveLength(1);
      expect(receipt.attempts[0]!.reason).toBe(attemptReason);
    });
  });

  describe('every exit path returns a receipt', () => {
    it('ROUTE-EXIT-01 contains throwing hooks without losing recorded attempts', async () => {
      const denied = await shadowRun(policy(), task(), { reserve: async () => { throw new Error('admission down'); } });
      expect(denied.dispatched).toEqual([]);
      expect(denied.receipt.skipped).toEqual([{ routeId: 'reasoning', reason: 'reservation-denied' }]);
      expect(denied.receipt.status).toBe('review');

      const released = await shadowRun(policy(), task(), { release: async () => { throw new Error('ledger down'); } });
      expect(released.receipt.status).toBe('selected');
      expect(released.receipt.budget.spentMicros).toBe(500);

      const rejected = await shadowRun(policy(), task(), { dispatch: async () => { throw new Error('transport down'); } });
      expect(rejected.receipt.reason).toBe('cost-unknown');
      expect(rejected.receipt.attempts).toMatchObject([{ status: 'failed', reason: 'rejected' }]);

      const hungWithBrokenTimer = await shadowRun(policy(), task(), {
        timer: async () => { throw new Error('timer down'); },
        dispatch: () => new Promise<RoutingDispatchResult>(() => undefined),
      });
      expect(hungWithBrokenTimer.receipt.attempts).toMatchObject([{ reason: 'timeout' }]);

      let reads = 0;
      const clockFails = await shadowRun(policy(), task(), {
        now: () => (reads++ < 2 ? 1_000 : Number.NaN),
        dispatch: async ({ candidate: selected }) => success(selected),
      });
      expect(clockFails.receipt).toMatchObject({ status: 'review', reason: 'runtime-error', selectedRouteId: null });
      // Every granted reservation was released, even on the failing paths (the other runs replace the recording hooks).
      for (const item of [rejected, hungWithBrokenTimer, clockFails]) {
        const calls = item.hooks.calls;
        expect(calls.filter(call => call.startsWith('reserve:')).length).toBe(calls.filter(call => call.startsWith('release:')).length);
      }
      for (const item of [denied, released, rejected, hungWithBrokenTimer, clockFails]) expectValidReceipt(item.receipt);
    });

    it('ROUTE-EXIT-02 cancellation stops before dispatch and after an in-flight abort', async () => {
      const controller = new AbortController();
      controller.abort();
      const early = await shadowRun(policy(), task(), { signal: controller.signal });
      expect(early.dispatched).toEqual([]);
      expect(early.receipt.reason).toBe('cancelled');

      const late = new AbortController();
      const inflight = await shadowRun(policy(), task(), {
        signal: late.signal,
        dispatch: ({ signal }) => new Promise<RoutingDispatchResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          late.abort();
        }),
      });
      expect(inflight.receipt.attempts).toMatchObject([{ reason: 'cancelled' }]);
      expect(inflight.receipt.status).toBe('review');
      expectValidReceipt(inflight.receipt);
    });
  });

  describe('shadow Jev never delays the authoritative result', () => {
    const fast = policy({ candidates: [withOps('cheap', { deadlineMs: 100 }), withOps('reasoning', { deadlineMs: 100 })] });
    const hung = () => new Promise<JevRoutingEvidence>(() => undefined);

    it('ROUTE-JEV-01 a hung Jev call is cut off at the remaining task deadline, not the policy deadline', async () => {
      const started = Date.now();
      const receipt = await runRoutingPilot(fast, task({ deadlineMs: 200 }), {
        enabled: true, ...ledger(), delay: async () => undefined,
        dispatch: async ({ candidate: selected }) => success(selected),
        evidence: hung,
      });
      const elapsed = Date.now() - started;
      expect(receipt.status).toBe('selected');
      expect(receipt.counterfactual).toMatchObject({ status: 'review', reason: 'jev-evidence-timeout' });
      expect(elapsed).toBeLessThan(600);
    });

    it('ROUTE-JEV-02 a caller abort ends the Jev call immediately and the evidence request carries the signal', async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const started = Date.now();
      const pending = runRoutingPilot(fast, task(), {
        enabled: true, ...ledger(), delay: async () => undefined, signal: controller.signal,
        dispatch: async ({ candidate: selected }) => success(selected),
        evidence: request => { seen = (request as { signal?: AbortSignal }).signal; setTimeout(() => controller.abort(), 20); return hung(); },
      });
      const receipt = await pending;
      expect(Date.now() - started).toBeLessThan(500);
      expect(receipt.status).toBe('selected');
      expect(receipt.counterfactual).toMatchObject({ status: 'not-evaluated', reason: 'cancelled' });
      expect(seen?.aborted).toBe(true);
    });

    it('ROUTE-JEV-03 no Jev call starts once the task deadline has passed', async () => {
      let clock = 1_000;
      const evidenceSpy = vi.fn(hung);
      const { receipt } = await shadowRun(fast, task({ deadlineMs: 150 }), {
        now: () => clock,
        dispatch: async ({ candidate: selected }) => { clock += 200; return success(selected); },
        evidence: evidenceSpy,
      });
      expect(receipt.status).toBe('selected');
      expect(receipt.counterfactual).toMatchObject({ status: 'not-evaluated', reason: 'deadline-exhausted' });
      expect(evidenceSpy).not.toHaveBeenCalled();
    });
  });

  it('ROUTE-F11 projects and redacts every model-visible field; description never crosses', async () => {
    const secretDescription = 'deploy with sk-proj-abcdefghijklmnop1234';
    let request: unknown;
    const t = task({}, { description: secretDescription, state: { text: 'token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', hidden: 'must-not-cross' } });
    const { receipt } = await shadowRun(policy(), t, { evidence: async value => { request = value; return evidence(); } });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('sk-proj-abcdefghijklmnop1234');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(serialized).not.toContain('must-not-cross');
    expect(serialized).not.toContain('deploy with');
    expect(Object.keys(request as object).sort()).toEqual(['candidates', 'projectedState', 'projection', 'signal', 'task']);
    expect((request as { task: unknown }).task).toEqual({ id: 'task-1' });
    expect(JSON.stringify(receipt)).not.toContain('sk-proj');
  });

  describe('F13-F18 shadow report', () => {
    const tasks = heldoutTasks();
    const prereg = (overrides: Parameters<typeof thresholds>[0] = {}, items = tasks) => freezeRoutingPreregistration({
      policy: { id: 'routing-pilot', version: '1.0.0', digest: hash('9') },
      baselineArm: 'fixed', registeredAt: REGISTERED_AT, tasks: items, thresholds: thresholds(overrides),
    });
    const build = (observations: RoutingShadowArmObservation[], options: {
      preregistration?: ReturnType<typeof prereg>; trusted?: `sha256:${string}`; holdoutAccessedAt?: string | null;
      integrity?: ReturnType<typeof integrity>;
    } = {}) => {
      const preregistration = options.preregistration ?? prereg();
      return buildRoutingShadowReport({
        id: 'routing-shadow-1', preregistration, trustedPreregistrationDigest: options.trusted ?? preregistration.digest,
        holdoutAccessedAt: options.holdoutAccessedAt === undefined ? HOLDOUT_AT : options.holdoutAccessedAt,
        evaluatedAt: EVALUATED_AT, observations, integrity: options.integrity ?? integrity(),
      });
    };

    it('ROUTE-F13 a well-powered, non-inferior, cheaper candidate is the only PROMOTE baseline', () => {
      const report = build(pairedObservations());
      expect(report.reasons).toEqual([]);
      expect(report.decision).toBe('PROMOTE');
      expect(() => validateRoutingShadowReport(report, report.preregistration.digest)).not.toThrow();
    });

    it('ROUTE-F13 the reviewer probe (n=2, delta -0.5, margin 0.5) cannot be preregistered or PROMOTE', () => {
      expect(() => prereg({ minimumOverallN: 2, minimumSliceN: 1, qualityNonInferiorityMarginBps: 5000 }, tasks.slice(0, 2))).toThrow(/preregistration/);
    });

    it('ROUTE-F13 quality non-inferiority uses the paired interval lower bound, not the point estimate', () => {
      // 4 of 40 tasks regress: point estimate -10 points sits exactly on a 10-point margin, but the lower bound is below it.
      const report = build(pairedObservations(undefined, (_item, index) => (index < 4 ? { success: false } : {})),
        { preregistration: prereg({ maxFailureRate: 0.5 }) });
      expect(report.comparisons.quality.interval).toMatchObject({ estimateBps: -1000, method: 'newcombe-hybrid-score', n: 40 });
      expect(report.comparisons.quality.interval!.lowerBps).toBeLessThan(-1000);
      expect(report.comparisons.quality.decision).toBe('not-non-inferior');
      expect(report.reasons).toContain('quality-non-inferiority');
      expect(report.decision).toBe('HOLD');
    });

    it('ROUTE-F14 arms must observe the same preregistered tasks with preregistered slices', () => {
      const shifted = pairedObservations().map(item => item.arm === 'jev-assisted' ? { ...item, taskId: `${item.taskId}-other` } : item);
      const unpaired = build(shifted);
      expect(unpaired.decision).toBe('HOLD');
      expect(unpaired.reasons).toContain('unpaired-arms');
      expect(unpaired.comparisons.quality.decision).toBe('insufficient');

      const reSliced = pairedObservations().map(item => item.arm === 'fixed' && item.taskId === 't000' ? { ...item, slice: 'code' } : item);
      expect(build(reSliced).reasons).toContain('slice-mismatch');

      const thin = prereg({}, tasks.map((item, index) => ({ ...item, slice: index < 3 ? 'rare' : item.slice })));
      const thinReport = build(pairedObservations(thin.tasks), { preregistration: thin });
      expect(thinReport.reasons).toContain('insufficient-slice:rare');
    });

    it('ROUTE-F15 preregistration is anchored to a trusted digest and timing is enforced', () => {
      const registered = prereg();
      const edited = { ...registered, thresholds: { ...registered.thresholds, qualityNonInferiorityMarginBps: 10_000 } };
      expect(() => build(pairedObservations(), { preregistration: edited, trusted: registered.digest })).toThrow(/preregistration/);
      const rehashed = freezeRoutingPreregistration({ ...edited, registeredAt: edited.registeredAt });
      expect(() => build(pairedObservations(), { preregistration: rehashed, trusted: registered.digest })).toThrow(/preregistration/);

      expect(build(pairedObservations(), { holdoutAccessedAt: '2026-08-01T00:00:00.000Z' }).reasons).toContain('holdout-before-registration');
      expect(build(pairedObservations(), { holdoutAccessedAt: '2026-09-12T00:00:00.000Z' }).reasons).toContain('evaluated-before-holdout');
      expect(build(pairedObservations(), { holdoutAccessedAt: null }).reasons).toContain('holdout-not-accessed');
    });

    it('ROUTE-F16 reuses the shared integrity findings (local-unverified, unverified fresh workspace)', () => {
      const report = build(pairedObservations(), { integrity: {
        ...integrity(), trusted_score_source: 'local-unverified', fresh_workspace_verified: false,
      } });
      expect(report.decision).toBe('HOLD');
      expect(report.integrityFindings).toEqual(['fresh-workspace-unverified', 'untrusted-score-source']);
      expect(build(pairedObservations(), { integrity: integrity('ROLLBACK') }).decision).toBe('ROLLBACK');
      expect(build(pairedObservations(), { integrity: integrity('HOLD') }).decision).toBe('HOLD');
    });

    it('ROUTE-F17 a forged PROMOTE with a recomputed digest is rejected', () => {
      const held = build(pairedObservations(), { integrity: { ...integrity(), trusted_score_source: 'local-unverified' } });
      const { digest: _digest, ...payload } = { ...held, decision: 'PROMOTE' as const, reasons: [], integrityFindings: [] };
      const forged = { ...payload, digest: routingDigest(payload) };
      expect(() => validateRoutingShadowReport(forged, held.preregistration.digest)).toThrow(/rebuilt/);
      const promoted = build(pairedObservations());
      const { digest: _d2, ...cheaper } = { ...promoted, observations: promoted.observations.map(item => ({ ...item, success: true })) };
      expect(() => validateRoutingShadowReport({ ...cheaper, digest: routingDigest(cheaper) }, promoted.preregistration.digest)).not.toThrow();
      expect(() => validateRoutingShadowReport(promoted, hash('0'))).toThrow(/preregistration/);
    });

    it('ROUTE-F18 economics are risk-adjusted and budget compliance uses actual spend', () => {
      // Cheaper first calls but expensive rework: net-negative after rework and failure penalties.
      const rework = build(pairedObservations(undefined, (_item, index) => (index < 5 ? { rework: true, reworkCostMicros: 2_000 } : {})));
      expect(rework.comparisons.economics.netSavingsMicros).toBeLessThan(0);
      expect(rework.reasons).toContain('net-economics');

      const overspent = build(pairedObservations(undefined, (_item, index) => (index === 0 ? { attemptCostMicros: 1_200 } : {})));
      expect(overspent.comparisons.budgetCompliant).toBe(false);
      expect(overspent.reasons).toContain('budget-compliance');

      const slow = build(pairedObservations(undefined, () => ({ latencyMs: 100 })));
      expect(slow.reasons).toContain('latency');
      const overridden = build(pairedObservations(undefined, (_item, index) => (index < 10 ? { humanOverride: true } : {})));
      expect(overridden.reasons).toContain('human-override-rate');
      const chatty = build(pairedObservations(undefined, () => ({ providerCalls: 3 })));
      expect(chatty.reasons).toContain('provider-calls');
    });
  });

  describe('F19 control drill', () => {
    const record = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09')!;
    const driftPolicy = records<DecisionDriftResponse>('drift-response.v1.valid.json').get('triage-drift-response')!;
    const history: AliasEvent[] = [
      { revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest, actualModel: record.champion.actualModel,
        recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null },
      { revision: 2, alias: record.alias, actualIdentityDigest: record.challenger.identityDigest, actualModel: record.challenger.actualModel,
        recordedAt: '2026-09-15T00:00:00.000Z', kind: 'promoted', promotionEligibilityId: record.eligibilityId },
    ];
    const signal: DriftSignal = {
      source: 'label-drift', id: 'label-drift-1', alias: record.alias, metric: 'label-error-rate-delta-v1', valueBps: 500,
      sampleN: 250, thresholdsVersion: driftPolicy.thresholds.version, observedAt: '2026-09-29T00:00:00.000Z',
    };
    const v1: RoutingPin = { id: 'routing-pilot', version: '1.0.0', digest: hash('1') };
    const v2: RoutingPin = { id: 'routing-pilot', version: '1.1.0', digest: hash('2') };

    function control(options: { mutateRunsOnRestore?: boolean; failRestoreCall?: number } = {}) {
      const policies = [v1, v2];
      let runs: RoutingActiveRunPin[] = [
        { runId: 'run-a', policy: v2, aliasRevision: 2, identityDigest: record.challenger.identityDigest },
      ];
      const opened: string[] = [];
      let restoreCalls = 0;
      return {
        opened, policies,
        policyHistory: () => [...policies],
        restorePolicy: vi.fn((target: RoutingPin) => {
          restoreCalls += 1;
          if (restoreCalls === options.failRestoreCall) throw new Error('policy store unavailable');
          policies.push(target);
          if (options.mutateRunsOnRestore) runs = runs.map(run => ({ ...run, policy: target }));
          return target;
        }),
        openJevCircuit: (reason: string) => { opened.push(reason); },
        activeRunPins: () => runs.map(run => ({ ...run })),
      };
    }
    const gateway = () => ({
      aliasHistory: () => history,
      promotionEligibility: () => null,
      promoteAlias: () => { throw new Error('out of scope'); },
      rollbackAlias: vi.fn((alias: string, _target: number, _approval: string, at: string): AliasEvent => ({
        revision: 3, alias, actualIdentityDigest: record.rollbackTarget.identityDigest, actualModel: record.champion.actualModel,
        recordedAt: at, kind: 'rolled-back', promotionEligibilityId: null,
      })),
    });

    it('ROUTE-F19 restores the prior pinned routing policy, opens the Jev circuit and re-verifies active pins', async () => {
      const routing = control();
      const aliases = gateway();
      const result = await runRoutingControlDrill({
        championChallenger: record, driftPolicy, driftSignal: signal, approvalReference: 'review-2620',
        gateway: aliases, control: routing, at: '2026-09-29T00:00:00.000Z',
      });
      expect(routing.restorePolicy).toHaveBeenCalledWith(v1, 'review-2620', '2026-09-29T00:00:00.000Z');
      expect(result.restoredPolicy).toEqual(v1);
      expect(result.previousPolicy).toEqual(v2);
      expect(routing.opened).toEqual(['restore-champion']);
      expect(result.jevCircuitOpen).toBe(true);
      expect(aliases.rollbackAlias).toHaveBeenCalledOnce();
      expect(result.activeRunPins).toEqual([{ runId: 'run-a', policy: v2, aliasRevision: 2, identityDigest: record.challenger.identityDigest }]);
    });

    it('ROUTE-F19 fails when rollback changes an active run pin', async () => {
      await expect(runRoutingControlDrill({
        championChallenger: record, driftPolicy, driftSignal: signal, approvalReference: 'review-2620',
        gateway: gateway(), control: control({ mutateRunsOnRestore: true }), at: '2026-09-29T00:00:00.000Z',
      })).rejects.toThrow(/active run pins changed/);
    });

    it('ROUTE-F19 a pin mismatch throws the drill error with circuit, policy and rollback state', async () => {
      const error = await drillError(gateway(), control({ mutateRunsOnRestore: true }));
      expect(error.message).toMatch(/active run pins changed/);
      expect(error.state.jevCircuitOpen).toBe(true);
      expect(error.state.policyRestored).toBe(true);
      expect(error.state.aliasRolledBack).toBe(true);
      expect(error.state.compensated).toBe(false);
      expect(error.state.currentPolicy).toEqual(v1);
    });

    it('ROUTE-F19 a pin mismatch keeps the before and after pins distinguishable', async () => {
      const error = await drillError(gateway(), control({ mutateRunsOnRestore: true }));
      expect(error.state.activeRunPinsBefore).toEqual([
        { runId: 'run-a', policy: v2, aliasRevision: 2, identityDigest: record.challenger.identityDigest },
      ]);
      expect(error.state.activeRunPinsAfter).toEqual([
        { runId: 'run-a', policy: v1, aliasRevision: 2, identityDigest: record.challenger.identityDigest },
      ]);
      expect(error.state.activeRunPinsAfter).not.toEqual(error.state.activeRunPinsBefore);
    });

    const drill = (aliases: ReturnType<typeof gateway>, routing: ReturnType<typeof control>) => runRoutingControlDrill({
      championChallenger: record, driftPolicy, driftSignal: signal, approvalReference: 'review-2620',
      gateway: aliases, control: routing, at: '2026-09-29T00:00:00.000Z',
    });
    async function drillError(aliases: ReturnType<typeof gateway>, routing: ReturnType<typeof control>): Promise<RoutingControlDrillError> {
      const error = await drill(aliases, routing).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(RoutingControlDrillError);
      return error as RoutingControlDrillError;
    }

    it('ROUTE-F19 a failing policy restore leaves the alias untouched and reports a consistent state', async () => {
      const routing = control({ failRestoreCall: 1 });
      const aliases = gateway();
      const error = await drillError(aliases, routing);
      expect(aliases.rollbackAlias).not.toHaveBeenCalled();
      expect(routing.policies).toEqual([v1, v2]);
      expect(error.state).toEqual({ jevCircuitOpen: true, policyRestored: false, aliasRolledBack: false, compensated: false,
        consistent: true, currentPolicy: v2 });
    });

    it('ROUTE-F19 a D17-refused rollback compensates the policy restore and reports it', async () => {
      const routing = control();
      const aliases = { ...gateway(), aliasHistory: () => history.slice(0, 1) };
      const error = await drillError(aliases, routing);
      expect(error.message).toMatch(/promoted challenger/);
      expect(routing.restorePolicy.mock.calls.map(call => call[0])).toEqual([v1, v2]);
      expect(routing.policies.at(-1)).toEqual(v2);
      expect(routing.opened).toEqual(['restore-champion']);
      expect(error.state).toEqual({ jevCircuitOpen: true, policyRestored: false, aliasRolledBack: false, compensated: true,
        consistent: true, currentPolicy: v2 });
    });

    it('ROUTE-F19 a failed compensation is reported as an inconsistent state', async () => {
      const routing = control({ failRestoreCall: 2 });
      const aliases = { ...gateway(), aliasHistory: () => history.slice(0, 1) };
      const error = await drillError(aliases, routing);
      expect(error.state).toEqual({ jevCircuitOpen: true, policyRestored: true, aliasRolledBack: false, compensated: false,
        consistent: false, currentPolicy: v1 });
    });

    it('ROUTE-F19 has no prior policy to restore to and refuses to invent one', async () => {
      const routing = { ...control(), policyHistory: () => [v2] };
      await expect(runRoutingControlDrill({
        championChallenger: record, driftPolicy, driftSignal: signal, approvalReference: 'review-2620',
        gateway: gateway(), control: routing, at: '2026-09-29T00:00:00.000Z',
      })).rejects.toThrow(/prior pinned routing policy/);
    });
  });

  describe('F20 permission non-widening', () => {
    const cases: Array<[string, Partial<RouteCandidate>, Partial<RoutingTask['requirements']>, string]> = [
      ['tool', { permissions: { ...candidate('x').permissions, tools: ['read', 'write'] } }, {}, 'permission-denied'],
      ['network', { permissions: { ...candidate('x').permissions, network: true } }, {}, 'permission-denied'],
      ['filesystem', { permissions: { ...candidate('x').permissions, filesystem: 'write' } }, {}, 'permission-denied'],
      ['secret', { permissions: { ...candidate('x').permissions, secrets: ['prod-db'] } }, {}, 'permission-denied'],
      ['action', { permissions: { ...candidate('x').permissions, actions: ['advise', 'deploy'] } }, {}, 'permission-denied'],
      ['provider', { model: { ...candidate('x').model, provider: 'unapproved' } }, {}, 'provider-denied'],
      ['region', { policy: { ...candidate('x').policy, regions: ['eu'] } }, {}, 'region-denied'],
      ['required tool missing', { permissions: { ...candidate('x').permissions, tools: [] } }, {}, 'tool-denied'],
    ];

    it.each(cases)('ROUTE-F20 a binding with extra %s authority is excluded before Jev and cannot be selected', async (_label, patch, requirements, reason) => {
      const wide = candidate('wide', patch);
      const p = policy({ candidates: [candidate('safe'), wide], defaultRouteId: 'wide', deterministicFallbackRouteId: 'safe' });
      const seen: string[][] = [];
      const dispatched: RouteCandidate[] = [];
      const { receipt } = await shadowRun(p, task({ allowlist: ['safe', 'wide'], ...requirements }), {
        evidence: async request => {
          seen.push(request.candidates.map(item => item.id));
          return evidence([{ routeId: 'safe', taskFit: 0.1, reasoningNeed: 0.1 }, { routeId: 'wide', taskFit: 1, reasoningNeed: 1 }]);
        },
        dispatch: async ({ candidate: selected }) => { dispatched.push(selected); return success(selected); },
      });
      expect(receipt.excluded).toEqual([{ routeId: 'wide', reasons: [reason] }]);
      expect(seen).toEqual([['safe']]);
      expect(receipt.counterfactual.status).toBe('review');
      expect(dispatched.map(item => item.id)).toEqual(['safe']);
      // The executed binding is the trusted policy entry, unwidened by any output.
      for (const item of dispatched) expect(item).toEqual(candidate('safe'));
    });

    it('ROUTE-F20 the dispatched binding is immutable and carries only its declared permissions', async () => {
      const { receipt } = await shadowRun(policy(), task(), {
        evidence: async () => evidence(),
        dispatch: async ({ candidate: selected }) => {
          expect(Object.isFrozen(selected.permissions)).toBe(true);
          expect(() => { (selected.permissions.tools as string[]).push('write'); }).toThrow();
          return success(selected);
        },
      });
      expect(receipt.status).toBe('selected');
    });
  });

  describe('F21 determinism', () => {
    const makeEvidence = (order: number[], values: JevRoutingEvidence['distributions']) => evidence(order.map(index => values[index]!));
    const three = policy({
      candidates: [candidate('alpha'), candidate('bravo'), candidate('charlie')],
      defaultRouteId: 'alpha', deterministicFallbackRouteId: 'bravo',
    });
    const t = task({ allowlist: ['alpha', 'bravo', 'charlie'] });

    it('ROUTE-F21 the same normalized evidence ranks identically under any completion order', async () => {
      const values: JevRoutingEvidence['distributions'] = [
        { routeId: 'alpha', taskFit: 0.4, reasoningNeed: 0.3 },
        { routeId: 'bravo', taskFit: 0.9, reasoningNeed: 0.3 },
        { routeId: 'charlie', taskFit: 0.6, reasoningNeed: 0.3 },
      ];
      const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
      const receipts = await Promise.all(orders.map((order, index) => shadowRun(
        { ...three, candidates: order.map(i => three.candidates[i]!) }, t, {
          evidence: () => new Promise(resolve => setTimeout(() => resolve(makeEvidence(order, values)), (orders.length - index) * 3)),
        })));
      for (const { receipt } of receipts) {
        expect(receipt.counterfactual.ranking).toEqual(['bravo', 'charlie', 'alpha']);
        expect(receipt.digest).toBe(receipts[0]!.receipt.digest);
      }
    });

    it('ROUTE-F21 exact ties break by route ID and invalid values never rank', async () => {
      const tie = [0, 1, 2].map(index => ({ routeId: ['charlie', 'alpha', 'bravo'][index]!, taskFit: 0.5, reasoningNeed: 0.3 }));
      const { receipt } = await shadowRun(three, t, { evidence: async () => evidence(tie) });
      expect(receipt.counterfactual.ranking).toEqual(['alpha', 'bravo', 'charlie']);
      const invalid = await shadowRun(three, t, { evidence: async () => evidence([...tie.slice(0, 2), { ...tie[2]!, reasoningNeed: Number.NaN }]) });
      expect(invalid.receipt.counterfactual).toMatchObject({ status: 'review', ranking: [] });
    });
  });
});
