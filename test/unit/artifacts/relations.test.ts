import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { buildRelations, relationId, relationsFingerprint } from '../../../src/artifacts/relations-builder.js';
import { loadBuiltRelations as loadRelations, rulesForTarget, targetsForRule, rulesForCapability, ruleStats } from '../../../src/artifacts/relations.js';
import { getGraphIndexDir, type ArtifactIndex } from '../../../src/artifacts/types.js';

let root: string;
const bundle = 'agentic/code/addons/example';
function put(file: string, content: string) {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}
const sidecar = () => path.join(getGraphIndexDir(root, 'framework'), 'relations.json');
const metadata = () => JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'), 'utf8')) as ArtifactIndex;
const build = () => buildIndex(root, { graph: 'framework', quiet: true });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-relations-'));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(root, 'cache'));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  put('package.json', '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) fs.mkdirSync(path.join(root, 'agentic/code', kind), { recursive: true });
  put(`${bundle}/skills/work/SKILL.md`, '---\nname: work\n---\n# Work\n');
  put(`${bundle}/agents/worker.md`, '# Worker\n');
  put(`${bundle}/commands/do.md`, '# Do\n');
  put(`${bundle}/flows/workflow.yaml`, 'apiVersion: flow.aiwg.io/v1\nkind: FlowPlaybook\nmetadata:\n  name: workflow\nspec:\n  description: Work together\n');
  put(`${bundle}/rules/first.md`, '---\nname: first\nactivation: bound\nenforcement: HIGH\nsummary: Follow first.\nbound_to: { skills: [work, work], agents: [worker], flows: [workflow] }\n---\n# First\n');
  put(`${bundle}/rules/second.md`, '---\nactivation: paths\nenforcement: critical\nsummary: Follow second.\npaths: ["src/**"]\nbound_to: { skills: [work] }\n---\n# Second\n');
  put(`${bundle}/rules/third.md`, '---\nactivation: on-demand\nenforcement: low\n---\n# Third\n');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('framework relationship sidecar', () => {
  it('writes a schema-valid index with deduplicated edges, projections, stats, and capability tiers', async () => {
    await build();
    const reader = loadRelations(root)!;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(fs.readFileSync(path.resolve('schemas/artifacts/relations.v1.schema.json'), 'utf8')));
    expect(validate(reader.index), JSON.stringify(validate.errors)).toBe(true);
    const ids = reader.rulesForTarget('skill', 'work');
    expect(ids.map(id => reader.index.rules[id].name)).toEqual(['first', 'second']);
    expect(reader.targetsForRule('first')).toHaveLength(4); // skill, agent, flow, projected skill
    expect(reader.rulesForTarget('skill', 'projected:workflow')).toEqual(reader.rulesForTarget('flow', 'workflow'));
    expect(reader.ruleStats('skill', 'work')).toEqual({ by_enforcement: { high: 1, critical: 1 }, by_activation: { bound: 1, paths: 1 }, required_checks: 2 });
    expect(reader.index.rules[ids[1]].paths).toEqual(['src/**']);
    expect(reader.rulesForCapability('addon:example', ['high', 'critical'])).toEqual(ids);
    expect(reader.rulesForCapability('addon:example', ['low'])).toHaveLength(1);
    expect(reader.rulesForTarget('command', 'do')).toEqual([]);
    expect(reader.ruleStats('skill', 'missing').required_checks).toBe(0);
  });

  it('reads only the sidecar and exposes batch and convenience APIs without metadata.json', async () => {
    await build();
    fs.rmSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'));
    const read = vi.spyOn(fs, 'readFileSync');
    const reader = loadRelations(root)!;
    expect(rulesForTarget('skill', 'work', root)).toEqual(reader.rulesForTarget('skill', 'work'));
    expect(targetsForRule('first', root)).toEqual(reader.targetsForRule('first'));
    expect(rulesForCapability('addon:example', ['low'], root)).toEqual(reader.rulesForCapability('addon:example', ['low']));
    expect(ruleStats('skill', 'work', root)).toEqual(reader.ruleStats('skill', 'work'));
    expect(read.mock.calls.some(([file]) => String(file).endsWith('metadata.json'))).toBe(false);
    // Callers cannot corrupt subsequent lookup results by modifying arrays/stats.
    reader.rulesForTarget('skill', 'work').length = 0;
    reader.ruleStats('skill', 'work').by_activation.bound = 99;
    expect(reader.rulesForTarget('skill', 'work')).toHaveLength(2);
    expect(reader.ruleStats('skill', 'work').by_activation.bound).toBe(1);
  });

  it('preserves unchanged sidecars and regenerates on rule/target additions, edits, deletions and missing/versioned sidecars', async () => {
    await build();
    const first = fs.readFileSync(sidecar(), 'utf8');
    const mtime = fs.statSync(sidecar()).mtimeMs;
    await build();
    expect(fs.readFileSync(sidecar(), 'utf8')).toBe(first);
    expect(fs.statSync(sidecar()).mtimeMs).toBe(mtime);
    // An unrelated document does not invalidate this projection.
    put('docs/note.md', '# Note\n');
    await build();
    expect(fs.readFileSync(sidecar(), 'utf8')).toBe(first);
    let fingerprint = loadRelations(root)!.index.fingerprint.sources;
    for (const [file, content] of [
      [`${bundle}/rules/third.md`, '---\nactivation: on-demand\nenforcement: medium\n---\n# Changed\n'],
      [`${bundle}/skills/work/SKILL.md`, '---\nname: work\n---\n# Changed target\n'],
      [`${bundle}/skills/new/SKILL.md`, '# New target\n'],
    ]) {
      put(file, content);
      await build();
      const next = loadRelations(root)!.index.fingerprint.sources;
      expect(next).not.toBe(fingerprint);
      fingerprint = next;
    }
    fs.rmSync(path.join(root, `${bundle}/skills/new`), { recursive: true });
    fs.rmSync(path.join(root, `${bundle}/rules/third.md`));
    await build();
    expect(loadRelations(root)!.index.fingerprint.sources).not.toBe(fingerprint);
    expect(loadRelations(root)!.rulesForCapability('addon:example', ['medium'])).toEqual([]);
    fs.rmSync(sidecar());
    await build();
    expect(loadRelations(root)).not.toBeNull();
    const unsupported = { ...loadRelations(root)!.index, version: 999 };
    fs.writeFileSync(sidecar(), JSON.stringify(unsupported));
    expect(loadRelations(root)).toBeNull();
    await build();
    expect(loadRelations(root)!.index.version).toBe(1);
  });

  it('handles corrupt/missing sidecars and retains explicit ambiguity errors', async () => {
    expect(loadRelations(root)).toBeNull();
    await build();
    const entries = Object.values(metadata().entries);
    const work = entries.find(entry => entry.type === 'skill')!;
    const duplicate = { ...work, path: 'agentic/code/addons/other/skills/work/SKILL.md' };
    // An unbound duplicate retains ambiguity without preventing unrelated lookups.
    const unbound = entries.filter(entry => entry.type !== 'rule');
    const index = buildRelations([...unbound, duplicate]);
    fs.writeFileSync(sidecar(), JSON.stringify(index));
    expect(() => loadRelations(root)!.rulesForTarget('skill', 'work')).toThrow('Ambiguous');
    expect(loadRelations(root)!.rulesForTarget('skill', relationId(work))).toEqual([]);
    expect(() => buildRelations([...entries, duplicate])).toThrow('Ambiguous skill binding target');
    expect(() => buildRelations(entries.filter(entry => entry !== work))).toThrow('Missing skill binding target');
    fs.writeFileSync(sidecar(), '{broken');
    expect(loadRelations(root)).toBeNull();
    await build();
    expect(loadRelations(root)).not.toBeNull();
  });

  it('hashes sources deterministically and distinguishes duplicate rule names by stable ID', async () => {
    await build();
    const entries = Object.values(metadata().entries);
    expect(relationsFingerprint(entries)).toEqual(relationsFingerprint([...entries].reverse()));
    const rule = entries.find(entry => entry.name === 'first')!;
    const duplicate = { ...rule, path: 'agentic/code/extensions/other/rules/first.md', bound_to: undefined };
    const index = buildRelations([...entries, duplicate]);
    expect(index.rules[relationId(rule)].capability).toBe('addon:example');
    expect(index.rules[relationId(duplicate)].capability).toBe('extension:other');
    fs.writeFileSync(sidecar(), JSON.stringify(index));
    expect(() => loadRelations(root)!.targetsForRule('first')).toThrow('Ambiguous');
    expect(loadRelations(root)!.targetsForRule(relationId(rule))).toHaveLength(4);
  });
});
