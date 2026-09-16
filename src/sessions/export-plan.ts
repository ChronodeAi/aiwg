/**
 * Builds and re-verifies a session export selection plan (#2564). A plan
 * binds a reviewable, human-inspectable selection to the exact session ids
 * and source/event digests seen at plan time, so `sessions export build`
 * can detect a stale plan (source changed since planning) rather than
 * silently exporting drifted data.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, SessionEvent } from './contracts.js';
import { SessionContractError } from './contracts.js';
import {
  buildSessionAiwgFortemiIndexExport,
  SESSION_EXPORT_INDEX_SCHEMA_VERSION,
} from './fortemi-export-mapping.js';
import { discoverSessionOutputCandidates, type SessionOutputCandidate } from './output-lineage.js';
import { FilesystemDerivedOutputIndex } from './output-registration.js';
import type { SessionRepository } from './repository.js';

export const SESSION_EXPORT_PLAN_SCHEMA_VERSION = '1.1.0' as const;

export interface SessionExportPlanEntry {
  sessionId: string;
  nativeSessionId: string;
  provider: string;
  sourceId: string;
  sourceDigest: string;
  metadataDigest: string;
  catalogTags: string[];
  eventCount: number;
  eventDigestSummary: string;
}

/** #2566: a registered analysis output selected alongside its session. */
export interface SessionExportPlanOutputEntry {
  sessionId: string;
  registrationId: string;
  outputLocator: string;
  outputDigest: string;
  outputByteLength: number;
  mediaType: string;
  lineage: 'registered';
  matchReason: string;
}

export interface SessionExportPlanAttachmentEntry {
  sessionId: string;
  eventId: string;
  filename: string;
  mediaType: string;
  digest: string;
  byteLength: number;
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
  attachments: SessionExportPlanAttachmentEntry[];
  totals: { sessionCount: number; eventCount: number; outputCount: number; attachmentCount: number; recordCount: number };
  preview: SessionExportPlanPreview;
}

