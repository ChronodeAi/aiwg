import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { SessionLauncher, RECOVERY_SCOPE_OPEN_CODE, resetInProcessAllowanceLedger }
  from '../../../tools/ralph-external/session-launcher.mjs';

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  resetInProcessAllowanceLedger();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('operator recovery transition summaries (#2915 T-OG-22)', () => {
  it.each([false, true])('forwards one actionable summary across checks and refusals (overlapping launchers: %s)', async overlapping => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const root = await mkdtemp(path.join(os.tmpdir(), 'ralph-transition-'));
    roots.push(root);
    const workdir = path.join(root, 'work');
    await mkdir(workdir);
    const brief = path.join(root, 'brief.md');
    await writeFile(brief, 'synthetic transition summary task');
    const f = workerResolutionFixture();
    const adapter = f.snapshot.registry.providers.codex.workerAdapter;
    const profile = adapter.invocationProfiles['fixture-shell'];
    profile.envAllowlist = [];
    profile.health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
      sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot',
      qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
    f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
    f.snapshot.config.parallelism.retry = { maxAttempts: 10 };
    const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
      buildInvocation: async input => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'], stdin: 'closed', envNames: [] }),
      extractFinal: () => null,
    };
    const drivers = { codex: driver };
    f.snapshot.installations.codex.boundary = driver.qualification.boundary;
    const breaker = new ScopedFailureBreaker({ nowMs: () => 1_000_000, jitterMs: () => 0 });
    const launcher = new SessionLauncher();
    const summaries = vi.fn();
    launcher.on('recovery-transition', summaries);
    let seq = 0;
    const launch = async (owner = launcher, onLaunched = async () => {}) => {
      const attempt = ++seq;
      const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir,
        final_output: path.join(root, `final-${attempt}.json`) };
      const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(plan.invocation).toBeDefined();
      const invocationPath = path.join(root, `plan-${attempt}.json`);
      await writeFile(invocationPath, JSON.stringify(plan));
      return owner.launchWorker({ invocationPath, runDir: path.join(root, `run-${attempt}`), scopedBreaker: breaker,
        inputs: { snapshot: f.snapshot, drivers }, now: f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async options => {
          await options.onDispatchCommit?.();
          await onLaunched();
          return { mode: 'degraded', child: spawn(path.join(root, 'missing-provider'), [], { stdio: ['ignore', 'pipe', 'pipe'] }) };
        },
      });
    };
    try {
      if (overlapping) {
        let entered = 0;
        let ready;
        let release;
        const allEntered = new Promise(resolve => { ready = resolve; });
        const continueLaunch = new Promise(resolve => { release = resolve; });
        const active = Array.from({ length: 3 }, (_, index) => {
          const owner = new SessionLauncher();
          if (index > 0) owner.on('recovery-transition', summaries);
          return launch(owner, async () => { if (++entered === 3) ready(); await continueLaunch; });
        });
        await allEntered;
        expect(breaker.listenerCount('transition')).toBe(3);
        // One transition object is delivered to all attached launchers by
        // EventEmitter; the operator surface must claim it only once.
        breaker.emit('transition', { summary: 'host:test: pause covered launches' });
        expect(summaries).toHaveBeenCalledOnce();
        summaries.mockClear();
        release();
        const outcomes = await Promise.all(active);
        expect(outcomes).toHaveLength(3);
        for (const outcome of outcomes) expect(outcome).toMatchObject({ errorCode: 'ENOENT', termination: 'confirmed' });
      } else {
        for (let i = 0; i < 3; i++) {
          await expect(launch()).resolves.toMatchObject({ errorCode: 'ENOENT', termination: 'confirmed' });
          expect(breaker.listenerCount('transition')).toBe(0);
        }
      }
      expect(breaker.listenerCount('transition')).toBe(0);
      expect(summaries).toHaveBeenCalledOnce();
      const event = summaries.mock.calls[0][0];
      expect(event).toMatchObject({ from: 'closed', to: 'open' });
      expect(event.summary).toContain(event.scopeKey);
      expect(event.summary).toMatch(/pause covered launches/);
      expect(event.summary).toMatch(/wait \d+ms/);
      for (let i = 0; i < 3; i++) {
        breaker.snapshot();
        breaker.getState(event.scopeKey);
        await expect(launch()).rejects.toMatchObject({ code: RECOVERY_SCOPE_OPEN_CODE });
        expect(breaker.listenerCount('transition')).toBe(0);
      }
      expect(summaries).toHaveBeenCalledOnce();
      const capture = JSON.parse(await readFile(path.join(root, 'run-3', 'exit.json'), 'utf8'));
      expect(capture).toMatchObject({ termination: 'confirmed' });
    } finally { breaker.destroy(); }
  });
});
