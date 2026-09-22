import type { DecisionDefinition } from './types.js';
import { DECISION_API_VERSION, DECISION_API_VERSION_STRUCTURED } from './types.js';
import { artifactPin, DecisionValidationError, validateDefinition } from './validate.js';

/** Explicit version upgrade: preserves authored strings while assigning a new artifact digest. */
export function convertDecisionDefinitionV1Alpha1(source: DecisionDefinition): {
  definition: DecisionDefinition;
  previousDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
} {
  if (source.apiVersion !== DECISION_API_VERSION) throw new DecisionValidationError('Conversion requires a v1alpha1 DecisionDefinition');
  validateDefinition(source);
  const previousDigest = artifactPin(source).digest;
  const definition: DecisionDefinition = structuredClone(source);
  definition.apiVersion = DECISION_API_VERSION_STRUCTURED;
  validateDefinition(definition);
  return { definition, previousDigest, digest: artifactPin(definition).digest };
}
