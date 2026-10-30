/**
 * Housekeeper status envelope (epic #3353 slice B5).
 *
 * `aiwg housekeeper status --json` emits this shape: the B1 §6 contract
 * fields (`contractVersion`/`command`/`status`/`mode`/`jobs`/`totals`) plus
 * per-index freshness measured by the B4 adapters. The CLI builds it from
 * live daemon IPC when a daemon answers, otherwise from local config and
 * persisted receipts (offline mode), so ordinary `aiwg` commands keep
 * working with no daemon running.
 */

export const HOUSEKEEPER_STATUS_CONTRACT_VERSION = 1;

export type HousekeeperMode = 'daemon' | 'offline';

export interface HousekeeperJobStatus {
  id: string;
  kind: string | null;
  lastState: 'ok' | 'failed' | 'skipped' | 'deferred' | 'never';
  lastRun: string | null;
  nextFire: string | null;
}

export interface HousekeeperFreshnessEntry {
  index: string;
  state: string;
  targetMs: number | null;
  converged: boolean | null;
}

export interface HousekeeperStatusTotals {
  jobs: number;
  ok: number;
  failed: number;
  skipped: number;
  deferred: number;
  never: number;
}

export interface HousekeeperInstallOutcome {
  state: string;
  reason: string | null;
  finishedAt: string | null;
  summary: string | null;
  oldVersion: string | null;
  newVersion: string | null;
}

export interface HousekeeperStatusEnvelope {
  contractVersion: number;
  command: 'housekeeper.status';
  status: 'ok';
  mode: HousekeeperMode;
  pid: number | null;
  uptimeSeconds: number;
  jobs: HousekeeperJobStatus[];
  totals: HousekeeperStatusTotals;
  freshness: HousekeeperFreshnessEntry[];
  update: {
    channel: string;
    checkOnly: true;
    lastCheck: string | null;
    available: boolean | null;
    lastInstall: HousekeeperInstallOutcome | null;
  };
}

const RECEIPT_STATES = new Set(['ok', 'failed', 'skipped', 'deferred']);

export function countJobTotals(jobs: HousekeeperJobStatus[]): HousekeeperStatusTotals {
  const totals: HousekeeperStatusTotals = {
    jobs: jobs.length, ok: 0, failed: 0, skipped: 0, deferred: 0, never: 0,
  };
  for (const job of jobs) {
    if (job.lastState === 'ok') totals.ok += 1;
    else if (job.lastState === 'failed') totals.failed += 1;
    else if (job.lastState === 'skipped') totals.skipped += 1;
    else if (job.lastState === 'deferred') totals.deferred += 1;
    else totals.never += 1;
  }
  return totals;
}

export function normalizeJobState(state: unknown): HousekeeperJobStatus['lastState'] {
  return typeof state === 'string' && RECEIPT_STATES.has(state)
    ? (state as HousekeeperJobStatus['lastState'])
    : 'never';
}

export interface BuildHousekeeperStatusInput {
  mode: HousekeeperMode;
  pid?: number | null;
  uptimeSeconds?: number;
  jobs?: HousekeeperJobStatus[];
  freshness?: HousekeeperFreshnessEntry[];
  lastCheck?: string | null;
  available?: boolean | null;
  lastInstall?: HousekeeperInstallOutcome | null;
}

/** Assemble the envelope; every field is always present. */
export function buildHousekeeperStatus(input: BuildHousekeeperStatusInput): HousekeeperStatusEnvelope {
  const jobs = input.jobs ?? [];
  return {
    contractVersion: HOUSEKEEPER_STATUS_CONTRACT_VERSION,
    command: 'housekeeper.status',
    status: 'ok',
    mode: input.mode,
    pid: input.pid ?? null,
    uptimeSeconds: input.uptimeSeconds ?? 0,
    jobs,
    totals: countJobTotals(jobs),
    freshness: input.freshness ?? [],
    update: {
      channel: 'stable',
      checkOnly: true,
      lastCheck: input.lastCheck ?? null,
      available: input.available ?? null,
      lastInstall: input.lastInstall ?? null,
    },
  };
}

/**
 * Map a B4 freshness snapshot to the status entry. `unavailable` (no local
 * deterministic probe) surfaces as `unsupported` per the B1 §6 state set.
 */
export function toFreshnessEntry(snapshot: {
  name: string;
  status: string;
  policy?: { targetStaleAfterMs?: number };
  convergence?: { converged?: boolean };
}): HousekeeperFreshnessEntry {
  return {
    index: snapshot.name,
    state: snapshot.status === 'unavailable' ? 'unsupported' : snapshot.status,
    targetMs: snapshot.policy?.targetStaleAfterMs ?? null,
    converged: snapshot.convergence?.converged ?? null,
  };
}
