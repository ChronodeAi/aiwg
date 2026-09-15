/**
 * Builds and re-verifies a session export selection plan (#2564). A plan
 * binds a reviewable, human-inspectable selection to the exact session ids
 * and source/event digests seen at plan time, so `sessions export build`
 * can detect a stale plan (source changed since planning) rather than
 * silently exporting drifted data.
 */
import { createHash } from 'node:crypto';
import type { Session, SessionEvent } from './contracts.js';
import { SessionContractError } from './contracts.js';
import {
  buildSessionAiwgFortemiIndexExport,
  SESSION_EXPORT_INDEX_SCHEMA_VERSION,
} from './fortemi-export-mapping.js';
import { discoverSessionOutputCandidates, type SessionOutputCandidate } from './output-lineage.js';
import { FilesystemDerivedOutputIndex } from './output-registration.js';
import type { SessionRepository } from './repository.js';

export const SESSION_EXPORT_PLAN_SCHEMA_VERSION = '1.0.0' as const;

export interface SessionExportPlanEntry {
  sessionId: string;
  nativeSessionId: string;
  provider: string;
  sourceId: string;
  sourceDigest: string;
  eventCount: number;
  eventDigestSummary: string;
}

/** #2566: a registered analysis output selected alongside its session. */
export interface SessionExportPlanOutputEntry {
  sessionId: string;
  registrationId: string;
  outputLocator: string;
  outputDigest: string;
  mediaType: string;
  lineage: 'registered';
  matchReason: string;
}

export interface SessionExportPlanPreview {
  recordCount: number;
  sampleRecordIds: string[];
}

export interface SessionExportPlan {
  schemaVersion: typeof SESSION_EXPORT_PLAN_SCHEMA_VERSION;
  indexSchemaVersion: typeof SESSION_EXPORT_INDEX_SCHEMA_VERSION;
  generatedAt: string;
  workspaceId: string;
  sessions: SessionExportPlanEntry[];
  /** Registered outputs discovered for the selected sessions (#2566). Absent projectRoot -> empty, never a partial/best-effort scan. */
  outputs: SessionExportPlanOutputEntry[];
  totals: { sessionCount: number; eventCount: number; outputCount: number; recordCount: number };
  preview: SessionExportPlanPreview;
}

function eventDigestSummary(events: SessionEvent[]): string {
  const hash = createHash('sha256');
  for (const event of events) hash.update(event.digest);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Selects the requested sessions from the repository and builds a plan.
 * Rejects an empty or duplicate selection, and any session id the
 * repository cannot authorize for the given workspace -- an unauthorized
 * or unknown id is a planning error, not something to silently skip.
 */
export function buildSessionExportPlan(
  repository: SessionRepository,
  options: {
    workspaceId: string;
    sessionIds: readonly string[];
    previewSampleSize?: number;
    /** Project root to scan for registered output lineage (#2566). Omit to skip output discovery entirely. */
    projectRoot?: string;
  },
): { plan: SessionExportPlan; sessions: Session[]; eventsBySessionId: Map<string, SessionEvent[]> } {
  const requested = [...new Set(options.sessionIds)];
  if (requested.length === 0) {
    throw new SessionContractError('INVALID_ARGUMENT', 'session export plan requires at least one session id');
  }
  if (requested.length !== options.sessionIds.length) {
    throw new SessionContractError('INVALID_ARGUMENT', 'session export plan selection contains duplicate session ids');
  }
  const sessions: Session[] = [];
  const eventsBySessionId = new Map<string, SessionEvent[]>();
  const entries: SessionExportPlanEntry[] = [];
  for (const sessionId of requested) {
    const session = repository.getSession(sessionId, options.workspaceId);
    if (!session) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        `session is unknown or not authorized for this workspace: ${sessionId}`,
      );
    }
    const events = repository.listEvents(sessionId, options.workspaceId);
    sessions.push(session);
    eventsBySessionId.set(sessionId, events);
    entries.push({
      sessionId: session.sessionId,
      nativeSessionId: session.nativeSessionId,
      provider: session.provider,
      sourceId: session.sourceId,
      sourceDigest: session.sourceDigest,
      eventCount: events.length,
      eventDigestSummary: eventDigestSummary(events),
    });
  }
  const sampleSize = options.previewSampleSize ?? 5;
  const outputCandidates: SessionOutputCandidate[] = options.projectRoot
    ? discoverSessionOutputCandidates(
        new FilesystemDerivedOutputIndex(options.projectRoot).registrations(),
        sessions,
      )
    : [];
  const outputs: SessionExportPlanOutputEntry[] = outputCandidates.map((candidate) => ({
    sessionId: candidate.sessionId,
    registrationId: candidate.registration.registrationId,
    outputLocator: candidate.registration.output.locator,
    outputDigest: candidate.registration.output.digest,
    mediaType: candidate.registration.output.mediaType,
    lineage: candidate.lineage,
    matchReason: candidate.matchReason,
  }));
  const index = buildSessionAiwgFortemiIndexExport(options.workspaceId, sessions, eventsBySessionId, outputs);
  const plan: SessionExportPlan = {
    schemaVersion: SESSION_EXPORT_PLAN_SCHEMA_VERSION,
    indexSchemaVersion: SESSION_EXPORT_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceId: options.workspaceId,
    sessions: entries,
    outputs,
    totals: {
      sessionCount: sessions.length,
      eventCount: entries.reduce((sum, entry) => sum + entry.eventCount, 0),
      outputCount: outputs.length,
      recordCount: index.items.length,
    },
    preview: {
      recordCount: index.items.length,
      sampleRecordIds: index.items.slice(0, sampleSize).map((item) => item.id),
    },
  };
  return { plan, sessions, eventsBySessionId };
}

/**
 * Re-selects the plan's sessions from the repository and compares digests
 * against what the plan recorded. Any drift -- a changed source, a
 * changed/reimported event set, or a session/id that has since disappeared
 * -- fails closed rather than exporting silently-stale data (#2564
 * acceptance criteria: "Plans reject stale sources ... changed analysis
 * bytes").
 */
export function reverifySessionExportPlan(
  repository: SessionRepository,
  plan: SessionExportPlan,
): { sessions: Session[]; eventsBySessionId: Map<string, SessionEvent[]> } {
  const sessions: Session[] = [];
  const eventsBySessionId = new Map<string, SessionEvent[]>();
  for (const entry of plan.sessions) {
    const session = repository.getSession(entry.sessionId, plan.workspaceId);
    if (!session) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        `planned session no longer exists or is not authorized: ${entry.sessionId}`,
      );
    }
    if (session.sourceDigest !== entry.sourceDigest) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        `session source changed since the plan was generated: ${entry.sessionId}`,
      );
    }
    const events = repository.listEvents(entry.sessionId, plan.workspaceId);
    if (events.length !== entry.eventCount || eventDigestSummary(events) !== entry.eventDigestSummary) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        `session events changed since the plan was generated: ${entry.sessionId}`,
      );
    }
    sessions.push(session);
    eventsBySessionId.set(entry.sessionId, events);
  }
  return { sessions, eventsBySessionId };
}
