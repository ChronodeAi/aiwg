import {
  computeBlobHash,
  packTarGz,
  sha256Hex,
  unpackTarGz,
  validateFullV1ShardArchive,
} from '@fortemi/core';

export interface EmbeddedShardAttachment {
  recordId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface NativeNote {
  id: string;
  metadata?: { aiwg_source?: { record_id?: string } };
  attachments?: Array<{
    extracted_text: string | null;
    extraction_status: 'deferred';
    reason: 'no_extracted_text';
    attachment: { id: string; path: string; mime: string; checksum: string; bytes: number };
  }>;
}

function jsonLines(values: unknown[]): Uint8Array {
  return new TextEncoder().encode(`${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

export async function embedAttachmentsInFullV1Shard(
  archive: Uint8Array,
  attachments: readonly EmbeddedShardAttachment[],
): Promise<Uint8Array> {
  if (attachments.length === 0) return archive;
  const files = unpackTarGz(archive);
  const notesBytes = files.get('notes.jsonl');
  const manifestBytes = files.get('manifest.json');
  if (!notesBytes || !manifestBytes) throw new Error('full-v1 shard is missing notes.jsonl or manifest.json');
  const notes = new TextDecoder().decode(notesBytes).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as NativeNote);
  const byRecordId = new Map(notes.map((note) => [note.metadata?.aiwg_source?.record_id, note]));
  for (const entry of attachments) {
    const note = byRecordId.get(entry.recordId);
    if (!note) throw new Error(`cannot attach bytes: shard record is missing: ${entry.recordId}`);
    const checksum = computeBlobHash(entry.bytes);
    note.attachments ??= [];
    note.attachments.push({
      extracted_text: null,
      extraction_status: 'deferred',
      reason: 'no_extracted_text',
      attachment: {
        id: entry.attachmentId,
        path: entry.filename,
        mime: entry.mimeType,
        checksum,
        bytes: entry.bytes.length,
      },
    });
    files.set(`blobs/${checksum.slice('blake3:'.length)}`, entry.bytes);
  }
  const updatedNotes = jsonLines(notes);
  files.set('notes.jsonl', updatedNotes);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    checksums: Record<string, string>;
  };
  manifest.checksums['notes.jsonl'] = await sha256Hex(updatedNotes);
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  const packed = packTarGz(files);
  const validation = await validateFullV1ShardArchive(packed);
  if (!validation.valid) throw new Error(`embedded shard failed validation: ${validation.errors.join('; ')}`);
  return packed;
}

export function recoverEmbeddedAttachments(archive: Uint8Array): EmbeddedShardAttachment[] {
  const files = unpackTarGz(archive);
  const notesBytes = files.get('notes.jsonl');
  if (!notesBytes) return [];
  const notes = new TextDecoder().decode(notesBytes).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as NativeNote);
  const recovered: EmbeddedShardAttachment[] = [];
  for (const note of notes) {
    const recordId = note.metadata?.aiwg_source?.record_id;
    if (!recordId) continue;
    for (const projection of note.attachments ?? []) {
      const ref = projection.attachment;
      const bytes = files.get(`blobs/${ref.checksum.replace(/^blake3:/, '')}`);
      if (!bytes) continue;
      if (bytes.length !== ref.bytes || computeBlobHash(bytes) !== ref.checksum) {
        throw new Error(`embedded attachment failed size/hash verification: ${ref.id}`);
      }
      recovered.push({
        recordId,
        attachmentId: ref.id,
        filename: ref.path,
        mimeType: ref.mime,
        bytes,
      });
    }
  }
  return recovered;
}
