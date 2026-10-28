// Preserve non-portable skill metadata across the portable boundary.
import { AGENT_SKILLS_SIDECAR_SCHEMA } from './agent-skills.js';
import type {
  AgentSkillDocument, AgentSkillProvenance, AgentSkillValidationProfile,
  AgentSkillSidecarV1, AgentSkillsStandardMetadata, AgentSkillResource,
} from './agent-skills.js';

export function createAgentSkillSidecar(
  document: AgentSkillDocument,
  provenance: AgentSkillProvenance,
  validationProfile: AgentSkillValidationProfile,
  trust: AgentSkillSidecarV1['trust'],
): AgentSkillSidecarV1 {
  return {
    $schema: AGENT_SKILLS_SIDECAR_SCHEMA,
    schemaVersion: 1,
    aiwg: structuredClone(document.aiwg),
    ...(document.providers ? { providers: structuredClone(document.providers) } : {}),
    provenance: structuredClone(provenance),
    validationProfile,
    trust: { ...trust },
  };
}

/**
 * Restore AIWG metadata omitted at a strict portability boundary. Portable
 * content remains authoritative for standard fields, body, and resources.
 */
export function restoreAgentSkillFromSidecar(
  standard: AgentSkillsStandardMetadata,
  body: string,
  resources: readonly AgentSkillResource[],
  sidecar: AgentSkillSidecarV1,
): AgentSkillDocument {
  return {
    standard: structuredClone(standard),
    body,
    resources: resources.map((resource) => ({ ...resource })),
    aiwg: structuredClone(sidecar.aiwg),
    ...(sidecar.providers ? { providers: structuredClone(sidecar.providers) } : {}),
    unknownFields: [],
  };
}
