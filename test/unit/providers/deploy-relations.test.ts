import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { relationId } from '../../../src/artifacts/relations-builder.js';
import { buildPrebuiltRelations } from '../../../src/artifacts/prebuilt-relations.js';
import { getGraphIndexDir, getProjectIndexRoot } from '../../../src/artifacts/types.js';

const repo = path.resolve(__dirname, '../../..');
let tmp: string, root: string, target: string, bundle: string;
function put(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function policy(id = 'work') { return `---\nname: contract\nactivation: bound\nenforcement: high\nsummary: Follow the contract.\nbound_to: {skills: [${id}]}\n---\n# Contract\n`; }
async function tables() {
  await buildIndex(root, { graph: 'framework', force: true, quiet: true });
  const metadata = JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'), 'utf8'));
  for (const [name, text] of Object.entries(buildPrebuiltRelations(root, Object.values(metadata.entries)))) put(path.join(root, 'prebuilt/framework-relations', name), text);
}
function prepare(extra = {}, guarded = true) {
  const guard = path.join(tmp, 'guard.mjs');
  put(guard, `import fs from 'node:fs';
    const read = fs.readFileSync; const mk = fs.mkdtempSync; let forbidden = false;
    process.on('exit', () => { if (forbidden) process.exitCode = 87; });
    fs.readFileSync = function(file, ...rest) {
      if (${JSON.stringify([path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'), path.join(getProjectIndexRoot(root), 'metadata.json')])}.includes(String(file))) { forbidden = true; throw new Error('PACKAGE_METADATA_READ'); }
      return read.call(this, file, ...rest);
    };
    fs.mkdtempSync = function(prefix, ...rest) { if (String(prefix).includes('aiwg-rule-index-')) { forbidden = true; throw new Error('PACKAGE_INDEX_BUILD'); } return mk.call(this, prefix, ...rest); };
  `);
  return JSON.parse(execFileSync('node', [...(guarded ? ['--import', guard] : []), '--input-type=module', '-e', `
    const { prepareRuleDelivery } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers/rule-delivery.mjs'))});
    const result = await prepareRuleDelivery(${JSON.stringify({ srcRoot: bundle, target, mode: 'all', capability: 'example', ...extra })});
    console.log(JSON.stringify({ targets: result.targets, pins: result.pins.map(rule => rule.name) }));
  `], { cwd: target, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AIWG_ROOT: root } }));
}
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-deploy-relations-'));
  root = path.join(tmp, 'package'); target = path.join(tmp, 'project'); bundle = path.join(root, 'agentic/code/addons/example');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(tmp, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_RULE_BINDING_INDEX_CACHE']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', root);
  fs.mkdirSync(target, { recursive: true }); fs.mkdirSync(path.join(root, 'agentic/code/frameworks'), { recursive: true });
  put(path.join(root, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
  put(path.join(bundle, 'rules/contract.md'), policy());
  put(path.join(bundle, 'skills/work/SKILL.md'), '---\nname: work\n---\n# Work\n');
  await tables();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('deploy compact package binding inputs', () => {
  it('resolves validated package artifacts with package metadata reads and full builds forbidden', () => {
    // An empty legacy project index must not trigger package metadata fallback.
    put(path.join(getProjectIndexRoot(target), 'metadata.json'), JSON.stringify({ entries: {} }));
    expect(prepare().targets.map((entry: any) => entry.source)).toEqual([path.join(bundle, 'skills/work/SKILL.md')]);
  });
  it('preserves project then user override precedence and user graph opt-out', () => {
    const projectFile = path.join(target, 'skills/work/SKILL.md'); const userFile = path.join(tmp, 'HOME/work/SKILL.md');
    put(projectFile, '# Project'); put(userFile, '# User');
    const entry = (file: string) => ({ type: 'skill', name: 'work', path: file });
    put(path.join(getGraphIndexDir(target, 'user'), 'metadata.json'), JSON.stringify({ entries: { user: entry(userFile) } }));
    expect(prepare().targets[0].source).toBe(userFile);
    put(path.join(getGraphIndexDir(target, 'project'), 'metadata.json'), JSON.stringify({ entries: { project: entry(projectFile) } }));
    expect(prepare().targets[0].source).toBe(projectFile);
    fs.rmSync(path.join(getGraphIndexDir(target, 'project'), 'metadata.json'));
    put(path.join(target, '.aiwg/aiwg.config'), JSON.stringify({ index: { userIndices: { enabled: false } } }));
    expect(prepare().targets[0].source).toBe(path.join(bundle, 'skills/work/SKILL.md'));
  });
  it('retains legitimate legacy project overrides while excluding legacy framework-origin entries', () => {
    const projectFile = path.join(target, 'skills/work/SKILL.md'); put(projectFile, '# Legacy project work');
    const legacyFile = path.join(getProjectIndexRoot(target), 'metadata.json');
    put(legacyFile, JSON.stringify({ entries: { project: { type: 'skill', name: 'work', path: projectFile },
      framework: { type: 'skill', name: 'work', path: 'agentic/code/addons/example/skills/work/SKILL.md' } } }));
    expect(prepare().targets[0].source).toBe(projectFile);
    put(legacyFile, JSON.stringify({ entries: {
      framework: { type: 'skill', name: 'work', path: path.join(bundle, 'skills/work/SKILL.md') },
    } }));
    expect(prepare().targets[0].source).toBe(path.join(bundle, 'skills/work/SKILL.md'));
  });
  it('prefers canonical source skills over generated plugin mirrors', async () => {
    put(path.join(root, 'agentic/code/plugins/example/skills/work/SKILL.md'), '---\nname: work\n---\n# Mirror\n');
    await tables();
    expect(prepare().targets[0].source).toBe(path.join(bundle, 'skills/work/SKILL.md'));
  });
  it('resolves stable package IDs and explicit operator pins without mutating canonical activation', () => {
    const external = path.join(tmp, 'external.md');
    const id = relationId({ type: 'skill', path: 'agentic/code/addons/example/skills/work/SKILL.md' } as any);
    put(external, policy(id));
    expect(prepare({ ruleSources: [external], config: { installed: { example: {} }, rules: { always_load: [{ rules: ['contract'] }] } } }).pins).toEqual(['contract']);
  });
  it('resolves flow contracts from compact records', async () => {
    put(path.join(bundle, 'flows/release.yaml'), 'apiVersion: workflow.aiwg.io/v1\nkind: FlowPlaybook\nmetadata:\n  name: release\nspec:\n  steps: []\n');
    await tables();
    const external = path.join(tmp, 'external.md'); put(external, policy().replace('skills: [work]', 'flows: [release]'));
    expect(prepare({ ruleSources: [external] }).targets[0].source).toBe(path.join(bundle, 'flows/release.yaml'));
  });
  it('rejects missing compact targets without rebuilding a validated package', () => {
    // Supply a new external contract against the unchanged validated package.
    const external = path.join(tmp, 'external.md'); put(external, policy('missing'));
    expect(() => prepare({ ruleSources: [external] })).toThrow(/Missing skill binding target: missing/);
  });
  it('rejects ambiguous local targets with the canonical resolver', () => {
    const first = path.join(target, 'one/SKILL.md'), second = path.join(target, 'two/SKILL.md');
    put(first, '# One'); put(second, '# Two');
    put(path.join(getGraphIndexDir(target, 'project'), 'metadata.json'), JSON.stringify({ entries: {
      one: { type: 'skill', name: 'local-work', path: first }, two: { type: 'skill', name: 'local-work', path: second },
    } }));
    const external = path.join(tmp, 'external.md'); put(external, policy('local-work'));
    expect(() => prepare({ ruleSources: [external] })).toThrow(/Ambiguous skill binding target: local-work/);
  });
  it('retains scoped local bundle bindings alongside compact package entries', () => {
    const local = path.join(target, 'custom');
    put(path.join(local, 'skills/local-work/SKILL.md'), '---\nname: local-work\n---\n# Local\n');
    const external = path.join(tmp, 'external.md'); put(external, policy('local-work'));
    const result = prepare({ ruleSources: [external], config: { installed: { custom: { localPath: 'custom' } } } });
    expect(result.targets[0].source).toBe(path.join(local, 'skills/local-work/SKILL.md'));
  });
  it('preserves scoped local targets when a stale package index is rebuilt for an added target', () => {
    const local = path.join(target, 'custom');
    put(path.join(local, 'skills/local-work/SKILL.md'), '---\nname: local-work\n---\n# Local\n');
    const added = path.join(bundle, 'skills/added/SKILL.md'); put(added, '---\nname: added\n---\n# Added\n');
    const first = path.join(tmp, 'first.md'), second = path.join(tmp, 'second.md');
    put(first, policy('added')); put(second, policy('local-work'));
    const result = prepare({ ruleSources: [first, second], config: { installed: { custom: { localPath: 'custom' } } } }, false);
    expect(result.targets.map((entry: any) => entry.source)).toEqual([added, path.join(local, 'skills/local-work/SKILL.md')]);
  });
  it('uses scoped source fallback when prebuilts are absent or source content changes', async () => {
    fs.rmSync(path.join(root, 'prebuilt'), { recursive: true });
    expect(prepare({}, false).targets[0].source).toBe(path.join(bundle, 'skills/work/SKILL.md'));
    await tables();
    put(path.join(bundle, 'skills/work/SKILL.md'), '---\nname: work\n---\n# Changed\n');
    expect(prepare({}, false).targets[0].source).toBe(path.join(bundle, 'skills/work/SKILL.md'));
  });  it('resolves the complete shipped binding corpus without package metadata or full indexing', () => {
    root = repo;
    const relations = JSON.parse(fs.readFileSync(path.join(root, 'prebuilt/framework-relations/relations.json'), 'utf8'));
    const bindings = JSON.parse(fs.readFileSync(path.join(root, 'prebuilt/framework-relations/bindings.json'), 'utf8'));
    const sources = Object.values(relations.rules).map((rule: any) => path.join(root, rule.path));
    const expected = new Set<string>();
    for (const rule of Object.values(bindings.rules) as any[]) {
      if (!rule.tagged) continue;
      for (const [type, ids] of Object.entries(rule.targets) as [string, string[]][]) {
        for (const id of ids) {
          if (id.startsWith('projected:')) continue;
          expected.add(path.resolve(root, relations.targets[`${type}:${id}`].path));
        }
      }
    }
    expect(expected.size).toBeGreaterThan(100);
    expect(new Set(prepare({ ruleSources: sources }).targets.map((entry: any) => entry.source))).toEqual(expected);
  });

});
