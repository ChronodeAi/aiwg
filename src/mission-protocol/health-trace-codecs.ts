import { stableJson } from './worker-contract-json.js';
// Pure Mission supervision trace and lease mapping codecs.
import { createHash } from 'node:crypto';
import { assertValidWorkerPayload, validateWorkerPayload } from './codecs.js';
import { WorkerContractError, HEALTH_ACTIVITY_SUMMARY_MAX_UTF8_BYTES, HEALTH_KNOWN_REASON_CODES,
  type WorkerHealthSummary, type HealthTraceKind, type WorkerArtifact, type HealthTraceProjection,
  type StopProof, type LeaseMappingInput, type LeaseMappingAction } from './types.js';

// S1 health-to-lease and Mission reconciliation mapping (B-OG-54 / #2916,
// 05 §8, ADR-OG-10/13). Pure functions over validated shapes: no scheduler,
// store, Mission runtime or managed import. S2 owners (B-OG-12/16) wire these
// verdicts into actual renew/fence/stop/settle/release runtime.

const HEALTH_TERMINAL_LIKE = new Set(['completed', 'failed', 'cancelled', 'crashed', 'failed-to-start']);

/**
 * Classify supervision evidence into a distinct shared-trace kind. Quiet,
 * stalled and uncertain map distinctly. Heartbeat/lease-only observation
 * yields activity-only, never productive work. A crashed or failed-to-start
 * worker without confirmed termination is terminal-unconfirmed: fail-stop is
 * claimed but a live descendant may survive, so it is never stop proof
 * (ADR-OG-10). Precondition: schema-valid workerHealthSummary.
 */
export function classifyHealthTrace(health: WorkerHealthSummary): HealthTraceKind {
  if (health.termination === 'confirmed' && HEALTH_TERMINAL_LIKE.has(health.state)) return 'terminal-proof';
  if (HEALTH_TERMINAL_LIKE.has(health.state)) return 'terminal-unconfirmed';
  // Confirmed termination with a non-terminal state is contradictory owner
  // evidence (finish() never produces it): downgrade, never productive.
  if (health.termination === 'confirmed') return 'uncertain';
  if (health.termination === 'uncertain') return 'uncertain';
  switch (health.state) {
    case 'launching':
    case 'started':
      return 'setup';
    case 'active':
      return health.lastProgressAt === null ? 'activity-only' : 'productive';
    case 'quiet':
      return 'quiet';
    case 'stalled':
    case 'hung':
      return 'stalled';
    default:
      return 'uncertain';
  }
}

const TRACE_TRUNCATION_MARKER = '…[truncated]';

/** Strip control/format characters and cap at maxUtf8Bytes (marker included). */
export function boundTraceText(text: string, maxUtf8Bytes: number): string {
  const clean = String(text).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, '');
  if (maxUtf8Bytes <= 0) return '';
  if (Buffer.byteLength(clean, 'utf8') <= maxUtf8Bytes) return clean;
  const markerBytes = Buffer.byteLength(TRACE_TRUNCATION_MARKER, 'utf8');
  if (maxUtf8Bytes < markerBytes) {
    // The budget cannot hold even the marker: return the longest
    // character-boundary prefix of the marker that fits, so the output
    // never exceeds the budget.
    let bytes = 0;
    let end = 0;
    for (const char of TRACE_TRUNCATION_MARKER) {
      const size = Buffer.byteLength(char, 'utf8');
      if (bytes + size > maxUtf8Bytes) break;
      bytes += size;
      end += char.length;
    }
    return TRACE_TRUNCATION_MARKER.slice(0, end);
  }
  let bytes = 0;
  let end = 0;
  for (const char of clean) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxUtf8Bytes - markerBytes) break;
    bytes += size;
    end += char.length;
  }
  return clean.slice(0, end) + TRACE_TRUNCATION_MARKER;
}

/**
 * Allowlisted reason label for the shared trace. Unlisted codes (including
 * any free text carrying secret material) project as UNCLASSIFIED#digest:
 * stable and bounded, never verbatim.
 */
export function healthReasonLabel(reasonCode: string): string {
  if ((HEALTH_KNOWN_REASON_CODES as readonly string[]).includes(reasonCode)) return reasonCode;
  const digest = createHash('sha256').update(reasonCode, 'utf8').digest('hex').slice(0, 12);
  return `UNCLASSIFIED#${digest}`;
}

/**
 * Digest-only lifecycle reference for the effect ledger. Only enum, counter,
 * digest and timestamp fields enter the digest; no payload content crosses.
 */
