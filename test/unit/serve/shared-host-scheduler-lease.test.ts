/**
 * Unit tests for the admission lease lifecycle (ADR-004) in
 * SharedHostScheduler: heartbeat-anchored renewal, bounded requeue, and the
 * hardened policy validation. Uses an injected clock and probe — no fake
 * timers, no filesystem.
 *
 * @implements ADR-004
 */

import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryAdmissionStore,
  SharedHostScheduler,
  type AdmissionRequest,
  type SharedHostPolicy,
} from '../../../src/serve/shared-host-scheduler.js';

const T0 = 1_700_000_000_000;
const TTL_MS = 300_000;

function makeRequest(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    requestId: 'req-1',
    orchestratorId: 'orch-1',
    environment: 'default',
    provider: 'claude',
    runtimeKind: 'host',
    priority: 10,
    submittedAt: new Date(T0).toISOString(),
    queueTimeoutMs: 24 * 60 * 60_000,
    ...overrides,
  };
}

function makeScheduler(
  policy: Partial<SharedHostPolicy>,
  clock: () => number,
  probe?: (loopId: string) => number | null,
): SharedHostScheduler {
  return new SharedHostScheduler(
    new InMemoryAdmissionStore(),
    {
      maxConcurrent: 1,
      leaseTtlMs: TTL_MS,
      agingIntervalMs: 30_000,
      allowPreemption: false,
      ...policy,
    },
    clock,
    probe ? { heartbeatProbe: probe } : {},
  );
}

// ── Aging sweep: unexpired leases ────────────────────────────

describe('SharedHostScheduler lease lifecycle: unexpired records', () => {
  it('leaves unexpired admitted records alone', () => {
    let now = T0;
    const scheduler = makeScheduler({}, () => now);
    scheduler.submit(makeRequest());
    now += TTL_MS - 1_000; // 1s before expiry
    const snapshot = scheduler.reconcileNow();
    const record = snapshot.records['req-1']!;
    expect(record.state).toBe('admitted');
    expect(record.reason).toBe('admitted by shared-host policy');
    expect(record.requeueAttempts).toBeUndefined();
  });
});

// ── Heartbeat-anchored renewal ───────────────────────────────

describe('SharedHostScheduler lease lifecycle: heartbeat-anchored renewal', () => {
  it('renews an expired lease when the heartbeat is fresh within the grace window', () => {
    let now = T0;
    const probe = vi.fn(() => 30_000); // heartbeat 30s old ≤ 90s grace
    const scheduler = makeScheduler({ renewalGraceMs: 90_000 }, () => now, probe);
    scheduler.submit(makeRequest());
    now += TTL_MS + 1_000; // lease expired
    const snapshot = scheduler.reconcileNow();
    const record = snapshot.records['req-1']!;
    expect(record.state).toBe('admitted');
    expect(record.reason).toBe('lease renewed');
    expect(Date.parse(record.leaseExpiresAt!)).toBe(now + TTL_MS);
    expect(record.finishedAt).toBeUndefined();
    // The probe is consulted with the record's loop identity.
    expect(probe).toHaveBeenCalledWith('req-1');
  });

  it('still flips to timed-out when the heartbeat is stale or absent past TTL', () => {
    let now = T0;
    const scheduler = makeScheduler({ renewalGraceMs: 90_000, maxRequeueAttempts: 0 }, () => now, () => null);
    scheduler.submit(makeRequest());
    now += TTL_MS + 1_000;
    const snapshot = scheduler.reconcileNow();
    const record = snapshot.records['req-1']!;
    expect(record.state).toBe('timed-out');
    expect(record.reason).toBe('admission lease expired; capacity recovered');
  });

  it('still flips to timed-out when the heartbeat is older than the grace window', () => {
    let now = T0;
    const scheduler = makeScheduler({ renewalGraceMs: 90_000, maxRequeueAttempts: 0 }, () => now, () => 91_000);
    scheduler.submit(makeRequest());
    now += TTL_MS + 1_000;
    const snapshot = scheduler.reconcileNow();
    expect(snapshot.records['req-1']!.state).toBe('timed-out');
  });

  it('renews through the loop id attached via attachLoopId', () => {
    let now = T0;
    const probe = vi.fn(() => 1_000);
    const scheduler = makeScheduler({ renewalGraceMs: 90_000 }, () => now, probe);
    scheduler.submit(makeRequest());
    scheduler.attachLoopId('req-1', 'ralph-loop-7');
    now += TTL_MS + 1_000;
    const snapshot = scheduler.reconcileNow();
    expect(probe).toHaveBeenCalledWith('ralph-loop-7');
    expect(snapshot.records['req-1']!.reason).toBe('lease renewed');
  });
});

// ── Bounded requeue ──────────────────────────────────────────

