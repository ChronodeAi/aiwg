// Transform AIWG skill instructions and metadata for Codex deployment.
import fs from 'node:fs';
import path from 'node:path';
import { skillMatchesProvider } from '../agents/providers/base.mjs';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

export function stripWrappingQuotes(value) {
  const trimmed = String(value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function yamlDoubleQuoted(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function codexDisplayName(skillName) {
  const acronyms = new Map([
    ['aiwg', 'AIWG'],
    ['dfir', 'DFIR'],
    ['sdlc', 'SDLC'],
    ['mcp', 'MCP'],
    ['pr', 'PR'],
  ]);

  return String(skillName)
    .split('-')
    .filter(Boolean)
    .map((part) => acronyms.get(part.toLowerCase()) || part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function codexOpenAiMetadata(skill) {
  return `interface:
  display_name: "${yamlDoubleQuoted(codexDisplayName(skill.name))}"
  short_description: "${yamlDoubleQuoted(skill.description)}"
`;
}

function resolveSkillModelPolicy(frontmatter) {
  const block = frontmatter.match(/^commandHint:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] || '';
  const hint = {};
  for (const line of block.split('\n')) {
    const match = line.trim().match(/^(model|modelRole|modelTier|modelEffort|modelRationale):\s*(.+)$/);
    if (match) hint[match[1]] = stripWrappingQuotes(match[2]);
  }
  const legacy = String(hint.model || '').toLowerCase();
  const role = hint.modelRole || (legacy === 'opus' ? 'reasoning'
    : legacy === 'haiku' ? 'efficiency' : legacy ? 'coding' : null);
  if (!role) return null;
  return {
    role,
    tier: hint.modelTier || (role === 'reasoning' ? 'premium'
      : role === 'efficiency' ? 'economy' : 'standard'),
    effort: hint.modelEffort,
    rationale: hint.modelRationale,
  };
}

/**
 * Parse AIWG SKILL.md - handles both frontmatter and non-frontmatter formats
 */
function parseSkillContent(content, skillName) {
  // Try YAML frontmatter format first
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const [, frontmatter, body] = fmMatch;
    const metadata = {};

    // Parse YAML-like frontmatter
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        metadata[key] = stripWrappingQuotes(value);
      }
    }

    return { metadata, body, modelPolicy: resolveSkillModelPolicy(frontmatter) };
  }

  // Fallback: Parse non-frontmatter format (# skill-name header)
  const lines = content.split('\n');
  let name = skillName;
  let description = '';
  let bodyStartIdx = 0;

  // Look for # header as name
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('# ')) {
      name = line.slice(2).trim();
      bodyStartIdx = i + 1;
      break;
    }
  }

  // Look for first paragraph as description (skip empty lines)
  for (let i = bodyStartIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line &&
      !line.endsWith(':') &&
      !line.startsWith('#') &&
      !line.startsWith('-') &&
      !line.startsWith('|')
    ) {
      description = line;
      break;
    }
  }

  // If description is too short, try next paragraph
  if (description.length < 20) {
    for (let i = bodyStartIdx; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('## ') && line.toLowerCase().includes('purpose')) {
        // Look for content after ## Purpose
        for (let j = i + 1; j < lines.length && j < i + 10; j++) {
          const purposeLine = lines[j].trim();
          if (purposeLine && !purposeLine.startsWith('#') && !purposeLine.startsWith('-')) {
            description = purposeLine;
            break;
          }
        }
        break;
      }
    }
  }

  return {
    metadata: { name, description },
    body: content
  };
}

/**
 * Transform AIWG skill to Codex format
 */
export function transformToCodexSkill(skillDir) {
  const skillPath = path.join(skillDir, 'SKILL.md');
  const skillName = path.basename(skillDir);
  const content = fs.readFileSync(skillPath, 'utf8');

  // Platform filtering: skip skills with explicit restrictions that exclude codex.
  // Skills using platforms: [all] (the standard token) always pass this check.
  if (!skillMatchesProvider(content, 'codex')) {
    return null;
  }

  const parsed = parseSkillContent(content, skillName);

  if (!parsed) {
    console.warn(`Warning: Could not parse ${skillPath}`);
    return null;
  }

  const { metadata, body, modelPolicy } = parsed;

  // Validate and truncate
  const name = (metadata.name || path.basename(skillDir)).slice(0, MAX_NAME_LENGTH);
  let description = metadata.description || '';

  // Codex REQUIRES a non-empty description — it rejects SKILL.md files that
  // lack one. Fail loudly rather than silently writing `description: ""`
  // (the exact regression this guard defends against).
  if (!description || !String(description).trim()) {
    console.error(
      `ERROR: Skill '${name}' has empty/missing description in source ${skillPath}`
    );
    console.error(
      `       Codex rejects SKILL.md files without a description field.`
    );
    console.error(
      `       Fix the source file: add a non-empty 'description:' to the frontmatter.`
    );
    return null;
  }

  // Truncate description to 500 chars, ending at word boundary
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH - 3);
    const lastSpace = description.lastIndexOf(' ');
    if (lastSpace > MAX_DESCRIPTION_LENGTH - 50) {
      description = description.slice(0, lastSpace);
    }
    description += '...';
  }

  // Final guard: never emit `description: ""` under any circumstance.
  const quotedDescription = yamlDoubleQuoted(description);
  if (!quotedDescription || !quotedDescription.trim()) {
    console.error(
      `ERROR: Skill '${name}' description collapsed to empty after normalization (source: ${skillPath})`
    );
    return null;
  }

  // Build Codex skill format — include platforms: [codex] so deployed skills are self-describing
  const codexContent = `---
name: "${yamlDoubleQuoted(name)}"
description: "${quotedDescription}"
platforms: [codex]
---

${modelPolicy
    ? `<!-- aiwg:model-policy role=${modelPolicy.role} tier=${modelPolicy.tier}${modelPolicy.effort ? ` effort=${modelPolicy.effort}` : ''} outcome=unsupported${modelPolicy.rationale ? ` rationale=${yamlDoubleQuoted(modelPolicy.rationale)}` : ''} -->\n\n`
    : ''}${body.trim()}
`;

  return {
    name,
    description,
    content: codexContent,
    metadataContent: codexOpenAiMetadata({ name, description }),
    sourcePath: skillPath,
    modelPolicy,
  };
}

