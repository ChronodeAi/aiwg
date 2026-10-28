/**
 * Managed Agent Skills provider deployment.
 *
 * Imported source trees remain immutable. Provider surfaces receive an atomic,
 * strict Agent Skills projection plus ownership metadata outside SKILL.md.
 *
 * @implements #1879
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Platform } from '../agents/types.js';
import { normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import { AGENT_SKILLS_SIDECAR_SCHEMA } from './agent-skills.js';
import { getImportedAgentSkill } from './importer.js';
import type {
  AgentSkillDeploymentOptions, AgentSkillDeploymentOutcome,
  AgentSkillDeploymentResult, AgentSkillImportResult,
} from './types.js';
import { resolvePolicy } from './deployment-policy.js';
import { projectionDocument, providerSkillBytes, sidecarBytes } from './deployment-projection.js';
import {
  AGENT_SKILL_MANAGED_MARKER, AGENT_SKILL_DEPLOYMENT_SIDECAR, MARKER_CONTENT,
  assertPortableName, fail,
  type DesiredEntry, type DesiredDirectory, type DesiredFile,
  type DeploymentSidecar, type ProjectionPlan, type AgentSkillProjectionInspection,
} from './deployment-types.js';
export {
  AGENT_SKILL_MANAGED_MARKER, AGENT_SKILL_DEPLOYMENT_SIDECAR,
  AgentSkillDeploymentError, type AgentSkillProjectionInspection,
} from './deployment-types.js';

function readDeploymentSidecar(
  targetPath: string,
  expectedName?: string,
  expectedProvider?: Platform,
): DeploymentSidecar | undefined {
  try {
    const sidecarPath = path.join(targetPath, AGENT_SKILL_DEPLOYMENT_SIDECAR);
    const stat = fs.lstatSync(sidecarPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const value = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as DeploymentSidecar;
    if (
      value.schemaVersion !== 1
      || value.kind !== 'aiwg-managed-agent-skill-projection'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)
      || !normalizeProviderDefinitionId(value.provider)
      || !/^[0-9a-f]{64}$/.test(value.sourceDigest)
      || !['native', 'projected', 'degraded', 'unsupported'].includes(
        value.projectionStatus,
      )
      || !Array.isArray(value.reasons)
      || !value.reasons.every((item) => typeof item === 'string')
      || !Array.isArray(value.warnings)
      || !value.warnings.every((item) => typeof item === 'string')
      || value.portable?.$schema !== AGENT_SKILLS_SIDECAR_SCHEMA
      || value.portable.schemaVersion !== 1
      || typeof value.portable.aiwg !== 'object'
      || value.portable.aiwg === null
      || Array.isArray(value.portable.aiwg)
      || value.portable.provenance?.sourceDigest !== value.sourceDigest
      || !['strict', 'compatible', 'discovery'].includes(
        value.portable.validationProfile,
      )
      || !['untrusted', 'trusted', 'revoked'].includes(
        value.portable.trust?.state,
      )
      || !['inactive', 'active', 'blocked'].includes(
        value.portable.trust?.activation,
      )
      || (expectedName !== undefined && value.name !== expectedName)
      || (expectedProvider !== undefined && value.provider !== expectedProvider)
      || path.basename(targetPath) !== value.name
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Codex, Antigravity, DeepSeek Harness, and Muse intentionally consume the
 * same portable project skill surface (<repo>/.agents/skills). A projection
 * written for any member is managed ownership for the others when the
 * desired payload is otherwise byte-identical.
 */
function providersShareProjectionSurface(
  actual: Platform,
  expected: Platform,
): boolean {
  const shared = new Set<Platform>(['antigravity', 'codex', 'deepseek-harness', 'muse']);
  return actual === expected || (shared.has(actual) && shared.has(expected));
}

