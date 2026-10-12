import { assertFlakeRecord } from './helper.mjs';

/**
 * Example bundle metric provider (#2831).
 *
 * Deterministic and offline: no network, no clock, no randomness. It counts
 * boolean `failed` records per slice into a `proportion` series that backs
 * `count-max`, `minimum-n` and `interval-bound` gates. Records are the only
 * input; the host seals the result with the trusted code and records digests.
 */

export const provider = {
  id: 'example.count/v1',
  version: '1.0.0',
  description: 'Example per-slice failure counts for offline gate evaluation.',
  metrics: {
    flakes: { kind: 'proportion', description: 'Failed records per slice.' },
  },
  compute(records) {
    if (!Array.isArray(records)) throw new Error('example records must be an array');
    const tables = new Map();
    for (const row of records) {
      assertFlakeRecord(row);
      const current = tables.get(row.slice) ?? { n: 0, events: 0 };
      tables.set(row.slice, { n: current.n + 1, events: current.events + (row.failed ? 1 : 0) });
    }
    const bySlice = {};
    for (const [slice, counts] of tables) bySlice[slice] = { ...counts };
    const pooled = Object.values(bySlice).reduce(
      (sum, observation) => ({ n: sum.n + observation.n, events: sum.events + observation.events }),
      Object.keys(bySlice).length ? { n: 0, events: 0 } : null,
    );
    return { metrics: { flakes: { bySlice, pooled } } };
  },
};

export default provider;
