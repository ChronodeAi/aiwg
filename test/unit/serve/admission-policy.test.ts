/**
 * Unit tests for the shared admission-lease policy loader (ADR-004).
 * One policy, three former hardcoded call sites (mc.ts 650/790/986), zero
 * duplicated lease literals.
 *
 * @implements ADR-004
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ADMISSION_LEASE,
  loadAdmissionLeasePolicy,
} from '../../../src/serve/shared-host-scheduler.js';

describe('loadAdmissionLeasePolicy', () => {
  it('falls back to minTtlMs defaults when no config and no startup measurements exist', () => {
    expect(loadAdmissionLeasePolicy(null)).toEqual({
      leaseTtlMs: 300_000,
      agingIntervalMs: 30_000,
      renewalGraceMs: 90_000,
      maxRequeueAttempts: 2,
      startupP95Ms: null,
    });
    expect(DEFAULT_ADMISSION_LEASE.leaseTtlMs).toBe(300_000);
  });

  it('derives leaseTtlMs = max(minTtlMs, ttlMultiplier × startupP95Ms)', () => {
    // 3 × 150s > 300s floor → measurement wins.
    expect(loadAdmissionLeasePolicy(null, 150_000).leaseTtlMs).toBe(450_000);
    // 3 × 50s < 300s floor → floor wins.
    expect(loadAdmissionLeasePolicy(null, 50_000).leaseTtlMs).toBe(300_000);
    // Non-positive measurements are ignored.
    expect(loadAdmissionLeasePolicy(null, 0).leaseTtlMs).toBe(300_000);
    expect(loadAdmissionLeasePolicy(null, -5).leaseTtlMs).toBe(300_000);
  });

  it('loads the lease lifecycle from serve.admissionLease config', () => {
    const policy = loadAdmissionLeasePolicy({
      serve: {
        admissionLease: {
          minTtlMs: 600_000,
          ttlMultiplier: 2,
          renewalGraceMs: 120_000,
          maxRequeueAttempts: 3,
        },
      },
    });
    expect(policy.leaseTtlMs).toBe(600_000);
    expect(policy.renewalGraceMs).toBe(120_000);
    expect(policy.maxRequeueAttempts).toBe(3);
    // Config floor beats a small measurement even with a custom multiplier.
    expect(loadAdmissionLeasePolicy(
      { serve: { admissionLease: { minTtlMs: 600_000, ttlMultiplier: 2 } } },
      100_000,
    ).leaseTtlMs).toBe(600_000);
    expect(loadAdmissionLeasePolicy(
      { serve: { admissionLease: { ttlMultiplier: 2 } } },
      200_000,
    ).leaseTtlMs).toBe(400_000);
  });

  it('ignores invalid config values and falls back to defaults', () => {
    expect(
      loadAdmissionLeasePolicy({ serve: { admissionLease: { minTtlMs: -5, maxRequeueAttempts: 1.5 } } }),
    ).toMatchObject({ leaseTtlMs: 300_000, maxRequeueAttempts: 2 });
  });
});
