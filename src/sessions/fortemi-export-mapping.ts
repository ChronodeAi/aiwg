/**
 * Maps AIWG session-catalog records onto the generic Fortemi Core record
 * graph (`AiwgFortemiRecord` / `AiwgFortemiIndexExport`) so session evidence
 * can be built into a real Knowledge Shard via `aiwgFortemiIndexToKnowledgeShard`
 * (#2564) instead of a hand-rolled archive format.
 *
 * Sessions and events have no on-disk repo path of their own -- they live in
 * the session catalog's SQLite store -- so `source.path`/`locator` use a
 * synthetic `aiwg-session://` scheme rather than claiming a real file. This
 * is deliberate, not a shortcut: it keeps the mapping honest about where the
 * data actually came from.
 */
import type {
  AiwgFortemiIndexExport,
  AiwgFortemiProvenance,
  AiwgFortemiRecord,
  AiwgFortemiRelationship,
} from '@fortemi/core';
import type { Session, SessionEvent } from './contracts.js';

/**
 * `record.v1`/`export.v1` forbid exactly the fields this mapping needs
 * (`source.origin`/`generated`/`checksum`/`updated_at`, relationship
 * `direction`/`privacy`, and any `compatibility` bag at all -- verified
 * empirically against @fortemi/core's bundled AJV schema, since the type
 * declarations alone don't encode this v1/v2 split). Use v2 throughout.
 */
export const SESSION_EXPORT_RECORD_SCHEMA_VERSION = 'aiwg.fortemi.index.record.v2' as const;
export const SESSION_EXPORT_INDEX_SCHEMA_VERSION = 'aiwg.fortemi.index.export.v2' as const;
const INDEX_GRAPH_ID = 'aiwg-sessions' as const;

export function sessionRecordLocator(session: Pick<Session, 'provider' | 'sessionId'>): string {
  return `aiwg-session://${session.provider}/${session.sessionId}`;
}

export function sessionEventRecordLocator(
  session: Pick<Session, 'provider' | 'sessionId'>,
  event: Pick<SessionEvent, 'eventId'>,
): string {
  return `${sessionRecordLocator(session)}/event/${event.eventId}`;
}

export function sessionToAiwgFortemiRecord(session: Session): AiwgFortemiRecord {
  const locator = sessionRecordLocator(session);
  const updatedAt = session.updatedAt ?? session.startedAt ?? new Date(0).toISOString();
  return {
    schema_version: SESSION_EXPORT_RECORD_SCHEMA_VERSION,
    id: session.sessionId,
    type: 'aiwg.session',
    source: {
      path: locator,
      repo_relative_path: locator,
      locator,
      origin: 'aiwg-session-catalog',
      generated: true,
      checksum: session.sourceDigest,
      updated_at: updatedAt,
    },
    // `title`/`text` are required by @fortemi/core's runtime schema even
    // though the published type marks them optional -- always emit a
    // deterministic fallback rather than an empty/undefined value.
    title: session.intent.title ?? `${session.provider} session ${session.nativeSessionId}`,
    text: session.intent.summary ?? `AIWG session ${session.sessionId} (${session.provider}, ${session.lifecycle})`,
    facets: { provider: [session.provider], lifecycle: [session.lifecycle] },
    tags: [],
    concepts: [],
    relationships: [],
    provenance: [{
      field: 'source',
      source: 'aiwg-session-catalog',
      path: locator,
      confidence: 'source',
      privacy: 'private',
    }],
    privacy: { classification: 'public', pii: false },
    updated_at: updatedAt,
    compatibility: {
      nativeSessionId: session.nativeSessionId,
      sourceId: session.sourceId,
      workspaceId: session.workspaceId,
      consistency: session.consistency,
    },
  };
}

export function sessionEventToAiwgFortemiRecord(
  session: Pick<Session, 'provider' | 'sessionId'>,
  event: SessionEvent,
): AiwgFortemiRecord {
  const locator = sessionEventRecordLocator(session, event);
  const parentLocator = sessionRecordLocator(session);
  const updatedAt = event.occurredAt ?? new Date(0).toISOString();
  const relationships: AiwgFortemiRelationship[] = [{
    type: 'parent-session',
    target_id: session.sessionId,
    target_path: parentLocator,
    direction: 'upstream',
    // This edge is a structural fact from the session catalog, not a
    // probabilistic inference -- maximum confidence, not a default.
    confidence: 1,
    privacy: event.sensitivity.classification === 'sensitive' ? 'private' : 'public',
  }];
  const provenance: AiwgFortemiProvenance[] = [{
    field: 'text',
    source: 'aiwg-session-catalog',
    path: locator,
    confidence: 'source',
    privacy: event.sensitivity.classification === 'sensitive' ? 'private' : 'public',
  }];
  return {
    schema_version: SESSION_EXPORT_RECORD_SCHEMA_VERSION,
    id: event.eventId,
    type: 'aiwg.session-event',
    source: {
      path: locator,
      repo_relative_path: locator,
      locator,
      origin: 'aiwg-session-catalog',
      generated: true,
      checksum: event.digest,
      updated_at: updatedAt,
    },
    title: `${event.kind}${event.role ? ` (${event.role})` : ''} -- ${session.sessionId}`,
    text: event.searchableText.length > 0 ? event.searchableText : `[${event.kind}: no text content]`,
    facets: {
      kind: [event.kind],
      ...(event.role ? { role: [event.role] } : {}),
      ...(event.toolName ? { tool: [event.toolName] } : {}),
    },
    tags: [],
    concepts: event.entities ?? [],
    relationships,
    provenance,
    privacy: {
      classification: event.sensitivity.classification === 'sensitive' ? 'private' : 'public',
      pii: event.sensitivity.classes.length > 0,
    },
    updated_at: updatedAt,
    compatibility: {
      sessionId: event.sessionId,
      sourceId: event.sourceId,
      nativeId: event.nativeId,
      sequence: event.sequence,
      model: event.model,
      toolCallId: event.toolCallId,
    },
  };
}

