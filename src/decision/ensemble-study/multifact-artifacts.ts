import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { admitEntry, DEFAULT_ENTRY_LIMITS } from '../entry.js';

/** Closed D17-MF artifact schemas (`schemas/decision/D17Multifact.v1.schema.json`), one validator per definition. */
const here = dirname(fileURLToPath(import.meta.url));
const file = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
  .map(directory => resolve(directory, 'D17Multifact.v1.schema.json')).find(existsSync);
if (!file) throw new Error('D17-MF schema is unavailable');
const schema = JSON.parse(readFileSync(file, 'utf8'));
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
ajv.addSchema(schema);
const KINDS = ['analysis', 'reviewTemplate', 'review', 'report', 'audit'] as const;
const validators = Object.fromEntries(KINDS.map(kind => [kind, ajv.getSchema(`${schema.$id}#/$defs/${kind}`)!])) as Record<typeof KINDS[number], ValidateFunction>;
const limits = { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 16_777_216, properties: 500_000, entries: 1_000_000, arrayLength: 20_000, memoryBytes: 67_108_864 };
export function validateD17MultifactArtifact(kind: typeof KINDS[number], value: unknown): void {
  admitEntry(value, limits);
  if (!validators[kind](value)) throw new Error(`D17-MF invalid ${kind} artifact`);
}
