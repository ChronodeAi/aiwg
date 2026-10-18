import { describe, it, expect, vi } from 'vitest';
import { medianMs } from '../../helpers/median-ms.ts';

describe('medianMs', () => {
  it('warms up before sampling and rejects isolated scheduler pauses', async () => {
    const durations = [1, 1000, 2, 3, 1000, 4, 5];
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const operation = vi.fn(() => {
      // Warm-up is deliberately much slower than measured work.
      clock += operation.mock.calls.length <= 3 ? 10000 : durations.shift()!;
    });

    expect(await medianMs(operation, 7)).toBe(4);
    expect(operation).toHaveBeenCalledTimes(10);
    expect(now).toHaveBeenCalledTimes(14);
  });

  it.each([10, 50, 100, 200, 1000, 2000, 10000])(
    'retains sensitivity to a sustained slowdown against a %i ms budget',
    async budget => {
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      expect(await medianMs(() => { clock += budget + 1; }, 7)).toBeGreaterThan(budget);
    }
  );

  it('awaits asynchronous operations without overlapping samples', async () => {
    let clock = 0;
    let active = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const operation = vi.fn(async () => {
      active++;
      expect(active).toBe(1);
      await Promise.resolve();
      clock += 5;
      active--;
    });

    expect(await medianMs(operation)).toBe(5);
    expect(operation).toHaveBeenCalledTimes(24);
    expect(active).toBe(0);
  });
});