function buildProjectionPlan(
  record: AgentSkillImportResult,
  options: AgentSkillDeploymentOptions,
): ProjectionPlan {
  const policy = resolvePolicy(options.target, options);
  const targetPath = path.join(policy.root, record.name);
  if (!policy.supported) {
    return {
      policy,
      targetPath,
      sourceDigest: record.digest,
      desiredEntries: [],
    };
  }

  const { document, sourceEntries } = projectionDocument(record);
  const original = sourceEntries.find((entry): entry is DesiredFile => (
    entry.kind === 'file' && entry.relativePath === 'SKILL.md'
  ));
  const skillBytes = providerSkillBytes(record, policy, document, original?.bytes);
  if (!skillBytes) {
    return {
      policy,
      targetPath,
      sourceDigest: record.digest,
      desiredEntries: [],
    };
  }
  const desiredEntries: DesiredEntry[] = sourceEntries
    .filter((entry) => entry.relativePath !== 'SKILL.md')
    .map((entry) => (
      entry.kind === 'directory'
        ? { ...entry }
        : { ...entry, bytes: Buffer.from(entry.bytes) }
    ));
  desiredEntries.push(
    { kind: 'file', relativePath: 'SKILL.md', bytes: skillBytes },
    {
      kind: 'file',
      relativePath: AGENT_SKILL_MANAGED_MARKER,
      bytes: Buffer.from(MARKER_CONTENT, 'utf8'),
    },
    {
      kind: 'file',
      relativePath: AGENT_SKILL_DEPLOYMENT_SIDECAR,
      bytes: sidecarBytes(record, policy, document),
    },
  );
  desiredEntries.sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
    || left.kind.localeCompare(right.kind)
  ));
  return {
    policy,
    targetPath,
    sourceDigest: record.digest,
    desiredEntries,
  };
}

function isManagedTarget(
  targetPath: string,
  expectedName?: string,
  expectedProvider?: Platform,
): boolean {
  if (!fs.existsSync(targetPath)) return false;
  try {
    const targetStat = fs.lstatSync(targetPath);
    const marker = path.join(targetPath, AGENT_SKILL_MANAGED_MARKER);
    const sidecar = readDeploymentSidecar(targetPath, expectedName);
    return (
      targetStat.isDirectory()
      && !targetStat.isSymbolicLink()
      && fs.lstatSync(marker).isFile()
      && !fs.lstatSync(marker).isSymbolicLink()
      && fs.readFileSync(marker, 'utf8') === MARKER_CONTENT
      && sidecar !== undefined
      && (expectedProvider === undefined
        || providersShareProjectionSurface(sidecar.provider, expectedProvider))
    );
  } catch {
    return false;
  }
}

function targetMatches(
  targetPath: string,
  desired: DesiredEntry[],
  name: string,
  provider: Platform,
): boolean {
  if (!isManagedTarget(targetPath, name, provider)) return false;
  const actual = new Map<string, 'directory' | Buffer>();
  const walk = (current: string, prefix: string): boolean => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        actual.set(relativePath, 'directory');
        if (!walk(absolutePath, relativePath)) return false;
      } else if (stat.isFile()) {
        actual.set(relativePath, fs.readFileSync(absolutePath));
      } else {
        return false;
      }
    }
    return true;
  };
  if (!walk(targetPath, '')) return false;
  if (actual.size !== desired.length) return false;
  return desired.every((entry) => {
    if (
      entry.kind === 'file'
      && entry.relativePath === AGENT_SKILL_DEPLOYMENT_SIDECAR
    ) {
      const sidecar = readDeploymentSidecar(targetPath, name);
      return sidecar !== undefined
        && providersShareProjectionSurface(sidecar.provider, provider)
        && sidecar.sourceDigest === JSON.parse(
          entry.bytes.toString('utf8'),
        ).sourceDigest;
    }
    const value = actual.get(entry.relativePath);
    return entry.kind === 'directory'
      ? value === 'directory'
      : Buffer.isBuffer(value) && value.equals(entry.bytes);
  });
}

