// Content-addressed tool-output image references for the session catalog (#3265).
import { createHash } from 'node:crypto';
import type { SessionEvent, SessionImageRef } from './contracts.js';

export type { SessionImageRef };

export interface ExtractedSessionImage extends SessionImageRef {
  bytes: Uint8Array;
}

export type SessionImageStatus = 'available' | 'unavailable';

export interface ResolvedSessionImage extends SessionImageRef {
  status: SessionImageStatus;
}

export interface ImageSourceLocator {
  locatorClass?: string;
  offset?: number;
}

const IMAGE_DIGEST_PREFIX = 'sha256:';

export function sha256Bytes(value: Uint8Array | string): `sha256:${string}` {
  return `${IMAGE_DIGEST_PREFIX}${createHash('sha256').update(value).digest('hex')}` as `sha256:${string}`;
}

export function isImageDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

/** Human-readable byte size for image placeholders (`3.1 MB`, `68 B`). */
export function formatImageBytes(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) return '0 B';
  if (byteLength < 1024) return `${Math.trunc(byteLength)} B`;
  const kb = byteLength / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Placeholder kept in `searchableText` (and FTS) instead of the image bytes. */
export function imagePlaceholder(ref: Pick<SessionImageRef, 'digest' | 'mediaType' | 'byteLength'>): string {
  return `[image: ${ref.digest}, ${ref.mediaType}, ${formatImageBytes(ref.byteLength)}]`;
}

// The payload class excludes whitespace so a match stops at the first word
// boundary instead of swallowing following prose; shape (and a minimum
// length well below any real image) is validated again on decode.
const DATA_URL_PATTERN = /data:(image\/[a-zA-Z0-9+.-]+)(;[a-zA-Z0-9!#$&^_.+-]+)*;base64,([A-Za-z0-9+/=]+)/g;
const MIN_BASE64_PAYLOAD_CHARS = 32;

function decodeBase64Payload(payload: string): Uint8Array | null {
  const compact = payload.replace(/\s+/g, '');
  // `Buffer.from(x, 'base64')` never throws -- it skips invalid characters --
  // so validate the shape first: base64 alphabet only, padding at the end,
  // and a length that can carry at least one byte.
  if (compact.length < 4 || compact.length % 4 === 1) return null;
  if (!/^(?:[A-Za-z0-9+/]+={0,2})$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0) return null;
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export interface TextImageExtraction {
  text: string;
  images: ExtractedSessionImage[];
}

/**
 * Replace inline base64 image data URLs in free text with content-hash
 * placeholders. Only `image/*` media types are extracted; other data URLs
 * (and remote `http(s)` image URLs, which are references already) pass
 * through untouched.
 */
export function extractInlineImagesFromText(
  text: string,
  source: ImageSourceLocator = {},
): TextImageExtraction {
  const images: ExtractedSessionImage[] = [];
  if (!text.includes('data:image/')) return { text, images };
  DATA_URL_PATTERN.lastIndex = 0;
  const result = text.replace(DATA_URL_PATTERN, (match, mediaType: string, _params: string, payload: string) => {
    if (payload.length < MIN_BASE64_PAYLOAD_CHARS) return match;
    const bytes = decodeBase64Payload(payload);
    if (!bytes) return match;
    const ref: ExtractedSessionImage = {
      digest: sha256Bytes(bytes),
      mediaType: String(mediaType).toLowerCase(),
      byteLength: bytes.length,
      ...(source.locatorClass !== undefined ? { locatorClass: source.locatorClass } : {}),
      ...(source.offset !== undefined ? { offset: source.offset } : {}),
      bytes,
    };
    images.push(ref);
    return imagePlaceholder(ref);
  });
  return { text: result, images };
}


function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface EventImageExtraction {
  searchableText: string;
  extensions: Record<string, unknown>;
  imageRefs: SessionImageRef[];
  images: ExtractedSessionImage[];
}

/**
 * Extract inline images from a whole import batch. Returns replacement
 * events (bytes swapped for references) plus the distinct blobs to persist.
 * Idempotent: placeholder text from an earlier pass matches no pattern, so
 * importer-extracted batches and direct writers converge on the same store
 * state. Blobs travel beside the events because event JSON must only hold
 * the content-hash reference, never the bytes.
 */
export function extractBatchEventImages(batch: {
  events: SessionEvent[];
  imageBlobs?: ExtractedSessionImage[];
}): { events: SessionEvent[]; imageBlobs: ExtractedSessionImage[] } {
  const blobs = new Map<string, ExtractedSessionImage>();
  for (const carried of batch.imageBlobs ?? []) {
    if (isImageDigest(carried.digest) && !blobs.has(carried.digest)) blobs.set(carried.digest, carried);
  }
  const events = batch.events.map((event) => {
    const extracted = extractEventImages({
      searchableText: event.searchableText,
      extensions: event.extensions,
      rawReference: event.rawReference,
    });
    for (const image of extracted.images) {
      if (!blobs.has(image.digest)) blobs.set(image.digest, image);
    }
    if (extracted.images.length === 0) return event;
    const refs: SessionImageRef[] = [...(event.imageRefs ?? [])];
    for (const ref of extracted.imageRefs) {
      if (!refs.some((prior) => prior.digest === ref.digest)) refs.push(ref);
    }
    return {
      ...event,
      searchableText: extracted.searchableText,
      extensions: extracted.extensions,
      imageRefs: refs,
    };
  });
  return { events, imageBlobs: [...blobs.values()] };
}

/** Extract inline images from one event's text; extensions keep their existing redaction. */
export function extractEventImages(input: {
  searchableText: string;
  extensions?: Record<string, unknown>;
  rawReference?: ImageSourceLocator;
}): EventImageExtraction {
  const source: ImageSourceLocator = {
    ...(input.rawReference?.locatorClass !== undefined ? { locatorClass: input.rawReference.locatorClass } : {}),
    ...(input.rawReference?.offset !== undefined ? { offset: input.rawReference.offset } : {}),
  };
  // Only event text is lifted. Provider image blocks in `extensions` are
  // left to native-extension sanitization, which redacts them to markers,
  // so this change never retains image bytes the catalog used to drop.
  const text = extractInlineImagesFromText(input.searchableText ?? '', source);
  const images = text.images;
  return {
    searchableText: text.text,
    extensions: isPlainObject(input.extensions) ? input.extensions : {},
    imageRefs: images.map((image) => ({
      digest: image.digest,
      mediaType: image.mediaType,
      byteLength: image.byteLength,
      ...(image.locatorClass !== undefined ? { locatorClass: image.locatorClass } : {}),
      ...(image.offset !== undefined ? { offset: image.offset } : {}),
    })),
    images,
  };
}