export interface SessionOutputRecordInput {
  sessionId: string;
  registrationId: string;
  outputLocator: string;
  outputDigest: string;
  mediaType: string;
  matchReason: string;
}

/**
 * A registered analysis output associated with a session (#2566), mapped as
 * a reference record. Like session-event attachments (#2565), this does not
 * embed the output's original bytes -- only its registration metadata and
 * digest, which is enough for a consumer to locate and verify the output
 * against the original registration, not to recover it from the shard
 * alone. Full byte embedding needs a blob-store integration that neither
 * #2564 nor #2566 has landed yet; that limitation is shared and explicit,
 * not silently dropped.
 */
export function sessionOutputToAiwgFortemiRecord(
  session: Pick<Session, 'provider' | 'sessionId'>,
  output: SessionOutputRecordInput,
): AiwgFortemiRecord {
  const locator = `${sessionRecordLocator(session)}/output/${output.registrationId}`;
  const now = new Date().toISOString();
  return {
    schema_version: SESSION_EXPORT_RECORD_SCHEMA_VERSION,
    id: `output_${output.registrationId}`,
    type: 'aiwg.session-output',
    source: {
      path: locator,
      repo_relative_path: output.outputLocator,
      locator,
      origin: 'aiwg-output-registration',
      generated: true,
      checksum: output.outputDigest,
      updated_at: now,
    },
    title: `registered output for ${session.sessionId}`,
    text: `${output.mediaType} output registered at ${output.outputLocator} (${output.matchReason}); `
      + 'bytes not embedded -- reference and digest only.',
    facets: { mediaType: [output.mediaType], lineage: ['registered'] },
    tags: [],
    concepts: [],
    relationships: [{
      type: 'parent-session',
      target_id: session.sessionId,
      target_path: sessionRecordLocator(session),
      direction: 'upstream',
      confidence: 1,
      privacy: 'private',
    }],
    provenance: [{
      field: 'source',
      source: 'aiwg-output-registration',
      path: locator,
      confidence: 'source',
      privacy: 'private',
    }],
    privacy: { classification: 'private', pii: false },
    updated_at: now,
    compatibility: {
      sessionId: output.sessionId,
      registrationId: output.registrationId,
      outputLocator: output.outputLocator,
      matchReason: output.matchReason,
      bytesEmbedded: false,
    },
  };
}

/**
 * Builds the full record graph for a selected set of sessions. `repoRef` is
 * a caller-supplied identity for `AiwgFortemiIndexExport.source.repo` (the
 * session catalog's workspace id, not a git repo -- the field is repurposed
 * honestly rather than left to imply something untrue).
 */
export function buildSessionAiwgFortemiIndexExport(
  repoRef: string,
  sessions: Session[],
  eventsBySessionId: ReadonlyMap<string, SessionEvent[]>,
  outputs: readonly SessionOutputRecordInput[] = [],
): AiwgFortemiIndexExport {
  const items: AiwgFortemiRecord[] = [];
  for (const session of sessions) {
    items.push(sessionToAiwgFortemiRecord(session));
    for (const event of eventsBySessionId.get(session.sessionId) ?? []) {
      items.push(sessionEventToAiwgFortemiRecord(session, event));
    }
    for (const output of outputs.filter((entry) => entry.sessionId === session.sessionId)) {
      items.push(sessionOutputToAiwgFortemiRecord(session, output));
    }
  }
  // Deterministic ordering: reproducible archives, easier diffing.
  items.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema_version: SESSION_EXPORT_INDEX_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source: { repo: repoRef, privacy: 'private', graph: INDEX_GRAPH_ID },
    compatibility: { previous_schema_version: 'aiwg.fortemi.index.export.v1', strategy: 'supported' },
    items,
  };
}
