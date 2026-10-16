import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deploySkillDir,
  deploySkillsWithKernelRouting,
  readSidecarManifest,
  writeSidecarManifest,
} from '../../../tools/agents/providers/base.mjs';

describe('shared skill copier ownership and stale files (#3035)', () => {
  let root: string;
  let destination: string;
  let sources: string;

  function write(filename: string, content: string): void {
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }

  function skill(group: string, bundle: string, name: string, body = bundle): string {
    const source = join(sources, 'agentic/code', group, bundle, 'skills', name);
    write(join(source, 'SKILL.md'), `---\nname: ${name}\nplatforms: [all]\n---\n${body}\n`);
    write(join(source, 'references/recipe.md'), `${bundle} recipe\n`);
    return source;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-skill-copy-'));
    sources = join(root, 'sources');
    destination = join(root, 'deployed');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of ['cleanup-audit', 'doc-sync', 'sdlc-accelerate']) {
    it(`reports ${name} from aiwg-utils versus sdlc-complete and preserves the owner`, () => {
      const addon = skill('addons', 'aiwg-utils', name);
      const framework = skill('frameworks', 'sdlc-complete', name);
      deploySkillDir(addon, destination, { provider: 'pi' });
      const deployed = join(destination, name);
      const receipt = readFileSync(join(deployed, '.aiwg-manifest.json'), 'utf8');
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(readSidecarManifest(deployed).managed['SKILL.md'].frameworkSlug).toBe('aiwg-utils');
      for (const options of [{}, { force: true }, { dryRun: true }]) {
        deploySkillDir(framework, destination, options);
        expect(warning).toHaveBeenLastCalledWith(
          `Skill deploy collision: '${name}' is owned by aiwg-utils; sdlc-complete skipped`,
        );
        expect(readFileSync(join(deployed, 'references/recipe.md'), 'utf8')).toBe('aiwg-utils recipe\n');
        expect(readFileSync(join(deployed, '.aiwg-manifest.json'), 'utf8')).toBe(receipt);
      }
    });
  }

  it('checks an existing manifest frameworkSlug even without the new source-directory record', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    deploySkillDir(addon, destination, {});
    const receipt = readSidecarManifest(join(destination, 'demo'));
    delete receipt.skillSource;
    writeSidecarManifest(join(destination, 'demo'), receipt, false);
    const framework = skill('frameworks', 'sdlc-complete', 'demo');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deploySkillDir(framework, destination, {});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('owned by aiwg-utils'));
  });

  it('detects a collision even when only the support assets differ', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo', 'same instructions');
    const framework = skill('frameworks', 'sdlc-complete', 'demo', 'same instructions');
    deploySkillDir(framework, destination, {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deploySkillDir(addon, destination, {});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('owned by sdlc-complete'));
  });

  it('updates the same owner after its installation root moves', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    deploySkillDir(addon, destination, {});
    sources = join(root, 'relocated');
    const relocated = skill('addons', 'aiwg-utils', 'demo', 'updated');
    deploySkillDir(relocated, destination, {});
    expect(readFileSync(join(destination, 'demo/SKILL.md'), 'utf8')).toContain('updated');
    expect(readSidecarManifest(join(destination, 'demo')).skillSource).toBe(relocated);
  });

  it('prunes removed support files while preserving additions and modified files', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    write(join(addon, 'assets/retired.txt'), 'retired');
    deploySkillDir(addon, destination, {});
    const deployed = join(destination, 'demo');
    write(join(deployed, 'references/recipe.md'), 'operator edit');
    write(join(deployed, 'assets/local.txt'), 'operator addition');
    rmSync(join(addon, 'references'), { recursive: true });
    rmSync(join(addon, 'assets'), { recursive: true });
    deploySkillDir(addon, destination, {});
    expect(existsSync(join(deployed, 'assets/retired.txt'))).toBe(false);
    expect(readFileSync(join(deployed, 'references/recipe.md'), 'utf8')).toBe('operator edit');
    expect(readFileSync(join(deployed, 'assets/local.txt'), 'utf8')).toBe('operator addition');
    expect(Object.keys(readSidecarManifest(deployed).managed)).toEqual(['SKILL.md']);
  });

  it('preserves stale support files during a dry run', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    deploySkillDir(addon, destination, {});
    rmSync(join(addon, 'references'), { recursive: true });
    const receipt = readFileSync(join(destination, 'demo/.aiwg-manifest.json'), 'utf8');
    deploySkillDir(addon, destination, { dryRun: true });
    expect(existsSync(join(destination, 'demo/references/recipe.md'))).toBe(true);
    expect(readFileSync(join(destination, 'demo/.aiwg-manifest.json'), 'utf8')).toBe(receipt);
  });

  it('does not follow a replaced support-directory symlink during cleanup', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    deploySkillDir(addon, destination, {});
    const outside = join(root, 'outside');
    write(join(outside, 'recipe.md'), 'aiwg-utils recipe\n');
    rmSync(join(destination, 'demo/references'), { recursive: true });
    symlinkSync(outside, join(destination, 'demo/references'));
    rmSync(join(addon, 'references'), { recursive: true });
    deploySkillDir(addon, destination, {});
    expect(existsSync(join(outside, 'recipe.md'))).toBe(true);
  });

  it('removes retired standard skills on redeploy, including an empty source skill list', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const sibling = skill('addons', 'another-addon', 'sibling');
    const options = { copyStandardSkills: true, srcRoot: sources };
    deploySkillsWithKernelRouting([addon, sibling], destination, null, options);
    rmSync(addon, { recursive: true });
    const result = deploySkillsWithKernelRouting([], destination, null, options);
    expect(result.prunedFromStandardDir).toBe(1);
    expect(existsSync(join(destination, 'demo'))).toBe(false);
    expect(existsSync(join(destination, 'sibling/SKILL.md'))).toBe(true);
  });

  it('preserves operator files inside retired standard skills and leaves legacy marker-only copies alone', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const options = { copyStandardSkills: true, srcRoot: sources };
    deploySkillsWithKernelRouting([addon], destination, null, options);
    write(join(destination, 'demo/local.txt'), 'operator addition');
    write(join(destination, 'demo/references/recipe.md'), 'operator edit');
    write(join(destination, 'legacy/SKILL.md'), 'operator or legacy skill');
    write(join(destination, 'legacy/.aiwg-managed'), 'aiwg\n');
    rmSync(addon, { recursive: true });
    deploySkillsWithKernelRouting([], destination, null, options);
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(false);
    expect(readFileSync(join(destination, 'demo/local.txt'), 'utf8')).toBe('operator addition');
    expect(readFileSync(join(destination, 'demo/references/recipe.md'), 'utf8')).toBe('operator edit');
    expect(existsSync(join(destination, 'demo/.aiwg-managed'))).toBe(false);
    expect(existsSync(join(destination, 'legacy/SKILL.md'))).toBe(true);
  });

  it('scopes stale standard cleanup to this source and honors dry runs', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const options = { copyStandardSkills: true, srcRoot: sources };
    deploySkillsWithKernelRouting([addon], destination, null, options);
    rmSync(addon, { recursive: true });
    deploySkillsWithKernelRouting([], destination, null, { ...options, dryRun: true });
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(true);
    deploySkillsWithKernelRouting([], destination, null, { ...options, srcRoot: join(sources, 'unrelated') });
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(true);
    deploySkillsWithKernelRouting([], destination, null, {});
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(true);
  });
});
