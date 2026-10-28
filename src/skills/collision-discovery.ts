// Discover local skill owners and resolve name collisions without executing skills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { listProviderDefinitions } from '../providers/provider-definitions.js';
import {
  AGENT_SKILLS_BASELINE, AGENT_SKILL_COLLISION_PRECEDENCE,
  type AgentSkillCollisionOrigin, type AgentSkillDiagnostic,
} from './agent-skills.js';
import type { SkillDetails } from './types.js';
import { isManagedTarget } from './deployment-ownership.js';

export interface SkillDiscoveryOptions {
  projectDir: string;
  homeDir?: string;
}

export function localSkillRoots(options: SkillDiscoveryOptions): Map<string, AgentSkillCollisionOrigin> {
  const project = path.resolve(options.projectDir);
  const home = path.resolve(options.homeDir ?? os.homedir());
  const roots = new Map<string, AgentSkillCollisionOrigin>();
  for (const { skillNamespace: ns } of listProviderDefinitions()) {
    const base = ns.pathType === 'home-dir' ? home : project;
    roots.set(path.resolve(base, ns.skillsBaseDir), ns.pathType === 'home-dir' ? 'user' : 'project');
  }
  roots.set(path.join(project, '.agents', 'skills'), 'project');
  roots.set(path.join(project, '.claude', '.aiwg', 'skills'), 'project');
  roots.set(path.join(home, '.claude', 'skills'), 'user');
  roots.set(path.join(home, '.claude', 'skills', 'synced'), 'synced');
  return roots;
}

export function discoverLocalSkillOwners(options: SkillDiscoveryOptions): SkillDetails[] {
  const skills: SkillDetails[] = [];
  for (const [root, origin] of localSkillRoots(options)) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      const file = path.join(directory, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const content = fs.readFileSync(file, 'utf8');
        const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
        const metadata = match ? parse(match[1]) : {};
        const name = typeof metadata?.name === 'string' ? metadata.name : entry.name;
        // Synced ownership is determined by its account cache root, never a marker.
        const owner = origin !== 'synced' && isManagedTarget(directory, name)
          ? 'aiwg-managed' : origin;
        skills.push({
          name, description: typeof metadata?.description === 'string' ? metadata.description : `Skill: ${name}`,
          source: 'local', installed: true, origin: owner, path: file, content,
        });
      } catch { /* Unreadable or malformed skills cannot be selected. */ }
    }
  }
  return skills;
}

function rank(skill: { origin?: AgentSkillCollisionOrigin }): number {
  return skill.origin ? AGENT_SKILL_COLLISION_PRECEDENCE[skill.origin] : 0;
}

export function skillCollisionDiagnostic(
  name: string, winner: AgentSkillCollisionOrigin, loser: AgentSkillCollisionOrigin, file: string,
): AgentSkillDiagnostic {
  return {
    code: 'AS_SKILL_COLLISION', severity: 'warning', file, yamlPath: '$.name',
    message: `${winner}-owned skill "${name}" takes precedence over ${loser}-owned skill`,
    upstreamBaseline: AGENT_SKILLS_BASELINE.revision,
    remediation: 'Rename the skill or explicitly remove the higher-precedence collision.',
  };
}

export function selectSkillOwners<T extends {
  name: string; origin?: AgentSkillCollisionOrigin; path?: string; diagnostics?: AgentSkillDiagnostic[];
}>(skills: readonly T[]): T[] {
  const selected = new Map<string, T>();
  // Path breaks equal-origin ties independently of filesystem enumeration order.
  const sorted = [...skills].sort((a, b) => rank(b) - rank(a)
    || (a.path ?? '').localeCompare(b.path ?? '') || a.name.localeCompare(b.name));
  for (const skill of sorted) {
    const winner = selected.get(skill.name);
    if (!winner) {
      selected.set(skill.name, { ...skill, diagnostics: [...(skill.diagnostics ?? [])] });
    } else if (winner.origin && skill.origin) {
      winner.diagnostics!.push(skillCollisionDiagnostic(
        skill.name, winner.origin, skill.origin, skill.path ?? '',
      ));
      winner.diagnostics!.push(...(skill.diagnostics ?? []));
    }
  }
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function higherLocalSkillOwner(
  name: string, incoming: AgentSkillCollisionOrigin, options: SkillDiscoveryOptions,
): SkillDetails | undefined {
  return selectSkillOwners(discoverLocalSkillOwners(options)).find(skill =>
    skill.name === name && rank(skill) > AGENT_SKILL_COLLISION_PRECEDENCE[incoming]);
}