describe('SharedHostScheduler lease lifecycle: bounded requeue', () => {
  it('requeues an expired record with attempts remaining, then re-admits when capacity exists', () => {
    let now = T0;
    const scheduler = makeScheduler({ maxRequeueAttempts: 2 }, () => now, () => null);
    scheduler.submit(makeRequest());
    now += TTL_MS + 1_000;
    // The expired record frees its own slot, so the same sweep requeues and
    // re-admits it with a fresh lease and the attempt recorded.
    const snapshot = scheduler.reconcileNow();
    const record = snapshot.records['req-1']!;
    expect(record.requeueAttempts).toBe(1);
    expect(record.state).toBe('admitted');
    expect(Date.parse(record.leaseExpiresAt!)).toBe(now + TTL_MS);
  });

  it('keeps a requeued record queued when capacity is taken by a stronger request', () => {
    let now = T0;
    const scheduler = makeScheduler(
      { maxConcurrent: 2, providerQuotas: { claude: 1 }, maxRequeueAttempts: 2 },
      () => now,
      () => null,
    );
    // req-a holds the claude quota slot; req-b waits with a much higher priority.
    scheduler.submit(makeRequest({ requestId: 'req-a', priority: 100 }));
    scheduler.submit(makeRequest({ requestId: 'req-b', priority: 1000 }));
    expect(snapshotState(scheduler, 'req-a')).toBe('admitted');
    expect(snapshotState(scheduler, 'req-b')).toBe('queued');

    now += TTL_MS + 1_000; // req-a's lease expires
    const snapshot = scheduler.reconcileNow();
    const requeued = snapshot.records['req-a']!;
    expect(requeued.state).toBe('queued');
    expect(requeued.reason).toBe('lease expired; requeued (attempt 1/2)');
    expect(requeued.requeueAttempts).toBe(1);
    expect(requeued.leaseExpiresAt).toBeUndefined();
    expect(requeued.finishedAt).toBeUndefined();
    // req-b wins the freed claude slot.
    expect(snapshot.records['req-b']!.state).toBe('admitted');
  });

  it('stops requeueing once maxRequeueAttempts is exhausted and goes terminal', () => {
    let now = T0;
    const scheduler = makeScheduler({ maxRequeueAttempts: 2 }, () => now, () => null);
    scheduler.submit(makeRequest());

    now += TTL_MS + 1_000; // expire #1 → requeue (1/2) → re-admit
    expect(scheduler.reconcileNow().records['req-1']!.requeueAttempts).toBe(1);
    now += TTL_MS + 1_000; // expire #2 → requeue (2/2) → re-admit
    expect(scheduler.reconcileNow().records['req-1']!.requeueAttempts).toBe(2);
    now += TTL_MS + 1_000; // expire #3 → attempts exhausted → terminal
    const record = scheduler.reconcileNow().records['req-1']!;
    expect(record.state).toBe('timed-out');
    expect(record.reason).toBe('admission lease expired; capacity recovered');
    expect(record.requeueAttempts).toBe(2);
    expect(record.finishedAt).toBeDefined();
  });

  it('rejects a conflicting submit() for a requeued record and accepts an identical replay', () => {
    let now = T0;
    const scheduler = makeScheduler(
      { maxConcurrent: 2, providerQuotas: { claude: 1 }, maxRequeueAttempts: 2 },
      () => now,
      () => null,
    );
    scheduler.submit(makeRequest({ requestId: 'req-a', priority: 100 }));
    scheduler.submit(makeRequest({ requestId: 'req-b', priority: 1000 }));
    now += TTL_MS + 1_000; // req-a expires → requeued, slot taken by req-b
    scheduler.reconcileNow();
    expect(snapshotState(scheduler, 'req-a')).toBe('queued');

    // Same id, different request → conflict.
    expect(() =>
      scheduler.submit(makeRequest({ requestId: 'req-a', provider: 'codex' })),
    ).toThrow(/conflicts with an existing admission/);
    // Same id, identical request → idempotent (the requeued record is returned).
    const replayed = scheduler.submit(makeRequest({ requestId: 'req-a', priority: 100 }));
    expect(replayed.reason).toBe('lease expired; requeued (attempt 1/2)');
  });

  it('renew() still throws on non-admitted state — the revival path stays closed', () => {
    let now = T0;
    const scheduler = makeScheduler({ maxRequeueAttempts: 0 }, () => now, () => null);
    scheduler.submit(makeRequest());
    now += TTL_MS + 1_000;
    scheduler.reconcileNow(); // terminal timed-out (no requeue attempts allowed)
    expect(() => scheduler.renew('req-1')).toThrow('cannot renew timed-out admission');
  });
});

// ── Hardened policy validation (ADR-004) ─────────────────────

describe('SharedHostScheduler lease lifecycle: policy validation', () => {
  it('keeps the positivity check for leaseTtlMs and agingIntervalMs', () => {
    expect(
      () => makeScheduler({ leaseTtlMs: 0 }, () => T0),
    ).toThrow('leaseTtlMs and agingIntervalMs must be positive');
  });

  it('rejects a leaseTtlMs below the measured startup p95, naming the measured value', () => {
    expect(() =>
      makeScheduler({ leaseTtlMs: 300_000, startupP95Ms: 600_000 }, () => T0),
    ).toThrow(/shorter than the measured startup p95 \(600000 ms\)/);
  });

  it('accepts a leaseTtlMs at or above the measured startup p95', () => {
    expect(() =>
      makeScheduler({ leaseTtlMs: 600_000, startupP95Ms: 600_000 }, () => T0),
    ).not.toThrow();
  });

  it('rejects non-positive renewalGraceMs and negative maxRequeueAttempts', () => {
    expect(() => makeScheduler({ renewalGraceMs: 0 }, () => T0)).toThrow('renewalGraceMs must be positive');
    expect(() => makeScheduler({ maxRequeueAttempts: -1 }, () => T0)).toThrow(
      'maxRequeueAttempts must be a non-negative integer',
    );
  });
});

function snapshotState(scheduler: SharedHostScheduler, requestId: string): string {
  return scheduler.snapshot().records[requestId]!.state;
}
