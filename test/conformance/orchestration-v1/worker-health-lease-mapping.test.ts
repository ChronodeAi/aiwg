/**
 * T-OG-24 S1: managed health mapping as pure contracts with a mocked
 * scheduler transaction boundary. Synthetic fixtures only; this file imports
 * the Mission codec and shared contract fixtures plus node builtins — no
 * managed (MC/scheduler/store) imports and no managed side effects.
 *
 * S2 handoff: B-OG-12 (renew/fence/stop/settle/release) and B-OG-16
 * (Mission/Flow/Ralph caller events) must run these same vectors as
 * mandatory runtime gates against the actual scheduler/MC/Flow/Ralph
 * crash/restart cases. Managed-only activation, leases, required evidence
 * and runtime integration do not block this S1 checkpoint.
 *
 * Mandatory S2 gate list (mirrored below in the mocked scheduler
 * boundary vectors): renew-never-updates-progress, expiry-never-releases,
 * cancel-disconnect-without-proof-retains-uncertainty,
 * stale-generation-denies-all-four-operations,
 * stale-confirmed-final-never-poisons-stop-proof,
 * late-final-after-cancel-disconnect-never-releases-while-uncertain,
 * confirmed-proof-settles-exactly-once, uncertain-proof-never-settles,
 * confirmed-proof-generation-must-match-current-generation-not-just-the-
 * callers-asserted-observedGeneration.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HEALTH_ACTIVITY_SUMMARY_MAX_UTF8_BYTES,
  WORKER_BASELINE_FEATURES,
  WorkerContractError,
  assembleWorkerResult,
  decodeWorkerPayload,
  decideLeaseMapping,
  encodeWorkerPayload,
  negotiateWorkerSupport,
  projectHealthTrace,
  validateWorkerPayload,
  workerContractSchemaId,
  workerDefinitionBundleDigest,
  type WorkerConsumerSupport,
  type WorkerHealthSummary,
} from '../../../src/mission-protocol/index.js';
import { fixtureJson, materialize } from '../mission-v1/worker-contract-fixtures.js';

const vectors = fixtureJson('mission-vectors.json');
const vector = (id: string) => materialize(vectors.find((v: any) => v.id === id), vectors);

const baseHealth: WorkerHealthSummary = {
  version: 1,
  state: 'active',
  coverage: 'full',
  handshake: 'semantic',
  lastObservedAt: '2026-10-08T00:00:01Z',
  lastActivityAt: '2026-10-08T00:00:01Z',
  lastProgressAt: '2026-10-08T00:00:01Z',
  reasonCode: 'PROGRESS',
  termination: 'running',
  transitionCount: 3,
  restartCount: 0,
  unavailableSignals: [],
  transitionRefs: [],
  observerGeneration: 7,
  startupDeadlineAt: null,
  hardDeadlineAt: null,
  maxCheckGapSeconds: 15,
  confidence: 'observed',
  handshakeAt: '2026-10-08T00:00:00Z',
  stalledAt: null,
};

const artifactBytes = Buffer.from('Exact synthetic artifact\n');
const artifactDigest = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;

type MockLeaseState = 'admitted' | 'expired' | 'cancelled-disconnected' | 'uncertain' | 'released';

interface MockLease {
  reservationId: string;
  generation: number;
  state: MockLeaseState;
  leaseExpiresAt: string;
  lastProgressAt: string | null;
  health: WorkerHealthSummary | null;
  settled: boolean;
  releases: number;
}

const confirmedTerminal = (observerGeneration: number | null): WorkerHealthSummary => ({
  ...baseHealth, state: 'completed', termination: 'confirmed', reasonCode: 'OK', observerGeneration,
});

const uncertainTermination = (observerGeneration: number | null): WorkerHealthSummary => ({
  ...baseHealth,
  state: 'active',
  termination: 'uncertain',
  lastProgressAt: null,
  reasonCode: 'DISCONNECTED',
  observerGeneration,
});

const terminalUnconfirmed = (observerGeneration: number | null): WorkerHealthSummary => ({
  ...baseHealth, state: 'completed', termination: 'uncertain', reasonCode: 'OK', observerGeneration,
});

/**
 * Pure mocked scheduler transaction boundary (S1 stand-in for
 * SharedHostScheduler). Every operation routes through decideLeaseMapping
 * with owner-observed health evidence; stop proof is derived, never
 * asserted. Generation fencing happens BEFORE any evidence is stored, so
 * stale evidence never contributes. The mock records calls and
 * writer-capacity releases without any scheduler, store, Mission or MC
 * runtime.
 */