export function healthLifecycleDigest(health: WorkerHealthSummary): WorkerArtifact {
  assertValidWorkerPayload('workerHealthSummary', health);
  const lifecycle = {
    version: health.version,
    state: health.state,
    coverage: health.coverage,
    handshake: health.handshake,
    termination: health.termination,
    confidence: health.confidence,
    observerGeneration: health.observerGeneration,
    transitionCount: health.transitionCount,
    restartCount: health.restartCount,
    lastObservedAt: health.lastObservedAt,
    lastActivityAt: health.lastActivityAt,
    lastProgressAt: health.lastProgressAt,
  };
  const digest = `sha256:${createHash('sha256').update(stableJson(lifecycle), 'utf8').digest('hex')}`;
  return { ref: `artifact:${digest}`, digest };
}

/**
 * Closed observed-state vocabulary for the previous-state channel. Free
 * text (including leaked bearer material) never interpolates into the
 * shared trace.
 */
const HEALTH_OBSERVED_STATES: ReadonlySet<string> = new Set([
  'launching', 'started', 'active', 'quiet', 'stalled', 'hung',
  'crashed', 'failed-to-start', 'completed', 'failed', 'cancelled',
]);

/**
 * Parse an ISO timestamp into epoch milliseconds for chronological
 * comparison. Comparison must never fall back to string ordering: distinct
 * representations of the same instant (e.g. '.000Z' vs 'Z') must compare
 * equal, not greater/lesser. Unparseable values reject as having no
 * timestamp evidence (null), never throw.
 */
function parseProgressTimestampMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fresh-progress gate: credit requires genuinely new progress evidence.
 * The health shape carries no progress sequence/key, so freshness is a
 * NONDECREASING credit watermark: `previousWatermark` is not merely "the
 * last observation" but the highest-ever CREDITED lastProgressAt, compared
 * by parsed epoch milliseconds (never raw strings). Out-of-order or
 * replayed snapshots (older than, or equal to, the watermark) earn no
 * credit and never move the watermark backward; heartbeats (which advance
 * activity/observed timestamps while the watermark is frozen) never
 * re-credit historical progress. Unparseable timestamps earn no credit.
 * Callers thread the watermark forward with `advanceProgressWatermark`.
 */
function isFreshProgressEvidence(
  health: WorkerHealthSummary,
  previousWatermark: Pick<WorkerHealthSummary, 'lastProgressAt'> | null,
): boolean {
  const currentMs = parseProgressTimestampMs(health.lastProgressAt);
  if (currentMs === null) return false;
  if (previousWatermark === null || previousWatermark.lastProgressAt === null) return true;
  const watermarkMs = parseProgressTimestampMs(previousWatermark.lastProgressAt);
  if (watermarkMs === null) return false;
  return currentMs > watermarkMs;
}

/**
 * Pure watermark reducer (no store): callers thread the returned value into
 * the next observation's `previousHealth`/watermark argument instead of
 * re-passing the raw last observation. The watermark advances ONLY when the
 * current observation was actually credited; a non-credited observation
 * (replay, heartbeat, or an out-of-order/older snapshot) leaves the
 * watermark exactly where it was. This is what makes real A -> B -> A -> B
 * delivery sequences credit true,true,false,false instead of re-crediting
 * B the second time it arrives: a naive caller that re-threads "the last
 * observation" (rather than this reducer's output) regresses to that bug.
 */
export function advanceProgressWatermark(
  previousWatermark: Pick<WorkerHealthSummary, 'lastProgressAt'> | null,
  credited: boolean,
  health: WorkerHealthSummary,
): Pick<WorkerHealthSummary, 'lastProgressAt'> {
  if (credited) return { lastProgressAt: health.lastProgressAt };
  return previousWatermark ?? { lastProgressAt: null };
}

/**
 * Project one health observation into the shared trace. The activity summary
 * is built only from enum/counter/generation fields plus the allowlisted
 * reason label; completionCredit is always false because Mission/Flow
 * completion gates stay authoritative. previousState must be a closed
 * observed state (or null); anything else is rejected, never interpolated.
 * progressCredit requires fresh progress evidence relative to
 * previousHealth, which callers must maintain as the nondecreasing credit
 * watermark (see advanceProgressWatermark) rather than the raw last
 * observation (null for a first observation / no watermark yet).
 */
