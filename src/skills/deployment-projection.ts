// Project immutable managed sources into provider frontmatter and sidecars.
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { createAgentSkillSidecar, projectStrictAgentSkill, type AgentSkillDocument } from './agent-skills.js';
import { agentSkillDocument, claudeSkillExtensions } from './provider-extensions.js';
import type { AgentSkillImportResult } from './types.js';
import { validateAgentSkillContent } from './validator.js';
import {
  AGENT_SKILL_MANAGED_MARKER, AGENT_SKILL_DEPLOYMENT_SIDECAR, fail,
  type DesiredEntry, type DesiredFile, type ProjectionPolicy,
} from './deployment-types.js';

function assertSafeSourceEntry(
  sourceRoot: string,
  absolutePath: string,
  relativePath: string,
): fs.Stats {
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    fail('AS_DEPLOY_SOURCE_SYMLINK', `managed source contains a symlink: ${relativePath}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    fail(
      'AS_DEPLOY_SOURCE_SPECIAL_FILE',
      `managed source contains a non-regular entry: ${relativePath}`,
    );
  }
  const real = fs.realpathSync.native(absolutePath);
  const relativeReal = path.relative(fs.realpathSync.native(sourceRoot), real);
  if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
    fail('AS_DEPLOY_SOURCE_ESCAPE', `managed source entry escapes its root: ${relativePath}`);
  }
  return stat;
}

function collectSourceEntries(sourceRoot: string): DesiredEntry[] {
  const entries: DesiredEntry[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        relativePath === AGENT_SKILL_MANAGED_MARKER
        || relativePath === AGENT_SKILL_DEPLOYMENT_SIDECAR
      ) {
        fail(
          'AS_DEPLOY_RESERVED_PATH',
          `managed source uses reserved deployment path "${relativePath}"`,
        );
      }
      const absolutePath = path.join(current, entry.name);
      const stat = assertSafeSourceEntry(sourceRoot, absolutePath, relativePath);
      if (stat.isDirectory()) {
        entries.push({ kind: 'directory', relativePath });
        walk(absolutePath, relativePath);
      } else {
        entries.push({
          kind: 'file',
          relativePath,
          bytes: fs.readFileSync(absolutePath),
        });
      }
    }
  };
  walk(sourceRoot, '');
  return entries;
}

export function projectionDocument(
  record: AgentSkillImportResult,
): {
  document: AgentSkillDocument;
  sourceEntries: DesiredEntry[];
} {
  const sourceEntries = collectSourceEntries(record.managedLocation);
  const skillFile = sourceEntries.find((entry): entry is DesiredFile => (
    entry.kind === 'file' && entry.relativePath === 'SKILL.md'
  ));
  if (!skillFile) {
    fail('AS_DEPLOY_SKILL_MISSING', 'managed source does not contain SKILL.md');
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(skillFile.bytes);
  const validation = validateAgentSkillContent(content, {
    profile: record.validationProfile,
    file: path.join(record.managedLocation, 'SKILL.md'),
    directoryName: record.name,
    skillRoot: record.managedLocation,
    checkResources: true,
  });
  if (!validation.valid || !validation.frontmatter) {
    fail(
      'AS_DEPLOY_SOURCE_INVALID',
      `managed source for "${record.name}" no longer passes ${record.validationProfile} validation`,
    );
  }

  return {
    document: agentSkillDocument(validation.frontmatter, validation.body),
    sourceEntries,
  };
}

export function providerSkillBytes(
  record: AgentSkillImportResult,
  policy: ProjectionPolicy,
  document: AgentSkillDocument,
  originalBytes?: Buffer,
): Buffer | undefined {
  const metadata: Record<string, unknown> & { description: string } = { ...projectStrictAgentSkill(document) };
  const extensions = claudeSkillExtensions(document);
  if (policy.provider === 'claude') {
    Object.assign(metadata, extensions);
  } else {
    for (const field of Object.keys(extensions).sort()) {
      const warning = `Claude skill field "${field}" is dropped for provider "${policy.provider}"; retained in providers.claude sidecar only`;
      policy.warnings.push(warning);
      policy.reasons.push(warning);
      policy.status = 'degraded';
    }
  }
  if (policy.appendToDescription) {
    const suffix = policy.appendToDescription;
    if (!metadata.description.endsWith(suffix)) {
      metadata.description = `${metadata.description.trimEnd()} ${suffix}`;
    }
  }
  if (
    policy.maxDescriptionLength !== undefined
    && metadata.description.length > policy.maxDescriptionLength
  ) {
    policy.status = 'degraded';
    policy.supported = false;
    policy.reasons.push(
      `description length ${metadata.description.length} exceeds the provider limit ${policy.maxDescriptionLength}; no truncation was applied`,
    );
    return undefined;
  }

  const frontmatter = stringify(metadata, {
    lineWidth: 0,
    sortMapEntries: false,
  }).trimEnd();
  const content = `---\n${frontmatter}\n---\n${document.body}`;
  const validation = validateAgentSkillContent(content, {
    profile: policy.provider === 'claude' ? 'compatible' : 'strict',
    file: 'SKILL.md',
    directoryName: record.name,
  });
  if (!validation.valid) {
    policy.status = 'degraded';
    policy.supported = false;
    policy.reasons.push(
      `provider projection failed validation: ${validation.diagnostics
        .filter((item) => item.severity === 'error')
        .map((item) => item.code)
        .join(', ')}`,
    );
    return undefined;
  }
  if (
    policy.provider === 'claude' && originalBytes
    && document.unknownFields.length === 0
    && Object.keys(document.aiwg).every((key) => Object.hasOwn(extensions, key))
  ) return Buffer.from(originalBytes);
  return Buffer.from(content, 'utf8');
}

export function sidecarBytes(
  record: AgentSkillImportResult,
  policy: ProjectionPolicy,
  document: AgentSkillDocument,
): Buffer {
  const portableSidecar = createAgentSkillSidecar(
    document,
    {
      sourceKind: record.source.kind,
      locator: record.source.locator,
      ...(record.source.kind === 'git'
        ? {
            requestedRevision: record.source.requestedRevision,
            resolvedRevision: record.source.resolvedRevision,
          }
        : {}),
      sourceDigest: record.digest,
      importedAt: record.importedAt,
      aiwgVersion: record.aiwgVersion,
    },
    record.validationProfile,
    record.trust,
  );
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'aiwg-managed-agent-skill-projection',
    name: record.name,
    provider: policy.provider,
    projectionStatus: policy.status,
    sourceDigest: record.digest,
    reasons: policy.reasons,
    warnings: policy.warnings,
    portable: portableSidecar,
  }, null, 2)}\n`, 'utf8');
}

