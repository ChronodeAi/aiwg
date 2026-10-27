// Derive public contract locations from schema fields without reflecting payload text.
import type { ErrorObject } from 'ajv';
import type { WorkerDefinitionName } from './types.js';

export function workerSemanticErrors(value: unknown, maxBytes: number, maxDepth: number): string[] {
  const ancestors = new Set<object>();
  function visit(node: unknown, depth: number): string | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (depth > maxDepth) return `JSON nesting depth exceeds ${maxDepth}`;
    if (ancestors.has(node)) return 'Worker JSON must not contain cycles';
    ancestors.add(node);
    for (const child of Object.values(node)) {
      const error = visit(child, depth + 1);
      if (error) return error;
    }
    ancestors.delete(node);
    return undefined;
  }
  // Root object/array is depth 1; scalar leaves do not add a nesting level.
  const depthError = visit(value, 1);
  if (depthError) return [depthError];
  try {
    const bytes = JSON.stringify(value);
    if (bytes === undefined) return ['Worker payload must be JSON serializable'];
    if (Buffer.byteLength(bytes, 'utf8') > maxBytes) return [`Serialized UTF-8 JSON exceeds ${maxBytes} bytes`];
  } catch {
    return ['Worker payload must be JSON serializable'];
  }
  return [];
}

export function contractValidationPointer(definition: WorkerDefinitionName,
  errors: ErrorObject[] | null | undefined, schema: Record<string, unknown>): string {
  const names = new Set<string>();
  function visit(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') {
      for (const name of Object.keys(record.properties)) names.add(name);
    }
    for (const value of Object.values(record)) visit(value);
  }
  visit(schema);
  const error = errors?.[0];
  const parts = (error?.instancePath ?? '').split('/').slice(1);
  if (error?.keyword === 'required') parts.push(String(error.params.missingProperty));
  const safe: string[] = [definition];
  for (const part of parts) {
    const name = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!names.has(name) && !/^(0|[1-9][0-9]{0,8})$/.test(name)) break;
    safe.push(part);
  }
  return `/${safe.join('/')}`;
}
