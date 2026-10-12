/**
 * Maps AIWG session-catalog records onto the generic Fortemi Core record
 * graph (`AiwgFortemiRecord` / `AiwgFortemiIndexExport`) so session evidence
 * can be built into a real, canonical `full-v1`/`2.0.0` Knowledge Shard via
 * `aiwgFortemiIndexToKnowledgeShardWithReport` (#2564) instead of a
 * hand-rolled archive format.
 *
 * Sessions and events have no on-disk repo path of their own -- they live in
 * the session catalog's SQLite store -- so `source.path`/`locator` use a
 * synthetic `aiwg-session://` scheme rather than claiming a real file. This
 * is deliberate, not a shortcut: it keeps the mapping honest about where the
 * data actually came from.
 *
 * Every AIWG-specific bit of bookkeeping (provider, lifecycle, kind, role,
 * tool name, native ids, model, sequence, ...) is represented through native
 * full-v1 shard components -- `tags` and `provenance_events` -- not through
 * an ad-hoc `facets`/`compatibility` bag. This was verified empirically: the
 * strict `...WithReport` converter refuses to produce an archive at all
 * (`success: false`) when a record carries fields it doesn't recognize as a
 * native component (reported as "unmapped fields not hidden in note
 * metadata"), so anything AIWG wants preserved has to go through a field the
 * converter actually understands. `tags`/`provenance_events` do; the earlier
 * `facets`/`compatibility` shape didn't.
 */
import type {
  AiwgFortemiIndexExport,
  AiwgFortemiProvenance,
  AiwgFortemiProvenanceEvent,
  AiwgFortemiRecord,
  AiwgFortemiRelationship,
} from '@fortemi/core';
import type { Session, SessionEvent } from './contracts.js';

/**
 * `record.v1`/`export.v1` forbid exactly the fields this mapping needs
 * (`source.origin`/`generated`/`checksum`/`updated_at`, relationship
 * `direction`/`confidence`/`privacy`) -- verified empirically against
 * @fortemi/core's bundled AJV schema, since the type declarations alone
 * don't encode this v1/v2 split. Use v2 throughout.
 */
export const SESSION_EXPORT_RECORD_SCHEMA_VERSION = 'aiwg.fortemi.index.record.v2' as const;
export const SESSION_EXPORT_INDEX_SCHEMA_VERSION = 'aiwg.fortemi.index.export.v2' as const;
const INDEX_GRAPH_ID = 'aiwg-sessions' as const;

function tag(key: string, value: string): string {
  return `${key}:${value}`;
}

export function sessionRecordLocator(session: Pick<Session, 'provider' | 'sessionId'>): string {
  return `aiwg-session://${session.provider}/${session.sessionId}`;
}

export function sessionEventRecordLocator(
  session: Pick<Session, 'provider' | 'sessionId'>,
  event: Pick<SessionEvent, 'eventId'>,
): string {
  return `${sessionRecordLocator(session)}/event/${event.eventId}`;
}

export function sessionToAiwgFortemiRecord(
  session: Session,
  catalogTags: readonly string[] = [],
): AiwgFortemiRecord {
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
    facets: {},
    tags: [
      tag('provider', session.provider),
      tag('lifecycle', session.lifecycle),
      ...catalogTags.map((value) => tag('catalogTag', value)),
    ],
    concepts: [],
    relationships: [],
    provenance: [{
      field: 'source',
      source: 'aiwg-session-catalog',
      path: locator,
      confidence: 'source',
      privacy: 'private',
    }],
    // Structural identifiers this export exists to preserve, carried as a
    // native provenance_events attribute bag rather than an unmapped
    // `compatibility` field the full-v1 converter would refuse to archive.
    provenance_events: [{
      activity: 'aiwg.session',
      agent: session.provider,
      started_at: session.startedAt ?? updatedAt,
      source: 'aiwg-session-catalog',
      path: locator,
      confidence: 'source',
      privacy: 'private',
      attributes: {
        nativeSessionId: session.nativeSessionId,
        sourceId: session.sourceId,
        workspaceId: session.workspaceId,
        consistency: session.consistency,
      },
    }],
    privacy: { classification: 'public', pii: false },
    updated_at: updatedAt,
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
  const provenanceEvents: AiwgFortemiProvenanceEvent[] = [{
    activity: `aiwg.session-event.${event.kind}`,
    agent: event.model ?? session.provider,
    started_at: event.occurredAt ?? updatedAt,
    source: 'aiwg-session-catalog',
    path: locator,
    confidence: 'source',
    privacy: event.sensitivity.classification === 'sensitive' ? 'private' : 'public',
    attributes: {
      sessionId: event.sessionId,
      sourceId: event.sourceId,
      nativeId: event.nativeId,
      sequence: event.sequence,
      toolCallId: event.toolCallId,
    },
  }];
  const tags = [
    tag('kind', event.kind),
    ...(event.role ? [tag('role', event.role)] : []),
    ...(event.toolName ? [tag('tool', event.toolName)] : []),
    ...(event.entities ?? []).map((entity) => tag('entity', entity)),
  ];
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
    facets: {},
    tags,
    // Entities are AIWG-extracted strings, not real SKOS taxonomy concepts
    // with definitions -- represented as `entity:` tags above, not as
    // `concepts` (which the full-v1 converter treats as SKOS references and
    // refuses to archive without SKOS metadata backing them).
    concepts: [],
    relationships,
    provenance,
    provenance_events: provenanceEvents,
    privacy: {
      classification: event.sensitivity.classification === 'sensitive' ? 'private' : 'public',
      pii: event.sensitivity.classes.length > 0,
    },
    updated_at: updatedAt,
  };
}

