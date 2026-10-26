// Hashes canonical worker configuration inputs for origins and replay checks.
import { createHash } from 'node:crypto';
/** Hash canonical JSON, treating absent optional model files as null. */
export function workerConfigDigest(value: unknown): string {
  const canonical = (node: any): any => {
    if (Array.isArray(node)) return node.map(canonical);
    if (node !== null && typeof node === 'object') return Object.fromEntries(Object.keys(node).sort().filter(key => node[key] !== undefined).map(key => [key, canonical(node[key])]));
    return node ?? null;
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}
