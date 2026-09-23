import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  getProviderDefinition,
  listProviderDefinitions,
  normalizeProviderDefinitionId,
  validateProviderDefinitionRegistry,
} from '../../../src/providers/provider-definitions.js';

const CURRENT_PLATFORM_IDS = [
  'antigravity',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'deepseek-harness',
  'factory',
  'hermes',
  'opencode',
  'openclaw',
  'openhuman',
  'pi',
  'omp',
  'warp',
  'windsurf',
  'dsh',
  'generic',
];

describe('provider definition registry', () => {
  it('has a valid definition for every current Platform value', () => {
    const definitions = validateProviderDefinitionRegistry();

    expect(definitions.map((definition) => definition.id)).toEqual(CURRENT_PLATFORM_IDS);
    for (const definition of definitions) {
      expect(definition.displayName).toBeTruthy();
      expect(definition.paths.artifacts).toHaveProperty('agents');
      expect(definition.paths.artifacts).toHaveProperty('commands');
      expect(definition.paths.artifacts).toHaveProperty('skills');
      expect(definition.paths.artifacts).toHaveProperty('rules');
      expect(definition.paths.artifacts).toHaveProperty('behaviors');
      expect(definition.paths.contextDiscovery).toHaveProperty('agents');
      expect(definition.paths.contextDiscovery).toHaveProperty('skills');
      expect(definition.paths.contextDiscovery).toHaveProperty('rules');
      expect(definition.paths.contextDiscovery).toHaveProperty('behaviors');
      expect(definition.adapters.agentFormat).toBeTruthy();
    }
  });

  it('normalizes existing provider aliases through definition data', () => {
    expect(normalizeProviderDefinitionId('claude-code')).toBe('claude');
    expect(normalizeProviderDefinitionId('openai')).toBe('codex');
    expect(normalizeProviderDefinitionId('tinyhumansai')).toBe('openhuman');
    expect(normalizeProviderDefinitionId('devin')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-desktop')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-local')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('cascade')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('pi-coding-agent')).toBe('pi');
    expect(normalizeProviderDefinitionId('dsh')).toBe('dsh');
    expect(normalizeProviderDefinitionId('missing-provider')).toBeNull();
  });

  it('keeps fork and upstream deployment routes distinct in isolated real dry-runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-dsh-route-'));
    const home = join(root, 'home');
    mkdirSync(home);
    const projectRoot = resolve(import.meta.dirname, '../../..');
    try {
      for (const selector of ['dsh', 'deepseek', 'deepseek-harness']) {
        const target = join(root, selector);
        mkdirSync(target);
        const result = spawnSync(process.execPath, [
          join(projectRoot, 'tools/agents/deploy-agents.mjs'),
          '--provider', selector, '--dry-run', '--target', target,
        ], {
          cwd: target,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            DSH_HOME: join(home, '.dsh'),
            DSH_AGENTS_HOME: join(home, '.agents'),
            HERMES_HOME: join(home, '.hermes'),
            AIWG_ROOT: projectRoot,
          },
          encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        if (selector === 'deepseek-harness') {
          expect(result.stdout).toContain('Loaded provider: deepseek-harness');
          expect(result.stdout).toContain('.dsh/aiwg.cordis.patch.yml');
          expect(result.stdout).not.toContain('deploy preset');
        } else {
          expect(result.stdout).toContain('Loaded provider: dsh');
          expect(result.stdout.match(/\[dry-run\] deploy preset /g)).toHaveLength(3);
          expect(result.stdout).toContain(join(home, '.dsh/.agent-presets'));
          expect(result.stdout).toContain('.dsh/.aiwg/skills');
          expect(result.stdout).not.toContain('aiwg.cordis.patch.yml');
        }
        expect(readdirSync(target)).toEqual([]);
        expect(readdirSync(home)).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('models Pi native resources without claiming unimplemented bridges', () => {
    const pi = getProviderDefinition('pi');
    expect(pi).toBeDefined();
    expect(pi?.status).toBe('experimental');
    expect(pi?.detection).toMatchObject({ env: [], process: ['pi'], capabilityId: 'pi' });
    expect(pi?.paths.kernelSkills).toBe('.agents/skills');
    expect(pi?.paths.artifacts.commands).toBe('.pi/prompts');
    expect(pi?.paths.artifacts.behaviors).toBe('.pi/extensions');
    expect(pi?.context.startupFiles).toEqual(['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']);
    expect(pi?.context.verification.source).toContain('79680533c6b898894f2d2421c7f640b212d3dfdd');
    expect(pi?.adapters.hookBridge).toBeNull();
    expect(pi?.adapters.mcpInjection).toBeNull();
  });

  it('keeps capability matrix references resolvable for all non-generic providers', () => {
    for (const definition of listProviderDefinitions()) {
      if (definition.id === 'generic') {
        expect(definition.capabilities.matrixRef).toBeNull();
        continue;
      }
      expect(definition.capabilities.matrixRef).toBeTruthy();
      expect(Object.keys(definition.capabilities.nativeFeatures)).toContain('mcp');
      expect(Object.keys(definition.capabilities.emulation)).toContain('mission_control');
    }
  });

  it('models the current no-behavior-change paths for representative providers', () => {
    expect(getProviderDefinition('claude')?.paths.kernelSkills).toBe('.claude/skills');
    expect(getProviderDefinition('codex')?.paths.kernelSkills).toBe('.agents/skills');
    expect(getProviderDefinition('openhuman')?.paths.deployTarget).toBe('mixed');
    expect(getProviderDefinition('openhuman')?.paths.kernelSkills).toBe('~/.openhuman/skills');
    expect(getProviderDefinition('windsurf')?.surfaces.precedence).toContain('.devin/rules/');
    expect(getProviderDefinition('windsurf')?.paths.artifacts.rules).toBe('.windsurf/rules');
    expect(getProviderDefinition('windsurf')?.paths.kernelSkills).toBe('.windsurf/skills');
  });

  it('records the Devin/Windsurf topology decision without enabling .devin writes', () => {
    const windsurf = getProviderDefinition('windsurf');
    expect(windsurf).toBeDefined();
    expect(windsurf?.displayName).toBe('Devin Desktop');
    expect(windsurf?.status).toBe('stable');
    expect(normalizeProviderDefinitionId('devin')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-desktop')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-cli')).toBeNull();

    const desktop = windsurf?.surfaces.related.find((surface) => surface.id === 'devin-desktop');
    expect(desktop?.relationship).toBe('same-provider');
    expect(desktop?.deployable).toBe(true);
    expect(windsurf?.aliases).toEqual(expect.arrayContaining(['devin', 'devin-desktop', 'devin-local', 'cascade']));
    expect(desktop?.paths.rules).toEqual(['.devin/rules/*.md', '.windsurf/rules/*.md']);
    expect(desktop?.paths.agentsMd).toEqual(['AGENTS.md', 'agents.md']);
    expect(desktop?.notes.join('\n')).toContain('AIWG keeps .devin/ as ignored local provider output');
    expect(windsurf?.surfaces.precedence).toEqual([
      '.devin/rules/',
      '.windsurf/rules/',
      'AGENTS.md',
      '.windsurfrules',
    ]);

    const cli = windsurf?.surfaces.related.find((surface) => surface.id === 'devin-cli');
    expect(cli?.relationship).toBe('future-provider');
    expect(cli?.deployable).toBe(false);
    expect(cli?.paths.rules).toContain('AGENTS.md');
    expect(cli?.paths.skills).toContain('.devin/skills/<skill-name>/SKILL.md');

    const productSkills = windsurf?.surfaces.related.find((surface) => surface.id === 'devin-product-skills');
    expect(productSkills?.relationship).toBe('companion-standard');
    expect(productSkills?.deployable).toBe(false);
    expect(productSkills?.paths.skills).toEqual(['.agents/skills/<skill-name>/SKILL.md']);
  });

  it('models smith-facing paths separately from deploy paths where legacy behavior differs', () => {
    expect(getProviderDefinition('copilot')?.paths.artifacts.commands).toBe('.github/commands');
    expect(getProviderDefinition('copilot')?.smithPaths.commands).toBe('.github/agents');
    expect(getProviderDefinition('opencode')?.paths.artifacts.agents).toBe('.opencode/agent');
    expect(getProviderDefinition('opencode')?.smithPaths.agents).toBeNull();
    expect(getProviderDefinition('openhuman')?.paths.artifacts.skills).toBe('~/.openhuman/.aiwg/skills');
    expect(getProviderDefinition('openhuman')?.smithPaths.skills).toBe('~/.openhuman/skills');
  });

  it('models context-discovery paths separately where regenerate differs from deploy paths', () => {
    expect(getProviderDefinition('codex')?.paths.artifacts.skills).toBe('.codex/.aiwg/skills');
    expect(getProviderDefinition('codex')?.paths.contextDiscovery.skills).toBe('.agents/skills');
    expect(getProviderDefinition('copilot')?.paths.artifacts.rules).toBe('.github/copilot-rules');
    expect(getProviderDefinition('copilot')?.paths.contextDiscovery.rules).toBe('.github/instructions');
    expect(getProviderDefinition('openhuman')?.paths.artifacts.agents).toBeNull();
    expect(getProviderDefinition('openhuman')?.paths.contextDiscovery.agents).toBe('.agents/agents');
  });

  it('models the DeepSeek Harness skills-only topology', () => {
    const dsh = getProviderDefinition('dsh');
    expect(dsh).toBeDefined();
    expect(dsh?.displayName).toBe('DeepSeek Harness');
    expect(normalizeProviderDefinitionId('deepseek')).toBe('dsh');
    expect(normalizeProviderDefinitionId('deepseek-harness')).toBe('deepseek-harness');
    expect(dsh?.aliases).toEqual(['deepseek']);
    const upstream = getProviderDefinition('deepseek-harness');
    expect(upstream?.id).toBe('deepseek-harness');
    expect(upstream?.aliases).toEqual([]);
    expect(upstream?.capabilities.matrixRef).toBe('deepseek-harness');
    expect(upstream?.capabilities.emulation.mission_control).toBe('aiwg-mc');
    expect(dsh?.capabilities.matrixRef).toBe('dsh');
    expect(dsh?.capabilities.emulation.mission_control).toBeNull();

    // Skills are the only directory-deployed artifact class: the kernel
    // inventory deploys flat to `.agents/skills/` (natively scanned by DSH's
    // skill provider) while the bulk payload lands in `.dsh/.aiwg/skills/`
    // (index-discoverable only, mirroring Codex's kernel pivot).
    expect(dsh?.paths.artifacts.skills).toBe('.dsh/.aiwg/skills');
    expect(dsh?.paths.kernelSkills).toBe('.agents/skills');
    expect(dsh?.paths.contextDiscovery.skills).toBe('.agents/skills');
    expect(dsh?.paths.artifacts.agents).toBeNull();
    expect(dsh?.paths.artifacts.commands).toBeNull();
    expect(dsh?.paths.artifacts.rules).toBeNull();

    // Context is AGENTS.md prose-directive over the canonical workspace graph
    // (WORKSPACE.md → AGENTS.md + AIWG.md), matching the codex context shape.
    expect(dsh?.context.loadMode).toBe('prose-directive');
    expect(dsh?.context.includeSyntax).toBeNull();
    expect(dsh?.context.bootstrapTargets).toEqual(['AGENTS.md']);
    expect(dsh?.context.support).toBe('supported');
    expect(dsh?.paths.contextFiles.aiwgMd).toBe(true);
    expect(dsh?.paths.contextFiles.agentsMd).toBe(true);
    expect(dsh?.paths.contextFiles.claudeMdHook).toBe(false);

    // MCP is native via cordis.yml plugin composition, not JSON injection.
    expect(dsh?.adapters.mcpInjection).toBeNull();
    expect(dsh?.adapters.contextAggregation).toBe('agents-md');
    expect(dsh?.capabilities.nativeFeatures.mcp).toBe(true);
    expect(dsh?.capabilities.nativeFeatures.agent_teams).toBe(true);
    expect(dsh?.skillNamespace.pathType).toBe('project');
    expect(dsh?.skillNamespace.skillsBaseDir).toBe('.agents/skills');
  });
});