class MockSchedulerBoundary {
  readonly calls: string[] = [];
  readonly unacceptedEvidence: Array<{ reservationId: string; generation: number; final: unknown }> = [];
  private readonly leases = new Map<string, MockLease>();

  admit(reservationId: string, generation: number, lastProgressAt: string | null): void {
    this.leases.set(reservationId, {
      reservationId, generation, state: 'admitted', leaseExpiresAt: '2026-10-08T01:00:00Z',
      lastProgressAt, health: null, settled: false, releases: 0,
    });
  }

  inspect(reservationId: string): MockLease {
    const lease = this.leases.get(reservationId);
    if (!lease) throw new WorkerContractError('OG_CONTRACT_INVALID', `Unknown reservation '${reservationId}'.`);
    return lease;
  }

  private decide(lease: MockLease, observedGeneration: number) {
    const leaseState = lease.state === 'released' || lease.state === 'uncertain' ? 'expired' : lease.state;
    return decideLeaseMapping({
      leaseState: leaseState as 'admitted' | 'expired' | 'cancelled-disconnected',
      leaseGeneration: lease.generation, observedGeneration, health: lease.health, settled: lease.settled,
    });
  }

  private deny(action: string): never {
    throw new WorkerContractError('OG_CONTRACT_UNSUPPORTED', `${action} denied by lease mapping.`);
  }

  renew(reservationId: string, observedGeneration: number): void {
    const lease = this.inspect(reservationId);
    this.calls.push(`renew:${reservationId}@${observedGeneration}`);
    if (this.decide(lease, observedGeneration) !== 'renew') this.deny('renew');
    lease.leaseExpiresAt = '2026-10-08T02:00:00Z';
  }

  expire(reservationId: string): void {
    const lease = this.inspect(reservationId);
    this.calls.push(`expire:${reservationId}`);
    lease.state = 'expired';
    if (this.decide(lease, lease.generation) !== 'retain-uncertain') this.deny('expire');
    lease.state = 'uncertain';
  }

  cancelDisconnect(reservationId: string, observedGeneration: number): void {
    const lease = this.inspect(reservationId);
    this.calls.push(`cancel:${reservationId}@${observedGeneration}`);
    const verdict = this.decide(lease, observedGeneration);
    if (verdict === 'deny-stale' || verdict === 'deny-already-settled') this.deny('cancel');
    if (verdict !== 'release-once') {
      lease.state = 'uncertain';
      return;
    }
    this.settleLease(lease);
  }

  observeHealth(reservationId: string, health: WorkerHealthSummary): void {
    const lease = this.inspect(reservationId);
    const observedGeneration = health.observerGeneration ?? 0;
    this.calls.push(`observe:${reservationId}@${observedGeneration}`);
    if (observedGeneration !== lease.generation) this.deny('observe');
    lease.health = health;
  }

  settle(reservationId: string, observedGeneration: number): void {
    const lease = this.inspect(reservationId);
    this.calls.push(`settle:${reservationId}@${observedGeneration}`);
    if (this.decide(lease, observedGeneration) !== 'release-once') this.deny('settle');
    this.settleLease(lease);
  }