export function projectHealthTrace(
  health: WorkerHealthSummary,
  previousState: WorkerHealthSummary['state'] | null = null,
  previousHealth: Pick<WorkerHealthSummary, 'lastProgressAt'> | null = null,
): HealthTraceProjection {
  assertValidWorkerPayload('workerHealthSummary', health);
  if (previousState !== null && !HEALTH_OBSERVED_STATES.has(previousState)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Invalid previous health state.');
  }
  const kind = classifyHealthTrace(health);
  const summary = `health.${health.state}:${health.termination}`
    + ` gen=${health.observerGeneration ?? 'none'} transitions=${health.transitionCount}`
    + ` prev=${previousState ?? 'none'} reason=${healthReasonLabel(health.reasonCode)}`;
  return {
    kind,
    progressCredit: kind === 'productive' && isFreshProgressEvidence(health, previousHealth),
    completionCredit: false,
    activitySummary: boundTraceText(summary, HEALTH_ACTIVITY_SUMMARY_MAX_UTF8_BYTES),
    effectRef: healthLifecycleDigest(health),
  };
}

/**
 * Derive stop proof from owner-observed supervision evidence (ADR-OG-10).
 * Only a terminal state with owner-confirmed termination is stop proof;
 * terminal-unconfirmed and uncertain observations stay uncertain, and the
 * absence of evidence is none. There is no free-form proof parameter:
 * callers pass the health summary (or null) and the proof is derived.
 * A late final after cancel-disconnect therefore never releases while
 * termination is uncertain (ADR-OG-13: late results stay unaccepted
 * evidence).
 */
export function stopProofFromHealth(health: WorkerHealthSummary | null): StopProof {
  if (health === null) return 'none';
  assertValidWorkerPayload('workerHealthSummary', health);
  if (health.termination === 'confirmed') {
    return HEALTH_TERMINAL_LIKE.has(health.state) ? 'confirmed' : 'uncertain';
  }
  if (HEALTH_TERMINAL_LIKE.has(health.state) || health.termination === 'uncertain') return 'uncertain';
  return 'none';
}

/**
 * The generation the stop-proof evidence actually belongs to, bridging a
 * missing observerGeneration to 0 (the bootstrap generation) for fencing —
 * mirroring the same bridge decideLeaseMapping already applies to the
 * caller-supplied leaseGeneration/observedGeneration fields. This is bound
 * to the health summary's OWN observerGeneration field, which the caller
 * cannot set independently of the evidence: a caller cannot claim generation
 * 3 while attaching generation-2 evidence and have it treated as current.
 */
function stopProofGeneration(health: WorkerHealthSummary | null): number | null {
  if (health === null) return null;
  return health.observerGeneration ?? 0;
}

/**
 * Pure renewal/reconcile/release verdict over a mocked scheduler boundary.
 * Fencing binds every action to the current generation: a stale observation
 * denies renew, cancel, settle and accept alike. Expiry or cancel-disconnect
 * without derived confirmed stop proof retains the uncertain reservation
 * and releases nothing. Confirmed stop proof settles exactly once — and only
 * when that proof's OWN generation (not merely the caller-asserted
 * observedGeneration) matches the current leaseGeneration; a confirmed
 * proof carried over from a stale generation never releases.
 */
export function decideLeaseMapping(input: LeaseMappingInput): LeaseMappingAction {
  let record: Record<string, unknown>;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected object');
    record = input as unknown as Record<string, unknown>;
  } catch {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Invalid lease mapping input.');
  }
  const leaseStates = ['admitted', 'expired', 'cancelled-disconnected'];
  if (typeof record.leaseState !== 'string' || !leaseStates.includes(record.leaseState)
    || !Number.isSafeInteger(record.leaseGeneration) || (record.leaseGeneration as number) < 0
    || !Number.isSafeInteger(record.observedGeneration) || (record.observedGeneration as number) < 0
    || typeof record.settled !== 'boolean'
    || !('health' in record)
    || (record.health !== null && !validateWorkerPayload('workerHealthSummary', record.health).valid)) {
    throw new WorkerContractError('OG_CONTRACT_INVALID', 'Invalid lease mapping input.');
  }
  const mapping = input as LeaseMappingInput;
  if (mapping.observedGeneration !== mapping.leaseGeneration) return 'deny-stale';
  if (mapping.settled) return 'deny-already-settled';
  const stopProof = stopProofFromHealth(mapping.health);
  const proofIsCurrent = stopProofGeneration(mapping.health) === mapping.leaseGeneration;
  if (stopProof === 'confirmed' && proofIsCurrent) return 'release-once';
  if (stopProof === 'uncertain' || (stopProof === 'confirmed' && !proofIsCurrent) || mapping.leaseState !== 'admitted') {
    return 'retain-uncertain';
  }
  return 'renew';
}