function eventDigestSummary(events: SessionEvent[]): string {
  const hash = createHash('sha256');
  for (const event of events) hash.update(event.digest);
  return `sha256:${hash.digest('hex')}`;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sessionMetadataDigest(session: Session, catalogTags: readonly string[]): string {
  return sha256(JSON.stringify({ session, catalogTags: [...catalogTags].sort() }));
}

function localEventAttachment(
  event: SessionEvent,
  projectRoot?: string,
): { filename: string; mediaType: string; bytes: Uint8Array } | null {
  const nativeEnvelope = Object.entries(event.extensions)
    .find(([key, value]) => key.startsWith('native.') && value && typeof value === 'object')?.[1] as
      Record<string, unknown> | undefined;
  const attachment = event.extensions.attachment ?? nativeEnvelope?.attachment;
  if (!attachment || typeof attachment !== 'object') return null;
  const value = attachment as Record<string, unknown>;
  const filename = typeof value.displayName === 'string' && value.displayName.length > 0
    ? value.displayName
    : typeof value.filename === 'string' && value.filename.length > 0 && !value.filename.startsWith('[REDACTED:')
      ? value.filename
      : `${event.eventId}.bin`;
  const mediaType = typeof value.mime === 'string' && value.mime.length > 0 ? value.mime : 'application/octet-stream';
  if (Array.isArray(value.dataBytes)
    && value.dataBytes.every((item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255)) {
    return { filename, mediaType, bytes: Uint8Array.from(value.dataBytes as number[]) };
  }
  if (typeof value.dataUrl === 'string') {
    const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(value.dataUrl);
    if (!match) throw new SessionContractError('MALFORMED_SOURCE', `invalid data URL attachment: ${event.eventId}`);
    const bytes = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    return { filename, mediaType: match[1] || mediaType, bytes };
  }
  if (typeof value.fileUrl === 'string') {
    if (!projectRoot) throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'project root is required for file attachments');
    const root = realpathSync(projectRoot);
    const candidate = fileURLToPath(value.fileUrl);
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new SessionContractError('SOURCE_NOT_AUTHORIZED', `attachment is a symbolic link: ${event.eventId}`);
    const actual = realpathSync(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
      throw new SessionContractError('SOURCE_OUTSIDE_ALLOWED_ROOT', `attachment resolves outside the project: ${event.eventId}`);
    }
    return { filename, mediaType, bytes: readFileSync(actual) };
  }
  return null;
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
    const catalogTags = repository.listTags(sessionId, options.workspaceId);
    sessions.push(session);
    eventsBySessionId.set(sessionId, events);
    entries.push({
      sessionId: session.sessionId,
      nativeSessionId: session.nativeSessionId,
      provider: session.provider,
      sourceId: session.sourceId,
      sourceDigest: session.sourceDigest,
      metadataDigest: sessionMetadataDigest(session, catalogTags),
      catalogTags,
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
    outputByteLength: candidate.registration.output.byteLength,
    mediaType: candidate.registration.output.mediaType,
    lineage: candidate.lineage,
    matchReason: candidate.matchReason,
  }));
  const attachments: SessionExportPlanAttachmentEntry[] = [];
  for (const session of sessions) {
    for (const event of eventsBySessionId.get(session.sessionId) ?? []) {
      const attachment = localEventAttachment(event, options.projectRoot);
      if (attachment) attachments.push({
        sessionId: session.sessionId,
        eventId: event.eventId,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        digest: sha256(attachment.bytes),
        byteLength: attachment.bytes.length,
      });
    }
  }
  const catalogTagsBySessionId = new Map(entries.map((entry) => [entry.sessionId, entry.catalogTags]));
  const index = buildSessionAiwgFortemiIndexExport(
    options.workspaceId, sessions, eventsBySessionId, outputs, catalogTagsBySessionId,
  );
  const plan: SessionExportPlan = {
    schemaVersion: SESSION_EXPORT_PLAN_SCHEMA_VERSION,
    indexSchemaVersion: SESSION_EXPORT_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceId: options.workspaceId,
    sessions: entries,
    outputs,
    attachments,
    totals: {
      sessionCount: sessions.length,
      eventCount: entries.reduce((sum, entry) => sum + entry.eventCount, 0),
      outputCount: outputs.length,
      attachmentCount: attachments.length,
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
  options: { projectRoot?: string } = {},
): {
  sessions: Session[];
  eventsBySessionId: Map<string, SessionEvent[]>;
  catalogTagsBySessionId: Map<string, string[]>;
  outputBytesByRegistrationId: Map<string, Uint8Array>;
  attachmentBytesByEventId: Map<string, Uint8Array>;
} {
  const sessions: Session[] = [];
  const eventsBySessionId = new Map<string, SessionEvent[]>();
  const catalogTagsBySessionId = new Map<string, string[]>();
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
    const catalogTags = repository.listTags(entry.sessionId, plan.workspaceId);
    if (entry.metadataDigest !== sessionMetadataDigest(session, catalogTags)
      || JSON.stringify(entry.catalogTags) !== JSON.stringify(catalogTags)) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        `session metadata or tags changed since the plan was generated: ${entry.sessionId}`,
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
    catalogTagsBySessionId.set(entry.sessionId, catalogTags);
  }
  const outputBytesByRegistrationId = new Map<string, Uint8Array>();
  if (plan.outputs.length > 0) {
    if (!options.projectRoot) {
      throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'project root is required to verify planned outputs');
    }
    const root = realpathSync(options.projectRoot);
    for (const output of plan.outputs) {
      const candidate = resolve(root, output.outputLocator);
      let stat;
      try {
        stat = lstatSync(candidate);
      } catch {
        throw new SessionContractError(
          'SCHEMA_DRIFT',
          `registered output is missing since the plan was generated: ${output.outputLocator}`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new SessionContractError('SOURCE_NOT_AUTHORIZED', `planned output is a symbolic link: ${output.outputLocator}`);
      }
      if (!stat.isFile()) {
        throw new SessionContractError('SCHEMA_DRIFT', `planned output is no longer a regular file: ${output.outputLocator}`);
      }
      if (stat.size !== output.outputByteLength) {
        throw new SessionContractError(
          'SCHEMA_DRIFT',
          `registered output changed since the plan was generated: ${output.outputLocator}`,
        );
      }
      const actual = realpathSync(candidate);
      if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
        throw new SessionContractError('SOURCE_OUTSIDE_ALLOWED_ROOT', 'planned output resolves outside the project');
      }
      const bytes = readFileSync(actual);
      if (sha256(bytes) !== output.outputDigest) {
        throw new SessionContractError(
          'SCHEMA_DRIFT',
          `registered output changed since the plan was generated: ${output.outputLocator}`,
        );
      }
      outputBytesByRegistrationId.set(output.registrationId, bytes);
    }
  }
  const attachmentBytesByEventId = new Map<string, Uint8Array>();
  for (const planned of plan.attachments ?? []) {
    const event = eventsBySessionId.get(planned.sessionId)?.find((candidate) => candidate.eventId === planned.eventId);
    const attachment = event ? localEventAttachment(event, options.projectRoot) : null;
    if (!attachment || attachment.bytes.length !== planned.byteLength || sha256(attachment.bytes) !== planned.digest) {
      throw new SessionContractError('SCHEMA_DRIFT', `session attachment changed since the plan was generated: ${planned.eventId}`);
    }
    attachmentBytesByEventId.set(planned.eventId, attachment.bytes);
  }
  return {
    sessions, eventsBySessionId, catalogTagsBySessionId, outputBytesByRegistrationId, attachmentBytesByEventId,
  };
}
