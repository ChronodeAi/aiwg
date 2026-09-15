/**
 * Recovers an `AiwgFortemiIndexExport`-shaped record graph from a real
 * `full-v1`/`2.0.0` Knowledge Shard archive built by
 * `aiwgFortemiIndexToKnowledgeShardWithReport` (#2564).
 *
 * `@fortemi/core`'s own `aiwgFortemiIndexFromKnowledgeShard` only recovers
 * archives built by the plain `aiwgFortemiIndexToKnowledgeShard` (`core-v1`):
 * that function embeds the entire original record verbatim as opaque note
 * metadata (`metadata.aiwg_fortemi_index`), which is what its reader looks
 * for. The strict `full-v1` converter deliberately does not do this -- the
 * point of `full-v1` is a genuinely native note/tag/link/provenance
 * representation any Fortemi consumer can read, not an AIWG-only escape
 * hatch. Verified empirically: `aiwgFortemiIndexFromKnowledgeShard` throws
 * "has no AIWG index metadata" against a `full-v1` archive, and even AIWG's
 * own artifact-index shard export test only round-trips through it using
 * `profile: "core-v1"`.
 *
 * So recovering a `full-v1` archive means reading the native shard files
 * directly and inverting this module's own mapping:
 *   - id/type/source/privacy  <- note.metadata.aiwg_source
 *   - title/text              <- note.title / note.original_content
 *   - tags                    <- note.tags
 *   - relationships           <- links.jsonl (from_note_id/to_note_id/kind/score)
 *   - provenance/provenance_events <- provenance_activities.jsonl, split by
 *     the `source:<field>` activity_type convention this module uses to
 *     distinguish `provenance` entries from `provenance_events` entries
 *
 * The index-level wrapper (`AiwgFortemiIndexExport.source`/`compatibility`)
 * is genuinely not preserved anywhere in a full-v1 archive -- there is no
 * per-archive metadata sidecar for it, only per-note. Recovery reports this
 * honestly with a fixed placeholder rather than inventing a value.
 */
import { unpackTarGz } from '@fortemi/core';
import type {
  AiwgFortemiIndexExport,
  AiwgFortemiProvenance,
  AiwgFortemiProvenanceEvent,
  AiwgFortemiRecord,
  AiwgFortemiRelationship,
} from '@fortemi/core';
import {
  SESSION_EXPORT_INDEX_SCHEMA_VERSION,
  SESSION_EXPORT_RECORD_SCHEMA_VERSION,
} from './fortemi-export-mapping.js';

const SOURCE_PROVENANCE_PREFIX = 'source:';

interface ShardNoteRecord {
  id: string;
  title: string;
  original_content: string;
  tags: string[];
  metadata?: { aiwg_source?: unknown };
}

interface ShardLinkRecord {
  from_note_id: string;
  to_note_id: string | null;
  kind: string;
  score: number | null;
}

interface ShardProvenanceActivityRecord {
  note_id: string;
  activity_type: string;
  model_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  metadata?: Record<string, unknown> | null;
}

interface AiwgSourceSidecar {
  record_id: string;
  record_type: string;
  source: AiwgFortemiRecord['source'];
  privacy: AiwgFortemiRecord['privacy'];
}

function decodeJsonLines<T>(bytes: Uint8Array | undefined): T[] {
  if (!bytes) return [];
  const text = new TextDecoder().decode(bytes);
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as T);
}

function isAiwgSourceSidecar(value: unknown): value is AiwgSourceSidecar {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.record_id === 'string' && typeof candidate.record_type === 'string';
}

export class FortemiShardRecoveryError extends Error {}

/**
 * Recovers the record graph from a `full-v1` archive. Throws
 * `FortemiShardRecoveryError` if the archive has no notes, or any note is
 * missing the `aiwg_source` sidecar this module's own mapping always writes
 * (meaning the shard wasn't produced by this mapping and can't be recovered
 * this way).
 */
