import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GROK_HOME_ENV,
  resolveGrokHome,
  resolveGrokHomeResult,
  grokBuildProjectPaths,
} from '../../../src/providers/grok-build-paths.js';
import { getProviderDefinition, normalizeProviderDefinitionId } from '../../../src/providers/provider-definitions.js';
import {
  deploySkills,
  resolveGrokHome as resolveFromWriter,
  createAgentsMd,
  paths as grokBuildPaths,
} from '../../../tools/agents/providers/grok-build.mjs';

const roots: string[] = [];
const repoRoot = resolve(__dirname, '../../..');

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env[GROK_HOME_ENV];
});

describe('grok-build path resolver', () => {
  it('defaults to ~/.grok when GROK_HOME unset', () => {
    delete process.env[GROK_HOME_ENV];
    const result = resolveGrokHomeResult();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('default');
      expect(result.path.endsWith('/.grok')).toBe(true);
    }
  });

  it('accepts absolute GROK_HOME', () => {
    process.env[GROK_HOME_ENV] = '/tmp/grok-home-abs';
    expect(resolveGrokHome()).toBe('/tmp/grok-home-abs');
  });

  it('rejects relative GROK_HOME overrides', () => {
    process.env[GROK_HOME_ENV] = 'relative/grok';
    expect(resolveGrokHomeResult().ok).toBe(false);
  });

  it('exposes verified project path shape', () => {
    const p = grokBuildProjectPaths();
    expect(p.skills).toBe('.grok/skills');
    expect(p.agents).toBe('.grok/agents');
    expect(p.config).toBe('.grok/config.toml');
  });
});

describe('grok-build provider definition', () => {
  it('registers experimental grok-build without bare grok alias and preserves grokbot', () => {
    expect(normalizeProviderDefinitionId('grok-build')).toBe('grok-build');
    expect(normalizeProviderDefinitionId('grok')).toBeNull();
    expect(normalizeProviderDefinitionId('grokbot')).toBe('grokbot');
    const def = getProviderDefinition('grok-build');
    expect(def?.displayName).toBe('Grok Build');
    expect(def?.status).toBe('experimental');
    expect(def?.aliases).toEqual([]);
    expect(def?.paths.artifacts.skills).toBe('.grok/skills');
    expect(def?.paths.kernelSkills).toBe('.grok/skills');
  });
});

describe('grok-build writer dry-run', () => {
  it('does not write and never targets .cursor or grokbot roots', () => {
    const project = temporaryRoot('aiwg-grok-build-project-');
    const result = deploySkills([], project, { dryRun: true, quiet: true, srcRoot: repoRoot });
    expect(result).toBe(0);
    expect(existsSync(join(project, '.cursor'))).toBe(false);
    expect(String(grokBuildPaths.skills)).toContain('.grok');
    expect(String(grokBuildPaths.skills)).not.toContain('.cursor');
    expect(resolveFromWriter()).toMatch(/\.grok$/);
  });

  it('creates AGENTS.md bridge mentioning discover/show and GROK_HOME', () => {
    const project = temporaryRoot('aiwg-grok-build-agents-');
    createAgentsMd(project, repoRoot, false /* dryRun */);
    const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('aiwg discover');
    expect(agents).toContain('aiwg show');
    expect(agents).toContain('GROK_HOME');
    expect(agents).toContain('.grok/skills');
    expect(agents).not.toContain('.cursor');
    expect(agents).toContain('distinct from Grok Bot');
  });

  it('deploys to .grok/skills without deleting operator-owned skills', () => {
    const project = temporaryRoot('aiwg-grok-build-deploy-');
    const operatorDir = join(project, '.grok', 'skills', 'operator-skill');
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(join(operatorDir, 'SKILL.md'), 'operator-owned\n');

    const source = temporaryRoot('aiwg-grok-build-src-');
    const skillDir = join(source, 'aiwg-status');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: aiwg-status\ndescription: status\n---\n\nStatus skill.\n',
    );

    const n = deploySkills([skillDir], project, {
      dryRun: false,
      quiet: true,
      srcRoot: repoRoot,
    });
    expect(n).toBeGreaterThanOrEqual(1);
    createAgentsMd(project, repoRoot, false);
    expect(readFileSync(join(operatorDir, 'SKILL.md'), 'utf8')).toBe('operator-owned\n');
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  });
});
