// The settle helper must not depend on machine speed (main CI failure, 2026-10-29).
import { describe, expect, it } from 'vitest';
import { setTimeout as realWait } from 'node:timers/promises';
import { advanceUntilSettled } from '../../helpers/worker-lifecycle.mjs';

describe('advanceUntilSettled', () => {
  it('waits in real time for work that outlasts the virtual budget, without advancing the clock further', async () => {
    let advanced = 0;
    // Settles only after real time passes, as a child close event does on a slow host.
    const slow = realWait(150).then(() => 'closed');
    const result = await advanceUntilSettled(slow, {
      advance: async (ms: number) => { advanced += ms; }, stepMs: 5, maxMs: 20, pause: async () => {},
    });
    expect(result).toBe('closed');
    expect(advanced).toBe(20);
  });

  it('still fails clearly when nothing settles within the virtual budget plus the real grace', async () => {
    const never = new Promise(() => {});
    await expect(advanceUntilSettled(never, { advance: async () => {}, maxMs: 10, realGraceMs: 50 }))
      .rejects.toThrow('Worker did not settle within 10 virtual ms plus 50 real ms');
  });

  it('propagates the worker failure', async () => {
    await expect(advanceUntilSettled(Promise.reject(new Error('boom')), { advance: async () => {} })).rejects.toThrow('boom');
  });
});