  acceptFinal(reservationId: string, final: unknown, health: WorkerHealthSummary): void {
    const lease = this.inspect(reservationId);
    const observedGeneration = health.observerGeneration ?? 0;
    this.calls.push(`accept:${reservationId}@${observedGeneration}`);
    if (observedGeneration !== lease.generation) {
      this.unacceptedEvidence.push({ reservationId, generation: observedGeneration, final });
      this.deny('accept');
    }
    lease.health = health;
    if (this.decide(lease, observedGeneration) !== 'release-once') {
      this.unacceptedEvidence.push({ reservationId, generation: observedGeneration, final });
      this.deny('accept');
    }
    this.settleLease(lease);
  }

  private settleLease(lease: MockLease): void {
    lease.settled = true;
    lease.releases += 1;
    lease.state = 'released';
  }
}

describe('T-OG-24 direct health result and codec compatibility', () => {
  it('validates a direct health result with parent and lease absent', () => {
    const brief = vector('direct-brief-no-lease');
    expect(brief).not.toHaveProperty('lease');
    expect(brief.intent).not.toHaveProperty('parent');
    const result = vector('direct-accepted-no-receipt');
    result.execution.health = { ...baseHealth };
    expect(validateWorkerPayload('workerHealthSummary', result.execution.health).valid).toBe(true);
    const assembled = assembleWorkerResult({
      brief,
      execution: result.execution,
      worker: result.worker,
      verification: { ...result.verification, artifactDigest },
      artifactBytes,
    });
    const decoded = JSON.parse(assembled.bytes);
    expect(validateWorkerPayload('workerDirectResult', decoded).valid).toBe(true);
    expect(decoded.execution.health).toEqual({ ...baseHealth });
    expect(decoded).not.toHaveProperty('lease');
  });

  it('decodes five-feature records and six-feature health attempts', () => {
    const five = vector('dispatch-roundtrip');
    expect(five.requiredFeatures).toHaveLength(5);
    expect(decodeWorkerPayload('workerDispatch', five)).toEqual(five);
    const six = vector('dispatch-health-feature');
    expect(six.requiredFeatures).toContain('worker-health.v1');
    expect(decodeWorkerPayload('workerDispatch', six)).toEqual(six);
  });

  it('rejects the new required feature for incapable consumers without field loss', () => {
    const digest = workerDefinitionBundleDigest();
    const six = vector('dispatch-health-feature');
    const before = structuredClone(six);
    const incapable: WorkerConsumerSupport = {
      revision: 1, bundleDigest: digest, features: [...WORKER_BASELINE_FEATURES], lossless: true,
    };
    expect(negotiateWorkerSupport(incapable, {
      requiredFeatures: six.requiredFeatures, bundleDigest: digest,
    })).toBe('OG_CONTRACT_UNSUPPORTED');
    expect(() => encodeWorkerPayload('workerDispatch', six, {
      consumer: incapable, requiredFeatures: six.requiredFeatures, bundleDigest: digest,
    })).toThrowError(WorkerContractError);
    expect(six).toEqual(before);
    expect(decodeWorkerPayload('workerDispatch', six)).toEqual(before);
  });

  it('ships under the unchanged schema identity with no new store', () => {
    expect(workerContractSchemaId()).toBe('https://aiwg.io/schemas/mission.aiwg.io/v1');
  });
});

