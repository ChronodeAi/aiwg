// Exercise worker-context refusal and recovery boundaries with temporary workdirs and local fakes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureWorkerContextBootstrap, flagDeployDirtiedSkipWorktree,
  syncWorkerContextProviders, WorkerContextBootstrapError,
} from '../../../src/config/worker-context.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function workdir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-context-refusal-'));
  roots.push(dir);
  return dir;
}
function result(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null, ...overrides };
}
function options() {
  return {
    workdir: workdir(), provider: 'muse', aiwgBin: 'synthetic-aiwg',
    statusFn: vi.fn().mockReturnValueOnce({ present: false, missing: ['kernel skills'] })
      .mockReturnValue({ present: true, missing: [] }),
    syncFn: vi.fn(async ({ providers }: { providers: string[] }) => ({ providers, updated: true })),
  };
}

describe('T-OG-04 worker context sync and launch refusals', () => {
  it.each([undefined, 'relative-workdir'])('refuses an invalid sync workdir %j before reading config', async dir => {
    const readConfig = vi.fn();
    await expect(syncWorkerContextProviders({ workdir: dir as string, providers: ['muse'], readConfig }))
      .rejects.toMatchObject({ code: 'OG_WORKER_CONTEXT_UNAVAILABLE', workdir: dir,
        remedy: 'sync worker context providers only into the worker workdir' });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it.each([undefined, 'relative-workdir'])('refuses an invalid launch workdir %j before checking status', async dir => {
    const opts = options();
    await expect(ensureWorkerContextBootstrap({ ...opts, workdir: dir as string }))
      .rejects.toMatchObject({ code: 'OG_WORKER_CONTEXT_UNAVAILABLE', provider: 'muse', workdir: dir });
    expect(opts.statusFn).not.toHaveBeenCalled();
    expect(opts.syncFn).not.toHaveBeenCalled();
  });

  it('refuses a nonexistent workdir inside the temporary fixture before sync', async () => {
    const opts = options();
    await expect(ensureWorkerContextBootstrap({ ...opts, workdir: path.join(opts.workdir, 'missing') }))
      .rejects.toThrow(/existing absolute workdir/);
    expect(opts.syncFn).not.toHaveBeenCalled();
  });

  it.each([new Error('read-only config'), 'read-only config'])('wraps sync failure %j and never deploys', async failure => {
    const opts = options();
    const deployFn = vi.fn();
    await expect(ensureWorkerContextBootstrap({ ...opts, deployFn, syncFn: async () => { throw failure; } }))
      .rejects.toMatchObject({ name: 'WorkerContextBootstrapError', code: 'OG_WORKER_CONTEXT_UNAVAILABLE',
        provider: 'muse', workdir: opts.workdir, message: 'worker context sync failed: read-only config',
        remedy: expect.stringContaining(path.join(opts.workdir, '.aiwg/aiwg.config')) });
    expect(deployFn).not.toHaveBeenCalled();
  });

  it('preserves typed sync refusals with their original remedy', async () => {
    const refusal = new WorkerContextBootstrapError('invalid providers', 'repair the provider list');
    const deployFn = vi.fn();
    await expect(ensureWorkerContextBootstrap({ ...options(), deployFn, syncFn: async () => { throw refusal; } }))
      .rejects.toBe(refusal);
    expect(deployFn).not.toHaveBeenCalled();
  });

  it('refuses invalid explicit providers before syncing', async () => {
    const opts = options();
    await expect(ensureWorkerContextBootstrap({ ...opts, providers: ['muse,codex'] }))
      .rejects.toThrow(/non-empty array of provider ids/);
    expect(opts.syncFn).not.toHaveBeenCalled();
  });

  it('reports a missing deploy binary with its install remedy', async () => {
    const opts = options();
    const spawn = vi.fn().mockReturnValue(result({ error: new Error('ENOENT'), status: null }));
    await expect(ensureWorkerContextBootstrap({ ...opts, spawn: spawn as typeof spawnSync, timeoutMs: 1234 }))
      .rejects.toMatchObject({ code: 'OG_WORKER_CONTEXT_UNAVAILABLE', provider: 'muse', workdir: opts.workdir,
        message: expect.stringContaining('failed to run (ENOENT)'),
        remedy: expect.stringContaining("tried 'synthetic-aiwg'") });
    expect(spawn).toHaveBeenCalledExactlyOnceWith('synthetic-aiwg',
      ['use', 'all', '--target', opts.workdir, '--yes'], { cwd: opts.workdir, encoding: 'utf8', timeout: 1234 });
    expect(opts.statusFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 7, stderr: '  refused by deployer  ', diagnostic: 'exited 7: refused by deployer;' },
    { status: null, stderr: undefined, diagnostic: 'exited null: ;' },
  ])('refuses unsuccessful deploy status $status', async ({ status, stderr, diagnostic }) => {
    const opts = options();
    const spawn = vi.fn().mockReturnValue(result({ status, stderr }));
    await expect(ensureWorkerContextBootstrap({ ...opts, spawn: spawn as typeof spawnSync }))
      .rejects.toMatchObject({ message: expect.stringContaining(diagnostic),
        remedy: expect.stringContaining('resolve the reported failure before launch') });
    expect(opts.statusFn).toHaveBeenCalledTimes(1);
  });

  it('bounds deploy stderr in refusal diagnostics', async () => {
    const spawn = vi.fn().mockReturnValue(result({ status: 1, stderr: 'x'.repeat(2001) + 'TRAILER' }));
    await expect(ensureWorkerContextBootstrap({ ...options(), spawn: spawn as typeof spawnSync }))
      .rejects.toMatchObject({ message: expect.stringContaining('x'.repeat(2000) + '; missing') });
  });

  it('wraps a non-Error deploy failure with the bootstrap diagnostic', async () => {
    await expect(ensureWorkerContextBootstrap({ ...options(), deployFn: () => { throw 'disk full'; } }))
      .rejects.toMatchObject({ message: expect.stringContaining('worker context deploy failed: disk full; missing in '),
        remedy: expect.stringContaining('resolve the reported failure before launch') });
  });

  it('preserves typed deploy refusals', async () => {
    const refusal = new WorkerContextBootstrapError('deploy refused', 'repair the target');
    await expect(ensureWorkerContextBootstrap({ ...options(), deployFn: () => { throw refusal; } }))
      .rejects.toBe(refusal);
  });

  it('uses the synced provider set for default deploy and skips failed git bridge discovery', async () => {
    const opts = options();
    const spawn = vi.fn().mockReturnValueOnce(result()).mockReturnValue(result({ status: 128 }));
    await expect(ensureWorkerContextBootstrap({ ...opts, providers: [], spawn: spawn as typeof spawnSync,
      syncFn: async ({ providers }) => {
        expect(providers).toEqual(['muse']);
        return { providers: ['codex', 'muse'], updated: true };
      },
    })).resolves.toEqual({ ensured: true, providers: ['codex', 'muse'], skippedBridges: [] });
    expect(opts.statusFn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1].slice(0, 2)).toEqual(['git', ['status', '--porcelain=v1', '--untracked-files=no']]);
  });

  it('returns bridges flagged after a successful default deploy', async () => {
    const spawn = vi.fn().mockReturnValueOnce(result())
      .mockReturnValueOnce(result({ stdout: ' M AGENTS.md\n' })).mockReturnValue(result());
    await expect(ensureWorkerContextBootstrap({ ...options(), spawn: spawn as typeof spawnSync }))
      .resolves.toEqual({ ensured: true, providers: ['muse'], skippedBridges: ['AGENTS.md'] });
    expect(spawn.mock.calls[2].slice(0, 2)).toEqual(['git', ['update-index', '--skip-worktree', '--', 'AGENTS.md']]);
  });
});

describe('T-OG-04 git bridge discovery errors', () => {
  it('reports spawn failures from git status', () => {
    const spawn = vi.fn().mockReturnValue(result({ error: new Error('git unavailable') }));
    expect(() => flagDeployDirtiedSkipWorktree({ workdir: workdir(), spawn: spawn as typeof spawnSync }))
      .toThrow('git status failed: git unavailable');
  });

  it('leaves a clean workdir alone even if status stdout is absent', () => {
    const spawn = vi.fn().mockReturnValue(result({ stdout: undefined }));
    expect(flagDeployDirtiedSkipWorktree({ workdir: workdir(), spawn: spawn as typeof spawnSync })).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('flags rename destinations and passes paths with spaces as single arguments', () => {
    const dir = workdir();
    const spawn = vi.fn().mockReturnValueOnce(result({ stdout: 'R  old.md -> new bridge.md\n' }))
      .mockReturnValue(result());
    expect(flagDeployDirtiedSkipWorktree({ workdir: dir, spawn: spawn as typeof spawnSync, timeoutMs: 456 }))
      .toEqual(['new bridge.md']);
    expect(spawn).toHaveBeenLastCalledWith('git', ['update-index', '--skip-worktree', '--', 'new bridge.md'],
      { cwd: dir, encoding: 'utf8', timeout: 456 });
  });

  it.each([' M "quoted\\tname.md"\n', 'R  old.md -> '])('refuses an unflaggeable status path %j', stdout => {
    const spawn = vi.fn().mockReturnValue(result({ stdout }));
    expect(() => flagDeployDirtiedSkipWorktree({ workdir: workdir(), spawn: spawn as typeof spawnSync }))
      .toThrow(/dirtied an unflaggeable path/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: new Error('index locked') }, { status: 1, stderr: ' index rejected ' }, { status: 1, stderr: undefined },
  ])('reports update-index failure %j', failure => {
    const spawn = vi.fn().mockReturnValueOnce(result({ stdout: ' M AGENTS.md\n' }))
      .mockReturnValue(result(failure));
    expect(() => flagDeployDirtiedSkipWorktree({ workdir: workdir(), spawn: spawn as typeof spawnSync }))
      .toThrow(`git update-index --skip-worktree failed: ${failure.error?.message ?? failure.stderr?.trim() ?? ''}`);
  });
});
