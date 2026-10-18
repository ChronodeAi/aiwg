import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { assertSessionResourceLimit, schemaIssueDetail, SessionContractError, type ConsistencyStateSchema } from './contracts.js';
import { assertImportByteLimit, DEFAULT_IMPORT_BYTE_LIMITS, type ImportByteLimits } from './import-limits.js';
import { authorizeSourceFile, type SourceAuthorization } from './policy.js';
import type { z } from 'zod';

export interface ReaderLimits extends ImportByteLimits {
  maxRecords: number;
  maxNestingDepth: number;
}
export type ReaderLimitName = Exclude<keyof ReaderLimits, 'limitOrigins'>;

export interface BoundedJsonRecord {
  value: unknown;
  sequence: number;
  byteOffset: number;
  byteLength: number;
}
export interface BoundedReadResult {
  records: BoundedJsonRecord[];
  nextCursor: string;
  consistency: z.infer<typeof ConsistencyStateSchema>;
  incompleteTail: boolean;
  bytesRead: number;
}

export interface BoundedJsonLineStream extends AsyncIterable<BoundedJsonRecord> {
  readonly nextCursor: string;
  readonly consistency: z.infer<typeof ConsistencyStateSchema>;
  readonly incompleteTail: boolean;
  readonly bytesRead: number;
  readonly recordsRead: number;
}

export const DEFAULT_READER_LIMITS: ReaderLimits = Object.freeze({
  maxRecords: 1_000_000,
  ...DEFAULT_IMPORT_BYTE_LIMITS,
  maxNestingDepth: 64,
});

export async function* streamJsonLines(
  path: string,
  options: {
    start?: number;
    end?: number;
    limits?: ImportByteLimits;
  } = {},
): AsyncGenerator<{ line: string; byteLength: number }> {
  const input = createReadStream(path, { start: options.start, end: options.end });
  let parts: Buffer[] = [];
  let length = 0;
  let total = 0;
  try {
    for await (const chunk of input) {
      const buffer = chunk as Buffer;
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start);
        const end = newline === -1 ? buffer.length : newline + 1;
        const segment = buffer.subarray(start, end);
        if (options.limits) {
          assertImportByteLimit('maxRecordBytes', options.limits, length + segment.length);
          assertImportByteLimit('maxTotalBytes', options.limits, (options.start ?? 0) + total + segment.length);
        }
        // Bound the raw bytes before copying or decoding a record. Only LF
        // separates records; CRLF and Unicode separators remain JSON input.
        parts.push(segment);
        length += segment.length;
        total += segment.length;
        start = end;
        if (newline !== -1) {
          const line = Buffer.concat(parts, length).toString('utf8');
          const byteLength = length;
          parts = [];
          length = 0;
          yield { line, byteLength };
        }
      }
    }
    if (length > 0) yield { line: Buffer.concat(parts, length).toString('utf8'), byteLength: length };
  } finally {
    input.destroy();
  }
}

export async function readBoundedJsonLines(
  authorization: SourceAuthorization,
  options: {
    cursor?: string;
    consistency: z.infer<typeof ConsistencyStateSchema>;
    limits?: Partial<ReaderLimits>;
  },
): Promise<BoundedReadResult> {
  const stream = await streamBoundedJsonLines(authorization, options);
  const records: BoundedJsonRecord[] = [];
  for await (const record of stream) records.push(record);
  return {
    records,
    nextCursor: stream.nextCursor,
    consistency: stream.consistency,
    incompleteTail: stream.incompleteTail,
    bytesRead: stream.bytesRead,
  };
}

