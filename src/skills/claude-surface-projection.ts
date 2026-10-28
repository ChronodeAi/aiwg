// Describe filesystem skill discovery and shell interpolation on Claude surfaces.
import type { AgentSkillProjectionStatus } from './agent-skills.js';

export interface ClaudeSkillSurfaceProjection {
  provider: 'claude';
  surface: 'cli' | 'desktop-code' | 'cowork' | 'cloud';
  status: AgentSkillProjectionStatus;
  shellInterpolation?: AgentSkillProjectionStatus;
  reasons: string[];
}

/** Inspection only: account-enabled skills are a separate delivery mechanism. */
export function projectClaudeSkillSurfaces(body: string): ClaudeSkillSurfaceProjection[] {
  const shell = /!`[^`]+`/.test(body);
  return (['cli', 'desktop-code', 'cowork', 'cloud'] as const).map((surface) => {
    const local = surface === 'cli' || surface === 'desktop-code';
    const shellStatus = local ? 'native' : surface === 'cowork' ? 'degraded' : 'unsupported';
    return {
      provider: 'claude',
      surface,
      status: local ? 'native' : 'unsupported',
      ...(shell ? { shellInterpolation: shellStatus } : {}),
      reasons: [
        local
          ? 'Reads filesystem SKILL.md bundles from .claude/skills.'
          : 'Does not read local .claude/skills; requires skills enabled on the claude.ai account.',
        ...(shell ? [local
          ? '! shell interpolation is native; AIWG does not execute it during validation or deploy.'
          : surface === 'cowork'
            ? '! shell interpolation is degraded to a policy notice for account-enabled Cowork skills.'
            : '! shell interpolation from a local skill is unsupported on cloud.'] : []),
      ],
    };
  });
}
