// Keep the real-time settlement barrier strict about empty-group evidence.
import { describe, expect, it, vi } from 'vitest';
import { waitForEmptyWorkerGroup } from '../../helpers/reaped-worker-spawn.mjs';

describe('worker group settlement barrier', () => {
  it('waits for ESRCH after a still-present group before resolving', async () => {
    const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
    const kill = vi.fn().mockReturnValueOnce(undefined).mockImplementationOnce(() => { throw gone; });
    const pause = vi.fn(async () => {});
    await waitForEmptyWorkerGroup(1234, { kill, pause });
    expect(kill.mock.calls).toEqual([[-1234, 0], [-1234, 0]]);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('does not interpret permission errors as proof of an empty group', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    await expect(waitForEmptyWorkerGroup(1234, { kill: () => { throw denied; } })).rejects.toBe(denied);
  });

  it('fails within its real-time bound if the group remains present', async () => {
    let elapsed = 0;
    await expect(waitForEmptyWorkerGroup(1234, { kill: () => {}, now: () => elapsed,
      pause: async () => { elapsed += 10; }, timeoutMs: 20 })).rejects.toThrow('Worker group 1234 did not empty');
    expect(elapsed).toBe(20);
  });
});
