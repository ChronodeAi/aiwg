// Validates HITL with the existing config schema definitions, shared by loader and resolver.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

function compiled(): ValidateFunction {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, 'vscode-extension/schemas/aiwg.config.v1.json'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('HITL config schema unavailable');
    root = parent;
  }
  const schema = JSON.parse(readFileSync(join(root, 'vscode-extension/schemas/aiwg.config.v1.json'), 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile({
    $ref: '#/definitions/HitlPolicy',
    definitions: Object.fromEntries(['HitlPolicy', 'HitlProfile', 'HitlSelector'].map(key => [key, schema.definitions[key]])),
  });
}
// Compile at module initialization; resolving an action performs no filesystem I/O.
const validator = compiled();
export function validateHitlPolicy(value: unknown): string[] {
  if (value === undefined) return [];
  if (validator(value)) return [];
  // Never echo supplied values, which may contain credentials or injected text.
  return ['authorization.hitl: invalid bounded policy (scope, categories, expiry or unknown fields)'];
}
