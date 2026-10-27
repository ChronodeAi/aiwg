// Assert the exact #3674 marker additions before comparing frozen legacy records.
import { expect } from 'vitest';

const marker = 'AIWG_WORKER_INVOCATION_ID';
export function normalizeMarkerRunRecord(name, baseline, branch) {
  if (name === 'invocation.json') {
    expect(branch.envNames).toEqual([...new Set([...baseline.envNames, marker])]);
    return { ...branch, envNames: baseline.envNames };
  }
  if (name === 'process.json') {
    expect(baseline).not.toHaveProperty('invocationMarker');
    expect(branch.invocationMarker).toBe(branch.invocationId);
    const { invocationMarker, ...unchanged } = branch;
    return unchanged;
  }
  return branch;
}

export function normalizeMarkerCallbackLog(baseline, branch) {
  let records = 0;
  const normalized = branch.map((entry, index) => {
    const previous = baseline[index];
    if (entry.name !== 'publishRecord' || !previous.args[2]?.includes('worker')) return entry;
    records++;
    expect(previous.args[2]).not.toContain('invocationMarker');
    expect(entry.args[2]).toEqual([...previous.args[2], 'invocationMarker'].sort());
    return { ...entry, args: entry.args.map((arg, n) => n === 2 ? previous.args[2] : arg) };
  });
  expect(records).toBeGreaterThan(0);
  return normalized;
}
