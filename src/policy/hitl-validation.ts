// Validates HITL with the existing config schema definitions, shared by loader and resolver.
import { createRequire } from 'node:module';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

function compiled(): ValidateFunction {
  const require = createRequire(import.meta.url);
  let schema;
  // Source and compiled modules share the shipped config schema; no cwd or home lookup.
  for (const relative of ['../../vscode-extension/schemas/aiwg.config.v1.json',
    '../../../vscode-extension/schemas/aiwg.config.v1.json']) {
    try { schema = require(relative); break; } catch (error: any) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  if (!schema) throw new Error('HITL config schema unavailable');
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