export interface SessionOutputRecordInput {
  sessionId: string;
  registrationId: string;
  outputLocator: string;
  outputDigest: string;
  mediaType: string;
  matchReason: string;
  bytesEmbedded?: boolean;
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
      + (output.bytesEmbedded ? 'original bytes embedded as a native attachment.' : 'bytes not embedded -- reference and digest only.'),
    facets: {},
    tags: [tag('mediaType', output.mediaType), tag('lineage', 'registered')],
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
    provenance_events: [{
      activity: 'aiwg.session-output',
      agent: 'aiwg-output-registration',
      started_at: now,
      source: 'aiwg-output-registration',
      path: locator,
      confidence: 'source',
      privacy: 'private',
      attributes: {
        sessionId: output.sessionId,
        registrationId: output.registrationId,
        outputLocator: output.outputLocator,
        matchReason: output.matchReason,
        bytesEmbedded: output.bytesEmbedded === true,
      },
    }],
    privacy: { classification: 'private', pii: false },
    updated_at: now,
  };
}

/**
 * A full-v1 archive has no per-archive metadata sidecar -- only the
 * `aiwg_source` embedded on each individual note. Without this record, the
 * index-level wrapper (`source.repo`/`privacy`/`graph`, `generated_at`)
 * would be a real, disclosed recovery gap. Representing it as one more
 * ordinary record closes that gap using the exact mechanism already built
 * for every other field (`provenance_events[0].attributes`), rather than
 * inventing a second, parallel embedding path.
 *
 * The id is prefixed to sort after every `event_`/`output_`/`session_` id
 * (deterministic regardless of content), and the type is namespaced so
 * recovery can find and exclude it from the recovered `items` unambiguously.
 */
export const EXPORT_MANIFEST_RECORD_TYPE = 'aiwg.session-catalog-export-manifest' as const;
export const EXPORT_MANIFEST_RECORD_ID = 'zzz-aiwg-session-catalog-export-manifest' as const;

function exportManifestRecord(repoRef: string, generatedAt: string): AiwgFortemiRecord {
  const locator = `aiwg-session-catalog://export-manifest/${repoRef}`;
  return {
    schema_version: SESSION_EXPORT_RECORD_SCHEMA_VERSION,
    id: EXPORT_MANIFEST_RECORD_ID,
    type: EXPORT_MANIFEST_RECORD_TYPE,
    source: {
      path: locator,
      repo_relative_path: locator,
      locator,
      origin: 'aiwg-session-catalog',
      generated: true,
      updated_at: generatedAt,
    },
    title: 'AIWG session export manifest',
    text: `Index-level metadata for this session export (${repoRef}). Not a session, event, or output record.`,
    facets: {},
    tags: [tag('graph', INDEX_GRAPH_ID)],
    concepts: [],
    relationships: [],
    provenance: [{
      field: 'source', source: 'aiwg-session-catalog', path: locator, confidence: 'source', privacy: 'private',
    }],
    provenance_events: [{
      activity: EXPORT_MANIFEST_RECORD_TYPE,
      agent: 'aiwg-session-catalog',
      started_at: generatedAt,
      source: 'aiwg-session-catalog',
      path: locator,
      confidence: 'source',
      privacy: 'private',
      attributes: { repo: repoRef, privacy: 'private', graph: INDEX_GRAPH_ID, generatedAt },
    }],
    privacy: { classification: 'private', pii: false },
    updated_at: generatedAt,
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
  catalogTagsBySessionId: ReadonlyMap<string, readonly string[]> = new Map(),
): AiwgFortemiIndexExport {
  const generatedAt = new Date().toISOString();
  const items: AiwgFortemiRecord[] = [exportManifestRecord(repoRef, generatedAt)];
  for (const session of sessions) {
    items.push(sessionToAiwgFortemiRecord(session, catalogTagsBySessionId.get(session.sessionId) ?? []));
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
    generated_at: generatedAt,
    source: { repo: repoRef, privacy: 'private', graph: INDEX_GRAPH_ID },
    compatibility: { previous_schema_version: 'aiwg.fortemi.index.export.v1', strategy: 'supported' },
    items,
  };
}