export async function streamBoundedJsonLines(
  authorization: SourceAuthorization,
  options: {
    cursor?: string;
    consistency: z.infer<typeof ConsistencyStateSchema>;
    limits?: Partial<ReaderLimits>;
  },
): Promise<BoundedJsonLineStream> {
  const allowed = await authorizeSourceFile(authorization);
  const limits = { ...DEFAULT_READER_LIMITS, ...options.limits };
  const start = parseCursor(options.cursor);
  if (start > allowed.size) throw new SessionContractError(
    'SCHEMA_DRIFT',
    'reader cursor is beyond source size',
    schemaIssueDetail('cursor'),
  );

  let offset = start;
  let total = 0;
  let count = 0;
  let incompleteTail = false;
  const iterate = async function* (): AsyncGenerator<BoundedJsonRecord> {
    for await (const { line, byteLength: bytes } of streamJsonLines(allowed.canonicalPath, { start, limits })) {
      assertSessionResourceLimit('maxRecords', limits.maxRecords, count + 1);
      if (line.trim() === '') {
        offset += bytes;
        total += bytes;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        if (options.consistency === 'provisional') {
          incompleteTail = true;
          break;
        }
        throw new SessionContractError(
          'SCHEMA_DRIFT',
          'malformed JSONL record in consistent source',
          schemaIssueDetail('<root>', 'invalid_json'),
        );
      }
      assertSessionResourceLimit('maxNestingDepth', limits.maxNestingDepth, jsonDepth(value));
      const record = { value, sequence: count, byteOffset: offset, byteLength: bytes };
      count += 1;
      offset += bytes;
      total += bytes;
      yield record;
    }
  };
  return {
    get nextCursor() { return String(offset); },
    consistency: options.consistency,
    get incompleteTail() { return incompleteTail; },
    get bytesRead() { return total; },
    get recordsRead() { return count; },
    [Symbol.asyncIterator]: iterate,
  };
}

// Single-document JSON and text exports cannot be incrementally normalized.
export const MAX_BUFFERED_SOURCE_BYTES = 64 * 1024 * 1024;

export async function readBoundedJson(
  authorization: SourceAuthorization,
  limitsInput?: Partial<ReaderLimits>,
): Promise<{ value: unknown; bytesRead: number }> {
  const allowed = await authorizeSourceFile(authorization);
  const limits = { ...DEFAULT_READER_LIMITS, ...limitsInput };
  assertImportByteLimit('maxTotalBytes', limits, allowed.size);
  assertImportByteLimit('maxRecordBytes', limits, allowed.size);
  assertSessionResourceLimit('maxBufferedSourceBytes', MAX_BUFFERED_SOURCE_BYTES, allowed.size);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(allowed.canonicalPath, 'utf8'));
  } catch {
    throw new SessionContractError('SCHEMA_DRIFT', 'malformed JSON source', schemaIssueDetail('<root>', 'invalid_json'));
  }
  assertSessionResourceLimit('maxNestingDepth', limits.maxNestingDepth, jsonDepth(value));
  return { value, bytesRead: allowed.size };
}

export async function readBoundedText(
  authorization: SourceAuthorization,
  limitsInput?: Partial<ReaderLimits>,
): Promise<{ value: string; bytesRead: number }> {
  const allowed = await authorizeSourceFile(authorization);
  const limits = { ...DEFAULT_READER_LIMITS, ...limitsInput };
  assertImportByteLimit('maxTotalBytes', limits, allowed.size);
  assertImportByteLimit('maxRecordBytes', limits, allowed.size);
  assertSessionResourceLimit('maxBufferedSourceBytes', MAX_BUFFERED_SOURCE_BYTES, allowed.size);
  return {
    value: await readFile(allowed.canonicalPath, 'utf8'),
    bytesRead: allowed.size,
  };
}

export async function fingerprintSourceFile(
  authorization: SourceAuthorization,
): Promise<{ digest: string; size: number }> {
  const allowed = await authorizeSourceFile(authorization);
  const handle = await open(allowed.canonicalPath, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < allowed.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, allowed.size - position), position);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { digest: `sha256:${hash.digest('hex')}`, size: allowed.size };
}

export async function fingerprintSourcePrefix(
  authorization: SourceAuthorization,
  length: number,
  skipPrefixBytes = 0,
): Promise<{ digest: string; size: number; mtimeMs: number; fileIdentity: string }> {
  const allowed = await authorizeSourceFile(authorization);
  if (!Number.isSafeInteger(length) || length < 0 || length > allowed.size
    || !Number.isSafeInteger(skipPrefixBytes) || skipPrefixBytes < 0 || skipPrefixBytes > allowed.size) {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'checkpoint source position is beyond the current source size',
      schemaIssueDetail('cursor'),
    );
  }
  const handle = await open(allowed.canonicalPath, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = skipPrefixBytes;
    while (position < length) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, length - position),
        position,
      );
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    size: allowed.size,
    mtimeMs: allowed.mtimeMs,
    fileIdentity: `${allowed.dev}:${allowed.ino}`,
  };
}

function parseCursor(cursor?: string): number {
  if (cursor === undefined || cursor === '') return 0;
  if (!/^\d+$/.test(cursor)) throw new SessionContractError('SCHEMA_DRIFT', 'invalid reader cursor', schemaIssueDetail('cursor'));
  return Number(cursor);
}

function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((max, child) => Math.max(max, jsonDepth(child, depth + 1)), depth);
}
