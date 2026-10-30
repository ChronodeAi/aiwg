import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCodexWorkerSandbox } from '../../../tools/cli/worker-qualification.mjs';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn(),
}));

beforeEach(() => { vi.mocked(execFile).mockReset(); });

describe('Codex model-free qualification sandbox check', () => {
  it('reports external as skipped without starting a subprocess', async () => {
    expect(await checkCodexWorkerSandbox({ executable: '/fixture/codex', cwd: '/fixture/tree',
      environment: {}, sandbox: 'external' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('disabled') });
    expect(execFile).not.toHaveBeenCalled();
  });
  it('runs a bounded shell no-op with only the supplied worker environment', async () => {
    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      args.at(-1)(null, '', '');
    }) as any);
    const environment = { PATH: '/usr/bin:/bin', HOME: '/fixture/home' };
    expect(await checkCodexWorkerSandbox({ executable: '/fixture/codex', cwd: '/fixture/tree', environment })).toEqual({ status: 'passed' });
    expect(execFile).toHaveBeenCalledExactlyOnceWith('/fixture/codex', [
      'sandbox', '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_workspace_write.network_access=false', '--', '/bin/sh', '-c', 'true',
    ], { cwd: '/fixture/tree', env: environment, timeout: 10_000,
      maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }, expect.any(Function));
  });

  it.each(['exit failure', 'timeout', 'output limit'])('blocks approval and redacts subprocess output on %s', async reason => {
    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      args.at(-1)(Object.assign(new Error('synthetic-secret'), { reason }), 'synthetic-secret', 'synthetic-secret');
    }) as any);
    await expect(checkCodexWorkerSandbox({ executable: '/fixture/codex', cwd: '/fixture/tree',
      environment: { PATH: '/usr/bin:/bin' } })).rejects.toThrow(
      'Codex sandbox no-op check failed; verify PATH and host sandbox support before qualifying again');
  });
});
