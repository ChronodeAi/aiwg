// Shared measurement conventions for bounded synthetic orchestration timing checks.
import { arch, cpus, platform } from 'node:os';

/** Nearest-rank p95: the 95th sorted observation for exactly 100 samples. */
export function p95(samples: number[]) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing samples');
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
}

export function timingReport(scenario: string, samples: number[], phases: string[]) {
  return { scenario, samples: samples.length, p95Ms: p95(samples), phases,
    fixture: 'workerResolutionFixture: 2 members, 2 models, cached synthetic snapshot',
    host: { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length,
      cpu: cpus()[0]?.model ?? 'unknown' } };
}
