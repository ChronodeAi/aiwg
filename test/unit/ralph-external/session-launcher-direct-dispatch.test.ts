/**
 * Unit tests for the Tier 0 gate-then-launch composition (FR-OG-107/108, #2888).
 *
 * @source @tools/ralph-external/session-launcher.mjs planDirectWorkerLaunch
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore - ESM import
import { planDirectWorkerLaunch, resetInProcessAllowanceLedger } from '../../../tools/ralph-external/session-launcher.mjs';

import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';

let clientFixture: ReturnType<typeof systemdClientFixture>;
beforeEach(() => {
  clientFixture = systemdClientFixture();
  vi.stubEnv('PATH', clientFixture.root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(clientFixture.root, { recursive: true, force: true });
});

const dispatchOnConfig = { parallelism: { worker_dispatch: true } };
const okLive = { supported: true, availMemGb: 64, loadRatio: 0.01, memPsiAvg10: 0, memPsiAvg60: 0, workers: 0, freeDiskGb: 64 };
const hotLive = { supported: true, availMemGb: 1, loadRatio: 2.5, memPsiAvg10: 50, memPsiAvg60: 50, workers: 20, freeDiskGb: 0.5 };
const okSpawn = (binary: string) => (path.basename(binary) === 'systemd-run'
  ? { status: 0, stdout: 'systemd 255\n', error: null }
  : { status: 0, stdout: '255\n', error: null });

describe('planDirectWorkerLaunch gate-then-launch (T-OG-16, FR-OG-107/108)', () => {
  it('never spawns when the host-resource gate blocks on synthetic over-threshold signals', async () => {
    let spawnCalls = 0;
    const outcome = await planDirectWorkerLaunch({
      name: 'blocked-demo', memoryMaxGb: 4, command: '/usr/bin/fixture-worker',
      config: dispatchOnConfig, live: hotLive,
      spawn: (() => { spawnCalls += 1; throw new Error('must not spawn: gate must refuse launch first'); }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, blocked: true });
    expect(Array.isArray((outcome as any).failures)).toBe(true);
    expect((outcome as any).failures.length).toBeGreaterThan(0);
    expect(spawnCalls).toBe(0);
  });

  it('is a no-op pass-through when worker_dispatch is off (legacy behaviour), regardless of host signals', async () => {
    let spawnCalls = 0;
    const outcome = await planDirectWorkerLaunch({
      name: 'legacy', memoryMaxGb: 2, command: '/usr/bin/fixture-worker', cwd: '/tmp/work', logFile: '/tmp/work/worker.log',
      config: { parallelism: { worker_dispatch: false } }, live: hotLive,
      isolation: { mode: 'systemd-unit', reason: 'fake' }, proposeUnit: () => 'aiwg-worker-legacy-1',
      spawn: ((binary: string, argv: string[]) => {
        spawnCalls += 1;
        if (path.basename(binary) === 'systemctl') return { status: 0, stdout: '4242\n', stderr: '', error: null };
        return { status: 0, stdout: '', stderr: '', error: null };
      }) as never,
    });
    // The gate itself was bypassed (legacy, enabled:false) even though the
    // injected host signals are over every default threshold; the launch
    // proceeds to the isolated-launch step.
    expect(outcome).toMatchObject({ launched: true, mode: 'systemd-unit' });
    expect(spawnCalls).toBeGreaterThan(0);
  });

  it('launches through systemd-run only after a passing dispatch gate, reusing its result as the launch gate', async () => {
    const calls: string[][] = [];
    const outcome = await planDirectWorkerLaunch({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/fixture-worker', args: ['--role', 'coding'],
      cwd: '/tmp/work', logFile: '/tmp/work/worker.log',
      config: dispatchOnConfig, live: okLive,
      isolation: { mode: 'systemd-unit', reason: 'fake' }, proposeUnit: () => 'aiwg-worker-demo-7',
      spawn: ((binary: string, argv: string[]) => {
        calls.push([binary, ...argv]);
        if (path.basename(binary) === 'systemctl') return { status: 0, stdout: '4242\n', stderr: '', error: null };
        return { status: 0, stdout: '', stderr: '', error: null };
      }) as never,
    });
    expect(outcome).toMatchObject({ launched: true, mode: 'systemd-unit', unit: 'aiwg-worker-demo-7', pid: 4242 });
    expect((outcome as any).gate).toMatchObject({ enabled: true, ok: true });
    const launchCall = calls.find(call => call[0] === clientFixture.binary)!;
    expect(launchCall).toContain('MemoryMax=4G');
    expect(launchCall).toContain('MemorySwapMax=0');
  });

  it('refuses a silent unconfined launch on a passing gate without a reachable systemd user manager', async () => {
    const outcome = await planDirectWorkerLaunch({
      name: 'degraded-demo', memoryMaxGb: 1, command: '/usr/bin/fixture-worker',
      config: dispatchOnConfig, live: okLive,
      spawn: (() => { throw new Error('spawn ENOENT: no systemd-run in this fixture'); }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, mode: 'degraded' });
    expect((outcome as any).diagnostic).toContain('allowDegraded');
  });

  it('detects isolation itself (no injected isolation) and still never spawns on a blocked gate', async () => {
    const outcome = await planDirectWorkerLaunch({
      name: 'real-detect', memoryMaxGb: 1, command: '/usr/bin/fixture-worker',
      config: dispatchOnConfig, live: hotLive, spawn: okSpawn as never,
    });
    expect(outcome).toMatchObject({ launched: false, blocked: true });
  });

  it('samples free disk on the worker worktree by default, failing closed without live signals', async () => {
    const seen: string[] = [];
    const outcome = await planDirectWorkerLaunch({
      name: 'disk-demo', memoryMaxGb: 1, command: '/usr/bin/fixture-worker', cwd: '/tmp/work',
      config: dispatchOnConfig,
      readers: {
        statfsPath: (sampled: string) => {
          seen.push(sampled);
          return { bavail: 0n, bsize: 4096n };
        },
      },
      spawn: (() => { throw new Error('must not spawn: disk-pressured gate must refuse launch first'); }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, blocked: true });
    expect((outcome as any).failures).toContainEqual(expect.objectContaining({ signal: 'free-disk' }));
    expect(seen).toEqual(['/tmp/work']);
  });
});

// T-OG-22: standalone planner admissions must have an operator consumer too.
describe('standalone recovery transition summaries', () => {
  it('reports a real planner probe/canary transition once and preserves unavailable-profile reasons', async () => {
    let time = 0;
    const breaker = new ScopedFailureBreaker({ nowMs: () => time, jitterMs: () => 0 });
    const summaries = vi.fn();
    try {
      for (let n = 0; n < 3; n++) {
        const { token } = breaker.admit({ invocationId: `failed-${n}`, scopeKeys: ['quota:shared'] });
        breaker.settle(token, { kind: 'failed', reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher',
          quotaAccount: 'shared', confirmedStop: true });
      }
      time = 120_000;
      const options = { name: 'planner-summary', command: process.execPath, args: ['--version'],
        invocation: { transport: 'shell', selected: { cli: 'fixture' }, limits: { wallSeconds: 30 } },
        config: dispatchOnConfig, live: okLive, scopedBreaker: breaker, onRecoveryTransition: summaries,
        taskChainDigest: 'planner-summary', maxAttempts: 2,
        drivers: { fixture: { qualification: { installation: { accountScope: 'shared' } } } },
      };
      const result = await planDirectWorkerLaunch(options);
      expect(result).toMatchObject({ launched: false, blocked: true,
        diagnostic: expect.stringContaining('restore a qualified scope-relevant probe'),
        probeDiagnostic: { reason: 'probe-profile-unavailable' } });
      expect(summaries.mock.calls.map(([event]) => event.to)).toEqual(['half-open', 'open', 'operator-intervention']);
      for (let n = 0; n < 3; n++) {
        time += 1_000_000;
        await planDirectWorkerLaunch(options);
      }
      expect(summaries).toHaveBeenCalledTimes(3);
      expect(breaker.listenerCount('transition')).toBe(0);
    } finally { breaker.destroy(); resetInProcessAllowanceLedger(); }
  });
});
