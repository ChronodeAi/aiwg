// Regressions for the three #2928 reviewer reproductions and dead-owner retries.
import { AsyncResource } from 'node:async_hooks';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyConfig, writeAiwgConfig, readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { applyWorkerAdoption, proposeWorkerAdoption, recoverWorkerAdoption } from '../../../src/config/worker-adoption.js';
import { workerDispatchBlocked, workerWriteLock } from '../../../src/config/worker-write.js';
import { assertWorkerActivationCurrent } from '../../../src/config/worker-activation-gate.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const options = { regenerate: async () => {} };
const bytes = (files: string[]) => Promise.all(files.map(file => readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-adoption-recovery-')); roots.push(root);
  for (const dir of ['install/agentic/code/frameworks/sdlc-complete/config', 'user', 'corpus']) await mkdir(join(root, dir), { recursive: true });
  vi.stubEnv('AIWG_HOME', join(root, 'install'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, 'corpus'));
  await writeFile(join(root, 'install/agentic/code/frameworks/sdlc-complete/config/models-v2.json'), JSON.stringify({ version: '2.0', defaults: { provider: 'codex', tier: 'standard' }, tiers: {}, providers: {} }));
  await writeAiwgConfig(root, { ...emptyConfig(), providers: ['codex'], parallelism: { worker_dispatch: true, worker_mode: 'managed' } });
  await writeFile(join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {} } }));
  const proposal = await proposeWorkerAdoption(root, { parallelism: { worker_dispatch: true, worker_mode: 'managed', max_parallel_subagents: 2 } });
  return { root, proposal, authority: { digest: proposal.digest } };
}
async function paused(root: string, action: string, step: string, proposal: unknown) {
  const file = join(root, 'review.json'); await writeFile(file, JSON.stringify(proposal));
  const child = fork(new URL('../../fixtures/worker-adoption/interrupted-owner.mts', import.meta.url), [root, action, step, file], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  const message = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(([code]) => { throw new Error(`fixture exited before checkpoint: ${code}`); })]);
  expect(message).toEqual({ step });
  return child;
}
async function kill(child: ChildProcess) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await kill(child);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('T-OG-13 #2928 recovery ownership FR-OG-056', () => {
  it('R01 refuses recovery overlapping a live apply and never exposes a mixed pair', async () => {
    const f = await fixture();
    await applyWorkerAdoption(f.root, f.proposal, f.authority, options);
    const previous = (await readAiwgConfig(f.root))!.parallelism!.activation;
    const proposal = await proposeWorkerAdoption(f.root, { parallelism: { worker_dispatch: true, worker_mode: 'managed', max_parallel_subagents: 3 }, workerSelection: { guards: { denySelfDelegation: true } } });
    const reader = new AsyncResource('independent-reader');
    await applyWorkerAdoption(f.root, proposal, { digest: proposal.digest }, { ...options, checkpoint: async step => {
      if (step === 'blocked') {
        const retained = await readFile(join(workerWriteLock(f.root), 'recovery.json'), 'utf8');
        await expect(recoverWorkerAdoption(f.root, { digest: proposal.digest }, options)).rejects.toThrow(/live|owned|locked/);
        expect(await readFile(join(workerWriteLock(f.root), 'recovery.json'), 'utf8')).toBe(retained);
      }
      if (step === 'blocked' || step === 'models') {
        expect(workerDispatchBlocked(f.root)).toBe(true);
        expect(() => assertWorkerActivationCurrent(f.root, previous)).toThrow(/closed/);
        await expect(reader.runInAsyncScope(() => new ConfigLoader(f.root).load(proposal.before.parallelism!))).rejects.toThrow(/closed/);
        await expect(writeAiwgConfig(f.root, emptyConfig())).rejects.toThrow(/locked/);
      }
    } });
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it('R02 rejects old proposal and standing authority after returning to identical direct bytes', async () => {
    const f = await fixture();
    const direct = { worker_dispatch: true, worker_mode: 'direct' as const, max_parallel_subagents: 2 };
    await writeAiwgConfig(f.root, { ...emptyConfig(), providers: ['codex'], parallelism: direct });
    const original = await proposeWorkerAdoption(f.root, { parallelism: { ...direct, worker_mode: 'managed' } });
    const standing = { project: f.root, revision: original.baseRevision, fields: ['/parallelism/worker_mode'] };
    await applyWorkerAdoption(f.root, original, standing, options);
    const back = await proposeWorkerAdoption(f.root, { parallelism: direct });
    await applyWorkerAdoption(f.root, back, { digest: back.digest }, options);
    const fresh = await proposeWorkerAdoption(f.root, { parallelism: { ...direct, worker_mode: 'managed' } });
    expect(fresh.baseRevision).toBe(original.baseRevision + 2);
    for (const authority of [standing, { digest: original.digest }]) await expect(applyWorkerAdoption(f.root, original, authority, options)).rejects.toThrow(/Stale proposal/);
    await expect(applyWorkerAdoption(f.root, fresh, standing, options)).rejects.toThrow(/authorization/);
    await applyWorkerAdoption(f.root, fresh, { digest: fresh.digest }, options);
    expect((await readAiwgConfig(f.root))!.parallelism!.activation!.revision).toBe(original.baseRevision + 3);
  });

  it('R03 retries interrupted recovery despite a leftover legacy recover-lock', async () => {
    const f = await fixture();
    await expect(applyWorkerAdoption(f.root, f.proposal, f.authority, { regenerate: async () => { throw new Error('retain block'); } })).rejects.toThrow(/Dispatch remains closed/);
    await mkdir(join(workerWriteLock(f.root), 'recover-lock'));
    await recoverWorkerAdoption(f.root, f.authority, { regenerate: async () => {
      expect(workerDispatchBlocked(f.root)).toBe(true);
      expect(() => assertWorkerActivationCurrent(f.root)).toThrow(/closed/);
    } });
    expect(workerDispatchBlocked(f.root)).toBe(false);
    expect(existsSync(workerWriteLock(f.root))).toBe(false);
  });

  it.each(['blocked', 'locked'])('R04 reclaims a dead apply paused at %s, including incomplete initialization', async step => {
    const f = await fixture();
    const child = await paused(f.root, 'apply', step, f.proposal);
    await expect(new ConfigLoader(f.root).load()).rejects.toThrow(`--authorize '${f.proposal.digest}'`);
    await expect(recoverWorkerAdoption(f.root, f.authority, options)).rejects.toThrow(/live|owned|locked/);
    await kill(child);
    await recoverWorkerAdoption(f.root, f.authority, { regenerate: async () => { expect(workerDispatchBlocked(f.root)).toBe(true); } });
    expect(workerDispatchBlocked(f.root)).toBe(false);
    expect((await readAiwgConfig(f.root))!.parallelism!.activation).toBeUndefined();
  });

  it('R05 reclaims a dead recovery before it writes any recovery metadata', async () => {
    const f = await fixture();
    await kill(await paused(f.root, 'apply', 'blocked', f.proposal));
    const recovery = await paused(f.root, 'recover', 'recovery:owned', f.proposal);
    await expect(recoverWorkerAdoption(f.root, f.authority, options)).rejects.toThrow(/live|owned|locked/);
    await kill(recovery);
    await recoverWorkerAdoption(f.root, f.authority, options);
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it.each(['blocked', 'models', 'config:0', 'activation', 'regenerated'])('R07 fences a displaced apply at %s without removing the successor or restoring over it', async step => {
    const f = await fixture();
    const initial = await readFile(join(f.root, '.aiwg/aiwg.config'), 'utf8');
    let heldBytes: (string | null)[] = [];
    await expect(applyWorkerAdoption(f.root, f.proposal, f.authority, { ...options, checkpoint: async current => {
      if (current !== step) return;
      const owner = JSON.parse(await readFile(join(workerWriteLock(f.root), 'owner.json'), 'utf8'));
      const successor = randomUUID();
      await symlink(JSON.stringify({ ...owner, generation: successor }), join(workerWriteLock(f.root), `next-${owner.generation}`));
      heldBytes = await bytes(f.proposal.inputs.map(input => input.file));
    } })).rejects.toThrow(/ownership lost/);
    expect(await bytes(f.proposal.inputs.map(input => input.file))).toEqual(heldBytes);
    expect(workerDispatchBlocked(f.root)).toBe(true);
    expect(existsSync(workerWriteLock(f.root))).toBe(true);
    if (step === 'blocked' || step === 'models') expect(await readFile(join(f.root, '.aiwg/aiwg.config'), 'utf8')).toBe(initial);
  });

  it('R08 serializes competing recovery claimants and retains the block through verification', async () => {
    const f = await fixture();
    await kill(await paused(f.root, 'apply', 'blocked', f.proposal));
    const results = await Promise.allSettled([1, 2].map(() => recoverWorkerAdoption(f.root, f.authority, {
      ...options, checkpoint: async () => { expect(workerDispatchBlocked(f.root)).toBe(true); },
    })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it('R09 advances the independent revision on direct, disabled and no-op adoptions', async () => {
    const f = await fixture();
    for (const parallelism of [{ worker_dispatch: true, worker_mode: 'direct' as const }, { worker_dispatch: false }, { worker_dispatch: false }]) {
      const proposal = await proposeWorkerAdoption(f.root, { parallelism });
      await applyWorkerAdoption(f.root, proposal, { digest: proposal.digest }, options);
      expect((await proposeWorkerAdoption(f.root, {})).baseRevision).toBe(proposal.baseRevision + 1);
      await expect(applyWorkerAdoption(f.root, proposal, { digest: proposal.digest }, options)).rejects.toThrow(/Stale proposal/);
    }
  });

  it('R10 preserves the consumed revision when recovering a crash after the commit marker', async () => {
    const f = await fixture();
    await kill(await paused(f.root, 'apply', 'committed', f.proposal));
    await recoverWorkerAdoption(f.root, f.authority, options);
    const next = await proposeWorkerAdoption(f.root, {});
    expect(next.baseRevision).toBe(f.proposal.baseRevision + 1);
    await expect(applyWorkerAdoption(f.root, f.proposal, f.authority, options)).rejects.toThrow(/Stale proposal/);
  });

  it('R11 refuses an unverifiable remote owner but distinguishes a reused local PID', async () => {
    const f = await fixture();
    await kill(await paused(f.root, 'apply', 'blocked', f.proposal));
    const file = join(workerWriteLock(f.root), 'owner.json');
    const original = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...original, host: `${original.host}-other` }));
    await expect(recoverWorkerAdoption(f.root, f.authority, options)).rejects.toThrow(/unverifiable owner/);
    expect(workerDispatchBlocked(f.root)).toBe(true);
    // A live PID is insufficient to identify a process whose start identity differs.
    await writeFile(file, JSON.stringify({ ...original, pid: process.pid, start: 'previous-boot:previous-start' }));
    await recoverWorkerAdoption(f.root, f.authority, options);
    expect(workerDispatchBlocked(f.root)).toBe(false);
  });

  it('R06 names the project, recovery record and exact command for direct/disabled blocked reads', async () => {
    const f = await fixture();
    await expect(applyWorkerAdoption(f.root, f.proposal, f.authority, { regenerate: async () => { throw new Error('retain block'); } })).rejects.toThrow(/Dispatch remains closed/);
    for (const parallelism of [{ worker_dispatch: true, worker_mode: 'direct' as const }, { worker_dispatch: false }]) {
      const error = await new ConfigLoader(f.root).load(parallelism).then(() => { throw new Error('Expected blocked read'); }, error => error as Error);
      expect(error.message).toContain(f.root);
      expect(error.message).toContain(join(workerWriteLock(f.root), 'recovery.json'));
      expect(error.message).toContain(`aiwg config set --project --target '${f.root}' --recover --authorize '${f.proposal.digest}'`);
    }
  });
});
