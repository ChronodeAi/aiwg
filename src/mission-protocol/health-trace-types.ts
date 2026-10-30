// Mission supervision trace and lease mapping contracts.
import type { WorkerArtifact, WorkerHealthSummary } from './types.js';

/**
 * S1 health-to-lease/trace mapping (B-OG-54 / #2916). Pure shared data
 * contracts; S2 owners (B-OG-12/16) wire them into runtime. These kinds
 * describe supervision evidence only: no parallel mission lifecycle is
 * created, and no direct worker depends on a lease.
 */
export type HealthTraceKind =
  | 'setup'
  | 'productive'
  | 'activity-only'
  | 'quiet'
  | 'stalled'
  | 'uncertain'
  | 'terminal-proof'
  | 'terminal-unconfirmed';

/** Bounded activity-log transition summary budget (UTF-8 bytes, marker included). */
export const HEALTH_ACTIVITY_SUMMARY_MAX_UTF8_BYTES = 1024;

/**
 * Closed observer reason-code allowlist for activity summaries. Mirrors the
 * `reasons` set in tools/ralph-external/lib/worker-health.mjs: B-OG-50 owns
 * the observer set, B-OG-54 owns this mapping allowlist; extend them together.
 * Unlisted codes project as UNCLASSIFIED#digest so free text (and any secret
 * material it carries) never crosses into the shared trace.
 */
export const HEALTH_KNOWN_REASON_CODES = [
  'OK',
  'AWAITING_HANDSHAKE',
  'PROCESS_ONLY',
  'ACCEPTED',
  'PROGRESS',
  'QUIET',
  'NO_PROGRESS',
  'STARTUP_DEADLINE',
  'HARD_DEADLINE',
  'STEP_LIMIT',
  'AUTH',
  'RATE_LIMIT',
  'NETWORK',
  'MODEL',
  'TRUST',
  'STDIN_WAIT',
  'SANDBOX',
  'NOT_FOUND',
  'RESOURCE',
  'PROVIDER_ERROR',
  'CRASH',
  'EXIT_ERROR',
  'FINAL_INVALID',
  'CANCELLED',
  'DISCONNECTED',
  'OBSERVER_GAP',
  'CAPTURE_WRITE',
  'OUTPUT_LIMIT',
  'MALFORMED_FRAME',
  'SOURCE_GAP',
  'IDENTITY_CHANGED',
] as const;

export type HealthReasonCode = (typeof HEALTH_KNOWN_REASON_CODES)[number];

export interface HealthTraceProjection {
  kind: HealthTraceKind;
  /** True only for genuine semantic progress; heartbeat/lease observation never sets this. */
  progressCredit: boolean;
  /** Always false: Mission/Flow completion gates stay authoritative. */
  completionCredit: false;
  /** Bounded, control-stripped transition summary for the activity log. */
  activitySummary: string;
  /** Digest-only lifecycle reference for the effect ledger; no payload content. */
  effectRef: WorkerArtifact;
}

/**
 * Pure renewal/reconcile/release verdicts over a mocked scheduler boundary.
 * Renewal carries no progress field, so it cannot assert progress by
 * construction. ADR-OG-10: expiry or silence never frees writer capacity.
 */
export type LeaseMappingAction =
  | 'renew'
  | 'retain-uncertain'
  | 'release-once'
  | 'deny-stale'
  | 'deny-already-settled';

export type LeaseStateForMapping = 'admitted' | 'expired' | 'cancelled-disconnected';

export type StopProof = 'none' | 'uncertain' | 'confirmed';

export interface LeaseMappingInput {
  leaseState: LeaseStateForMapping;
  leaseGeneration: number;
  observedGeneration: number;
  /**
   * Owner-observed supervision evidence. Stop proof is derived from this
   * summary by stopProofFromHealth, never asserted by the caller: null
   * means no evidence observed yet. ADR-OG-10/13.
   */
  health: WorkerHealthSummary | null;
  settled: boolean;
}

