import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAllArtifactBasenames, discoverAddons, getAddonRuleFiles, getAddonSkillDirs } from '../../../tools/agents/providers/base.mjs';

import { sourceRules } from '../providers/rule-source-expectations.js';

const root = path.resolve(import.meta.dirname, '../../..');
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

// Framework-mode deploys (`aiwg use sdlc`, `aiwg use all --copy-all`) collect
// addon content through discoverAddons(); explicitInstall addons deploy only
// when named (#2641).
describe('discoverAddons explicitInstall', () => {
  it('skips explicitInstall and devOnly addons but keeps autoInstall:false ones', async () => {
    const srcRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-discover-addons-'));
    temps.push(srcRoot);
    const manifests: Record<string, object> = {
      'opt-in': { explicitInstall: true, autoInstall: false },
      contributor: { devOnly: true },
      plain: { autoInstall: false },
    };
    for (const [name, manifest] of Object.entries(manifests)) {
      const skill = path.join(srcRoot, 'agentic/code/addons', name, 'skills', `${name}-skill`);
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}-skill\n---\n`);
      await writeFile(path.join(srcRoot, 'agentic/code/addons', name, 'manifest.json'), JSON.stringify(manifest));
    }
    expect(discoverAddons(srcRoot).map((addon: { name: string }) => addon.name)).toEqual(['plain']);
    expect(getAddonSkillDirs(srcRoot).map((dir: string) => path.basename(dir))).toEqual(['plain-skill']);
  });

  it('keeps decision-engine out of bulk deploys from the real tree', () => {
    const names = discoverAddons(root).map((addon: { name: string }) => addon.name);
    expect(names).not.toContain('decision-engine');
    expect(names).toEqual(expect.arrayContaining(['composition-engine', 'testing-quality', 'aiwg-utils']));
    expect(getAddonSkillDirs(root).some((dir: string) => path.basename(dir) === 'decision-evaluate')).toBe(false);
  });

  it('keeps activation-selected explicitInstall rules in the prune desired set without adding them to bulk deploys (#2862)', async () => {
    const bulkRules = getAddonRuleFiles(root).map((file: string) => path.basename(file));
    expect(bulkRules).not.toContain('decision-offload.md');
    const rule = sourceRules(root, 'addons', true).find(rule => rule.name === 'decision-offload')!;
    expect(rule.activation).toBe('bound');
    expect(getAddonRuleFiles(root, [], { includeExplicit: true }).includes(rule.file)).toBe(rule.fileDelivered);
    expect(discoverAddons(root, { includeExplicit: true }).map((addon: { name: string }) => addon.name)).toContain('decision-engine');
    expect(computeAllArtifactBasenames(root, 'rules').has(rule.name)).toBe(rule.fileDelivered);
    // Retain #2862's prune protection with an explicit kernel rule. The real
    // decision-offload contract is bound now and must not reappear at startup.
    const source = await mkdtemp(path.join(os.tmpdir(), 'aiwg-explicit-rules-'));
    temps.push(source);
    const addon = path.join(source, 'agentic/code/addons/opt-in');
    await mkdir(path.join(addon, 'rules'), { recursive: true });
    await mkdir(path.join(source, 'agentic/code/frameworks'), { recursive: true });
    await writeFile(path.join(addon, 'manifest.json'), JSON.stringify({ explicitInstall: true }));
    const kernel = path.join(addon, 'rules/explicit-kernel.md');
    await writeFile(kernel, '---\nname: explicit-kernel\nactivation: kernel\nenforcement: high\n---\nPreserve the explicit guard.\n');
    expect(getAddonRuleFiles(source)).not.toContain(kernel);
    expect(getAddonRuleFiles(source, [], { includeExplicit: true })).toContain(kernel);
    expect(computeAllArtifactBasenames(source, 'rules').has('explicit-kernel')).toBe(true);
  });
});

describe('direct addon/framework skill discovery (#3035)', () => {
  async function sourceFixture(): Promise<string> {
    const source = await mkdtemp(path.join(os.tmpdir(), 'aiwg-direct-addon-'));
    temps.push(source);
    await mkdir(path.join(source, 'skills/probe'), { recursive: true });
    await writeFile(path.join(source, 'manifest.json'), JSON.stringify({ explicitInstall: true }));
    await writeFile(path.join(source, 'skills/probe/SKILL.md'), '---\nname: probe\n---\n');
    await mkdir(path.join(source, 'skills/not-a-skill'));
    return source;
  }

  it('discovers an explicitly selected source and honors exclusions', async () => {
    const source = await sourceFixture();
    expect(getAddonSkillDirs(source)).toEqual([path.join(source, 'skills/probe')]);
    expect(getAddonSkillDirs(source, [path.basename(source)])).toEqual([]);
  });

  it('ignores top-level skills for repository-root sources without duplicate discovery', async () => {
    const source = await sourceFixture();
    const addon = path.join(source, 'agentic/code/addons/plain');
    await mkdir(path.join(addon, 'skills/nested'), { recursive: true });
    await writeFile(path.join(addon, 'skills/nested/SKILL.md'), '# Nested skill\n');
    expect(getAddonSkillDirs(source)).toEqual([path.join(addon, 'skills/nested')]);
  });

  it('ignores missing sources and skills paths that are files', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'aiwg-direct-files-'));
    temps.push(source);
    await writeFile(path.join(source, 'skills'), '# Not a directory\n');
    expect(getAddonSkillDirs(source)).toEqual([]);
    expect(getAddonSkillDirs(path.join(source, 'missing'))).toEqual([]);
  });

  it('skips an escaping skills symlink with a warning, including a sibling with the same prefix', async () => {
    const source = await sourceFixture();
    const outside = `${source}-outside`;
    temps.push(outside);
    await mkdir(path.join(outside, 'pulled-skill'), { recursive: true });
    await writeFile(path.join(outside, 'pulled-skill/SKILL.md'), '# Outside skill\n');
    await rm(path.join(source, 'skills'), { recursive: true });
    await symlink(outside, path.join(source, 'skills'), 'dir');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getAddonSkillDirs(source)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('resolves outside source root'));
    } finally {
      warn.mockRestore();
    }
  });

  it('allows a contained skills symlink and a symlinked source root after realpath', async () => {
    const source = await sourceFixture();
    await mkdir(path.join(source, 'contained/probe'), { recursive: true });
    await writeFile(path.join(source, 'contained/probe/SKILL.md'), '# Contained skill\n');
    await rm(path.join(source, 'skills'), { recursive: true });
    await symlink(path.join(source, 'contained'), path.join(source, 'skills'), 'dir');
    const alias = `${source}-alias`;
    temps.push(alias);
    await symlink(source, alias, 'dir');
    expect(getAddonSkillDirs(alias)).toEqual([path.join(alias, 'skills/probe')]);
  });
});
