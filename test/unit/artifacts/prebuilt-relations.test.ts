import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import * as builder from '../../../src/artifacts/index-builder.js';
import { buildPrebuiltRelations, checkPrebuiltRelations } from '../../../src/artifacts/prebuilt-relations.js';
import { frameworkSourceDigest } from '../../../src/artifacts/framework-source-digest.js';
import { ensureRelations, loadBuiltRelations, selectPrebuiltRelations, PREBUILT_RELATIONS_DIR } from '../../../src/artifacts/relations.js';
import { getGraphIndexDir, type ArtifactIndex } from '../../../src/artifacts/types.js';
import { showArtifact, relationshipRules, relationshipRuleStats } from '../../../src/artifacts/query-engine.js';
import { refreshFrameworkCapabilities } from '../../../src/artifacts/framework-capabilities.js';

let tmp: string;
let root: string;
const skill = 'agentic/code/addons/example/skills/work/SKILL.md';
const rule = 'agentic/code/addons/example/rules/first.md';
function put(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
function entries() {
  const index = JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'), 'utf8')) as ArtifactIndex;
  return Object.values(index.entries);
}
function writeTables() {
  const tables = buildPrebuiltRelations(root, entries());
  for (const [file, text] of Object.entries(tables)) put(`${PREBUILT_RELATIONS_DIR}/${file}`, text);
  return tables;
}
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-prebuilt-relations-'));
  root = path.join(tmp, 'runtime');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(tmp, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', root);
  put('package.json', '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) fs.mkdirSync(path.join(root, 'agentic/code', kind), { recursive: true });
  put(skill, '---\nname: work\n---\n# Work\n');
  put(rule, '---\nname: first\nactivation: bound\nenforcement: high\nsummary: First summary.\nbound_to: {skills: [work]}\n---\n# First\n');
  await buildIndex(root, { graph: 'framework', quiet: true });
  writeTables();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('prebuilt relationship selection', () => {
  it('applies project pins equally to prebuilt and built readers without changing canonical tables', () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(project, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({
      installed: { example: { source: 'project-local' } },
      rules: { always_load: [{ rules: ['first'] }] },
    }));
    const build = vi.spyOn(builder, 'buildIndex');
    for (const reader of [selectPrebuiltRelations(root, project).reader!, loadBuiltRelations(root, project)!]) {
      expect(reader.ruleStats('skill', 'work').by_activation).toEqual({ kernel: 1 });
      expect(Object.values(reader.index.rules)[0].activation).toBe('bound');
    }
    expect(selectPrebuiltRelations(root).reader!.ruleStats('skill', 'work').by_activation).toEqual({ bound: 1 });
    expect(build).not.toHaveBeenCalled();
  });

  it('reports invalid project pin policy instead of hiding it as a missing relationship cache', async () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(project, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ rules: { always_load: [{ all: 'yes' }] } }));
    const build = vi.spyOn(builder, 'buildIndex');
    expect(() => selectPrebuiltRelations(root, project)).toThrow(/always_load|all/);
    expect(() => loadBuiltRelations(root, project)).toThrow(/always_load|all/);
    await expect(ensureRelations(root, project)).rejects.toThrow(/always_load|all/);
    expect(build).not.toHaveBeenCalled();
  });

  it('is portable, byte reproducible, and selected on a fresh HOME without source index reads/builds', async () => {
    put('src/rules/activation.mjs', '// byte-identical shipped module\n');
    const tables = writeTables();
    const other = path.join(tmp, 'installed');
    fs.cpSync(root, other, { recursive: true });
    fs.mkdirSync(path.join(other, 'dist/src/rules'), { recursive: true });
    fs.renameSync(path.join(other, 'src/rules/activation.mjs'), path.join(other, 'dist/src/rules/activation.mjs'));
    expect(frameworkSourceDigest(other, false)).toBe(frameworkSourceDigest(root, false));
    expect(buildPrebuiltRelations(other, entries())).toEqual(tables);
    fs.rmSync(getGraphIndexDir(root, 'framework'), { recursive: true });
    const build = vi.spyOn(builder, 'buildIndex');
    const read = vi.spyOn(fs, 'readFileSync');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true });
    const shown = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(shown.bound_rules).toEqual([{ name: 'first', activation: 'bound', summary: 'First summary.', show_command: 'aiwg show rule first' }]);
    expect(build).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([file]) => String(file).endsWith('metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'))).toBe(false);
    expect(selectPrebuiltRelations(other).reader).not.toBeNull();
    expect(checkPrebuiltRelations(root)).toEqual([]);
  });

  it('rebuilds modified rules through reconciliation and reports why, then reuses the receipt', async () => {
    await refreshFrameworkCapabilities(root, false);
    const before = selectPrebuiltRelations(root).reader!.index;
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('First summary.', 'Edited summary.'));
    expect(selectPrebuiltRelations(root).reason).toContain('source digest differs');
    const build = vi.spyOn(builder, 'buildIndex');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = await ensureRelations(root);
    expect(build).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('source digest differs');
    expect(reader!.index.fingerprint).not.toEqual(before.fingerprint);
    expect(Object.values(reader!.index.rules)[0].summary).toBe('Edited summary.');
    await ensureRelations(root);
    expect(build).toHaveBeenCalledTimes(1);
    expect(checkPrebuiltRelations(root).join(' ')).toContain('source digest differs');
  });

  it('detects additions, deletions, same-size edits, version mismatch and corrupt tables', () => {
    const initial = frameworkSourceDigest(root);
    const oldStat = fs.statSync(path.join(root, rule));
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('First summary.', 'Other summary.'));
    fs.utimesSync(path.join(root, rule), oldStat.atime, oldStat.mtime);
    expect(frameworkSourceDigest(root)).not.toBe(initial);
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('Other summary.', 'First summary.'));
    expect(frameworkSourceDigest(root)).toBe(initial);
    put('agentic/code/addons/example/skills/new/SKILL.md', '# New\n');
    expect(selectPrebuiltRelations(root).reason).toContain('source digest differs');
    fs.rmSync(path.join(root, 'agentic/code/addons/example/skills/new'), { recursive: true });
    expect(selectPrebuiltRelations(root).reader).not.toBeNull();
    fs.unlinkSync(path.join(root, skill));
    expect(selectPrebuiltRelations(root).reason).toContain('source digest differs');
    put(skill, '---\nname: work\n---\n# Work\n');
    put('package.json', '{"name":"aiwg","version":"1.0.1"}');
    expect(selectPrebuiltRelations(root).reason).toContain('package version differs');
    put('package.json', '{"name":"aiwg","version":"1.0.0"}');
    put(`${PREBUILT_RELATIONS_DIR}/relations.json`, '{}');
    expect(selectPrebuiltRelations(root).reason).toContain('checksum differs');
    expect(checkPrebuiltRelations(root)).toContain('relations.json checksum differs');
  });

  it('merges project contracts without changing precomputed shipped stats', () => {
    const reader = selectPrebuiltRelations(root).reader!;
    const target = entries().find(entry => entry.type === 'skill')!;
    const local = { ...entries().find(entry => entry.type === 'rule')!,
      path: '.aiwg/rules/local.md', name: 'local', activation: 'summary', ruleEnforcement: 'critical' };
    expect(relationshipRules([local], target, reader).map(rule => rule.name)).toEqual(['first', 'local']);
    expect(relationshipRuleStats([local], target, reader)).toEqual({
      by_enforcement: { high: 1, critical: 1 }, by_activation: { bound: 1, summary: 1 }, required_checks: 2,
    });
    expect(reader.ruleStats('skill', target.name!).required_checks).toBe(1);
    const override = { ...target, path: '.aiwg/skills/work/SKILL.md' };
    expect(relationshipRules([local], override, reader).map(rule => rule.name)).toEqual(['first', 'local']);
    expect(relationshipRuleStats([local], override, reader)).toEqual(relationshipRuleStats([local], target, reader));
  });

  it('precomputes native paths, Hermes deferral, legacy activation and flow skill projections', async () => {
    for (const [name, activation, enforcement] of [
      ['kernel-high', 'kernel', 'high'], ['kernel-critical', 'kernel', 'critical'],
      ['paths', 'paths', 'high'], ['summary', 'summary', 'medium'], ['demand', 'on-demand', 'low'],
    ]) put(`agentic/code/addons/example/rules/${name}.md`, `---\nactivation: ${activation}\nenforcement: ${enforcement}\nsummary: ${name}.\n${activation === 'paths' ? 'paths: ["src/**"]\n' : ''}---\n# ${name}\n`);
    put('agentic/code/addons/example/rules/legacy.md', '# Legacy\n\n**Enforcement Level**: MEDIUM\n');
    put('agentic/code/addons/example/flows/workflow.yaml', 'apiVersion: flow.aiwg.io/v1\nkind: FlowPlaybook\nmetadata: { name: workflow }\nspec: { description: Do work }\n');
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('skills: [work]', 'skills: [work], flows: [workflow]'));
    await buildIndex(root, { graph: 'framework', quiet: true });
    const tables = writeTables();
    const relations = JSON.parse(tables['relations.json']);
    const bindings = JSON.parse(tables['bindings.json']);
    const id = (name: string): string => Object.keys(relations.rules).find(id => relations.rules[id].name === name)!;
    expect(bindings.providers.claude.native_paths).toContain(id('paths'));
    expect(bindings.providers.codex.discoverable_paths).toContain(id('paths'));
    expect(bindings.providers.hermes.kernel).toContain(id('kernel-critical'));
    expect(bindings.providers.hermes.kernel).not.toContain(id('kernel-high'));
    expect(bindings.providers.hermes.summary).toContain(id('kernel-high'));
    expect(bindings.providers.claude.kernel).toContain(id('kernel-high'));
    expect(bindings.rules[id('legacy')].activation).toBe('on-demand');
    expect(bindings.rules[id('first')].targets.flow).toHaveLength(1);
    expect(bindings.rules[id('first')].targets.skill).toHaveLength(2);
    const projection = bindings.rules[id('first')].targets.skill.find((id: string) => id.startsWith('projected:'));
    expect(bindings.targets[`skill:${projection}`].rules).toContain(id('first'));
  });

  it('repairs a removed sidecar even when the source/index receipt is unchanged', async () => {
    await refreshFrameworkCapabilities(root, false);
    const sidecar = path.join(getGraphIndexDir(root, 'framework'), 'relations.json');
    fs.unlinkSync(sidecar);
    const build = vi.spyOn(builder, 'buildIndex');
    await refreshFrameworkCapabilities(root, false);
    expect(build).toHaveBeenCalledTimes(1);
    expect(loadBuiltRelations(root)!.rulesForTarget('skill', 'work')).toHaveLength(1);
  });
});
