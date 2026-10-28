// Shared observed-lineage validation for worker resolution and final review.
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerModelObservation, WorkerPolicyDiagnostic } from './types.js';

let catalogValidators: { catalog: ValidateFunction; observation: ValidateFunction; discovery: ValidateFunction } | undefined;
export function getCatalogValidators(): NonNullable<typeof catalogValidators> {
  if (!catalogValidators) {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = [resolve(here, '../../schemas/models/model-catalog.v1.schema.json'), resolve(here, '../../../schemas/models/model-catalog.v1.schema.json')].find(existsSync);
    if (!file) throw new Error('Model catalog schema is unavailable');
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
    ajv.addSchema(schema);
    catalogValidators = { catalog: ajv.getSchema(schema.$id)!, observation: ajv.compile({ $ref: `${schema.$id}#/$defs/workerObservation` }), discovery: ajv.compile({ $ref: `${schema.$id}#/properties/discovery` }) };
  }
  return catalogValidators;
}
export function validateWorkerModelObservation(input: unknown): string[] {
  const validate = getCatalogValidators().observation;
  return validate(input) ? [] : (validate.errors ?? []).map(error => `${error.instancePath}: ${error.message}`);
}
/** Optional catalog facts do not veto otherwise qualified selection. */
export function hasSelectionRelevantConflicts(observation: WorkerModelObservation): boolean {
  const relevant = /^\/(?:lifecycle|availability|visibility|hidden|efforts|effortSupport|reasoningEfforts|sunsetAt|retiredAt|replacementModelId|supersededBy|dataUse|id|apiModelId|llmProvider|cliId|family|runtimeVersion|accountScope|endpointFingerprint|identityEvidence|contextTokens|maxOutputTokens|qualification)(?:\/|$)/;
  return observation.conflicts?.some(conflict => relevant.test(conflict.field)) ?? false;
}

/** Same lineage rule for resolve and acceptance; CLI names never prove diversity. */
export function workerReviewLineageDiagnostics(input: {
  reviewOf?: WorkerModelObservation;
  requireDifferentFamily?: boolean;
  reviewer?: WorkerModelObservation;
}): WorkerPolicyDiagnostic[] {
  if (!input.requireDifferentFamily) return [];
  const diagnostics: WorkerPolicyDiagnostic[] = [];
  const deny = (pointer: string, message: string): void => {
    diagnostics.push({ code: 'OG_MODEL_UNAPPROVED', pointer, message });
  };
  const unambiguous = (observation: WorkerModelObservation | undefined): observation is WorkerModelObservation =>
    !!observation && validateWorkerModelObservation(observation).length === 0
    && !hasSelectionRelevantConflicts(observation) && !!observation.family && observation.family !== 'unknown';
  if (!unambiguous(input.reviewOf)) {
    deny('/request/reviewOf', 'Required review needs unambiguous observed source lineage');
  }
  // Omission here is intentional during resolver preflight. Acceptance explicitly
  // requires a reviewer before calling this shared predicate.
  if (input.reviewer !== undefined) {
    if (!unambiguous(input.reviewer)) {
      deny('/worker/family', 'Required review needs unambiguous observed reviewer lineage');
    } else if (input.reviewer.family === input.reviewOf?.family) {
      deny('/worker/family', 'Required review must use a different observed family');
    }
  }
  return diagnostics;
}
