import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { GateBinding, GatePack, GateReport } from './types.js';

export class GateSchemaError extends Error {
  constructor(message: string, readonly errors: ErrorObject[] = []) {
    super(message);
    this.name = 'GateSchemaError';
  }
}

const schemaFiles = {
  GatePack: 'GatePack.v1alpha1.schema.json',
  GateBinding: 'GateBinding.v1alpha1.schema.json',
  GateReport: 'GateReport.v1alpha1.schema.json',
} as const;

export type GateDocumentKind = keyof typeof schemaFiles;

let validators: Map<string, ValidateFunction> | null = null;

function schemaRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../schemas/gates'), resolve(here, '../../../schemas/gates')];
  const found = candidates.find(candidate => existsSync(resolve(candidate, schemaFiles.GatePack)));
  if (!found) throw new GateSchemaError('Gate schema directory is unavailable');
  return found;
}

function getValidators(): Map<string, ValidateFunction> {
  if (validators) return validators;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
  validators = new Map();
  for (const [kind, filename] of Object.entries(schemaFiles) as Array<[GateDocumentKind, string]>) {
    const schema = JSON.parse(readFileSync(resolve(schemaRoot(), filename), 'utf8')) as Record<string, unknown>;
    validators.set(`gates.aiwg.io/v1alpha1:${kind}`, ajv.compile(schema));
  }
  return validators;
}

const message = (errors: ErrorObject[] | null | undefined): string =>
  errors?.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ') ?? 'unknown schema error';

/** Closed-schema validation for a gates document. Returns the document unchanged when valid. */
export function validateGateDocument<T extends GatePack | GateBinding | GateReport>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GateSchemaError('Gate document must be an object');
  }
  const kind = (value as { kind?: string }).kind as GateDocumentKind | undefined;
  const version = (value as { apiVersion?: string }).apiVersion;
  const key = `${version}:${kind}`;
  const validate = kind ? getValidators().get(key) : undefined;
  if (!validate) throw new GateSchemaError(`Unsupported gate kind/version '${key}'`);
  if (!validate(value)) throw new GateSchemaError(`${kind} schema validation failed: ${message(validate.errors)}`, validate.errors ?? []);
  return value as T;
}
