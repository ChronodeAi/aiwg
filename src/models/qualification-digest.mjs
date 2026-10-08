import { createHash } from 'node:crypto';

// One encoding for persisted TS bindings, runtime ESM edits and installation
// scopes. Use code-unit key order, never locale-dependent collation. Optional
// object properties follow JSON omission semantics; array order is significant.
export function qualificationDigest(value) {
  const normalize = item => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort()
        .filter(key => item[key] !== undefined)
        .map(key => [key, normalize(item[key])]));
    }
    return item;
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')}`;
}
