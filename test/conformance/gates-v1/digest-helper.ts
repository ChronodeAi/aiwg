import type { ExecutedQualification } from '../../../src/decision/qualification/runner.js';
import type { QualificationReleaseInputs } from '../../../src/decision/qualification/release.js';
import { cleanIntegrity } from './helper.js';

const pin = (n: number): `sha256:${string}` => `sha256:${String(n).padStart(64, '0')}`;

/** Minimal builder input that exercises the real release-record digest path without the runner. */
export function syntheticReleaseInput(): { executed: ExecutedQualification; input: QualificationReleaseInputs } {
  const executed = {
    manifest: { runId: 'digest-vector', sourceCommit: 'a'.repeat(40), dirty: false, cases: [], evidence: [] },
    report: { gates: [], decision: 'HOLD' },
    verification: [],
  } as unknown as ExecutedQualification;
  const digest = pin(7);
  const input: QualificationReleaseInputs = {
    commands: ['vitest run'], environment: 'synthetic-node',
    pins: { definition: pin(1), ruleset: pin(2), binding: pin(3), adapter: pin(4), requestedModel: pin(5),
      servedModel: pin(6), policy: pin(8), calibration: pin(9), dataset: pin(10), split: pin(11), seed: pin(12),
      priceCatalog: pin(13), compilePrefixCache: pin(14), receiptReplay: pin(15), resultCache: pin(16) },
    budgets: { calls: 10 }, actuals: { calls: 0 }, reviewer: 'reviewed-by-operator',
    integrity: { ...cleanIntegrity(), release_gate: { decision: 'HOLD', reasons: ['digest-vector'] } },
    benchmark: { planDigest: digest, trustedPlanDigest: digest, decision: 'pass', sampleN: 10, minimumN: 10 },
    metrics: { overall: { sampleN: 1 }, slices: {}, stability: null, injectionSensitivity: null } as never,
    integritySnapshot: { digest: pin(9), artifactCount: 1 },
  };
  return { executed, input };
}
