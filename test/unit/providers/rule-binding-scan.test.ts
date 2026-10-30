import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectRuleBindingEntries, buildIndex } from '../../../src/artifacts/index-builder.js';
import { createRuleBindingTargetResolver } from '../../../src/artifacts/query-engine.js';
import type { ArtifactIndex } from '../../../src/artifacts/types.js';
import { prepareRuleDelivery } from '../../../tools/agents/providers/rule-delivery.mjs';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-binding-scan-'));
  roots.push(root);
  const source = path.join(root, 'source');
  fs.cpSync(path.resolve('test/fixtures/rule-delivery'), source, { recursive: true });
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  return { root, source, target };
}

describe('rule binding source scan', () => {
  it('matches full-index identities and canonical binding resolution', async () => {
    const { root, source } = fixture();
    const write = (file: string, content: string) => {
      const dest = path.join(source, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content);
    };
    write('skills/named/SKILL.md', '---\nname: Display name\n---\n# Named skill\n');
    write('skills/named/references/help.md', '# Support, not a skill\n');
    write('agents/nested/AGENT.md', '---\nname: named-agent\n---\n# Agent\n');
    write('other.md', '---\ntype: skill\nname: explicit\n---\n# Explicit\n');
    write('flows/example.yaml', 'apiVersion: workflow.aiwg.io/v1\nkind: Workflow\nmetadata:\n  name: example\nspec:\n  steps: []\n');
    const scanned = await collectRuleBindingEntries(source, '.');
    await buildIndex(source, { scope: '.', force: true, quiet: true, outputDir: root });
    const full = Object.values((JSON.parse(fs.readFileSync(path.join(root, '.aiwg/.index/metadata.json'), 'utf8')) as ArtifactIndex).entries)
      .filter(entry => ['skill', 'agent', 'flow'].includes(entry.type));
    const identity = ({ path, type, name, title }: typeof full[number]) => ({ path, type, name, title });
    expect(scanned.map(identity)).toEqual(full.map(identity));
    const scanResolver = createRuleBindingTargetResolver(scanned);
    const fullResolver = createRuleBindingTargetResolver(full);
    for (const entry of full) {
      if (!entry.name) continue;
      const type = entry.type as 'skill' | 'agent' | 'flow';
      expect(identity(scanResolver(type, entry.name))).toEqual(identity(fullResolver(type, entry.name)));
    }
  });

  it('kernel-only fallback binds skills without creating a full source index', async () => {
    const { source, target } = fixture();
    vi.stubEnv('AIWG_ROOT', source);
    vi.stubEnv('AIWG_RULE_BINDING_INDEX_CACHE', '');
    const original = fs.mkdtempSync;
    const temporary = vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix: any, options: any) => {
      if (String(prefix).includes('aiwg-rule-index-')) throw new Error('Full-corpus binding index regression');
      return original(prefix, options) as any;
    });
    const delivery = await prepareRuleDelivery({ srcRoot: source, target, kernelOnly: true, mode: 'all',
      pinConfigs: { project: {}, user: {} } });
    expect(delivery.targets.some((entry: any) => entry.type === 'skill')).toBe(true);
    expect(delivery.bindings.size).toBeGreaterThan(0);
    expect(temporary.mock.calls.some(([prefix]) => String(prefix).includes('aiwg-rule-index-'))).toBe(false);
    expect(fs.existsSync(path.join(source, '.aiwg/.index'))).toBe(false);
  });
});