function writeDesiredTree(root: string, desired: DesiredEntry[]): void {
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  for (const entry of desired.filter(
    (item): item is DesiredDirectory => item.kind === 'directory',
  ).sort((left, right) => (
    left.relativePath.split('/').length - right.relativePath.split('/').length
    || left.relativePath.localeCompare(right.relativePath)
  ))) {
    fs.mkdirSync(path.join(root, ...entry.relativePath.split('/')), {
      recursive: true,
      mode: 0o700,
    });
  }
  for (const entry of desired.filter(
    (item): item is DesiredFile => item.kind === 'file',
  ).sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const target = path.join(root, ...entry.relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.bytes, { flag: 'wx', mode: 0o600 });
  }
}

function promoteAtomically(
  name: string,
  plan: ProjectionPlan,
): AgentSkillDeploymentOutcome {
  const parent = path.dirname(plan.targetPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const suffix = randomUUID();
  const staging = path.join(parent, `.${path.basename(plan.targetPath)}.staging-${suffix}`);
  const backup = path.join(parent, `.${path.basename(plan.targetPath)}.backup-${suffix}`);
  const existed = fs.existsSync(plan.targetPath);
  try {
    writeDesiredTree(staging, plan.desiredEntries);
    if (existed) {
      if (!isManagedTarget(plan.targetPath, name, plan.policy.provider)) {
        fail(
          'AS_DEPLOY_COLLISION_RACE',
          'deployment target ownership changed before atomic promotion',
        );
      }
      fs.renameSync(plan.targetPath, backup);
    }
    try {
      fs.renameSync(staging, plan.targetPath);
    } catch (error) {
      if (fs.existsSync(plan.targetPath)) {
        fs.rmSync(plan.targetPath, { recursive: true, force: true });
      }
      if (fs.existsSync(backup)) fs.renameSync(backup, plan.targetPath);
      throw error;
    }
    if (fs.existsSync(backup)) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        fs.rmSync(plan.targetPath, { recursive: true, force: true });
        fs.renameSync(backup, plan.targetPath);
        throw error;
      }
    }
    return existed ? 'updated' : 'deployed';
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(backup) && !fs.existsSync(plan.targetPath)) {
      fs.renameSync(backup, plan.targetPath);
    }
  }
}

function result(
  operation: AgentSkillDeploymentResult['operation'],
  outcome: AgentSkillDeploymentOutcome,
  dryRun: boolean,
  name: string,
  plan: ProjectionPlan,
): AgentSkillDeploymentResult {
  return {
    schemaVersion: 1,
    operation,
    outcome,
    dryRun,
    name,
    provider: plan.policy.provider,
    projectionStatus: plan.policy.status,
    path: plan.targetPath,
    reasons: [...plan.policy.reasons],
    warnings: [...plan.policy.warnings],
    sourceDigest: plan.sourceDigest,
  };
}

function requireDeployableImport(
  name: string,
  projectDir: string,
): AgentSkillImportResult {
  const record = getImportedAgentSkill(projectDir, name);
  if (!record) {
    fail('AS_DEPLOY_IMPORT_MISSING', `managed Agent Skill "${name}" is not imported`);
  }
  if (
    record.trust.state !== 'trusted'
    || record.trust.activation !== 'active'
  ) {
    fail(
      'AS_DEPLOY_IMPORT_INACTIVE',
      `managed Agent Skill "${name}" is ${record.trust.state}/${record.trust.activation}`,
    );
  }
  if (record.diagnostics.some((item) => item.code === 'AS_IMPORT_MANAGED_DRIFT')) {
    fail(
      'AS_DEPLOY_IMPORT_DRIFT',
      `managed Agent Skill "${name}" no longer matches digest ${record.digest}`,
    );
  }
  return record;
}