describe('T-OG-24 shared trace vectors', () => {
  it('maps quiet, stalled and uncertain distinctly with no productive credit', () => {
    const traces = {
      quiet: projectHealthTrace({ ...baseHealth, state: 'quiet', reasonCode: 'QUIET' }, 'active'),
      stalled: projectHealthTrace({ ...baseHealth, state: 'stalled', reasonCode: 'NO_PROGRESS' }, 'quiet'),
      uncertain: projectHealthTrace({ ...baseHealth, state: 'active', termination: 'uncertain', lastProgressAt: null, reasonCode: 'DISCONNECTED' }, 'active'),
    };
    expect(new Set([traces.quiet.kind, traces.stalled.kind, traces.uncertain.kind]))
      .toEqual(new Set(['quiet', 'stalled', 'uncertain']));
    for (const trace of Object.values(traces)) {
      expect(trace.progressCredit).toBe(false);
      expect(trace.completionCredit).toBe(false);
      expect(Buffer.byteLength(trace.activitySummary, 'utf8'))
        .toBeLessThanOrEqual(HEALTH_ACTIVITY_SUMMARY_MAX_UTF8_BYTES);
    }
    expect(traces.quiet.activitySummary).toContain('prev=active');
  });

  it('never treats heartbeat or lease observation as productive work or completion', () => {
    const heartbeatOnly = projectHealthTrace({ ...baseHealth, lastProgressAt: null, reasonCode: 'OK' });
    expect(heartbeatOnly.kind).toBe('activity-only');
    expect(heartbeatOnly.progressCredit).toBe(false);
    expect(heartbeatOnly.completionCredit).toBe(false);
    const terminalProof = projectHealthTrace({ ...baseHealth, state: 'completed', termination: 'confirmed', reasonCode: 'OK' });
    expect(terminalProof.kind).toBe('terminal-proof');
    expect(terminalProof.completionCredit).toBe(false);
  });

  it('bounds hostile summaries and redacts free text from the shared trace', () => {
    const hostile: WorkerHealthSummary = {
      ...baseHealth,
      state: 'quiet',
      reasonCode: `${'x'.repeat(4000)} bearer sk-fake-SECRET \x00\x1f`,
      transitionRefs: Array.from({ length: 64 }, (_, index) => ({
        ref: `artifact:transition-${index}`,
        digest: `sha256:${'b'.repeat(64)}`,
      })),
    };
    expect(validateWorkerPayload('workerHealthSummary', hostile).valid).toBe(true);
    const trace = projectHealthTrace(hostile, 'active');
    expect(Buffer.byteLength(trace.activitySummary, 'utf8'))
      .toBeLessThanOrEqual(HEALTH_ACTIVITY_SUMMARY_MAX_UTF8_BYTES);
    expect(trace.activitySummary).not.toContain('sk-fake-SECRET');
    expect(trace.activitySummary).toMatch(/reason=UNCLASSIFIED#[0-9a-f]{12}/);
    expect(JSON.stringify(trace.effectRef)).not.toContain('sk-fake-SECRET');
    expect(Object.keys(trace.effectRef).sort()).toEqual(['digest', 'ref']);
  });
});

describe('T-OG-24 mocked scheduler boundary vectors (S2 runtime gates)', () => {
  it('renewing a lease never updates progress', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, '2026-10-08T00:00:01Z');
    boundary.renew('r1', 3);
    boundary.renew('r1', 3);
    const lease = boundary.inspect('r1');
    expect(lease.leaseExpiresAt).toBe('2026-10-08T02:00:00Z');
    expect(lease.lastProgressAt).toBe('2026-10-08T00:00:01Z');
    expect(lease.releases).toBe(0);
  });

  it('expiry cannot release writer capacity', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, null);
    boundary.expire('r1');
    const lease = boundary.inspect('r1');
    expect(lease.state).toBe('uncertain');
    expect(lease.releases).toBe(0);
    expect(() => boundary.renew('r1', 3)).toThrowError(WorkerContractError);
    expect(() => boundary.settle('r1', 3)).toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').releases).toBe(0);
  });

  it('cancel-disconnect without stop proof retains uncertainty without release', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, null);
    boundary.cancelDisconnect('r1', 3);
    expect(boundary.inspect('r1').state).toBe('uncertain');
    expect(boundary.inspect('r1').releases).toBe(0);
  });

  it('stale generation cannot renew, cancel, settle or accept', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, null);
    boundary.observeHealth('r1', confirmedTerminal(3));
    expect(() => boundary.renew('r1', 2)).toThrowError(WorkerContractError);
    expect(() => boundary.cancelDisconnect('r1', 4)).toThrowError(WorkerContractError);
    expect(() => boundary.settle('r1', 2)).toThrowError(WorkerContractError);
    expect(() => boundary.acceptFinal('r1', { late: true }, confirmedTerminal(4))).toThrowError(WorkerContractError);
    const lease = boundary.inspect('r1');
    expect(lease.state).toBe('admitted');
    expect(lease.releases).toBe(0);
    expect(boundary.unacceptedEvidence).toEqual([{ reservationId: 'r1', generation: 4, final: { late: true } }]);
  });

  it('a stale confirmed final never poisons stop proof', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, null);
    expect(() => boundary.acceptFinal('r1', { stale: true }, confirmedTerminal(2)))
      .toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').health).toBeNull();
    expect(() => boundary.settle('r1', 3)).toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').releases).toBe(0);
    boundary.observeHealth('r1', confirmedTerminal(3));
    boundary.settle('r1', 3);
    expect(boundary.inspect('r1').releases).toBe(1);
    expect(boundary.unacceptedEvidence).toEqual([{ reservationId: 'r1', generation: 2, final: { stale: true } }]);
  });

  it('a late final after cancel-disconnect never releases while termination is uncertain', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, null);
    boundary.cancelDisconnect('r1', 3);
    expect(boundary.inspect('r1').state).toBe('uncertain');
    expect(() => boundary.acceptFinal('r1', { late: true }, terminalUnconfirmed(3)))
      .toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').releases).toBe(0);
    expect(boundary.inspect('r1').state).toBe('uncertain');
    expect(() => boundary.settle('r1', 3)).toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').releases).toBe(0);
  });

  it('bridges a missing observer generation to zero for fencing', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r0', 0, null);
    boundary.acceptFinal('r0', { final: true }, confirmedTerminal(null));
    expect(boundary.inspect('r0').releases).toBe(1);
    boundary.admit('r1', 3, null);
    expect(() => boundary.acceptFinal('r1', { late: true }, confirmedTerminal(null)))
      .toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').health).toBeNull();
    expect(boundary.unacceptedEvidence).toEqual([{ reservationId: 'r1', generation: 0, final: { late: true } }]);
  });

  it('stop proof enables exactly one settlement and release', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, null);
    expect(() => boundary.settle('r1', 3)).toThrowError(WorkerContractError);
    boundary.observeHealth('r1', confirmedTerminal(3));
    boundary.settle('r1', 3);
    expect(boundary.inspect('r1').releases).toBe(1);
    expect(boundary.inspect('r1').state).toBe('released');
    expect(() => boundary.settle('r1', 3)).toThrowError(WorkerContractError);
    expect(() => boundary.acceptFinal('r1', { replay: true }, confirmedTerminal(3))).toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').releases).toBe(1);
  });

  it('uncertain stop proof never settles', () => {
    const boundary = new MockSchedulerBoundary();
    boundary.admit('r1', 3, null);
    boundary.observeHealth('r1', uncertainTermination(3));
    expect(() => boundary.settle('r1', 3)).toThrowError(WorkerContractError);
    expect(() => boundary.acceptFinal('r1', { tentative: true }, uncertainTermination(3))).toThrowError(WorkerContractError);
    expect(boundary.inspect('r1').releases).toBe(0);
    expect(boundary.unacceptedEvidence).toHaveLength(1);
  });

  it('a confirmed proof carried over from a stale generation never releases, even when leaseGeneration===observedGeneration', () => {
    // The observe/accept/settle mock helpers derive observedGeneration from
    // the health itself, so they cannot smuggle a mismatched generation past
    // their own guard. decideLeaseMapping is the real boundary a caller can
    // reach directly (e.g. a scheduler that trusts a separately-asserted
    // generation number instead of the attached evidence's own generation),
    // so this exercises it without the mock's extra guard.
    const staleProofCurrentClaim = decideLeaseMapping({
      leaseState: 'admitted', leaseGeneration: 3, observedGeneration: 3,
      health: confirmedTerminal(2), settled: false,
    });
    expect(staleProofCurrentClaim).toBe('retain-uncertain');
    const currentProofCurrentClaim = decideLeaseMapping({
      leaseState: 'admitted', leaseGeneration: 3, observedGeneration: 3,
      health: confirmedTerminal(3), settled: false,
    });
    expect(currentProofCurrentClaim).toBe('release-once');
  });
});
