import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

import {
  GROK_HOME_ENV,
  resolveGrokHome,
  resolveGrokHomeResult,
  grokBuildProjectPaths,
} from '../../../src/providers/grok-build-paths.js';
import {
  getProviderDefinition,
  normalizeProviderDefinitionId,
  validateProviderDefinitionRegistry,
} from '../../../src/providers/provider-definitions.js';
import { providerContextContract } from '../../../src/smiths/context-pipeline/workspace-context.js';
import {
  deploySkills,
  resolveGrokHome as resolveFromWriter,
  createAgentsMd,
  paths as grokBuildPaths,
  support as grokBuildSupport,
} from '../../../tools/agents/providers/grok-build.mjs';

const roots: string[] = [];
const repoRoot = resolve(__dirname, '../../..');

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeSkill(root: string, name: string, opts: { kernel?: boolean } = {}): string {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  const kernelLine = opts.kernel ? 'kernel: true\n' : '';
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n${kernelLine}---\n\nBody for ${name}.\n`,
  );
  return skillDir;
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
    expect(def?.paths.artifacts.agents).toBeNull();
    expect(def?.paths.artifacts.rules).toBeNull();
    expect(def?.upstream?.revision).toBe('4247f661689354b831191f11eeeac8424993fe3d');
    expect(def?.upstream?.revision).not.toBe('0'.repeat(40));
  });

  it('rejects all-zero upstream revisions in the registry schema', () => {
    expect(() => validateProviderDefinitionRegistry()).not.toThrow();
    const def = getProviderDefinition('grok-build');
    expect(def?.upstream?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(def?.upstream?.revision === '0'.repeat(40)).toBe(false);
  });

  it('models nested AGENTS.md + .grok/rules context (config.toml is not startup)', () => {
    const contract = providerContextContract('grok-build');
    expect(contract?.nestedContext).toBe(true);
    expect(contract?.support).toBe('supported');
    expect(contract?.startupFiles).toEqual(['AGENTS.md', '.grok/rules/*.md']);
    expect(contract?.startupFiles).not.toContain('.grok/config.toml');
    expect(contract?.precedence.some((line) => /deeper/i.test(line))).toBe(true);
    expect(contract?.precedence.some((line) => /root-to-cwd/i.test(line))).toBe(true);
  });
});

describe('grok-build nested context contract', () => {
  it('documents root-to-cwd discovery with deeper-file precedence', () => {
    const project = temporaryRoot('aiwg-grok-nested-');
    const nested = join(project, 'packages', 'api');
    mkdirSync(join(project, '.grok', 'rules'), { recursive: true });
    mkdirSync(join(nested, '.grok', 'rules'), { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'root agents\n');
    writeFileSync(join(nested, 'AGENTS.md'), 'nested agents win\n');
    writeFileSync(join(project, '.grok', 'rules', 'root.md'), 'root rule\n');
    writeFileSync(join(nested, '.grok', 'rules', 'api.md'), 'nested rule wins\n');

    // AIWG documents Grok Build's host discovery; we assert the on-disk layout
    // a nested cwd would present to `grok inspect`, not re-implement the loader.
    const contract = providerContextContract('grok-build');
    expect(contract?.nestedContext).toBe(true);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(nested, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(nested, '.grok', 'rules', 'api.md'))).toBe(true);
    expect(readFileSync(join(nested, 'AGENTS.md'), 'utf8')).toContain('nested agents win');
    expect(getProviderDefinition('grok-build')?.paths.configFile).toBe('.grok/config.toml');
    expect(contract?.startupFiles).not.toContain('.grok/config.toml');
  });
});

describe('grok-build writer dry-run', () => {
  it('marks agents/rules indexed and never targets .cursor or grokbot roots', () => {
    const project = temporaryRoot('aiwg-grok-build-project-');
    const result = deploySkills([], project, { dryRun: true, quiet: true, srcRoot: repoRoot });
    expect(result).toMatchObject({ kernel: 0, standardCopied: 0 });
    expect(existsSync(join(project, '.cursor'))).toBe(false);
    expect(String(grokBuildPaths.skills)).toContain('.grok');
    expect(String(grokBuildPaths.skills)).not.toContain('.cursor');
    expect(grokBuildSupport.agents).toBe('indexed');
    expect(grokBuildSupport.rules).toBe('indexed');
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
    expect(agents).toMatch(/#2577|deferred/i);
  });

  it('deploys kernel skills to .grok/skills and leaves standard index-driven', () => {
    const project = temporaryRoot('aiwg-grok-build-deploy-');
    const operatorDir = join(project, '.grok', 'skills', 'operator-skill');
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(join(operatorDir, 'SKILL.md'), 'operator-owned\n');

    const source = temporaryRoot('aiwg-grok-build-src-');
    const kernelDir = writeSkill(source, 'aiwg-status', { kernel: true });
    const standardDir = writeSkill(source, 'some-standard-skill', { kernel: false });

    const result = deploySkills([kernelDir, standardDir], project, {
      dryRun: false,
      quiet: true,
      srcRoot: repoRoot,
    });
    expect(result.kernel).toBe(1);
    expect(result.standardCopied).toBe(0);
    expect(existsSync(join(project, '.grok', 'skills', 'aiwg-status', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.grok', 'skills', 'some-standard-skill'))).toBe(false);
    expect(existsSync(join(project, '.grok', '.aiwg', 'skills', 'some-standard-skill'))).toBe(false);
    expect(readFileSync(join(operatorDir, 'SKILL.md'), 'utf8')).toBe('operator-owned\n');
  });

  it('copies one standard skill when --copy-all / copyStandardSkills is set', () => {
    const project = temporaryRoot('aiwg-grok-build-copyall-');
    const source = temporaryRoot('aiwg-grok-build-src-copyall-');
    const kernelDir = writeSkill(source, 'aiwg-kernel-one', { kernel: true });
    const standardDir = writeSkill(source, 'aiwg-standard-one', { kernel: false });

    const result = deploySkills([kernelDir, standardDir], project, {
      dryRun: false,
      quiet: true,
      srcRoot: repoRoot,
      copyStandardSkills: true,
    });
    expect(result.kernel).toBe(1);
    expect(result.standardCopied).toBe(1);
    expect(existsSync(join(project, '.grok', 'skills', 'aiwg-kernel-one', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.grok', '.aiwg', 'skills', 'aiwg-standard-one', 'SKILL.md'))).toBe(true);
  });
});

describe('grok-build kernel-only dry-run', () => {
  it('plans far fewer than the full corpus under --kernel-only', () => {
    const target = temporaryRoot('aiwg-grok-kernel-only-');
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'tools/agents/deploy-agents.mjs'),
        '--provider', 'grok-build',
        '--mode', 'all',
        '--target', target,
        '--dry-run',
        '--quiet',
        '--kernel-only',
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    expect(result.status).toBe(0);
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    const skillLines = out.split('\n').filter((line) =>
      line.includes('[dry-run] deploy') && line.includes('SKILL.md') && line.includes('.grok/skills/'));
    // Full corpus was ~525; kernel-only should be the kernel set (tens, not hundreds).
    expect(skillLines.length).toBeGreaterThan(0);
    expect(skillLines.length).toBeLessThan(80);
    expect(skillLines.some((line) => line.includes('.grok/.aiwg/skills/'))).toBe(false);
  });
});
