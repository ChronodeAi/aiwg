import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compareDecisionLoadBounds,
  type DecisionLoadManifestV2,
  type DecisionLoadObservations,
  type DecisionLoadResourceObservations,
} from '../../../src/decision/qualification/load.js';

const manifest = JSON.parse(readFileSync(
  resolve(process.cwd(), 'docs/decision/load-manifest.v2.json'), 'utf8',
)) as DecisionLoadManifestV2;

const observations: DecisionLoadObservations = {
  arrivals: 100, attempts: 100, completed: 100, failed: 0, shed: 0, cancelled: 0,
  shedReasons: {}, maximumActiveCalls: 1, maximumQueuedCalls: 1,
  maximumEligibleLaneWaitMs: 1, retryAmplificationRatio: 1,
  maximumCancellationLatencyMs: 1, quietPrincipalAdmissionRatio: 1,
  noisyPrincipalAdmissionRatio: 0, virtualDurationMs: 1000,
};

const resources = (cpuSource: DecisionLoadResourceObservations['cpuSource'], cpuPercentOneCore: number)
  : DecisionLoadResourceObservations => ({
    heapUsedMiB: 10, residentMemoryMiB: 100,
    cpuPercentOneCore, cpuSource,
  });

describe('load CPU bound source gate', () => {
  it('enforces the CPU bound when thread-CPU measurement is available', () => {
    const comparisons = compareDecisionLoadBounds(
      manifest, observations, resources('thread', manifest.bounds.maximumCpuPercentOneCore + 1));
    const cpu = comparisons.find(comparison => comparison.bound === 'maximumCpuPercentOneCore');
    expect(cpu).toBeDefined();
    expect(cpu?.pass).toBe(false);
  });

  it('omits the CPU comparison for the wall-clock upper-bound fallback', () => {
    // The fallback is process-wide wall time (runner + sibling workers), so it
    // cannot bound harness CPU. Gating on it fails conforming code on shared
    // runners (observed 100 vs limit 80 across repeated CI runs).
    const comparisons = compareDecisionLoadBounds(manifest, observations, resources('wall-clock-upper-bound', 100));
    expect(comparisons.find(comparison => comparison.bound === 'maximumCpuPercentOneCore')).toBeUndefined();
    expect(comparisons.every(comparison => comparison.pass)).toBe(true);
  });
});
