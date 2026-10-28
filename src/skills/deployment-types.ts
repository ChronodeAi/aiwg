// Share managed deployment contracts, ownership markers, and errors.
import type { Platform } from '../agents/types.js';
import type { AgentSkillProjectionStatus, AgentSkillSidecarV1 } from './agent-skills.js';

export const AGENT_SKILL_MANAGED_MARKER = '.aiwg-managed';
export const AGENT_SKILL_DEPLOYMENT_SIDECAR = '.aiwg-agent-skill.json';

export const MARKER_CONTENT = 'aiwg-agent-skill-v1\n';
export interface DesiredDirectory {
  kind: 'directory';
  relativePath: string;
}

export interface DesiredFile {
  kind: 'file';
  relativePath: string;
  bytes: Buffer;
}

export type DesiredEntry = DesiredDirectory | DesiredFile;

export interface ProjectionPolicy {
  provider: Platform;
  root: string;
  status: AgentSkillProjectionStatus;
  supported: boolean;
  reasons: string[];
  warnings: string[];
  appendToDescription?: string;
  maxDescriptionLength?: number;
}

export interface ProjectionPlan {
  policy: ProjectionPolicy;
  targetPath: string;
  sourceDigest: string;
  desiredEntries: DesiredEntry[];
}

export interface DeploymentSidecar {
  schemaVersion: 1;
  kind: 'aiwg-managed-agent-skill-projection';
  name: string;
  provider: Platform;
  projectionStatus: AgentSkillProjectionStatus;
  sourceDigest: string;
  reasons: string[];
  warnings: string[];
  portable: AgentSkillSidecarV1;
}

export interface AgentSkillProjectionInspection {
  provider: Platform;
  projectionStatus: AgentSkillProjectionStatus;
  path: string;
  sourceDigest: string;
  supported: boolean;
  exists: boolean;
  managed: boolean;
  matches: boolean;
  reasons: string[];
  warnings: string[];
}

export class AgentSkillDeploymentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSkillDeploymentError';
  }
}

export function fail(code: string, message: string): never {
  throw new AgentSkillDeploymentError(code, message);
}

export function assertPortableName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    fail(
      'AS_DEPLOY_NAME',
      'Agent Skill name must be 1-64 lowercase ASCII letters, numbers, or single hyphens',
    );
  }
}

