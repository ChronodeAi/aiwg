// Partial direct dispatch timing through the existing gate and isolated-launch boundary.
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveWorkerPlan } from '../../../src/models/resolver.js';
import { planDirectWorkerLaunch } from '../../../tools/ralph-external/session-launcher.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { timingReport } from '../../fixtures/orchestration-timing.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('T-OG-16 NFR-OG-001 P01 100 warm unqueued fake launches have p95 dispatch-to-launch <= 5 seconds', async () => {
  const client = systemdClientFixture();
  roots.push(client.root);
  vi.stubEnv('PATH', client.root);
  vi.stubEnv('HOME', client.root);
  const f = workerResolutionFixture();
  // A four-file, <1 KiB synthetic warm workspace; setup is outside the timer.
  writeFileSync(path.join(client.root, 'brief.txt'), 'synthetic timing brief\n');
  const samples: number[] = [];
  let launchAt = 0; let launches = 0;
  const fakeSpawn = (binary: string, argv: string[]) => {
    if (binary === client.binary) {
      if (!argv.includes('MemoryMax=1G')) throw new Error('Missing isolation ceiling');
      launchAt = performance.now();
      launches++;
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    if (binary !== client.systemctl) throw new Error('Unexpected fixture command');
    return { status: 0, stdout: argv.includes('MainPID') ? '4242\n' : '', stderr: '', error: null };
  };
  for (let index = 0; index < 105; index++) {
    launchAt = 0;
    const start = performance.now();
    const plan = resolveWorkerPlan(f.snapshot, f.request);
    expect(plan.status).toBe('eligible');
    const result = await planDirectWorkerLaunch({
      name: `timing-${index}`, memoryMaxGb: 1, command: process.execPath, args: ['fixture-worker.mjs'],
      cwd: client.root, stdinPath: path.join(client.root, 'brief.txt'),
      env: { HOME: client.root, PATH: client.root }, envNames: ['HOME', 'PATH'],
      config: f.snapshot.config,
      live: { supported: true, availMemGb: 64, loadRatio: 0, memPsiAvg10: 0, memPsiAvg60: 0, workers: 0, freeDiskGb: 64 },
      isolation: { mode: 'systemd-unit', reason: 'synthetic timing fixture' },
      scopedBreaker: null, // No recovery admission or background unit-settlement observer in this fixture.
      proposeUnit: () => `aiwg-worker-timing-${index}`, spawn: fakeSpawn as never,
    });
    expect(result).toMatchObject({ launched: true, mode: 'systemd-unit', pid: 4242, gate: { enabled: true, ok: true } });
    expect(launchAt).toBeGreaterThanOrEqual(start);
    if (index >= 5) samples.push(launchAt - start);
  }
  const report = timingReport('P01', samples, ['cached resolve', 'synthetic resource gate', 'isolation argv/environment', 'fake systemd-run submission']);
  console.info(JSON.stringify(report));
  expect(launches).toBe(105); // Five warmups, then exactly 100 measured, serial/unqueued launches.
  expect(report.samples).toBe(100);
  expect(report.p95Ms).toBeLessThanOrEqual(5_000);
}, 30_000);