export function recoverAiwgFortemiIndexFromFullV1Shard(bytes: Uint8Array): AiwgFortemiIndexExport {
  const files = unpackTarGz(bytes);
  const notes = decodeJsonLines<ShardNoteRecord>(files.get('notes.jsonl'));
  if (notes.length === 0) {
    throw new FortemiShardRecoveryError('Knowledge Shard contains no notes to recover');
  }
  const links = decodeJsonLines<ShardLinkRecord>(files.get('links.jsonl'));
  const activities = decodeJsonLines<ShardProvenanceActivityRecord>(files.get('provenance_activities.jsonl'));

  const noteIdToRecordId = new Map<string, string>();
  for (const note of notes) {
    const sidecar = note.metadata?.aiwg_source;
    if (!isAiwgSourceSidecar(sidecar)) {
      throw new FortemiShardRecoveryError(
        `Knowledge Shard note ${note.id} has no aiwg_source metadata -- `
        + 'this archive was not produced by the AIWG session export mapping',
      );
    }
    noteIdToRecordId.set(note.id, sidecar.record_id);
  }

  const items: AiwgFortemiRecord[] = notes.map((note) => {
    const sidecar = note.metadata!.aiwg_source as AiwgSourceSidecar;
    const relationships: AiwgFortemiRelationship[] = links
      .filter((link) => link.from_note_id === note.id)
      .map((link) => ({
        type: link.kind,
        target_id: link.to_note_id ? (noteIdToRecordId.get(link.to_note_id) ?? link.to_note_id) : '',
        confidence: link.score ?? undefined,
      }));
    const noteActivities = activities.filter((activity) => activity.note_id === note.id);
    const provenance: AiwgFortemiProvenance[] = [];
    const provenanceEvents: AiwgFortemiProvenanceEvent[] = [];
    for (const activity of noteActivities) {
      const metadata = activity.metadata ?? {};
      if (activity.activity_type.startsWith(SOURCE_PROVENANCE_PREFIX)) {
        provenance.push({
          field: activity.activity_type.slice(SOURCE_PROVENANCE_PREFIX.length),
          source: (metadata.source as string | undefined) ?? activity.model_name ?? '',
          path: (metadata.path as string | undefined) ?? '',
          confidence: (metadata.confidence as AiwgFortemiProvenance['confidence'] | undefined) ?? 'source',
          privacy: (metadata.privacy as AiwgFortemiProvenance['privacy'] | undefined) ?? 'private',
        });
      } else {
        provenanceEvents.push({
          activity: activity.activity_type,
          agent: activity.model_name ?? undefined,
          started_at: activity.started_at ?? undefined,
          ended_at: activity.ended_at ?? undefined,
          source: (metadata.source as string | undefined) ?? undefined,
          path: (metadata.path as string | undefined) ?? undefined,
          confidence: (metadata.confidence as AiwgFortemiProvenanceEvent['confidence'] | undefined) ?? undefined,
          privacy: (metadata.privacy as AiwgFortemiProvenanceEvent['privacy'] | undefined) ?? undefined,
          attributes: (metadata.attributes as Record<string, unknown> | undefined) ?? undefined,
        });
      }
    }
    return {
      schema_version: SESSION_EXPORT_RECORD_SCHEMA_VERSION,
      id: sidecar.record_id,
      type: sidecar.record_type,
      source: sidecar.source,
      title: note.title,
      text: note.original_content,
      facets: {},
      tags: note.tags,
      concepts: [],
      relationships,
      provenance,
      provenance_events: provenanceEvents,
      privacy: sidecar.privacy,
      updated_at: sidecar.source.updated_at ?? new Date(0).toISOString(),
    } satisfies AiwgFortemiRecord;
  });
  items.sort((left, right) => left.id.localeCompare(right.id));

  return {
    schema_version: SESSION_EXPORT_INDEX_SCHEMA_VERSION,
    // Not preserved anywhere in a full-v1 archive (see module doc) --
    // labeled honestly rather than invented.
    generated_at: new Date(0).toISOString(),
    source: { repo: 'recovered-from-full-v1-shard', privacy: 'private' },
    items,
  };
}
