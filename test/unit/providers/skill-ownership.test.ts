import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneRecordedSkillFiles, releaseSkillOwnership, type SkillRemovalPlanEntry } from '../../../src/providers/skill-ownership.mjs';

describe('skill ownership removal plans (#3472)', () => {
  let dir: string;
  const original = 'original content';
  const hash = `sha256:${createHash('sha256').update(original).digest('hex')}`;
  beforeEach(() => {
    fs.mkdirSync('/tmp/aiwg-3472', { recursive: true });
    dir = fs.mkdtempSync('/tmp/aiwg-3472/ownership-');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('produces the same plan for dry-run and real removal of a mixed receipt', () => {
    const skillDir = path.join(dir, 'skill');
    fs.mkdirSync(path.join(skillDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), original);
    fs.writeFileSync(path.join(skillDir, 'nested/unchanged.txt'), original);
    fs.writeFileSync(path.join(skillDir, 'modified.txt'), 'operator edit');
    fs.writeFileSync(path.join(skillDir, 'unrecorded.txt'), 'operator addition');
    fs.symlinkSync('modified.txt', path.join(skillDir, 'linked.txt'));
    const backing = path.join(dir, 'backing');
    fs.mkdirSync(backing);
    fs.writeFileSync(path.join(backing, 'unchanged.txt'), original);
    fs.symlinkSync(backing, path.join(skillDir, 'linked-dir'));
    fs.writeFileSync(path.join(skillDir, '.aiwg-managed'), '');
    fs.writeFileSync(path.join(skillDir, '.aiwg-manifest.json'), JSON.stringify({ managed: {
      'SKILL.md': { hash, frameworkSlug: 'demo' },
      'nested/unchanged.txt': { hash },
      'modified.txt': { hash },
      'linked.txt': { hash },
      'linked-dir/unchanged.txt': { hash },
    } }));
    const owner = { frameworkSlug: 'demo' };
    const dryPlan: SkillRemovalPlanEntry[] = [];
    expect(releaseSkillOwnership(skillDir, owner, { dryRun: true, plan: dryPlan })).toBe(false);
    expect(dryPlan).toHaveLength(7);
    for (const entry of dryPlan) expect(fs.lstatSync(entry.path)).toBeDefined();
    expect(dryPlan.map(entry => [path.relative(skillDir, entry.path), entry.action, entry.reason])).toEqual([
      ['SKILL.md', 'remove', 'unchanged managed file'],
      ['nested/unchanged.txt', 'remove', 'unchanged managed file'],
      ['modified.txt', 'preserve', 'modified or unverifiable managed file'],
      ['linked.txt', 'preserve', 'symlink preserved'],
      ['linked-dir/unchanged.txt', 'preserve', 'symlink preserved'],
      ['.aiwg-manifest.json', 'remove', 'ownership metadata released'],
      ['.aiwg-managed', 'remove', 'ownership metadata released'],
    ]);
    const realPlan: SkillRemovalPlanEntry[] = [];
    expect(releaseSkillOwnership(skillDir, owner, { plan: realPlan })).toBe(false);
    expect(realPlan).toEqual(dryPlan);
    for (const entry of realPlan) {
      if (entry.action === 'remove') expect(fs.existsSync(entry.path)).toBe(false);
      else expect(fs.lstatSync(entry.path)).toBeDefined();
    }
    expect(fs.readFileSync(path.join(skillDir, 'modified.txt'), 'utf8')).toBe('operator edit');
    expect(fs.readFileSync(path.join(skillDir, 'linked-dir/unchanged.txt'), 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(skillDir, 'unrecorded.txt'), 'utf8')).toBe('operator addition');
  });

  it('plans every recorded file while retaining desired, missing, and out-of-root paths', () => {
    fs.writeFileSync(path.join(dir, 'retained.txt'), original);
    const managed = { 'retained.txt': { hash }, 'missing.txt': { hash }, '../outside.txt': { hash } };
    const dryPlan: SkillRemovalPlanEntry[] = [];
    pruneRecordedSkillFiles(dir, managed, new Set(['retained.txt']), { dryRun: true, plan: dryPlan });
    const realPlan: SkillRemovalPlanEntry[] = [];
    pruneRecordedSkillFiles(dir, managed, new Set(['retained.txt']), { plan: realPlan });
    expect(realPlan).toEqual(dryPlan);
    expect(dryPlan.map(entry => [entry.action, entry.reason])).toEqual([
      ['preserve', 'retained managed file'],
      ['preserve', 'missing or unreadable path; cannot verify'],
      ['preserve', 'path outside skill directory'],
    ]);
    expect(fs.readFileSync(path.join(dir, 'retained.txt'), 'utf8')).toBe(original);
  });
});
