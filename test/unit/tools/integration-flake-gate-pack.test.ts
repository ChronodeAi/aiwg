import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RUNS,
  FLAKE_GATE_PACK_PATH,
  FLAKE_GATE_POLICY_DEFAULTS,
  loadFlakeGatePolicy,
  runFlakeGate,
} from '../../../tools/scripts/integration-flake-gate.mjs';
import { loadGatePackFile } from '../../../src/gates/discovery.js';

function outputBuffer() {
  let content = '';
  return {
    stream: { write: (chunk: string) => { content += chunk; } },
    read: () => content,
  };
}

describe('integration flake gate pack wiring', () => {
  it('derives its default run count from the ci-flake pack requiredRuns default', () => {
    const pack = loadGatePackFile(FLAKE_GATE_PACK_PATH);
    expect(pack.spec.parameters?.requiredRuns?.default).toBe(50);
    expect(DEFAULT_RUNS).toBe(pack.spec.parameters?.requiredRuns?.default);
    expect(loadFlakeGatePolicy().requiredRuns).toBe(DEFAULT_RUNS);
  });

  it('takes the per-run failure outcome from the pack failures gate onFail', () => {
    const pack = loadGatePackFile(FLAKE_GATE_PACK_PATH);
    const failuresGate = pack.spec.gates.find((gate) => gate.kind === 'count-max');
    expect(failuresGate?.onFail).toBe('ROLLBACK');
    expect(FLAKE_GATE_POLICY_DEFAULTS.failureOutcome).toBe('ROLLBACK');
    expect(loadFlakeGatePolicy().failureOutcome).toBe(failuresGate?.onFail);
  });

  it('decides ROLLBACK through the shared lattice on the first failed run', () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 3, stdout: 'second output', stderr: 'second error' });

    const result = runFlakeGate({
      totalRuns: 4,
      spawn,
      now: (() => { let clock = 0; return () => (clock += 10); })(),
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(result).toMatchObject({ ok: false, status: 1, decision: 'ROLLBACK', failedRun: 2 });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('decides PROMOTE when every run passes', () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    let clock = 0;

    const result = runFlakeGate({
      totalRuns: 2,
      spawn,
      now: () => (clock += 10),
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(result).toMatchObject({ ok: true, status: 0, decision: 'PROMOTE', completedRuns: 2 });
  });
});
