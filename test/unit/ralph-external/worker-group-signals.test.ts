import { spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { isSafeWorkerGroupTarget, sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('worker group signal targets', () => {
  it.each([0, 1, -1, 1.5, NaN, undefined, process.pid, 54321])('rejects unsafe target %s', pgid => {
    expect(isSafeWorkerGroupTarget(pgid, { pgid: 54321 })).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('refuses an unavailable caller identity', () => {
    expect(isSafeWorkerGroupTarget(54321, null)).toBe(false);
    expect(isSafeWorkerGroupTarget(54321, {})).toBe(false);
  });

  it('permits a distinct positive worker group', () => {
    expect(isSafeWorkerGroupTarget(54321, { pgid: 12345 })).toBe(true);
  });

  it.each([0, 1, -1, 1.5, NaN, undefined, process.pid, sampleWorkerIdentity(process.pid)?.pgid])('OMP close, timeout and explicit kill refuse target %s', async pid => {
    const root = await mkdtemp(path.join(tmpdir(), 'worker-group-signals-'));
    roots.push(root);
    const child: any = new EventEmitter();
    Object.assign(child, { pid, killed: false, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const launcher = new SessionLauncher();
    launcher.setProviderAdapter({ getName: () => 'omp', getBinary: () => '/fixture/worker',
      getEnvOverrides: () => ({}), buildSessionArgs: () => [], parseOutput: () => ({ success: true }) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = launcher._launchSession({ prompt: 'test', workingDir: root,
      stdoutPath: path.join(root, 'stdout'), stderrPath: path.join(root, 'stderr'), timeoutMs: 10 });
    launcher.kill();
    await vi.advanceTimersByTimeAsync(6010);
    child.emit('close', 0);
    await done;
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
