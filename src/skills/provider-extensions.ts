// Classify Claude-native fields separately from portable Agent Skills metadata.
import {
  AIWG_SKILL_CONTROL_FIELDS,
  STANDARD_SKILL_FIELDS,
  type AgentSkillDocument,
  type AgentSkillsStandardMetadata,
} from './agent-skills.js';

export const CLAUDE_SKILL_FIELDS = [
  'disable-model-invocation', 'user-invocable', 'disallowed-tools', 'context',
  'agent', 'background', 'model', 'effort', 'paths', 'shell', 'argument-hint',
  'arguments',
] as const;

export type ClaudeSkillField = (typeof CLAUDE_SKILL_FIELDS)[number];
export interface AgentSkillProviderExtensions {
  claude?: Partial<Record<ClaudeSkillField, unknown>>;
}

export function agentSkillDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): AgentSkillDocument {
  const standard = Object.fromEntries(STANDARD_SKILL_FIELDS
    .filter((key) => Object.hasOwn(frontmatter, key))
    .map((key) => [key, structuredClone(frontmatter[key])]));
  const aiwg = Object.fromEntries(AIWG_SKILL_CONTROL_FIELDS
    .filter((key) => Object.hasOwn(frontmatter, key))
    .map((key) => [key, structuredClone(frontmatter[key])]));
  const claude = Object.fromEntries(CLAUDE_SKILL_FIELDS
    .filter((key) => Object.hasOwn(frontmatter, key))
    .map((key) => [key, structuredClone(frontmatter[key])]));
  const known = new Set<string>([
    ...STANDARD_SKILL_FIELDS, ...AIWG_SKILL_CONTROL_FIELDS, ...CLAUDE_SKILL_FIELDS,
  ]);
  return {
    standard: standard as unknown as AgentSkillsStandardMetadata,
    aiwg,
    ...(Object.keys(claude).length ? { providers: { claude } } : {}),
    body,
    resources: [],
    unknownFields: Object.entries(frontmatter)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => ({ key, value: structuredClone(value) })),
  };
}

/** Older sidecars retained context/effort under aiwg; preserve that spelling. */
export function claudeSkillExtensions(document: AgentSkillDocument): Record<string, unknown> {
  return {
    ...Object.fromEntries(CLAUDE_SKILL_FIELDS
      .filter((key) => Object.hasOwn(document.aiwg, key))
      .map((key) => [key, structuredClone(document.aiwg[key as keyof typeof document.aiwg])])),
    ...structuredClone(document.providers?.claude ?? {}),
  };
}
