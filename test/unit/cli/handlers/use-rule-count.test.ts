// Verifies activation-selected rule accounting without counting unselected catalog entries.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { countDeployedBundleRules } from '../../../../src/cli/handlers/use-bundle-counts.js';

let root: string;
let bundle: string;
let rules: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aiwg-rule-count-'));
  bundle = path.join(root, 'bundle');
  rules = path.join(root, 'project', '.claude/rules');
  await mkdir(path.join(bundle, 'rules'), { recursive: true });
  await mkdir(rules, { recursive: true });
  for (const name of ['summary', 'native', 'unselected']) {
    await writeFile(path.join(bundle, 'rules', `${name}.md`), name === 'summary'
      ? '---\nname: summary\nactivation: summary\nsummary: Synthetic summary rule\nenforcement: high\n---\nBody.\n'
      : `Synthetic ${name} rule`);
  }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('deployed bundle rule counts', () => {
  it('counts selected summary rules and native files once, excluding other bundles and unselected rules', async () => {
    const index = '- summary — Fetch: `aiwg show rule summary --body`.\n';
    await writeFile(path.join(rules, 'RULES-INDEX.md'), index);
    await writeFile(path.join(rules, '.aiwg-manifest.json'), JSON.stringify({
      managed: { 'RULES-INDEX.md': { hash: `sha256:${createHash('sha256').update(index).digest('hex')}` } }, ruleSources: [
      path.join(bundle, 'rules/summary.md'), path.join(bundle, 'rules/native.md'),
      path.join(root, 'other/rules/unselected.md'),
    ] }));
    await writeFile(path.join(rules, 'native.md'), 'Native body');
    expect(await countDeployedBundleRules(bundle, root, rules)).toBe(2);
    await rm(path.join(rules, 'RULES-INDEX.md'));
    expect(await countDeployedBundleRules(bundle, root, rules)).toBe(1);
    await writeFile(path.join(rules, 'RULES-INDEX.md'), `${index}Operator edit\n`);
    expect(await countDeployedBundleRules(bundle, root, rules)).toBe(1);
  });

  it('counts a summary rule whose display name contains spaces', async () => {
    await writeFile(path.join(bundle, 'rules', 'summary.md'),
      '---\nid: diversity-awareness\nname: Diversity Awareness\nactivation: summary\nsummary: Synthetic\nenforcement: medium\n---\nBody.\n');
    const index = '- Diversity Awareness — Fetch: `aiwg show rule Diversity Awareness --body`.\n';
    await writeFile(path.join(rules, 'RULES-INDEX.md'), index);
    await writeFile(path.join(rules, '.aiwg-manifest.json'), JSON.stringify({
      managed: { 'RULES-INDEX.md': { hash: `sha256:${createHash('sha256').update(index).digest('hex')}` } },
      ruleSources: [path.join(bundle, 'rules/summary.md')],
    }));
    expect(await countDeployedBundleRules(bundle, root, rules)).toBe(1);
  });

  it('counts legacy native .mdc files without a projection receipt', async () => {
    await writeFile(path.join(rules, 'native.mdc'), 'Native body');
    expect(await countDeployedBundleRules(bundle, path.join(root, 'project'), '.claude/rules')).toBe(1);
    expect(await countDeployedBundleRules(bundle, root, '')).toBe(0);
    expect(await countDeployedBundleRules(path.join(root, 'missing'), root, rules)).toBe(0);
  });
});
