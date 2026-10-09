/** T-OG-21: exact windows and synthetic monotonic supervision; runtime retries S2+. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkerEffectiveHealth } from '../../../src/serve/worker-invocation.js';
import { validateWorkerPayload } from '../../../src/mission-protocol/codecs.js';
import { createWorkerHealthObserver, sampleOwnedWorktreeContent } from '../../../tools/ralph-external/lib/worker-health.mjs';

const input = { role: 'coding', effort: 'high', modelKey: 'fixture/model', profileRef: 'fixture', wallSeconds: 1800,
  stepEnforcement: 'observed' as const };
function fixture(windows: any = {}) {
  let now = 0;
  const observer = createWorkerHealthObserver({ invocationId: 'fixture-stall', now: () => now, wallNow: () => Date.UTC(2026, 9, 8),
    health: { handshake: 'semantic', outputFraming: 'jsonl', progressEvidence: ['completed'], coverage: 'full' }, effectiveHealth: windows });
  observer.observe({ kind: 'accepted' });
  return { observer, set: (time: number) => { now = time; } };
}

describe('T-OG-21 exact frozen effective health', () => {
  it.each([
    ['coding', 'high', 1, 90, 300], ['efficiency', 'low', 1, 90, 300],
    ['reasoning', 'high', 2, 180, 600], ['coding', 'xhigh', 2, 180, 600], ['reasoning', 'max', 3, 270, 900],
  ])('%s/%s default scale is max, never product', (role, effort, scale, quietSeconds, stallSeconds) => {
    const health = resolveWorkerEffectiveHealth(undefined, { ...input, role: String(role), effort: String(effort) });
    expect(health).toMatchObject({ startupSeconds: 60, checkSeconds: 15, quietSeconds, stallSeconds,
      diagnosticGraceSeconds: 60, terminateGraceSeconds: 5, hardTimeoutSeconds: 1800, scale });
    expect(validateWorkerPayload('workerEffectiveHealth', health).valid).toBe(true);
  });
  it('fractional model scale yields exactly 112.5/375 seconds', () => {
    const health = resolveWorkerEffectiveHealth({ modelScale: { 'fixture/model': 1.25 } }, input);
    expect(health).toMatchObject({ scale: 1.25, quietSeconds: 112.5, stallSeconds: 375, startupSeconds: 60 });
    expect(validateWorkerPayload('workerEffectiveHealth', health).valid).toBe(true);
  });
  it('scale clamp and remaining wall/transport/step intersections preserve short tasks', () => {
    const health = resolveWorkerEffectiveHealth({ modelScale: { 'fixture/model': 8 }, maxSteps: 100 },
      { ...input, wallSeconds: 20, transportSeconds: 10, remainingSteps: 4 });
    expect(health).toMatchObject({ scale: 6, quietSeconds: 540, stallSeconds: 1800, hardTimeoutSeconds: 10, maxSteps: 4 });
    expect(health.startupSeconds).toBe(60);
  });
  it.each([{ checkSeconds: 61 }, { startupSeconds: 5 }, { quietSeconds: 300 }, { stallSeconds: 0 }, { quietSeconds: NaN }])('rejects invalid window %j', config => {
    expect(() => resolveWorkerEffectiveHealth(config, input)).toThrow();
  });
  it('startup override uses canonical model and is unscaled', () => {
    expect(resolveWorkerEffectiveHealth({ modelScale: { 'fixture/model': 4 }, modelStartupSeconds: { 'fixture/model': 100 } }, input))
      .toMatchObject({ startupSeconds: 100, quietSeconds: 360, stallSeconds: 1200 });
  });
});

describe('T-OG-21 no-progress and deadline observations', () => {
  it('520 distinct keys and 60 later completions never falsely stall or become hung', () => {
    const f = fixture();
    const hard = f.observer.snapshot().hardDeadlineAt;
    for (let i = 0; i < 520; i++) {
      f.set(i);
      f.observer.observe({ kind: 'progress', key: `completed-${i}` });
    }
    f.observer.check();
    for (let i = 520; i < 580; i++) {
      f.set(519 + (i - 519) * 15000);
      f.observer.observe({ kind: 'progress', key: `completed-${i}` });
      expect(f.observer.check()).toMatchObject({ state: 'active', reasonCode: 'PROGRESS', hardDeadlineAt: hard });
      const progress = f.observer.snapshot().lastProgressAt;
      f.set(520 + (i - 519) * 15000);
      f.observer.observe({ kind: 'progress', key: `completed-${i}` });
      expect(f.observer.snapshot().lastProgressAt).toBe(progress);
      expect(f.observer.shouldStop()).toBe(false);
    }
    expect(f.observer.evidence().events).toHaveLength(64);
    expect(f.observer.evidence().gaps).toEqual([]);
  });
  it('late accepted-start and completion cannot escape expired monotonic windows', () => {
    let now = 0;
    const observer = createWorkerHealthObserver({ health: { handshake: 'semantic', outputFraming: 'jsonl' }, now: () => now });
    now = 61000; observer.observe({ kind: 'accepted' });
    expect(observer.snapshot()).toMatchObject({ state: 'failed-to-start', handshake: 'unobserved', reasonCode: 'STARTUP_DEADLINE' });
    expect(observer.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).toBe('failed');
    const f = fixture({ hardTimeoutSeconds: 10 }); f.set(10001);
    expect(f.observer.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }))
      .toMatchObject({ state: 'failed', reasonCode: 'HARD_DEADLINE' });
  });
  it('fractional quiet/stall boundaries are exact and polling cannot reset them', () => {
    const f = fixture({ quietSeconds: 112.5, stallSeconds: 375 });
    const hard = f.observer.snapshot().hardDeadlineAt;
    f.set(112499); expect(f.observer.check().state).toBe('started');
    f.set(112500); expect(f.observer.check().state).toBe('quiet');
    f.set(374999); expect(f.observer.check().state).toBe('quiet');
    f.set(375000); expect(f.observer.check().state).toBe('stalled');
    expect(f.observer.snapshot().hardDeadlineAt).toBe(hard);
    f.set(435000); expect(f.observer.check().state).toBe('hung');
  });
  it.each(['error', 'heartbeat', 'cpu', 'activity'])('%s never postpones stall', kind => {
    const f = fixture();
    f.observer.observe({ kind: 'progress', key: 'first' });
    const progress = f.observer.snapshot().lastProgressAt;
    for (let time = 15000; time <= 300000; time += 15000) {
      f.set(time);
      if (kind === 'cpu') f.observer.sampleActivity({ running: true, cpu: time });
      else f.observer.observe({ kind, reasonCode: 'RATE_LIMIT' });
      f.observer.check();
    }
    expect(f.observer.snapshot()).toMatchObject({ state: 'stalled', lastProgressAt: progress });
  });
  it('progress during diagnostic grace resumes but never extends hard ceiling', () => {
    const f = fixture(); f.set(300000); f.observer.check();
    const hard = f.observer.snapshot().hardDeadlineAt;
    f.set(301000); f.observer.observe({ kind: 'progress', key: 'after-diagnostic' });
    expect(f.observer.check().state).toBe('active');
    expect(f.observer.snapshot().hardDeadlineAt).toBe(hard);
  });
  it('same filename content edits are progress; caches/logs and identical content are excluded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-health-content-'));
    try {
      const filename = path.join(root, 'file.txt'); await writeFile(filename, 'first');
      const first = await sampleOwnedWorktreeContent(root, { files: ['file.txt'] });
      await writeFile(filename, 'second');
      const second = await sampleOwnedWorktreeContent(root, { files: ['file.txt'] });
      expect(second).not.toBe(first);
      const f = fixture(); f.observer.sampleActivity({ content: first }); f.set(1000);
      f.observer.sampleActivity({ content: second }); const progress = f.observer.snapshot().lastProgressAt;
      expect(progress).not.toBeNull(); f.set(2000); f.observer.sampleActivity({ content: second });
      expect(f.observer.snapshot().lastProgressAt).toBe(progress);
      expect(await sampleOwnedWorktreeContent(root, { files: ['trace.log'] }))
        .toBe(await sampleOwnedWorktreeContent(root, { files: [] }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('final before crash and an unconfirmed stop never complete execution', () => {
    const f = fixture(); f.observer.observe({ kind: 'terminal', success: true });
    expect(f.observer.finish({ exitCode: 1, signal: 'SIGKILL', termination: 'uncertain', finalValid: true }))
      .toMatchObject({ state: 'crashed', termination: 'uncertain' });
  });
});
