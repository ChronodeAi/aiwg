// Exercises tightening at the shared resolver boundary without invoking any worker.
import { describe, expect, it } from 'vitest';
import { resolveWorkerPlan } from '../../../src/models/resolver.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

function fixture() {
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.budgets = { perRun: { tokens: 9000, costUsd: 3, wallSeconds: 120 },
    perTask: { tokens: 5000, costUsd: 2, wallSeconds: 90 } };
  f.snapshot.config.parallelism!.retry = { maxAttempts: 4 };
  f.snapshot.constraints = { ceilings: { tokens: 4000, costUsd: 1.5, wallSeconds: 60, maxAttempts: 3 } };
  return f;
}

describe('T-OG-01 tightening-only task ceilings (#3701)', () => {
  it.each([
    ['tokens', 3000, 4000, 4001], ['costUsd', 1, 1.5, 2],
    ['wallSeconds', 30, 60, 61], ['maxAttempts', 2, 3, 4],
  ] as const)('tightens %s, accepts equality and rejects relaxation with both values', (key, tight, resolved, loose) => {
    const f = fixture();
    f.request.ceilings = { [key]: tight };
    const plan = resolveWorkerPlan(f.snapshot, f.request);
    expect(plan.status).toBe('eligible');
    expect(plan.ceilings[key]).toBe(tight);
    expect(plan.origins?.[`/ceilings/${key}`]).toEqual([expect.objectContaining({
      source: 'request', pointer: `/request/ceilings/${key}`, contribution: tight,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })]);
    f.request.ceilings[key] = resolved;
    expect(resolveWorkerPlan(f.snapshot, f.request).status).toBe('eligible');
    f.request.ceilings[key] = loose;
    const blocked = resolveWorkerPlan(f.snapshot, f.request);
    expect(blocked.status).toBe('blocked');
    expect(blocked.selected).toBeNull();
    expect(blocked.diagnostics).toContainEqual({ code: 'OG_POLICY_RELAXATION',
      pointer: `/request/ceilings/${key}`,
      message: `Requested ${key} ceiling ${loose} exceeds resolved policy ceiling ${resolved}.` });
    expect(blocked.ceilings[key]).toBe(resolved);
  });

  it('preserves all equally binding origins and never mutates loader data', () => {
    const f = fixture();
    f.snapshot.config.parallelism!.budgets!.perTask!.tokens = 4000;
    f.request.ceilings = { tokens: 4000 };
    const before = structuredClone(f);
    const plan = resolveWorkerPlan(f.snapshot, f.request);
    expect(f).toEqual(before);
    expect(plan.origins?.['/ceilings/tokens'].map(origin => origin.pointer)).toEqual([
      '/parallelism/budgets/perTask/tokens', '/constraints/ceilings/tokens', '/request/ceilings/tokens',
    ]);
  });

  it.each([
    ['tokens', 50000, 50001], ['wallSeconds', 900, 901], ['maxAttempts', 3, 4],
  ] as const)('includes the existing default %s ceiling before comparing caller values', (key, resolved, loose) => {
    const f = workerResolutionFixture();
    const defaults = { tokens: 50000, wallSeconds: 900 };
    const initial = resolveWorkerPlan(f.snapshot, f.request, defaults);
    expect(initial.ceilings[key]).toBe(resolved);
    f.request.ceilings = { [key]: loose };
    expect(resolveWorkerPlan(f.snapshot, f.request, defaults).diagnostics).toContainEqual(expect.objectContaining({
      code: 'OG_POLICY_RELAXATION', pointer: `/request/ceilings/${key}`,
      message: `Requested ${key} ceiling ${loose} exceeds resolved policy ceiling ${resolved}.`,
    }));
  });

  it('includes a stricter configured health hard stop and allows a new cost restriction', () => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.health = { hardTimeoutSeconds: 45 };
    f.request.ceilings = { costUsd: 0, wallSeconds: 46 };
    const plan = resolveWorkerPlan(f.snapshot, f.request);
    expect(plan.ceilings).toMatchObject({ costUsd: 0, wallSeconds: 45 });
    expect(plan.origins?.['/ceilings/wallSeconds'][0].pointer).toBe('/parallelism/health/hardTimeoutSeconds');
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_POLICY_RELAXATION' }));
    f.request.ceilings.wallSeconds = 45;
    expect(resolveWorkerPlan(f.snapshot, f.request).status).toBe('eligible');
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects invalid caller counts (%s)', tokens => {
    const f = fixture();
    f.request.ceilings = { tokens };
    expect(resolveWorkerPlan(f.snapshot, f.request).diagnostics).toContainEqual(expect.objectContaining({
      code: 'OG_CONFIG_REFERENCE', pointer: '/request/ceilings/tokens',
    }));
  });
});