export function deployImportedAgentSkill(
  name: string,
  options: AgentSkillDeploymentOptions,
): AgentSkillDeploymentResult {
  assertPortableName(name);
  const projectDir = path.resolve(options.projectDir);
  const record = requireDeployableImport(name, projectDir);
  const plan = buildProjectionPlan(record, { ...options, projectDir });
  const dryRun = options.dryRun ?? false;
  if (!plan.policy.supported) {
    return result('deploy', 'blocked', dryRun, name, plan);
  }
  if (
    fs.existsSync(plan.targetPath)
    && !isManagedTarget(plan.targetPath, name, plan.policy.provider)
  ) {
    plan.policy.status = 'degraded';
    plan.policy.reasons.push('target collision is not owned by AIWG');
    plan.policy.warnings.push('the existing user-owned target was not modified');
    return result('deploy', 'blocked', dryRun, name, plan);
  }
  if (targetMatches(
    plan.targetPath,
    plan.desiredEntries,
    name,
    plan.policy.provider,
  )) {
    return result('deploy', 'unchanged', dryRun, name, plan);
  }
  if (dryRun) return result('deploy', 'planned', true, name, plan);
  return result('deploy', promoteAtomically(name, plan), false, name, plan);
}

export function uninstallImportedAgentSkill(
  name: string,
  options: AgentSkillDeploymentOptions,
): AgentSkillDeploymentResult {
  assertPortableName(name);
  const projectDir = path.resolve(options.projectDir);
  const record = getImportedAgentSkill(projectDir, name);
  const policy = resolvePolicy(options.target, { ...options, projectDir });
  const plan: ProjectionPlan = {
    policy,
    targetPath: path.join(policy.root, name),
    sourceDigest: record?.digest ?? '',
    desiredEntries: [],
  };
  const deployedSidecar = readDeploymentSidecar(
    plan.targetPath,
    name,
    policy.provider,
  );
  if (deployedSidecar) {
    plan.sourceDigest = deployedSidecar.sourceDigest;
  }
  const dryRun = options.dryRun ?? false;
  if (!fs.existsSync(plan.targetPath)) {
    return result('uninstall', 'absent', dryRun, name, plan);
  }
  if (!isManagedTarget(plan.targetPath, name, plan.policy.provider)) {
    plan.policy.status = 'degraded';
    plan.policy.reasons.push('target collision is not owned by AIWG');
    plan.policy.warnings.push('the existing user-owned target was not removed');
    return result('uninstall', 'blocked', dryRun, name, plan);
  }
  if (dryRun) return result('uninstall', 'planned', true, name, plan);
  fs.rmSync(plan.targetPath, { recursive: true, force: true });
  return result('uninstall', 'removed', false, name, plan);
}

export function inspectImportedAgentSkillProjection(
  name: string,
  options: AgentSkillDeploymentOptions,
): AgentSkillProjectionInspection {
  assertPortableName(name);
  const projectDir = path.resolve(options.projectDir);
  const record = getImportedAgentSkill(projectDir, name);
  if (!record) {
    fail('AS_DEPLOY_IMPORT_MISSING', `managed Agent Skill "${name}" is not imported`);
  }
  const plan = buildProjectionPlan(record, { ...options, projectDir, dryRun: true });
  const exists = fs.existsSync(plan.targetPath);
  const managed = exists && isManagedTarget(
    plan.targetPath,
    name,
    plan.policy.provider,
  );
  return {
    provider: plan.policy.provider,
    projectionStatus: plan.policy.status,
    path: plan.targetPath,
    sourceDigest: plan.sourceDigest,
    supported: plan.policy.supported,
    exists,
    managed,
    matches: (
      plan.policy.supported
      && managed
      && targetMatches(
        plan.targetPath,
        plan.desiredEntries,
        name,
        plan.policy.provider,
      )
    ),
    reasons: [...plan.policy.reasons],
    warnings: [...plan.policy.warnings],
  };
}
