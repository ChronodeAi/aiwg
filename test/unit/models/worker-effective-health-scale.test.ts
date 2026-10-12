/**
 * Regression coverage for the health-window scaling example numbers quoted
 * in the generated parallelism-cap guidance (#1362 fix-first review item 5):
 * scale is the single largest applicable role/effort/model factor, never
 * their product, and only the hard deadline + its grace periods are capped
 * by the remaining wall-clock/transport ceilings — startup/quiet/stall keep
 * their configured or scaled values and are instead flagged via
 * `truncatedWindows` when they would exceed that capped deadline.
 *
 * @source @src/serve/worker-invocation.ts resolveWorkerEffectiveHealth()
 */
import { describe, expect, it } from 'vitest';
import { resolveWorkerEffectiveHealth } from '../../../src/serve/worker-invocation.js';

describe('resolveWorkerEffectiveHealth scaling (#1362 guidance example numbers)', () => {
  it('reasoning at xhigh effort resolves 180s/600s from the 90s/300s defaults using the MAX factor, not a product', () => {
    // role 'reasoning' default factor is 2; effort 'xhigh' default factor is
    // also 2. If scaling multiplied factors together the result would be a
    // scale of 4 (360s/1200s) — the correct behavior takes the max (2).
    const health = resolveWorkerEffectiveHealth(undefined, {
      role: 'reasoning', effort: 'xhigh', modelKey: 'fixture/model', profileRef: 'fixture',
      wallSeconds: 100000, stepEnforcement: 'unavailable',
    });
    expect(health.scale).toBe(2);
    expect(health.quietSeconds).toBe(180);
    expect(health.stallSeconds).toBe(600);
  });

  it('an effective 1.25 scale (no role/effort factor above it) gives 112.5s/375s', () => {
    // role 'efficiency' default factor is 1; no effort scaling applied
    // (effort: null); a configured modelScale of 1.25 is then the single
    // largest applicable factor.
    const health = resolveWorkerEffectiveHealth({ modelScale: { 'fixture/model': 1.25 } }, {
      role: 'efficiency', effort: null, modelKey: 'fixture/model', profileRef: 'fixture',
      wallSeconds: 100000, stepEnforcement: 'unavailable',
    });
    expect(health.scale).toBe(1.25);
    expect(health.quietSeconds).toBe(112.5);
    expect(health.stallSeconds).toBe(375);
  });

  it('only the hard deadline and its grace periods are capped by wall/transport ceilings; startup/quiet/stall keep their scaled values and are flagged via truncatedWindows', () => {
    const health = resolveWorkerEffectiveHealth(undefined, {
      role: 'reasoning', effort: 'xhigh', modelKey: 'fixture/model', profileRef: 'fixture',
      wallSeconds: 30, transportSeconds: 20, stepEnforcement: 'unavailable',
    });
    // hardTimeoutSeconds is capped to the smaller of the two ceilings.
    expect(health.hardTimeoutSeconds).toBe(20);
    // startup/quiet/stall are NOT reduced to fit inside the capped deadline.
    expect(health.startupSeconds).toBe(60);
    expect(health.quietSeconds).toBe(180);
    expect(health.stallSeconds).toBe(600);
    // Each of them exceeds the capped hard deadline, so all three are flagged.
    expect(health.truncatedWindows).toEqual(['startup', 'quiet', 'stall']);
    // Grace periods, unlike startup/quiet/stall, ARE capped to the deadline.
    expect(health.diagnosticGraceSeconds).toBe(20);
    expect(health.terminateGraceSeconds).toBe(5);
  });
});
