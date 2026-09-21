import { TextEncoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { parseDocument } from 'yaml';

export interface EntryLimits {
  serializedBytes: number;
  depth: number;
  properties: number;
  arrayLength: number;
  stringLength: number;
  entries: number;
  timeMs: number;
}

export const DEFAULT_ENTRY_LIMITS: Readonly<EntryLimits> = Object.freeze({
  serializedBytes: 262_144, depth: 32, properties: 4096,
  arrayLength: 4096, stringLength: 65_536, entries: 8192, timeMs: 1000,
});

export class EntryAdmissionError extends Error {
  constructor(readonly reasonCode: string, readonly counts: Readonly<Record<string, number>>) {
    super(`Decision entry rejected: ${reasonCode}`);
    this.name = 'EntryAdmissionError';
  }
}

/** Check the object graph before JSON serialization, schema validation or digesting. */
export function admitEntry(value: unknown, limits: Readonly<EntryLimits> = DEFAULT_ENTRY_LIMITS): void {
  const counts = { entries: 0, properties: 0, bytes: 0 };
  const started = performance.now();
  const encoder = new TextEncoder();
  const stack = new Set<object>();
  const fail = (reason: string): never => { throw new EntryAdmissionError(reason, counts); };
  const add = (text: string): void => {
    counts.bytes += encoder.encode(text).byteLength;
    if (counts.bytes > limits.serializedBytes) fail('serialized-bytes');
  };
  const visit = (item: unknown, depth: number): void => {
    if (performance.now() - started > limits.timeMs) fail('time-budget');
    if (++counts.entries > limits.entries) fail('entry-count');
    if (depth > limits.depth) fail('nesting-depth');
    if (item === null || typeof item === 'boolean') return add(String(item));
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('nonfinite-number');
      return add(JSON.stringify(item));
    }
    if (typeof item === 'string') {
      if (item.length > limits.stringLength) fail('string-length');
      return add(JSON.stringify(item));
    }
    if (!item || typeof item !== 'object') throw new EntryAdmissionError('non-json-value', counts);
    if (stack.has(item)) fail('cycle');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) fail('object-prototype');
    stack.add(item);
    if (Array.isArray(item)) {
      if (item.length > limits.arrayLength) fail('array-length');
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(item, index)) fail('sparse-array');
        visit(item[index], depth + 1);
      }
    } else {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(item);
      counts.properties += keys.length;
      if (counts.properties > limits.properties) fail('property-count');
      for (const key of keys) {
        if (typeof key !== 'string') throw new EntryAdmissionError('symbol-key', counts);
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail('unsafe-key');
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('accessor-or-hidden-field');
        add(JSON.stringify(key));
        visit(descriptor.value, depth + 1);
      }
    }
    stack.delete(item);
  };
  visit(value, 0);
};

/** Parse authored JSON with duplicate mapping keys rejected before it becomes an object. */
export function parseDecisionJson(source: string, limits: Readonly<EntryLimits> = DEFAULT_ENTRY_LIMITS): unknown {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > limits.serializedBytes) throw new EntryAdmissionError('serialized-bytes', { bytes });
  const started = performance.now();
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch { throw new EntryAdmissionError('invalid-json', { bytes }); }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new EntryAdmissionError('duplicate-or-invalid-key', { bytes });
  if (performance.now() - started > limits.timeMs) throw new EntryAdmissionError('time-budget', { bytes });
  admitEntry(value, limits);
  return value;
}

/** Bounded gzip admission for callers that accept compressed decision documents. */
export function parseCompressedDecisionJson(source: Uint8Array, limits: Readonly<EntryLimits> = DEFAULT_ENTRY_LIMITS): unknown {
  if (source.byteLength > limits.serializedBytes) {
    throw new EntryAdmissionError('compressed-bytes', { bytes: source.byteLength });
  }
  let inflated: Buffer;
  try {
    inflated = gunzipSync(source, { maxOutputLength: limits.serializedBytes });
  } catch {
    throw new EntryAdmissionError('decompressed-bytes-or-invalid-gzip', { bytes: source.byteLength });
  }
  return parseDecisionJson(inflated.toString('utf8'), limits);
}
