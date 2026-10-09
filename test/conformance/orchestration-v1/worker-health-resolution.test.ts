/** T-OG-01 S1: synthetic offline health preferences; no spawn, files, accounts or inference. */
import { describe, expect, it } from 'vitest';
import { validateParallelismConfig } from '../../../src/config/aiwg-config.js';
import { resolveWorkerEffectiveHealth } from '../../../src/serve/worker-invocation.js';
import { encodeWorkerPayload, decodeWorkerPayload, validateWorkerPayload } from '../../../src/mission-protocol/codecs.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';

const input = { role: 'reasoning', effort: 'max', modelKey: 'fixture/model', profileRef: 'fixture', wallSeconds: 1800,
  stepEnforcement: 'unavailable' as const };

describe('T-OG-01 S1 health resolution and source origins', () => {
  it('H01 old configuration remains valid and unchanged', () => {
    const config = { max_parallel_subagents: 4 };
    const before = JSON.stringify(config);
    expect(validateParallelismConfig(config)).toEqual([]);
    expect(JSON.stringify(config)).toBe(before);
  });
  it.each([
    [{ checkSeconds: 61 }, 'checkSeconds'],
    [{ startupSeconds: 5 }, 'checkSeconds'],
    [{ quietSeconds: 300 }, 'quietSeconds'],
    [{ cooldownSeconds: 901 }, 'cooldownSeconds'],
    [{ cooldownSeconds: 30, maxCooldownSeconds: 20 }, 'cooldownSeconds'],
    [{ roleScale: { review: 2 } }, 'roleScale'],
    [{ roleScale: { coding: 7 } }, 'roleScale'],
    [{ modelScale: { 'fixture/model': 0 } }, 'modelScale'],
    [{ modelScale: { 'fixture/bad/key': 2 } }, 'modelScale'],
    [{ modelStartupSeconds: { 'fixture/model': 5 } }, 'modelStartupSeconds'],
    [{ stallSeconds: NaN }, 'stallSeconds'],
    [{ hardTimeoutSeconds: Infinity }, 'hardTimeoutSeconds'],
    [{ probeSeconds: 0 }, 'probeSeconds'],
    [{ halfOpenMaxProbes: 2 }, 'halfOpenMaxProbes'],
  ])('H02 invalid preferences %j reject with an actionable field', (health, field) => {
    expect(validateParallelismConfig({ health }).join(';')).toContain(field);
  });
  it('H03 default sources and max factors are deterministic and frozen by the descriptor', () => {
    const first = resolveWorkerEffectiveHealth(undefined, input);
    expect(first).toMatchObject({ quietSeconds: 270, stallSeconds: 900, hardTimeoutSeconds: 1800,
      scale: 3, stepEnforcement: 'unavailable', origins: {
        scale: ['defaults/parallelism.health.effortScale.max'],
        hardTimeoutSeconds: ['defaults/parallelism.health.hardTimeoutSeconds', 'runtime/remainingWallSeconds'],
      } });
    expect(resolveWorkerEffectiveHealth(undefined, input)).toEqual(first);
    expect(decodeWorkerPayload('workerEffectiveHealth', encodeWorkerPayload('workerEffectiveHealth', first))).toEqual(first);
  });
  it('H04 fractional max and explicit model startup keep all exact source pointers', () => {
    const config = { roleScale: { reasoning: 1.5 }, effortScale: { max: 1.25 }, modelScale: { 'fixture/model': 2.25 },
      modelStartupSeconds: { 'fixture/model': 45 } };
    const health = resolveWorkerEffectiveHealth(config, input);
    expect(health).toMatchObject({ scale: 2.25, quietSeconds: 202.5, stallSeconds: 675, startupSeconds: 45,
      origins: { startupSeconds: ['/parallelism/health/modelStartupSeconds/fixture~1model'],
        scale: ['/parallelism/health/modelScale/fixture~1model'] } });
    config.modelScale['fixture/model'] = 6;
    expect(health.scale).toBe(2.25);
  });
  it('H05 short parent/transport ceilings truncate windows, clip grace and disclose their origins', () => {
    const health = resolveWorkerEffectiveHealth({ hardTimeoutSeconds: 3600 }, { ...input, wallSeconds: 10,
      transportSeconds: 3, remainingSteps: 4, profileSteps: 2 });
    expect(health).toMatchObject({ hardTimeoutSeconds: 3, maxSteps: 2, diagnosticGraceSeconds: 3,
      terminateGraceSeconds: 3, truncatedWindows: ['startup', 'quiet', 'stall'], origins: {
        hardTimeoutSeconds: ['profile/transportSeconds'], maxSteps: ['profile/maxSteps'] } });
  });
  it('H06 a configured hard ceiling replaces the default while remaining parent ceilings still win', () => {
    expect(resolveWorkerEffectiveHealth({ hardTimeoutSeconds: 3600 }, { ...input, wallSeconds: 4000 }).hardTimeoutSeconds).toBe(3600);
    expect(resolveWorkerEffectiveHealth({ hardTimeoutSeconds: 3600 }, { ...input, wallSeconds: 2000 }).hardTimeoutSeconds).toBe(2000);
  });
  it('H06b the shared observer preserves the configured deadline beyond the default', () => {
    let now = 0;
    const effectiveHealth = resolveWorkerEffectiveHealth({ hardTimeoutSeconds: 3600 }, { ...input, wallSeconds: 4000 });
    const observer = createWorkerHealthObserver({ invocationId: 'health-3600', now: () => now,
      wallNow: () => Date.UTC(2026, 9, 8), effectiveHealth });
    expect(observer.snapshot().hardDeadlineAt).toBe('2026-10-08T01:00:00.000Z');
    now = 1801000;
    expect(observer.check().reasonCode).not.toBe('HARD_DEADLINE');
    now = 3600000;
    expect(observer.check().reasonCode).toBe('HARD_DEADLINE');
  });
  it('H07 task cadence and trusted startup ceiling only tighten configured values', () => {
    const health = resolveWorkerEffectiveHealth({ startupSeconds: 60, checkSeconds: 15 }, {
      ...input, startupCeilingSeconds: 20, checkSeconds: 2 });
    expect(health).toMatchObject({ startupSeconds: 20, checkSeconds: 2,
      origins: { startupSeconds: ['runtime/startupCeilingSeconds'], checkSeconds: ['task/checkSeconds'] } });
  });
  it.each(['observed', 'unavailable'] as const)('H08 required step cap rejects %s observations', stepEnforcement => {
    expect(() => resolveWorkerEffectiveHealth({ requireStepCap: true }, { ...input, stepEnforcement })).toThrow('not qualified');
  });
  it.each(['native', 'external'] as const)('H09 qualified %s step cap preserves the smallest remaining ceiling', stepEnforcement => {
    expect(resolveWorkerEffectiveHealth({ requireStepCap: true, maxSteps: 20 }, {
      ...input, stepEnforcement, remainingSteps: 10, profileSteps: 5 })).toMatchObject({ maxSteps: 5, stepEnforcement });
  });
  it('H10 valid existing probe preferences require no new namespace or state', () => {
    expect(validateParallelismConfig({ health: { maxCooldownSeconds: 1000, probeSeconds: 5,
      probeMaxBytes: 2048, halfOpenMaxProbes: 1 } })).toEqual([]);
  });
  it('H11 legacy effective-health shape stays valid without synthesized metadata', () => {
    const { origins, truncatedWindows, ...legacy } = resolveWorkerEffectiveHealth(undefined, input);
    expect(origins).toBeDefined();
    expect(truncatedWindows).toEqual([]);
    expect(validateWorkerPayload('workerEffectiveHealth', legacy).valid).toBe(true);
    expect(decodeWorkerPayload('workerEffectiveHealth', encodeWorkerPayload('workerEffectiveHealth', legacy))).toEqual(legacy);
  });
});
